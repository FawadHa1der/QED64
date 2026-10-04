// The page API (frontend/src/page-api.ts; docs/EMBEDDING.md §2–§3) over a fake
// relay and editor: the frozen object and its pre-boot behaviour, the boot
// document hand-off, setDocument / settled semantics (identical text resolves
// at once; halted, timeout and afterSession), the events derived from the
// relay's status and its taps, restart's inputs and guards, the cursor,
// liveness, memory and the offer.
import { describe, expect, it, vi } from "vitest";
import {
  codeFromHash, createPageApi, isSyntheticFrame, toApiStatus, FILE_PROGRESS_MS, LIVENESS_TIMING,
  type ApiStatus, type Capabilities, type EditorLike, type RelayLike,
} from "../../frontend/src/page-api";
import { normalizeMemoryBytes, parseMemoryParam } from "../../frontend/src/embed/params";
import type { RelayStatus, RestartOptions } from "../../frontend/src/lsp-relay";
import { tapRelay, type LspMessage } from "../../frontend/src/relay-taps";

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
  restart(opts: RestartOptions) { this.restarts.push(opts); }
  reusableOpts() { return this.remembered; }
  fromClient(msg: LspMessage) {
    const p = msg.params as { textDocument: { uri: string; version: number; text?: string }; contentChanges?: { text: string }[] };
    if (msg.method === "textDocument/didOpen") { this.doc = { uri: p.textDocument.uri, version: p.textDocument.version }; this.lastText = p.textDocument.text ?? ""; }
    if (msg.method === "textDocument/didChange" && this.doc) { this.doc.version = p.textDocument.version; this.lastText = p.contentChanges![0]!.text; }
  }
  toClient(msg: LspMessage) { this.posted.push(msg); }
}

/** A one-document editor whose edits go to the relay the way the LSP client's would. */
class FakeEditor implements EditorLike {
  text = "";
  version = 1;
  edits = 0;
  position = { lineNumber: 1, column: 1 };
  focused = 0;
  constructor(private readonly relay: FakeRelay) {}
  getModel() {
    const lines = () => this.text.split("\n");
    return {
      uri: { toString: () => URI }, getValue: () => this.text, getFullModelRange: () => "all", setValue: (t: string) => this.change(t),
      getLineCount: () => lines().length, getLineMaxColumn: (n: number) => (lines()[n - 1] ?? "").length + 1,
    };
  }
  executeEdits(_s: string, edits: Array<{ text: string }>) { this.edits += 1; this.change(edits[0]!.text); return true; }
  pushUndoStop() { return true; }
  getPosition() { return this.position; }
  setPosition(p: { lineNumber: number; column: number }) { this.position = p; }
  revealPositionInCenterIfOutsideViewport() {}
  focus() { this.focused += 1; }
  private change(t: string) {
    if (t === this.text) return;
    this.text = t;
    this.version += 1;
    this.relay.fromClient({ method: "textDocument/didChange", params: { textDocument: { uri: URI, version: this.version }, contentChanges: [{ text: t }] } });
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
  const editor = new FakeEditor(relay);
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
const flush = () => new Promise((r) => setTimeout(r, 0));

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
    const r = await t.api.setDocument("theorem t : 1 = 1 := rfl\n");
    expect(r).toEqual({ version: 2, unchanged: false });
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
    await expect(t.api.setDocument("BC\nD\n", { undoable: false, cursor: { lineNumber: 1, column: 99 } })).resolves.toEqual({ version: 2, unchanged: false });
    expect(t.editor.edits).toBe(0);
    expect(t.api.getCursor()).toEqual({ lineNumber: 1, column: 3 });
  });
  it("settled waits for ready at the requested version, through a reboot", async () => {
    const t = setup();
    boot(t);
    t.relay.current = status({ phase: "elaborating", version: 1 });
    let got: ApiStatus | null = null;
    void t.api.settled({ version: 2 }).then((s) => { got = s; });
    t.page.relayStatus(status({ phase: "ready", version: 1 })); // an older version settling is not it
    t.relay.session = { ...t.relay.session, id: "s2" };
    t.page.relayStatus(status({ phase: "booting", relay: "rebooting", rebootReason: "crash", session: "s2", version: null }));
    await flush();
    expect(got).toBeNull();
    t.page.relayStatus(status({ phase: "ready", version: 2, session: "s2" }));
    await flush();
    expect(got).toMatchObject({ phase: "ready", version: 2, session: "s2" });
  });
  it("settled({afterSession}) never resolves on that session", async () => {
    const t = setup();
    boot(t);
    let got: ApiStatus | null = null;
    void t.api.settled({ afterSession: "s1" }).then((s) => { got = s; });
    t.page.relayStatus(status({ phase: "ready", version: 1, session: "s1" }));
    await flush();
    expect(got).toBeNull();
    t.relay.session = { ...t.relay.session, id: "s2" };
    t.page.relayStatus(status({ phase: "ready", version: 1, session: "s2" }));
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
    t.page.relayStatus(status({ phase: "halted", relay: "halted", version: 1 }));
    await expect(halted).rejects.toMatchObject({ code: "HALTED" });
    const slow = t.api.settled({ version: 9, timeoutMs: 1000 });
    t.clock.advance(1000);
    await expect(slow).rejects.toMatchObject({ code: "TIMEOUT" });
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
    t.taps.toClient({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { textDocument: { uri: URI, version: 1 }, processing: [] } });
    t.taps.toClient({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: "QED64: the Lean checker died (crash)" } }); // synthetic: not proof of life
    t.clock.advance(5000);
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
