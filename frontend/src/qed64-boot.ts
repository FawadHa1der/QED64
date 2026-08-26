// QED64 runtime boot for the lean4web-style front end, split for restarts:
// artifacts install once per page (OPFS-cached across visits), sessions are
// created repeatedly — a header edit exits the Lean file worker (the
// watchdog restart contract), which under wasm tears down the instance, so
// "restart the worker" means "boot a fresh session and reload snapshots".
import { LeanSession, memoryCandidates, type LibraryPack, type RuntimeManifest } from "../../src/runtime/client";
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

export interface StatusSink {
  /** A long-running stage began (spinner + elapsed ticker). */
  busy(label: string): void;
  /** Update the busy label without restarting the clock. */
  progress(label: string): void;
  /** The page is quiescent. */
  idle(label: string): void;
}

export async function installArtifacts(ui: StatusSink): Promise<Qed64Artifacts> {
  ui.busy("fetching manifests");
  const index = await fetchProfileIndex();
  if (!index) throw new Error("profile index missing (/profiles/index.json)");
  const manifestResponse = await fetch("/runtime/runtime-manifest.json", { cache: "no-cache" });
  if (!manifestResponse.ok) throw new Error(`runtime manifest: HTTP ${manifestResponse.status}`);
  const runtime = (await manifestResponse.json()) as RuntimeManifest;

  const installed = new Map<string, InstalledProfile>();
  for (const id of ["core", "essential"]) {
    const entry = index.profiles.find((p) => p.id === id);
    if (!entry) {
      if (id === "core") throw new Error("core profile not published");
      continue; // Mathlib optional: Init-only editing still works
    }
    const label = id === "core" ? "Lean core library" : "Mathlib";
    ui.busy(`installing the ${label}`);
    const profile = await installProfile(entry, (p) => {
      const verb = p.phase === "cached" ? "checking cached" : p.phase === "download" ? "downloading" : p.phase === "inflate" ? "unpacking" : "committing";
      ui.progress(`${verb} ${label} — ${(p.loaded / 1048576) | 0} / ${((p.total ?? 0) / 1048576) | 0} MiB`);
    });
    installed.set(id, profile);
  }
  const snapshots = await fetchSnapshotIndex();
  return { runtime, index, installed, snapshots };
}

export async function newSession(
  artifacts: Qed64Artifacts,
  ui: StatusSink,
  onDead: () => void,
): Promise<Qed64Session> {
  // Memory-backed pack segments are TRANSFERRED to the worker at boot and
  // detach page-side; a restarted session must re-install them (an OPFS-
  // backed install revalidates in milliseconds; memory-mode re-downloads).
  for (const [id, profile] of [...artifacts.installed]) {
    const consumed = profile.segments.some((seg) => seg.bytes && seg.bytes.buffer.byteLength === 0);
    if (!consumed) continue;
    const entry = artifacts.index.profiles.find((p) => p.id === id);
    if (!entry) {
      artifacts.installed.delete(id);
      continue;
    }
    ui.busy(`re-preparing the ${id} library for the new session`);
    artifacts.installed.set(
      id,
      await installProfile(entry, (p) => {
        ui.progress(`${p.phase} ${id} — ${(p.loaded / 1048576) | 0} / ${((p.total ?? 0) / 1048576) | 0} MiB`);
      }),
    );
  }
  const packs: LibraryPack[] = [...artifacts.installed.values()].flatMap((p) =>
    p.segments.map((segment, i) => ({
      id: `${p.id}#${i}`,
      ...(segment.blob ? { blob: segment.blob } : {}),
      ...(segment.bytes ? { bytes: segment.bytes } : {}),
      metadata: segment.metadata,
      mountPoint: `/lib/packs/${p.id}`,
    })),
  );
  const searchPath = [...artifacts.installed.keys()].map((id) => `/lib/packs/${id}`).join(":");

  ui.busy("starting Lean");
  const session = new LeanSession();
  session.onLog = (stream: string, text: string) => console.debug(`[lean:${stream}] ${text}`);
  session.onProgress = (p: { phase: string; label?: string }) => ui.progress(p.label ?? p.phase);
  session.onStateChange = (state: string) => {
    if (state === "dead") onDead();
  };
  await session.boot({
    runtime: artifacts.runtime,
    memory: { initialBytes: 256 * 1048576, maximumCandidates: memoryCandidates() },
    leanPath: searchPath,
    packs,
  });
  const qs: Qed64Session = { session, loadedSnapshots: new Set() };
  // The init snapshot makes Init-only worker sessions instant (covering-env
  // aliasing in lean_wasm_lsp_init serves any covered header from it).
  await loadSnapshotByName(artifacts, qs, "init", ui);
  return qs;
}

/** Load a named snapshot into the session's runtime (idempotent). */
export async function loadSnapshotByName(
  artifacts: Qed64Artifacts,
  qs: Qed64Session,
  name: string,
  ui: StatusSink,
): Promise<boolean> {
  if (qs.loadedSnapshots.has(name)) return true;
  const entry = artifacts.snapshots?.snapshots.find((s) => s.name === name);
  if (!entry) return false;
  const gib = (entry.bytes / 1073741824).toFixed(1);
  ui.busy(`loading the ${name === "mathlib" ? "Mathlib" : name} environment (${gib} GiB — once per session, cached in your browser)`);
  try {
    const r = await qs.session.loadSnapshot(entry.url, `${name}.snap`, entry.bytes, snapshotCacheKey(entry));
    if (r.success) qs.loadedSnapshots.add(name);
    return r.success;
  } catch (err) {
    ui.progress(`${name} snapshot failed: ${(err as Error).message}`);
    return false;
  }
}
