// The parser-coverage lint must flag text Lean silently skips, and must stay
// quiet on every legitimate shape in the bundled examples and common Lean.

import { describe, expect, test } from "vitest";
import { parseCoverageLints } from "../../src/editor/coverage";
import { EXAMPLES } from "../../src/examples";

const flag = (source: string) => parseCoverageLints(source).map((d) => d.line);

describe("flags parser-skipped text", () => {
  test("random letters", () => {
    expect(flag("jdfvhdjsgfj\n")).toEqual([1]);
    expect(flag("#eval 1\n\nasdf garbage qwerty !!\n")).toEqual([3]);
    expect(flag("dhsjkfhsjk\n#eval 2\nmore junk\n")).toEqual([1, 3]);
  });
  test("numbers or symbols at top level", () => {
    expect(flag("42\n")).toEqual([1]);
    expect(flag("= nonsense\n")).toEqual([1]);
  });
});

describe("stays quiet on legitimate Lean", () => {
  test("every bundled example is clean", () => {
    for (const example of EXAMPLES) {
      expect(flag(example.source), example.id).toEqual([]);
    }
  });
  test("declarations, modifiers, hash commands", () => {
    const source = [
      "import Mathlib.Data.Real.Basic",
      "open Nat in",
      "private def x := 1",
      "@[simp] theorem t : x = x := rfl",
      "#check t",
      "set_option maxHeartbeats 400000",
      "noncomputable def y : Nat := 2",
    ].join("\n");
    expect(flag(source)).toEqual([]);
  });
  test("macro_rules with column-0 alternatives", () => {
    expect(flag("macro_rules\n| `(tactic| foo) => `(tactic| rfl)\n")).toEqual([]);
  });
  test("indented continuations are never flagged", () => {
    expect(flag("def f : Nat :=\n  let a := 1\n  a + 1\n")).toEqual([]);
  });
  test("block comments spanning lines", () => {
    expect(flag("/- free text\nno commands here\nstill comment -/\n#eval 1\n")).toEqual([]);
  });
  test("multiline strings at column 0", () => {
    expect(flag('#eval "hello\nworld"\n')).toEqual([]);
  });
  test("unclosed brackets make the next line a continuation", () => {
    expect(flag("#eval (1 +\n2)\n")).toEqual([]);
    expect(flag("#eval [1,\n2, 3]\n")).toEqual([]);
  });
  test("guillemet identifiers and doc comments", () => {
    expect(flag("/-- docs -/\ndef «weird name» := 3\n")).toEqual([]);
  });
  test("where clauses at column 0", () => {
    expect(flag("def g := h\nwhere h := 4\n")).toEqual([]);
  });
});
