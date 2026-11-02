// QED64 runtime boot for the lean4web-style front end, split for restarts:
// artifacts install once per page (OPFS-cached across visits), sessions are
// created repeatedly — the relay replaces a crashed worker, and a user
// restart (widening a light session, api.restart) boots a fresh one — so the
// pieces a session boot needs (the snapshot prefetch + load) live here, and
// the boot itself in resident-session.ts. No library pack is installed in the
// browser since D1 (2026-11): every environment is a snapshot.
import { runtimeManifestIdFault, type LeanSession, type RuntimeManifest } from "./client";
import { entryLabel, fetchSnapshotIndex, loadSnapshotIndex, snapshotCacheKey, type SnapshotEntry, type SnapshotIndex } from "./snapshots";
import { NO_OVERRIDES, parseBootParams, validateBootOverrides, type BootOverrides } from "./params";
import { failureCauseOf, type BootStage, type BootStep, type FailureCause } from "./failure";
import { clearNetworkFailure, isRawCached, networkFailedRecently, noteNetworkFailure, PREFETCH_SILENCE_MS, prefetchRaw, type PrefetchRawResult } from "./raw-cache";

export interface Qed64Artifacts {
  runtime: RuntimeManifest;
  snapshots: SnapshotIndex | null;
}

export interface Qed64Session {
  session: LeanSession;
  /** Snapshot names already resident in this session's runtime. */
  loadedSnapshots: Set<string>;
  /** Why the last `loadSnapshotByName` returned false (docs/EMBEDDING.md §7.2). */
  lastFailure?: FailureCause;
}

/** Structured progress beside the prose label (docs/EMBEDDING.md §7.1): every
 * call QED64 makes carries `stage`, and `subject` where there is one; labels
 * are for humans and are not API. */
export interface ProgressInfo {
  /** Legacy fine-grained phase ("snapshot-load", "snapshot-init", …). */
  phase?: string;
  loaded?: number;
  total?: number;
  unit?: string;
  stage?: BootStage;
  /** Snapshot name or runtime file ("mathlib", "lean.wasm"). */
  subject?: string;
  step?: BootStep;
  /** Set on the call that reports a failure. */
  error?: FailureCause;
}

export interface StatusSink {
  /** A long-running stage began (spinner + elapsed ticker). `info` (optional,
   * so existing sinks keep compiling) carries the structured stage. */
  busy(label: string, info?: ProgressInfo): void;
  /** Update the busy label without restarting the clock; numeric progress
   * (bytes/modules) rides along when the producer has it. */
  progress(label: string, info?: ProgressInfo): void;
  /** The page is quiescent. */
  idle(label: string): void;
  /** Offer ONE explicit, user-initiated action beside the pill. QED64 offers
   * no action since D1; kept optional so an embedder's sink compiles. The
   * action stays until `clearAction` or the next offer replaces it. */
  action?(label: string, run: () => void): void;
  clearAction?(): void;
}

declare const __QED64_BUILD_ID__: string;

/** The runtime buildId this shell was built against (`__QED64_BUILD_ID__`, a
 * bundler define: frontend/vite.config.ts sets it from the committed runtime
 * manifest), or null when the bundler defines none (an embedder without it,
 * the unit tests). Read at call time. */
function shellBuildId(): string | null {
  return typeof __QED64_BUILD_ID__ === "string" ? __QED64_BUILD_ID__ : null;
}

/** HARDENING #64: a mutable index names whatever pairing was uploaded LAST,
 * which during an upload-then-deploy window is the next runtime's, not this
 * shell's. The snapshot index goes through the one rule, `pairedCopyOr`
 * (lib/snapshots.ts), by loadSnapshotIndex's `pairedBuildId` (the option a
 * direct caller such as lean4game's game boot passes too). The shell's
 * buildId is passed as is: a missing or malformed one reads no copy. So a
 * paired site costs no request, and one that does not publish the copies
 * (an embedder's own origin) never sees one unless its mutable index is
 * mispaired. (QED64's own site has no such window since 2026-11: its indexes
 * ship in its deploy, docs/DEPLOY.md "Atomic deploys", so they always pair
 * with its shell, and a paired index costs no request.) */
const pairedBuildId = (): string | undefined => shellBuildId() ?? undefined;

