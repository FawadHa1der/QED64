// QED64 runtime boot for the lean4web-style front end, split for restarts:
// artifacts install once per page (OPFS-cached across visits), sessions are
// created repeatedly — the relay replaces a crashed worker, and a user
// restart ("Load exact imports", widening a light session) boots a fresh
// one — so the pieces a session boot needs (pack install on demand, snapshot
// prefetch + load) live here, and the boot itself in resident-session.ts.
import { runtimeManifestIdFault, type LeanSession, type RuntimeManifest } from "./client";
import { fetchProfileIndex, installProfile, type InstalledProfile, type ProfileIndex } from "./profiles";
import { entryLabel, fetchSnapshotIndex, loadSnapshotIndex, pairedCopyOr, pairedIndexCopyUrl, snapshotCacheKey, type SnapshotEntry, type SnapshotIndex } from "./snapshots";
import { NO_OVERRIDES, parseBootParams, validateBootOverrides, type BootOverrides } from "./params";
import { failureCauseOf, stepOfInstallPhase, type BootStage, type BootStep, type FailureCause } from "./failure";
import { clearNetworkFailure, isRawCached, networkFailedRecently, noteNetworkFailure, PREFETCH_SILENCE_MS, prefetchRaw, type PrefetchRawResult } from "./raw-cache";

