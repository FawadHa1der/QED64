import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSnapshotIndex, loadSnapshotIndex, snapshotCacheKey } from "../../lib/snapshots";

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

describe("loadSnapshotIndex names what is wrong (docs/EMBEDDING.md §4: an overlay is never a silent null)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (status: number, body: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
  const good = { schema: "qed64.snapshot-index/v1", snapshots: [{ name: "init", url: "/snapshots/init.x.snapz", bytes: 1, imports: [] }] };
  it.each([
    [404, "not found", /HTTP 404/, "missing"],
    [503, "busy", /HTTP 503/, "network"],
    [200, "<!doctype html>", /answered HTML/, "missing"],
    [200, "{not json", /not JSON/, "corrupt"],
    [200, JSON.stringify({ schema: "other", snapshots: [] }), /not a qed64.snapshot-index\/v1 index/, "corrupt"],
    [200, JSON.stringify({ ...good, snapshots: [{ name: "x", url: 3, imports: [] }] }), /malformed entry "x"/, "corrupt"],
  ] as const)("HTTP %i %s", async (status, body, message, fault) => {
    serve(status, body);
    await expect(loadSnapshotIndex("/snapshots-x/index.json")).rejects.toMatchObject({ message: expect.stringMatching(message), indexFault: fault });
    serve(status, body);
    await expect(fetchSnapshotIndex("/snapshots-x/index.json")).resolves.toBeNull(); // the lenient form keeps its contract
  });
  it("a good index loads", async () => {
    serve(200, JSON.stringify(good));
    await expect(loadSnapshotIndex()).resolves.toEqual(good);
  });
});
