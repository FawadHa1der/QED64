// Lean-side liveness (public/workers/lean.worker.js, docs/HARDENING.md #52):
// the pure bookkeeping that tells a frozen Lean runtime from a busy one,
// driven with a fake clock; the runtime-mailbox kick (every tick, uncounted);
// and the boot-time instrumentation of the glue (message notifications, the
// FileWorker exit hook) — all loaded from the REAL worker script in vm
// sandboxes (the front-door.test.ts pattern). A sandbox whose worker may die
// gets its own: `die` latches.
import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; error?: unknown; result?: unknown };
interface Counters { probes: number; answered: number; stalls: number; resumed: number; rescues: number }
interface Liveness {
  cfg: { tickMs: number; probeAfterMs: number; wedgeAfterMs: number; graceMs: number; requestTtlMs: number };
  outstanding: Map<number | string, number>;
  probe: { id: string; sentAt: number } | null;
  stalledAt: number;
  counters: Counters;
}
type Action = null | { kind: "probe"; msg: Msg } | { kind: "stall"; silentMs: number } | { kind: "dead"; silentMs: number };
interface Mailbox { mode: string; exitHooked: boolean; exitEntries: { name: string; index: number }[] }
interface Hooks {
  LIVENESS: Liveness["cfg"];
  LIVENESS_PROBE_PREFIX: string;
  createLiveness(now: number): Liveness;
  livenessClientRequest(L: Liveness, msg: Msg, now: number): void;
  livenessServerFrame(L: Liveness, msg: Msg, now: number): { probe: boolean; resumedAfterMs: number | null };
  livenessTick(L: Liveness, now: number, phase: string, docOpen?: boolean): Action;
  kickMailbox(): { kicked: boolean };
  instrumentRuntimeMailbox(): Mailbox;
  mailboxBootLine(m: Mailbox): string;
  EXIT_ENTRY_NAMES: readonly string[];
  runtimeMailbox: Mailbox;
  start(): void;
  stop(): void;
  step(): void;
}
interface Resident { attachRing(memory: unknown, ptr: number): void }
type Posted = { type: string; kind?: string; reason?: string; code?: number | null; message?: string };

function loadWorker() {
  const posted: Posted[] = [];
  const workers = path.resolve(__dirname, "../../public/workers");
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
    setTimeout, clearTimeout, clearInterval,
    setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref(); return t; },
    fetch: () => Promise.reject(new Error("no network in unit tests")),
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: unknown) => posted.push(m as Posted);
  sandbox.addEventListener = () => {};
  sandbox.crossOriginIsolated = true;
  sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  const exportsOf = (sandbox as { __qed64TestExports?: { liveness: Hooks; resident: Resident } }).__qed64TestExports!;
  return { sandbox, posted, hooks: exportsOf.liveness, resident: exportsOf.resident };
}
const deaths = (posted: Posted[]) => posted.filter((m) => m.kind === "died");
/** Resident mode on, with a fake heap big enough for the ring the worker would attach. */
function goResident(resident: Resident) {
  resident.attachRing({ buffer: new SharedArrayBuffer(1 << 16) }, 0);
}

let hooks: Hooks;
beforeAll(() => { hooks = loadWorker().hooks; });

const request = (id: number, method = "textDocument/hover"): Msg => ({ jsonrpc: "2.0", id, method, params: {} });
const response = (id: number | string): Msg => ({ jsonrpc: "2.0", id, result: null });
const progress = (): Msg => ({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { processing: [] } });

/** Drive ticks every `cfg.tickMs` from `from` to `to`, returning every non-null action with its time. */
function run(L: Liveness, from: number, to: number, phase: string, docOpen = true) {
  const out: { at: number; action: NonNullable<Action> }[] = [];
  for (let t = from; t <= to; t += L.cfg.tickMs) {
    const a = hooks.livenessTick(L, t, phase, docOpen);
    if (a) out.push({ at: t, action: a });
  }
  return out;
}

