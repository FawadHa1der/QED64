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
}

function overridesOf(opts: InstallOptions): BootOverrides {
  const o = opts.overrides ?? "url";
  if (o === "none") return NO_OVERRIDES;
  if (o === "url") return parseBootParams(location.search, location.origin);
  return validateBootOverrides(o, location.origin);
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
  const index = await fetchProfileIndex(profileReroot("/profiles/index.json"));
  if (!index) throw new Error(`profile index missing (${profileReroot("/profiles/index.json")})`);
  // Prefer the immutable manifest of the runtime this shell was built
  // against (uploaded by scripts/upload-artifacts.sh) so a shell deploy
  // never races the mutable manifest switch; the mutable path serves dev
  // and any shell whose pinned copy predates the pinning scheme.
  let manifestResponse: Response | null = null;
  if (typeof __QED64_BUILD_ID__ === "string") {
    const pinned = await fetch(`/runtime/runtime-manifest.${__QED64_BUILD_ID__}.json`);
    if (pinned.ok && (pinned.headers.get("content-type") ?? "").includes("json")) manifestResponse = pinned;
  }
  // Dev-only override (?runtime=<hash>): boot a runtime that is chunked into
  // public/runtime but not promoted — the resident-worker campaign tests the
  // patch-0031 build this way without touching the served manifest.
  const devRuntime = overrides.runtime;
  if (devRuntime) manifestResponse = await fetch(`/runtime/runtime-manifest.${devRuntime}.json`, { cache: "no-cache" });
  if (!manifestResponse) manifestResponse = await fetch("/runtime/runtime-manifest.json", { cache: "no-cache" });
  if (!manifestResponse.ok) throw new Error(`runtime manifest: HTTP ${manifestResponse.status}`);
  const runtime = (await manifestResponse.json()) as RuntimeManifest;

  const installed = new Map<string, InstalledProfile>();
  // Only the core library installs at boot. Mathlib elaboration is served by
  // the umbrella SNAPSHOT (a resident environment needs no pack mounts), so
  // the 1 GB pack download + 3.3 GiB unpack is skipped entirely — it kept a
  // real-Chrome first visit under enough memory pressure to crash the tab.
  // The pack only installs on demand if a header must import from oleans.
  const core = index.profiles.find((p) => p.id === "core");
  if (!core) throw new Error("core profile not published");
  ui.busy("installing the Lean core library", { stage: "profile", subject: "core" });
  installed.set(
    "core",
    await installProfile(core, (p) => {
      const verb = p.phase === "cached" ? "checking cached" : p.phase === "download" ? "downloading" : p.phase === "inflate" ? "unpacking" : "committing";
      ui.progress(`${verb} the Lean core library`, { phase: `core-${p.phase}`, loaded: p.loaded, total: p.total ?? 0, unit: "bytes", stage: "profile", subject: "core", step: stepOfInstallPhase(p.phase) });
    }, profileReroot),
  );
  // Dev-only override (?snapshots=<dir>): an unpromoted snapshot set served
  // from public/<dir> (a symlink to a staging bake); the index's urls name
  // the promoted dir, so they are re-rooted here. Cache keys are content-
  // addressed, so unpromoted bakes never collide with served ones.
  const devSnapshots = overrides.snapshots;
  // An overlay that was asked for and is missing or malformed is a named boot
  // failure (docs/EMBEDDING.md §4), never a silent "no snapshots" that surfaces
  // later as "snapshot 'init' failed to load".
  const snapshots = devSnapshots
    ? await loadSnapshotIndex(`/${devSnapshots}/index.json`).then((idx) => ({
        ...idx,
        snapshots: idx.snapshots.map((e) => ({ ...e, url: e.url.replace(/^\/snapshots\//, `/${devSnapshots}/`) })),
      }), (err: Error & { indexFault?: "network" | "corrupt" }) => {
        throw Object.assign(new Error(`?snapshots=${devSnapshots}: ${err.message}`), {
          cause: { kind: err.indexFault ?? failureCauseOf(err).kind, stage: "manifests", subject: devSnapshots, message: err.message } satisfies FailureCause,
        });
      })
    : await fetchSnapshotIndex();
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

/** How long the raw prefetch may go without a message before the page stops
 * waiting for it (it reports every 500 ms while bytes arrive). */
export const PREFETCH_SILENCE_MS = 3 * 60 * 1000;

export interface PrefetchRawOptions {
  onProgress?(p: { loaded: number; total: number; step: "download" | "inflate" }): void;
  signal?: AbortSignal;
  /** Give up after this long without a message (default PREFETCH_SILENCE_MS). */
  silenceMs?: number;
  workerUrl?: string;
}
export interface PrefetchRawResult {
  /** cached: the raw region was already complete (no worker spawned);
   * done: written now; unavailable: no OPFS / no cache key / the worker could
   * not use storage; busy: another tab holds the write; silent: no message for
   * `silenceMs`; aborted: `signal`; error: the worker failed. */
  status: "cached" | "done" | "unavailable" | "busy" | "silent" | "aborted" | "error";
  bytes?: number;
  error?: FailureCause;
}

/** Make sure the RAW (inflated) region cache of a snapshot exists in OPFS
 * BEFORE a Lean worker touches it (docs/EMBEDDING.md §7.4). The download and
 * gunzip run in a disposable prefetch worker whose heap dies on completion — a
 * Lean worker that streams/inflates itself keeps ~4.6 GB of that era's
 * allocations for its whole life (measured 9.7 GB vs 5-7 GB steady resident).
 * Never throws: every outcome is a status, and a failure is non-fatal for a
 * session (the Lean worker's own streaming path still works). */
export async function prefetchRaw(entry: SnapshotEntry, opts: PrefetchRawOptions = {}): Promise<PrefetchRawResult> {
  const cacheKey = snapshotCacheKey(entry);
  if (!cacheKey) return { status: "unavailable" };
  if (opts.signal?.aborted) return { status: "aborted" };
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("qed64-snapshots", { create: true });
    try {
      const f = await (await dir.getFileHandle(`${cacheKey}.raw`)).getFile();
      if (f.size === entry.bytes) return { status: "cached", bytes: f.size }; // warm — nothing to do
    } catch { /* not cached */ }
  } catch { return { status: "unavailable" }; } // no OPFS: the worker streams as before
  const silenceMs = opts.silenceMs ?? PREFETCH_SILENCE_MS;
  return new Promise<PrefetchRawResult>((resolve) => {
    const w = new Worker(opts.workerUrl ?? "/workers/snapshot-prefetch.worker.js");
    // Give up on the prefetch only after a SILENCE (a wedged worker or a dead
    // connection), never after a fixed total: it reports every 500 ms
    // while bytes arrive, and a slow first visit legitimately
    // downloads for longer than any deadline — the old 15-minute one
    // abandoned the Mathlib download on links under ~3 Mbit/s, and the Lean
    // worker then fetched it again from the start (HARDENING #54).
    let bail: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: PrefetchRawResult) => {
      clearTimeout(bail);
      opts.signal?.removeEventListener("abort", onAbort);
      w.terminate();
      resolve(r);
    };
    const onAbort = () => finish({ status: "aborted" });
    const arm = () => {
      clearTimeout(bail);
      bail = setTimeout(() => finish({ status: "silent" }), silenceMs);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    arm();
    w.postMessage({ url: entry.url, cacheKey, rawBytes: entry.bytes });
    w.onmessage = (e) => {
      const m = e.data as { status?: string; bytes?: number; total?: number; phase?: string; error?: string };
      if (m.status === "progress") {
        arm();
        opts.onProgress?.({ loaded: m.bytes ?? 0, total: m.total ?? entry.bytes, step: m.phase === "inflate" ? "inflate" : "download" });
        return;
      }
      if (m.status === "error" || m.status === "unavailable" || m.status === "busy") {
        return finish({ status: m.status, error: failureCauseOf(new Error(m.error ?? m.status), { stage: "snapshot", subject: entry.name }) });
      }
      finish({ status: "done", bytes: m.bytes });
    };
  });
}

async function ensureRawSnapshotCached(entry: SnapshotEntry, name: string, ui: StatusSink): Promise<void> {
  const gib = (entry.bytes / 1073741824).toFixed(1);
  const r = await prefetchRaw(entry, {
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
    qs.lastFailure = { kind: "other", stage: "snapshot", subject: name, message: `snapshot '${name}' is not in the snapshot index` };
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
    else qs.lastFailure = { kind: "corrupt", stage: "snapshot", subject: name, message: `the Lean loader refused the ${name} snapshot region` };
    return r.success;
  } catch (err) {
    const cause = failureCauseOf(err, { stage: "snapshot", subject: name });
    qs.lastFailure = cause;
    ui.progress(`${name} snapshot failed: ${(err as Error).message}`, { stage: "snapshot", subject: name, error: cause });
    return false;
  }
}
