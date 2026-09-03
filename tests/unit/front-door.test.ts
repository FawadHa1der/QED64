// The resident LSP front door (public/workers/lsp-front-door.js) is the
// worker-side machine of docs/ARCHITECTURE-REEVALUATION-2-2026-09-02.md §2.4,
// exercised here as the pure reducer it is (§7 day 5 exit: queue-until-open,
// re-open rebasing, allowlist, coalesce newest) plus the bug-class rows that
// name it (§4 rows 6 and 8), and once through the REAL worker host in a vm
// sandbox (the ring-writer.test.ts pattern) for the `lsp` dispatch wiring.
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import "../../public/workers/lsp-front-door.js";

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
type Frame = { kind: "client"; msg: Msg; replay?: boolean } | { kind: "server"; msg: Msg } | { kind: "booted" } | { kind: "ring"; busy: boolean } | { kind: "died" };
interface Status { phase: string; version: number | null; header: { mode: string } | null; dropped: number }
interface Result { state: unknown; ringWrites: Msg[]; replies: Msg[]; startLoop: boolean; statusDelta: Status }
type Posted = { protocol?: number; type: string; kind?: string; msg?: Msg; requestId?: string; phase?: string; result?: { operation: string; open?: boolean }; error?: { code: string; recoverable: boolean } };
interface FrontDoor {
  initialState(): unknown;
  step(state: unknown, frame: Frame): Result;
  SERVER_CAPABILITIES: { textDocumentSync: { change: number } };
  FORWARDED_NOTIFICATIONS: Set<string>;
}
const FD = (globalThis as unknown as { Qed64LspFrontDoor: FrontDoor }).Qed64LspFrontDoor;

const URI = "file:///project/Probe.lean";
const initialize = (id = 1): Msg => ({ jsonrpc: "2.0", id, method: "initialize", params: { processId: null, capabilities: {} } });
const didOpen = (version: number, text: string, uri = URI): Msg => ({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "lean4", version, text } } });
const didChange = (version: number, text: string, uri = URI): Msg => ({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] } });
const request = (id: number, method: string, params: unknown = { textDocument: { uri: URI } }): Msg => ({ jsonrpc: "2.0", id, method, params });
const notification = (method: string, params: unknown = {}): Msg => ({ jsonrpc: "2.0", method, params });
const fileProgress = (version: number, processing: number): Msg => ({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { textDocument: { uri: URI, version }, processing: Array.from({ length: processing }, () => ({ range: {}, kind: 1 })) } });
const headerStatus = (version: number, mode: string): Msg => ({ jsonrpc: "2.0", method: "$/qed64/headerStatus", params: { version, mode, key: ["Init"], moduleCount: 1, missing: [], ms: 1 } });
const textOf = (m: Msg) => ((m.params as { contentChanges?: { text: string }[]; textDocument?: { text?: string } }).contentChanges?.[0]?.text ?? (m.params as { textDocument: { text?: string } }).textDocument.text);
const versionOf = (m: Msg) => (m.params as { textDocument: { version: number } }).textDocument.version;

/** A scripted run: feed frames in order, collect every effect. */
function run(frames: Frame[], from: unknown = FD.initialState()) {
  let state = from;
  const ring: Msg[] = [];
  const replies: Msg[] = [];
  const starts: number[] = [];
  let status: Status | null = null;
  frames.forEach((f, i) => {
    const r = FD.step(state, f);
    state = r.state;
    ring.push(...r.ringWrites);
    replies.push(...r.replies);
    if (r.startLoop) starts.push(i);
    status = r.statusDelta;
  });
  return { state, ring, replies, starts, status: status! };
}

describe("front door: initialize / shutdown", () => {
  it("answers initialize from the table with full-text sync (change = 1) and caches it; a replay is cached only", () => {
    const { replies, ring } = run([{ kind: "client", msg: initialize(7) }]);
    expect(ring).toEqual([]);
    expect(replies).toHaveLength(1);
    const result = replies[0]!.result as { capabilities: { textDocumentSync: { change: number } }; serverInfo: { name: string } };
    expect(replies[0]!.id).toBe(7);
    expect(result.capabilities.textDocumentSync.change).toBe(1);
    expect(FD.SERVER_CAPABILITIES.textDocumentSync.change).toBe(1);
    const replay = run([{ kind: "client", msg: initialize(8), replay: true }]);
    expect(replay.replies).toEqual([]);
  });
  it("answers shutdown null and drops exit", () => {
    const { replies, status } = run([{ kind: "client", msg: request(3, "shutdown", undefined) }, { kind: "client", msg: notification("exit") }]);
    expect(replies).toEqual([{ jsonrpc: "2.0", id: 3, result: null }]);
    expect(status.dropped).toBe(1);
  });
});

