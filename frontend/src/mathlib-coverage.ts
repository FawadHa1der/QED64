// What `import Mathlib` serves here (UX parity M1.5, docs/HARDENING.md #89; README "Which Mathlib"). The kernel
// serves the aliases `Mathlib` and `Mathlib.Tactic` from the umbrella (lib/snapshots.ts UMBRELLA_ALIASES), a curated
// part of Mathlib, about a quarter of its modules; natively they mean all of Mathlib. A module imported by name brings
// its whole closure, so only under those two headers can an unknown name be the umbrella's gap rather than the
// visitor's. The plain page shows a note beside the pill while such an error stands (main.ts); the version tooltip
// and the README say the rest. tests/unit/mathlib-coverage.test.ts holds the lists to the tracked umbrella manifest
// and to the README. Pure: unit-tested under node.

/** Mathlib areas the umbrella has no module of. */
export const MATHLIB_NONE = ["CategoryTheory", "Probability", "FieldTheory", "AlgebraicGeometry", "AlgebraicTopology", "ModelTheory", "RepresentationTheory"] as const;
/** Mathlib areas the umbrella has almost nothing of (at most 10 modules each). */
export const MATHLIB_FEW = ["MeasureTheory", "NumberTheory", "Combinatorics"] as const;

const or = (xs: readonly string[]): string => `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;
/** The gaps as one clause: "no CategoryTheory, … or RepresentationTheory, and almost no MeasureTheory, … or Combinatorics". */
export const MATHLIB_GAPS = `no ${or(MATHLIB_NONE)}, and almost no ${or(MATHLIB_FEW)}`;

/** A header line importing a Mathlib alias (UMBRELLA_ALIASES' Mathlib entries), with the modifiers the front door's
 * IMPORT_LINE takes, a trailing comment and a CRLF line end. `[ \t]`, not `\s`: a match never spans lines. */
const ALIAS_IMPORT = /^[ \t]*(?:(?:public|private)[ \t]+)?(?:meta[ \t]+)?import[ \t]+Mathlib(?:\.Tactic)?[ \t]*(?:--.*)?\r?$/m;
/** Lean's unknown-name errors, in the 4.33+ phrasing ("Unknown identifier `x`") and the older one. */
const UNKNOWN_NAME = /^unknown (?:identifier|constant|namespace)\b/i;

/** Show the note? The document imports a Mathlib alias and Lean reports an unknown name as an error. */
export function coverageHint(text: string, diagnostics: ReadonlyArray<{ severity?: number; message: string }>): boolean {
  return ALIAS_IMPORT.test(text) && diagnostics.some((d) => d.severity === 1 && UNKNOWN_NAME.test(d.message));
}