export interface InstallOptions {
  /** Where the dev/embedding overrides come from (docs/EMBEDDING.md §4, §7.6):
   * "url" (default) parses `?snapshots=` / `?profiles=` / `?runtime=` from the
   * page URL, "none" ignores the URL, an object supplies them. Every source is
   * validated — a refused value throws a BootParamError naming the parameter;
   * `?profiles=` is validated, then ignored (D1). */
  overrides?: "url" | "none" | Partial<Record<keyof BootOverrides, string | null>>;
  /** Accepted and ignored since D1 (2026-11): no library pack is installed in
   * the browser and no profile index is read, whatever the value. Kept so v1
   * callers compile. */
  profiles?: "core" | "none" | string[];
  /** Already resolved (e.g. by a pairing check before boot): used as is. */
  runtime?: RuntimeManifest;
  snapshots?: SnapshotIndex | null;
}

/** The overrides an InstallOptions selects, validated. */
export function overridesOf(opts: Pick<InstallOptions, "overrides"> = {}): BootOverrides {
  const o = opts.overrides ?? "url";
  if (o === "none") return NO_OVERRIDES;
  if (o === "url") return parseBootParams(location.search, location.origin);
  return validateBootOverrides(o, location.origin);
}

/** The pinned runtime's immutable manifest, or null for a miss: an HTTP
 * error, a non-JSON answer (a host that rewrites misses to a page), or a fetch
 * or body read that rejects (a dead link while navigator.onLine is still true,
 * a refusing proxy; HARDENING #65). A miss leaves the choice to the mutable
 * path, whose own failure, if any, is the boot's. */
async function pinnedRuntimeManifest(id: string): Promise<RuntimeManifest | null> {
  try {
    const r = await fetch(`/runtime/runtime-manifest.${id}.json`);
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return (await r.json()) as RuntimeManifest;
  } catch {
    return null;
  }
}

/** The runtime manifest a boot uses (docs/EMBEDDING.md §7.6): the immutable
 * manifest of the runtime this shell was built against first (the toolchain
 * release's, uploaded by its owner under lean4-wasm64/<id>/ before any shell
 * pins it, so a shell deploy never races the mutable manifest switch),
 * `?runtime=` (an unpromoted runtime chunked into
 * public/runtime), else the mutable path. */
