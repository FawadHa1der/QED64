// HARDENING #64: the site-owned indexes, pinned. The mutable
// `/snapshots/index.json` and `/profiles/index.json` name the pairing uploaded
// LAST: on 2026-10-08 the upload of a new pairing replaced them while the
// deployed shell still booted the old runtime, and every new visit failed
// SNAPSHOT_UNPAIRED until the deploy. A shell built for runtime X
// (`__QED64_BUILD_ID__`) now reads the mutable index and, when it names
// another runtime, X's per-build copy (`/snapshots/index.<X>.json`,
// `/snapshots/profiles-index.<X>.json`), used when it is an index; a paired
// mutable index costs no extra request, so a site without the copies (an
// embedder's origin, a local tree) sees no 404. The follow-up: the snapshot
// index's rule lives in loadSnapshotIndex / fetchSnapshotIndex behind
// `pairedBuildId`, for a page that reads the index itself (lean4game's game
// boot), and the shell goes through it; a copy is used only when it is
// paired with the pinned runtime.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSnapshotIndexFor, installArtifacts, pinnedIndexUrls, snapshotPairingFault, type StatusSink } from "../../lib/qed64-boot";
import { fetchSnapshotIndex, loadSnapshotIndex, pairedIndexCopyUrl } from "../../lib/snapshots";
import { NO_OVERRIDES } from "../../lib/params";
import type { RuntimeManifest } from "../../lib/client";

const ORIGIN = "http://localhost:5199";
const OLD = "wasm64-3ab1c6a9da03bc29"; // the deployed shell's runtime
const NEW = "wasm64-f69cca24d0878a58"; // the pairing uploaded ahead of its deploy

const snapshotIndex = (runtime: string | null) => ({
  schema: "qed64.snapshot-index/v1",
  snapshots: [{ name: "init", url: `/snapshots/init.${"0".repeat(16)}.snapz`, digest: `sha256:${"0".repeat(64)}`, bytes: 10, transfer: 5, imports: [], ...(runtime === null ? {} : { runtime }) }],
});
const profileIndex = (runtime: string) => ({ schema: "qed64.profile-index/v1", runtime: { buildId: runtime, leanVersion: "4.34.0" }, profiles: [] });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const html = () => new Response("<!doctype html><title>QED64</title>", { status: 200, headers: { "content-type": "text/html" } });
const notFound = () => new Response("not found", { status: 404 });

/** A site: path → answer; every fetched path recorded in order. */
function site(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
    const p = String(u);
    asked.push(p);
    const a = answers[p];
    return a ? a() : notFound();
  }));
  vi.stubGlobal("location", { search: "", origin: ORIGIN });
  return asked;
}
const SNAP_COPY = `/snapshots/index.${OLD}.json`;
const PROF_COPY = `/snapshots/profiles-index.${OLD}.json`;
/** The window of 2026-10-08: the mutable files already name NEW. */
const WINDOW = {
  "/snapshots/index.json": () => json(snapshotIndex(NEW)),
  "/profiles/index.json": () => json(profileIndex(NEW)),
};
/** Steady state: the mutable files name the shell's own runtime. */
const PAIRED = {
  "/snapshots/index.json": () => json(snapshotIndex(OLD)),
  "/profiles/index.json": () => json(profileIndex(OLD)),
};
const COPIES = {
  [SNAP_COPY]: () => json(snapshotIndex(OLD)),
  [PROF_COPY]: () => json(profileIndex(OLD)),
};
const sink = (): StatusSink => ({ busy: vi.fn(), progress: vi.fn(), idle: vi.fn() });
const runtime = { buildId: OLD } as RuntimeManifest;

afterEach(() => vi.unstubAllGlobals());

describe("the per-build index paths", () => {
  it("live under /snapshots/ (site-owned under every record), named like runtime-manifest.<buildId>.json", () => {
    expect(pinnedIndexUrls(OLD)).toEqual({ snapshots: `/snapshots/index.${OLD}.json`, profiles: `/snapshots/profiles-index.${OLD}.json` });
  });
});