describe("front door: queue until open (§6 amendment 20; §4 row 6)", () => {
  it("queues everything from script load; the first didOpen after boot starts the loop with initialize + didOpen", () => {
    const { ring, starts, status } = run([
      { kind: "client", msg: initialize() },
      { kind: "client", msg: didOpen(1, "A") },
      { kind: "client", msg: request(2, "textDocument/semanticTokens/full") },
    ]);
    expect(ring).toEqual([]); // still booting
    expect(starts).toEqual([]);
    expect(status.phase).toBe("booting");
    const after = run([{ kind: "booted" }], run([
      { kind: "client", msg: initialize() },
      { kind: "client", msg: didOpen(1, "A") },
      { kind: "client", msg: request(2, "textDocument/semanticTokens/full") },
    ]).state);
    expect(after.starts).toEqual([0]);
    expect(after.ring.map((m) => m.method)).toEqual(["initialize", "textDocument/didOpen", "textDocument/semanticTokens/full"]);
    expect(after.ring[0]!.id).toBe(1); // the client's initialize id, its params
    expect(after.status.phase).toBe("starting");
  });
  it("queued v2, v3 + open at v1 → the ring sees didOpen(v1) then didChange(v3) only (newest wins)", () => {
    const { ring } = run([
      { kind: "client", msg: didOpen(1, "A") },
      { kind: "client", msg: didChange(2, "AB") },
      { kind: "client", msg: didChange(3, "ABC") },
      { kind: "booted" },
    ]);
    expect(ring.map((m) => m.method)).toEqual(["initialize", "textDocument/didOpen", "textDocument/didChange"]);
    expect(versionOf(ring[1]!)).toBe(1);
    expect(versionOf(ring[2]!)).toBe(3);
    expect(textOf(ring[2]!)).toBe("ABC");
  });
  it("a didChange queued before a booting worker's open at a later version is dropped (already in the open text)", () => {
    // The relay's replay after a crash: queued client edits, then initialize
    // (replay) + didOpen carrying the latest text at the latest version.
    const { ring, status } = run([
      { kind: "client", msg: didChange(5, "E") },
      { kind: "client", msg: didChange(6, "EF") },
      { kind: "client", msg: initialize(1), replay: true },
      { kind: "client", msg: didOpen(6, "EF") },
      { kind: "booted" },
    ]);
    expect(ring.map((m) => m.method)).toEqual(["initialize", "textDocument/didOpen"]);
    expect(versionOf(ring[1]!)).toBe(6);
    expect(status.version).toBe(6);
  });
  it("a request queued before the didOpen lands after the opening sequence (nothing between initialize and didOpen)", () => {
    const { ring } = run([
      { kind: "booted" },
      { kind: "client", msg: request(9, "$/lean/rpc/connect") },
      { kind: "client", msg: didOpen(1, "A") },
    ]);
    expect(ring.map((m) => m.method)).toEqual(["initialize", "textDocument/didOpen", "$/lean/rpc/connect"]);
  });
  it("a didOpen queued behind an older document's frames supersedes them (a level switch during boot)", () => {
    const { ring } = run([
      { kind: "client", msg: didOpen(1, "A", "file:///a.lean") },
      { kind: "client", msg: didChange(3, "AAA", "file:///a.lean") },
      { kind: "client", msg: didOpen(1, "B", "file:///b.lean") },
      { kind: "booted" },
    ]);
    expect(ring.map((m) => m.method)).toEqual(["initialize", "textDocument/didOpen"]);
    expect(textOf(ring[1]!)).toBe("B");
  });
});

