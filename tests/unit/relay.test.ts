// The L3 relay (frontend/src/lsp-relay.ts) against a FakeSession — the
// invariants docs/ARCHITECTURE-REEVALUATION-2-2026-09-02.md §2.3 names:
// `hash(fake.lastFullText) === hash(lastText)` after every scenario, zero
// client-facing messages synthesized except responses to failed in-flight
// ids, `setTimeout` never called by the relay module, and a death carrying a
// stale session changing nothing. The 1.5 s settle is injected (§8 item 9).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LspRelay, type RelaySession, type RelayStatus, type RestartOptions } from "../../frontend/src/lsp-relay";
import type { JsonRpcMessage as Msg, WorkerStatus } from "../../src/runtime/client";

class FakeSession implements RelaySession {
  static seq = 0;
  static all: FakeSession[] = [];
  readonly id = `fake${(FakeSession.seq += 1)}`;
  readonly sent: Array<{ msg: Msg; replay: boolean }> = [];
  lastFullText: string | null = null;
  disposed = false;
  started = false;
  bootOk!: () => void;
  bootFailed!: (e: Error) => void;
  private readonly booted = new Promise<void>((resolve, reject) => { this.bootOk = resolve; this.bootFailed = reject; });
  onLsp: (msg: Msg) => void = () => {};
  onStatus: (s: WorkerStatus) => void = () => {};
  onDied: (code: number | null, reason: string, message: string) => void = () => {};
  constructor(readonly opts?: RestartOptions) { FakeSession.all.push(this); }
  start() { this.started = true; return this.booted; }
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
  }
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
  it("parses no text: no regex literal over messages, no split/indexOf on text", () => {
    expect(/\.split\(|\.match\(|\.test\(|\.exec\(|new RegExp/.test(source)).toBe(false);
  });
  it("stays within the ~150-line budget (hard cap 160 including comments)", () => {
    expect(source.split("\n").length).toBeLessThanOrEqual(160);
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
    // BootOk replays what the relay recorded (§2.3 BootOk): initialize(replay) + didOpen(lastText).
    expect(current().methods()).toEqual(["initialize", "textDocument/didOpen", "initialize(replay)", "textDocument/didOpen"]);
    relay.fromClient(didChange(2, "AB"));
    expect(current().lastFullText).toBe("AB");
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
    expect(toClient).toEqual([{ jsonrpc: "2.0", id: 9, error: { code: -32603, message: expect.stringContaining("halted") } }]);
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
    relay.restart({ snapshots: ["init", "mathlib"], warmHeader: "import Mathlib.Data.Real.Basic" });
    await settle();
    expect(old.disposed).toBe(true);
    expect(errorsToClient()).toEqual([{ jsonrpc: "2.0", id: 3, error: { code: -32900, message: expect.stringContaining("exact imports") } }]);
    expect(relay.state).toEqual({ kind: "rebooting", reason: "user" });
    expect(current().opts).toEqual({ snapshots: ["init", "mathlib"], warmHeader: "import Mathlib.Data.Real.Basic" });
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
    // halted refusal — never anything synthesized.
    expect(toClient.every((m) => m.id !== undefined)).toBe(true);
    expect(toClient.filter((m) => m.result !== undefined).map((m) => m.id)).toEqual([0]);
    expect(errorsToClient()).toHaveLength(relay.stats.failedInFlight + haltedRefusals);
    expect(relay.stats.workerDeaths).toBeGreaterThan(0);
  });
});
