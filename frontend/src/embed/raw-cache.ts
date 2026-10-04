// The raw (inflated) snapshot region cache in OPFS, and the one way to fill it
// (docs/EMBEDDING.md §7.4).
//
// A Lean worker sync-reads `<cacheKey>.raw` straight into its heap; producing
// that file — download + gunzip — happens in a disposable prefetch worker whose
// heap dies when it is done (a Lean worker that streams and inflates itself
// measured ~4.6 GB heavier for its whole life). Since W5 the prefetch worker is
// the only writer of `.raw`, through `<cacheKey>.raw.partial` and a rename.
//
// prefetchRaw is single-flight per cache key:
//   * in this page: callers of one key share one worker; each keeps its own
//     onProgress and signal; an abort detaches only that caller, and the
//     worker is terminated when every caller has aborted;
//   * across tabs: the writer holds the Web Lock `qed64-raw:<cacheKey>` for
//     its whole life; a second tab either returns "busy" (onBusy "return") or
//     waits for the lock, re-probes `.raw` and finds it done (onBusy "wait",
//     what loadSnapshotByName uses).
// On silence or abort the worker is terminated, `.raw.partial` removed (never
// `.raw`), and `.raw` re-probed: a commit that finished just before reports
// "done". After a flight settles no message or timer has any effect. It never
// throws.
import { snapshotCacheKey, type SnapshotEntry, type SnapshotIndex } from "../../../src/runtime/snapshots";
import { failureCauseOf, type FailureCause } from "./failure";

/** The OPFS directory of the snapshot caches. */
export const SNAPSHOT_CACHE_DIR = "qed64-snapshots";
/** How long a prefetch may go without a message before the page stops
 * waiting for it (it reports every 500 ms while bytes arrive; HARDENING #54). */
export const PREFETCH_SILENCE_MS = 3 * 60 * 1000;

/** The raw region's file name in SNAPSHOT_CACHE_DIR, or null for an entry with no cache key. */
export function rawRegionName(entry: SnapshotEntry): string | null {
  const key = snapshotCacheKey(entry);
  return key ? `${key}.raw` : null;
}

/** Does a file in SNAPSHOT_CACHE_DIR belong to an entry of `index` (its
 * compressed copy, its raw region, or either one's partial)? Everything else
 * there is a stale bake a sweep may remove. */
export function isCacheKeyOf(fileName: string, index: SnapshotIndex): boolean {
  const base = fileName.replace(/(\.raw)?(\.partial)?$/, "");
  return index.snapshots.some((e) => snapshotCacheKey(e) === base);
}

async function cacheDir(create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(SNAPSHOT_CACHE_DIR, { create });
  } catch { return null; }
}

/** Is the entry's raw region complete in OPFS? (null: no OPFS here) */
export async function isRawCached(entry: SnapshotEntry): Promise<boolean | null> {
  const name = rawRegionName(entry);
  const dir = await cacheDir(true);
  if (!dir || !name) return dir ? false : null;
  try { return (await (await dir.getFileHandle(name)).getFile()).size === entry.bytes; } catch { return false; }
}

/** Remove the entry's raw region (and its partial). Resolves whether anything was removed. */
export async function removeRawRegion(entry: SnapshotEntry): Promise<boolean> {
  const name = rawRegionName(entry);
  const dir = await cacheDir(false);
  if (!dir || !name) return false;
  let removed = false;
  for (const f of [name, `${name}.partial`]) {
    try { await dir.removeEntry(f); removed = true; } catch { /* absent or locked */ }
  }
  return removed;
}

export interface PrefetchRawOptions {
  /** `loaded`: bytes of the inflated region written so far; `total`: the
   * entry's raw size. `step` "inflate": the source is a local compressed copy
   * (no network); "download": the network. */
  onProgress?(p: { loaded: number; total: number; step: "download" | "inflate" }): void;
  signal?: AbortSignal;
  /** Give up after this long without a message (default PREFETCH_SILENCE_MS). */
  silenceMs?: number;
  workerUrl?: string;
  /** Another tab is writing this region: "wait" for it (at most `busyWaitMs`,
   * default PREFETCH_SILENCE_MS) and re-probe, or "return" busy at once. */
  onBusy?: "wait" | "return";
  busyWaitMs?: number;
}
export interface PrefetchRawResult {
  /** cached: complete before the call (no worker spawned); done: complete now;
   * unavailable: no OPFS or no cache key, or the worker could not use storage;
   * busy: another writer holds the region; silent: no message for silenceMs;
   * aborted: this caller's signal; error: the worker failed (`error` says how). */
  status: "cached" | "done" | "unavailable" | "busy" | "silent" | "aborted" | "error";
  bytes?: number;
  error?: FailureCause;
}

interface Caller { onProgress?: PrefetchRawOptions["onProgress"]; resolve(r: PrefetchRawResult): void; done: boolean }
interface Flight { callers: Set<Caller>; abortAll(): void }
const flights = new Map<string, Flight>();

const refused = (entry: SnapshotEntry, why: string): PrefetchRawResult =>
  ({ status: "error", error: { kind: "other", stage: "snapshot", subject: entry.name, code: "SNAPSHOT_URL_REFUSED", message: why } });