describe("front door: re-open rebasing (§6 second pass 1)", () => {
  const opened = run([{ kind: "booted" }, { kind: "client", msg: initialize() }, { kind: "client", msg: didOpen(1, "A") }, { kind: "client", msg: didChange(2, "AB") }, { kind: "client", msg: didChange(3, "ABC") }]);
  it("a didOpen on a live loop becomes a full-text didChange continuing the worker's version sequence", () => {
    const r = run([{ kind: "client", msg: didOpen(1, "NEXT", "file:///level2.lean") }], opened.state);
    expect(r.starts).toEqual([]);
    expect(r.ring).toHaveLength(1);
    expect(r.ring[0]!.method).toBe("textDocument/didChange");
    expect(versionOf(r.ring[0]!)).toBe(4); // lastVersion 3 + 1
    expect(textOf(r.ring[0]!)).toBe("NEXT");
    expect((r.ring[0]!.params as { textDocument: { uri: string } }).textDocument.uri).toBe("file:///level2.lean");
    expect(r.status.version).toBe(1); // client space
  });
  it("later client versions are shifted outbound and worker versions shifted back inbound, on every versioned field", () => {
    const r = run([
      { kind: "client", msg: didOpen(1, "NEXT") },
      { kind: "client", msg: didChange(2, "NEXT!") },
      { kind: "client", msg: request(5, "textDocument/waitForDiagnostics", { uri: URI, version: 2 }) },
      { kind: "server", msg: fileProgress(5, 1) },
      { kind: "server", msg: { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 5, diagnostics: [] } } },
      { kind: "server", msg: { jsonrpc: "2.0", method: "$/lean/ileanInfoFinal", params: { version: 5, references: {} } } },
      { kind: "server", msg: headerStatus(4, "covered") },
      { kind: "server", msg: fileProgress(5, 0) },
    ], opened.state);
    expect(versionOf(r.ring[1]!)).toBe(5);
    expect((r.ring[2]!.params as { version: number }).version).toBe(5);
    expect(versionOf(r.replies[0]!)).toBe(2);
    expect((r.replies[1]!.params as { version: number }).version).toBe(2);
    expect((r.replies[2]!.params as { version: number }).version).toBe(2);
    expect((r.replies[3]!.params as { version: number }).version).toBe(1);
    expect(r.status.phase).toBe("ready");
    expect(r.status.version).toBe(2);
  });
  it("without a re-open nothing is shifted", () => {
    const r = run([{ kind: "server", msg: fileProgress(3, 0) }], opened.state);
    expect(versionOf(r.replies[0]!)).toBe(3);
    expect(r.status.phase).toBe("ready");
  });
  it("a re-open at the SAME client version after a drain is not ready until the NEW version drains (no false ready on a level switch)", () => {
    // Level 1 opened at v1 and fully elaborated; level 2 re-opens at v1.
    const drained = run([{ kind: "booted" }, { kind: "client", msg: didOpen(1, "L1") }, { kind: "server", msg: fileProgress(1, 0) }]);
    expect(drained.status.phase).toBe("ready");
    const reopened = run([{ kind: "client", msg: didOpen(1, "L2", "file:///level2.lean") }], drained.state);
    expect(reopened.ring.map((m) => m.method)).toEqual(["textDocument/didChange"]);
    expect(versionOf(reopened.ring[0]!)).toBe(2); // worker space: lastVersion 1 + 1
    expect(reopened.status.phase).toBe("elaborating");
    expect(reopened.status.version).toBe(1);
    // A late drain for the OLD document (worker v1) must not read as ready either.
    expect(run([{ kind: "server", msg: fileProgress(1, 0) }], reopened.state).status.phase).toBe("elaborating");
    // Only the new version's drain (worker v2 = client v1) is ready.
    const ready = run([{ kind: "server", msg: fileProgress(2, 0) }], reopened.state);
    expect(ready.status.phase).toBe("ready");
    expect(versionOf(ready.replies[0]!)).toBe(1);
    // The same with edits in between: level 1 drained at v3, level 2 opened at v1 and edited to v3.
    const l1 = run([{ kind: "booted" }, { kind: "client", msg: didOpen(1, "A") }, { kind: "client", msg: didChange(3, "ABC") }, { kind: "server", msg: fileProgress(3, 0) }]);
    expect(l1.status.phase).toBe("ready");
    const l2 = run([{ kind: "client", msg: didOpen(1, "B", "file:///level2.lean") }, { kind: "client", msg: didChange(3, "BCD", "file:///level2.lean") }], l1.state);
    expect(l2.status.phase).toBe("elaborating");
    expect(versionOf(l2.ring[1]!)).toBe(6); // base 3: client v3 → worker v6
    expect(run([{ kind: "server", msg: fileProgress(6, 0) }], l2.state).status.phase).toBe("ready");
  });
});

