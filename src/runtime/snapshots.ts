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
  /** Module-name roots this entry's environment serves, matched on a
   * component boundary (`HasseView` covers `HasseView.Foo`, never
   * `HasseView2`): the page boots, or widens a running session, to the entry
   * for a header naming one (docs/EMBEDDING.md §8). Advisory — the kernel's
   * header verdict stays authoritative. Absent: the legacy rule (the entry
   * named `mathlib` serves the umbrella roots; any other serves none). */
  roots?: string[];
  /** Human name for the pill and boot card ("Mathlib + widgets"). */
  label?: string;
  /** Initial Memory64 commit (bytes) when this entry is among a session's loads. */
  initialBytes?: number;
}

export interface SnapshotIndex {
  schema: string;
  snapshots: SnapshotEntry[];
}

/** A module-name root: dotted identifier components, no wildcard. */
const ROOT = /^[A-Za-z_][\w']*(?:\.[A-Za-z_][\w']*)*$/;

export interface IndexOptions {
  /** Accept an index, or entry URLs, on another origin. Off by default: a
   * region is committed to this site's storage under the key the index names
   * and loaded on every later visit (docs/EMBEDDING.md §4, HARDENING #57). */
  allowCrossOrigin?: boolean;
  /** The page's origin (default `location.origin`; no check when neither is known). */
  origin?: string;
}

/** The index, or a thrown Error naming what is wrong with it (an HTTP status,
 * a body that is not JSON, a schema or entry that does not validate, an index
 * or entry URL on another origin). */
export async function loadSnapshotIndex(url = "/snapshots/index.json", opts: IndexOptions = {}): Promise<SnapshotIndex> {
  const origin = opts.origin ?? (globalThis as { location?: { origin?: string } }).location?.origin;
  const indexUrl = origin ? new URL(url, origin) : null;
  const foreign = (u: URL | null) => !opts.allowCrossOrigin && !!origin && (!u || u.origin !== new URL(origin).origin);
  if (foreign(indexUrl)) throw Object.assign(new Error(`${url}: not on this site`), { code: "SNAPSHOT_URL_REFUSED", indexFault: "refused" as const });
  const response = await fetch(url, { cache: "no-cache" });
  if (foreign(response.redirected && response.url ? new URL(response.url) : indexUrl)) {
    throw Object.assign(new Error(`${url}: redirected off this site`), { code: "SNAPSHOT_URL_REFUSED", indexFault: "refused" as const });
  }
  if (!response.ok) {
    const st = response.status;
    const gone = st >= 400 && st < 500 && st !== 408 && st !== 425 && st !== 429; // the server does not have it: a deploy problem
    throw Object.assign(new Error(`${url}: HTTP ${st}`), { indexFault: gone ? "missing" as const : "network" as const });
  }
  const body = await response.text();
  if (/^\s*</.test(body)) throw Object.assign(new Error(`${url}: the server answered HTML, not an index`), { indexFault: "missing" as const });
  let index: SnapshotIndex;
  try { index = JSON.parse(body) as SnapshotIndex; } catch { throw Object.assign(new Error(`${url}: not JSON`), { indexFault: "corrupt" as const }); }
  if (index?.schema !== "qed64.snapshot-index/v1" || !Array.isArray(index.snapshots)) {
    throw Object.assign(new Error(`${url}: not a qed64.snapshot-index/v1 index`), { indexFault: "corrupt" as const });
  }
  for (const entry of index.snapshots) {
    if (
      typeof entry.name !== "string" ||
      typeof entry.url !== "string" ||
      !Array.isArray(entry.imports) ||
      (entry.runtime !== undefined && typeof entry.runtime !== "string") ||
      (entry.roots !== undefined && (!Array.isArray(entry.roots) || !entry.roots.every((r) => typeof r === "string" && ROOT.test(r)))) ||
      (entry.label !== undefined && typeof entry.label !== "string") ||
      (entry.initialBytes !== undefined && !(typeof entry.initialBytes === "number" && Number.isFinite(entry.initialBytes) && entry.initialBytes > 0))
    ) {
      throw Object.assign(new Error(`${url}: malformed entry ${JSON.stringify(entry?.name ?? null)}`), { indexFault: "corrupt" as const });
    }
    let entryUrl: URL | null = null;
    try { entryUrl = indexUrl ? new URL(entry.url, indexUrl) : null; } catch { /* not a URL */ }
    if (foreign(entryUrl)) {
      throw Object.assign(new Error(`${url}: entry ${JSON.stringify(entry.name)} points off this site (${entryUrl?.origin ?? entry.url})`), { code: "SNAPSHOT_URL_REFUSED", indexFault: "refused" as const });
    }
  }
  return index;
}

