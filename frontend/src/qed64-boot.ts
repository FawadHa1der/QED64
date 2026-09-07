// QED64 runtime boot for the lean4web-style front end, split for restarts:
// artifacts install once per page (OPFS-cached across visits), sessions are
// created repeatedly — the relay replaces a crashed worker, and a user
// restart ("Load exact imports", widening a light session) boots a fresh
// one — so the pieces a session boot needs (pack install on demand, snapshot
// prefetch + load) live here, and the boot itself in resident-session.ts.
import type { LeanSession, RuntimeManifest } from "../../src/runtime/client";
import { fetchProfileIndex, installProfile, type InstalledProfile, type ProfileIndex } from "../../src/install/profiles";
import { fetchSnapshotIndex, snapshotCacheKey, type SnapshotIndex } from "../../src/runtime/snapshots";

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
}

export interface ProgressInfo {
  phase?: string;
  loaded?: number;
  total?: number;
  unit?: string;
}

export interface StatusSink {
  /** A long-running stage began (spinner + elapsed ticker). */
  busy(label: string): void;
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

export async function installArtifacts(ui: StatusSink): Promise<Qed64Artifacts> {
  ui.busy("fetching manifests");
  const index = await fetchProfileIndex();
  if (!index) throw new Error("profile index missing (/profiles/index.json)");
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
  const devRuntime = new URLSearchParams(location.search).get("runtime");
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
  ui.busy("installing the Lean core library");
  installed.set(
    "core",
    await installProfile(core, (p) => {
      const verb = p.phase === "cached" ? "checking cached" : p.phase === "download" ? "downloading" : p.phase === "inflate" ? "unpacking" : "committing";
      ui.progress(`${verb} the Lean core library`, { phase: `core-${p.phase}`, loaded: p.loaded, total: p.total ?? 0, unit: "bytes" });
    }),
  );
  // Dev-only override (?snapshots=<dir>): an unpromoted snapshot set served
  // from public/<dir> (a symlink to a staging bake); the index's urls name
  // the promoted dir, so they are re-rooted here. Cache keys are content-
  // addressed, so unpromoted bakes never collide with served ones.
  const devSnapshots = new URLSearchParams(location.search).get("snapshots");
  const snapshots = devSnapshots
    ? await fetchSnapshotIndex(`/${devSnapshots}/index.json`).then((idx) => idx && {
        ...idx,
        snapshots: idx.snapshots.map((e) => ({ ...e, url: e.url.replace(/^\/snapshots\//, `/${devSnapshots}/`) })),
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
  ui.busy(`installing the ${id} library (needed to import this header)`);
  artifacts.installed.set(
    id,
    await installProfile(entry, (p) => {
      ui.progress(`${p.phase} ${id} — ${(p.loaded / 1048576) | 0} / ${((p.total ?? 0) / 1048576) | 0} MiB`);
    }),
  );
  return true;
}

/** Load a named snapshot into the session's runtime (idempotent). */
/** Make sure the RAW (inflated) region cache exists BEFORE the Lean worker
 * touches this snapshot. The download and gunzip run in a disposable
 * prefetch worker whose heap dies on completion — a Lean worker that
 * streams/inflates itself keeps ~4.6 GB of that era's allocations for its
 * whole life (measured 9.7 GB vs 5-7 GB steady resident). Failure is
 * non-fatal: the Lean worker's own streaming path still works. */
async function ensureRawSnapshotCached(
  entry: { url: string; bytes: number },
  name: string,
  ui: StatusSink,
): Promise<void> {
  const cacheKey = snapshotCacheKey(entry as Parameters<typeof snapshotCacheKey>[0]);
  if (!cacheKey) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("qed64-snapshots", { create: true });
    try {
      const f = await (await dir.getFileHandle(`${cacheKey}.raw`)).getFile();
      if (f.size === entry.bytes) return; // warm — nothing to do
    } catch { /* not cached */ }
  } catch { return; } // no OPFS: the worker streams as before
  const gib = (entry.bytes / 1073741824).toFixed(1);
  await new Promise<void>((resolve) => {
    const w = new Worker("/workers/snapshot-prefetch.worker.js");
    const bail = window.setTimeout(() => { w.terminate(); resolve(); }, 15 * 60 * 1000);
    w.postMessage({ url: entry.url, cacheKey, rawBytes: entry.bytes });
    w.onmessage = (e) => {
      const m = e.data as { status?: string; bytes?: number; total?: number; phase?: string; error?: string };
      if (m.status === "progress") {
        ui.progress(`preparing the ${name} environment (${gib} GiB — one-time)`,
          { phase: "snapshot", loaded: m.bytes ?? 0, total: m.total ?? entry.bytes, unit: "bytes" });
        return;
      }
      if (m.status === "error" || m.status === "unavailable" || m.status === "busy") {
        console.warn(`[qed64] raw prefetch ${m.status}: ${m.error ?? ""} — the checker will stream it instead`);
      }
      window.clearTimeout(bail);
      w.terminate();
      resolve();
    };
  });
}

export async function loadSnapshotByName(
  artifacts: Qed64Artifacts,
  qs: Qed64Session,
  name: string,
  ui: StatusSink,
): Promise<boolean> {
  if (qs.loadedSnapshots.has(name)) return true;
  const entry = artifacts.snapshots?.snapshots.find((s) => s.name === name);
  if (!entry) return false;
  await ensureRawSnapshotCached(entry, name, ui);
  const gib = (entry.bytes / 1073741824).toFixed(1);
  ui.busy(`loading the ${name === "mathlib" ? "Mathlib" : name} environment (${gib} GiB unpacked — cached in your browser after the first visit)`);
  try {
    // The index entry's `runtime` (buildId that baked it) rides along so the worker
    // can refuse an unpaired snapshot with SNAPSHOT_UNPAIRED instead of trapping
    // (snapshots are binary-paired to the runtime; artifact discipline, review C6).
    const r = await qs.session.loadSnapshot(entry.url, `${name}.snap`, entry.bytes, snapshotCacheKey(entry), entry.runtime);
    if (r.success) qs.loadedSnapshots.add(name);
    return r.success;
  } catch (err) {
    ui.progress(`${name} snapshot failed: ${(err as Error).message}`);
    return false;
  }
}