describe("liveness: when nothing is owed, nothing is probed", () => {
  it("an idle or ready session is never probed", () => {
    const L = hooks.createLiveness(0);
    expect(run(L, 0, 30 * 60_000, "ready")).toEqual([]);
    expect(run(L, 0, 60_000, "headerRefused")).toEqual([]);
    expect(L.counters).toEqual({ probes: 0, answered: 0, stalls: 0, resumed: 0, rescues: 0 });
  });
  it("'starting' before the didOpen is in the ring is never probed (the FileWorker reads initialize and didOpen before its loop; a probe there would kill it)", () => {
    const L = hooks.createLiveness(0);
    expect(run(L, 0, 120_000, "starting", false)).toEqual([]);
    expect(L.counters.probes).toBe(0);
  });
});

describe("liveness: a busy but healthy Lean side", () => {
  it("probes after `probeAfterMs` of silence while elaborating: a private id, an unknown method, WITH params", () => {
    const L = hooks.createLiveness(0);
    const acts = run(L, 0, L.cfg.probeAfterMs, "elaborating");
    expect(acts).toHaveLength(1);
    expect(acts[0]!.at).toBe(L.cfg.probeAfterMs);
    const probe = (acts[0]!.action as { msg: Msg }).msg;
    expect(String(probe.id).startsWith(hooks.LIVENESS_PROBE_PREFIX)).toBe(true);
    expect(probe.method).toBe("$/qed64/liveness");
    // Lean's mainLoop matches `Message.request id method (some params)`;
    // a request without params is "Got invalid JSON-RPC message" (fatal).
    expect(probe.params).toEqual({});
    // While the probe is outstanding no second probe is sent.
    expect(run(L, L.cfg.probeAfterMs + L.cfg.tickMs, L.cfg.probeAfterMs + L.cfg.wedgeAfterMs - L.cfg.tickMs, "elaborating")).toEqual([]);
  });
  it("'starting' with the document open is owed work: a silent first elaboration is probed", () => {
    const L = hooks.createLiveness(0);
    expect(run(L, 0, L.cfg.probeAfterMs, "starting", true).map((x) => x.action.kind)).toEqual(["probe"]);
  });
  it("the probe's answer is swallowed and clears it; a non-terminating elaboration that keeps answering is never declared dead", () => {
    const L = hooks.createLiveness(0);
    let now = 0;
    let probes = 0;
    // Ten minutes of a tactic that prints nothing: probe, answer 50 ms later, repeat.
    while (now < 10 * 60_000) {
      const a = hooks.livenessTick(L, now, "elaborating", true);
      if (a?.kind === "probe") {
        probes += 1;
        expect(hooks.livenessServerFrame(L, { jsonrpc: "2.0", id: a.msg.id, error: { code: -32603, message: "unknown" } }, now + 50)).toEqual({ probe: true, resumedAfterMs: null });
      }
      expect(a?.kind === "stall" || a?.kind === "dead").toBe(false);
      now += L.cfg.tickMs;
    }
    expect(probes).toBeGreaterThan(50);
    expect(L.counters.answered).toBe(probes);
    expect(L.counters.stalls).toBe(0);
    expect(L.probe).toBeNull();
  });
  it("other server frames keep a probed session alive even if the probe's own answer is slow", () => {
    const L = hooks.createLiveness(0);
    expect(run(L, 0, L.cfg.probeAfterMs, "elaborating")).toHaveLength(1);
    // Output keeps flowing every 3 s for a minute; the answer is queued behind it.
    for (let t = L.cfg.probeAfterMs; t < 60_000; t += 3000) {
      expect(hooks.livenessServerFrame(L, progress(), t)).toEqual({ probe: false, resumedAfterMs: null });
      expect(hooks.livenessTick(L, t + 1000, "elaborating", true)).toBeNull();
    }
    expect(L.counters.stalls).toBe(0);
  });
  it("tracks forwarded client requests (not initialize): an unanswered request is owed work even when the phase is ready", () => {
    const L = hooks.createLiveness(0);
    hooks.livenessClientRequest(L, request(1, "initialize"), 0);
    expect(L.outstanding.size).toBe(0);
    hooks.livenessClientRequest(L, request(7, "$/lean/rpc/call"), 0);
    hooks.livenessClientRequest(L, { jsonrpc: "2.0", method: "textDocument/didChange", params: {} }, 0); // notification: not tracked
    expect([...L.outstanding.keys()]).toEqual([7]);
    expect(run(L, 0, L.cfg.probeAfterMs, "ready").map((x) => x.action.kind)).toEqual(["probe"]);
    // The request's answer (any frame with its id and no method) retires it;
    // a server→client request (id AND method) does not.
    hooks.livenessServerFrame(L, { jsonrpc: "2.0", id: 7, method: "workspace/inlayHint/refresh" }, L.cfg.probeAfterMs + 5);
    expect(L.outstanding.size).toBe(1);
    hooks.livenessServerFrame(L, response(7), L.cfg.probeAfterMs + 10);
    expect(L.outstanding.size).toBe(0);
  });
  it("forgets a forwarded request after `requestTtlMs` (an unanswered request is not a liveness signal forever)", () => {
    const L = hooks.createLiveness(0);
    hooks.livenessClientRequest(L, request(9), 0);
    hooks.livenessServerFrame(L, progress(), L.cfg.requestTtlMs - 1); // recent output: no probe due
    expect(hooks.livenessTick(L, L.cfg.requestTtlMs + 1, "ready", true)).toBeNull();
    expect(L.outstanding.size).toBe(0);
  });
});

