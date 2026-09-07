// The L3 relay (frontend/src/lsp-relay.ts) against a FakeSession — the
// invariants docs/ARCHITECTURE-REEVALUATION-2-2026-09-02.md §2.3 names:
// `hash(fake.lastFullText) === hash(lastText)` after every scenario, zero
// client-facing messages synthesized except responses to failed in-flight
// ids and the breaker's one halted note (PUMP-REMOVAL-ASSESSMENT gap 5),
// `setTimeout` never called by the relay module, and a death carrying a
// stale session changing nothing. The 1.5 s settle is injected (§8 item 9).
// The pump-retirement contract (docs/RESIDENT-WORKER-PLAN.md "relay contract")
// is pinned at the end: lastDeath, the halted note, restartOpts across a
// crash, and a synchronous unload.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LspRelay, isImport, type RelaySession, type RelayStatus, type RestartOptions } from "../../frontend/src/lsp-relay";
import type { JsonRpcMessage as Msg, WorkerStatus } from "../../src/runtime/client";

class FakeSession implements RelaySession {
  static seq = 0;
  static all: FakeSession[] = [];
  readonly id = `fake${(FakeSession.seq += 1)}`;
  readonly sent: Array<{ msg: Msg; replay: boolean }> = [];
  lastFullText: string | null = null;
  disposed = false;
  terminated = false;
  started = false;
  armed = false;
  /** `sent.length` when arm() was called: proves the BootOk replay preceded the arm (§2.3 → §2.4 Ready → Open). */
  armedAfter = -1;
  armFails = false;
  bootOk!: () => void;
  bootFailed!: (e: Error) => void;
  private readonly booted = new Promise<void>((resolve, reject) => { this.bootOk = resolve; this.bootFailed = reject; });
  onLsp: (msg: Msg) => void = () => {};
  onStatus: (s: WorkerStatus) => void = () => {};
  onDied: (code: number | null, reason: string, message: string) => void = () => {};
  constructor(readonly opts?: RestartOptions) { FakeSession.all.push(this); }
  start() { this.started = true; return this.booted; }
  arm() {
    this.armedAfter = this.sent.length;
    if (this.armFails) return Promise.reject(new Error("Worker is 'compiling', not ready"));
    this.armed = true;
    return Promise.resolve();
  }
  lsp(msg: Msg, replay = false) {
    if (this.disposed) return;
    this.sent.push({ msg, replay });
    // The worker's document: the last full text it was handed (change = 1).
    const p = msg.params as { textDocument?: { text?: string }; contentChanges?: { text?: string }[] } | undefined;
    if (msg.method === "textDocument/didOpen") this.lastFullText = p?.textDocument?.text ?? null;
    else if (msg.method === "textDocument/didChange") this.lastFullText = p?.contentChanges?.[0]?.text ?? this.lastFullText;
    // The front door answers initialize at once from its table (a replay is cached only — §2.4).
    else if (msg.method === "initialize" && !replay) this.onLsp({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  }
  dispose() {
    this.disposed = true;
    this.onLsp = () => {};
    this.onStatus = () => {};
    this.onDied = () => {};
    // Like LeanSession.dispose(): an in-flight boot is rejected (DISPOSED).
    if (this.started) this.bootFailed(new Error("Session disposed."));
  }
  /** The synchronous kill the relay's unload() must reach (the pump's disposeHard). */
  terminate() { this.terminated = true; }
  methods() { return this.sent.map((s) => `${s.msg.method}${s.replay ? "(replay)" : ""}`); }
}

const hash = (t: string | null) => createHash("sha256").update(t === null ? "<no document>" : t).digest("hex");
const URI = "file:///project/Probe.lean";
const initialize: Msg = { jsonrpc: "2.0", id: 0, method: "initialize", params: { capabilities: {} } };
const didOpen = (version: number, text: string): Msg => ({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: URI, languageId: "lean4", version, text } } });
const didChange = (version: number, text: string): Msg => ({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: URI, version }, contentChanges: [{ text }] } });
const request = (id: number, method: string): Msg => ({ jsonrpc: "2.0", id, method, params: { textDocument: { uri: URI } } });
/** Let MessagePort deliveries land (a macrotask hop; the relay itself owns no timer — checked statically below). */
const settle = () => new Promise<void>((r) => setImmediate(r));