describe("front door: allowlist (§5 Watchdog Parity; K-iv)", () => {
  const opened = run([{ kind: "booted" }, { kind: "client", msg: didOpen(1, "A") }]);
  it("forwards exactly the five notifications FileWorker.handleNotification dispatches plus every request", () => {
    expect([...FD.FORWARDED_NOTIFICATIONS].sort()).toEqual(["$/cancelRequest", "$/lean/rpc/keepAlive", "$/lean/rpc/release", "$/lean/staleDependency", "textDocument/didChange"].sort());
    const r = run([
      { kind: "client", msg: notification("initialized") },
      { kind: "client", msg: notification("$/setTrace", { value: "off" }) },
      { kind: "client", msg: notification("workspace/didChangeConfiguration", { settings: {} }) },
      { kind: "client", msg: notification("textDocument/didClose", { textDocument: { uri: URI } }) },
      { kind: "client", msg: notification("textDocument/didSave", { textDocument: { uri: URI } }) },
      { kind: "client", msg: notification("$/lean/rpc/keepAlive", { uri: URI, sessionId: "1" }) },
      { kind: "client", msg: notification("$/cancelRequest", { id: 4 }) },
      { kind: "client", msg: request(4, "textDocument/hover") },
      { kind: "client", msg: { jsonrpc: "2.0", id: 77, result: { applied: true } } }, // a client response to a server request
    ], opened.state);
    expect(r.ring.map((m) => m.method ?? "response")).toEqual(["$/lean/rpc/keepAlive", "$/cancelRequest", "textDocument/hover", "response"]);
    expect(r.status.dropped).toBe(5);
  });
});

describe("front door: ring backpressure (§2.4 coalesce newest)", () => {
  const opened = run([{ kind: "booted" }, { kind: "client", msg: didOpen(1, "A") }]);
  it("while the ring is parked a didChange replaces the held didChange at its arrival position; the drain flushes in order", () => {
    const r = run([
      { kind: "ring", busy: true },
      { kind: "client", msg: didChange(2, "AB") },
      { kind: "client", msg: request(6, "textDocument/hover") },
      { kind: "client", msg: didChange(3, "ABC") },
      { kind: "ring", busy: false },
      { kind: "client", msg: didChange(4, "ABCD") },
    ], opened.state);
    expect(r.ring.map((m) => `${m.method}${m.method === "textDocument/didChange" ? versionOf(m) : ""}`)).toEqual(["textDocument/hover", "textDocument/didChange3", "textDocument/didChange4"]);
    expect(r.status.version).toBe(4);
  });
});