describe("liveness: a frozen Lean side", () => {
  it("probe unanswered and no frame for `wedgeAfterMs` → a stall; still nothing `graceMs` later → dead, with the silence measured", () => {
    const L = hooks.createLiveness(0);
    const end = L.cfg.probeAfterMs + L.cfg.wedgeAfterMs + L.cfg.graceMs;
    const acts = run(L, 0, end, "elaborating");
    expect(acts.map((x) => x.action.kind)).toEqual(["probe", "stall", "dead"]);
    expect(acts[1]!.at).toBe(L.cfg.probeAfterMs + L.cfg.wedgeAfterMs);
    expect(acts[2]!.at).toBe(end);
    expect((acts[2]!.action as { silentMs: number }).silentMs).toBe(end);
    expect(L.counters).toMatchObject({ probes: 1, stalls: 1, resumed: 0 });
  });
  it("output resuming in the grace window ends the stall (counted, with its length)", () => {
    const L = hooks.createLiveness(0);
    const acts = run(L, 0, L.cfg.probeAfterMs + L.cfg.wedgeAfterMs, "elaborating");
    expect(acts.map((x) => x.action.kind)).toEqual(["probe", "stall"]);
    expect(hooks.livenessServerFrame(L, progress(), acts[1]!.at + 1500)).toEqual({ probe: false, resumedAfterMs: 1500 });
    expect(L.counters).toMatchObject({ stalls: 1, resumed: 1 });
    expect(L.stalledAt).toBe(0);
  });
  it("when the first frame after a stall IS the probe's answer, both facts are reported (the answer is swallowed, the resume is not lost)", () => {
    const L = hooks.createLiveness(0);
    const acts = run(L, 0, L.cfg.probeAfterMs + L.cfg.wedgeAfterMs, "elaborating");
    const probeId = (acts[0]!.action as { msg: Msg }).msg.id!;
    expect(hooks.livenessServerFrame(L, response(probeId), acts[1]!.at + 700)).toEqual({ probe: true, resumedAfterMs: 700 });
    expect(L.counters).toMatchObject({ answered: 1, resumed: 1 });
    expect(L.probe).toBeNull();
  });
  it("time to a verdict is bounded: dead at probeAfter + wedgeAfter + grace after the last frame", () => {
    const { probeAfterMs, wedgeAfterMs, graceMs } = hooks.LIVENESS;
    expect(probeAfterMs + wedgeAfterMs + graceMs).toBeLessThanOrEqual(30_000);
    expect(probeAfterMs).toBeGreaterThanOrEqual(5000); // never inside a normal elaboration's quiet stretch
  });
});

