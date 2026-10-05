// Full-text edit coalescing (frontend/src/embed/edit-coalescer.ts; docs/EMBEDDING.md
// §7.8, HARDENING #59): a burst of full-text didChanges reaches the worker at
// most once per window, the newest last; while a change is held every other
// frame waits behind it in order (a client's per-keystroke requests must not
// defeat the coalescing), except the frames that change the document set or
// edit it partially, which flush it first; a semantic-tokens request queued
// behind a change that a newer change replaces is answered ContentModified,
// as Lean would (the one reply Monaco rebases by its later edits).
import { describe, expect, it } from "vitest";
import { SUPERSEDED, SUPERSEDED_METHODS, createEditCoalescer, isFullTextChange } from "../../frontend/src/embed/edit-coalescer";

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: unknown };
class Clock {
  t = 0;
  timers: Array<{ at: number; f: () => void; id: number }> = [];
  seq = 0;
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

  it("while a change is held, requests and notifications wait behind it in order (lean4monaco's change + requests per keystroke); the ones a newer change supersedes are answered ContentModified", () => {
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
    c.send(note("$/cancelRequest", { id: 103 }));
    expect(sent()).toEqual(["v2@0"]); // everything since waits for the window
    // Each keystroke's change replaced the held one: the semantic-tokens requests made against the replaced text were
    // answered at that moment; the InfoView's calls wait and are answered against the newest text (the client's view by then).
    expect(rejected.map((r) => `${r.id}@${r.t}`)).toEqual(["3@20", "4@30", "5@40"]);
    clock.advance(300);
    expect(sent()).toEqual([
      "v2@0", "v6@300", // the newest change, then the queue in arrival order
      "$/lean/rpc/call@300", "$/lean/rpc/connect@300", "$/lean/rpc/call@300", "$/lean/rpc/connect@300", "$/lean/rpc/call@300", "$/lean/rpc/connect@300",
      "textDocument/semanticTokens/full@300", "$/lean/rpc/call@300", "$/lean/rpc/connect@300",
      "$/cancelRequest@300",
    ]);
    clock.advance(1000);
    expect(sent()).toHaveLength(12); // the window closed with nothing held
    expect(rejected).toHaveLength(3);
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