let relay: LspRelay;
let statuses: RelayStatus[];
let toClient: Msg[];
const errorsToClient = () => toClient.filter((m) => m.error !== undefined);
let clock: number;
let settles: number;
const current = () => FakeSession.all[FakeSession.all.length - 1]!;

beforeEach(() => {
  FakeSession.all.length = 0;
  statuses = [];
  toClient = [];
  clock = 1_000_000;
  settles = 0;
  relay = new LspRelay(
    (opts) => new FakeSession(opts),
    { status: (s) => statuses.push(s) },
    () => { settles += 1; return Promise.resolve(); },
    () => clock,
  );
  relay.clientPort.onmessage = (e) => toClient.push(e.data as Msg);
});
afterEach(async () => {
  await settle();
  // Every scenario ends with the worker holding exactly the text the relay remembers.
  expect(hash(current().lastFullText)).toBe(hash(relay.doc ? relay.lastText : null));
  relay.clientPort.close();
  relay.unload();
});

/** BootOk for the session in flight (its `start()` runs one microtask after the injected settle). */
async function bootCurrent() {
  await settle();
  const s = current();
  expect(s.started).toBe(true);
  s.bootOk();
  await settle();
}

describe("relay: line and timer budget (§8 item 9)", () => {
  const source = readFileSync(path.resolve(__dirname, "../../frontend/src/lsp-relay.ts"), "utf8");
  it("owns no timer of any kind — the settle is injected", () => {
    expect(/setTimeout|setInterval|requestIdleCallback|requestAnimationFrame|performance\.now/.test(source)).toBe(false);
  });
  it("parses no text beyond splitting it into lines: no regex literal, no match/test/exec, no other split", () => {
    // The one text operation the pump's retirement added (gaps 2/5, restart options across a crash): the
    // import lines, found with startsWith over `text.split("\n")` — never a regex, and exactly ONE such split
    // (linesOf), so a second unrelated line split cannot slip in under the whitelist.
    expect(source.split('.split("\\n")').length - 1).toBe(1);
    const withoutLineSplit = source.replaceAll('.split("\\n")', "");
    expect(/\.split\(|\.match\(|\.test\(|\.exec\(|new RegExp/.test(withoutLineSplit)).toBe(false);
  });
  it("finds import lines exactly as the front door's and main.ts's IMPORT_LINE regex does (tabs, modifiers, order)", () => {
    // The regex both public/workers/lsp-front-door.js and frontend/src/main.ts spell; the relay must agree line for
    // line, or the halted note and the warm-compiled header it remembers a restart for would drift from them.
    const IMPORT_LINE = /^\s*(?:public\s+|private\s+)?(?:meta\s+)?import\s+/;
    const lines = [
      "import Mathlib.Tactic", "  import Foo", "\timport\tFoo", "import  Foo", "public import X", "private import X",
      "public\timport X", "meta import X", "public meta import X", "private\tmeta\timport X", " import Foo",
      "import", "import\n", "importFoo", "meta public import X", "public private import X", "public  private import X",
      "publicimport X", "metaimport X", "-- import Foo", "/- import -/", "theorem import_ok : True := trivial", "", "   ",
      "open Nat in import X", "public", "private meta", "Import Foo", "IMPORT Foo",
    ];
    for (const line of lines) expect(isImport(line), JSON.stringify(line)).toBe(IMPORT_LINE.test(line));
  });
  it("stays within the line budget (hard cap 220 including comments; ~150 before the pump-retirement contract)", () => {
    expect(source.split("\n").length).toBeLessThanOrEqual(220);
  });
});

describe("relay: serving", () => {
  it("creates a session synchronously, forwards client traffic while it boots, and serves after BootOk", async () => {
    expect(FakeSession.all).toHaveLength(1);
    expect(relay.state.kind).toBe("rebooting");
    relay.fromClient(initialize);
    relay.fromClient(didOpen(1, "A"));
    await bootCurrent();
    expect(relay.state.kind).toBe("serving");
    // BootOk replays what the relay recorded (§2.3 BootOk): initialize(replay) + didOpen(lastText),
    // and only THEN arms the worker, so the replay is in its queue when the loop opens once (§2.4).
    expect(current().methods()).toEqual(["initialize", "textDocument/didOpen", "initialize(replay)", "textDocument/didOpen"]);
    expect(current().armed).toBe(true);
    expect(current().armedAfter).toBe(4);
    relay.fromClient(didChange(2, "AB"));
    expect(current().lastFullText).toBe("AB");
    // A ranged didChange (a client ignoring change = 1) cannot update lastText; it is forwarded and counted.
    relay.fromClient({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: URI, version: 3 }, contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "X" }] } });
    expect(relay.lastText).toBe("AB");
    expect(relay.stats.rangedChanges).toBe(1);
    relay.fromClient(didChange(4, "XAB"));
    // Server frames go straight to the client; responses clear the pending id.
    relay.fromClient(request(5, "textDocument/hover"));
    expect(relay.pending.get(5)).toBe("textDocument/hover");
    current().onLsp({ jsonrpc: "2.0", id: 5, result: null });
    await settle();
    expect(relay.pending.size).toBe(0);
    expect(toClient).toEqual([{ jsonrpc: "2.0", id: 0, result: { capabilities: {} } }, { jsonrpc: "2.0", id: 5, result: null }]);
  });
  it("edit-during-boot: DidOpen v1, DidChange v2, v3, BootOk → the open carries v3's text", async () => {
    relay.fromClient(initialize);
    relay.fromClient(didOpen(1, "A"));
    relay.fromClient(didChange(2, "AB"));
    relay.fromClient(didChange(3, "ABC"));
    await bootCurrent();
    const replayed = current().sent.filter((s) => s.replay || s.msg.method === "textDocument/didOpen").slice(-2);
    expect(replayed[0]!.msg.method).toBe("initialize");
    expect((replayed[1]!.msg.params as { textDocument: { version: number; text: string } }).textDocument).toMatchObject({ version: 3, text: "ABC" });
    expect(toClient.map((m) => m.id)).toEqual([0]); // only the worker's initialize answer; nothing synthesized
  });
  it("reads status only from the current session and exposes it with the relay state on top", async () => {
    await bootCurrent();
    const st: WorkerStatus = { phase: "ready", version: 1, header: null, ring: { bytesQueued: 0, refused: 0 }, pool: { unused: 3, running: 2 }, dropped: 0 };
    current().onStatus(st);
    expect(relay.status()).toMatchObject({ phase: "ready", relay: "serving", session: current().id, pool: { running: 2 } });
    expect(statuses.at(-1)).toMatchObject({ phase: "ready" });
  });
  it("passes the worker's collision fact through untouched — the page's exact-imports offer keys on it (§3 row 8)", async () => {
    await bootCurrent();
    const collision = { names: ["Nat.add_comm"], version: 1 };
    const base: WorkerStatus = { phase: "ready", version: 1, header: null, ring: { bytesQueued: 0, refused: 0 }, pool: { unused: 3, running: 2 }, dropped: 0 };
    current().onStatus({ ...base, collision });
    expect(relay.status().collision).toEqual(collision);
    expect(statuses.at(-1)?.collision).toEqual(collision);
    current().onStatus({ ...base, collision: null });
    expect(relay.status().collision).toBeNull();
  });
});