describe("liveness: the runtime-mailbox kick", () => {
  it("is a no-op when the glue exposes no mailbox", () => {
    const { hooks: h } = loadWorker();
    expect(h.kickMailbox()).toEqual({ kicked: false });
  });
  it("calls the glue's `_emscripten_check_mailbox` once per kick", () => {
    const { sandbox, hooks: h } = loadWorker();
    let calls = 0;
    sandbox.__emscripten_check_mailbox = () => { calls += 1; };
    expect(h.kickMailbox()).toEqual({ kicked: true });
    expect(h.kickMailbox()).toEqual({ kicked: true });
    expect(calls).toBe(2);
  });
  it("the liveness tick serves the mailbox on every tick (no PENDING watch, no deferred kick)", () => {
    const { sandbox, hooks: h } = loadWorker();
    let calls = 0;
    sandbox.__emscripten_check_mailbox = () => { calls += 1; };
    h.start();
    try {
      h.step();
      h.step();
      h.step();
    } finally {
      h.stop();
    }
    expect(calls).toBe(3);
  });
  it("an unwind thrown through it is benign", () => {
    const { sandbox, hooks: h, posted } = loadWorker();
    sandbox.__emscripten_check_mailbox = () => { throw "unwind"; };
    expect(h.kickMailbox().kicked).toBe(true);
    expect(deaths(posted)).toEqual([]);
  });
  it("any other error thrown by a proxied function is the session's death (crash)", () => {
    const { sandbox, hooks: h, posted, resident } = loadWorker();
    goResident(resident);
    sandbox.__emscripten_check_mailbox = () => { throw new Error("boom"); };
    expect(h.kickMailbox().kicked).toBe(true);
    expect(deaths(posted).map((d) => d.reason)).toEqual(["crash"]);
    expect(deaths(posted)[0]!.message).toMatch(/boom/);
  });
  it("an ExitStatus thrown through it in resident mode is the FileWorker's exit, with its code", () => {
    const { sandbox, hooks: h, posted, resident } = loadWorker();
    goResident(resident);
    sandbox.__emscripten_check_mailbox = () => { const e = new Error("exit"); e.name = "ExitStatus"; (e as unknown as { status: number }).status = 3; throw e; };
    h.kickMailbox();
    expect(deaths(posted).map((d) => [d.reason, d.code])).toEqual([["exit", 3]]);
  });
});

