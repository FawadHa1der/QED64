// The page API (frontend/src/page-api.ts; docs/EMBEDDING.md §2–§3) over a fake
// relay and editor: the frozen object and its pre-boot behaviour, the boot
// document hand-off, setDocument / settled semantics (identical text sends
// nothing; halted, timeout and afterSession), the events derived from the
// relay's status and its taps, restart's inputs and guards, the cursor,
// liveness, memory and the offer. The fakes behave like what they stand for:
// the editor's edits reach the relay as the LSP client sends them (coalesced,
// never synchronously), the relay remembers its restart options, posts a copy
// and reports its own status(); where a sequence of sessions matters, the real
// LspRelay runs.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codeFromHash, createPageApi, isSyntheticFrame, pageStatusSink, toApiStatus, FILE_PROGRESS_MS, LIVENESS_TIMING,
  type ApiStatus, type Capabilities, type EditorLike, type PageApi, type RelayLike,
} from "../../frontend/src/page-api";
import { normalizeMemoryBytes, parseMemoryParam } from "../../frontend/src/embed/params";
import { LspRelay, type RelaySession, type RelayStatus, type RestartOptions } from "../../frontend/src/lsp-relay";
import { tapRelay, type LspMessage } from "../../frontend/src/relay-taps";
import { createCheckFallback } from "../../frontend/src/check-fallback";
import { STAGES, createBootChecklist } from "../../frontend/src/boot-checklist";
import { STALE_NOTICE, createStaleWatch, isStaleDeath } from "../../frontend/src/stale-notice";
import { deathCause } from "../../frontend/src/embed/failure";
import type { JsonRpcMessage, WorkerStatus } from "../../src/runtime/client";

const CAPS: Capabilities = {
  editorRpc: true, documents: true, events: true, restart: true, embedMode: true, snapshotRoots: false, postMessage: false,
  liveness: true, memory: true, widgetSourceCache: true, offers: true,
};
const BUILD = { buildId: "wasm64-3ab1c6a9da03bc29", leanVersion: "4.34.0", sourceRevision: "x@abc", shell: null };
const URI = "file:///project/Probe.lean";
const GiB = 1073741824;

function status(over: Partial<RelayStatus> = {}): RelayStatus {
  return { phase: "ready", version: 1, header: null, ring: { bytesQueued: 0, refused: 0 }, pool: { unused: 1, running: 0 }, dropped: 0, collision: null, relay: "serving", rebootReason: null, session: "s1", lastDeath: null, ...over } as RelayStatus;
}

class FakeRelay implements RelayLike {
  state = { kind: "serving" };
  doc: { uri: string; version: number } | null = null;
  lastText = "";
  session = { id: "s1", snapshots: ["init", "mathlib"] as readonly string[], initialBytes: 2 * GiB };
  current = status();
  restarts: RestartOptions[] = [];
  remembered: RestartOptions | undefined = undefined;
  posted: LspMessage[] = [];
  status() { return this.current; }
  restart(opts: RestartOptions) { this.restarts.push(opts); this.remembered = opts; } // LspRelay keeps them as restartOpts
  reusableOpts() { return this.remembered; }
  fromClient(msg: LspMessage) {
    const p = msg.params as { textDocument: { uri: string; version: number; text?: string }; contentChanges?: { text: string }[] };
    if (msg.method === "textDocument/didOpen") { this.doc = { uri: p.textDocument.uri, version: p.textDocument.version }; this.lastText = p.textDocument.text ?? ""; }
    if (msg.method === "textDocument/didChange" && this.doc) { this.doc.version = p.textDocument.version; this.lastText = p.contentChanges![0]!.text; }
  }
  toClient(msg: LspMessage) { this.posted.push(structuredClone(msg)); } // postMessage: a copy, taken at post time
}

/** vscode-languageclient 9.0.1 sends queued full-text changes 250 ms after the last edit (client.js `new Delayer(250)`). */
const CLIENT_FLUSH_MS = 250;

/** A one-document editor whose edits reach the relay the way the LSP client sends them: full text (the
 * front door's change = 1) and coalesced — an edit only queues the document, and the trailing delayer,
 * restarted by every edit, sends ONE didChange with the text and version id at flush time
 * (textSynchronization.js `_pendingTextDocumentChanges`). Never synchronously. */
class FakeEditor implements EditorLike {
  text = "";
  version = 1;
  edits = 0;
  position = { lineNumber: 1, column: 1 };
  focused = 0;
  private flushTimer: unknown = null;
  constructor(private readonly relay: FakeRelay, private readonly clock: Clock) {}
  getModel() {
    const lines = () => this.text.split("\n");
    return {
      uri: { toString: () => URI }, getValue: () => this.text, getFullModelRange: () => "all", setValue: (t: string) => this.change(t),
      getLineCount: () => lines().length, getLineMaxColumn: (n: number) => (lines()[n - 1] ?? "").length + 1, getEOL: () => "\n",
      getVersionId: () => this.version,
    };
  }
  executeEdits(_s: string, edits: Array<{ text: string }>) { this.edits += 1; this.change(edits[0]!.text); return true; }
  pushUndoStop() { return true; }
  getPosition() { return this.position; }
  setPosition(p: { lineNumber: number; column: number }) { this.position = p; }
  revealPositionInCenterIfOutsideViewport() {}
  focus() { this.focused += 1; }
  /** A keystroke or an InfoView edit: a change the API did not make. */
  type(t: string) { this.change(t); }
  private change(t: string) {
    t = t.replace(/\r\n?/g, "\n"); // Monaco keeps one EOL: inserted CRLF / CR become the model's
    if (t === this.text) return;
    this.text = t;
    this.version += 1;
    if (this.flushTimer !== null) this.clock.clearTimeout(this.flushTimer);
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = null;
      this.relay.fromClient({ method: "textDocument/didChange", params: { textDocument: { uri: URI, version: this.version }, contentChanges: [{ text: this.text }] } });
    }, CLIENT_FLUSH_MS);
  }
}

class Clock {
  t = 1000;
  timers: Array<{ at: number; f: () => void; id: number }> = [];
  seq = 0;
  now = () => this.t;
  setTimeout = (f: () => void, ms: number) => { const id = (this.seq += 1); this.timers.push({ at: this.t + ms, f, id }); return id; };
  clearTimeout = (id: unknown) => { this.timers = this.timers.filter((x) => x.id !== id); };
  advance(ms: number) {
    this.t += ms;
    for (const x of this.timers.filter((y) => y.at <= this.t)) { this.clearTimeout(x.id); x.f(); }
  }
}

