// Full-text edit coalescing (frontend/src/embed/edit-coalescer.ts; docs/EMBEDDING.md
// §7.8, HARDENING #59): a burst of full-text didChanges reaches the worker at
// most once per window, the newest last; while a change is held every other
// frame waits behind it in order (a client's per-keystroke requests must not
// defeat the coalescing), except the frames that change the document set or
// edit it partially, which flush it first; a semantic-tokens request queued
// behind a change that a newer change replaces is answered ContentModified,
// as Lean would (the one reply Monaco rebases by its later edits).
import { describe, expect, it } from "vitest";
import { CANCELLED, DEFAULT_MAX_HOLD_MS, DEFAULT_MAX_IN_FLIGHT_REQUESTS, DEFAULT_MIN_FREE_WORKERS, DEFAULT_PRESSURE_MEMORY_MS, SUPERSEDED, SUPERSEDED_METHODS, createEditCoalescer, isFullTextChange, type BackPressureEvent, type PoolSample } from "../../frontend/src/embed/edit-coalescer";

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: unknown };
class Clock {
  t = 0;
  timers: Array<{ at: number; f: () => void; id: number }> = [];
  seq = 0;
  now = () => this.t;
  setTimeout = (f: () => void, ms: number) => { const id = (this.seq += 1); this.timers.push({ at: this.t + ms, f, id }); return id; };
  clearTimeout = (id: unknown) => { this.timers = this.timers.filter((x) => x.id !== id); };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.t = next.at;
      this.clearTimeout(next.id);
      next.f();
    }
    this.t = end;
  }
}
const change = (version: number, text: string, uri = "file:///a.lean"): Msg => ({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri, version }, contentChanges: [{ text }] } });
const setup = (ms = 300) => {
  const clock = new Clock();
  const out: Array<{ m: Msg; replay?: boolean; t: number }> = [];
  const rejected: Array<{ id: number | string | undefined; method: string | undefined; code: number; t: number }> = [];
  const c = createEditCoalescer<Msg>({
    forward: (m, replay) => out.push({ m, ...(replay ? { replay } : {}), t: clock.t }),
    reject: (m, e) => rejected.push({ id: m.id, method: m.method, code: e.code, t: clock.t }),
    ms,
    timers: clock,
    backPressure: { maxInFlightRequests: 0 }, // the window's own rules; the cap has its own block below
  });
  const sent = () => out.map((o) => (o.m.method === "textDocument/didChange" ? `v${(o.m.params as { textDocument: { version: number } }).textDocument.version}@${o.t}` : `${o.m.method}@${o.t}`));
  return { clock, out, c, sent, rejected };
};

describe("isFullTextChange", () => {
  it("is a didChange with one content change that carries the whole text", () => {
    expect(isFullTextChange(change(2, "x"))).toBe(true);
    expect(isFullTextChange({ method: "textDocument/didChange", params: { contentChanges: [{ range: {}, text: "x" }] } })).toBe(false);
    expect(isFullTextChange({ method: "textDocument/didChange", params: { contentChanges: [{ text: "a" }, { text: "b" }] } })).toBe(false);
    expect(isFullTextChange({ method: "textDocument/didOpen", params: { textDocument: { text: "x" } } })).toBe(false);
    expect(isFullTextChange({ method: "textDocument/didChange" })).toBe(false);
  });
});