describe("relay: deaths (§2.3 SessionDied; §3 rows 9-11)", () => {
  it("a crash fails in-flight requests within the turn (-32900 for rpc, -32603 otherwise), settles, reboots, replays", async () => {
    relay.fromClient(initialize);
    relay.fromClient(didOpen(1, "A"));
    await bootCurrent();
    relay.fromClient(didChange(2, "AB"));
    relay.fromClient(request(7, "$/lean/rpc/call"));
    relay.fromClient(request(8, "textDocument/completion"));
    const dead = current();
    dead.onDied(null, "abort", "Lean runtime aborted");
    await settle();
    expect(errorsToClient()).toEqual([
      { jsonrpc: "2.0", id: 7, error: { code: -32900, message: expect.stringContaining("died") } },
      { jsonrpc: "2.0", id: 8, error: { code: -32603, message: expect.stringContaining("died") } },
    ]);
    expect(dead.disposed).toBe(true);
    expect(relay.state).toEqual({ kind: "rebooting", reason: "crash" });
    expect(relay.stats).toMatchObject({ workerDeaths: 1, reboots: 1, failedInFlight: 2, staleDeaths: 0 });
    expect(FakeSession.all).toHaveLength(2);
    expect(settles).toBe(1);
    // An edit during the reboot is forwarded to the booting session (it queues) and recorded.
    relay.fromClient(didChange(3, "ABC"));
    await bootCurrent();
    expect(relay.state.kind).toBe("serving");
    expect(current().methods()).toEqual(["textDocument/didChange", "initialize(replay)", "textDocument/didOpen"]);
    expect(current().lastFullText).toBe("ABC");
  });
  it("stale-death-ignored: a death from a superseded session changes nothing", async () => {
    relay.fromClient(didOpen(1, "A"));
    await bootCurrent();
    const old = current();
    old.onDied(null, "abort", "x");
    await settle();
    const fresh = current();
    expect(fresh).not.toBe(old);
    old.onDied(null, "abort", "again"); // disposed: its callbacks are gone
    const detachedDied = (relay as unknown as { onDied(s: RelaySession, c: null, r: string): void }).onDied;
    detachedDied.call(relay, old, null, "abort"); // even delivered by hand it is stale
    await settle();
    expect(current()).toBe(fresh);
    expect(relay.stats).toMatchObject({ workerDeaths: 1, staleDeaths: 1, reboots: 1 });
    expect(relay.state).toEqual({ kind: "rebooting", reason: "crash" });
    await bootCurrent();
  });
  it("BootFailed is a death: three inside 120 s trip the breaker into Halted; a didChange re-arms", async () => {
    relay.fromClient(didOpen(1, "A"));
    for (let i = 0; i < 3; i += 1) {
      const s = current();
      s.bootFailed(new Error("boot failed"));
      await settle();
      clock += 1000;
    }
    expect(relay.state).toEqual({ kind: "halted" });
    expect(relay.stats).toMatchObject({ workerDeaths: 3, breakerTrips: 1, reboots: 2 });
    expect(relay.status().phase).toBe("halted");
    expect(FakeSession.all).toHaveLength(3);
    // Requests while halted are answered -32603; notifications other than didChange are dropped.
    relay.fromClient(request(9, "textDocument/hover"));
    relay.fromClient({ jsonrpc: "2.0", method: "$/lean/rpc/keepAlive", params: {} });
    await settle();
    expect(errorsToClient()).toEqual([{ jsonrpc: "2.0", id: 9, error: { code: -32603, message: expect.stringContaining("halted") } }]);
    expect(toClient.filter((m) => m.error === undefined).map((m) => m.method)).toEqual(["textDocument/publishDiagnostics"]); // the halted note, once
    expect(FakeSession.all).toHaveLength(3);
    // The user edits: deaths reset, a fresh session boots, the edit reaches it.
    relay.fromClient(didChange(2, "AB"));
    expect(relay.state).toEqual({ kind: "rebooting", reason: "user" });
    expect(relay.deaths).toEqual([]);
    expect(FakeSession.all).toHaveLength(4);
    expect(current().methods()).toEqual(["textDocument/didChange"]);
    await bootCurrent();
    expect(relay.state.kind).toBe("serving");
  });
  it("an arm the worker refuses is a BootFailed death (counted once), and the next session serves", async () => {
    relay.fromClient(didOpen(1, "A"));
    await settle();
    const first = current();
    first.armFails = true;
    first.bootOk();
    await settle();
    expect(first.disposed).toBe(true);
    expect(relay.state).toEqual({ kind: "rebooting", reason: "bootFailed" });
    expect(relay.stats).toMatchObject({ workerDeaths: 1, reboots: 1, staleDeaths: 0 });
    expect(FakeSession.all).toHaveLength(2);
    await bootCurrent();
    expect(relay.state.kind).toBe("serving");
    expect(current().armedAfter).toBe(current().sent.length);
  });
  it("a death mid-boot is one death: the disposed session's rejected start() is not counted as stale", async () => {
    relay.fromClient(didOpen(1, "A"));
    await settle();
    current().onDied(null, "crash", "INIT_FAILED");
    await settle();
    expect(relay.state).toEqual({ kind: "rebooting", reason: "crash" });
    expect(relay.stats).toMatchObject({ workerDeaths: 1, staleDeaths: 0, reboots: 1 });
    await bootCurrent();
    expect(relay.state.kind).toBe("serving");
  });
  it("deaths older than 120 s fall out of the breaker window", async () => {
    relay.fromClient(didOpen(1, "A"));
    await bootCurrent();
    for (let i = 0; i < 4; i += 1) {
      current().onDied(null, "abort", "x");
      await settle();
      clock += 61_000;
      await bootCurrent();
    }
    expect(relay.state.kind).toBe("serving");
    expect(relay.stats.breakerTrips).toBe(0);
  });
});

