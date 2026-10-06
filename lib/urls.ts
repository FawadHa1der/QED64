// The URLs an offline cache (a service worker's warm-up) needs for one runtime
// (docs/EMBEDDING.md §7.5). Snapshot and profile URLs stay with their indexes
// (`SnapshotEntry.url`, a profile manifest's parts).
import type { RuntimeManifest } from "./client";

/** The worker scripts a page spawns or a worker `importScripts`, by served path. */
export const WORKER_URLS: readonly string[] = Object.freeze([
  "/workers/lean.worker.js",
  "/workers/lsp-frames.js",
  "/workers/lsp-front-door.js",
  "/workers/memory64-probe.js",
  "/workers/snapshot-prefetch.worker.js",
]);

export function runtimeUrls(manifest: RuntimeManifest): { manifests: string[]; chunks: string[]; workers: string[] } {
  return {
    // The immutable per-build copy first (what a pinned shell fetches), then
    // the mutable pointer a shell without a pin falls back to.
    manifests: [`/runtime/runtime-manifest.${manifest.buildId}.json`, "/runtime/runtime-manifest.json"],
    chunks: [...new Set((["lean.js", "lean.wasm"] as const).flatMap((f) => manifest.files[f]?.chunks.map((c) => c.url) ?? []))],
    workers: [...WORKER_URLS],
  };
}
