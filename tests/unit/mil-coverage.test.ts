// Mathematics in Lean (docs/PROVENANCE.md; arch review 2026-10-28 D12): the real modules chapters 1-8 import stay
// served. MIL 2bf0e10 (v4.21) has 19 non-alias header imports in C01-C08; these 16 are in the curated essential set
// (Data.Real.Basic and Data.Set.Lattice as deprecated shims), the other three (Analysis.Calculus.Taylor,
// Combinatorics.Pigeonhole, Topology.Instances.Real.Lemmas) are refused. v4.35 dropped 81 essential modules: a Lean
// import that drops one of these fails here, not in a reader's tutorial. Positive only: a gap that closes never fails it.
import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { UMBRELLA_ALIASES } from "../../lib/snapshots";

const MIL_C01_C08 = [
  "Mathlib.Algebra.BigOperators.Ring.List", "Mathlib.Algebra.EuclideanDomain.Basic", "Mathlib.Algebra.Ring.Defs",
  "Mathlib.Analysis.SpecialFunctions.Log.Basic", "Mathlib.Data.Finset.Max", "Mathlib.Data.Finset.Powerset",
  "Mathlib.Data.Fintype.BigOperators", "Mathlib.Data.Nat.Factorization.Basic", "Mathlib.Data.Nat.GCD.Basic",
  "Mathlib.Data.Nat.Prime.Basic", "Mathlib.Data.Real.Basic", "Mathlib.Data.Set.Function", "Mathlib.Data.Set.Lattice",
  "Mathlib.GroupTheory.QuotientGroup.Basic", "Mathlib.RingTheory.PrincipalIdealDomain", "Mathlib.Topology.MetricSpace.Basic",
];

it("MIL chapters 1-8: MIL.Common and Mathlib.Tactic are aliases, and every other module they import is in the essential manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../public/profiles/mathlib-essential.manifest.json"), "utf8"));
  const served = new Set(Object.keys(manifest.content.modules));
  expect(UMBRELLA_ALIASES).toEqual(expect.arrayContaining(["MIL.Common", "Mathlib.Tactic"]));
  expect(MIL_C01_C08.filter((m) => !served.has(m))).toEqual([]);
});