describe("relay: RestartRequested (§2.3; §3 row 8)", () => {
  it("disposes without a death, boots a session with the options, counts a user restart, leaves deaths untouched", async () => {
    relay.fromClient(initialize);
    relay.fromClient(didOpen(1, "import Mathlib.Data.Real.Basic\nx"));
    await bootCurrent();
    relay.fromClient(request(3, "$/lean/rpc/connect"));
    const old = current();
    // The page's "Load exact imports" (§3 row 8): boot-only snapshots, the relay's own last text as the
    // header to warm, and the olean pack the exact import needs — all handed to the replacement session as is.
    relay.restart({ snapshots: ["init", "mathlib"], warmHeader: relay.lastText, packs: ["essential"] });
    await settle();
    expect(old.disposed).toBe(true);
    expect(errorsToClient()).toEqual([{ jsonrpc: "2.0", id: 3, error: { code: -32900, message: expect.stringContaining("exact imports") } }]);
    expect(relay.state).toEqual({ kind: "rebooting", reason: "user" });
    expect(current().opts).toEqual({ snapshots: ["init", "mathlib"], warmHeader: "import Mathlib.Data.Real.Basic\nx", packs: ["essential"] });
    expect(relay.stats).toMatchObject({ userRestarts: 1, workerDeaths: 0, reboots: 0 });
    await bootCurrent();
    expect(current().methods()).toEqual(["initialize(replay)", "textDocument/didOpen"]);
  });
  it("is a no-op unless serving", async () => {
    relay.restart({});
    expect(FakeSession.all).toHaveLength(1);
    expect(relay.stats.userRestarts).toBe(0);
    await bootCurrent();
  });
});

