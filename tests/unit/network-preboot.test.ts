// A lasting network failure during the snapshot download costs no runtime
// per retry (HARDENING #63). The widgets showcase's C11 (pin bf9d947) cut
// every .snapz response: each session booted its runtime (the Memory64
// reservation and its glue isolates), then the download failed, start()
// rejected, and the relay's reboot booted a NEW runtime while the network was
// still down: three runtimes in 26 s, and a reload right after the halt
// crashed the renderer (the pointer-cage limit of #55). Now a session whose
// page's previous boot failed with a network-kind cause downloads its
// pre-open snapshots BEFORE it boots; a first attempt and a cached snapshot
// boot as before, and the relay and its breaker are unchanged.
//
// Over a fake Worker, a spied LeanSession and a spied raw-cache prefetch (the
// harness of unpaired-early.test.ts): no wasm, no browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/raw-cache", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/raw-cache")>();
  return { ...real, prefetchRaw: vi.fn(async () => ({ status: "done", bytes: 100 })), isRawCached: vi.fn(async () => false) };
});

import { clearNetworkFailure, isRawCached, NETWORK_FAILURE_MEMORY_MS, networkFailedRecently, noteNetworkFailure, prefetchRaw, type PrefetchRawResult } from "../../lib/raw-cache";
import { downloadBeforeBoot, noteBootNetworkFailure, type ProgressInfo, type Qed64Artifacts, type StatusSink } from "../../lib/qed64-boot";
import { ResidentSession } from "../../lib/resident-session";
import { LspRelay, type RestartOptions } from "../../lib/lsp-relay";
import { deathInfo } from "../../frontend/src/page-api";
import { failureCauseOf, type FailureCause } from "../../lib/failure";
import type { RuntimeManifest } from "../../lib/client";

const BOOTED = "wasm64-3ab1c6a9da03bc29";
const runtime = { buildId: BOOTED, leanVersion: "4.34.0", files: { "lean.js": { bytes: 0, sha256: "", chunks: [] }, "lean.wasm": { bytes: 0, sha256: "", chunks: [] } } } as RuntimeManifest;
const snap = (name: string, hex: string) => ({ name, url: `/snapshots/${name}.x.snapz`, bytes: 100, transfer: 50, digest: `sha256:${hex.repeat(32)}`, imports: [], runtime: BOOTED });
const INIT = snap("init", "ab");
const MATHLIB = snap("mathlib", "cd");
const artifacts = (): Qed64Artifacts => ({
  runtime,
  index: { schema: "qed64.profile-index/v1", profiles: [] } as unknown as Qed64Artifacts["index"],
  installed: new Map(),
  snapshots: { schema: "qed64.snapshot-index/v1", snapshots: [INIT, MATHLIB] } as unknown as Qed64Artifacts["snapshots"],
});
/** What the prefetch worker's failure becomes for a cut stream (raw-cache.ts runWorker: failureCauseOf of its message). */
const CUT: FailureCause = { kind: "network", stage: "snapshot", subject: "mathlib", message: "network error" };
const cutResult = (subject = "mathlib"): PrefetchRawResult => ({ status: "error", error: { ...CUT, subject } });
/** The Lean worker's own stream, cut (what loadSnapshotByName classifies as the boot's cause today). */
const workerCut = () => Object.assign(new Error("network error"), { code: "SNAPSHOT_FAILED" });

/** A body that ended cleanly before its Content-Length (the lane's truncate cut): both snapshot workers' words
 * (tests/unit/short-transfer.test.ts runs them). Before #63's follow-up the decoder's "Compressed input was
 * truncated." reached the page instead, classified corrupt, and the network rule never fired. */