export interface Qed64Artifacts {
  runtime: RuntimeManifest;
  index: ProfileIndex;
  installed: Map<string, InstalledProfile>;
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
  /** Legacy fine-grained phase ("core-download", "snapshot-init", …). */
  phase?: string;
  loaded?: number;
  total?: number;
  unit?: string;
  stage?: BootStage;
  /** Profile id, snapshot name or runtime file ("core", "mathlib", "lean.wasm"). */
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
  /** Offer ONE explicit, user-initiated action beside the pill (e.g. "Load
   * exact imports"); optional so embedders' sinks keep compiling. The action
   * stays until `clearAction` or the next offer replaces it. */
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

/** @internal The per-build copies of the two site-owned indexes (HARDENING
 * #64), written beside the mutable ones by every promote and upload and named
 * by the runtime they are paired with, as `/runtime/runtime-manifest.<buildId>.json`
 * is. Both live under `/snapshots/`, the prefix every QED64 Worker and record
 * leaves to the site (hosting.siteOwned): `/profiles/index.<buildId>.json`
 * would be routed to the toolchain release, which does not carry it. Served
 * must-revalidate (infra/edge-worker.js isImmutable): a same-runtime rebake
 * rewrites them under the same name. */
export function pinnedIndexUrls(buildId: string): { snapshots: string; profiles: string } {
  return { snapshots: pairedIndexCopyUrl("/snapshots/index.json", buildId), profiles: `/snapshots/profiles-index.${buildId}.json` };
}

/** HARDENING #64: a mutable index names whatever pairing was uploaded LAST,
 * which during an upload-then-deploy window is the next runtime's, not this
 * shell's. Both indexes go through the one rule, `pairedCopyOr`
 * (lib/snapshots.ts): the snapshot index through loadSnapshotIndex's
 * `pairedBuildId` (the option a direct caller such as lean4game's game boot
 * passes too), the profile index here with its own copy path. The shell's
 * buildId is passed as is: a missing or malformed one reads no copy. So a
 * paired site costs no request, and one that does not publish the copies
 * (an embedder's own origin) never sees one unless its mutable index is
 * mispaired. */
const pairedBuildId = (): string | undefined => shellBuildId() ?? undefined;

/** Set once by installArtifacts from `?profiles=`; identity in production. */
let profileReroot: (url: string) => string = (url) => url;

export interface InstallOptions {
  /** Where the dev/embedding overrides come from (docs/EMBEDDING.md §4, §7.6):
   * "url" (default) parses `?snapshots=` / `?profiles=` / `?runtime=` from the
   * page URL, "none" ignores the URL, an object supplies them. Every source is
   * validated — a refused value throws a BootParamError naming the parameter. */
  overrides?: "url" | "none" | Partial<Record<keyof BootOverrides, string | null>>;
  /** Library packs installed at boot: "core" (default, the editor), "none"
   * (a page whose environment is all snapshot — a game: no 120 MB download, and
   * a missing profile index is an empty one), or a list of profile ids. */
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

/** The runtime manifest a boot uses (docs/EMBEDDING.md §7.6): the immutable
 * manifest of the runtime this shell was built against first (uploaded by
 * scripts/upload-artifacts.sh, so a shell deploy never races the mutable
 * manifest switch), `?runtime=` (an unpromoted runtime chunked into
 * public/runtime), else the mutable path. */
export async function resolveRuntimeManifest(overrides: BootOverrides, opts: { pinnedBuildId?: string | null } = {}): Promise<RuntimeManifest> {
  const pinnedId = opts.pinnedBuildId !== undefined ? opts.pinnedBuildId : shellBuildId();
  let manifestResponse: Response | null = null;
  if (pinnedId) {
    const pinned = await fetch(`/runtime/runtime-manifest.${pinnedId}.json`);
    if (pinned.ok && (pinned.headers.get("content-type") ?? "").includes("json")) manifestResponse = pinned;
  }
  if (overrides.runtime) manifestResponse = await fetch(`/runtime/runtime-manifest.${overrides.runtime}.json`, { cache: "no-cache" });
  if (!manifestResponse) manifestResponse = await fetch("/runtime/runtime-manifest.json", { cache: "no-cache" });
  if (!manifestResponse.ok) throw new Error(`runtime manifest: HTTP ${manifestResponse.status}`);
  const manifest = (await manifestResponse.json()) as RuntimeManifest;
  // runtime/v1 invariant (§7.2): buildId is "wasm64-" + sha256(lean.wasm)[:16]. The worker refuses it too
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

export async function installArtifacts(ui: StatusSink, opts: InstallOptions = {}): Promise<Qed64Artifacts> {
  ui.busy("fetching manifests", { stage: "manifests" });
  // Validated BEFORE any fetch: an override is spliced into artifact URLs.
  const overrides = overridesOf(opts);
  // Dev-only override (?profiles=<dir>): an unpromoted profile set served
  // from public/<dir> (a symlink to work/staging/<buildId>/profiles). A staged
  // runtime of another Lean version must never mount the SERVED packs — the
  // olean githash gate is compiled off, so foreign oleans would be misread,
  // not refused. Index, manifests and parts are all re-rooted by basename.
  const devProfiles = overrides.profiles;
  profileReroot = devProfiles ? (url: string) => url.replace(/^\/profiles\//, `/${devProfiles}/`) : (url: string) => url;
  const wanted = opts.profiles ?? "core";
  const indexUrl = profileReroot("/profiles/index.json");
  const served: ProfileIndex = wanted === "none"
    ? await fetchProfileIndex(indexUrl).catch(() => ({ schema: "qed64.profile-index/v1", profiles: [] }) as unknown as ProfileIndex)
    : await fetchProfileIndex(indexUrl);
  // The served index names the pairing uploaded last (HARDENING #64): when it
  // is another runtime's, the pinned runtime's copy; a `?profiles=` set keeps
  // its own index.
  const index: ProfileIndex = devProfiles || !served ? served
    : await pairedCopyOr(served, pairedBuildId(), (i) => [i.runtime?.buildId], (id) => pinnedIndexUrls(id).profiles, (url) => fetchProfileIndex(url));
  if (!index) throw new Error(`profile index missing (${indexUrl})`);
  const runtime = opts.runtime ?? (await resolveRuntimeManifest(overrides));

  const installed = new Map<string, InstalledProfile>();
  // Only the core library installs at boot. Mathlib elaboration is served by
  // the umbrella SNAPSHOT (a resident environment needs no pack mounts), so
  // the 1 GB pack download + 3.3 GiB unpack is skipped entirely — it kept a
  // real-Chrome first visit under enough memory pressure to crash the tab.
  // The pack only installs on demand if a header must import from oleans.
  for (const id of wanted === "none" ? [] : wanted === "core" ? ["core"] : wanted) {
    const entry = index.profiles.find((p) => p.id === id);
    if (!entry) throw new Error(`${id} profile not published`);
    const what = id === "core" ? "the Lean core library" : `the ${id} library`;
    ui.busy(`installing ${what}`, { stage: "profile", subject: id });
    installed.set(
      id,
      await installProfile(entry, (p) => {
        const verb = p.phase === "cached" ? "checking cached" : p.phase === "download" ? "downloading" : p.phase === "inflate" ? "unpacking" : "committing";
        ui.progress(`${verb} ${what}`, { phase: `${id === "core" ? "core" : "pack"}-${p.phase}`, loaded: p.loaded, total: p.total ?? 0, unit: "bytes", stage: "profile", subject: id, step: stepOfInstallPhase(p.phase) });
      }, profileReroot),
    );
  }
  const snapshots = opts.snapshots !== undefined ? opts.snapshots : await fetchSnapshotIndexFor(overrides);
  return { runtime, index, installed, snapshots };
}

/** Install a profile on demand (for headers that must import from oleans). */
export async function ensureProfile(
  artifacts: Qed64Artifacts,
  id: string,
  ui: StatusSink,
): Promise<boolean> {
  if (artifacts.installed.has(id)) return true;
  const entry = artifacts.index.profiles.find((p) => p.id === id);
  if (!entry) return false;
  ui.busy(`installing the ${id} library (needed to import this header)`, { stage: "profile", subject: id });
  artifacts.installed.set(
    id,
    await installProfile(entry, (p) => {
      ui.progress(`${p.phase} ${id} — ${(p.loaded / 1048576) | 0} / ${((p.total ?? 0) / 1048576) | 0} MiB`,
        { phase: `pack-${p.phase}`, loaded: p.loaded, total: p.total ?? 0, unit: "bytes", stage: "profile", subject: id, step: stepOfInstallPhase(p.phase) });
    }, profileReroot),
  );
  return true;
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
