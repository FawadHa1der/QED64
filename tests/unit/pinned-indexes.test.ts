// HARDENING #64: the site-owned indexes, pinned. The mutable
// `/snapshots/index.json` and `/profiles/index.json` name the pairing uploaded
// LAST: on 2026-10-08 the upload of a new pairing replaced them while the
// deployed shell still booted the old runtime, and every new visit failed
// SNAPSHOT_UNPAIRED until the deploy. A shell built for runtime X
// (`__QED64_BUILD_ID__`) now reads the mutable index and, when it names
// another runtime, X's per-build copy (`/snapshots/index.<X>.json`,
// `/snapshots/profiles-index.<X>.json`), used when it is an index; a paired
// mutable index costs no extra request, so a site without the copies (an
// embedder's origin, a local tree) sees no 404.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSnapshotIndexFor, installArtifacts, pinnedIndexUrls, type StatusSink } from "../../lib/qed64-boot";
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

  it("a missing or HTML profile-index copy keeps the mutable index; profiles: \"none\" keeps its lenient empty index without asking for a copy", async () => {
    vi.stubGlobal("__QED64_BUILD_ID__", OLD);
    for (const answer of [notFound, html]) {
      const asked = site({ ...WINDOW, [PROF_COPY]: answer });
      const a = await installArtifacts(sink(), { overrides: "none", profiles: [], runtime, snapshots: null });
      expect(a.index.runtime.buildId).toBe(NEW);
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
