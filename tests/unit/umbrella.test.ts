// The umbrella header rewrite: one baked environment must serve every
// Mathlib import set, so Mathlib-using headers are rewritten to
// `import QED64.Essential` — position-preserving, availability-gated.

import { describe, expect, it } from "vitest";
import { UMBRELLA_MODULE, rewriteHeaderToUmbrella, shouldUseUmbrella } from "../../src/runtime/umbrella";
import { parseImports } from "../../src/install/profiles";

describe("rewriteHeaderToUmbrella", () => {
  it("replaces the first import line and comments out the rest", () => {
    const source = [
      "import Mathlib.Data.Real.Basic",
      "import Mathlib.Tactic.Linarith",
      "",
      "example (x y : ℝ) : x * y = y * x := mul_comm x y",
    ].join("\n");
    const out = rewriteHeaderToUmbrella(source).split("\n");
    expect(out[0]).toBe(`import ${UMBRELLA_MODULE}`);
    expect(out[1]).toBe("-- import Mathlib.Tactic.Linarith");
    expect(out[2]).toBe("");
    expect(out[3]).toBe("example (x y : ℝ) : x * y = y * x := mul_comm x y");
  });

  it("preserves the line count exactly (diagnostics need no remapping)", () => {
    const source = "-- leading comment\nimport Mathlib.A\n\nimport Mathlib.B\ntheorem t : True := trivial\n";
    expect(rewriteHeaderToUmbrella(source).split("\n").length).toBe(source.split("\n").length);
  });

  it("the rewritten header parses as exactly the umbrella set", () => {
    const source = "public import Mathlib.A\nmeta import Mathlib.B\nimport Mathlib.C\n#eval 1\n";
    expect(parseImports(rewriteHeaderToUmbrella(source))).toEqual([UMBRELLA_MODULE]);
  });

  it("leaves comment lines and body text untouched", () => {
    const source = "-- import Mathlib.NotReally\nimport Mathlib.X\nexample : True := trivial\n";
    const out = rewriteHeaderToUmbrella(source).split("\n");
    expect(out[0]).toBe("-- import Mathlib.NotReally");
    expect(out[2]).toBe("example : True := trivial");
  });
});

describe("shouldUseUmbrella", () => {
  const available = new Set(["Mathlib.Data.Real.Basic", "Mathlib.Tactic.Linarith", "Lean.Elab"]);

  it("activates for available Mathlib imports", () => {
    expect(shouldUseUmbrella(["Mathlib.Data.Real.Basic", "Mathlib.Tactic.Linarith"], available)).toBe(true);
  });

  it("stays off for core-only headers (exact semantics, small closures)", () => {
    expect(shouldUseUmbrella(["Lean.Elab"], available)).toBe(false);
    expect(shouldUseUmbrella([], available)).toBe(false);
  });

  it("stays off when any named import is unavailable — missing modules must error", () => {
    expect(shouldUseUmbrella(["Mathlib.Data.Real.Basic", "Mathlib.DoesNotExist"], available)).toBe(false);
  });

  it("treats aggregator/tutorial aliases as satisfied by the umbrella", () => {
    // MIL.Common (Mathematics in Lean) alongside a real Mathlib import — the
    // exact header every MIL exercise ships with.
    expect(shouldUseUmbrella(["MIL.Common", "Mathlib.Data.Real.Basic"], available)).toBe(true);
    // Whole-library aggregators dropped by the curation.
    expect(shouldUseUmbrella(["Mathlib"], available)).toBe(true);
    expect(shouldUseUmbrella(["Mathlib.Tactic"], available)).toBe(true);
    // An alias alone still counts as Mathlib intent.
    expect(shouldUseUmbrella(["MIL.Common"], available)).toBe(true);
  });

  it("aliases do not launder genuinely unknown modules", () => {
    expect(shouldUseUmbrella(["MIL.Common", "MyProject.Defs"], available)).toBe(false);
    expect(shouldUseUmbrella(["MIL.NotCommon"], available)).toBe(false);
  });
});
