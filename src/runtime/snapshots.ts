// Baked environment snapshots.
//
// A snapshot is a compacted-region file produced by the EXACT shipped runtime
// under Node (`npm run bake:snapshot`): loading one seeds the worker's
// environment cache for the ordered header-import list recorded inside it,
// replacing a minutes-long module-closure import with a seconds-long region
// load. The index maps each snapshot to that ordered import list; matching is
// exact — the runtime keys its cache by the precise `import` sequence.

export interface SnapshotEntry {
  name: string;
  url: string;
  /** `sha256:<hex>` of the served (compressed) bytes; also embedded in the
   * content-addressed `url`, which is what makes immutable HTTP caching of
   * snapshots safe across runtime rebuilds. */
  digest?: string;
  /** Raw (uncompressed) region size — what MEMFS must hold. */
  bytes: number;
  /** Compressed transfer size when `url` is gzip-served; absent = raw. */
  transfer?: number;
  /** Ordered header imports the snapshot's environment was baked for;
   * empty = the default no-import (Init) header. */
  imports: string[];
}

export interface SnapshotIndex {
  schema: string;
  snapshots: SnapshotEntry[];
}

export async function fetchSnapshotIndex(url = "/snapshots/index.json"): Promise<SnapshotIndex | null> {
  try {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) return null;
    const index = (await response.json()) as SnapshotIndex;
    if (index.schema !== "qed64.snapshot-index/v1" || !Array.isArray(index.snapshots)) return null;
    for (const entry of index.snapshots) {
      if (
        typeof entry.name !== "string" ||
        typeof entry.url !== "string" ||
        !Array.isArray(entry.imports)
      ) {
        return null;
      }
    }
    return index;
  } catch {
    return null;
  }
}

/** Find the snapshot matching an ordered import list exactly (or the boot
 * snapshot when `imports` is empty). */
export function matchSnapshot(index: SnapshotIndex | null, imports: string[]): SnapshotEntry | null {
  if (!index) return null;
  for (const entry of index.snapshots) {
    if (entry.imports.length !== imports.length) continue;
    let same = true;
    for (let i = 0; i < imports.length; i += 1) {
      if (entry.imports[i] !== imports[i]) {
        same = false;
        break;
      }
    }
    if (same) return entry;
  }
  return null;
}

/** Stable OPFS cache file name for a snapshot. Prefer the content digest:
 * sizes do NOT identify a bake — a rebuilt runtime produces a region of the
 * identical raw size (same environment content, different relocation
 * values), and loading a stale snapshot against a new binary traps "memory
 * access out of bounds". The size-based form remains only for indexes
 * without digests. */
export function snapshotCacheKey(entry: SnapshotEntry): string {
  const safe = entry.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const d = /^sha256:([0-9a-f]{64})$/.exec(entry.digest ?? "");
  if (d) return `${safe}.${d[1]!.slice(0, 16)}.snapz`;
  return `${safe}.${entry.bytes}.${entry.transfer ?? 0}.snapz`;
}