describe("createEditCoalescer", () => {
  it("a burst reaches the worker once per window, the newest last (lean4game's trigger: 9 changes in 230 ms)", () => {
    const { clock, c, sent } = setup();
    for (let v = 2; v <= 10; v += 1) { c.send(change(v, "x".repeat(v))); clock.advance(29); }
    expect(sent()).toEqual(["v2@0"]); // the leading edge; v3..v10 held, newest wins
    clock.advance(300);
    expect(sent()).toEqual(["v2@0", "v10@300"]);
    clock.advance(1000);
    expect(sent()).toEqual(["v2@0", "v10@300"]); // the window closed: nothing more
    c.send(change(11, "y"));
    expect(sent().at(-1)).toBe("v11@1561"); // a change after a quiet window goes at once
  });

  it("a long stream reaches the worker at most once per window", () => {
    const { clock, c, out } = setup();
    for (let v = 2; v < 302; v += 1) { c.send(change(v, `t${v}`)); clock.advance(10); } // 3 s of keystrokes at 10 ms
    clock.advance(1000);
    const times = out.map((o) => o.t);
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(300);
    expect(out.length).toBeLessThanOrEqual(11);
    expect((out.at(-1)!.m.params as { textDocument: { version: number } }).textDocument.version).toBe(301); // the newest arrives
  });

  const req = (id: number, method = "$/lean/plainGoal", params: unknown = { textDocument: { uri: "file:///a.lean" }, position: { line: 0, character: 0 } }): Msg => ({ jsonrpc: "2.0", id, method, params });
  const note = (method: string, params: unknown = {}): Msg => ({ jsonrpc: "2.0", method, params });

  it("with nothing held, every frame goes at once", () => {
    const { c, sent } = setup();
    c.send(req(1, "textDocument/hover"));
    c.send(change(2, "a")); // the leading edge
    c.send(req(2, "textDocument/semanticTokens/full")); // nothing held: at once
    expect(sent()).toEqual(["textDocument/hover@0", "v2@0", "textDocument/semanticTokens/full@0"]);
  });

  it("while a change is held, requests and notifications wait behind it in order (lean4monaco's change + requests per keystroke); the ones a newer change supersedes are answered ContentModified, and one cancelled while it waits is answered RequestCancelled", () => {
    const { clock, c, sent, rejected } = setup();
    c.send(change(2, "a"));
    clock.advance(10);
    for (let v = 3; v <= 6; v += 1) {
      c.send(change(v, "a".repeat(v)));
      c.send(req(v, "textDocument/semanticTokens/full"));
      c.send(req(100 + v, "$/lean/rpc/call"));
      c.send(req(200 + v, "$/lean/rpc/connect", { uri: "file:///a.lean" })); // version-free: waits, never answered here
      clock.advance(10);
    }
    c.send(note("$/cancelRequest", { id: 103 })); // the first keystroke's InfoView call, still queued: answered RequestCancelled here, the cancel dropped
    expect(sent()).toEqual(["v2@0"]); // everything since waits for the window
    // Each keystroke's change replaced the held one: the semantic-tokens requests made against the replaced text were
    // answered at that moment; the InfoView's calls wait and are answered against the newest text (the client's view by then).
    expect(rejected.map((r) => `${r.id}@${r.t}:${r.code}`)).toEqual(["3@20:-32801", "4@30:-32801", "5@40:-32801", "103@50:-32800"]);
    clock.advance(300);
    expect(sent()).toEqual([
      "v2@0", "v6@300", // the newest change, then the queue in arrival order
      "$/lean/rpc/connect@300", "$/lean/rpc/call@300", "$/lean/rpc/connect@300", "$/lean/rpc/call@300", "$/lean/rpc/connect@300",
      "textDocument/semanticTokens/full@300", "$/lean/rpc/call@300", "$/lean/rpc/connect@300",
    ]);
    clock.advance(1000);
    expect(sent()).toHaveLength(10); // the window closed with nothing held
    expect(rejected).toHaveLength(4);
  });

  it("a semantic-tokens request queued behind a change that a newer change replaces is answered ContentModified at once; every other frame stays queued", () => {
    expect([...SUPERSEDED_METHODS].sort()).toEqual(["textDocument/completion", "textDocument/semanticTokens/full", "textDocument/semanticTokens/full/delta", "textDocument/semanticTokens/range"]);
    const { clock, c, sent, rejected } = setup();
    c.send(change(10, "a")); // the window
    clock.advance(80);
    c.send(change(11, "ab")); // held
    c.send(req(1, "$/lean/plainGoal")); // queued, made against v11: answered against the newest text later (the InfoView re-asks on every change anyway)
    c.send({ jsonrpc: "2.0", id: 2, method: "$/lean/rpc/connect", params: { uri: "file:///a.lean" } }); // names no textDocument
    c.send(note("$/lean/rpc/keepAlive", { uri: "file:///a.lean", sessionId: "s" }));
    c.send(note("textDocument/didSave", { textDocument: { uri: "file:///a.lean" } })); // names the document, but a notification has no answer: it waits
    c.send(req(5, "textDocument/semanticTokens/range", { textDocument: { uri: "file:///b.lean" }, range: {} })); // another document's tokens: not this change's
    clock.advance(170);
    c.send(req(3, "textDocument/semanticTokens/full", { textDocument: { uri: "file:///a.lean" } })); // Monaco's document tokens, made against v11
    c.send(req(6, "textDocument/completion", { textDocument: { uri: "file:///a.lean" }, position: { line: 0, character: 2 } })); // the quick suggest, made against v11; adjacent to 3
    expect(rejected).toEqual([]);
    clock.advance(30);
    c.send(change(12, "ab\n")); // v12 replaces v11: Monaco would rebase a reply computed on v12 by the v11→v12 edit a second time
    expect(rejected).toEqual([{ id: 3, method: "textDocument/semanticTokens/full", code: -32801, t: 280 }, { id: 6, method: "textDocument/completion", code: -32801, t: 280 }]);
    expect(SUPERSEDED.code).toBe(-32801);
    expect(sent()).toEqual(["v10@0"]);
    clock.advance(20);
    expect(sent()).toEqual(["v10@0", "v12@300", "$/lean/plainGoal@300", "$/lean/rpc/connect@300", "$/lean/rpc/keepAlive@300", "textDocument/didSave@300", "textDocument/semanticTokens/range@300"]);
    c.send(req(4, "textDocument/semanticTokens/full", { textDocument: { uri: "file:///a.lean" } })); // the window is open again, nothing held: at once
    expect(sent().at(-1)).toBe("textDocument/semanticTokens/full@300");
    expect(rejected).toHaveLength(2);
  });

  it("a superseded request flushed by a barrier or by another document's change is forwarded, never answered here: its change reaches the checker", () => {
    for (const [name, mk] of [
      ["didOpen", () => note("textDocument/didOpen", { textDocument: { uri: "file:///b.lean", version: 1, text: "" } })],
      ["another document's change", () => change(1, "c", "file:///b.lean")],
      ["ranged change", (): Msg => ({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///a.lean", version: 4 }, contentChanges: [{ range: {}, text: "d" }] } })],
    ] as const) {
      const { c, sent, rejected } = setup();
      c.send(change(2, "a"));
      c.send(change(3, "ab")); // held
      c.send(req(5, "textDocument/semanticTokens/full", { textDocument: { uri: "file:///a.lean" } })); // against v3
      c.send(req(6, "textDocument/completion", { textDocument: { uri: "file:///a.lean" }, position: { line: 0, character: 2 } })); // adjacent, against v3
      c.send(mk());
      expect(rejected, name).toEqual([]);
      expect(sent().slice(0, 4), name).toEqual(["v2@0", "v3@0", "textDocument/semanticTokens/full@0", "textDocument/completion@0"]); // v3 went, so the replies are right
    }
  });

  it("a reject hook that sends frames back in (a page observer) never loses the newest change or misfiles its frames", () => {
    const clock = new Clock();
    const out: string[] = [];
    let c!: ReturnType<typeof createEditCoalescer<Msg>>;
    const v = (m: Msg) => (m.params as { textDocument: { version: number } }).textDocument.version;
    const rejected: number[] = [];
    c = createEditCoalescer<Msg>({
      forward: (m) => out.push(m.method === "textDocument/didChange" ? `v${v(m)}@${clock.t}` : `${m.method}@${clock.t}`),
      reject: (m) => { // an out-observer reacts to the ContentModified reply by editing and asking again
        rejected.push(m.id as number);
        c.send(change(4, "abcd"));
        c.send(req(9, "textDocument/semanticTokens/full", { textDocument: { uri: "file:///a.lean" } }));
      },
      ms: 300, timers: clock,
    });
    c.send(change(2, "a"));
    c.send(change(3, "ab")); // held
    c.send(req(8, "textDocument/semanticTokens/full", { textDocument: { uri: "file:///a.lean" } })); // against v3
    c.send(change(5, "abc")); // replaces v3: request 8 is answered; inside the hook v4 arrives (older than v5? no: the client's newest is what it sends last)
    expect(rejected).toEqual([8]);
    clock.advance(300);
    // The hook's v4 is the newest frame the client sent, so it is what Lean sees; the hook's request waits behind it, never answered here.
    expect(out).toEqual(["v2@0", "v4@300", "textDocument/semanticTokens/full@300"]);
  });

  it("a request queued behind a change that is NOT replaced is forwarded, never answered here", () => {
    const { clock, c, sent, rejected } = setup();
    c.send(change(10, "a"));
    c.send(change(11, "ab"));
    c.send(req(1, "textDocument/semanticTokens/full"));
    clock.advance(300);
    expect(sent()).toEqual(["v10@0", "v11@300", "textDocument/semanticTokens/full@300"]);
    expect(rejected).toEqual([]);
  });

  it("every forwarded change opens a window, a barrier's flush included: the change after a barrier's flush waits a full window", () => {
    const { clock, c, sent } = setup();
    c.send(change(2, "a"));
    clock.advance(10);
    c.send(change(3, "ab")); // held
    c.send(note("textDocument/didOpen", { textDocument: { uri: "file:///b.lean", version: 1, text: "" } })); // a barrier: v3 goes at 10
    expect(sent()).toEqual(["v2@0", "v3@10", "textDocument/didOpen@10"]);
    clock.advance(10);
    c.send(change(4, "abc")); // inside the window v3 opened: held, not sent 10 ms after v3
    expect(sent()).toHaveLength(3);
    clock.advance(280); // 300 ms after v3, not after v2
    expect(sent()).toHaveLength(3);
    clock.advance(10);
    expect(sent().at(-1)).toBe("v4@310");
  });

  it("didOpen, didClose, a ranged or multi-part didChange and a replay flush the held change and the queue, then go", () => {
    const ranged: Msg = { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///a.lean", version: 9 }, contentChanges: [{ range: {}, text: "d" }] } };
    const multi: Msg = { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///a.lean", version: 9 }, contentChanges: [{ text: "x" }, { text: "y" }] } };
    for (const [name, barrier, replay] of [
      ["didOpen", note("textDocument/didOpen", { textDocument: { uri: "file:///a.lean", version: 9, text: "z" } }), false],
      ["didClose", note("textDocument/didClose", { textDocument: { uri: "file:///a.lean" } }), false],
      ["ranged", ranged, false],
      ["multi", multi, false],
      ["replay", req(0, "initialize"), true],
    ] as const) {
      const { clock, c, out } = setup();
      c.send(change(2, "a"));
      c.send(change(3, "ab"));
      c.send(req(7));
      c.send(barrier, replay);
      expect(out.map((o) => o.m.method), name).toEqual(["textDocument/didChange", "textDocument/didChange", "$/lean/plainGoal", barrier.method]);
      expect(out.at(-1)!.replay ?? false, name).toBe(replay);
      clock.advance(300);
      expect(out, name).toHaveLength(4);
    }
  });

  it("a replayed didChange is never held", () => {
    const { clock, c, out } = setup();
    c.send(change(2, "a"));
    c.send(change(3, "ab"), true);
    c.send(change(4, "abc"), true);
    expect(out.map((o) => o.replay ?? false)).toEqual([false, true, true]);
    clock.advance(300);
    expect(out).toHaveLength(3);
  });

  it("never merges changes of different documents", () => {
    const { c, sent, clock } = setup();
    c.send(change(2, "a", "file:///a.lean"));
    c.send(change(3, "b", "file:///a.lean"));
    c.send(req(5));
    c.send(change(1, "c", "file:///b.lean"));
    expect(sent()).toEqual(["v2@0", "v3@0", "$/lean/plainGoal@0"]); // a's held change and its queue went before b's was held
    clock.advance(300);
    expect(sent()).toEqual(["v2@0", "v3@0", "$/lean/plainGoal@0", "v1@300"]);
  });

  it("dispose drops the held change and the queue and stops the window; later sends are ignored", () => {
    const { clock, c, out } = setup();
    c.send(change(2, "a"));
    c.send(change(3, "ab"));
    c.send(req(4));
    c.dispose();
    expect(clock.timers).toHaveLength(0);
    clock.advance(1000);
    c.send(change(4, "abc"));
    c.send({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: {} });
    expect(out).toHaveLength(1);
  });

  it("a window of 0 forwards every change at once", () => {
    const { c, out, clock } = setup(0);
    for (let v = 2; v <= 6; v += 1) c.send(change(v, `t${v}`));
    expect(out).toHaveLength(5);
    expect(clock.timers).toHaveLength(0);
  });
});

// Back-pressure on the worker's pool sample (HARDENING #59, the `pageslow`
// crash): a change held when its window ends stays held while fewer than
// `minFreeWorkers` preallocated Workers are free, the frames behind it with
// it, until a later sample shows the pool drained or the cap ends; a quiet
// change under pressure is held the same way. The samples are injected.
describe("createEditCoalescer: back-pressure on the worker's pool", () => {
  type Ev = { kind: BackPressureEvent["kind"]; unused: number; queued: number; heldMs: number | undefined; t: number };
  const bp = (opts: { minFreeWorkers?: number; maxHoldMs?: number; pressureMemoryMs?: number } = {}, ms = 300) => {
    const clock = new Clock();
    const out: Array<{ m: Msg; replay?: boolean; t: number }> = [];
    const rejected: Array<{ id: number | string | undefined; code: number; t: number }> = [];
    const events: Ev[] = [];
    const c = createEditCoalescer<Msg>({
      forward: (m, replay) => out.push({ m, ...(replay ? { replay } : {}), t: clock.t }),
      reject: (m, e) => rejected.push({ id: m.id, code: e.code, t: clock.t }),
      ms,
      timers: clock,
      backPressure: { ...opts, onEvent: (e) => events.push({ kind: e.kind, unused: e.pool.unused, queued: e.queued, heldMs: e.heldMs, t: clock.t }) },
    });
    const version = (m: Msg) => (m.params as { textDocument: { version: number } }).textDocument.version;
    const sent = () => out.map((o) => (o.m.method === "textDocument/didChange" ? `v${version(o.m)}@${o.t}` : `${o.m.method}@${o.t}`));
    return { clock, out, c, sent, rejected, events, version };
  };
  const pool = (unused: number, running = 24 - unused): PoolSample => ({ unused, running, parked: 0 });
  const req = (id: number, method = "$/lean/plainGoal", params: unknown = { textDocument: { uri: "file:///a.lean" }, position: { line: 0, character: 0 } }): Msg => ({ jsonrpc: "2.0", id, method, params });
  const note = (method: string, params: unknown = {}): Msg => ({ jsonrpc: "2.0", method, params });

  it("the defaults: hold under 6 free Workers of the runtime's 24 (at most 18 pthreads alive), for 1 s after the last such sample, 5 s cap", () => {
    expect(DEFAULT_MIN_FREE_WORKERS).toBe(6);
    expect(DEFAULT_MAX_HOLD_MS).toBe(5000);
    expect(DEFAULT_PRESSURE_MEMORY_MS).toBe(1000);
  });

  it("a change held when its window ends stays held while the pool is pressured; the sample that shows it drained releases it at once, the queue behind it, and reopens the window", () => {
    const { clock, c, sent, events } = bp();
    c.send(change(2, "a")); // the leading edge; window to 300
    c.observe(pool(14)); // plenty free
    clock.advance(150);
    c.send(change(3, "ab")); // held in the window
    c.send(req(1)); // queued behind it
    c.observe(pool(3)); // 3 free: pressured
    clock.advance(150); // the window ends: still held
    expect(sent()).toEqual(["v2@0"]);
    expect(events).toEqual([{ kind: "hold", unused: 3, queued: 1, heldMs: undefined, t: 300 }]);
    clock.advance(1000); // no sample, inside the cap: still held
    expect(sent()).toEqual(["v2@0"]);
    c.observe(pool(5)); // still pressured (5 < 6)
    expect(sent()).toEqual(["v2@0"]);
    c.observe(pool(6)); // drained, but within the memory of the sample just before: still held
    expect(sent()).toEqual(["v2@0"]);
    clock.advance(1000);
    c.observe(pool(6)); // drained: exactly the threshold, 1 s after the last pressured sample
    expect(sent()).toEqual(["v2@0", "v3@2300", "$/lean/plainGoal@2300"]);
    expect(events.at(-1)).toEqual({ kind: "release", unused: 6, queued: 1, heldMs: 2000, t: 2300 });
    clock.advance(100);
    c.send(change(4, "abc")); // inside the window the release opened: held
    expect(sent()).toHaveLength(3);
    clock.advance(200); // its end, unpressured: goes
    expect(sent().at(-1)).toBe("v4@2600");
    expect(events).toHaveLength(2);
    // The release ended the hold's cap too: at 5300 (where it would have fired) nothing fires, so a change held inside a window then waits its window out.
    clock.advance(2600);
    c.send(change(5, "abcd")); // 5200: at once
    clock.advance(50);
    c.send(change(6, "abcde")); // 5250: held in v5's window, to 5500
    clock.advance(100); // 5350
    expect(sent().at(-1)).toBe("v5@5200");
    clock.advance(150);
    expect(sent().at(-1)).toBe("v6@5500");
    expect(events).toHaveLength(2);
  });

  it("a hold the memory alone keeps ends when the memory expires, with no new sample (an idle worker emits none); a pressured sample during the hold extends it; the timers end with the hold", () => {
    const { clock, c, sent, events } = bp({ pressureMemoryMs: 1000 });
    c.observe(pool(2)); // pressured at 0
    clock.advance(200);
    c.observe(pool(14)); // drained at 200: the memory (to 1000) still pressures
    c.send(change(2, "a")); // held by the memory alone
    expect(sent()).toEqual([]);
    clock.advance(799);
    expect(sent()).toEqual([]);
    clock.advance(1); // 1000: the memory expired and the last sample is drained
    expect(sent()).toEqual(["v2@1000"]);
    expect(events.map((e) => `${e.kind}@${e.t}`)).toEqual(["hold@200", "release@1000"]);
    expect(clock.timers).toHaveLength(1); // the window only
    clock.advance(300);
    // A pressured sample during a hold moves the expiry; a drained one after it does not release early.
    c.send(change(3, "ab")); // 1300: no window, last sample drained, memory expired: at once
    expect(sent()).toEqual(["v2@1000", "v3@1300"]);
    clock.advance(100);
    c.send(change(4, "abc")); // held in the window
    c.observe(pool(3)); // 1400: pressured
    clock.advance(200); // 1600: the window ends → hold
    expect(events.at(-1)).toEqual({ kind: "hold", unused: 3, queued: 0, heldMs: undefined, t: 1600 });
    clock.advance(500);
    c.observe(pool(3)); // 2100: pressured again: expiry moves to 3100
    clock.advance(500);
    c.observe(pool(14)); // 2600: drained, inside the memory
    clock.advance(499);
    expect(sent()).toHaveLength(2);
    clock.advance(1); // 3100
    expect(sent().at(-1)).toBe("v4@3100");
    // A pressured sample moves a pending re-check, and when it fires with that sample still the latest, the hold stays (only the cap ends it).
    clock.advance(300); // 3400: the window closes
    c.observe(pool(2)); // 3400: pressured
    clock.advance(200);
    c.observe(pool(14)); // 3600: drained; the memory runs to 4400
    c.send(change(5, "abcd")); // 3600: quiet, pressured by the memory alone: held, re-check at 4400
    clock.advance(500);
    c.observe(pool(3)); // 4100: pressured during the hold: the re-check moves to 5100
    clock.advance(1100); // 5200: it fired with a pressured sample as the latest: still held
    expect(sent().at(-1)).toBe("v4@3100");
    expect(events.at(-1)!.kind).toBe("hold");
    clock.advance(3400); // 8600: the cap (5000 after 3600)
    expect(sent().at(-1)).toBe("v5@8600");
    expect(events.at(-1)!.kind).toBe("cap");
    // A barrier ends a hold the memory keeps: no re-check timer survives it.
    c.observe(pool(2)); // 8600
    clock.advance(400);
    c.observe(pool(14)); // 9000: drained, inside the memory
    c.send(change(6, "abcde")); // the window (8600-8900) closed: quiet, pressured by memory: held, re-check at 9600
    c.send(note("textDocument/didOpen", { textDocument: { uri: "file:///b.lean", version: 1, text: "" } })); // flushes it
    expect(sent().slice(-2)).toEqual(["v6@9000", "textDocument/didOpen@9000"]);
    expect(clock.timers).toHaveLength(1); // the window v6 opened, nothing else
    c.dispose();
    expect(clock.timers).toHaveLength(0);
  });

  it("the memory: a drained sample inside pressureMemoryMs of the last pressured one neither releases a hold nor lets a change through; the count flaps as short request threads come and go", () => {
    const { clock, c, sent, events } = bp({ pressureMemoryMs: 500 });
    c.observe(pool(2)); // pressured at 0
    clock.advance(100);
    c.observe(pool(12)); // the flap
    c.send(change(2, "a")); // 100: still pressured by memory: held
    expect(sent()).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["hold"]);
    clock.advance(300);
    c.observe(pool(12)); // 400: inside the memory
    expect(sent()).toEqual([]);
    clock.advance(100); // 500: the memory ended (re-checked by the hold itself, no sample needed)
    expect(sent()).toEqual(["v2@500"]);
    expect(events.map((e) => e.kind)).toEqual(["hold", "release"]);
    clock.advance(300); // the window closes
    c.send(change(3, "ab")); // 800: 700 ms after the last pressured sample, latest sample drained: at once
    expect(sent()).toEqual(["v2@500", "v3@800"]);
  });

  it("the cap: the hold ends after maxHoldMs with the newest change whatever the pool says, and a newer change replacing the held one does not restart it", () => {
    const { clock, c, sent, events } = bp({ maxHoldMs: 1000 });
    c.observe(pool(2));
    c.send(change(2, "a")); // quiet but pressured: held at once, the cap from now
    expect(sent()).toEqual([]);
    expect(events).toEqual([{ kind: "hold", unused: 2, queued: 0, heldMs: undefined, t: 0 }]);
    clock.advance(600);
    c.send(change(3, "ab")); // newest wins; the cap still ends at 1000
    c.send(req(1));
    clock.advance(399);
    expect(sent()).toEqual([]);
    clock.advance(1);
    expect(sent()).toEqual(["v3@1000", "$/lean/plainGoal@1000"]);
    expect(events.at(-1)).toEqual({ kind: "cap", unused: 2, queued: 1, heldMs: 1000, t: 1000 });
    clock.advance(10000); // the window the cap opened closes with nothing held: nothing more
    expect(sent()).toHaveLength(2);
    expect(clock.timers).toHaveLength(0);
  });

  it("under sustained pressure a sustained pace (150 ms/char, the pageslow cadence) reaches the worker once per window plus cap, never nothing, and the newest version last", () => {
    const { clock, c, out, version } = bp({ maxHoldMs: 1000 });
    c.observe(pool(0, 30));
    for (let v = 2; v <= 60; v += 1) { c.send(change(v, "x".repeat(v))); clock.advance(150); } // 59 keystrokes, 8.85 s
    clock.advance(2000);
    const times = out.map((o) => o.t);
    expect(times[0]).toBe(1000); // the first change was held at 0 (quiet, pressured) and went at the cap
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1300); // window + cap
    expect(out.length).toBeLessThanOrEqual(8);
    const versions = out.map((o) => version(o.m));
    expect([...versions].sort((a, b) => a - b)).toEqual(versions); // in order
    expect(versions.at(-1)).toBe(60); // the newest arrives
  });

  it("a change arriving with no window open while the pool is pressured is held, not forwarded; a drained sample releases it; pressure with nothing held changes nothing", () => {
    const { clock, c, sent } = bp();
    c.observe(pool(5));
    c.send(change(2, "a"));
    expect(sent()).toEqual([]);
    clock.advance(1000); // the memory
    c.observe(pool(9));
    expect(sent()).toEqual(["v2@1000"]);
    clock.advance(300);
    c.observe(pool(5)); // pressured, nothing held
    c.send(req(1, "textDocument/hover")); // nothing held: at once
    expect(sent()).toEqual(["v2@1000", "textDocument/hover@1300"]);
    clock.advance(1000);
    c.observe(pool(9));
    expect(sent()).toHaveLength(2); // nothing to release
  });

  it("newest wins during a hold for the pool, and the superseded requests are answered ContentModified as inside the window", () => {
    const { clock, c, sent, rejected } = bp();
    c.observe(pool(1));
    c.send(change(2, "a")); // held
    c.send(req(1, "textDocument/semanticTokens/full", { textDocument: { uri: "file:///a.lean" } }));
    c.send(req(2)); // the InfoView's goal: waits, answered against the newest text
    clock.advance(100);
    c.send(change(3, "ab"));
    expect(rejected).toEqual([{ id: 1, code: -32801, t: 100 }]);
    expect(sent()).toEqual([]);
    clock.advance(900);
    c.observe(pool(10));
    expect(sent()).toEqual(["v3@1000", "$/lean/plainGoal@1000"]);
  });

  it("barriers, replays and another document's change flush a hold for the pool at once and leave no cap behind", () => {
    const ranged: Msg = { jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///a.lean", version: 4 }, contentChanges: [{ range: {}, text: "d" }] } };
    for (const [name, barrier, replay] of [
      ["didOpen", note("textDocument/didOpen", { textDocument: { uri: "file:///b.lean", version: 1, text: "" } }), false],
      ["didClose", note("textDocument/didClose", { textDocument: { uri: "file:///a.lean" } }), false],
      ["ranged", ranged, false],
      ["replay", req(0, "initialize"), true],
      ["another document", change(1, "c", "file:///b.lean"), false],
    ] as const) {
      const { clock, c, out, events } = bp({ maxHoldMs: 1000 });
      c.observe(pool(0));
      c.send(change(2, "a")); // held for the pool
      c.send(req(7));
      c.send(barrier, replay);
      // The held change and its queue went at once; a barrier follows them, another document's change is now the held one.
      expect(out.slice(0, 2).map((o) => o.m.method), name).toEqual(["textDocument/didChange", "$/lean/plainGoal"]);
      expect(out.length, name).toBe(name === "another document" ? 2 : 3);
      if (name !== "another document") expect(out[2]!.m.method, name).toBe(barrier.method);
      const after = out.length;
      clock.advance(5000);
      // No late cap: the other document's change (held in the window the flush opened, then under pressure) goes at its own cap, once.
      expect(out.length, name).toBe(name === "another document" ? after + 1 : after);
      expect(events.map((e) => e.kind), name).toEqual(name === "another document" ? ["hold", "hold", "cap"] : ["hold"]);
    }
  });

  it("an unmeasured pool (-1), no sample, a malformed sample, or minFreeWorkers 0 never holds", () => {
    for (const [name, opts, sample] of [
      ["unmeasured", {}, pool(-1, -1)],
      ["none", {}, undefined],
      ["null", {}, null],
      ["malformed", {}, { unused: "3" } as unknown as PoolSample],
      ["disabled", { minFreeWorkers: 0 }, pool(0, 30)],
    ] as const) {
      const { clock, c, sent, events } = bp(opts);
      c.observe(sample);
      c.send(change(2, "a"));
      expect(sent(), name).toEqual(["v2@0"]);
      clock.advance(10);
      c.send(change(3, "ab"));
      clock.advance(290);
      expect(sent(), name).toEqual(["v2@0", "v3@300"]);
      expect(events, name).toEqual([]);
    }
  });

  it("the threshold is the configured count of free Workers, compared on the latest sample", () => {
    const { c, sent, clock } = bp({ minFreeWorkers: 10, pressureMemoryMs: 0 });
    c.observe(pool(9));
    c.send(change(2, "a"));
    expect(sent()).toEqual([]);
    c.observe(pool(10));
    expect(sent()).toEqual(["v2@0"]); // no memory: the next drained sample releases
    clock.advance(300);
  });

  it("dispose during a hold for the pool drops the change and the queue and leaves no timer; a sample afterwards forwards nothing", () => {
    const { clock, c, out } = bp();
    c.observe(pool(0));
    c.send(change(2, "a"));
    c.send(req(1));
    c.dispose();
    expect(clock.timers).toHaveLength(0);
    c.observe(pool(20));
    clock.advance(10000);
    expect(out).toHaveLength(0);
  });

  it("a sample inside the window changes nothing before the window ends: neither an early forward nor an early hold", () => {
    const { clock, c, sent, events } = bp({ pressureMemoryMs: 0 });
    c.send(change(2, "a"));
    clock.advance(10);
    c.send(change(3, "ab")); // held in the window
    c.observe(pool(0)); // pressured: the window decides at its end
    expect(events).toEqual([]);
    clock.advance(100);
    c.observe(pool(14)); // drained before the window ends: no early forward
    expect(sent()).toEqual(["v2@0"]);
    clock.advance(190);
    expect(sent()).toEqual(["v2@0", "v3@300"]);
    expect(events).toEqual([]);
  });

  it("a window of 0 forwards every change at once whatever the pool says", () => {
    const { c, out, clock } = bp({}, 0);
    c.observe(pool(0, 30));
    c.send(change(2, "a"));
    c.send(change(3, "ab"));
    expect(out).toHaveLength(2);
    expect(clock.timers).toHaveLength(0);
  });
});

// The cap on requests in flight: each request Lean is handling is a task on
// its own dedicated thread while it waits, so ~90 released at once above an
// `IO.sleep` grew the pool 24 → 64 (HARDENING #59 addendum). At most
// `maxInFlightRequests` are at the worker unanswered; the next waits at the
// head of the queue, in order; a reply (`settle`) admits the next.
describe("createEditCoalescer: requests in flight", () => {
  const bp = (opts: { maxInFlightRequests?: number; minFreeWorkers?: number } = {}) => {
    const clock = new Clock();
    const out: Array<{ m: Msg; replay?: boolean; t: number }> = [];
    const rejected: Array<{ id: number | string | undefined; code: number; t: number }> = [];
    const events: Array<{ kind: BackPressureEvent["kind"]; queued: number; inFlight: number }> = [];
    const c = createEditCoalescer<Msg>({
      forward: (m, replay) => out.push({ m, ...(replay ? { replay } : {}), t: clock.t }),
      reject: (m, e) => rejected.push({ id: m.id, code: e.code, t: clock.t }),
      ms: 300,
      timers: clock,
      backPressure: { ...opts, onEvent: (e) => events.push({ kind: e.kind, queued: e.queued, inFlight: e.inFlight }) },
    });
    const sent = () => out.map((o) => (o.m.method === "textDocument/didChange" ? `v${(o.m.params as { textDocument: { version: number } }).textDocument.version}@${o.t}` : `${o.m.method}${o.m.id === undefined ? "" : `#${o.m.id}`}@${o.t}`));
    return { clock, out, c, sent, rejected, events };
  };
  const req = (id: number, method = "$/lean/plainGoal", params: unknown = { textDocument: { uri: "file:///a.lean" }, position: { line: 0, character: 0 } }): Msg => ({ jsonrpc: "2.0", id, method, params });
  const note = (method: string, params: unknown = {}): Msg => ({ jsonrpc: "2.0", method, params });

  it("the default cap is 6 (one keystroke's requests)", () => {
    expect(DEFAULT_MAX_IN_FLIGHT_REQUESTS).toBe(6);
  });

  it("at most maxInFlightRequests requests are at the worker unanswered; the next waits at the head of the queue with everything behind it in order, and each reply admits the next", () => {
    const { c, sent, events } = bp({ maxInFlightRequests: 2 });
    c.send(req(1));
    c.send(req(2));
    c.send(req(3)); // waits
    c.send(note("$/lean/rpc/keepAlive", { uri: "file:///a.lean", sessionId: "s" })); // behind it: nothing passes a waiting request
    c.send(req(4));
    expect(sent()).toEqual(["$/lean/plainGoal#1@0", "$/lean/plainGoal#2@0"]);
    expect(events).toEqual([{ kind: "wait", queued: 1, inFlight: 2 }, { kind: "wait", queued: 3, inFlight: 2 }]);
    c.settle(99); // not in flight: nothing
    expect(sent()).toHaveLength(2);
    c.settle(1);
    expect(sent()).toEqual(["$/lean/plainGoal#1@0", "$/lean/plainGoal#2@0", "$/lean/plainGoal#3@0", "$/lean/rpc/keepAlive@0"]); // 3 admitted, the notification behind it goes, 4 waits
    c.settle(2);
    expect(sent().at(-1)).toBe("$/lean/plainGoal#4@0");
    c.settle(3); c.settle(4);
    c.send(req(5));
    expect(sent().at(-1)).toBe("$/lean/plainGoal#5@0"); // slots free again
  });

  it("a $/cancelRequest for a queued request answers it RequestCancelled here and is not forwarded; one for a request in flight (or unknown) goes at once, even while a change is held", () => {
    const { c, sent, rejected } = bp({ maxInFlightRequests: 1 });
    c.send(req(1));
    c.send(req(2)); // waits
    c.send(note("$/cancelRequest", { id: 2 }));
    expect(rejected).toEqual([{ id: 2, code: -32800, t: 0 }]);
    expect(CANCELLED.code).toBe(-32800);
    expect(sent()).toEqual(["$/lean/plainGoal#1@0"]);
    c.send(change(2, "a")); // the window
    c.send(change(3, "ab")); // held
    c.send(note("$/cancelRequest", { id: 1 })); // in flight: at once, ahead of the held change (it waits for nothing)
    c.send(note("$/cancelRequest", { id: 77 })); // unknown here: the worker's to ignore
    expect(sent()).toEqual(["$/lean/plainGoal#1@0", "v2@0", "$/cancelRequest@0", "$/cancelRequest@0"]);
    expect(rejected).toHaveLength(1);
  });

  it("a cancel for a request queued behind a held change answers it here too (its $/cancelRequest would otherwise wait behind the change)", () => {
    const { c, sent, rejected, clock } = bp();
    c.send(change(2, "a"));
    c.send(change(3, "ab")); // held
    c.send(req(1, "textDocument/inlayHint", { textDocument: { uri: "file:///a.lean" }, range: {} }));
    c.send(req(2)); 
    c.send(note("$/cancelRequest", { id: 1 })); // Monaco cancelled its inlay hints on the next keystroke
    expect(rejected).toEqual([{ id: 1, code: -32800, t: 0 }]);
    clock.advance(300);
    expect(sent()).toEqual(["v2@0", "v3@300", "$/lean/plainGoal#2@300"]); // neither the request nor its cancel reached the worker
  });

  it("a full-text change goes ahead of requests waiting for a slot: those Monaco would rebase are answered ContentModified, the rest wait on and are answered against the newer text", () => {
    const { c, sent, rejected } = bp({ maxInFlightRequests: 1 });
    c.send(req(1)); // in flight
    c.send(req(2)); // waits
    c.send(req(3, "textDocument/semanticTokens/full", { textDocument: { uri: "file:///a.lean" } })); // waits
    c.send(req(4, "textDocument/semanticTokens/full", { textDocument: { uri: "file:///b.lean" } })); // another document's: not this change's
    c.send(change(2, "a")); // ahead of the queue, at once
    expect(sent()).toEqual(["$/lean/plainGoal#1@0", "v2@0"]);
    expect(rejected).toEqual([{ id: 3, code: -32801, t: 0 }]);
    c.settle(1);
    expect(sent().at(-1)).toBe("$/lean/plainGoal#2@0");
    c.settle(2);
    expect(sent().at(-1)).toBe("textDocument/semanticTokens/full#4@0");
    c.send(change(3, "ab")); // inside the window: held; nothing queued now is older than it
    expect(rejected).toHaveLength(1);
  });

  it("requests released with a held change count toward the cap; a barrier or a replay flushes the whole queue past it", () => {
    for (const [name, barrier, replay] of [
      ["didOpen", note("textDocument/didOpen", { textDocument: { uri: "file:///b.lean", version: 1, text: "" } }), false],
      ["replay", req(0, "initialize"), true],
    ] as const) {
      const { c, sent, clock } = bp({ maxInFlightRequests: 2 });
      c.send(change(2, "a"));
      c.send(change(3, "ab")); // held
      for (let i = 1; i <= 4; i += 1) c.send(req(i));
      clock.advance(300);
      expect(sent(), name).toEqual(["v2@0", "v3@300", "$/lean/plainGoal#1@300", "$/lean/plainGoal#2@300"]); // two admitted, two wait
      c.send(barrier, replay);
      expect(sent(), name).toHaveLength(7); // the two waiting, then the barrier
    }
  });

  it("maxInFlightRequests 0 is no cap; a replay is never counted", () => {
    const open = bp({ maxInFlightRequests: 0 });
    for (let i = 1; i <= 20; i += 1) open.c.send(req(i));
    expect(open.sent()).toHaveLength(20);
    expect(open.events).toEqual([]);
    const one = bp({ maxInFlightRequests: 1 });
    one.c.send(req(0, "initialize"), true); // the relay's replay: answered or failed by the relay, never a slot
    one.c.send(req(1));
    expect(one.sent()).toEqual(["initialize#0@0", "$/lean/plainGoal#1@0"]);
  });

  it("the pageslow stream (a change and five requests per 150 ms, replies that never come) keeps at most the cap at the worker, in order, and the newest change first", () => {
    const { c, out, clock } = bp();
    let id = 0;
    for (let v = 2; v <= 20; v += 1) {
      c.send(change(v, "x".repeat(v)));
      for (let k = 0; k < 5; k += 1) c.send(req((id += 1)));
      clock.advance(150);
    }
    clock.advance(1000);
    const requests = out.filter((o) => o.m.id !== undefined);
    expect(requests).toHaveLength(6);
    expect(requests.map((o) => o.m.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.filter((o) => o.m.method === "textDocument/didChange").at(-1)!.m.params).toMatchObject({ textDocument: { version: 20 } });
    for (let i = 1; i <= 6; i += 1) c.settle(i);
    expect(out.filter((o) => o.m.id !== undefined)).toHaveLength(12); // the next six, in order
  });

  it("dispose drops the queue; a later reply admits nothing", () => {
    const { c, out } = bp({ maxInFlightRequests: 1 });
    c.send(req(1));
    c.send(req(2));
    c.dispose();
    c.settle(1);
    expect(out).toHaveLength(1);
  });
});
