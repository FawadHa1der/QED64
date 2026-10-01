// Lean-side liveness (public/workers/lean.worker.js, docs/HARDENING.md #52):
// the pure bookkeeping that tells a frozen Lean runtime from a busy one,
// driven with a fake clock; the runtime-mailbox kick and its rescue
// accounting; and the boot-time instrumentation of the glue (message
// notifications, the proxied-call count, the FileWorker exit hook) — all
// loaded from the REAL worker script in vm sandboxes (the front-door.test.ts
// pattern). A sandbox whose worker may die gets its own: `die` latches.
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
  rescue: { notifiedAtLastKick: number; pending: { empty: number } | null };
  counters: Counters;
}
type Action = null | { kind: "probe"; msg: Msg } | { kind: "stall"; silentMs: number } | { kind: "dead"; silentMs: number };
interface Mailbox { mode: string; notified: number; empty: number; served: number; counting: boolean; exitHooked: boolean }
interface Hooks {
  LIVENESS: Liveness["cfg"];
  LIVENESS_PROBE_PREFIX: string;
  createLiveness(now: number): Liveness;
  livenessClientRequest(L: Liveness, msg: Msg, now: number): void;
  livenessServerFrame(L: Liveness, msg: Msg, now: number): { probe: boolean; resumedAfterMs: number | null };
  livenessTick(L: Liveness, now: number, phase: string, docOpen?: boolean): Action;
  livenessKicked(L: Liveness, served: boolean | null, notified: number, empty: number): boolean;
  kickMailbox(): { kicked: boolean; served: boolean | null };
  instrumentRuntimeMailbox(): Mailbox;
  runtimeMailbox: Mailbox;
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

describe("liveness: rescues are confirmed, never guessed", () => {
  it("a kick that served work with no notification since the previous kick is a candidate, confirmed one kick later when no late (empty) notification came", () => {
    const L = hooks.createLiveness(0);
    expect(hooks.livenessKicked(L, false, 0, 0)).toBe(false); // idle: nothing served
    expect(hooks.livenessKicked(L, true, 40, 0)).toBe(false); // served while notifications flowed: not a candidate
    expect(hooks.livenessKicked(L, true, 40, 0)).toBe(false); // candidate (no notification since the last kick)
    expect(hooks.livenessKicked(L, false, 41, 0)).toBe(true); //  a notification arrived and served NEW work: the candidate's wakeup was lost → confirmed
    expect(L.counters.rescues).toBe(1);
  });
  it("the in-flight notification for work the kick already served arrives empty and cancels the candidate (a race, not a lost wakeup)", () => {
    const L = hooks.createLiveness(0);
    hooks.livenessKicked(L, false, 10, 2);
    expect(hooks.livenessKicked(L, true, 10, 2)).toBe(false); // candidate
    expect(hooks.livenessKicked(L, false, 11, 3)).toBe(false); // the late message found nothing to serve: cancelled
    expect(L.counters.rescues).toBe(0);
    expect(L.rescue.pending).toBeNull();
  });
  it("an unobservable kick (no instrumented table) is never a candidate", () => {
    const L = hooks.createLiveness(0);
    hooks.livenessKicked(L, null, 5, 0);
    expect(hooks.livenessKicked(L, null, 5, 0)).toBe(false);
    expect(hooks.livenessKicked(L, null, 5, 0)).toBe(false);
    expect(L.counters.rescues).toBe(0);
  });
});

describe("liveness: the runtime-mailbox kick", () => {
  it("is a no-op when the glue exposes no mailbox", () => {
    const { hooks: h } = loadWorker();
    expect(h.kickMailbox()).toEqual({ kicked: false, served: null });
  });
  it("calls the glue's `_emscripten_check_mailbox` once per kick; `served` is unobservable without the instrumented table", () => {
    const { sandbox, hooks: h } = loadWorker();
    let calls = 0;
    sandbox.__emscripten_check_mailbox = () => { calls += 1; };
    expect(h.kickMailbox()).toEqual({ kicked: true, served: null });
    expect(h.kickMailbox()).toEqual({ kicked: true, served: null });
    expect(calls).toBe(2);
  });
  it("reports whether it served a proxied call, counted by the instrumented proxied-function table", () => {
    const { sandbox, hooks: h } = loadWorker();
    const table = [() => 0, () => 0, () => 7];
    sandbox.proxiedFunctionTable = table;
    expect(h.instrumentRuntimeMailbox().counting).toBe(true);
    let queued = 0;
    sandbox.__emscripten_check_mailbox = () => { while (queued > 0) { queued -= 1; (table[2] as () => number)(); } };
    expect(h.kickMailbox()).toEqual({ kicked: true, served: false });
    queued = 2;
    expect(h.kickMailbox()).toEqual({ kicked: true, served: true });
    expect(h.runtimeMailbox.served).toBe(2);
    expect((table[2] as () => number)()).toBe(7); // the wrapper is transparent
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
    expect(h.instrumentRuntimeMailbox()).toMatchObject({ mode: "as built", counting: false, exitHooked: false });
  });
  it("turns off the Atomics.waitAsync waiter and counts notification-driven checks, and those that served nothing", () => {
    const { sandbox, hooks: h } = loadWorker();
    const table = [() => 0];
    sandbox.proxiedFunctionTable = table;
    sandbox.waitAsyncPolyfilled = false;
    let delivered = 0;
    let queued = 0;
    sandbox.checkMailbox = () => { delivered += 1; while (queued > 0) { queued -= 1; (table[0] as () => number)(); } };
    const m = h.instrumentRuntimeMailbox();
    expect(m.mode).toBe("message");
    expect(sandbox.waitAsyncPolyfilled).toBe(true);
    // The glue's message handler and its self-notification look the global up at call time.
    queued = 1;
    (sandbox.checkMailbox as () => void)();
    (sandbox.checkMailbox as () => void)();
    expect(delivered).toBe(2);
    expect(m).toMatchObject({ notified: 2, empty: 1, served: 1 });
  });
  it("reports a FileWorker exit (proxied `_proc_exit` / `exitOnMainThread`) as a death in resident mode, before the glue swallows it", () => {
    for (const index of [0, 1]) {
      const { sandbox, hooks: h, posted, resident } = loadWorker();
      const procExit = () => { throw Object.assign(new Error("exit"), { name: "ExitStatus" }); };
      const exitOnMainThread = () => { throw Object.assign(new Error("exit"), { name: "ExitStatus" }); };
      sandbox._proc_exit = procExit;
      sandbox.exitOnMainThread = exitOnMainThread;
      const table = [procExit, exitOnMainThread, () => 0];
      sandbox.proxiedFunctionTable = table;
      expect(h.instrumentRuntimeMailbox().exitHooked).toBe(true);
      // Not resident: the glue's own behaviour, no death reported here.
      expect(() => (table[index] as (c: number) => void)(5)).toThrow();
      expect(deaths(posted)).toEqual([]);
      goResident(resident);
      expect(() => (table[index] as (c: number) => void)(5)).toThrow(); // the original still runs (and throws)
      expect(deaths(posted).map((d) => [d.reason, d.code])).toEqual([["exit", 5]]);
    }
  });
  it("does not hook entries that are not the glue's exit functions", () => {
    const { sandbox, hooks: h } = loadWorker();
    sandbox._proc_exit = () => {};
    sandbox.proxiedFunctionTable = [() => {}, () => {}];
    expect(h.instrumentRuntimeMailbox()).toMatchObject({ counting: true, exitHooked: false });
  });
});
