// The raw snapshot region cache (frontend/src/embed/raw-cache.ts;
// docs/EMBEDDING.md §7.4): single-flight per cache key in the page (callers
// share one worker, abort detaches only the caller, the last abort terminates),
// the cross-tab Web Lock (busy "return" vs "wait" + re-probe, decided per
// caller), cleanup on silence/abort (partial removed, never .raw; a commit
// that beat the bail is "done"), a worker that fails to load, late messages,
// same-origin URLs only, and the exported cache helpers. Over a fake Worker,
// OPFS and a LockManager that grants a task later, as browsers do.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCacheKeyOf, isRawCached, prefetchRaw, rawRegionName, removeRawRegion, SNAPSHOT_CACHE_DIR } from "../../frontend/src/embed/raw-cache";
import { snapshotCacheKey, type SnapshotIndex } from "../../src/runtime/snapshots";

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor(readonly url: string) { FakeWorker.all.push(this); }
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  emit(data: unknown) { this.onmessage?.({ data }); }
}
/** OPFS: a map of file name → size; `removed` records removals; `onLookup` runs as a lookup starts. */
class FakeOpfs {
  files = new Map<string, number>();
  removed: string[] = [];
  onLookup?: () => void;
  dir = {
    getFileHandle: async (name: string) => { this.onLookup?.(); if (!this.files.has(name)) throw new Error("NotFoundError"); return { getFile: async () => ({ size: this.files.get(name)! }) }; },
    removeEntry: async (name: string) => { if (!this.files.delete(name)) throw new Error("NotFoundError"); this.removed.push(name); },
  };
}
/** Web Locks as Chromium implements the spec: one holder per name, FIFO
 * waiters, ifAvailable. The callback (with the lock, or null for ifAvailable)
 * is invoked from a LATER TASK, never in the requester's microtasks. An abort
 * before that task rejects and cancels the request (freeing a lock granted
 * meanwhile); after it, nothing. `held.add` / `release` play another tab. */
class FakeLocks {
  held = new Set<string>();
  waiters = new Map<string, Array<() => void>>();
  request(name: string, opts: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (lock: object | null) => unknown): Promise<unknown> {
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let state: "queued" | "granted" | "invoked" = "queued";
      const invoke = (lock: object | null) => setTimeout(() => {
        if (signal?.aborted) return; // cancelled while the grant was on its way
        state = "invoked";
        const waiting = (async () => cb(lock))();
        resolve(waiting);
        if (lock) void waiting.then(() => this.release(name), () => this.release(name));
      }, 0);
      const grant = () => { state = "granted"; this.held.add(name); invoke({ name }); };
      signal?.addEventListener("abort", () => {
        if (state === "invoked") return;
        if (state === "granted") this.release(name);
        else this.waiters.set(name, (this.waiters.get(name) ?? []).filter((g) => g !== grant));
        reject(signal.reason);
      }, { once: true });
      if (!this.held.has(name)) grant();
      else if (opts.ifAvailable) invoke(null);
      else this.waiters.set(name, [...(this.waiters.get(name) ?? []), grant]);
    });
  }
  /** Free `name` and grant it to the next waiter. */
  release(name: string) { this.held.delete(name); this.waiters.get(name)?.shift()?.(); }
}

const entry = { name: "mathlib", url: "/snapshots/mathlib.x.snapz", bytes: 1000, transfer: 400, digest: `sha256:${"ab".repeat(32)}`, imports: [] };
const RAW = rawRegionName(entry)!;
const LOCK = `qed64-raw:${snapshotCacheKey(entry)}`;
let opfs: FakeOpfs;
let locks: FakeLocks | undefined;
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
/** Real timers only: run tasks (a lock grant is one) until `cond` holds. */
const until = async (cond: () => boolean) => { for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 0)); };