describe("front door: status (§2.2(e); §4 row 8)", () => {
  it("refused header, body edit, covered header + drain → ready; refusal persists across body-only versions", () => {
    const opened = run([{ kind: "booted" }, { kind: "client", msg: didOpen(5, "import Bogus\nx") }]);
    const refused = run([{ kind: "server", msg: headerStatus(5, "refused") }, { kind: "server", msg: fileProgress(5, 0) }], opened.state);
    expect(refused.status.phase).toBe("headerRefused");
    expect(refused.status.header!.mode).toBe("refused");
    // Body-only edit: a ring write goes out; no new headerStatus arrives (Lean's `unchanged` path).
    const edited = run([{ kind: "client", msg: didChange(6, "import Bogus\nxy") }], refused.state);
    expect(edited.ring).toHaveLength(1);
    expect(edited.status.phase).toBe("elaborating");
    const drained = run([{ kind: "server", msg: fileProgress(6, 0) }], edited.state);
    expect(drained.status.phase).toBe("headerRefused");
    // Header fixed: covered verdict at v7, then the drain → ready.
    const fixed = run([{ kind: "client", msg: didChange(7, "import Init\nxy") }, { kind: "server", msg: headerStatus(7, "covered") }, { kind: "server", msg: fileProgress(7, 2) }], drained.state);
    expect(fixed.status.phase).toBe("elaborating");
    const ready = run([{ kind: "server", msg: fileProgress(7, 0) }], fixed.state);
    expect(ready.status.phase).toBe("ready");
    expect(ready.status.header!.mode).toBe("covered");
  });
  it("a drain for an older version is not ready; death is terminal", () => {
    const opened = run([{ kind: "booted" }, { kind: "client", msg: didOpen(1, "A") }, { kind: "client", msg: didChange(2, "AB") }]);
    expect(run([{ kind: "server", msg: fileProgress(1, 0) }], opened.state).status.phase).toBe("elaborating");
    const dead = run([{ kind: "died" }, { kind: "client", msg: didChange(3, "ABC") }], opened.state);
    expect(dead.status.phase).toBe("dead");
    expect(dead.ring).toEqual([]);
    expect(dead.status.dropped).toBe(1);
  });
  it("the reducer does not mutate its input state", () => {
    const s0 = FD.initialState();
    const snapshot = JSON.stringify(s0);
    run([{ kind: "client", msg: didOpen(1, "A") }, { kind: "booted" }, { kind: "client", msg: didChange(2, "AB") }], s0);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});

describe("front door: worker host wiring (lean.worker.js)", () => {
  let posted: Posted[];
  let deliver: (data: unknown) => void;
  let imported: string[];
  interface Hooks {
    frontDoor: {
      state(): { phase: string; queue: unknown[] } | null;
      status(): { phase: string };
      armed(): boolean;
      open(): boolean;
      host(h: { state?: string; M?: unknown; memory?: unknown }): void;
    };
    resident: { RESIDENT_RING_CAP: number };
  }
  let hooks: Hooks;
  beforeAll(() => {
    posted = [];
    imported = [];
    const workers = path.resolve(__dirname, "../../public/workers");
    const listeners: Record<string, (e: { data: unknown }) => void> = {};
    const sandbox: Record<string, unknown> = {
      crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
      setTimeout, clearTimeout, clearInterval,
      // The heartbeat the open loop starts must not pin the test process.
      setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref(); return t; },
      fetch: () => Promise.reject(new Error("no network in unit tests")),
    };
    sandbox.self = sandbox;
    sandbox.postMessage = (m: unknown) => posted.push(m as Posted);
    sandbox.addEventListener = (type: string, fn: (e: { data: unknown }) => void) => { listeners[type] = fn; };
    sandbox.crossOriginIsolated = true;
    // A real `importScripts` (synchronous, like the browser's): the worker's own
    // loads — the unconditional decoder and the LAZY front door — run here, and
    // the spy records exactly what it asked for and when.
    sandbox.importScripts = (name: string) => {
      imported.push(name);
      vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
    };
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
    hooks = (sandbox as { __qed64TestExports?: Hooks }).__qed64TestExports!;
    deliver = (data) => listeners.message!({ data });
  });
  it("imports only lsp-frames.js at script load; the front door loads lazily on the first `lsp` (a pump-only consumer never loads it)", () => {
    // lean4game vendors lean.worker.js + snapshot-prefetch.worker.js + lsp-frames.js
    // as a fixed closure and only ever speaks the pump requests: an unconditional
    // import of lsp-front-door.js would throw before {type:"boot"} and hang every game session.
    expect(imported).toEqual(["lsp-frames.js"]);
    expect(posted.filter((m) => m.type === "boot")).toHaveLength(1);
    // Every request the pump path sends is dispatched without the front door.
    deliver({ protocol: 1, requestId: "c1", type: "capabilities" });
    expect(posted.find((m) => m.requestId === "c1")).toMatchObject({ type: "result" });
    expect(imported).toEqual(["lsp-frames.js"]);
  });
  it("dispatches `lsp` without a requestId while a snapshot loads: answers initialize as an `lsp` event, queues the rest, reports status once per change, and does NOT open the loop", () => {
    posted.length = 0;
    // lean4monaco's initialize/didOpen land while the page's loadSnapshot('init')
    // owns the runtime (`state === "compiling"`) — the ordering that broke the boot.
    hooks.frontDoor.host({ state: "compiling" });
    deliver({ protocol: 1, type: "lsp", msg: initialize(11) });
    expect(imported).toEqual(["lsp-frames.js", "lsp-front-door.js"]);
    deliver({ protocol: 1, type: "lsp", msg: didOpen(1, "A") });
    deliver({ protocol: 1, type: "lsp", msg: didOpen(1, "A") }); // no status change → no second status event
    const lsp = posted.filter((m) => m.type === "event" && m.kind === "lsp");
    expect(lsp).toHaveLength(1);
    expect(lsp[0]!.msg!.id).toBe(11);
    expect(posted.filter((m) => m.type === "error")).toEqual([]);
    expect(posted.filter((m) => m.type === "event" && m.kind === "died")).toEqual([]);
    const status = posted.filter((m) => m.type === "event" && m.kind === "status");
    expect(status).toHaveLength(1);
    expect(status[0]!.phase).toBe("booting");
    expect(hooks.frontDoor.state()!.phase).toBe("booting");
    expect(hooks.frontDoor.state()!.queue).toHaveLength(1); // the didOpen waits for the ARM, not for the wasm boot
    expect(hooks.frontDoor.open()).toBe(false);
  });
  it("`lsp-arm` is refused BAD_STATE while the runtime is owned; once ready it opens the loop exactly once with initialize + didOpen, after which loadSnapshot is BAD_STATE (K-i)", () => {
    posted.length = 0;
    deliver({ protocol: 1, requestId: "a1", type: "lsp-arm" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "error", requestId: "a1", error: { code: "BAD_STATE", recoverable: true } });
    expect(hooks.frontDoor.armed()).toBe(false);
    expect(hooks.frontDoor.state()!.phase).toBe("booting");
    expect(hooks.frontDoor.open()).toBe(false);
    // The page's snapshot loads finish: the host is ready and holds the runtime
    // (a fake with the four resident-transport exports and a fake shared heap).
    const CAP = hooks.resident.RESIDENT_RING_CAP;
    const memory = { buffer: new SharedArrayBuffer(16 + CAP) };
    const calls: string[] = [];
    hooks.frontDoor.host({
      state: "ready",
      memory,
      M: {
        _malloc: () => 0n,
        _lean_browser64_configure_input_ring: () => { calls.push("ring"); return 0; },
        _lean_wasm_shell_mark_preinitialized: () => { calls.push("preinit"); },
        callMain: (argv: string[]) => { calls.push(`main ${argv.join(" ")}`); },
      },
    });
    posted.length = 0;
    deliver({ protocol: 1, requestId: "a2", type: "lsp-arm" });
    expect(posted.find((m) => m.requestId === "a2")).toMatchObject({ type: "result", result: { operation: "lsp-arm", open: true } });
    expect(calls).toEqual(["preinit", "ring", "main --worker -Dserver.reportDelayMs=0"]);
    expect(hooks.frontDoor.armed()).toBe(true);
    expect(hooks.frontDoor.open()).toBe(true);
    expect(hooks.frontDoor.state()!.phase).toBe("open");
    expect(hooks.frontDoor.state()!.queue).toHaveLength(0);
    expect(posted.filter((m) => m.type === "event" && m.kind === "died")).toEqual([]);
    // The opening sequence is in the ring, in order, with nothing between.
    const written = Atomics.load(new Int32Array(memory.buffer, 0, 4), 1);
    const frames = new TextDecoder().decode(new Uint8Array(memory.buffer, 16, written))
      .split("Content-Length: ").filter(Boolean)
      .map((f) => JSON.parse(f.slice(f.indexOf("\r\n\r\n") + 4)) as Msg);
    expect(frames.map((f) => f.method)).toEqual(["initialize", "textDocument/didOpen"]);
    expect(frames[0]!.id).toBe(11);
    expect(textOf(frames[1]!)).toBe("A");
    const status = posted.filter((m) => m.type === "event" && m.kind === "status");
    expect(status.at(-1)!.phase).toBe("starting");
    // K-i: a snapshot published under a live loop would change a verdict Lean already reused.
    posted.length = 0;
    deliver({ protocol: 1, requestId: "s1", type: "loadSnapshot", input: { url: "/snapshots/x.raw" } });
    expect(posted[0]).toMatchObject({ type: "error", requestId: "s1", error: { code: "BAD_STATE" } });
    // A repeated arm is idempotent: no second opening sequence.
    deliver({ protocol: 1, requestId: "a3", type: "lsp-arm" });
    expect(posted.find((m) => m.requestId === "a3")).toMatchObject({ type: "result", result: { operation: "lsp-arm", open: true } });
    expect(calls).toHaveLength(3);
    expect(Atomics.load(new Int32Array(memory.buffer, 0, 4), 1)).toBe(written);
  });
});