describe("relay: text-hash property", () => {
  it("over random interleavings of edits, deaths, boots and restarts the worker's text equals lastText", async () => {
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    relay.fromClient(initialize);
    relay.fromClient(didOpen(1, "v1"));
    let version = 1;
    let haltedRefusals = 0;
    for (let step = 0; step < 300; step += 1) {
      const roll = rand();
      await settle(); // a rebooting session's start() lands
      if (roll < 0.5) relay.fromClient(didChange((version += 1), `v${version}-${rand().toFixed(4)}`));
      else if (roll < 0.65 && relay.state.kind !== "halted") { current().onDied(null, "abort", "x"); await settle(); clock += 50_000; }
      else if (roll < 0.9 && relay.state.kind === "rebooting" && current().started) { current().bootOk(); await settle(); }
      else if (roll < 0.95 && relay.state.kind === "serving") { relay.restart({}); await settle(); }
      else {
        if (relay.state.kind === "halted") haltedRefusals += 1;
        relay.fromClient(request(1000 + step, rand() < 0.5 ? "$/lean/rpc/call" : "textDocument/hover"));
      }
      // The invariant holds whenever the relay is serving (a booting session holds the text in its queue).
      if (relay.state.kind === "serving") expect(hash(current().lastFullText)).toBe(hash(relay.lastText));
    }
    const finish = async () => { while (relay.state.kind === "rebooting") { await settle(); current().bootOk(); await settle(); } };
    await finish();
    if (relay.state.kind === "halted") relay.fromClient(didChange((version += 1), "revive"));
    await finish();
    expect(relay.state.kind).toBe("serving");
    await settle();
    // Every client-facing message was either the worker's initialize answer or
    // an error response to a client id — a failed in-flight request or a
    // halted refusal — never anything synthesized, except the breaker's one
    // halted note per trip (gap 5).
    const notes = toClient.filter((m) => m.id === undefined);
    expect(notes.every((m) => m.method === "textDocument/publishDiagnostics")).toBe(true);
    expect(notes).toHaveLength(relay.stats.breakerTrips);
    expect(toClient.filter((m) => m.result !== undefined).map((m) => m.id)).toEqual([0]);
    expect(errorsToClient()).toHaveLength(relay.stats.failedInFlight + haltedRefusals);
    expect(relay.stats.workerDeaths).toBeGreaterThan(0);
  });
});

