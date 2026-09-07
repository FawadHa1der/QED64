import { describe, expect, it } from "vitest";
import { snapshotCacheKey } from "../../src/runtime/snapshots";

describe("snapshotCacheKey", () => {
  const digest = "sha256:61a520c98f37eda0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  it("identifies a bake by its content digest when the index carries one", () => {
    expect(snapshotCacheKey({ name: "mathlib", url: "x", digest, bytes: 2755235045, transfer: 844806690, imports: ["QED64.Essential"] }))
      .toBe("mathlib.61a520c98f37eda0.snapz");
  });
  it("distinguishes runtimes whose bakes have IDENTICAL sizes", () => {
    // The live incident: a rebuilt runtime produces the same raw region size
    // (same env content, different relocation values) — sizes cannot tell
    // the bakes apart, only the digest can.
    const other = "sha256:0000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const a = snapshotCacheKey({ name: "mathlib", url: "x", digest, bytes: 2755235045, transfer: 844806690, imports: [] });
    const b = snapshotCacheKey({ name: "mathlib", url: "x", digest: other, bytes: 2755235045, transfer: 844806690, imports: [] });
    expect(a).not.toBe(b);
  });
  it("falls back to name + sizes for digestless indexes, with a storage-safe name", () => {
    expect(snapshotCacheKey({ name: "mathlib", url: "/snapshots/mathlib.snapz", bytes: 2755235045, transfer: 844808328, imports: ["QED64.Essential"] }))
      .toBe("mathlib.2755235045.844808328.snapz");
    expect(snapshotCacheKey({ name: "odd/name", url: "x", bytes: 1, imports: [] })).toBe("odd_name.1.0.snapz");
    expect(snapshotCacheKey({ name: "odd/name", url: "x", digest: "sha256:tooshort", bytes: 1, imports: [] })).toBe("odd_name.1.0.snapz");
  });
  it("changes when a re-bake changes the region size", () => {
    const a = snapshotCacheKey({ name: "init", url: "x", bytes: 342124365, transfer: 107411334, imports: [] });
    const b = snapshotCacheKey({ name: "init", url: "x", bytes: 342124366, transfer: 107411334, imports: [] });
    expect(a).not.toBe(b);
  });
});
