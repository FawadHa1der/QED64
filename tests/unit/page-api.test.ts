// The page API (frontend/src/page-api.ts; docs/EMBEDDING.md §2–§3) over a fake
// relay and editor: the frozen object and its pre-boot behaviour, the boot
// document hand-off, setDocument / settled semantics (identical text resolves
// at once; halted and timeout reject), the events derived from the relay's
// status and its two ports, and restart's guards.
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeFromHash, createPageApi, toApiStatus, type ApiStatus, type Capabilities, type EditorLike, type RelayLike } from "../../frontend/src/page-api";
import type { RelayStatus } from "../../frontend/src/lsp-relay";

const CAPS: Capabilities = { editorRpc: true, documents: true, events: true, restart: true, embedMode: true, snapshotRoots: false, postMessage: false };
const BUILD = { buildId: "wasm64-3ab1c6a9da03bc29", leanVersion: "4.34.0", sourceRevision: "x@abc", shell: null };
const URI = "file:///project/Probe.lean";

function status(over: Partial<RelayStatus> = {}): RelayStatus {
  return { phase: "ready", version: 1, header: null, ring: { bytesQueued: 0, refused: 0 }, pool: { unused: 1, running: 0 }, dropped: 0, collision: null, relay: "serving", rebootReason: null, session: "s1", lastDeath: null, ...over } as RelayStatus;
}

class FakeRelay implements RelayLike {
  readonly channel = new MessageChannel();
  readonly clientPort = this.channel.port2;
  state = { kind: "serving" };
  doc: { uri: string; version: number } | null = null;
  lastText = "";
  session = { id: "s1", snapshots: ["init", "mathlib"] as readonly string[] };
  current = status();
  restarts: unknown[] = [];
  status() { return this.current; }
  restart(opts: unknown) { this.restarts.push(opts); }
  fromClient(msg: { method?: string; params?: unknown }) {
    const p = msg.params as { textDocument: { uri: string; version: number; text?: string }; contentChanges?: { text: string }[] };
    if (msg.method === "textDocument/didOpen") { this.doc = { uri: p.textDocument.uri, version: p.textDocument.version }; this.lastText = p.textDocument.text ?? ""; }
    if (msg.method === "textDocument/didChange" && this.doc) { this.doc.version = p.textDocument.version; this.lastText = p.contentChanges![0]!.text; }
  }
  /** What the editor would receive from the relay. */
  toClient(msg: unknown) { this.channel.port1.postMessage(msg); }
}

/** A one-document editor whose edits go to the relay the way the LSP client's would. */
class FakeEditor implements EditorLike {
  text = "";
  version = 1;
  edits = 0;
  position: unknown = null;
  constructor(private readonly relay: FakeRelay) {}
  getModel() {
    return { uri: { toString: () => URI }, getValue: () => this.text, getFullModelRange: () => "all", setValue: (t: string) => this.change(t) };
  }
  executeEdits(_s: string, edits: Array<{ text: string }>) { this.edits += 1; this.change(edits[0]!.text); return true; }
  pushUndoStop() { return true; }
  setPosition(p: unknown) { this.position = p; }
  revealPositionInCenterIfOutsideViewport() {}
  focus() {}
  private change(t: string) {
    if (t === this.text) return;
    this.text = t;
    this.version += 1;
    this.relay.fromClient({ method: "textDocument/didChange", params: { textDocument: { uri: URI, version: this.version }, contentChanges: [{ text: t }] } });
  }
}

function setup(schedule?: (f: () => void) => void) {
  const page = createPageApi(CAPS, schedule ?? ((f) => f()));
  const relay = new FakeRelay();
  const editor = new FakeEditor(relay);
  return { page, relay, editor, api: page.api };
}
function boot(t: ReturnType<typeof setup>, text = "example : True := trivial\n") {
  t.page.takeBootDocument();
  t.page.bind({ relay: t.relay, editor: () => t.editor, build: BUILD, snapshotNames: ["init", "mathlib", "widgets"] });
  t.editor.text = text;
  t.relay.fromClient({ method: "textDocument/didOpen", params: { textDocument: { uri: URI, version: 1, text } } });
  t.page.editorReady();
  t.relay.clientPort.start();
}
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => vi.useRealTimers());