// ---- The pump-retirement contract (docs/RESIDENT-WORKER-PLAN.md "relay contract") ----

const HEADER = "import Mathlib.Data.Real.Basic";
const publishes = () => toClient.filter((m) => m.method === "textDocument/publishDiagnostics");

describe("relay contract: lastDeath (gap 2 — the boot failure reason reaches the page)", () => {
  it("is null until a death, then carries the worker's (reason, message) on status() and on every sink status", async () => {
    relay.fromClient(didOpen(1, "A"));
    expect(relay.status().lastDeath).toBeNull();
    await bootCurrent();
    current().onDied(137, "abort", "Lean runtime aborted: out of memory");
    await settle();
    expect(relay.status().lastDeath).toEqual({ reason: "abort", message: "Lean runtime aborted: out of memory" });
    expect(statuses.at(-1)?.lastDeath).toEqual({ reason: "abort", message: "Lean runtime aborted: out of memory" });
    await bootCurrent();
  });
  it("a start() rejection is reason 'bootFailed' with the rejection's message (Memory64 reservation, runtime fetch, pairing)", async () => {
    await settle();
    current().bootFailed(new Error("Memory64 reservation of 6 GiB refused"));
    await settle();
    expect(relay.status().lastDeath).toEqual({ reason: "bootFailed", message: "Memory64 reservation of 6 GiB refused" });
    expect(relay.state).toEqual({ kind: "rebooting", reason: "bootFailed" });
    await bootCurrent();
  });
  it("an arm() the worker refuses is 'bootFailed' with the worker's own words", async () => {
    await settle();
    current().armFails = true;
    current().bootOk();
    await settle();
    expect(relay.status().lastDeath).toEqual({ reason: "bootFailed", message: "Worker is 'compiling', not ready" });
    await bootCurrent();
  });
  it("survives the halt (the page reads it beside phase 'halted') and clears only when a session reports phase 'ready'", async () => {
    relay.fromClient(didOpen(1, "A"));
    for (let i = 0; i < 3; i += 1) { current().bootFailed(new Error(`boot ${i}`)); await settle(); clock += 1000; }
    expect(relay.status()).toMatchObject({ phase: "halted", lastDeath: { reason: "bootFailed", message: "boot 2" } });
    relay.fromClient(didChange(2, "AB"));
    await bootCurrent();
    // Serving is not yet ready: the death stands until the worker says so.
    expect(relay.state.kind).toBe("serving");
    expect(relay.status().lastDeath).toEqual({ reason: "bootFailed", message: "boot 2" });
    const base: WorkerStatus = { phase: "elaborating", version: 2, header: null, ring: { bytesQueued: 0, refused: 0 }, pool: { unused: 3, running: 2 }, dropped: 0 };
    current().onStatus(base);
    expect(relay.status().lastDeath).not.toBeNull();
    current().onStatus({ ...base, phase: "ready" });
    expect(relay.status().lastDeath).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ phase: "ready", lastDeath: null });
  });
  it("a stale death sets nothing", async () => {
    await bootCurrent();
    const old = current();
    old.onDied(null, "abort", "first");
    await settle();
    (relay as unknown as { onDied(s: RelaySession, r: string, m: string): void }).onDied.call(relay, old, "abort", "stale");
    expect(relay.status().lastDeath).toEqual({ reason: "abort", message: "first" });
    await bootCurrent();
  });
});