describe("liveness: boot-time instrumentation of the glue", () => {
  it("leaves a glue without the globals as built", () => {
    const { hooks: h } = loadWorker();
    expect(h.instrumentRuntimeMailbox()).toMatchObject({ mode: "as built", exitHooked: false });
  });
  it("turns off the Atomics.waitAsync waiter (message mode) and leaves `checkMailbox` and the other table entries as the glue built them", () => {
    const { sandbox, hooks: h } = loadWorker();
    const entry = () => 0;
    const table = [entry];
    sandbox.proxiedFunctionTable = table;
    sandbox.waitAsyncPolyfilled = false;
    const checkMailbox = () => {};
    sandbox.checkMailbox = checkMailbox;
    const m = h.instrumentRuntimeMailbox();
    expect(m.mode).toBe("message");
    expect(sandbox.waitAsyncPolyfilled).toBe(true);
    expect(sandbox.checkMailbox).toBe(checkMailbox);
    expect(table[0]).toBe(entry);
  });
  /** A sandbox whose glue defines both exit functions, with `table` built from them (the K6 tests' setup). */
  function withExits(build: (procExit: () => never, exitOnMainThread: () => never) => unknown[]) {
    const w = loadWorker();
    const procExit = (): never => { throw Object.assign(new Error("exit"), { name: "ExitStatus" }); };
    const exitOnMainThread = (): never => { throw Object.assign(new Error("exit"), { name: "ExitStatus" }); };
    w.sandbox._proc_exit = procExit;
    w.sandbox.exitOnMainThread = exitOnMainThread;
    const table = build(procExit, exitOnMainThread);
    w.sandbox.proxiedFunctionTable = table;
    return { ...w, table };
  }
  it("reports a FileWorker exit (proxied `_proc_exit` / `exitOnMainThread`, matched by identity at any index) as a death in resident mode, before the glue swallows it", () => {
    // Neither entry at the index the glue used to give it (K6): found by identity, not position.
    const order = (procExit: () => never, exitOnMainThread: () => never) => [() => 0, exitOnMainThread, () => 0, procExit];
    {
      const { hooks: h } = withExits(order);
      const m = h.instrumentRuntimeMailbox();
      expect(m.exitEntries).toEqual([{ name: "exitOnMainThread", index: 1 }, { name: "_proc_exit", index: 3 }]);
      expect(m.exitHooked).toBe(true);
    }
    for (const index of [1, 3]) {
      const { hooks: h, posted, resident, table } = withExits(order);
      expect(h.instrumentRuntimeMailbox().exitHooked).toBe(true);
      // Not resident: the glue's own behaviour, no death reported here.
      expect(() => (table[index] as (c: number) => void)(5)).toThrow();
      expect(deaths(posted)).toEqual([]);
      goResident(resident);
      expect(() => (table[index] as (c: number) => void)(5)).toThrow(); // the original still runs (and throws)
      expect(deaths(posted).map((d) => [d.reason, d.code])).toEqual([["exit", 5]]);
    }
  });
  it("one exit entry missing: not hooked, and the one found still reports", () => {
    // `exitOnMainThread` is defined but absent from the table.
    const { hooks: h, posted, resident, table } = withExits((procExit) => [procExit, () => 0]);
    const m = h.instrumentRuntimeMailbox();
    expect(m.exitHooked).toBe(false);
    expect(m.exitEntries).toEqual([{ name: "_proc_exit", index: 0 }]);
    goResident(resident);
    expect(() => (table[0] as (c: number) => void)(5)).toThrow();
    expect(deaths(posted).map((d) => [d.reason, d.code])).toEqual([["exit", 5]]);
  });
  it("the boot line names each exit entry, and keeps the prefixes the showcase's capture matches", () => {
    const showcase = /\[boot\] (runtime mailbox|WARNING)/;
    const full = hooks.mailboxBootLine({ mode: "message", exitHooked: true, exitEntries: [{ name: "_proc_exit", index: 0 }, { name: "exitOnMainThread", index: 1 }] });
    expect(full).toBe("[boot] runtime mailbox: message notifications (no Atomics.waitAsync); FileWorker exit hooked (_proc_exit at [0], exitOnMainThread at [1])");
    expect(full).toMatch(showcase);
    const partial = hooks.mailboxBootLine({ mode: "message", exitHooked: false, exitEntries: [{ name: "_proc_exit", index: 0 }] });
    expect(partial.startsWith("[boot] WARNING: runtime mailbox partly instrumented")).toBe(true);
    expect(partial).toContain("exitOnMainThread not found");
    expect(partial).toContain("_proc_exit at [0]");
    expect(partial).toMatch(showcase);
    // Message mode off with both entries hooked is a WARNING too (the mode is named).
    const asBuilt = hooks.mailboxBootLine({ mode: "as built", exitHooked: true, exitEntries: [{ name: "_proc_exit", index: 0 }, { name: "exitOnMainThread", index: 1 }] });
    expect(asBuilt).toMatch(/^\[boot\] WARNING: runtime mailbox partly instrumented \(mode as built; /);
    expect(hooks.EXIT_ENTRY_NAMES).toEqual(["_proc_exit", "exitOnMainThread"]);
  });
  it("does not hook entries that are not the glue's exit functions", () => {
    const { sandbox, hooks: h } = loadWorker();
    sandbox._proc_exit = () => {};
    const originals = [() => {}, () => {}];
    const table = [...originals];
    sandbox.proxiedFunctionTable = table;
    expect(h.instrumentRuntimeMailbox()).toMatchObject({ exitHooked: false, exitEntries: [] });
    expect(table[0]).toBe(originals[0]);
    expect(table[1]).toBe(originals[1]);
  });
});