function setup() {
  const clock = new Clock();
  const page = createPageApi(CAPS, clock);
  const relay = new FakeRelay();
  const editor = new FakeEditor(relay, clock);
  const taps = tapRelay(relay);
  return { page, relay, editor, taps, clock, api: page.api };
}
type T = ReturnType<typeof setup>;
function boot(t: T, text = "example : True := trivial\n") {
  t.page.takeBootDocument();
  t.page.bind({ relay: t.relay, taps: t.taps, editor: () => t.editor, build: BUILD, snapshotNames: ["init", "mathlib", "widgets"], memoryBytes: normalizeMemoryBytes });
  t.editor.text = text;
  t.relay.fromClient({ method: "textDocument/didOpen", params: { textDocument: { uri: URI, version: 1, text } } });
  t.page.editorReady();
}
/** The relay reports a status: its sink gets the relay's own status() (LspRelay calls `sink.status(this.status())`). */
function report(t: T, over: Partial<RelayStatus>) {
  t.relay.current = status(over);
  t.page.relayStatus(t.relay.current);
}
const flush = () => new Promise((r) => setTimeout(r, 0));
/** What a promise has come to once pending work ran: its value, its rejection, or "pending". */
async function outcome(p: Promise<unknown>): Promise<unknown> {
  let got: unknown = "pending";
  p.then((v) => { got = v; }, (e: unknown) => { got = e; });
  await flush();
  return got;
}

describe("the object", () => {
  it("is frozen, versioned and answers status() before anything is bound", () => {
    const { api } = setup();
    expect(Object.isFrozen(api) && Object.isFrozen(api.capabilities)).toBe(true);
    expect(api.version).toBe(1);
    expect(api.revision).toMatch(/^1\.\d+\.\d+$/);
    expect(api.capabilities).toEqual(CAPS);
    expect(api.build()).toBeNull();
    expect(api.getDocument()).toBeNull();
    expect(api.getCursor()).toBeNull();
    expect(api.focus()).toBe(false);
    expect(api.status()).toMatchObject({ phase: "booting", relay: "rebooting", session: null, version: null, lastDeath: null, snapshots: null, liveness: null, memory: null, offer: null, boot: { overlay: true } });
    expect(api.restart()).toEqual({ accepted: false, fromSession: null });
    expect(api.setCursor({ lineNumber: 1, column: 1 })).toBe(false);
    expect(api.acceptOffer()).toBe(false);
  });

  it("the stable projection leaves the internal counters out", () => {
    const s = toApiStatus(status({ liveness: { probes: 1, answered: 1, stalls: 0, resumed: 0, rescues: 0 } }), { stage: "done", label: "", done: true, failed: false, message: null, overlay: false }, ["init"]);
    expect(Object.keys(s).sort()).toEqual(["boot", "collision", "header", "lastDeath", "liveness", "memory", "offer", "phase", "rebootReason", "relay", "session", "snapshots", "version"]);
    expect(s.liveness).toBeNull(); // counters are not the projection
  });

  it("whenReady waits for both the relay and the mounted editor", async () => {
    const t = setup();
    let ready = false;
    void t.api.whenReady().then(() => { ready = true; });
    t.page.bind({ relay: t.relay, taps: t.taps, editor: () => t.editor, build: BUILD, snapshotNames: [] });
    await flush();
    expect(ready).toBe(false);
    t.page.editorReady();
    await flush();
    expect(ready).toBe(true);
    expect(t.api.build()).toEqual(BUILD);
  });
});

describe("the boot document", () => {
  it("setDocument before boot becomes the boot document and resolves once the page is up", async () => {
    const t = setup();
    const p = t.api.setDocument("import Mathlib\n");
    await expect(t.page.waitBootDocument(new Promise(() => {}))).resolves.toBe("import Mathlib\n");
    expect(t.page.takeBootDocument()).toBe("import Mathlib\n");
    t.page.bind({ relay: t.relay, taps: t.taps, editor: () => t.editor, build: BUILD, snapshotNames: [] });
    t.relay.fromClient({ method: "textDocument/didOpen", params: { textDocument: { uri: URI, version: 1, text: "import Mathlib\n" } } });
    t.page.editorReady();
    await expect(p).resolves.toEqual({ version: 1, unchanged: false });
  });
  it("waitBootDocument gives up at the deadline; a setDocument after boot read it edits the editor instead", async () => {
    const t = setup();
    await expect(t.page.waitBootDocument(Promise.resolve())).resolves.toBeNull();
    boot(t);
    const r = t.api.setDocument("theorem t : 1 = 1 := rfl\n");
    t.clock.advance(CLIENT_FLUSH_MS);
    await expect(r).resolves.toEqual({ version: 2, unchanged: false });
    expect(t.editor.edits).toBe(1);
  });
  it("#code= decodes (lean4web's spelling); anything else is not a boot document", () => {
    expect(codeFromHash(`#code=${encodeURIComponent("import Mathlib\n-- ∀ x, x = x\n")}`)).toBe("import Mathlib\n-- ∀ x, x = x\n");
    expect(codeFromHash("#foo=1&code=abc")).toBe("abc");
    expect(codeFromHash("")).toBeNull();
    expect(codeFromHash("#codez=N4Ig")).toBeNull();
    expect(codeFromHash("#code=%E0%A4%A")).toBeNull(); // malformed
  });
});