const SHORT = "the transfer of init.x.snapz ended early: received 1000000 of 2000000 bytes";
const TRUNCATED = "Compressed input was truncated.";
/** The prefetch worker's report of it, classified as raw-cache.ts runWorker does. */
const prefetchFailed = (message: string, subject = "init"): PrefetchRawResult => ({ status: "error", error: failureCauseOf(new Error(message), { stage: "snapshot", subject }) });
const workerFailed = (message: string) => Object.assign(new Error(message), { code: "SNAPSHOT_FAILED" });

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
beforeEach(() => {
  FakeLeanWorker.posted = [];
  vi.stubGlobal("Worker", FakeLeanWorker);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
  vi.mocked(prefetchRaw).mockReset();
  vi.mocked(prefetchRaw).mockResolvedValue({ status: "done", bytes: 100 });
  vi.mocked(isRawCached).mockReset();
  vi.mocked(isRawCached).mockResolvedValue(false); // OPFS present, the region not complete
  clearNetworkFailure(INIT);
  clearNetworkFailure(MATHLIB);
  vi.spyOn(console, "warn").mockImplementation(() => {}); // today's "raw prefetch error … stream it instead" line
  calls = [];
  ui = { busy: (label, info) => calls.push({ kind: "busy", label, info }), progress: (label, info) => calls.push({ kind: "progress", label, info }), idle() {} };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A session whose worker calls are spied; boot, loads and arm succeed unless told otherwise. */
function session(a: Qed64Artifacts = artifacts(), opts: RestartOptions = { snapshots: ["init", "mathlib"] }) {
  const s = new ResidentSession({ artifacts: a, ui, headerText: "import Mathlib\n" }, opts);
  const boot = vi.spyOn(s.lean, "boot").mockResolvedValue({} as never);
  const loadSnapshot = vi.spyOn(s.lean, "loadSnapshot").mockResolvedValue({ success: true, elapsedMs: 1 });
  vi.spyOn(s.lean, "arm").mockResolvedValue(undefined);
  return { s, boot, loadSnapshot };
}
const prefetchedNames = () => vi.mocked(prefetchRaw).mock.calls.map(([e]) => e.name);
/** A prefetch the test settles by hand. */
function deferredPrefetch() {
  let settle!: (r: PrefetchRawResult) => void;
  vi.mocked(prefetchRaw).mockImplementationOnce(() => new Promise<PrefetchRawResult>((r) => { settle = r; }));
  return (r: PrefetchRawResult) => settle(r);
}
/** Progress calls shaped like onBusyWait's "waiting for another tab" (a "snapshot"/"download" call
 * without `loaded`: what lean4game's stageLabel reads as the wait). */
const waitShaped = () => calls.filter((c) => c.kind === "progress" && c.info?.stage === "snapshot" && c.info.step === "download" && c.info.loaded === undefined);
const PREBOOT_LABEL = "preparing the mathlib environment before the checker starts (the last attempt lost the network)";
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("the shared memory of a network failure (raw-cache.ts)", () => {
  it("is per entry, expires after NETWORK_FAILURE_MEMORY_MS and is cleared by hand", () => {
    expect(NETWORK_FAILURE_MEMORY_MS).toBe(60_000);
    expect(networkFailedRecently(MATHLIB)).toBe(false);
    const t = 1_000_000;
    noteNetworkFailure(MATHLIB, t);
    expect(networkFailedRecently(MATHLIB, t + 59_999)).toBe(true);
    expect(networkFailedRecently(INIT, t + 1)).toBe(false);
    expect(networkFailedRecently(MATHLIB, t + 60_000)).toBe(false);
    expect(networkFailedRecently(MATHLIB, t + 1)).toBe(false); // expired means forgotten
    noteNetworkFailure(MATHLIB);
    expect(networkFailedRecently(MATHLIB)).toBe(true);
    clearNetworkFailure(MATHLIB);
    expect(networkFailedRecently(MATHLIB)).toBe(false);
  });

  it("a session's network-kind boot failure notes every snapshot it loads before opening; another kind notes none", async () => {
    const a = session();
    a.loadSnapshot.mockRejectedValueOnce(workerCut()); // init's own stream, cut
    await expect(a.s.start()).rejects.toMatchObject({ message: "snapshot 'init' failed to load", cause: { kind: "network", stage: "snapshot", subject: "init" } });
    expect(networkFailedRecently(INIT)).toBe(true);
    expect(networkFailedRecently(MATHLIB)).toBe(true); // never reached, and it would cost the next runtime the same way
    clearNetworkFailure(INIT); clearNetworkFailure(MATHLIB);
    const b = session();
    b.loadSnapshot.mockRejectedValueOnce(new Error("snapshot is not a compacted-region file"));
    await expect(b.s.start()).rejects.toMatchObject({ cause: { kind: "corrupt" } });
    expect(networkFailedRecently(INIT) || networkFailedRecently(MATHLIB)).toBe(false);
  });

  it("noteBootNetworkFailure skips a name the index does not list", () => {
    noteBootNetworkFailure(artifacts(), ["nope", "mathlib"]);
    expect(networkFailedRecently(MATHLIB)).toBe(true);
    expect(networkFailedRecently(INIT)).toBe(false);
  });
});

describe("ResidentSession.start(): the download before the boot, after a network failure", () => {
  it("a first attempt keeps today's order: the runtime boots first, then each snapshot is prefetched and loaded", async () => {
    const { s, boot, loadSnapshot } = session();
    await s.start();
    expect(boot).toHaveBeenCalledTimes(1);
    expect(prefetchedNames()).toEqual(["init", "mathlib"]);
    expect(boot.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(prefetchRaw).mock.invocationCallOrder[0]!);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("after a network failure the boot waits for the download to resolve, then boots once and loads from the cache", async () => {
    noteBootNetworkFailure(artifacts(), ["init", "mathlib"]);
    vi.mocked(prefetchRaw).mockResolvedValueOnce({ status: "cached", bytes: 100 }); // init: already complete, no wait
    const settleMathlib = deferredPrefetch();
    const { s, boot, loadSnapshot } = session();
    let booted!: () => void;
    boot.mockImplementationOnce(() => new Promise((r) => { booted = () => r({} as never); }));
    const started = s.start();
    await flush();
    expect(prefetchedNames()).toEqual(["init", "mathlib"]);
    expect(boot).not.toHaveBeenCalled(); // mathlib's download is still running
    expect(FakeLeanWorker.posted.filter((m) => m.type === "boot")).toEqual([]);
    expect(networkFailedRecently(MATHLIB)).toBe(true);
    settleMathlib({ status: "done", bytes: 100 });
    await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    // The memory is cleared by the completed downloads themselves, before the runtime is up and a load ran.
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(networkFailedRecently(INIT) || networkFailedRecently(MATHLIB)).toBe(false);
    booted();
    await started;
    expect(boot.mock.invocationCallOrder[0]!).toBeGreaterThan(vi.mocked(prefetchRaw).mock.invocationCallOrder[1]!);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("a completed pre-boot download clears the memory even when the boot then fails another way (oom)", async () => {
    noteBootNetworkFailure(artifacts(), ["mathlib"]);
    const { s, boot, loadSnapshot } = session(artifacts(), { snapshots: ["mathlib"] });
    boot.mockRejectedValueOnce(new Error("could not allocate memory"));
    await expect(s.start()).rejects.toMatchObject({ cause: { kind: "oom" } });
    expect(prefetchedNames()).toEqual(["mathlib"]);
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(networkFailedRecently(MATHLIB)).toBe(false); // the next reboot does not run the pre-boot step again
  });

  it("the pre-boot label carries byte facts, so it never reads as the wait for another tab; only onBusyWait's does", async () => {
    noteBootNetworkFailure(artifacts(), ["mathlib"]);
    vi.mocked(prefetchRaw).mockImplementationOnce(async (_e, o) => { o?.onBusyWait?.(); return { status: "done", bytes: 100 }; });
    const { s } = session(artifacts(), { snapshots: ["mathlib"] });
    await s.start();
    expect(calls).toContainEqual({ kind: "progress", label: PREBOOT_LABEL, info: { phase: "snapshot", loaded: 0, total: 100, unit: "bytes", stage: "snapshot", subject: "mathlib", step: "download" } });
    expect(waitShaped().map((c) => c.label)).toEqual(["waiting for another tab to finish preparing the mathlib environment"]);
  });

  it("a download that fails with a network cause rejects start() with it before any runtime exists", async () => {
    noteBootNetworkFailure(artifacts(), ["init", "mathlib"]);
    vi.mocked(prefetchRaw).mockResolvedValueOnce({ status: "done", bytes: 100 }).mockResolvedValueOnce(cutResult());
    const { s, boot, loadSnapshot } = session();
    await expect(s.start()).rejects.toMatchObject({ message: "snapshot 'mathlib' failed to load", cause: CUT });
    expect(boot).not.toHaveBeenCalled();
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(FakeLeanWorker.posted.filter((m) => m.type === "boot")).toEqual([]);
    expect(prefetchedNames()).toEqual(["init", "mathlib"]); // one request each: the relay's reboots are the retries
    // Reported on the sink as a failed load is; and the failure is remembered again for the next reboot.
    expect(calls).toContainEqual({ kind: "progress", label: "mathlib snapshot failed: network error", info: { stage: "snapshot", subject: "mathlib", error: CUT } });
    expect(networkFailedRecently(MATHLIB)).toBe(true);
    expect(networkFailedRecently(INIT)).toBe(true);
  });

  it("a cached snapshot never waits for a download, and the boot goes on", async () => {
    noteBootNetworkFailure(artifacts(), ["init", "mathlib"]);
    vi.mocked(isRawCached).mockResolvedValue(true);
    vi.mocked(prefetchRaw).mockResolvedValue({ status: "cached", bytes: 100 });
    const { s, boot } = session();
    await s.start();
    expect(boot).toHaveBeenCalledTimes(1);
    // Probed, not prefetched, before the boot; and no download label flashes on the card.
    expect(boot.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(prefetchRaw).mock.invocationCallOrder[0]!);
    expect(calls.filter((c) => c.label.includes("before the checker starts"))).toEqual([]);
    expect(waitShaped()).toEqual([]);
    expect(networkFailedRecently(INIT) || networkFailedRecently(MATHLIB)).toBe(false);
  });

  it("a prefetch that cannot decide (another tab, silence, a non-network error, storage refused) boots, and the load does not prefetch again", async () => {
    for (const r of [{ status: "unavailable" }, { status: "busy" }, { status: "silent" }, { status: "error", error: { kind: "storage", message: "QuotaExceededError" } }] as PrefetchRawResult[]) {
      noteBootNetworkFailure(artifacts(), ["mathlib"]);
      vi.mocked(prefetchRaw).mockReset();
      vi.mocked(prefetchRaw).mockResolvedValueOnce(r).mockResolvedValue({ status: "done", bytes: 100 });
      const { s, boot, loadSnapshot } = session(artifacts(), { snapshots: ["mathlib"] });
      await s.start();
      expect(boot, r.status).toHaveBeenCalledTimes(1);
      expect(loadSnapshot, r.status).toHaveBeenCalledTimes(1);
      // One prefetch, the pre-boot one: a second would wait out another silence (3 min) or busyWaitMs.
      expect(prefetchRaw, r.status).toHaveBeenCalledTimes(1);
      expect(vi.mocked(prefetchRaw).mock.invocationCallOrder[0]!, r.status).toBeLessThan(boot.mock.invocationCallOrder[0]!);
    }
  });

  it("without OPFS the pre-boot step does not apply: the boot goes first, as a first attempt's", async () => {
    noteBootNetworkFailure(artifacts(), ["mathlib"]);
    vi.mocked(isRawCached).mockResolvedValue(null);
    vi.mocked(prefetchRaw).mockResolvedValue({ status: "unavailable" });
    const { s, boot } = session(artifacts(), { snapshots: ["mathlib"] });
    await s.start();
    expect(prefetchRaw).toHaveBeenCalledTimes(1);
    expect(boot.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(prefetchRaw).mock.invocationCallOrder[0]!);
    expect(waitShaped()).toEqual([]);
  });

  it("an expired memory boots as a first attempt does", async () => {
    noteNetworkFailure(MATHLIB, Date.now() - NETWORK_FAILURE_MEMORY_MS - 1);
    const { s, boot } = session(artifacts(), { snapshots: ["mathlib"] });
    await s.start();
    expect(boot.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(prefetchRaw).mock.invocationCallOrder[0]!);
  });

  it("the checker's own successful stream clears the memory too", async () => {
    noteBootNetworkFailure(artifacts(), ["mathlib"]);
    vi.mocked(isRawCached).mockResolvedValue(null);
    vi.mocked(prefetchRaw).mockResolvedValue({ status: "unavailable" }); // no OPFS: the checker streams it
    const { s, loadSnapshot } = session(artifacts(), { snapshots: ["mathlib"] });
    await s.start();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(networkFailedRecently(MATHLIB)).toBe(false);
  });
});

describe("through the relay: a download that always fails", () => {
  it("halts after its usual three bootFailed deaths with the network cause, and only the first attempt boots a runtime", async () => {
    vi.mocked(prefetchRaw).mockResolvedValue(cutResult());
    const boots: Array<ReturnType<typeof vi.fn>> = [];
    const statuses: string[] = [];
    const relay = new LspRelay(() => {
      const x = session();
      x.loadSnapshot.mockRejectedValue(workerCut()); // today's path: the checker streams it itself, and that is cut too
      boots.push(x.boot as never);
      return x.s;
    }, { status: (st) => statuses.push(st.relay) }, () => Promise.resolve());
    await vi.waitFor(() => expect(relay.state.kind).toBe("halted"));
    expect(relay.stats).toMatchObject({ workerDeaths: 3, breakerTrips: 1, reboots: 2 });
    expect(relay.lastDeath).toMatchObject({ reason: "bootFailed", message: "snapshot 'init' failed to load", seq: 3, cause: { kind: "network", stage: "snapshot", subject: "init" } });
    expect(relay.status()).toMatchObject({ phase: "halted", relay: "halted" });
    expect(deathInfo(relay.status().lastDeath)).toMatchObject({ reason: "bootFailed", cause: { kind: "network" } });
    expect(boots).toHaveLength(3);
    expect(boots.map((b) => b.mock.calls.length)).toEqual([1, 0, 0]); // was [1, 1, 1]: a runtime per retry
    // Every retry is a real request (the showcase's lasting cut counts more than one cut): the first attempt's
    // prefetch of init, then one pre-boot request per reboot.
    expect(prefetchedNames()).toEqual(["init", "init", "init"]);
    expect(statuses.at(-1)).toBe("halted");
    relay.clientPort.close();
  });

  it("an edit's re-arm after the network returns boots normally and the memory clears", async () => {
    vi.mocked(prefetchRaw).mockResolvedValue(cutResult());
    let networkBack = false;
    const boots: Array<ReturnType<typeof vi.fn>> = [];
    const relay = new LspRelay(() => {
      const x = session();
      if (!networkBack) x.loadSnapshot.mockRejectedValue(workerCut());
      boots.push(x.boot as never);
      return x.s;
    }, { status() {} }, () => Promise.resolve());
    await vi.waitFor(() => expect(relay.state.kind).toBe("halted"));
    networkBack = true;
    vi.mocked(prefetchRaw).mockResolvedValue({ status: "done", bytes: 100 });
    expect(relay.rearm()).toBe(true);
    await vi.waitFor(() => expect(relay.state.kind).toBe("serving"));
    expect(boots.map((b) => b.mock.calls.length)).toEqual([1, 0, 0, 1]);
    expect(networkFailedRecently(INIT) || networkFailedRecently(MATHLIB)).toBe(false);
    relay.clientPort.close();
  });
});

describe("a short transfer is a network failure, so the rule fires for it (the browser lane's truncate cut)", () => {
  it("the checker's own short stream fails start() with a network cause and is remembered", async () => {
    const a = session();
    a.loadSnapshot.mockRejectedValueOnce(workerFailed(SHORT));
    await expect(a.s.start()).rejects.toMatchObject({ message: "snapshot 'init' failed to load", cause: { kind: "network", code: "SNAPSHOT_FAILED", subject: "init", message: SHORT } });
    expect(networkFailedRecently(INIT)).toBe(true);
  });

  it("through the relay: a body cut short on every request halts with the network cause, and only the first attempt boots", async () => {
    vi.mocked(prefetchRaw).mockResolvedValue(prefetchFailed(SHORT));
    const boots: Array<ReturnType<typeof vi.fn>> = [];
    const relay = new LspRelay(() => {
      const x = session();
      x.loadSnapshot.mockRejectedValue(workerFailed(SHORT)); // the prefetch failed first; the checker streams it and is cut the same way
      boots.push(x.boot as never);
      return x.s;
    }, { status() {} }, () => Promise.resolve());
    await vi.waitFor(() => expect(relay.state.kind).toBe("halted"));
    expect(relay.stats).toMatchObject({ workerDeaths: 3, breakerTrips: 1, reboots: 2 });
    expect(relay.lastDeath).toMatchObject({ reason: "bootFailed", seq: 3, cause: { kind: "network", stage: "snapshot", subject: "init", message: SHORT } });
    expect(boots.map((b) => b.mock.calls.length)).toEqual([1, 0, 0]); // the lane's truncate run: was [1, 1, 1]
    expect(prefetchedNames()).toEqual(["init", "init", "init"]);
    relay.clientPort.close();
  });

  it("through the relay, without a Content-Length: the index's transfer size reaches the checker's stream, so the cut is network too", async () => {
    // A close-delimited body (no Content-Length) that ends short on every request. The prefetch worker has the
    // index's transfer (raw-cache.ts posts it) and fails with the transfer wording; the boot's cause, though, is the
    // checker's own stream of the same URL, which can say so only when loadSnapshot passes it the same expectation.
    // This fake Lean worker does what lean.worker.js does with and without it (short-transfer.test.ts runs that).
    const SHORT_NO_CL = `the transfer of init.x.snapz ended early: received 25 of ${INIT.transfer} bytes`;
    vi.mocked(prefetchRaw).mockResolvedValue(prefetchFailed(SHORT_NO_CL));
    const boots: Array<ReturnType<typeof vi.fn>> = [];
    const transfers: unknown[] = [];
    const relay = new LspRelay(() => {
      const x = session();
      x.loadSnapshot.mockImplementation(async (...args: unknown[]) => {
        const transferBytes = args[5];
        transfers.push(transferBytes);
        throw workerFailed(typeof transferBytes === "number" && transferBytes > 0 ? SHORT_NO_CL : TRUNCATED);
      });
      boots.push(x.boot as never);
      return x.s;
    }, { status() {} }, () => Promise.resolve());
    await vi.waitFor(() => expect(relay.state.kind).toBe("halted"));
    expect(transfers).toEqual([INIT.transfer]); // only the first attempt reached the checker
    expect(relay.lastDeath).toMatchObject({ reason: "bootFailed", seq: 3, cause: { kind: "network", subject: "init", message: SHORT_NO_CL } });
    expect(boots.map((b) => b.mock.calls.length)).toEqual([1, 0, 0]); // without transferBytes: corrupt, [1, 1, 1]
    expect(prefetchedNames()).toEqual(["init", "init", "init"]);
    relay.clientPort.close();
  });

  it("a body that arrived in full and fails the decoder stays corrupt: no pre-boot download, a runtime per attempt as before", async () => {
    vi.mocked(prefetchRaw).mockResolvedValue(prefetchFailed(TRUNCATED));
    const boots: Array<ReturnType<typeof vi.fn>> = [];
    const relay = new LspRelay(() => {
      const x = session();
      x.loadSnapshot.mockRejectedValue(workerFailed(TRUNCATED));
      boots.push(x.boot as never);
      return x.s;
    }, { status() {} }, () => Promise.resolve());
    await vi.waitFor(() => expect(relay.state.kind).toBe("halted"));
    expect(relay.lastDeath).toMatchObject({ reason: "bootFailed", cause: { kind: "corrupt", message: TRUNCATED } });
    expect(boots.map((b) => b.mock.calls.length)).toEqual([1, 1, 1]); // retrying a corrupt snapshot first would not help
    expect(networkFailedRecently(INIT)).toBe(false);
    relay.clientPort.close();
  });
});

describe("LeanSession.loadSnapshot's message", () => {
  it("carries transferBytes as an optional input field (additive, EMBEDDING §7.7), and omits it when the entry has none", async () => {
    const posted = async (...args: unknown[]) => {
      FakeLeanWorker.posted = [];
      const { s, loadSnapshot } = session();
      loadSnapshot.mockRestore(); // the real method, posting to the fake worker
      void (s.lean as unknown as { loadSnapshot: (...a: unknown[]) => Promise<unknown> }).loadSnapshot(...args).catch(() => {});
      await vi.waitFor(() => expect(FakeLeanWorker.posted.filter((m) => m.type === "loadSnapshot")).toHaveLength(1));
      return (FakeLeanWorker.posted.find((m) => m.type === "loadSnapshot") as { input?: Record<string, unknown> }).input;
    };
    const base = { url: INIT.url, name: "init.snap", expectedBytes: 100, cacheKey: "k", runtime: BOOTED };
    expect(await posted(INIT.url, "init.snap", 100, "k", BOOTED, 50)).toStrictEqual({ ...base, transferBytes: 50 });
    expect(await posted(INIT.url, "init.snap", 100, "k", BOOTED)).toStrictEqual(base);
  });
});

describe("downloadBeforeBoot", () => {
  it("does nothing without a remembered failure or for an entry the index does not list", async () => {
    await expect(downloadBeforeBoot(artifacts(), "mathlib", ui)).resolves.toBeNull();
    await expect(downloadBeforeBoot(artifacts(), "nope", ui)).resolves.toBeNull();
    expect(prefetchRaw).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it("passes the session's busyWaitMs to the prefetch (another tab's write is waited for, as the load does)", async () => {
    noteNetworkFailure(MATHLIB);
    await expect(downloadBeforeBoot(artifacts(), "mathlib", ui, { busyWaitMs: 1234 })).resolves.toBeNull();
    expect(vi.mocked(prefetchRaw).mock.calls[0]![1]).toMatchObject({ onBusy: "wait", busyWaitMs: 1234 });
  });
  it("resolves \"undecided\" for a busy or silent prefetch, and logs today's warning once for silence", async () => {
    noteNetworkFailure(MATHLIB);
    vi.mocked(prefetchRaw).mockResolvedValueOnce({ status: "busy" }).mockResolvedValueOnce({ status: "silent" });
    await expect(downloadBeforeBoot(artifacts(), "mathlib", ui)).resolves.toBe("undecided");
    await expect(downloadBeforeBoot(artifacts(), "mathlib", ui)).resolves.toBe("undecided");
    expect(vi.mocked(console.warn).mock.calls.map(([m]) => m)).toEqual(["[qed64] raw prefetch silent for 180 s — the checker will stream it instead"]);
    expect(waitShaped()).toEqual([]);
  });
  it("a cached region resolves null without a prefetch or a label, and clears the memory", async () => {
    noteNetworkFailure(MATHLIB);
    vi.mocked(isRawCached).mockResolvedValue(true);
    await expect(downloadBeforeBoot(artifacts(), "mathlib", ui)).resolves.toBeNull();
    expect(prefetchRaw).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(networkFailedRecently(MATHLIB)).toBe(false);
  });
});