export async function prefetchRaw(entry: SnapshotEntry, opts: PrefetchRawOptions = {}): Promise<PrefetchRawResult> {
  const key = snapshotCacheKey(entry);
  if (!key) return { status: "unavailable" };
  if (opts.signal?.aborted) return { status: "aborted" };
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (origin) {
    let target: URL | null = null;
    try { target = new URL(entry.url, origin); } catch { /* not a URL */ }
    if (!target || target.origin !== origin) return refused(entry, `${target?.origin ?? "an invalid URL"} is not this site`);
  }
  const cached = await isRawCached(entry);
  if (cached === null) return { status: "unavailable" };
  if (cached) return { status: "cached", bytes: entry.bytes };
  if (opts.signal?.aborted) return { status: "aborted" };

  return new Promise<PrefetchRawResult>((resolve) => {
    const caller: Caller = { onProgress: opts.onProgress, resolve: (r) => { if (!caller.done) { caller.done = true; resolve(r); } }, done: false };
    // Register the caller BEFORE the flight can start: a lock granted at once
    // must already see who is waiting.
    let flight = flights.get(key);
    const fresh = !flight;
    if (!flight) {
      flight = { callers: new Set(), abortAll: () => {} };
      flights.set(key, flight);
    }
    const f = flight;
    f.callers.add(caller);
    opts.signal?.addEventListener("abort", () => {
      f.callers.delete(caller);
      caller.resolve({ status: "aborted" });
      if (f.callers.size === 0) f.abortAll();
    }, { once: true });
    if (fresh) {
      void runFlight(entry, key, f, opts).then((r) => {
        if (flights.get(key) === f) flights.delete(key);
        for (const c of f.callers) c.resolve(r);
      });
    }
  });
}

async function runFlight(entry: SnapshotEntry, key: string, f: Flight, opts: PrefetchRawOptions): Promise<PrefetchRawResult> {
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks) return runWorker(entry, key, f, opts);
  const onBusy = opts.onBusy ?? "return";
  const wait = new AbortController();
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  if (onBusy === "wait") waitTimer = setTimeout(() => wait.abort(), opts.busyWaitMs ?? PREFETCH_SILENCE_MS);
  f.abortAll = () => wait.abort();
  try {
    return await locks.request(`qed64-raw:${key}`, onBusy === "wait" ? { signal: wait.signal } : { ifAvailable: true }, async (lock) => {
      clearTimeout(waitTimer);
      if (!lock) return { status: "busy" } as PrefetchRawResult;
      if (f.callers.size === 0) return { status: "aborted" } as PrefetchRawResult;
      if (await isRawCached(entry)) return { status: "done", bytes: entry.bytes } as PrefetchRawResult; // another tab finished it
      return runWorker(entry, key, f, opts);
    });
  } catch {
    clearTimeout(waitTimer);
    return f.callers.size === 0 ? { status: "aborted" } : { status: "busy" }; // the lock wait was cut short
  }
}

function runWorker(entry: SnapshotEntry, key: string, f: Flight, opts: PrefetchRawOptions): Promise<PrefetchRawResult> {
  const silenceMs = opts.silenceMs ?? PREFETCH_SILENCE_MS;
  return new Promise<PrefetchRawResult>((resolve) => {
    let settled = false;
    let bail: ReturnType<typeof setTimeout> | undefined;
    const w = new Worker(opts.workerUrl ?? "/workers/snapshot-prefetch.worker.js");
    const finish = (r: PrefetchRawResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(bail);
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
      resolve(r);
    };
    /** Silence or abort: the worker is gone; drop its partial, and report a commit that beat us to it. */
    const giveUp = (status: "silent" | "aborted") => {
      if (settled) return;
      settled = true;
      clearTimeout(bail);
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
      void (async () => {
        const dir = await cacheDir(false);
        try { await dir?.removeEntry(`${key}.raw.partial`); } catch { /* absent or held */ }
        resolve((await isRawCached(entry)) ? { status: "done", bytes: entry.bytes } : { status });
      })();
    };
    const arm = () => {
      clearTimeout(bail);
      bail = setTimeout(() => giveUp("silent"), silenceMs);
    };
    f.abortAll = () => giveUp("aborted");
    w.onerror = (e: ErrorEvent) => {
      if (settled) return;
      e.preventDefault?.();
      finish({ status: "error", error: { kind: "other", stage: "snapshot", subject: entry.name, code: "WORKER_LOAD_FAILED", message: e.message || "the prefetch worker failed to load" } });
    };
    w.onmessage = (e: MessageEvent) => {
      if (settled) return; // after the flight settled, nothing a worker says matters
      const m = e.data as { status?: string; code?: string; bytes?: number; total?: number; phase?: string; error?: string };
      if (m.status === "progress") {
        arm();
        for (const c of f.callers) c.onProgress?.({ loaded: m.bytes ?? 0, total: m.total ?? entry.bytes, step: m.phase === "inflate" ? "inflate" : "download" });
        return;
      }
      if (m.status === "error" || m.status === "unavailable" || m.status === "busy") {
        const cause = failureCauseOf(Object.assign(new Error(m.error ?? m.status), m.code ? { code: m.code } : {}), { stage: "snapshot", subject: entry.name });
        return finish({ status: m.status, error: cause });
      }
      finish({ status: "done", bytes: m.bytes ?? entry.bytes });
    };
    arm();
    w.postMessage({ url: entry.url, cacheKey: key, rawBytes: entry.bytes });
  });
}
