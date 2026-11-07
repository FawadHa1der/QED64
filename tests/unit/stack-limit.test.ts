// lib/stack-limit.ts (HARDENING #92, docs/EMBEDDING.md §7.10): the classifier of Lean's engine-stack guard errors and
// the note it appends, on Lean's own message texts (tests/fixtures/stack-limit-messages.json: publishes captured from
// runs, Lean's own encoding of the same messages as an InfoView RPC reply and as a publish, and, where an entry's
// `source` says so, a text reconstructed from Lean's source). The guard error stays an error with Lean's words first;
// Lean's limits that desktop Lean has too are never taken for it.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GUARD_PHRASES, STACK_LIMIT_NOTE, annotateStackLimit, isStackLimitDiagnostic, type StackLimitDiagnostic } from "../../lib/stack-limit";
import * as embed from "../../lib/index";

const root = path.resolve(__dirname, "../..");
type Fixture = {
  published: { id: string; guard: boolean; text: string; source: string }[];
  wire: { name: string; guard: boolean; rpc: unknown; pub: string }[];
  captured: { source: string; publish: StackLimitDiagnostic[]; rpcReply: StackLimitDiagnostic[] };
};
const fx = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/stack-limit-messages.json"), "utf8")) as Fixture;
const text = (id: string) => fx.published.find((p) => p.id === id)!.text;
const wire = (name: string) => fx.wire.find((w) => w.name === name)!;
const err = (message: unknown, extra: Partial<StackLimitDiagnostic> & Record<string, unknown> = {}) =>
  ({ range: { start: { line: 3, character: 66 }, end: { line: 3, character: 72 } }, severity: 1, message, ...extra });
const SUFFIX = `\n\n${STACK_LIMIT_NOTE}`;
const P1 = text("P1");

describe("the fixture", () => {
  it("holds the guard's two phrases, Lean's native limits, and Lean's own wire encoding of each shape", () => {
    expect(fx.published.filter((p) => p.guard).map((p) => p.id)).toEqual(["P1", "P2", "P3", "decide-kernel"]);
    expect(fx.published.filter((p) => !p.guard).map((p) => p.id)).toEqual(["P3-cut", "N1", "N2", "N3", "N4", "N6"]);
    expect(fx.wire.map((w) => [w.name, w.guard])).toEqual([["E", true], ["E-synth", true], ["K", true], ["E-simp", true], ["decide-kernel", true], ["N1", false], ["N2-simp", false], ["N4", false]]);
    // The wire's publish strings are the captured ones: the probe encodes the same messages the runs logged.
    expect(wire("E").pub).toBe(P1);
    expect(wire("K").pub).toBe(text("P2"));
    expect(wire("N1").pub).toBe(text("N1"));
    expect(wire("E-simp").pub).toBe(`Tactic \`simp\` failed with a nested error:\n${P1}`);
    // decide's report of a kernel failure is not captured from a run: the probe renders Decide.lean's own m! around P2.
    expect(text("decide-kernel")).toBe(wire("decide-kernel").pub);
    expect(text("decide-kernel")).toBe(`Tactic \`decide\` failed. The elaborator is able to reduce the \`Decidable\` instance, but the kernel fails with:\n\n  ${text("P2")}`);
    // Lean puts an interactive message's words in `expr` embeds (tag[0]), never in tag[1]: a walker of text/append/tag[1]
    // would read nothing of the guard's error, which is why the classifier reads the JSON.
    expect(wire("E").rpc).toEqual({ tag: [{ expr: { text: P1 } }, { text: "" }] });
  });
});

describe("the wasm runtime's own messages (captured in the browser)", () => {
  it("are the shapes the fixture's Lean probe encodes, and classify as such", () => {
    const { publish, rpcReply } = fx.captured;
    expect(publish.map((d) => d.message)).toEqual([text("N1"), P1]);
    expect(rpcReply).toHaveLength(1);
    expect(rpcReply[0]!.message).toEqual(wire("E").rpc);
    expect(publish.filter(isStackLimitDiagnostic)).toEqual([publish[1]]);
    expect(rpcReply.filter(isStackLimitDiagnostic)).toEqual(rpcReply);
    expect(annotateStackLimit(rpcReply)[0]!.message).toEqual({ append: [wire("E").rpc, { text: SUFFIX }] });
  });
});