describe("fetchSnapshotIndexFor", () => {
  it("in the window: the mutable index names NEW, so a shell pinned to OLD reads and uses OLD's copy", async () => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    const asked = site({ ...WINDOW, ...COPIES });
    const idx = await fetchSnapshotIndexFor(NO_OVERRIDES);
    expect(idx?.snapshots[0]?.runtime).toBe(OLD);
    expect(asked).toEqual(["/snapshots/index.json", SNAP_COPY]);
  });

  it("paired (or an index without runtime fields): the mutable index, and no request for the copy", async () => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    let asked = site({ ...PAIRED, ...COPIES });
    expect((await fetchSnapshotIndexFor(NO_OVERRIDES))?.snapshots[0]?.runtime).toBe(OLD);
    expect(asked).toEqual(["/snapshots/index.json"]);
    asked = site({ ...COPIES, "/snapshots/index.json": () => json(snapshotIndex(null)) });
    expect((await fetchSnapshotIndexFor(NO_OVERRIDES))?.snapshots[0]?.runtime).toBeUndefined();
    expect(asked).toEqual(["/snapshots/index.json"]);
  });

  it.each([
    ["a 404 (a deployment older than the copies)", notFound],
    ["an HTML answer (a dev server's SPA fallback)", html],
    ["a malformed body", () => json({ schema: "something else" })],
    ["a network error", () => { throw new TypeError("Failed to fetch"); }],
  ])("a copy that is %s: the mutable index, exactly as before", async (_label, answer) => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    const asked = site({ ...WINDOW, [SNAP_COPY]: answer });
    expect((await fetchSnapshotIndexFor(NO_OVERRIDES))?.snapshots[0]?.runtime).toBe(NEW);
    expect(asked).toEqual(["/snapshots/index.json", SNAP_COPY]);
  });

  it.each(NOT_A_PAIRED_COPY)("a copy that is %s: the mutable index (the shell uses the option's rule)", async (_label, answer) => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    const asked = site({ ...WINDOW, [SNAP_COPY]: answer });
    expect((await fetchSnapshotIndexFor(NO_OVERRIDES))?.snapshots[0]?.runtime).toBe(NEW);
    expect(asked).toEqual(["/snapshots/index.json", SNAP_COPY]);
  });

  it("a missing mutable index stays missing (no copy request); no pinned buildId, or a malformed one, never asks for a copy", async () => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    let asked = site({ ...COPIES });
    expect(await fetchSnapshotIndexFor(NO_OVERRIDES)).toBeNull();
    expect(asked).toEqual(["/snapshots/index.json"]);
    for (const pin of [undefined, "", "wasm64-XYZ", "../../evil"]) {
      vi.unstubAllGlobals();
      if (pin !== undefined) vi.stubGlobal("__QED64_BUILD_ID__", pin);
      asked = site({ ...WINDOW, ...COPIES });
      expect((await fetchSnapshotIndexFor(NO_OVERRIDES))?.snapshots[0]?.runtime, String(pin)).toBe(NEW);
      expect(asked, String(pin)).toEqual(["/snapshots/index.json"]);
    }
  });

  it("?snapshots=<dir> keeps reading its own index (overlays are unchanged)", async () => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    const asked = site({ ...COPIES, "/snapshots/widgets8/index.json": () => json(snapshotIndex(NEW)) });
    const idx = await fetchSnapshotIndexFor({ ...NO_OVERRIDES, snapshots: "snapshots/widgets8" });
    expect(idx?.snapshots[0]?.url).toBe(`/snapshots/widgets8/init.${"0".repeat(16)}.snapz`);
    expect(asked).toEqual(["/snapshots/widgets8/index.json"]);
  });
});