describe("setDocument / settled", () => {
  it("identical text resolves at once, unchanged, and sends nothing", async () => {
    const t = setup();
    boot(t, "A\n");
    await expect(t.api.setDocument("A\n")).resolves.toEqual({ version: 1, unchanged: true });
    expect(t.editor.edits).toBe(0);
  });
  it("undoable: false uses setValue; the cursor is set (clamped) when given", async () => {
    const t = setup();
    boot(t, "A\n");
    const r = t.api.setDocument("BC\nD\n", { undoable: false, cursor: { lineNumber: 1, column: 99 } });
    t.clock.advance(CLIENT_FLUSH_MS);
    await expect(r).resolves.toEqual({ version: 2, unchanged: false });
    expect(t.editor.edits).toBe(0);
    expect(t.api.getCursor()).toEqual({ lineNumber: 1, column: 3 });
  });
  it("settled waits for ready at the requested version, through a reboot", async () => {
    const t = setup();
    boot(t);
    t.relay.current = status({ phase: "elaborating", version: 1 });
    let got: ApiStatus | null = null;
    void t.api.settled({ version: 2 }).then((s) => { got = s; });
    report(t, { phase: "ready", version: 1 }); // an older version settling is not it
    t.relay.session = { ...t.relay.session, id: "s2" };
    report(t, { phase: "booting", relay: "rebooting", rebootReason: "crash", session: "s2", version: null });
    await flush();
    expect(got).toBeNull();
    report(t, { phase: "ready", version: 2, session: "s2" });
    await flush();
    expect(got).toMatchObject({ phase: "ready", version: 2, session: "s2" });
  });
  it("settled({afterSession}) never resolves on that session", async () => {
    const t = setup();
    boot(t);
    let got: ApiStatus | null = null;
    void t.api.settled({ afterSession: "s1" }).then((s) => { got = s; });
    report(t, { phase: "ready", version: 1, session: "s1" });
    await flush();
    expect(got).toBeNull();
    t.relay.session = { ...t.relay.session, id: "s2" };
    report(t, { phase: "ready", version: 1, session: "s2" });
    await flush();
    expect(got).toMatchObject({ session: "s2" });
  });
  it("a status the page superseded inside the sink (a self-widen) is never reported", () => {
    const t = setup();
    boot(t);
    const seen: string[] = [];
    t.api.on("status", (s) => seen.push(`${s.session} ${s.phase}`));
    t.api.on("ready", (r) => seen.push(`ready ${r.session}`));
    t.relay.session = { ...t.relay.session, id: "s2" }; // the widen restarted inside the sink…
    t.page.relayStatus(status({ phase: "booting", relay: "rebooting", rebootReason: "user", session: "s2", version: null }));
    t.page.relayStatus(status({ phase: "headerRefused", session: "s1", version: 1 })); // …then the stale verdict arrives
    expect(seen).toEqual(["s2 booting"]);
  });
  it("settled resolves at once when already settled; rejects HALTED and TIMEOUT", async () => {
    const t = setup();
    boot(t);
    await expect(t.api.settled()).resolves.toMatchObject({ phase: "ready", version: 1 });
    const halted = t.api.settled({ version: 9 });
    report(t, { phase: "halted", relay: "halted", version: 1 });
    await expect(halted).rejects.toMatchObject({ code: "HALTED" });
    await expect(t.api.settled()).rejects.toMatchObject({ code: "HALTED" }); // still halted: at once
    report(t, { phase: "elaborating", version: 1 }); // re-armed by an edit
    const slow = t.api.settled({ version: 9, timeoutMs: 1000 });
    t.clock.advance(1000);
    await expect(slow).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("review fixes", () => {
  it("setDocument with CRLF or lone-CR text resolves (the model normalizes line endings), and identical-modulo-EOL is unchanged", async () => {
    const t = setup();
    boot(t, "A\n");
    const r = t.api.setDocument("B\r\nC\rD\n");
    t.clock.advance(CLIENT_FLUSH_MS);
    await expect(r).resolves.toEqual({ version: 2, unchanged: false });
    expect(t.editor.text).toBe("B\nC\nD\n");
    await expect(t.api.setDocument("B\r\nC\nD\r\n")).resolves.toEqual({ version: 2, unchanged: true });
  });
  it("a status listener that restarts the session suppresses the superseded ready and settled", async () => {
    const t = setup();
    boot(t);
    t.relay.current = status({ phase: "elaborating" });
    const readies: string[] = [];
    t.api.on("ready", (r) => readies.push(r.session));
    const off = t.api.on("status", () => { // an embedder's own widening
      off();
      t.relay.session = { ...t.relay.session, id: "s2" };
      t.relay.current = status({ phase: "booting", relay: "rebooting", rebootReason: "user", session: "s2", version: null });
    });
    const verdict = t.api.settled();
    report(t, { phase: "headerRefused", session: "s1", version: 1 });
    expect(readies).toEqual([]);
    expect(await outcome(verdict)).toBe("pending");
  });
  it("a boot that fails before the page is up rejects whenReady, settled and a pre-boot setDocument", async () => {
    const t = setup();
    const ready = t.api.whenReady();
    const settled = t.api.settled();
    const doc = t.api.setDocument("x");
    t.page.bootFailed("refused ?snapshots=/evil: …");
    await expect(ready).rejects.toMatchObject({ code: "BOOT_FAILED" });
    await expect(settled).rejects.toMatchObject({ code: "BOOT_FAILED" });
    await expect(doc).rejects.toMatchObject({ code: "BOOT_FAILED" });
  });
  it("restart({initialBytes}) sets the sticky commit; a later explicit restart without it clears it", () => {
    const t = setup();
    const sticky: Array<number | null> = [];
    t.page.takeBootDocument();
    t.page.bind({ relay: t.relay, taps: t.taps, editor: () => t.editor, build: BUILD, snapshotNames: ["init", "mathlib"], memoryBytes: normalizeMemoryBytes, setSessionMemory: (b) => sticky.push(b) });
    t.page.editorReady();
    t.api.restart({ initialBytes: 3 * GiB });
    t.api.restart();
    expect(sticky).toEqual([3 * GiB, null]);
    expect(t.relay.restarts).toEqual([{ snapshots: ["init", "mathlib"], initialBytes: 3 * GiB }, { snapshots: ["init", "mathlib"] }]); // not the remembered commit
  });
  it("a boot failure is kept: whenReady, settled and a pre-boot setDocument called AFTER it reject too", async () => {
    // The iframe's load event comes after a refused parameter already failed the boot (main().catch runs first).
    const t = setup();
    let fromListener: Promise<unknown> = Promise.resolve("no boot event");
    t.api.on("boot", (b) => { if (b.failed) fromListener = t.api.settled(); }); // registered while the failure is being reported
    t.page.bootFailed("refused ?snapshots=/evil: …");
    expect(await outcome(fromListener)).toMatchObject({ code: "BOOT_FAILED" });
    expect(await outcome(t.api.whenReady())).toMatchObject({ code: "BOOT_FAILED", message: "refused ?snapshots=/evil: …" });
    expect(await outcome(t.api.settled())).toMatchObject({ code: "BOOT_FAILED" });
    expect(await outcome(t.api.setDocument("x"))).toMatchObject({ code: "BOOT_FAILED" });
  });
  it("a boot that fails after bind but before the editor mounts rejects settled too, called before or after it", async () => {
    // main(): bind(), then `await leanMonaco.start()` throws, so editorReady never comes. With no didOpen the
    // front door says "starting" (lsp-front-door.js phaseOf: no doc), and no verdict will ever settle it.
    const t = setup();
    t.page.takeBootDocument();
    t.page.bind({ relay: t.relay, taps: t.taps, editor: () => undefined, build: BUILD, snapshotNames: [] });
    report(t, { phase: "starting", version: null });
    const before = outcome(t.api.settled());
    t.page.bootFailed("monaco failed to start");
    expect(await outcome(t.api.whenReady())).toMatchObject({ code: "BOOT_FAILED" });
    expect(await before).toMatchObject({ code: "BOOT_FAILED" });
    expect(await outcome(t.api.settled())).toMatchObject({ code: "BOOT_FAILED" });
  });
  it("settled resolves with its own status: a status listener editing the shared payload, before or after it, changes nothing", async () => {
    const t = setup();
    boot(t);
    const payloads: ApiStatus[] = [];
    t.api.on("status", (s) => { payloads.push(s); s.version = 0; s.header?.missing.splice(0); }); // runs before settled's check
    const verdict = t.api.settled({ version: 2 });
    t.api.on("status", (s) => { s.header?.missing.splice(0); }); // runs after it, before its caller sees the value
    report(t, { phase: "headerRefused", version: 2, header: { version: 2, mode: "refused", key: [], moduleCount: 0, missing: ["Mathlib"], ms: 0 } });
    const got = await outcome(verdict);
    expect(got).toMatchObject({ phase: "headerRefused", version: 2, header: { missing: ["Mathlib"] } });
    expect(payloads).not.toContain(got);
    expect(t.api.status().header?.missing).toEqual(["Mathlib"]);
  });
  it("back-to-back setDocument calls settle on the ONE didChange the LSP client coalesces them into; a repeat waits for it", async () => {
    const t = setup();
    boot(t, "A\n");
    const forwarded: number[] = [];
    t.api.on("document", (d) => forwarded.push(d.version));
    const first = t.api.setDocument("L1\n");
    const second = t.api.setDocument("L2\n");
    const repeat = t.api.setDocument("L2\n"); // the model holds it already; the relay does not
    expect(await outcome(repeat)).toBe("pending"); // not the previous text's version
    t.clock.advance(CLIENT_FLUSH_MS);
    expect(forwarded).toEqual([3]);
    expect(await outcome(first)).toEqual({ version: 3, unchanged: false }); // superseded in the window: the text that replaced it
    expect(await outcome(second)).toEqual({ version: 3, unchanged: false });
    expect(await outcome(repeat)).toEqual({ version: 3, unchanged: true });
  });
  it("a keystroke inside the client's window still settles setDocument, with the version that carried both", async () => {
    const t = setup();
    boot(t, "A\n");
    const r = t.api.setDocument("B\n");
    t.clock.advance(100);
    t.editor.type("B\nx");
    t.clock.advance(CLIENT_FLUSH_MS);
    expect(await outcome(r)).toEqual({ version: 3, unchanged: false });
  });
  it("a new session's liveness reports no frame until it sends one, not the dead session's silence", () => {
    const t = setup();
    boot(t);
    const zero = { probes: 0, answered: 0, stalls: 0, resumed: 0, rescues: 0 };
    t.page.relayStatus(status({ phase: "elaborating", liveness: zero }));
    t.relay.toClient({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { textDocument: { uri: URI, version: 1 }, processing: [] } });
    t.clock.advance(18000); // wedged
    t.relay.session = { ...t.relay.session, id: "s2" };
    t.page.relayStatus(status({ phase: "booting", relay: "rebooting", rebootReason: "wedged", session: "s2", version: null }));
    t.clock.advance(30000); // the replacement loads its snapshots, then opens its loop
    t.page.relayStatus(status({ phase: "elaborating", session: "s2", liveness: zero }));
    expect(t.api.status().liveness).toMatchObject({ lastAnswerAgoMs: null, lastFrameAgoMs: null });
  });
  it("payloads are copies: a listener editing one in place changes neither what the editor receives nor the page's state", () => {
    const t = setup();
    boot(t);
    t.api.on("diagnostics", (d) => { d.diagnostics.length = 0; });
    t.api.on("fileProgress", (p) => { p.processing.length = 0; });
    t.api.on("death", (d) => { d.cause!.message = "edited"; });
    t.api.on("boot", (b) => { if (b.error) b.error.message = "edited"; });
    t.api.on("status", (s) => { s.header?.missing.splice(0); });
    const readies: unknown[] = [];
    t.api.on("ready", (r) => readies.push(r.header?.missing));
    const publish = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [{ range: {}, message: "x", source: "Lean 4" }] } };
    t.taps.toClient(publish);
    expect((t.relay.posted[0]!.params as { diagnostics: unknown[] }).diagnostics).toHaveLength(1); // the editor's markers
    const processing = [{ range: {} }];
    t.taps.toClient({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { textDocument: { uri: URI, version: 1 }, processing } });
    t.clock.advance(FILE_PROGRESS_MS);
    expect(processing).toHaveLength(1);
    const cause = { kind: "network" as const, message: "HTTP 503" };
    t.relay.current = status({ phase: "headerRefused", header: { version: 1, mode: "refused", key: [], moduleCount: 0, missing: ["Mathlib"], ms: 0 }, lastDeath: { reason: "bootFailed", message: "m", seq: 1, session: "s1", cause } });
    t.page.relayStatus(t.relay.current);
    t.page.bootFailed("m", cause);
    expect(cause.message).toBe("HTTP 503");
    expect(t.api.status().lastDeath?.cause?.message).toBe("HTTP 503");
    expect(readies).toEqual([["Mathlib"]]);
  });
});

/** A RelaySession that boots at once, its commit sized the way ResidentSession sizes it: the restart's
 * `initialBytes`, else the page's policy (main.ts: the sticky api commit, else the default). */
/** main.ts's boot card as renderStatus drives it: EVERY status goes to the real check fallback first; a halt
 * before any ready turns the card into the failure card (bootFail); a final verdict finishes the boot; the
 * fallback's timer finishes it too. Only the card's own bookkeeping is modelled here — the fallback decision is
 * check-fallback.ts itself. */
function bootCardModel(page: PageApi, clock: Clock, onFire: () => void) {
  let bootDone = false, everReady = false;
  const events: string[] = [];
  const checklist = createBootChecklist();
  const finish = (why: string) => { if (bootDone) return; bootDone = true; events.push(why); page.bootFinished(); checklist.finish(); };
  const fallback = createCheckFallback(() => { onFire(); finish("editor shown"); }, 30000, clock);
  return {
    events,
    checklist,
    /** The active checklist step's name ("done" once finished). */
    step: () => STAGES[checklist.stage] ?? "done",
    /** main.ts bootProgress: a progress report while the card is up. */
    progress(label: string, info?: { phase?: string }) { if (!bootDone) checklist.progress(label, info); },
    renderStatus(s: RelayStatus) {
      if (!bootDone) { fallback.observe(s); checklist.observe(s); }
      if (s.phase === "ready") everReady = true;
      if (s.phase === "halted") { if (s.lastDeath && !everReady && !bootDone) events.push("failure card"); return; }
      if (s.phase === "ready" || s.phase === "headerRefused") finish("verdict");
    },
  };
}

class Session implements RelaySession {
  onLsp: (msg: JsonRpcMessage) => void = () => {};
  onStatus: (status: WorkerStatus) => void = () => {};
  onDied: (code: number | null, reason: string, message: string, cause?: unknown) => void = () => {};
  readonly snapshots: readonly string[];
  readonly initialBytes: number;
  constructor(readonly id: string, opts: RestartOptions, sticky: number | null) {
    this.snapshots = opts.snapshots ?? ["init", "mathlib"];
    this.initialBytes = opts.initialBytes ?? sticky ?? 2 * GiB;
  }
  start() { return Promise.resolve(); }
  arm() { return Promise.resolve(); }
  lsp() {}
  dispose() {}
  terminate() {}
  die() { this.onDied(134, "abort", "out of memory"); }
  report(over: Partial<WorkerStatus>) { this.onStatus({ phase: "ready", version: 1, header: null, ring: { bytesQueued: 0, refused: 0 }, pool: { unused: 1, running: 0 }, dropped: 0, collision: null, ...over }); }
}

describe("over the real relay", () => {
  const relays: LspRelay[] = [];
  afterEach(() => { for (const r of relays.splice(0)) { r.clientPort.close(); r.unload(); } });
  /** The real LspRelay (its remembered restart options, its breaker, its status order) under the page API;
   * `sinkOf` builds the relay's status sink (default: the API alone). */
  function overRelay(sinkOf?: (relay: LspRelay, page: PageApi) => (s: RelayStatus) => void) {
    const page = createPageApi(CAPS, new Clock());
    const sessions: Session[] = [];
    let sticky: number | null = null;
    let sink = (s: RelayStatus) => page.relayStatus(s);
    const relay = new LspRelay((opts) => {
      const s = new Session(`s${sessions.length + 1}`, opts ?? {}, sticky);
      sessions.push(s);
      return s;
    }, { status: (s) => sink(s) }, () => Promise.resolve());
    relays.push(relay);
    if (sinkOf) sink = sinkOf(relay, page);
    page.takeBootDocument();
    page.bind({ relay, taps: tapRelay(relay), editor: () => undefined, build: BUILD, snapshotNames: ["init", "mathlib"], memoryBytes: normalizeMemoryBytes, setSessionMemory: (b) => { sticky = b; } });
    page.editorReady();
    return { relay, page, api: page.api, current: () => sessions[sessions.length - 1]! };
  }

  // lean4game QD-API-2: a deploy under a running page pairs two worker revisions; the relay heals, but the page
  // runs its old bundle and had no typed way to know. The cause kind `stale` is that signal (EMBEDDING §7.2).
  it("a stale-page death (WORKER_DEP_MISMATCH) reaches the death event and a halted boot's failure as kind stale; the page's prompt shows once", async () => {
    const shown: string[] = [];
    const watch = createStaleWatch((d) => shown.push(d.message));
    const h = overRelay((relay, page) => (s) => { // main.ts renderStatus: the watch, and a halt before ready is bootFail(message, cause)
      page.relayStatus(s);
      watch(s);
      if (s.phase === "halted" && s.lastDeath) page.bootFailed(s.lastDeath.message, s.lastDeath.cause);
    });
    const deaths: string[] = [];
    const boots: string[] = [];
    h.api.on("death", (d) => deaths.push(`${d.session} ${d.reason} ${d.cause?.kind} ${d.cause?.code} reboot=${d.willReboot} halted=${d.halted}`));
    h.api.on("boot", (b) => { if (b.failed) boots.push(`${b.stage} ${b.error?.kind} ${b.error?.code}`); });
    await flush();
    h.current().report({ phase: "ready" });
    const message = "lsp-front-door.js is revision \"2\", lean.worker.js needs 1 (a deploy mixed versions; reload)";
    // What ResidentSession hands the relay for the worker's error reply (deathCause, embed-library.test.ts).
    const dieStale = () => h.current().onDied(null, "WORKER_DEP_MISMATCH", message, deathCause("WORKER_DEP_MISMATCH", message, { errorCode: "WORKER_DEP_MISMATCH" }));
    dieStale();
    await flush();
    expect(deaths).toEqual(["s1 WORKER_DEP_MISMATCH stale WORKER_DEP_MISMATCH reboot=true halted=false"]);
    expect(isStaleDeath(h.relay.status().lastDeath)).toBe(true);
    expect(shown).toEqual([message]);
    h.current().report({ phase: "ready" }); // the replacement loaded the new scripts and serves: lastDeath clears, the prompt stays
    expect(h.relay.status().lastDeath).toBeNull();
    for (let i = 0; i < 2; i++) { dieStale(); await flush(); } // each replacement boots, then dies the same way: the breaker halts
    expect(h.relay.state.kind).toBe("halted");
    expect(deaths.at(-1)).toBe("s3 WORKER_DEP_MISMATCH stale WORKER_DEP_MISMATCH reboot=false halted=true");
    expect(boots).toEqual(["failed stale WORKER_DEP_MISMATCH"]);
    expect(shown).toHaveLength(1); // once per page
    expect(STALE_NOTICE).toMatch(/reload/);
  });
  it("the stale watch ignores every other death and a status without one", () => {
    const shown: unknown[] = [];
    const watch = createStaleWatch((d) => shown.push(d));
    const other = { reason: "WORKER_DEP_MISSING", message: "x", seq: 1, session: "s1", cause: { kind: "other" as const, code: "WORKER_SCRIPT_LOAD_FAILED", message: "x" } };
    expect([watch({ lastDeath: null }), watch({ lastDeath: other }), watch({ lastDeath: { ...other, cause: undefined } })]).toEqual([false, false, false]);
    expect(shown).toEqual([]);
  });
  it("restart() without initialBytes goes back to the page default: the relay's remembered options carry no commit", async () => {
    const h = overRelay();
    await flush();
    h.api.restart({ initialBytes: 3 * GiB });
    await flush();
    expect(h.current().initialBytes).toBe(3 * GiB);
    h.api.restart();
    await flush();
    expect(h.current().initialBytes).toBe(2 * GiB);
    expect(h.api.status().memory?.initialBytes).toBe(2 * GiB);
    h.current().die(); // a crash reboot reuses that restart's options
    expect(h.current().initialBytes).toBe(2 * GiB);
  });
  it("restart() on a halted relay re-arms on the page's default commit, not the sticky one", async () => {
    const h = overRelay();
    await flush();
    h.api.restart({ initialBytes: 6 * GiB });
    await flush();
    for (let i = 0; i < 3; i++) h.current().die(); // the crash-loop breaker
    expect(h.relay.state.kind).toBe("halted");
    expect(h.api.restart({ initialBytes: 2 * GiB })).toMatchObject({ accepted: false });
    expect(h.api.restart()).toEqual({ accepted: true, fromSession: "s4" });
    expect(h.current().initialBytes).toBe(2 * GiB);
  });
  it("a verdict the page's self-widen supersedes finishes no boot: boot done, status() and settled() come with the replacement", async () => {
    let widened = false;
    const h = overRelay((relay, page) => pageStatusSink(
      () => relay.session.id,
      (s) => { // main.ts widenForRoots: restart once with the environment that covers the refused header
        if (widened || s.phase !== "headerRefused" || s.header?.mode !== "refused") return;
        widened = true;
        relay.restart({ snapshots: ["init", "mathlib"] });
      },
      (s) => { if (s.phase === "ready" || s.phase === "headerRefused") page.bootFinished(); }, // main.ts renderStatus → bootFinish
      (s) => page.relayStatus(s),
    ));
    const seen: string[] = [];
    h.api.on("boot", (b) => {
      if (!b.done) return;
      const s = h.api.status();
      seen.push(`done ${s.session} ${s.phase}`);
      void h.api.settled().then((v) => seen.push(`settled ${v.session} ${v.phase}`));
    });
    await flush(); // the light session serves; the document's Mathlib header is refused
    h.current().report({ phase: "headerRefused", header: { version: 1, mode: "refused", key: [], moduleCount: 0, missing: ["Mathlib"], ms: 0 } });
    await flush();
    expect(h.relay.session.id).toBe("s2");
    h.current().report({ phase: "ready" });
    await flush();
    expect(seen).toEqual(["done s2 ready", "settled s2 ready"]);
  });
  it("the boot card's check fallback armed by the replaced light session never finishes the widened boot (check-fallback.ts, fed every status as main.ts does)", async () => {
    const clock = new Clock();
    let widened = false;
    const finished: string[] = [];
    let card!: ReturnType<typeof bootCardModel>;
    const h = overRelay((relay, page) => {
      card = bootCardModel(page, clock, () => finished.push(`fallback ${relay.session.id} ${relay.status().phase}`));
      return pageStatusSink(
        () => relay.session.id,
        (s) => { // main.ts selfWiden: restart once with the environment that covers the refused header
          if (widened || s.phase !== "headerRefused" || s.header?.mode !== "refused") return;
          widened = true;
          relay.restart({ snapshots: ["init", "mathlib"] });
        },
        card.renderStatus,
        (s) => page.relayStatus(s),
      );
    });
    const done: string[] = [];
    h.api.on("boot", (b) => { if (b.done) done.push(`${h.api.status().session} ${h.api.status().phase}`); });
    await flush(); // the light session serves (the arm's status carries a non-final phase): the fallback arms
    expect(clock.timers).toHaveLength(1);
    card.progress("elaborating");
    expect(card.step()).toBe("check");
    h.current().report({ phase: "headerRefused", header: { version: 1, mode: "refused", key: [], moduleCount: 0, missing: ["Mathlib"], ms: 0 } });
    expect(card.step()).toBe("runtime"); // the checklist follows the replacement's download
    // Widened synchronously: the replacement's rebooting status (reason "user") disarmed the light session's
    // timer — while the replacement is still booting (its download can take minutes), nothing finishes the boot.
    expect(h.relay.session.id).toBe("s2");
    expect(clock.timers).toHaveLength(0);
    clock.advance(30000);
    expect(finished).toEqual([]);
    expect(done).toEqual([]);
    await flush(); // the replacement serves: ITS first serving status arms its own fallback
    expect(clock.timers).toHaveLength(1);
    h.current().report({ phase: "ready" });
    await flush();
    expect(done).toEqual(["s2 ready"]);
    clock.advance(60000);
    expect(finished).toEqual([]);
  });
  it("a deliberate restart during the first boot (api.restart, \"Load exact imports\") disarms the light session's fallback too", async () => {
    for (const how of ["api.restart", "offer"] as const) {
      const clock = new Clock();
      const finished: string[] = [];
      let card!: ReturnType<typeof bootCardModel>;
      const h = overRelay((relay, page) => {
        card = bootCardModel(page, clock, () => finished.push(`fallback ${relay.session.id}`));
        return pageStatusSink(() => relay.session.id, () => {}, card.renderStatus, (s) => page.relayStatus(s));
      });
      await flush(); // s1 serves: armed
      h.current().report({ phase: "elaborating" });
      card.progress("elaborating");
      expect(card.step(), how).toBe("check");
      clock.advance(5000);
      if (how === "api.restart") expect(h.api.restart({ snapshots: ["init", "mathlib"] }).accepted).toBe(true);
      else h.relay.restart({ snapshots: ["init", "mathlib"], warmHeader: "import Mathlib\n", packs: ["essential"] }); // main.ts's offer
      expect(clock.timers, how).toHaveLength(0);
      // The card stays up for the replacement's download, and its checklist shows that download, not "Check".
      expect(card.step(), how).toBe("runtime");
      card.progress("downloading the Mathlib environment (1.0 GB)", { phase: "snapshot" });
      expect(card.step(), how).toBe("env");
      h.current().report({ phase: "booting", version: null }); // a later status of the same replacement: no second rewind
      expect(h.relay.state.kind, how).toBe("rebooting");
      expect(card.step(), how).toBe("env");
      clock.advance(60000); // the replacement is still booting (a download): nothing finishes the boot
      expect(finished, how).toEqual([]);
      expect(h.api.status().boot.done, how).toBe(false);
    }
  });
});

describe("the check fallback over the real relay's crash loop", () => {
  const relays: LspRelay[] = [];
  afterEach(() => { for (const r of relays.splice(0)) { r.clientPort.close(); r.unload(); } });
  it("a restored buffer that kills the checker after every serve still surfaces the editor 30 s after the first serve: crash reboots and the halt leave the fallback armed", async () => {
    const clock = new Clock();
    const page = createPageApi(CAPS, new Clock());
    const sessions: Session[] = [];
    const card = bootCardModel(page, clock, () => {});
    const relay: LspRelay = new LspRelay(() => { const x = new Session(`s${sessions.length + 1}`, {}, null); sessions.push(x); return x; }, {
      status: pageStatusSink(() => relay.session.id, () => {}, card.renderStatus, (s) => page.relayStatus(s)),
    }, () => Promise.resolve());
    relays.push(relay);
    await flush(); // s1 serves: the fallback arms
    expect(clock.timers).toHaveLength(1);
    for (let i = 0; i < 3; i += 1) {
      sessions.at(-1)!.report({ phase: "elaborating" });
      card.progress("elaborating");
      clock.advance(5000);
      sessions.at(-1)!.die(); // the buffer kills the checker; the relay reboots (a crash reboot keeps the timer)
      expect(card.step()).toBe("check"); // and does not rewind the checklist: the card is gone 30 s after the first serve
      await flush();
    }
    expect(relay.state.kind).toBe("halted"); // the breaker: three deaths inside 120 s
    expect(card.events).toEqual(["failure card"]);
    clock.advance(15000); // 30 s after the FIRST serve
    expect(card.events).toEqual(["failure card", "editor shown"]); // the editor appears; the halted pill and note say "edit the file"
  });
  it("a boot that fails before any session serves keeps the failure card: only a serving status arms the fallback", async () => {
    const clock = new Clock();
    const page = createPageApi(CAPS, new Clock());
    const card = bootCardModel(page, clock, () => {});
    class Refused extends Session { override start() { return Promise.reject(new Error("Memory64 reservation refused")); } }
    let n = 0;
    const relay: LspRelay = new LspRelay(() => new Refused(`s${++n}`, {}, null), {
      status: pageStatusSink(() => relay.session.id, () => {}, card.renderStatus, (s) => page.relayStatus(s)),
    }, () => Promise.resolve());
    relays.push(relay);
    for (let i = 0; i < 6; i += 1) await flush();
    expect(relay.state.kind).toBe("halted"); // bootFailed three times: the breaker
    expect(relay.status().lastDeath?.reason).toBe("bootFailed");
    expect(card.events).toEqual(["failure card"]);
    expect(clock.timers).toHaveLength(0); // the rebooting statuses (reason bootFailed) never armed it
    clock.advance(120000);
    expect(card.events).toEqual(["failure card"]);
  });
});

describe("integration-review fixes", () => {
  it("status().memory forgets the previous session's meter reading when the session changes", () => {
    const t = setup();
    boot(t);
    report(t, { session: "s1" });
    t.page.memory(4 * GiB, 4 * GiB);
    expect(t.api.status().memory).toMatchObject({ currentBytes: 4 * GiB, maximumBytes: 4 * GiB });
    t.relay.session = { ...t.relay.session, id: "s2", initialBytes: 6 * GiB };
    report(t, { session: "s2", phase: "booting", relay: "rebooting", rebootReason: "user", version: null });
    expect(t.api.status().memory).toEqual({ initialBytes: 6 * GiB, currentBytes: null, maximumBytes: null });
  });
  it("status().memory never pairs a reading with another session's commit, even inside the sink pass that changes the session", () => {
    const t = setup();
    boot(t);
    report(t, { session: "s1" });
    t.page.memory(4 * GiB, 4 * GiB);
    t.relay.session = { ...t.relay.session, id: "s2", initialBytes: 6 * GiB }; // the relay already holds s2; the API has not seen its status yet
    expect(t.api.status().memory).toEqual({ initialBytes: 6 * GiB, currentBytes: null, maximumBytes: null });
  });
  it("settled() called BEFORE a restarting status listener is registered is not resolved by the superseded verdict", async () => {
    const t = setup();
    boot(t);
    report(t, { phase: "elaborating", version: 1 });
    const v = t.api.settled();
    t.api.on("status", (s) => { // an embedder's own widening, wired after it started waiting
      if (s.phase !== "headerRefused" || s.session !== "s1") return;
      t.relay.session = { ...t.relay.session, id: "s2" };
      t.relay.current = status({ phase: "booting", relay: "rebooting", rebootReason: "user", session: "s2", version: null });
    });
    report(t, { phase: "headerRefused", session: "s1", version: 1 });
    expect(await outcome(v)).toBe("pending");
    report(t, { phase: "ready", session: "s2", version: 1 });
    expect(await outcome(v)).toMatchObject({ session: "s2", phase: "ready" });
  });
  it("settled() called from a boot-done listener waits past a restart a later status listener makes", async () => {
    const t = setup();
    boot(t);
    let v: Promise<unknown> | null = null;
    t.api.on("boot", (b) => { if (b.done && !v) v = t.api.settled(); });
    t.api.on("status", (s) => {
      if (s.phase !== "headerRefused" || s.session !== "s1") return;
      t.relay.session = { ...t.relay.session, id: "s2" };
      t.relay.current = status({ phase: "booting", relay: "rebooting", rebootReason: "user", session: "s2", version: null });
    });
    // main.ts's sink: renderStatus finishes the boot (boot done) BEFORE the API emits this status.
    t.relay.current = status({ phase: "headerRefused", session: "s1", version: 1 });
    t.page.bootFinished();
    t.page.relayStatus(t.relay.current);
    expect(v).not.toBeNull();
    expect(await outcome(v!)).toBe("pending");
    report(t, { phase: "ready", session: "s2", version: 1 });
    expect(await outcome(v!)).toMatchObject({ session: "s2", phase: "ready" });
  });
});

describe("events", () => {
  it("document carries what the relay forwarded", () => {
    const t = setup();
    boot(t);
    const docs: unknown[] = [];
    t.api.on("document", (d) => docs.push(d));
    t.relay.fromClient({ method: "textDocument/didChange", params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: "X" }] } });
    expect(docs).toEqual([{ uri: URI, version: 2, length: 1, text: "X" }]);
  });
  it("ready fires once per (session, version); death and reboot are derived from the status sequence", () => {
    const t = setup();
    boot(t);
    const seen: string[] = [];
    t.api.on("ready", (r) => seen.push(`ready ${r.session}@${r.version}${r.refused ? " refused" : ""}`));
    t.api.on("death", (d) => seen.push(`death ${d.session} ${d.kind} ${d.cause?.kind ?? "-"} reboot=${d.willReboot} halted=${d.halted}`));
    t.api.on("reboot", (r) => seen.push(`reboot ${r.fromSession}→${r.toSession} ${r.reason}`));
    t.page.relayStatus(status({ version: 1 }));
    t.page.relayStatus(status({ version: 1 }));
    const death = { reason: "bootFailed", message: "snapshot 'mathlib' failed to load", seq: 1, session: "s1", cause: { kind: "network" as const, message: "HTTP 503" } };
    t.relay.session = { ...t.relay.session, id: "s2" };
    t.page.relayStatus(status({ phase: "booting", relay: "rebooting", rebootReason: "bootFailed", session: "s2", version: null, lastDeath: death }));
    t.page.relayStatus(status({ phase: "booting", relay: "rebooting", rebootReason: "bootFailed", session: "s2", version: null, lastDeath: death }));
    t.page.relayStatus(status({ phase: "headerRefused", session: "s2", version: 1, lastDeath: death }));
    t.page.relayStatus(status({ phase: "halted", relay: "halted", session: "s2", version: 1, lastDeath: { reason: "abort", message: "OOM", seq: 2, session: "s2", exitCode: 134 } }));
    expect(seen).toEqual([
      "ready s1@1",
      "reboot s1→s2 bootFailed",
      "death s1 bootFailed network reboot=true halted=false",
      "ready s2@1 refused",
      "death s2 abort - reboot=false halted=true",
    ]);
  });
  it("diagnostics name their origin; fileProgress coalesces on a timer and flushes before status; a throwing listener harms no one", () => {
    const t = setup();
    boot(t);
    const got: unknown[] = [];
    t.api.on("diagnostics", () => { throw new Error("embedder bug"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.api.on("diagnostics", (d) => got.push(["diag", d.origin, d.diagnostics.length]));
    t.api.on("fileProgress", (p) => got.push(["progress", p.processing.length]));
    t.api.on("status", () => got.push(["status"]));
    t.taps.toClient({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [{ range: {}, message: "x", source: "Lean 4" }] } });
    t.taps.toClient({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [{ range: {}, message: "halted", source: "QED64" }] } });
    const progress = (n: number) => t.taps.toClient({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { textDocument: { uri: URI, version: 1 }, processing: new Array(n).fill({ range: {} }) } });
    for (const n of [3, 2, 1]) progress(n);
    expect(got).toEqual([["diag", "lean", 1], ["diag", "qed64", 1]]);
    t.clock.advance(FILE_PROGRESS_MS);
    progress(4);
    t.page.relayStatus(status()); // flushes the pending progress first
    expect(got.slice(2)).toEqual([["progress", 1], ["progress", 4], ["status"]]);
    expect(t.relay.posted).toHaveLength(6); // the taps observe, the relay still posts
  });
  it("boot steps, the boot card, and on/off", () => {
    const t = setup();
    const boots: string[] = [];
    const off = t.api.on("boot", (b) => boots.push(`${b.stage}${b.subject ? `:${b.subject}` : ""}${b.done ? " done" : ""}${b.failed ? " failed" : ""}${b.error ? ` ${b.error.kind}` : ""}`));
    t.page.bootStep("installing the Lean core library", { stage: "profile", subject: "core" });
    t.page.bootStep("snapshot failed", { stage: "snapshot", subject: "mathlib", error: { kind: "network", message: "HTTP 503" } });
    expect(t.api.status().boot).toMatchObject({ stage: "snapshot", done: false, overlay: true });
    t.page.bootFinished();
    expect(t.api.status().boot).toMatchObject({ done: true, overlay: false });
    off();
    t.page.bootFailed("never seen");
    expect(boots).toEqual(["profile:core", "snapshot:mathlib network", "done done"]);
  });
});