export async function resolveRuntimeManifest(overrides: BootOverrides, opts: { pinnedBuildId?: string | null } = {}): Promise<RuntimeManifest> {
  const pinnedId = opts.pinnedBuildId !== undefined ? opts.pinnedBuildId : shellBuildId();
  let manifest = pinnedId ? await pinnedRuntimeManifest(pinnedId) : null;
  if (overrides.runtime || !manifest) {
    const r = await fetch(overrides.runtime ? `/runtime/runtime-manifest.${overrides.runtime}.json` : "/runtime/runtime-manifest.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(`runtime manifest: HTTP ${r.status}`);
    manifest = (await r.json()) as RuntimeManifest;
  }
  // runtime/v1 and v2 invariant (§7.2), over the decoded lean.wasm: buildId is "wasm64-" + sha256(lean.wasm)[:16]. The worker refuses it too
  // (RUNTIME_MANIFEST_MISMATCH); checking here fails the boot before any chunk is fetched, with a cause.
  const fault = runtimeManifestIdFault(manifest);
  if (fault) throw Object.assign(new Error(`runtime manifest: ${fault}`), { code: "RUNTIME_MANIFEST_MISMATCH" }); // failureCauseOf reads the code: kind "corrupt"
  return manifest;
}

/** The snapshot index a boot uses: `?snapshots=<dir>` (an unpromoted set
 * served from public/<dir>; its urls name the promoted dir, so they are
 * re-rooted — cache keys are content-addressed, so unpromoted bakes never
 * collide with served ones), else the served `/snapshots/index.json`, or,
 * when that names another runtime than the one this shell pins, the pinned
 * runtime's copy `/snapshots/index.<buildId>.json` (HARDENING #64) when it
 * is an index paired with that runtime (loadSnapshotIndex's `pairedBuildId`,
 * the same rule a direct caller of fetchSnapshotIndex gets). An overlay that was asked
 * for and is missing, malformed or off this site is a named failure
 * (docs/EMBEDDING.md §4), never a silent "no snapshots" that surfaces later as
 * "snapshot 'init' failed to load". */
export async function fetchSnapshotIndexFor(overrides: BootOverrides): Promise<SnapshotIndex | null> {
  const dir = overrides.snapshots;
  if (!dir) {
    return fetchSnapshotIndex("/snapshots/index.json", { pairedBuildId: pairedBuildId() });
  }
  return loadSnapshotIndex(`/${dir}/index.json`).then((idx) => ({
    ...idx,
    snapshots: idx.snapshots.map((e) => ({ ...e, url: e.url.replace(/^\/snapshots\//, `/${dir}/`) })),
  }), (err: Error & { indexFault?: "missing" | "network" | "corrupt" | "refused" }) => {
    const cause = failureCauseOf(err, { stage: "manifests", subject: dir });
    throw Object.assign(new Error(`?snapshots=${dir}: ${err.message}`), {
      cause: { ...cause, kind: err.indexFault === "refused" ? "other" : err.indexFault ?? cause.kind } satisfies FailureCause,
    });
  });
}

/** @internal D1 (2026-11): releases before it installed library packs into OPFS `qed64-packs/` (the Lean core, ~385 MB,
 * on every visit; the Mathlib pack, 3.6 GB, after a "Load exact imports") and remembered an OPFS write ceiling in
 * localStorage. Nothing reads them now: both are removed, best effort, on every boot until gone (an absent directory
 * costs one NotFoundError). Never throws; never awaited by the boot. A tab of an older release may still have a pack
 * mounted; its reads then fail, as they could under the old installer's own clean-up of superseded packs
 * (docs/DEPLOY.md "Old shells"). Resolves whether the directory was removed. */
export async function removeRetiredPackStore(): Promise<boolean> {
  try { localStorage.removeItem("qed64.opfs.byteCeiling"); } catch { /* storage-less */ }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("qed64-packs", { recursive: true });
    return true;
  } catch { return false; }
}

export async function installArtifacts(ui: StatusSink, opts: InstallOptions = {}): Promise<Qed64Artifacts> {
  ui.busy("fetching manifests", { stage: "manifests" });
  // Validated BEFORE any fetch: an override is spliced into artifact URLs (`?profiles=` too, then ignored: D1).
  const overrides = overridesOf(opts);
  void removeRetiredPackStore(); // D1: the pack store of older releases, off the boot's path
  const runtime = opts.runtime ?? (await resolveRuntimeManifest(overrides));
  const snapshots = opts.snapshots !== undefined ? opts.snapshots : await fetchSnapshotIndexFor(overrides);
  return { runtime, snapshots };
}

// The raw prefetch lives in raw-cache.ts (single-flight, cross-tab
// lock, cleanup); re-exported here for existing importers.
export { PREFETCH_SILENCE_MS, prefetchRaw, type PrefetchRawOptions, type PrefetchRawResult } from "./raw-cache";

/** Options of `loadSnapshotByName` (docs/EMBEDDING.md §7.3, §7.4). */
export interface LoadSnapshotOptions {
  /** How long the load waits for ANOTHER tab writing the same raw region
   * (the prefetch's `onBusy: "wait"` bound, `busyWaitMs`; default
   * PREFETCH_SILENCE_MS) before the Lean worker streams the region itself. */
  busyWaitMs?: number;
}

/** The page-side pairing check (HARDENING #62, docs/EMBEDDING.md §7.2): the
 * cause the worker's SNAPSHOT_UNPAIRED refusal gives, decided from the two
 * facts the page already holds, the index entry's `runtime` (the buildId that
 * baked it) and the runtime manifest's `buildId`. null when they match, or
 * when either is absent: an entry without `runtime` (an index that predates
 * the field) is the worker's to decide, as before. */
export function snapshotPairingFault(entry: Pick<SnapshotEntry, "runtime">, name: string, runtime: Pick<RuntimeManifest, "buildId"> | null | undefined): FailureCause | null {
  const baked = entry.runtime, booted = runtime?.buildId;
  if (typeof baked !== "string" || baked.length === 0 || typeof booted !== "string" || baked === booted) return null;
  return { kind: "unpaired", stage: "snapshot", subject: name, code: "SNAPSHOT_UNPAIRED", message: `snapshot '${name}' was baked for runtime ${baked}; this page runs runtime ${booted}` };
}

/** `name`'s pairing fault against the artifacts' runtime, reported on the
 * sink as a failed snapshot load reports it (the call carries the cause);
 * null when it is paired, unknown, or not in the index. Fetches nothing. */
export function refuseUnpairedSnapshot(artifacts: Pick<Qed64Artifacts, "runtime" | "snapshots">, name: string, ui: StatusSink): FailureCause | null {
  const entry = artifacts.snapshots?.snapshots.find((s) => s.name === name);
  const cause = entry ? snapshotPairingFault(entry, name, artifacts.runtime) : null;
  if (cause) ui.progress(`${name} snapshot failed: ${cause.message}`, { stage: "snapshot", subject: name, error: cause });
  return cause;
}

/** The raw prefetch with the boot card's progress (the one fill path, raw-cache.ts). */
async function prefetchForBoot(entry: SnapshotEntry, name: string, ui: StatusSink, opts: LoadSnapshotOptions): Promise<PrefetchRawResult> {
  const gib = (entry.bytes / 1073741824).toFixed(1);
  // "wait": another tab writing this region finishes it for us; streaming it
  // here instead would put the ~4.6 GB-heavier path into this Lean worker.
  const r = await prefetchRaw(entry, {
    onBusy: "wait",
    ...(opts.busyWaitMs !== undefined ? { busyWaitMs: opts.busyWaitMs } : {}),
    onBusyWait: () => ui.progress(`waiting for another tab to finish preparing the ${name} environment`, { phase: "snapshot", stage: "snapshot", subject: name, step: "download" }),
    onProgress: (p) => ui.progress(`preparing the ${name} environment (${gib} GiB — one-time)`,
      { phase: "snapshot", loaded: p.loaded, total: p.total, unit: "bytes", stage: "snapshot", subject: name, step: p.step }),
  });
  if (r.status === "done" || r.status === "cached") clearNetworkFailure(entry);
  return r;
}

/** The one warning a prefetch that left the region to the checker logs. */
function warnCheckerStreams(r: PrefetchRawResult): void {
  if (r.status === "silent") console.warn(`[qed64] raw prefetch silent for ${PREFETCH_SILENCE_MS / 1000} s — the checker will stream it instead`);
  else if (r.error) console.warn(`[qed64] raw prefetch ${r.status}: ${r.error.message} — the checker will stream it instead`);
}

async function ensureRawSnapshotCached(entry: SnapshotEntry, name: string, ui: StatusSink, opts: LoadSnapshotOptions): Promise<void> {
  warnCheckerStreams(await prefetchForBoot(entry, name, ui, opts));
}

/** HARDENING #63: a boot that loads `names` before it opens failed with a
 * network-kind cause; the next session of this page (the relay's reboot)
 * downloads each of them before it boots its runtime (`downloadBeforeBoot`).
 * Every name, not only the cause's subject: a cut `init` means `mathlib`
 * was never reached and would cost the next runtime the same way. */
export function noteBootNetworkFailure(artifacts: Pick<Qed64Artifacts, "snapshots">, names: readonly string[]): void {
  for (const name of names) {
    const entry = artifacts.snapshots?.snapshots.find((s) => s.name === name);
    if (entry) noteNetworkFailure(entry);
  }
}

/** @internal What `downloadBeforeBoot` decided: a network cause (the caller
 * rejects before any runtime exists); "undecided" (the prefetch ran and left
 * the region to the checker: the boot's load must not prefetch it again,
 * `loadSnapshotForBoot`); or null (the step did not apply, or the region is
 * complete). */
export type PreBootDownload = FailureCause | "undecided" | null;

/** HARDENING #63, the step a session runs before it boots its runtime: when a
 * boot of this page that loaded `name` failed with a network-kind cause in
 * the last NETWORK_FAILURE_MEMORY_MS (raw-cache.ts) and the region is not
 * complete in the raw cache, download it to completion first (the raw
 * prefetch, its size and magic checked as always; once: the relay's reboots
 * are the retries). Resolves the download's network cause, reported on the
 * sink as a failed load reports it, when it failed with one. Resolves null
 * when the step does not apply (no such failure, no entry, no OPFS) and when
 * the region is complete (cached, or downloaded now: the memory is cleared).
 * Resolves "undecided" when the prefetch could not decide (another tab's
 * write, silence, a non-network error, storage refused): the boot then goes
 * on, and its load lets the checker stream the region without a second
 * prefetch (a second silence or busy wait would double the cost). */
export async function downloadBeforeBoot(artifacts: Pick<Qed64Artifacts, "snapshots">, name: string, ui: StatusSink, opts: LoadSnapshotOptions = {}): Promise<PreBootDownload> {
  const entry = artifacts.snapshots?.snapshots.find((s) => s.name === name);
  if (!entry || !networkFailedRecently(entry)) return null;
  // Probed first, so a cached region shows no download label at all.
  const cached = await isRawCached(entry);
  if (cached === null) return null; // no OPFS: the load's prefetch answers at once, the checker streams
  if (cached) { clearNetworkFailure(entry); return null; }
  // A download label with byte facts (loaded 0 of the region), so an embedder
  // that reads a "snapshot"/"download" call without `loaded` as onBusyWait's
  // "waiting for another tab" (lean4game's stageLabel) does not misread it.
  ui.progress(`preparing the ${name} environment before the checker starts (the last attempt lost the network)`,
    { phase: "snapshot", loaded: 0, total: entry.bytes, unit: "bytes", stage: "snapshot", subject: name, step: "download" });
  const r = await prefetchForBoot(entry, name, ui, opts);
  if (r.status === "done" || r.status === "cached") return null;
  if (r.status !== "error" || r.error?.kind !== "network") { warnCheckerStreams(r); return "undecided"; }
  const cause: FailureCause = { ...r.error, stage: "snapshot", subject: name };
  ui.progress(`${name} snapshot failed: ${cause.message}`, { stage: "snapshot", subject: name, error: cause });
  return cause;
}

export async function loadSnapshotByName(
  artifacts: Qed64Artifacts,
  qs: Qed64Session,
  name: string,
  ui: StatusSink,
  opts: LoadSnapshotOptions = {},
): Promise<boolean> {
  return loadSnapshotForBoot(artifacts, qs, name, ui, opts, false);
}

/** @internal `loadSnapshotByName`, with `prefetched`: this boot's
 * `downloadBeforeBoot` already ran the raw prefetch for `name` and it ended
 * "undecided", so the checker streams the region without a second one. */
export async function loadSnapshotForBoot(
  artifacts: Qed64Artifacts,
  qs: Qed64Session,
  name: string,
  ui: StatusSink,
  opts: LoadSnapshotOptions,
  prefetched: boolean,
): Promise<boolean> {
  if (qs.loadedSnapshots.has(name)) return true;
  const entry = artifacts.snapshots?.snapshots.find((s) => s.name === name);
  if (!entry) {
    qs.lastFailure = { kind: "missing", stage: "snapshot", subject: name, code: "SNAPSHOT_NOT_IN_INDEX", message: `snapshot '${name}' is not in the snapshot index` };
    return false;
  }
  // Refused here, before a byte of it is fetched or inflated (HARDENING #62):
  // the worker's own refusal came only after the whole region was cached.
  const unpaired = refuseUnpairedSnapshot(artifacts, name, ui);
  if (unpaired) {
    qs.lastFailure = unpaired;
    return false;
  }
  if (!prefetched) await ensureRawSnapshotCached(entry, name, ui, opts);
  const gib = (entry.bytes / 1073741824).toFixed(1);
  ui.busy(`loading the ${entryLabel(entry)} environment (${gib} GiB unpacked — cached in your browser after the first visit)`,
    { stage: "snapshot", subject: name, step: "load" });
  try {
    // The index entry's `runtime` (buildId that baked it) rides along so the worker
    // can refuse an unpaired snapshot with SNAPSHOT_UNPAIRED instead of trapping
    // (snapshots are binary-paired to the runtime; artifact discipline, review C6).
    // `transfer` (the compressed size) lets the worker's own stream call a body
    // that ends short of it a network failure even without a Content-Length
    // (HARDENING #63 follow-up 1): this stream's error is the boot's cause.
    const r = await qs.session.loadSnapshot(entry.url, `${name}.snap`, entry.bytes, snapshotCacheKey(entry), entry.runtime, entry.transfer);
    if (r.success) { qs.loadedSnapshots.add(name); clearNetworkFailure(entry); } // the checker streamed it, or read the cache
    else qs.lastFailure = { kind: "corrupt", stage: "snapshot", subject: name, code: "SNAPSHOT_LOAD_RESULT", message: `the Lean loader refused the ${name} snapshot region` };
    return r.success;
  } catch (err) {
    const cause = failureCauseOf(err, { stage: "snapshot", subject: name });
    qs.lastFailure = cause;
    ui.progress(`${name} snapshot failed: ${(err as Error).message}`, { stage: "snapshot", subject: name, error: cause });
    return false;
  }
}
