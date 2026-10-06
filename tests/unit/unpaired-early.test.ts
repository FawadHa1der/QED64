// An unpaired snapshot is refused by the page before anything is fetched
// (HARDENING #62). The worker's SNAPSHOT_UNPAIRED refusal came only after the
// session had booted the 2 GiB runtime and the raw prefetch had downloaded
// and inflated the whole region, and the relay's three bootFailed retries
// paid both three times. The page knows both facts beforehand: the index
// entry's `runtime` and the runtime manifest's `buildId`.
//
// Over a fake Worker, a spied LeanSession and a spied raw-cache prefetch (the
// fetch/cache path): no wasm, no browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../frontend/src/embed/raw-cache", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../frontend/src/embed/raw-cache")>();
  return { ...real, prefetchRaw: vi.fn(async () => ({ status: "done", bytes: 100 })) };
});

import { prefetchRaw } from "../../frontend/src/embed/raw-cache";
import { loadSnapshotByName, snapshotPairingFault, type ProgressInfo, type Qed64Artifacts, type Qed64Session, type StatusSink } from "../../frontend/src/qed64-boot";
import { ResidentSession, type ResidentHost } from "../../frontend/src/resident-session";
import { LspRelay, type RestartOptions } from "../../frontend/src/lsp-relay";
import { deathInfo } from "../../frontend/src/page-api";
import type { RuntimeManifest } from "../../src/runtime/client";

const BOOTED = "wasm64-3ab1c6a9da03bc29";
const OTHER = "wasm64-0000000000000000";
const runtime = { buildId: BOOTED, leanVersion: "4.34.0", files: { "lean.js": { bytes: 0, sha256: "", chunks: [] }, "lean.wasm": { bytes: 0, sha256: "", chunks: [] } } } as RuntimeManifest;
/** An index entry; `baked` undefined = no `runtime` field (an index that predates it). */
const snap = (name: string, baked: string | undefined) => ({ name, url: `/snapshots/${name}.x.snapz`, bytes: 100, transfer: 50, digest: `sha256:${"cd".repeat(32)}`, imports: [], ...(baked === undefined ? {} : { runtime: baked }) });
const artifacts = (init: string | undefined, mathlib: string | undefined): Qed64Artifacts => ({
  runtime,
  index: { schema: "qed64.profile-index/v1", profiles: [] } as unknown as Qed64Artifacts["index"],
  installed: new Map(),
  snapshots: { schema: "qed64.snapshot-index/v1", snapshots: [snap("init", init), snap("mathlib", mathlib)] } as unknown as Qed64Artifacts["snapshots"],
});
const UNPAIRED_MATHLIB = { kind: "unpaired", stage: "snapshot", subject: "mathlib", code: "SNAPSHOT_UNPAIRED", message: `snapshot 'mathlib' was baked for runtime ${OTHER}; this page runs runtime ${BOOTED}` };

/** The Lean worker: records what the session posts (a `boot` request would start the runtime). */
class FakeLeanWorker {
  static posted: Array<{ type?: string }> = [];
  constructor(_url: string) {}
  addEventListener() {}
  postMessage(m: { type?: string }) { FakeLeanWorker.posted.push(m); }
  terminate() {}
}

let calls: Array<{ kind: "busy" | "progress"; label: string; info?: ProgressInfo }>;
let ui: StatusSink;
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  FakeLeanWorker.posted = [];
  vi.stubGlobal("Worker", FakeLeanWorker);
  vi.stubGlobal("navigator", {});
  fetchSpy = vi.fn(async () => new Response("Not Found", { status: 404 }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.mocked(prefetchRaw).mockClear();
  calls = [];
  ui = { busy: (label, info) => calls.push({ kind: "busy", label, info }), progress: (label, info) => calls.push({ kind: "progress", label, info }), idle() {} };
});
afterEach(() => vi.unstubAllGlobals());

describe("snapshotPairingFault: the two facts the page holds", () => {
  it("an entry baked by another runtime is the worker's SNAPSHOT_UNPAIRED cause, naming both ids", () => {
    expect(snapshotPairingFault({ runtime: OTHER }, "mathlib", runtime)).toEqual(UNPAIRED_MATHLIB);
  });
  it("a paired entry, an entry without `runtime` (old indexes, lean4game's game indexes) and an unknown runtime are not refused", () => {
    expect(snapshotPairingFault({ runtime: BOOTED }, "mathlib", runtime)).toBeNull();
    expect(snapshotPairingFault({}, "mathlib", runtime)).toBeNull();
    expect(snapshotPairingFault({ runtime: "" }, "mathlib", runtime)).toBeNull(); // the worker accepts an empty one too
    expect(snapshotPairingFault({ runtime: OTHER }, "mathlib", null)).toBeNull();
  });
});

