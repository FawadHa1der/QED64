// Position mapping from Lean 1-based line/column diagnostics into CodeMirror
// offsets, including clamping at document edges.

import { describe, expect, test } from "vitest";
import { EditorState } from "@codemirror/state";
import { toCmDiagnostics } from "../../src/editor/setup";
import type { Diagnostic } from "../../src/runtime/client";

const doc = "import Mathlib\n\ntheorem t : True := by\n  trivial\n";
const state = EditorState.create({ doc });

const d = (over: Partial<Diagnostic>): Diagnostic => ({
  fileName: "input.lean",
  line: 1,
  column: 0,
  severity: "error",
  message: "m",
  ...over,
});

describe("toCmDiagnostics", () => {
  test("maps line/column to offsets", () => {
    const [cm] = toCmDiagnostics(state, [d({ line: 3, column: 8 })]);
    const line3 = state.doc.line(3);
    expect(cm!.from).toBe(line3.from + 8);
    expect(cm!.to).toBeGreaterThan(cm!.from);
    expect(cm!.severity).toBe("error");
  });

  test("uses explicit end positions when present", () => {
    const [cm] = toCmDiagnostics(state, [d({ line: 1, column: 0, endLine: 1, endColumn: 6 })]);
    expect(cm!.from).toBe(0);
    expect(cm!.to).toBe(6);
  });

  test("clamps out-of-range lines and columns", () => {
    const [beyond] = toCmDiagnostics(state, [d({ line: 999, column: 500 })]);
    expect(beyond!.to).toBeLessThanOrEqual(doc.length);
    expect(beyond!.from).toBeLessThanOrEqual(beyond!.to);
    const [zero] = toCmDiagnostics(state, [d({ line: 0 })]);
    expect(zero).toBeUndefined(); // line < 1 is dropped
  });

  test("information maps to info", () => {
    const [cm] = toCmDiagnostics(state, [d({ severity: "information" })]);
    expect(cm!.severity).toBe("info");
  });
});