describe("liveness", () => {
  it("projects the worker's counters: stalled while a stall is open; answer and frame clocks; events per counter step", () => {
    const t = setup();
    boot(t);
    const kinds: string[] = [];
    t.api.on("liveness", (l) => kinds.push(`${l.session} ${l.kind}`));
    const live = (c: Partial<NonNullable<RelayStatus["liveness"]>>) => status({ phase: "elaborating", liveness: { probes: 0, answered: 0, stalls: 0, resumed: 0, rescues: 0, ...c } });
    t.page.relayStatus(live({}));
    expect(t.api.status().liveness).toEqual({ stalled: false, lastAnswerAgoMs: null, lastFrameAgoMs: null, ...LIVENESS_TIMING });
    t.page.relayStatus(live({ probes: 1, answered: 1 }));
    t.relay.toClient({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { textDocument: { uri: URI, version: 1 }, processing: [] } }); // the Lean side (through the relay)
    t.clock.advance(1000);
    t.relay.toClient({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: "QED64: the Lean checker died (crash)" } }); // the relay's own: not proof of life
    t.taps.toClient({ jsonrpc: "2.0", id: 4, result: { sourcetext: "x" } }); // the page's own (the widget-source cache): not proof of life either
    t.clock.advance(4000);
    expect(t.api.status().liveness).toMatchObject({ stalled: false, lastAnswerAgoMs: 5000, lastFrameAgoMs: 5000 });
    t.page.relayStatus(live({ probes: 2, answered: 1, stalls: 1 }));
    expect(t.api.status().liveness?.stalled).toBe(true);
    t.page.relayStatus(live({ probes: 2, answered: 2, stalls: 1, resumed: 1, rescues: 1 }));
    expect(t.api.status().liveness?.stalled).toBe(false);
    expect(kinds).toEqual(["s1 answered", "s1 stall", "s1 answered", "s1 resumed", "s1 rescue"]);
  });
  it("tells the relay's own frames from the Lean side's", () => {
    expect(isSyntheticFrame({ id: 1, error: { code: -32900, message: "QED64: restarting" } })).toBe(true);
    expect(isSyntheticFrame({ method: "textDocument/publishDiagnostics", params: { diagnostics: [{ source: "QED64", message: "x", range: {} }] } })).toBe(true);
    expect(isSyntheticFrame({ method: "textDocument/publishDiagnostics", params: { diagnostics: [] } })).toBe(false);
    expect(isSyntheticFrame({ id: 1, error: { code: -32603, message: "unknown method" } })).toBe(false);
  });
});