describe("loadSnapshotByName: an unpaired entry is refused before the fetch/cache path", () => {
  const qsOf = () => {
    const loadSnapshot = vi.fn(async () => ({ success: true, elapsedMs: 1 }));
    return { qs: { session: { loadSnapshot }, loadedSnapshots: new Set<string>() } as unknown as Qed64Session, loadSnapshot };
  };

  it("refuses it: false, the worker path's lastFailure, the cause on the sink, no prefetch and no worker load", async () => {
    const { qs, loadSnapshot } = qsOf();
    await expect(loadSnapshotByName(artifacts(BOOTED, OTHER), qs, "mathlib", ui)).resolves.toBe(false);
    expect(qs.lastFailure).toEqual(UNPAIRED_MATHLIB);
    expect(prefetchRaw).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([{ kind: "progress", label: `mathlib snapshot failed: ${UNPAIRED_MATHLIB.message}`, info: { stage: "snapshot", subject: "mathlib", error: UNPAIRED_MATHLIB } }]);
    expect(qs.loadedSnapshots.has("mathlib")).toBe(false);
  });

  it("accepts a paired entry: prefetched, then loaded with its runtime for the worker's own check", async () => {
    const { qs, loadSnapshot } = qsOf();
    await expect(loadSnapshotByName(artifacts(BOOTED, BOOTED), qs, "mathlib", ui)).resolves.toBe(true);
    expect(prefetchRaw).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).toHaveBeenCalledWith("/snapshots/mathlib.x.snapz", "mathlib.snap", 100, expect.any(String), BOOTED);
    expect(qs.lastFailure).toBeUndefined();
  });

  it("ignores an entry without `runtime`: the worker decides, as before", async () => {
    const { qs, loadSnapshot } = qsOf();
    await expect(loadSnapshotByName(artifacts(undefined, undefined), qs, "mathlib", ui)).resolves.toBe(true);
    expect(prefetchRaw).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).toHaveBeenCalledWith("/snapshots/mathlib.x.snapz", "mathlib.snap", 100, expect.any(String), undefined);
  });
});

describe("ResidentSession.start(): an unpaired pre-open snapshot rejects before the runtime boots", () => {
  /** A session whose worker calls are spied; boot, loads and arm succeed when reached. */
  function session(a: Qed64Artifacts, opts: RestartOptions = { snapshots: ["init", "mathlib"] }, extra: Partial<ResidentHost> = {}) {
    const s = new ResidentSession({ artifacts: a, ui, headerText: "import Mathlib\n", ...extra }, opts);
    const boot = vi.spyOn(s.lean, "boot").mockResolvedValue({} as never);
    const loadSnapshot = vi.spyOn(s.lean, "loadSnapshot").mockResolvedValue({ success: true, elapsedMs: 1 });
    vi.spyOn(s.lean, "arm").mockResolvedValue(undefined);
    return { s, boot, loadSnapshot };
  }

  it("rejects with the unpaired cause: no runtime boot, no snapshot load, no prefetch, no pack install", async () => {
    const { s, boot, loadSnapshot } = session(artifacts(BOOTED, OTHER));
    await expect(s.start()).rejects.toMatchObject({ message: "snapshot 'mathlib' failed to load", cause: UNPAIRED_MATHLIB });
    expect(boot).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled(); // not even the paired init: nothing is loaded for a boot that cannot open
    expect(prefetchRaw).not.toHaveBeenCalled();
    expect(FakeLeanWorker.posted.filter((m) => m.type === "boot")).toEqual([]);
    // "Load exact imports" installs the essential pack before the boot: refused before that too.
    const withPack = artifacts(BOOTED, OTHER);
    withPack.index.profiles.push({ id: "essential", manifest: "/profiles/essential.json", release: "r", modules: 1 } as never);
    const p = session(withPack, { snapshots: ["init", "mathlib"], packs: ["essential"] });
    await expect(p.s.start()).rejects.toMatchObject({ cause: { kind: "unpaired", subject: "mathlib" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p.boot).not.toHaveBeenCalled();
  });

  it("a paired index, and one without `runtime`, boot and load as before", async () => {
    for (const a of [artifacts(BOOTED, BOOTED), artifacts(undefined, undefined)]) {
      const { s, boot, loadSnapshot } = session(a);
      await s.start();
      expect(boot).toHaveBeenCalledTimes(1);
      expect(loadSnapshot).toHaveBeenCalledTimes(2);
    }
    expect(prefetchRaw).toHaveBeenCalledTimes(4);
  });

  it("only the snapshots this session loads before it opens are checked (an unpaired entry it does not load is not its failure)", async () => {
    const { s, boot } = session(artifacts(BOOTED, OTHER), { snapshots: ["init"] });
    await s.start();
    expect(boot).toHaveBeenCalledTimes(1);
  });

  it("through the relay: three bootFailed deaths with the unpaired cause, then halted, and not one runtime boot or download", async () => {
    const boots: Array<ReturnType<typeof vi.fn>> = [];
    const statuses: string[] = [];
    const relay = new LspRelay(() => { const x = session(artifacts(BOOTED, OTHER)); boots.push(x.boot as never); return x.s; }, { status: (st) => statuses.push(st.relay) }, () => Promise.resolve());
    await vi.waitFor(() => expect(relay.state.kind).toBe("halted"));
    expect(relay.stats).toMatchObject({ workerDeaths: 3, breakerTrips: 1, reboots: 2 });
    expect(relay.lastDeath).toMatchObject({ reason: "bootFailed", message: "snapshot 'mathlib' failed to load", seq: 3, cause: UNPAIRED_MATHLIB });
    expect(relay.status()).toMatchObject({ phase: "halted", relay: "halted" });
    // The page API's projection of it (what api.status().lastDeath reports).
    expect(deathInfo(relay.status().lastDeath)).toMatchObject({ reason: "bootFailed", cause: { kind: "unpaired", code: "SNAPSHOT_UNPAIRED" } });
    expect(boots).toHaveLength(3);
    for (const b of boots) expect(b).not.toHaveBeenCalled();
    expect(prefetchRaw).not.toHaveBeenCalled();
    expect(FakeLeanWorker.posted.filter((m) => m.type === "boot")).toEqual([]);
    expect(statuses.at(-1)).toBe("halted");
    relay.clientPort.close();
  });
});
