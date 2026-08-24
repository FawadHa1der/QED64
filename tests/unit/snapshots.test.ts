import { describe, expect, it, test } from "vitest";
import { matchSnapshot, type SnapshotIndex, snapshotCacheKey } from "../../src/runtime/snapshots";

const index: SnapshotIndex = {
  schema: "qed64.snapshot-index/v1",
  snapshots: [
    { name: "init", url: "/snapshots/init.snap", bytes: 342_124_365, imports: [] },
    {
      name: "mathlib-groups",
      url: "/snapshots/mathlib-groups.snap",
      bytes: 2_000_000_000,
      imports: ["Mathlib.Algebra.Group.Basic"],
    },
    {
      name: "two-imports",
      url: "/snapshots/two.snap",
      bytes: 1,
      imports: ["Mathlib.Tactic", "Mathlib.Data.Real.Basic"],
    },
  ],
};

describe("matchSnapshot", () => {
  test("empty imports match the boot snapshot", () => {
    expect(matchSnapshot(index, [])!.name).toBe("init");
  });
  test("single import matches exactly", () => {
    expect(matchSnapshot(index, ["Mathlib.Algebra.Group.Basic"])!.name).toBe("mathlib-groups");
  });
  test("order matters (runtime cache is keyed by the ordered list)", () => {
    expect(matchSnapshot(index, ["Mathlib.Tactic", "Mathlib.Data.Real.Basic"])!.name).toBe("two-imports");
    expect(matchSnapshot(index, ["Mathlib.Data.Real.Basic", "Mathlib.Tactic"])).toBeNull();
  });
  test("subsets and supersets do not match", () => {
    expect(matchSnapshot(index, ["Mathlib.Tactic"])).toBeNull();
    expect(matchSnapshot(index, ["Mathlib.Algebra.Group.Basic", "Mathlib.Tactic"])).toBeNull();
  });
  test("null index matches nothing", () => {
    expect(matchSnapshot(null, [])).toBeNull();
  });
});


describe("snapshotCacheKey", () => {
  it("identifies a bake by name and both sizes, with a storage-safe name", () => {
    expect(snapshotCacheKey({ name: "mathlib", url: "/snapshots/mathlib.snapz", bytes: 2755235045, transfer: 844808328, imports: ["QED64.Essential"] }))
      .toBe("mathlib.2755235045.844808328.snapz");
    expect(snapshotCacheKey({ name: "odd/name", url: "x", bytes: 1, imports: [] })).toBe("odd_name.1.0.snapz");
  });
  it("changes when a re-bake changes the region size", () => {
    const a = snapshotCacheKey({ name: "init", url: "x", bytes: 342124365, transfer: 107411334, imports: [] });
    const b = snapshotCacheKey({ name: "init", url: "x", bytes: 342124366, transfer: 107411334, imports: [] });
    expect(a).not.toBe(b);
  });
});