describe("restart", () => {
  it("only while serving; no argument = the relay's reusable options, else this session's snapshots", () => {
    const t = setup();
    boot(t);
    expect(t.api.restart()).toEqual({ accepted: true, fromSession: "s1" });
    t.relay.remembered = { snapshots: ["init", "mathlib"], warmHeader: "import Mathlib.Data.Real.Basic\n", packs: ["essential"] };
    t.api.restart();
    t.api.restart({ snapshots: ["init", "widgets"] });
    expect(t.relay.restarts).toEqual([
      { snapshots: ["init", "mathlib"] },
      { snapshots: ["init", "mathlib"], warmHeader: "import Mathlib.Data.Real.Basic\n", packs: ["essential"] },
      { snapshots: ["init", "widgets"] },
    ]);
    expect(() => t.api.restart({ snapshots: ["init", "nope"] })).toThrow(/unknown snapshot/);
    t.relay.state = { kind: "rebooting" };
    expect(t.api.restart()).toEqual({ accepted: false, fromSession: "s1" });
  });
  it("initialBytes is normalized (256 MiB steps, clamped to [1, 6] GiB) and rides on the current inputs", () => {
    const t = setup();
    boot(t);
    t.api.restart({ initialBytes: 3.1 * GiB });
    t.api.restart({ initialBytes: 64 * GiB });
    expect(t.relay.restarts).toEqual([{ snapshots: ["init", "mathlib"], initialBytes: 3 * GiB }, { snapshots: ["init", "mathlib"], initialBytes: 6 * GiB }]);
    expect(() => t.api.restart({ initialBytes: -1 })).toThrow(/memory/);
  });
});