describe("relay contract: the halted note (gap 5 — one whole-document publish replaces the dead session's markers)", () => {
  const text = `-- a comment first\n${HEADER}\nimport Mathlib.Tactic\n\ninductive Tree\n`;
  async function halt() {
    for (let i = 0; i < 3; i += 1) { current().onDied(null, "abort", "x"); await settle(); clock += 1000; await settle(); }
    expect(relay.state).toEqual({ kind: "halted" });
  }
  it("is exactly one severity-1 QED64 diagnostic on the first import line, spanning it, at the client's version", async () => {
    relay.fromClient(initialize);
    relay.fromClient(didOpen(1, "A"));
    await bootCurrent();
    relay.fromClient(didChange(7, text));
    await halt();
    expect(publishes()).toEqual([{
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: URI,
        version: 7,
        diagnostics: [{
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: HEADER.length } },
          severity: 1,
          source: "QED64",
          message: "imports could not be loaded: the checker crashed repeatedly while processing this content. Edit the file (or pick an example from the menu) to restart it.",
        }],
      },
    }]);
    // A later didChange re-arms as before; the note is not re-posted, and the next session's own publish replaces it.
    relay.fromClient(didChange(8, `${text}\n`));
    expect(relay.state).toEqual({ kind: "rebooting", reason: "user" });
    await bootCurrent();
    expect(publishes()).toHaveLength(1);
  });
  it("sits on line 0 when no line is an import, and the front door's modifiers (public/private/meta) still count as imports", async () => {
    relay.fromClient(didOpen(1, "theorem t : True := trivial\n"));
    await bootCurrent();
    await halt();
    expect(publishes()[0]!.params).toMatchObject({ diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: "theorem t : True := trivial".length } } }] });
    relay.fromClient(didChange(2, "\n  public meta import Foo.Bar\nimport Baz\n"));
    await bootCurrent();
    await halt();
    expect(publishes()[1]!.params).toMatchObject({ version: 2, diagnostics: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: "  public meta import Foo.Bar".length } } }] });
    relay.fromClient(didChange(3, "import Baz\n")); // re-arm so the scenario ends served (the afterEach text invariant)
    await bootCurrent();
  });
  it("an empty document still gets a 1-character range on line 0", async () => {
    relay.fromClient(didOpen(1, ""));
    await bootCurrent();
    await halt();
    expect(publishes()[0]!.params).toMatchObject({ diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] });
    relay.fromClient(didChange(2, "x"));
    await bootCurrent();
  });
  it("no document, no note", async () => {
    await bootCurrent();
    await halt();
    expect(publishes()).toEqual([]);
    expect(relay.status().phase).toBe("halted");
  });
});