function stub({ withLocks = false } = {}) {
  opfs = new FakeOpfs();
  locks = withLocks ? new FakeLocks() : undefined;
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => opfs.dir }) }, ...(locks ? { locks } : {}) });
}
beforeEach(() => { FakeWorker.all = []; vi.stubGlobal("Worker", FakeWorker); stub(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("single flight in this page", () => {
  it("two callers share one worker; each gets its own progress; both get the result", async () => {
    const a: unknown[] = [], b: unknown[] = [];
    const ra = prefetchRaw(entry, { onProgress: (p) => a.push(p.loaded) });
    const rb = prefetchRaw(entry, { onProgress: (p) => b.push(p.loaded) });
    await flush();
    expect(FakeWorker.all).toHaveLength(1);
    FakeWorker.all[0]!.emit({ status: "progress", bytes: 10, total: 1000, phase: "download" });
    FakeWorker.all[0]!.emit({ status: "done", bytes: 1000 });
    await expect(ra).resolves.toEqual({ status: "done", bytes: 1000 });
    await expect(rb).resolves.toEqual({ status: "done", bytes: 1000 });
    expect([a, b]).toEqual([[10], [10]]);
  });
  it("an abort detaches only that caller; the last abort terminates the worker and drops its partial", async () => {
    const ca = new AbortController(), cb = new AbortController();
    const ra = prefetchRaw(entry, { signal: ca.signal });
    const rb = prefetchRaw(entry, { signal: cb.signal });
    await flush();
    const w = FakeWorker.all[0]!;
    opfs.files.set(`${RAW}.partial`, 300);
    ca.abort();
    await expect(ra).resolves.toEqual({ status: "aborted" });
    expect(w.terminated).toBe(false);
    cb.abort();
    await expect(rb).resolves.toEqual({ status: "aborted" });
    expect(w.terminated).toBe(true);
    await flush();
    expect(opfs.removed).toEqual([`${RAW}.partial`]);
    ca.abort(); // idempotent
  });
  it("cached: a complete region spawns nothing; partial-sized is not complete", async () => {
    opfs.files.set(RAW, 1000);
    await expect(prefetchRaw(entry)).resolves.toEqual({ status: "cached", bytes: 1000 });
    expect(FakeWorker.all).toHaveLength(0);
    await expect(isRawCached(entry)).resolves.toBe(true);
    opfs.files.set(RAW, 999);
    await expect(isRawCached(entry)).resolves.toBe(false);
  });
});

describe("silence, load failures, late messages", () => {
  it("silence: terminate, drop the partial (never .raw), and report a commit that beat the bail as done", async () => {
    vi.useFakeTimers();
    const r = prefetchRaw(entry, { silenceMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    const w = FakeWorker.all[0]!;
    opfs.files.set(`${RAW}.partial`, 10);
    opfs.files.set(RAW, 1000); // the worker committed just before the bail
    await vi.advanceTimersByTimeAsync(1000);
    await expect(r).resolves.toEqual({ status: "done", bytes: 1000 });
    expect(w.terminated).toBe(true);
    expect(opfs.removed).toEqual([`${RAW}.partial`]);
    expect(opfs.files.has(RAW)).toBe(true);
  });
  it("silence without a commit is silent; messages after it change nothing", async () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    const r = prefetchRaw(entry, { silenceMs: 1000, onProgress: (p) => seen.push(p) });
    await vi.advanceTimersByTimeAsync(0);
    const w = FakeWorker.all[0]!;
    const handler = w.onmessage;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(r).resolves.toEqual({ status: "silent" });
    expect(w.onmessage).toBeNull();
    handler?.({ data: { status: "progress", bytes: 5, total: 1000 } }); // a late message delivered anyway
    handler?.({ data: { status: "done", bytes: 1000 } });
    expect(seen).toEqual([]);
  });
  it("a worker that fails to load resolves at once with WORKER_LOAD_FAILED", async () => {
    const r = prefetchRaw(entry);
    await flush();
    FakeWorker.all[0]!.onerror?.({ message: "", preventDefault() {} });
    await expect(r).resolves.toMatchObject({ status: "error", error: { code: "WORKER_LOAD_FAILED", stage: "snapshot", subject: "mathlib" } });
  });
  it("a worker refusal keeps its code", async () => {
    const r = prefetchRaw(entry);
    await flush();
    FakeWorker.all[0]!.emit({ status: "error", code: "SNAPSHOT_URL_REFUSED", error: "SNAPSHOT_URL_REFUSED: https://evil.example is not this site" });
    await expect(r).resolves.toMatchObject({ status: "error", error: { code: "SNAPSHOT_URL_REFUSED" } });
  });
});

describe("across tabs (Web Locks)", () => {
  beforeEach(() => stub({ withLocks: true }));
  it("onBusy return: another tab's writer means busy at once", async () => {
    locks!.held.add(LOCK);
    await expect(prefetchRaw(entry)).resolves.toEqual({ status: "busy" });
    expect(FakeWorker.all).toHaveLength(0);
  });
  it("onBusy wait: says so once, waits for the other tab, re-probes, and finds it done without a worker", async () => {
    locks!.held.add(LOCK); // another tab is writing
    const waits: string[] = [];
    const r = prefetchRaw(entry, { onBusy: "wait", onBusyWait: () => waits.push("waiting") });
    await until(() => waits.length > 0);
    opfs.files.set(RAW, 1000); // the other tab committed
    locks!.release(LOCK);
    await expect(r).resolves.toEqual({ status: "done", bytes: 1000 });
    expect(FakeWorker.all).toHaveLength(0);
    expect(waits).toEqual(["waiting"]);
  });
  it("onBusy wait gives up after busyWaitMs", async () => {
    vi.useFakeTimers();
    locks!.held.add(LOCK);
    const r = prefetchRaw(entry, { onBusy: "wait", busyWaitMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(r).resolves.toEqual({ status: "busy" });
    expect(locks!.waiters.get(LOCK)).toEqual([]); // the queued request was withdrawn
  });
  it("the writer holds the lock while its worker runs", async () => {
    const r = prefetchRaw(entry);
    await until(() => FakeWorker.all.length > 0);
    expect(locks!.held.has(LOCK)).toBe(true);
    FakeWorker.all[0]!.emit({ status: "done", bytes: 1000 });
    await r;
    await until(() => locks!.held.size === 0);
    expect(locks!.held.size).toBe(0);
  });
});

describe("review fixes", () => {
  it("a 'wait' caller that joined a 'return' flight keeps waiting when the flight finds another tab writing", async () => {
    stub({ withLocks: true });
    locks!.held.add(LOCK);
    const ret = prefetchRaw(entry); // "return": busy at once
    const waits: string[] = [];
    const waiter = prefetchRaw(entry, { onBusy: "wait", onBusyWait: () => waits.push("waiting") });
    await expect(ret).resolves.toEqual({ status: "busy" });
    await until(() => waits.length > 0);
    opfs.files.set(RAW, 1000);
    locks!.release(LOCK);
    await expect(waiter).resolves.toEqual({ status: "done", bytes: 1000 });
    expect(waits).toEqual(["waiting"]);
  });
  it("a Worker constructor that throws is an error, never busy or a hang", async () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("SecurityError: bad worker URL"); } });
    await expect(prefetchRaw(entry, { workerUrl: "//elsewhere/x.js" })).resolves.toMatchObject({ status: "error", error: { code: "WORKER_LOAD_FAILED" } });
    stub({ withLocks: true });
    vi.stubGlobal("Worker", class { constructor() { throw new Error("SecurityError"); } });
    await expect(prefetchRaw(entry)).resolves.toMatchObject({ status: "error", error: { code: "WORKER_LOAD_FAILED" } });
  });
  it("a caller arriving while an aborted flight cleans up starts a fresh flight", async () => {
    const ac = new AbortController();
    const first = prefetchRaw(entry, { signal: ac.signal });
    await flush();
    ac.abort();
    const second = prefetchRaw(entry);
    await expect(first).resolves.toEqual({ status: "aborted" });
    for (let i = 0; i < 10 && FakeWorker.all.length < 2; i++) await flush();
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1]!.emit({ status: "done", bytes: 1000 });
    await expect(second).resolves.toEqual({ status: "done", bytes: 1000 });
  });
});

describe("busy is the lock's answer, per caller", () => {
  beforeEach(() => stub({ withLocks: true }));
  it("onBusy wait with the lock free never says it is waiting for another tab (the grant is a task away)", async () => {
    const waits: string[] = [];
    const r = prefetchRaw(entry, { onBusy: "wait", onBusyWait: () => waits.push("waiting") });
    await until(() => FakeWorker.all.length > 0);
    FakeWorker.all[0]!.emit({ status: "done", bytes: 1000 });
    await expect(r).resolves.toEqual({ status: "done", bytes: 1000 });
    expect(waits).toEqual([]);
  });
  it("the last caller aborting during the re-probe under the lock spawns no worker and frees the lock", async () => {
    const ac = new AbortController();
    let lookups = 0;
    opfs.onLookup = () => { if (++lookups === 2) ac.abort(); }; // the second .raw probe is the one under the lock
    await expect(prefetchRaw(entry, { signal: ac.signal })).resolves.toEqual({ status: "aborted" });
    await until(() => locks!.held.size === 0);
    expect(FakeWorker.all).toHaveLength(0);
    expect(locks!.held.size).toBe(0);
    expect(lookups).toBe(2);
  });
  it("a 'return' caller is answered busy at once while this page waits for another tab, joining early or late", async () => {
    locks!.held.add(LOCK); // another tab is writing
    const waits: string[] = [], answers: unknown[] = [];
    const waiter = prefetchRaw(entry, { onBusy: "wait", onBusyWait: () => waits.push("waiting") });
    void prefetchRaw(entry).then((r) => answers.push(r)); // joins while the flight still asks for the lock
    await until(() => waits.length > 0);
    await flush();
    void prefetchRaw(entry).then((r) => answers.push(r)); // the flight is waiting now
    await flush(); // microtasks only: no lock task runs before the answer
    expect(answers).toEqual([{ status: "busy" }, { status: "busy" }]);
    opfs.files.set(RAW, 1000);
    locks!.release(LOCK);
    await expect(waiter).resolves.toEqual({ status: "done", bytes: 1000 });
    expect(waits).toEqual(["waiting"]);
  });
  it("each 'wait' caller says so as it starts waiting and keeps its own busyWaitMs", async () => {
    vi.useFakeTimers();
    locks!.held.add(LOCK);
    const said: string[] = [];
    const a = prefetchRaw(entry, { onBusy: "wait", busyWaitMs: 500, onBusyWait: () => said.push("a") });
    await vi.advanceTimersByTimeAsync(0);
    const b = prefetchRaw(entry, { onBusy: "wait", busyWaitMs: 2000, onBusyWait: () => said.push("b") });
    await vi.advanceTimersByTimeAsync(0);
    expect(said).toEqual(["a", "b"]); // b joined a flight that was already waiting
    await vi.advanceTimersByTimeAsync(500);
    await expect(a).resolves.toEqual({ status: "busy" });
    opfs.files.set(RAW, 1000);
    locks!.release(LOCK); // b is still queued for the lock
    await vi.advanceTimersByTimeAsync(0);
    await expect(b).resolves.toEqual({ status: "done", bytes: 1000 });
    expect(FakeWorker.all).toHaveLength(0);
  });
});

describe("same origin only, and the helpers", () => {
  it("refuses an entry URL on another origin before any worker", async () => {
    vi.stubGlobal("location", { origin: "http://localhost:5199" });
    await expect(prefetchRaw({ ...entry, url: "//evil.example/x.snapz" })).resolves.toMatchObject({ status: "error", error: { code: "SNAPSHOT_URL_REFUSED" } });
    expect(FakeWorker.all).toHaveLength(0);
  });
  it("names, ownership and removal", async () => {
    const index: SnapshotIndex = { schema: "qed64.snapshot-index/v1", snapshots: [entry] };
    const key = snapshotCacheKey(entry);
    expect(SNAPSHOT_CACHE_DIR).toBe("qed64-snapshots");
    expect(RAW).toBe(`${key}.raw`);
    for (const f of [key, `${key}.partial`, `${key}.raw`, `${key}.raw.partial`]) expect(isCacheKeyOf(f, index), f).toBe(true);
    expect(isCacheKeyOf("mathlib.0000000000000000.snapz.raw", index)).toBe(false);
    opfs.files.set(RAW, 1000);
    opfs.files.set(`${RAW}.partial`, 1);
    await expect(removeRawRegion(entry)).resolves.toBe(true);
    expect(opfs.files.size).toBe(0);
  });
});
