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
//     onProgress, signal, onBusy and busyWaitMs (silenceMs and workerUrl are
//     the first caller's); an abort detaches only that caller, and the
//     worker is terminated when every caller has aborted;
//   * across tabs: the writer holds the Web Lock `qed64-raw:<cacheKey>` for
//     its whole life. A flight asks for it with ifAvailable first, so "another
//     tab is writing" is the lock's answer, never a guess from how soon a free
//     lock is granted (a task away). Then each caller either returns "busy"
//     (onBusy "return") or waits for the lock, re-probes `.raw` and finds it
//     done (onBusy "wait", what loadSnapshotByName uses).
// On silence or abort the worker is terminated, `.raw.partial` removed (never
// `.raw`), and `.raw` re-probed: a commit that finished just before reports
// "done". After a flight settles no message or timer has any effect. It never
// throws.
import { snapshotCacheKey, type SnapshotEntry, type SnapshotIndex } from "./snapshots";
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

/** How long a network-kind boot failure is remembered (HARDENING #63). */
export const NETWORK_FAILURE_MEMORY_MS = 60_000;
/** Module state every session of this page shares, never the relay's: per
 * cache key (else URL), when a session's boot last failed with a
 * network-kind cause while this entry was among its pre-open loads. A session
 * that finds its entry here downloads the region BEFORE it boots its runtime
 * (qed64-boot.ts downloadBeforeBoot), so a lasting network failure costs the
 * relay's retries no runtime. A completed download clears it; it expires
 * after NETWORK_FAILURE_MEMORY_MS; a reload forgets it. */
const networkFailures = new Map<string, number>();
/** @internal Remember that a boot loading `entry` failed with a network-kind cause at `at`. */
export function noteNetworkFailure(entry: SnapshotEntry, at: number = Date.now()): void { networkFailures.set(snapshotCacheKey(entry), at); }
/** @internal Did a boot loading `entry` fail with a network-kind cause in the last NETWORK_FAILURE_MEMORY_MS? */
export function networkFailedRecently(entry: SnapshotEntry, now: number = Date.now()): boolean {
  const key = snapshotCacheKey(entry), at = networkFailures.get(key);
  if (at === undefined) return false;
  if (now - at < NETWORK_FAILURE_MEMORY_MS) return true;
  networkFailures.delete(key);
  return false;
}
/** @internal Forget it: the region downloaded (or loaded) completely. */
export function clearNetworkFailure(entry: SnapshotEntry): void { networkFailures.delete(snapshotCacheKey(entry)); }

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
  /** Called once when this caller starts waiting for another tab's writer (onBusy "wait"). */
  onBusyWait?(): void;
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

/** `wait` (onBusy "wait" only) starts this caller's wait for another tab's
 * writer: onBusyWait, and busy once its own busyWaitMs runs out. */
interface Caller { onProgress?: PrefetchRawOptions["onProgress"]; wait?(): void; waitTimer?: ReturnType<typeof setTimeout>; resolve(r: PrefetchRawResult): void; done: boolean }
/** `waiting`: another tab holds the lock and this flight is queued for it. */
interface Flight { callers: Set<Caller>; abortAll(): void; closed: boolean; waiting: boolean }
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
  let flight = flights.get(key);
  if (flight?.closed) flight = undefined; // shutting down: never join it
  if (flight?.waiting && opts.onBusy !== "wait") return { status: "busy" }; // queued behind another tab

  return new Promise<PrefetchRawResult>((resolve) => {
    const caller: Caller = {
      onProgress: opts.onProgress,
      resolve: (r) => { if (!caller.done) { caller.done = true; clearTimeout(caller.waitTimer); resolve(r); } },
      done: false,
    };
    // Register the caller BEFORE the flight can start: a lock granted at once
    // must already see who is waiting.
    const fresh = !flight;
    const f: Flight = flight ?? { callers: new Set(), abortAll: () => {}, closed: false, waiting: false };
    if (fresh) flights.set(key, f);
    const detach = (r: PrefetchRawResult) => {
      if (!f.callers.delete(caller)) return;
      caller.resolve(r);
      if (f.callers.size === 0) f.abortAll();
    };
    if (opts.onBusy === "wait") caller.wait = () => {
      try { opts.onBusyWait?.(); } catch { /* an embedder's callback never breaks the flight */ }
      caller.waitTimer = setTimeout(() => detach({ status: "busy" }), opts.busyWaitMs ?? PREFETCH_SILENCE_MS);
    };
    f.callers.add(caller);
    if (f.waiting) caller.wait?.(); // joined a flight already queued behind another tab
    opts.signal?.addEventListener("abort", () => detach({ status: "aborted" }), { once: true });
    if (fresh) {
      const settle = (r: PrefetchRawResult) => {
        close(key, f);
        for (const c of f.callers) c.resolve(r);
      };
      runFlight(entry, key, f, opts).then(settle, (e: unknown) => settle({ status: "error", error: failureCauseOf(e, { stage: "snapshot", subject: entry.name }) }));
    }
  });
}

/** A flight that is settling or shutting down takes no new callers. */
function close(key: string, f: Flight): void {
  f.closed = true;
  if (flights.get(key) === f) flights.delete(key);
}

async function runFlight(entry: SnapshotEntry, key: string, f: Flight, opts: PrefetchRawOptions): Promise<PrefetchRawResult> {
  const locks = (navigator as { locks?: LockManager }).locks;
  if (!locks) return runWorker(entry, key, f, opts);
  const name = `qed64-raw:${key}`;
  const wait = new AbortController();
  f.abortAll = () => { close(key, f); wait.abort(); };
  const write = async (): Promise<PrefetchRawResult> => {
    f.waiting = false;
    for (const c of f.callers) clearTimeout(c.waitTimer);
    if (await isRawCached(entry)) return { status: "done", bytes: entry.bytes }; // another tab finished it
    // After the probe: a last abort during it had no worker to terminate yet.
    if (f.callers.size === 0) return { status: "aborted" };
    return runWorker(entry, key, f, opts);
  };
  try {
    // ifAvailable first: whether another tab is writing is the lock's answer,
    // never a guess from how soon a free lock is granted (a task away).
    const now = await locks.request(name, { ifAvailable: true }, (lock) => lock && write());
    if (now) return now;
    // Another tab is writing this region: "return" callers are answered busy, "wait" callers queue for it.
    for (const c of f.callers) if (!c.wait) { f.callers.delete(c); c.resolve({ status: "busy" }); }
    if (f.callers.size === 0) { close(key, f); return { status: "busy" }; }
    f.waiting = true;
    for (const c of f.callers) c.wait?.();
    return await locks.request(name, { signal: wait.signal }, write);
  } catch {
    return f.callers.size === 0 ? { status: "aborted" } : { status: "busy" }; // the lock wait was cut short
  }
}

function runWorker(entry: SnapshotEntry, key: string, f: Flight, opts: PrefetchRawOptions): Promise<PrefetchRawResult> {
  const silenceMs = opts.silenceMs ?? PREFETCH_SILENCE_MS;
  return new Promise<PrefetchRawResult>((resolve) => {
    let settled = false;
    let bail: ReturnType<typeof setTimeout> | undefined;
    let w: Worker;
    try {
      w = new Worker(opts.workerUrl ?? "/workers/snapshot-prefetch.worker.js");
    } catch (e) {
      resolve({ status: "error", error: { kind: "other", stage: "snapshot", subject: entry.name, code: "WORKER_LOAD_FAILED", message: String((e as Error)?.message ?? e) } });
      return;
    }
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
      close(key, f); // a caller arriving during the cleanup starts afresh
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