describe("the object", () => {
  it("is frozen, versioned and answers status() before anything is bound", () => {
    const { api } = setup();
    expect(Object.isFrozen(api) && Object.isFrozen(api.capabilities)).toBe(true);
    expect(api.version).toBe(1);
    expect(api.revision).toMatch(/^1\.\d+\.\d+$/);
    expect(api.capabilities).toEqual(CAPS);
    expect(api.build()).toBeNull();
    expect(api.getDocument()).toBeNull();
    expect(api.status()).toMatchObject({ phase: "booting", relay: "rebooting", session: null, version: null, lastDeath: null, snapshots: null });
    expect(api.restart()).toBe(false);
    expect(api.setCursor({ lineNumber: 1, column: 1 })).toBe(false);
  });

  it("the stable projection leaves the internal counters out", () => {
    const s = toApiStatus(status({ liveness: { probes: 1, answered: 1, stalls: 0, resumed: 0, rescues: 0 } }), { stage: "done", label: "", done: true, failed: false, message: null }, ["init"]);
    expect(Object.keys(s).sort()).toEqual(["boot", "collision", "header", "lastDeath", "phase", "rebootReason", "relay", "session", "snapshots", "version"]);
  });

  it("whenReady waits for both the relay and the mounted editor", async () => {
    const t = setup();
    let ready = false;
    void t.api.whenReady().then(() => { ready = true; });
    t.page.bind({ relay: t.relay, editor: () => t.editor, build: BUILD, snapshotNames: [] });
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
    t.page.bind({ relay: t.relay, editor: () => t.editor, build: BUILD, snapshotNames: [] });
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
  it("undoable: false uses setValue; the cursor is set when given", async () => {
    const t = setup();
    boot(t, "A\n");
    await expect(t.api.setDocument("B\n", { undoable: false, cursor: { lineNumber: 1, column: 2 } })).resolves.toEqual({ version: 2, unchanged: false });
    expect(t.editor.edits).toBe(0);
    expect(t.editor.position).toEqual({ lineNumber: 1, column: 2 });
  });
  it("settled waits for ready at the requested version, through a reboot", async () => {
    const t = setup();
    boot(t);
    t.relay.current = status({ phase: "elaborating", version: 1 });
    let got: ApiStatus | null = null;
    void t.api.settled({ version: 2 }).then((s) => { got = s; });
    t.page.relayStatus(status({ phase: "ready", version: 1 })); // an older version settling is not it
    t.page.relayStatus(status({ phase: "booting", relay: "rebooting", rebootReason: "crash", session: "s2", version: null }));
    await flush();
    expect(got).toBeNull();
    t.page.relayStatus(status({ phase: "ready", version: 2, session: "s2" }));
    await flush();
    expect(got).toMatchObject({ phase: "ready", version: 2, session: "s2" });
  });
  it("settled resolves at once when already settled; rejects HALTED and TIMEOUT", async () => {
    const t = setup();
    boot(t);
    await expect(t.api.settled()).resolves.toMatchObject({ phase: "ready", version: 1 });
    const halted = t.api.settled({ version: 9 });
    t.page.relayStatus(status({ phase: "halted", relay: "halted", version: 1 }));
    await expect(halted).rejects.toMatchObject({ code: "HALTED" });
    vi.useFakeTimers();
    const slow = t.api.settled({ version: 9, timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
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
    const death = { reason: "bootFailed", message: "snapshot 'mathlib' failed to load", cause: { kind: "network" as const, message: "HTTP 503" } };
    t.page.relayStatus(status({ phase: "booting", relay: "rebooting", rebootReason: "bootFailed", session: "s2", version: null, lastDeath: death }));
    t.page.relayStatus(status({ phase: "booting", relay: "rebooting", rebootReason: "bootFailed", session: "s2", version: null, lastDeath: death }));
    t.page.relayStatus(status({ phase: "headerRefused", session: "s2", version: 1, lastDeath: death }));
    t.page.relayStatus(status({ phase: "halted", relay: "halted", session: "s2", version: 1, lastDeath: { reason: "abort", message: "OOM" } }));
    expect(seen).toEqual([
      "ready s1@1",
      "reboot s1→s2 bootFailed",
      "death s1 bootFailed network reboot=true halted=false",
      "ready s2@1 refused",
      "death s2 abort - reboot=false halted=true",
    ]);
  });
  it("diagnostics name their origin; fileProgress coalesces to one per frame; a throwing listener harms no one", async () => {
    const frames: Array<() => void> = [];
    const t = setup((f) => frames.push(f));
    boot(t);
    const got: unknown[] = [];
    t.api.on("diagnostics", () => { throw new Error("embedder bug"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    t.api.on("diagnostics", (d) => got.push(["diag", d.origin, d.diagnostics.length]));
    t.api.on("fileProgress", (p) => got.push(["progress", p.processing.length]));
    t.relay.toClient({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [{ range: {}, message: "x", source: "Lean 4" }] } });
    t.relay.toClient({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [{ range: {}, message: "halted", source: "QED64" }] } });
    for (const n of [3, 2, 1]) t.relay.toClient({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { textDocument: { uri: URI, version: 1 }, processing: new Array(n).fill({ range: {} }) } });
    await flush(); await flush();
    expect(frames).toHaveLength(1);
    frames[0]!();
    expect(got).toEqual([["diag", "lean", 1], ["diag", "qed64", 1], ["progress", 1]]);
  });
  it("boot steps, the end of the boot and on/off", () => {
    const t = setup();
    const boots: string[] = [];
    const off = t.api.on("boot", (b) => boots.push(`${b.stage}${b.subject ? `:${b.subject}` : ""}${b.done ? " done" : ""}${b.failed ? " failed" : ""}`));
    t.page.bootStep("installing the Lean core library", { stage: "profile", subject: "core" });
    t.page.bootStep("loading", { stage: "snapshot", subject: "mathlib", step: "load" });
    expect(t.api.status().boot).toMatchObject({ stage: "snapshot", done: false });
    t.page.bootFinished();
    t.page.bootFinished();
    off();
    t.page.bootFailed("never seen");
    expect(boots).toEqual(["profile:core", "snapshot:mathlib", "done done"]);
  });
});

describe("restart", () => {
  it("only while serving; defaults to the current snapshots; refuses names the index lacks", () => {
    const t = setup();
    boot(t);
    expect(t.api.restart()).toBe(true);
    expect(t.api.restart({ snapshots: ["init", "widgets"] })).toBe(true);
    expect(t.relay.restarts).toEqual([{ snapshots: ["init", "mathlib"] }, { snapshots: ["init", "widgets"] }]);
    expect(() => t.api.restart({ snapshots: ["init", "nope"] })).toThrow(/unknown snapshot/);
    t.relay.state = { kind: "rebooting" };
    expect(t.api.restart()).toBe(false);
  });
});