describe("isStackLimitDiagnostic", () => {
  it("recognises the guard's error, alone or nested, as a published string", () => {
    for (const p of fx.published) expect(isStackLimitDiagnostic(err(p.text)), `${p.id} (${p.source})`).toBe(p.guard);
  });

  it("classifies Lean's InfoView reply exactly as its publish: the editor and the InfoView agree", () => {
    for (const w of fx.wire) {
      expect(isStackLimitDiagnostic(err(w.rpc)), `${w.name} rpc`).toBe(w.guard);
      expect(isStackLimitDiagnostic(err(w.pub)), `${w.name} pub`).toBe(w.guard);
    }
  });

  it("does not take Lean's native maxRecDepth for it, though both start with the same words and carry the same tag", () => {
    expect(text("N1").startsWith("maximum recursion depth has been reached")).toBe(true);
    expect(P1.startsWith("maximum recursion depth has been reached")).toBe(true);
    expect(isStackLimitDiagnostic(err(text("N1")))).toBe(false);
    expect(isStackLimitDiagnostic(err(text("N2")))).toBe(false);
  });

  it("counts only errors the editor shows: not a warning, an info (a visitor's #eval printing the words) or isSilent", () => {
    expect(isStackLimitDiagnostic(err(P1, { severity: 2 }))).toBe(false);
    expect(isStackLimitDiagnostic(err(P1, { severity: 3 }))).toBe(false);
    expect(isStackLimitDiagnostic(err(P1, { severity: undefined }))).toBe(false);
    expect(isStackLimitDiagnostic(err(P1, { isSilent: true }))).toBe(false);
    expect(isStackLimitDiagnostic(err(P1, { isSilent: false }))).toBe(true);
  });

  it("is never fooled by QED64's own note (the relay's pause note: stack-limit-notes.test.ts, on the real relay)", () => {
    expect(isStackLimitDiagnostic(err(STACK_LIMIT_NOTE))).toBe(false);
    for (const p of GUARD_PHRASES) expect(STACK_LIMIT_NOTE).not.toContain(p);
    // An annotated error is still the guard's.
    expect(isStackLimitDiagnostic(err(P1 + SUFFIX))).toBe(true);
  });

  it("the phrases and the note hold no character JSON escapes, so the JSON reading finds them whole", () => {
    for (const s of [STACK_LIMIT_NOTE, ...GUARD_PHRASES]) {
      expect(JSON.stringify(s)).toBe(`"${s}"`);
    }
  });

  it("reads anything malformed as not the guard's", () => {
    for (const message of [null, undefined, 42, {}, { foo: 1 }, []]) expect(isStackLimitDiagnostic(err(message))).toBe(false);
    expect(isStackLimitDiagnostic(null as unknown as StackLimitDiagnostic)).toBe(false);
  });
});

describe("annotateStackLimit", () => {
  it("appends the note to the guard's errors only, Lean's words first, every other field and entry unchanged", () => {
    const unsolved = err("unsolved goals\n⊢ False");
    const info = err(P1, { severity: 3 });
    const guard = err(P1, { fullRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 72 } }, source: "Lean 4", code: "x", leanTags: [1] });
    const native = err(text("N1"));
    const input = [native, guard, unsolved, info];
    const frozen = structuredClone(input);
    const out = annotateStackLimit(input);
    expect(input).toEqual(frozen); // never mutates
    expect(out).not.toBe(input);
    expect(out[1]).toEqual({ ...guard, message: P1 + SUFFIX });
    expect(out[1]!.severity).toBe(1); // the verdict stays "error"
    expect(out[0]).toBe(native);
    expect(out[2]).toBe(unsolved);
    expect(out[3]).toBe(info);
  });

  it("annotates every guard shape the fixture has, string and wire alike", () => {
    for (const p of fx.published.filter((x) => x.guard)) expect(annotateStackLimit([err(p.text)])[0]!.message, p.id).toBe(p.text + SUFFIX);
    for (const w of fx.wire) {
      const [out] = annotateStackLimit([err(w.rpc)]);
      if (!w.guard) { expect(out!.message, w.name).toBe(w.rpc); continue; }
      const m = out!.message as { append: unknown[] };
      expect(m.append.at(-1), w.name).toEqual({ text: SUFFIX });
    }
  });

  it("a TaggedText gains one {text} node: at the end of its append, or in a new append around it", () => {
    const tag = wire("E").rpc as object;
    expect(annotateStackLimit([err(tag)])[0]!.message).toEqual({ append: [tag, { text: SUFFIX }] });
    expect(annotateStackLimit([err({ text: P1 })])[0]!.message).toEqual({ append: [{ text: P1 }, { text: SUFFIX }] });
    const synth = wire("E-synth").rpc as { append: unknown[] };
    const out = annotateStackLimit([err(synth)])[0]!.message as { append: unknown[] };
    expect(out.append).toEqual([...synth.append, { text: SUFFIX }]); // not nested: Lean's TaggedText has no append directly in an append
    expect(synth.append.at(-1)).not.toEqual({ text: SUFFIX }); // the input's array is untouched
  });

  it("returns its input when nothing needs the note, and is idempotent", () => {
    const none = fx.published.filter((p) => !p.guard).map((p) => err(p.text));
    expect(annotateStackLimit(none)).toBe(none);
    expect(annotateStackLimit([])).toEqual([]);
    for (const message of [P1, wire("E").rpc, wire("E-synth").rpc, wire("K").rpc]) {
      const once = annotateStackLimit([err(message)]);
      expect(annotateStackLimit(once)).toBe(once);
    }
  });
});

describe("the qed64/embed barrel", () => {
  it("exports the three helpers (EMBEDDING §7.10)", () => {
    expect(embed.STACK_LIMIT_NOTE).toBe(STACK_LIMIT_NOTE);
    expect(embed.isStackLimitDiagnostic).toBe(isStackLimitDiagnostic);
    expect(embed.annotateStackLimit).toBe(annotateStackLimit);
  });
});
