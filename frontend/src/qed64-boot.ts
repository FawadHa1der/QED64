// QED64 runtime boot for the lean4web-style front end, split for restarts:
// artifacts install once per page (OPFS-cached across visits), sessions are
// created repeatedly — the relay replaces a crashed worker, and a user
// restart ("Load exact imports", widening a light session) boots a fresh
// one — so the pieces a session boot needs (pack install on demand, snapshot
// prefetch + load) live here, and the boot itself in resident-session.ts.
import type { LeanSession, RuntimeManifest } from "../../src/runtime/client";
import { fetchProfileIndex, installProfile, type InstalledProfile, type ProfileIndex } from "../../src/install/profiles";
import { entryLabel, fetchSnapshotIndex, loadSnapshotIndex, snapshotCacheKey, type SnapshotEntry, type SnapshotIndex } from "../../src/runtime/snapshots";
import { NO_OVERRIDES, parseBootParams, validateBootOverrides, type BootOverrides } from "./embed/params";
import { failureCauseOf, stepOfInstallPhase, type BootStage, type BootStep, type FailureCause } from "./embed/failure";
import { PREFETCH_SILENCE_MS, prefetchRaw } from "./embed/raw-cache";

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
  const pinnedId = opts.pinnedBuildId !== undefined ? opts.pinnedBuildId : typeof __QED64_BUILD_ID__ === "string" ? __QED64_BUILD_ID__ : null;
  let manifestResponse: Response | null = null;
  if (pinnedId) {
    const pinned = await fetch(`/runtime/runtime-manifest.${pinnedId}.json`);
    if (pinned.ok && (pinned.headers.get("content-type") ?? "").includes("json")) manifestResponse = pinned;
  }
  if (overrides.runtime) manifestResponse = await fetch(`/runtime/runtime-manifest.${overrides.runtime}.json`, { cache: "no-cache" });
  if (!manifestResponse) manifestResponse = await fetch("/runtime/runtime-manifest.json", { cache: "no-cache" });
  if (!manifestResponse.ok) throw new Error(`runtime manifest: HTTP ${manifestResponse.status}`);
  return (await manifestResponse.json()) as RuntimeManifest;
}

/** The snapshot index a boot uses: `?snapshots=<dir>` (an unpromoted set
 * served from public/<dir>; its urls name the promoted dir, so they are
 * re-rooted — cache keys are content-addressed, so unpromoted bakes never
 * collide with served ones), else the served index. An overlay that was asked
 * for and is missing, malformed or off this site is a named failure
 * (docs/EMBEDDING.md §4), never a silent "no snapshots" that surfaces later as
 * "snapshot 'init' failed to load". */
export async function fetchSnapshotIndexFor(overrides: BootOverrides): Promise<SnapshotIndex | null> {
  const dir = overrides.snapshots;
  if (!dir) return fetchSnapshotIndex();
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
  const index: ProfileIndex = wanted === "none"
    ? await fetchProfileIndex(indexUrl).catch(() => ({ schema: "qed64.profile-index/v1", profiles: [] }) as unknown as ProfileIndex)
    : await fetchProfileIndex(indexUrl);
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

// The raw prefetch lives in embed/raw-cache.ts (single-flight, cross-tab
// lock, cleanup); re-exported here for existing importers.
export { PREFETCH_SILENCE_MS, prefetchRaw, type PrefetchRawOptions, type PrefetchRawResult } from "./embed/raw-cache";

async function ensureRawSnapshotCached(entry: SnapshotEntry, name: string, ui: StatusSink): Promise<void> {
  const gib = (entry.bytes / 1073741824).toFixed(1);
  // "wait": another tab writing this region finishes it for us; streaming it
  // here instead would put the ~4.6 GB-heavier path into this Lean worker.
  const r = await prefetchRaw(entry, {
    onBusy: "wait",
    onBusyWait: () => ui.progress(`waiting for another tab to finish preparing the ${name} environment`, { phase: "snapshot", stage: "snapshot", subject: name, step: "download" }),
    onProgress: (p) => ui.progress(`preparing the ${name} environment (${gib} GiB — one-time)`,
      { phase: "snapshot", loaded: p.loaded, total: p.total, unit: "bytes", stage: "snapshot", subject: name, step: p.step }),
  });
  if (r.status === "silent") console.warn(`[qed64] raw prefetch silent for ${PREFETCH_SILENCE_MS / 1000} s — the checker will stream it instead`);
  else if (r.error) console.warn(`[qed64] raw prefetch ${r.status}: ${r.error.message} — the checker will stream it instead`);
}

export async function loadSnapshotByName(
  artifacts: Qed64Artifacts,
  qs: Qed64Session,
  name: string,
  ui: StatusSink,
): Promise<boolean> {
  if (qs.loadedSnapshots.has(name)) return true;
  const entry = artifacts.snapshots?.snapshots.find((s) => s.name === name);
  if (!entry) {
    qs.lastFailure = { kind: "missing", stage: "snapshot", subject: name, code: "SNAPSHOT_NOT_IN_INDEX", message: `snapshot '${name}' is not in the snapshot index` };
    return false;
  }
  await ensureRawSnapshotCached(entry, name, ui);
  const gib = (entry.bytes / 1073741824).toFixed(1);
  ui.busy(`loading the ${entryLabel(entry)} environment (${gib} GiB unpacked — cached in your browser after the first visit)`,
    { stage: "snapshot", subject: name, step: "load" });
  try {
    // The index entry's `runtime` (buildId that baked it) rides along so the worker
    // can refuse an unpaired snapshot with SNAPSHOT_UNPAIRED instead of trapping
    // (snapshots are binary-paired to the runtime; artifact discipline, review C6).
    const r = await qs.session.loadSnapshot(entry.url, `${name}.snap`, entry.bytes, snapshotCacheKey(entry), entry.runtime);
    if (r.success) qs.loadedSnapshots.add(name);
    else qs.lastFailure = { kind: "corrupt", stage: "snapshot", subject: name, code: "SNAPSHOT_LOAD_RESULT", message: `the Lean loader refused the ${name} snapshot region` };
    return r.success;
  } catch (err) {
    const cause = failureCauseOf(err, { stage: "snapshot", subject: name });
    qs.lastFailure = cause;
    ui.progress(`${name} snapshot failed: ${(err as Error).message}`, { stage: "snapshot", subject: name, error: cause });
    return false;
  }
}
