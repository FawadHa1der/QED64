// Baked environment snapshots.
//
// A snapshot is a compacted-region file produced by the EXACT shipped runtime
// under Node (`npm run bake:snapshot`): loading one seeds the worker's
// environment cache for the ordered header-import list recorded inside it,
// replacing a minutes-long module-closure import with a seconds-long region
// load. The index records each snapshot's ordered import list and the
// runtime that baked it; the resident kernel resolves headers against the
// loaded environments itself (patch 0032 K1), so nothing page-side matches
// import lists any more.

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
  /** `buildId` of the runtime that baked this region (snapshots are
   * function-table-paired to one binary). Written by bake-snapshot.mjs;
   * absent only in indexes that predate the field, which the preflight
   * reports as "no pairing fact" rather than as a match. */
  runtime?: string;
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
        !Array.isArray(entry.imports) ||
        (entry.runtime !== undefined && typeof entry.runtime !== "string")
      ) {
        return null;
      }
    }
    return index;
  } catch {
    return null;
  }
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
