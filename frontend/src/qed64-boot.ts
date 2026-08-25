// Minimal QED64 runtime boot for the lean4web-style front end: fetch the
// runtime manifest + profile index, install the core profile (OPFS-cached
// after the first visit), and boot the persistent Lean worker session. This
// is the app shell's installAndBoot/bootSession flow with the UI stripped.
import { LeanSession, memoryCandidates, type LibraryPack, type RuntimeManifest } from "../../src/runtime/client";
import { fetchProfileIndex, installProfile, type InstalledProfile } from "../../src/install/profiles";

export interface BootedQed64 {
  session: LeanSession;
  runtime: RuntimeManifest;
  installed: Map<string, InstalledProfile>;
}

export async function bootQed64(onStatus: (line: string) => void): Promise<BootedQed64> {
  onStatus("fetching manifests…");
  const index = await fetchProfileIndex();
  if (!index) throw new Error("profile index missing (/profiles/index.json)");
  const manifestResponse = await fetch("/runtime/runtime-manifest.json", { cache: "no-cache" });
  if (!manifestResponse.ok) throw new Error(`runtime manifest: HTTP ${manifestResponse.status}`);
  const runtime = (await manifestResponse.json()) as RuntimeManifest;

  const installed = new Map<string, InstalledProfile>();
  const core = index.profiles.find((p) => p.id === "core");
  if (!core) throw new Error("core profile not published");
  onStatus("installing Lean core library…");
  const profile = await installProfile(core, (p) => {
    onStatus(`${p.phase} core — ${(p.loaded / 1048576) | 0} / ${((p.total ?? 0) / 1048576) | 0} MiB`);
  });
  installed.set("core", profile);

  const packs: LibraryPack[] = [...installed.values()].flatMap((p) =>
    p.segments.map((segment, i) => ({
      id: `${p.id}#${i}`,
      ...(segment.blob ? { blob: segment.blob } : {}),
      ...(segment.bytes ? { bytes: segment.bytes } : {}),
      metadata: segment.metadata,
      mountPoint: `/lib/packs/${p.id}`,
    })),
  );
  const searchPath = [...installed.keys()].map((id) => `/lib/packs/${id}`).join(":");

  onStatus(`booting runtime ${runtime.buildId}…`);
  const session = new LeanSession();
  session.onLog = (stream: string, text: string) => console.debug(`[lean:${stream}] ${text}`);
  session.onProgress = (p: { phase: string; label?: string }) => onStatus(p.label ?? p.phase);
  const ready = await session.boot({
    runtime,
    memory: { initialBytes: 256 * 1048576, maximumCandidates: memoryCandidates() },
    leanPath: searchPath,
    packs,
  });
  onStatus(`Lean ready (${ready.mode})`);
  return { session, runtime, installed };
}