/** Copies that are not OLD's paired index: each keeps the mutable index. */
const NOT_A_PAIRED_COPY: [string, () => Response][] = [
  ["a 404 (a deployment older than the copies)", notFound],
  ["an HTML answer (a dev server's SPA fallback)", html],
  ["a malformed body", () => json({ schema: "something else" })],
  ["a network error", () => { throw new TypeError("Failed to fetch"); }],
  ["an index of another runtime (mispaired)", () => json(snapshotIndex(NEW))],
  ["an index mixing OLD and NEW", () => json({ ...snapshotIndex(OLD), snapshots: [...snapshotIndex(OLD).snapshots, { ...snapshotIndex(NEW).snapshots[0], name: "mathlib" }] })],
  ["an index without runtime fields", () => json(snapshotIndex(null))],
  ["an empty index", () => json({ schema: "qed64.snapshot-index/v1", snapshots: [] })],
  ["an index whose entry points off this site", () => json({ ...snapshotIndex(OLD), snapshots: [{ ...snapshotIndex(OLD).snapshots[0], url: "https://evil.example/init.snapz" }] })],
];

describe("loadSnapshotIndex / fetchSnapshotIndex: pairedBuildId (a direct caller, lean4game's game boot)", () => {
  it("the copy's path: index.<buildId>.json beside the given index, its query and fragment dropped", () => {
    expect(pairedIndexCopyUrl("/snapshots/index.json", OLD)).toBe(SNAP_COPY);
    expect(pairedIndexCopyUrl("/games/robo/index.json?from=/a/b#/c", OLD)).toBe(`/games/robo/index.${OLD}.json`);
    expect(pairedIndexCopyUrl(`${ORIGIN}/snapshots/index.json`, OLD)).toBe(`${ORIGIN}${SNAP_COPY}`);
    expect(pairedIndexCopyUrl("index.json", OLD)).toBe(`index.${OLD}.json`);
    expect(pinnedIndexUrls(OLD).snapshots).toBe(pairedIndexCopyUrl("/snapshots/index.json", OLD));
  });

  it("without the option: exactly today's requests, even in the window", async () => {
    const asked = site({ ...WINDOW, ...COPIES });
    expect((await loadSnapshotIndex()).snapshots[0]?.runtime).toBe(NEW);
    expect((await fetchSnapshotIndex())?.snapshots[0]?.runtime).toBe(NEW);
    expect((await fetchSnapshotIndex("/snapshots/index.json", {}))?.snapshots[0]?.runtime).toBe(NEW);
    expect(asked).toEqual(["/snapshots/index.json", "/snapshots/index.json", "/snapshots/index.json"]);
  });

  it("paired, or an index without runtime fields: the index, and no request for the copy", async () => {
    let asked = site({ ...PAIRED, ...COPIES });
    expect((await loadSnapshotIndex(undefined, { pairedBuildId: OLD })).snapshots[0]?.runtime).toBe(OLD);
    expect((await fetchSnapshotIndex(undefined, { pairedBuildId: OLD }))?.snapshots[0]?.runtime).toBe(OLD);
    expect(asked).toEqual(["/snapshots/index.json", "/snapshots/index.json"]);
    asked = site({ ...COPIES, "/snapshots/index.json": () => json(snapshotIndex(null)) });
    expect((await fetchSnapshotIndex(undefined, { pairedBuildId: OLD }))?.snapshots[0]?.runtime).toBeUndefined();
    expect(asked).toEqual(["/snapshots/index.json"]);
  });

  it("mispaired: the paired copy beside it is read with the same checks and used (both functions, any directory)", async () => {
    let asked = site({ ...WINDOW, ...COPIES });
    expect((await loadSnapshotIndex("/snapshots/index.json", { pairedBuildId: OLD })).snapshots[0]?.runtime).toBe(OLD);
    expect((await fetchSnapshotIndex("/snapshots/index.json", { pairedBuildId: OLD }))?.snapshots[0]?.runtime).toBe(OLD);
    expect(asked).toEqual(["/snapshots/index.json", SNAP_COPY, "/snapshots/index.json", SNAP_COPY]);
    const game = "/games/robo/index.json", gameCopy = `/games/robo/index.${OLD}.json`;
    asked = site({ [game]: () => json(snapshotIndex(NEW)), [gameCopy]: () => json(snapshotIndex(OLD)), ...COPIES });
    expect((await fetchSnapshotIndex(game, { pairedBuildId: OLD }))?.snapshots[0]?.runtime).toBe(OLD);
    expect(asked).toEqual([game, gameCopy]);
  });

  it("a mutable index that MIXES runtimes (lean4game's merge after a partial rebake) is mispaired: the paired copy is used", async () => {
    // stage-snapshots.py replaces each rebaked game's entry by name and keeps
    // the others, so one entry naming another runtime is enough to read the copy.
    const entry = (name: string, runtime: string) => ({ ...snapshotIndex(runtime).snapshots[0]!, name, url: `/snapshots/${name}.${"0".repeat(16)}.snapz` });
    const mixed = { schema: "qed64.snapshot-index/v1", snapshots: [entry("init", OLD), entry("mathlib", NEW)] };
    const pairedCopy = { schema: "qed64.snapshot-index/v1", snapshots: [entry("init", OLD), entry("mathlib", OLD)] };
    const answers = { ...COPIES, "/snapshots/index.json": () => json(mixed), [SNAP_COPY]: () => json(pairedCopy) };
    const reads: Array<[string, () => Promise<{ snapshots: Array<{ runtime?: string }> } | null>]> = [
      ["loadSnapshotIndex", () => loadSnapshotIndex(undefined, { pairedBuildId: OLD })],
      ["fetchSnapshotIndex", () => fetchSnapshotIndex(undefined, { pairedBuildId: OLD })],
      ["fetchSnapshotIndexFor", () => { vi.stubGlobal("__QED64_BUILD_ID__", OLD); return fetchSnapshotIndexFor(NO_OVERRIDES); }],
    ];
    for (const [label, read] of reads) {
      const asked = site(answers);
      const idx = await read();
      expect(asked, label).toEqual(["/snapshots/index.json", SNAP_COPY]);
      expect(idx?.snapshots.map((e) => e.runtime), label).toEqual([OLD, OLD]);
      vi.unstubAllGlobals();
    }
  });

  it("an empty mutable index names no other runtime: one request, no copy", async () => {
    const empty = { schema: "qed64.snapshot-index/v1", snapshots: [] };
    for (const read of [loadSnapshotIndex, fetchSnapshotIndex]) {
      const asked = site({ ...COPIES, "/snapshots/index.json": () => json(empty) });
      expect((await read(undefined, { pairedBuildId: OLD }))?.snapshots).toEqual([]);
      expect(asked).toEqual(["/snapshots/index.json"]);
    }
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    const asked = site({ ...COPIES, "/snapshots/index.json": () => json(empty) });
    expect((await fetchSnapshotIndexFor(NO_OVERRIDES))?.snapshots).toEqual([]);
    expect(asked).toEqual(["/snapshots/index.json"]);
  });

  it.each(NOT_A_PAIRED_COPY)("mispaired, and the copy is %s: the mutable index, which the boot then refuses as before", async (_label, answer) => {
    for (const read of [loadSnapshotIndex, fetchSnapshotIndex]) {
      const asked = site({ ...WINDOW, [SNAP_COPY]: answer });
      const idx = await read("/snapshots/index.json", { pairedBuildId: OLD });
      expect(idx?.snapshots[0]?.runtime).toBe(NEW);
      expect(asked).toEqual(["/snapshots/index.json", SNAP_COPY]);
      // today's refusal (HARDENING #62): the entry is unpaired with the runtime this page boots
      expect(snapshotPairingFault(idx!.snapshots[0]!, "init", { buildId: OLD })).toMatchObject({ kind: "unpaired", code: "SNAPSHOT_UNPAIRED" });
    }
  });

  it("a missing mutable index stays missing (no copy request); a pairedBuildId that is not a buildId reads no copy", async () => {
    let asked = site({ ...COPIES });
    await expect(loadSnapshotIndex(undefined, { pairedBuildId: OLD })).rejects.toMatchObject({ indexFault: "missing" });
    expect(await fetchSnapshotIndex(undefined, { pairedBuildId: OLD })).toBeNull();
    expect(asked).toEqual(["/snapshots/index.json", "/snapshots/index.json"]);
    for (const pin of ["", "wasm64-XYZ", "../../evil", OLD.toUpperCase(), `${OLD}0`, ` ${OLD}`]) {
      asked = site({ ...WINDOW, ...COPIES, [`/snapshots/index.${pin}.json`]: () => json(snapshotIndex(OLD)) });
      expect((await fetchSnapshotIndex(undefined, { pairedBuildId: pin }))?.snapshots[0]?.runtime, pin).toBe(NEW);
      expect(asked, pin).toEqual(["/snapshots/index.json"]);
    }
  });
});

