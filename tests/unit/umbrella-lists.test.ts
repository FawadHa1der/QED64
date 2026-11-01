// The umbrella's lists, one copy each in lib/snapshots.ts (arch review 2026-10-28 R1, R9a; HARDENING #82).
// The roots the light-boot policy and a rootless `mathlib` entry claim; the kernel's four aliases (below, with the
// copies that cannot import lib: the compiler battery here, the front door in tests/unit/front-door.test.ts; the
// kernel's own copy, patch 0032 `aliasOk`, is frozen by the kernel's K3 and unreachable from a test).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LEGACY_UMBRELLA_ROOTS } from "../../lib/snapshots";
import { isUmbrellaModule } from "../../lib/resident-session";

const root = path.resolve(__dirname, "../..");
const essential = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, "public/profiles/mathlib-essential.manifest.json"), "utf8")).content.modules));
const ALIAS_ROOTS = ["Mathlib", "Batteries", "MIL", "QED64"]; // the aliases' roots and the umbrella module: no module of that exact name is served

describe("umbrella roots (lib/snapshots.ts LEGACY_UMBRELLA_ROOTS)", () => {
  it("are the aliases' roots, the umbrella's own, and the packages whose root module the umbrella holds", () => {
    expect([...LEGACY_UMBRELLA_ROOTS]).toEqual(["Mathlib", "Batteries", "MIL", "QED64", "Lean", "Std", "Aesop", "Qq", "Plausible", "LeanSearchClient"]);
  });
  it("every package root names a module of the tracked essential manifest (a Lean import that drops one fails here)", () => {
    for (const r of LEGACY_UMBRELLA_ROOTS.filter((r) => !ALIAS_ROOTS.includes(r))) expect(essential.has(r), r).toBe(true);
  });
  it("isUmbrellaModule reads the same list, on a component boundary", () => {
    for (const r of LEGACY_UMBRELLA_ROOTS) {
      expect(isUmbrellaModule(r), r).toBe(true);
      expect(isUmbrellaModule(`${r}.X`), r).toBe(true);
      expect(isUmbrellaModule(`${r}2`), r).toBe(false);
    }
  });
});
