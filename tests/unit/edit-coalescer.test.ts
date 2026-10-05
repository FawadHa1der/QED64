// Full-text edit coalescing (frontend/src/embed/edit-coalescer.ts; docs/EMBEDDING.md
// §7.8, HARDENING #59): a burst of full-text didChanges reaches the worker at
// most once per window, the newest last; anything else flushes a held change
// first, so Lean never answers about text it has not been sent.
import { describe, expect, it } from "vitest";
import { createEditCoalescer, isFullTextChange } from "../../frontend/src/embed/edit-coalescer";

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
  const c = createEditCoalescer<Msg>((m, replay) => out.push({ m, ...(replay ? { replay } : {}), t: clock.t }), ms, clock);
  const sent = () => out.map((o) => (o.m.method === "textDocument/didChange" ? `v${(o.m.params as { textDocument: { version: number } }).textDocument.version}@${o.t}` : `${o.m.method}@${o.t}`));
  return { clock, out, c, sent };
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

  it("any other frame forwards the held change first, then itself", () => {
    const { clock, c, sent } = setup();
    c.send(change(2, "a"));
    clock.advance(50);
    c.send(change(3, "ab"));
    c.send({ jsonrpc: "2.0", id: 7, method: "$/lean/plainGoal", params: {} });
    expect(sent()).toEqual(["v2@0", "v3@50", "$/lean/plainGoal@50"]);
    c.send(change(4, "abc")); // the window is still open: held
    c.send({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///a.lean", version: 5 }, contentChanges: [{ range: {}, text: "d" }] } }); // ranged: never held, never reordered
    expect(sent()).toEqual(["v2@0", "v3@50", "$/lean/plainGoal@50", "v4@50", "v5@50"]);
    clock.advance(300);
    expect(sent()).toHaveLength(5);
  });

  it("a replay is forwarded as a replay, after a held change; a replayed didChange is never held", () => {
    const { clock, c, out } = setup();
    c.send(change(2, "a"));
    c.send(change(3, "ab"));
    c.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, true);
    c.send(change(4, "abc"), true);
    expect(out.map((o) => [o.m.method, o.replay ?? false])).toEqual([
      ["textDocument/didChange", false], ["textDocument/didChange", false], ["initialize", true], ["textDocument/didChange", true],
    ]);
    clock.advance(300);
    expect(out).toHaveLength(4);
  });

  it("never merges changes of different documents", () => {
    const { c, sent } = setup();
    c.send(change(2, "a", "file:///a.lean"));
    c.send(change(3, "b", "file:///a.lean"));
    c.send(change(1, "c", "file:///b.lean"));
    expect(sent()).toEqual(["v2@0", "v3@0"]); // a's held change went before b's was held
  });

  it("dispose drops the held change and stops the window; later sends are ignored", () => {
    const { clock, c, out } = setup();
    c.send(change(2, "a"));
    c.send(change(3, "ab"));
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