/** The index, or null when it is missing, malformed or off this site. */
export async function fetchSnapshotIndex(url = "/snapshots/index.json", opts: IndexOptions = {}): Promise<SnapshotIndex | null> {
  try {
    return await loadSnapshotIndex(url, opts);
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

// ---------------------------------------------------------------------------
// Overlay environments (docs/EMBEDDING.md §8): which entries a header needs.
// Pure functions of the index; the page's boot policy and its self-widen use
// them, so an overlay index that declares `roots` is booted and widened to by
// itself, and an index without them behaves exactly as before.

/** The roots the umbrella snapshot serves (patch 0032 K1: `QED64.Essential`
 * covers every Mathlib/Batteries module in the essential profile, and the
 * tutorial aliases Mathlib, Mathlib.Tactic, Batteries, MIL.Common). */
export const LEGACY_UMBRELLA_ROOTS: readonly string[] = Object.freeze(["Mathlib", "Batteries", "MIL", "QED64"]);
/** The entries every session loads first. */
export const BASE_SNAPSHOTS: readonly string[] = Object.freeze(["init"]);

const MiB = 1048576;

export function entryRoots(e: SnapshotEntry): readonly string[] {
  return e.roots ?? (e.name === "mathlib" ? LEGACY_UMBRELLA_ROOTS : []);
}
export const coversModule = (roots: readonly string[], module: string): boolean =>
  roots.some((r) => module === r || module.startsWith(`${r}.`));
const isInit = (m: string) => m === "Init" || m.startsWith("Init.");

/** The snapshot list for a header's modules: the base, plus at most ONE
 * other entry — the kernel serves a header from one environment that covers
 * the whole key, and every region is a full-size allocation in the heap, so a
 * second heavy region never helps. The smallest entry covering every module
 * the base does not; failing that, the one covering the most (ties: smaller)
 * — a mixed header still boots the umbrella and the kernel names the module
 * it cannot cover; none covering any: the base alone. */
export function chooseSnapshots(index: SnapshotIndex, modules: readonly string[], base: readonly string[] = BASE_SNAPSHOTS): string[] {
  const baseRoots = index.snapshots.filter((e) => base.includes(e.name)).flatMap((e) => [...entryRoots(e)]);
  const required = [...new Set(modules)].filter((m) => !isInit(m) && !coversModule(baseRoots, m));
  if (required.length === 0) return [...base];
  let best: { e: SnapshotEntry; covered: number } | null = null;
  for (const e of index.snapshots) {
    if (base.includes(e.name)) continue;
    const roots = entryRoots(e);
    const covered = required.filter((m) => coversModule(roots, m)).length;
    if (covered === 0) continue;
    if (!best || covered > best.covered || (covered === best.covered && e.bytes < best.e.bytes)) best = { e, covered };
  }
  return best ? [...base, best.e.name] : [...base];
}

/** The entry to widen a running session to when the kernel refused its header
 * for `missing` modules: the smallest entry not already loaded that covers
 * EVERY one of them — and, given the header's modules, every one of those the
 * base does not serve (the new session serves the whole header from ONE
 * environment: an entry covering only what is missing NOW would be refused
 * for what the old session covered, and widening back would loop) — else null
 * (a near-miss root never widens: no snapshot would change the verdict). */
export function widenTarget(index: SnapshotIndex, missing: readonly string[], loaded: readonly string[], headerModules: readonly string[] = [], base: readonly string[] = BASE_SNAPSHOTS): SnapshotEntry | null {
  if (missing.length === 0) return null;
  const baseRoots = index.snapshots.filter((e) => base.includes(e.name)).flatMap((e) => [...entryRoots(e)]);
  const required = [...new Set([...missing, ...headerModules])].filter((m) => !isInit(m) && !coversModule(baseRoots, m));
  let best: SnapshotEntry | null = null;
  for (const e of index.snapshots) {
    if (loaded.includes(e.name)) continue;
    const roots = entryRoots(e);
    if (required.every((m) => coversModule(roots, m)) && (!best || e.bytes < best.bytes)) best = e;
  }
  return best;
}

/** The initial commit for a session loading `names`: the largest
 * `initialBytes` an entry among them declares; else 2 GiB when any non-base
 * entry is loaded (growing a shared Memory64 by gigabytes in many steps while
 * a region streams is the path that crashed renderers); else 256 MiB. */
export function initialBytesForEntries(index: SnapshotIndex | null, names: readonly string[], base: readonly string[] = BASE_SNAPSHOTS): number {
  const declared = (index?.snapshots ?? []).filter((e) => names.includes(e.name) && typeof e.initialBytes === "number").map((e) => e.initialBytes!);
  // An index is data: its hint is capped like ?memory= (the session's reservation ladder reconciles the rest).
  if (declared.length > 0) return Math.min(6 * 1024 * MiB, Math.max(...declared));
  return names.some((n) => !base.includes(n)) ? 2048 * MiB : 256 * MiB;
}

/** The pill/card name of an entry. */
export const entryLabel = (e: Pick<SnapshotEntry, "name" | "label">): string => e.label ?? (e.name === "mathlib" ? "Mathlib" : e.name);