describe("installArtifacts: both indexes", () => {
  it("in the window, a shell pinned to OLD boots OLD's profile index and snapshot index", async () => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    const asked = site({ ...WINDOW, ...COPIES });
    const a = await installArtifacts(sink(), { overrides: "none", profiles: [], runtime });
    expect(a.index.runtime.buildId).toBe(OLD);
    expect(a.snapshots?.snapshots[0]?.runtime).toBe(OLD);
    expect(asked).toEqual(["/profiles/index.json", PROF_COPY, "/snapshots/index.json", SNAP_COPY]);
  });

  it("paired: one request per index, as before", async () => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    const asked = site({ ...PAIRED, ...COPIES });
    const a = await installArtifacts(sink(), { overrides: "none", profiles: [], runtime });
    expect([a.index.runtime.buildId, a.snapshots?.snapshots[0]?.runtime]).toEqual([OLD, OLD]);
    expect(asked).toEqual(["/profiles/index.json", "/snapshots/index.json"]);
  });

  it("a missing, HTML or mispaired profile-index copy keeps the mutable index; profiles: \"none\" keeps its lenient empty index without asking for a copy", async () => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    for (const answer of [notFound, html]) {
      const asked = site({ ...WINDOW, [PROF_COPY]: answer });
      const a = await installArtifacts(sink(), { overrides: "none", profiles: [], runtime, snapshots: null });
      expect(a.index.runtime.buildId).toBe(NEW);
      expect(asked).toEqual(["/profiles/index.json", PROF_COPY]);
    }
    for (const answer of [() => json(profileIndex(NEW)), () => json({ schema: "qed64.profile-index/v1", profiles: [] })]) {
      const asked = site({ ...WINDOW, [PROF_COPY]: answer }); // a copy of another runtime's pairing, or of none
      const a = await installArtifacts(sink(), { overrides: "none", profiles: [], runtime, snapshots: null });
      expect(a.index.runtime?.buildId).toBe(NEW);
      expect(asked).toEqual(["/profiles/index.json", PROF_COPY]);
    }
    const asked = site({ ...COPIES });
    const none = await installArtifacts(sink(), { overrides: "none", profiles: "none", runtime, snapshots: null });
    expect(none.index.profiles).toEqual([]);
    expect(asked).toEqual(["/profiles/index.json"]);
  });

  it("?profiles=<dir> keeps its own index; no pin keeps the mutable one", async () => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    let asked = site({ ...COPIES, "/profiles-staged/index.json": () => json(profileIndex(NEW)) });
    const staged = await installArtifacts(sink(), { overrides: { profiles: "profiles-staged" }, profiles: [], runtime, snapshots: null });
    expect(staged.index.runtime.buildId).toBe(NEW);
    expect(asked).toEqual(["/profiles-staged/index.json"]);
    vi.unstubAllGlobals();
    asked = site({ ...WINDOW, ...COPIES });
    const unpinned = await installArtifacts(sink(), { overrides: "none", profiles: [], runtime, snapshots: null });
    expect(unpinned.index.runtime.buildId).toBe(NEW);
    expect(asked).toEqual(["/profiles/index.json"]);
  });
});