describe("relay contract: restart options outlive a crash while the header stands", () => {
  const exact: RestartOptions = { snapshots: ["init", "mathlib"], warmHeader: `${HEADER}\nx`, packs: ["essential"] };
  it("a death-reboot reuses the last restart(opts) when the import lines are unchanged (body edits do not count)", async () => {
    relay.fromClient(didOpen(1, `${HEADER}\nx`));
    await bootCurrent();
    relay.restart(exact);
    expect(relay.restartOpts).toEqual(exact);
    await bootCurrent();
    relay.fromClient(didChange(2, `${HEADER}\n\ntheorem t : 1 + 1 = 2 := by norm_num\n`));
    current().onDied(null, "abort", "x");
    await settle();
    expect(current().opts).toEqual(exact);
    expect(relay.restartOpts).toEqual(exact);
    expect(relay.state).toEqual({ kind: "rebooting", reason: "crash" });
    await bootCurrent();
  });
  it("a header change forgets them: the reboot after it boots the default (umbrella) session", async () => {
    relay.fromClient(didOpen(1, `${HEADER}\nx`));
    await bootCurrent();
    relay.restart(exact);
    await bootCurrent();
    relay.fromClient(didChange(2, "import Mathlib.Data.Nat.Basic\nx"));
    current().onDied(null, "abort", "x");
    await settle();
    expect(current().opts).toBeUndefined();
    expect(relay.restartOpts).toBeNull();
    // ...and they do not come back when the header is edited back: only a fresh restart() sets them.
    relay.fromClient(didChange(3, `${HEADER}\nx`));
    await bootCurrent();
    current().onDied(null, "abort", "x");
    await settle();
    expect(current().opts).toBeUndefined();
    await bootCurrent();
  });
  it("the breaker forgets them: the halted re-arm boots the default (umbrella) session even with the header unchanged, and only a later restart() sets them again", async () => {
    // The exact import itself may be what kills the worker (an OOM warm compile); re-arming into the same mode
    // would halt again on every body edit until the HEADER changed. The umbrella at least serves the header.
    relay.fromClient(didOpen(1, `${HEADER}\nx`));
    await bootCurrent();
    relay.restart(exact);
    await bootCurrent();
    current().onDied(null, "abort", "x"); await settle(); clock += 1000; await settle();
    expect(current().opts).toEqual(exact); // the first two reboots still reuse them
    for (let i = 0; i < 2; i += 1) { current().onDied(null, "abort", "x"); await settle(); clock += 1000; await settle(); }
    expect(relay.state).toEqual({ kind: "halted" });
    expect(relay.restartOpts).toBeNull();
    relay.fromClient(didChange(2, `${HEADER}\nxy`)); // a body-only edit: the header stands, the options are gone
    expect(relay.state).toEqual({ kind: "rebooting", reason: "user" });
    expect(current().opts).toBeUndefined();
    await bootCurrent();
    const other: RestartOptions = { snapshots: ["init"], warmHeader: "", packs: [] };
    relay.restart(other);
    expect(relay.restartOpts).toEqual(other);
    await bootCurrent();
    expect(current().opts).toEqual(other);
  });
});

describe("relay contract: unload is synchronous", () => {
  it("disposes and terminates the live session inside the caller's turn — nothing awaited, nothing deferred", async () => {
    relay.fromClient(didOpen(1, "A"));
    await bootCurrent();
    const live = current();
    relay.unload();
    expect(live.disposed).toBe(true);
    expect(live.terminated).toBe(true);
  });
});