describe("cursor, focus, memory, offer", () => {
  it("getCursor/setCursor clamp to the document; focus does not move the cursor", () => {
    const t = setup();
    boot(t, "ab\ncdef\n");
    expect(t.api.setCursor({ lineNumber: 9, column: 9 })).toBe(true);
    expect(t.api.getCursor()).toEqual({ lineNumber: 3, column: 1 });
    expect(t.api.setCursor({ lineNumber: 2, column: 0 }, { focus: false })).toBe(true);
    expect(t.api.getCursor()).toEqual({ lineNumber: 2, column: 1 });
    const focused = t.editor.focused;
    expect(t.api.focus()).toBe(true);
    expect(t.editor.focused).toBe(focused + 1);
    expect(t.api.getCursor()).toEqual({ lineNumber: 2, column: 1 });
  });
  it("memory reports the session's commit and the meter's heap", () => {
    const t = setup();
    boot(t);
    expect(t.api.status().memory).toEqual({ initialBytes: 2 * GiB, currentBytes: null, maximumBytes: null });
    t.page.memory(3 * GiB, 6 * GiB);
    expect(t.api.status().memory).toEqual({ initialBytes: 2 * GiB, currentBytes: 3 * GiB, maximumBytes: 6 * GiB });
  });
  it("the exact-imports offer is reported and can be accepted once", () => {
    const t = setup();
    boot(t);
    const offers: unknown[] = [];
    t.api.on("offer", (o) => offers.push(o));
    const run = vi.fn(() => t.page.setOffer(null));
    t.page.setOffer({ kind: "exactImports", label: "Load exact imports" }, run);
    expect(t.api.status().offer).toEqual({ kind: "exactImports", label: "Load exact imports" });
    expect(t.api.acceptOffer("exactImports")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(t.api.acceptOffer()).toBe(false);
    expect(offers).toEqual([{ kind: "exactImports", label: "Load exact imports" }, null]);
  });
  it("?memory= is validated GiB, normalized like restart's initialBytes", () => {
    expect(parseMemoryParam("")).toBeNull();
    expect(parseMemoryParam("?memory=3")).toBe(3 * GiB);
    expect(parseMemoryParam("?memory=2.6")).toBe(2.5 * GiB);
    expect(parseMemoryParam("?memory=0.25")).toBe(1 * GiB);
    expect(parseMemoryParam("?memory=99")).toBe(6 * GiB);
    for (const bad of ["abc", "-1", "1e3", "3GiB", "0", "1.2345"]) expect(() => parseMemoryParam(`?memory=${bad}`), bad).toThrow(/refused \?memory=/);
  });
});
