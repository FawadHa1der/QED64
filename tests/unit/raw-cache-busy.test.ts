// A busy raw-cache handle is retried before the Lean worker streams the snapshot (architecture review R2 part 1).
// The prefetch worker is the sole writer of `qed64-snapshots/<cacheKey>.raw`; the Lean worker's loadSnapshot opens a
// sync access handle on it. A sync handle is exclusive per file wherever the browser does not know `mode`, so while
// another context holds one (an older worker's exclusive handle, or a predecessor tab's worker caught mid-read until
// Blink terminates it, within 2 s) the open throws. It used to fall straight to the network: a .snapz fetch and an
// inflate in the Lean worker's own heap, the heavier path the cache exists to avoid. openRawSnapshot now opens
// read-only (shared where Chromium 121+ knows the mode) and retries a busy open with async sleeps for
// RAW_BUSY.waitMs, then logs `[boot] raw cache busy: …` once and streams. A missing `.raw` streams at once.
//
// The REAL lean.worker.js in a vm sandbox (the short-transfer.test.ts pattern): loadSnapshot over a fake heap
// (frontDoor.host) and a fake OPFS whose every method awaits a macrotask before acting, as a browser's does
// (HARDENING #58: a fake that answers synchronously hides ordering bugs). No wasm, no browser.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

const workers = path.resolve(__dirname, "../../public/workers");
const ORIGIN = "http://localhost:5295";
const URL_ = "/snapshots/init.k.snapz";
const CACHE_KEY = "init.k";
const RAW_NAME = `${CACHE_KEY}.raw`;

/** A region: the "olean" magic, then deterministic bytes. */
function region(n: number): Uint8Array {
  const out = new Uint8Array(n);
  out.set([0x6f, 0x6c, 0x65, 0x61, 0x6e]);
  let x = 0x2545f491;
  for (let i = 5; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const RAW = region(200_000);
const GZ = new Uint8Array(zlib.gzipSync(RAW));

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const named = (name: string, message: string) => Object.assign(new Error(message), { name });

interface CachedFile {
  /** The bytes the file holds (its `getFile().size` and the handle's region). */
  bytes: Uint8Array;
  /** The first this-many `createSyncAccessHandle` calls throw (`Infinity`: every one). */
  busyCalls?: number;
  /** The name of the error a busy open throws (default Chromium's lock error). */
  errorName?: string;
}

/** A fake OPFS root with the `qed64-snapshots` directory; `files` holds the cached entries. Every method awaits a
 * macrotask before acting (#58). `opens` records the options of each createSyncAccessHandle call. */
function fakeOpfs(files: Record<string, CachedFile>) {
  const opens: unknown[] = [];
  const removed: string[] = [];
  const dir = {
    async getFileHandle(name: string) {
      await tick();
      const f = files[name];
      if (!f) throw named("NotFoundError", `A requested file or directory could not be found: ${name}`);
      return {
        async getFile() { await tick(); return { size: f.bytes.length }; },
        async createSyncAccessHandle(opts?: unknown) {
          await tick();
          opens.push(opts);
          if (opens.length <= (f.busyCalls ?? 0)) throw named(f.errorName ?? "NoModificationAllowedError", "Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.");
          return {
            getSize: () => f.bytes.length,
            read(view: Uint8Array, { at }: { at: number }) {
              const n = Math.max(0, Math.min(view.length, f.bytes.length - at));
              view.set(f.bytes.subarray(at, at + n));
              return n;
            },
            close() {},
          };
        },
      };
    },
    async removeEntry(name: string) { await tick(); removed.push(name); delete files[name]; },
  };
  const root = { async getDirectoryHandle() { await tick(); return dir; } };
  return { opens, removed, navigator: { storage: { getDirectory: async () => { await tick(); return root; } } } };
}

type Posted = { type: string; requestId?: string | null; kind?: string; phase?: string; text?: string; error?: { code: string; message: string } };
interface Hooks {
  frontDoor: { host(h: { state?: string; M?: unknown; memory?: unknown }): void };
  rawCache: { RAW_BUSY: { waitMs: number; retryMs: number } };
}

/** The real worker in a fresh sandbox over `files`, a counted fetch of the .snapz, and a fake heap whose region
 * "load" stops the run once it has the bytes. `bound` shortens RAW_BUSY in this sandbox (undefined: the defaults). */
function leanWorker(files: Record<string, CachedFile>, bound?: { waitMs: number; retryMs: number }) {
  const opfs = fakeOpfs(files);
  const fetches: number[] = [];
  const posted: Array<Posted & { at: number }> = [];
  const listeners: Record<string, (e: { data: unknown }) => void> = {};
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, Headers, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
    ReadableStream, WritableStream, TransformStream, DecompressionStream,
    setTimeout, clearTimeout, clearInterval,
    setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref(); return t; },
    location: new URL(`${ORIGIN}/workers/lean.worker.js`),
    navigator: opfs.navigator,
    fetch: async () => {
      fetches.push(performance.now());
      const body = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < GZ.length; i += 65536) c.enqueue(GZ.slice(i, i + 65536)); c.close(); } });
      return { ok: true, status: 200, redirected: false, url: `${ORIGIN}${URL_}`, headers: new Headers({ "content-type": "application/octet-stream", "content-length": String(GZ.length) }), body };
    },
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: Posted) => posted.push({ ...m, at: performance.now() });
  sandbox.addEventListener = (type: string, fn: (e: { data: unknown }) => void) => { listeners[type] = fn; };
  sandbox.crossOriginIsolated = true;
  sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  const hooks = (sandbox as { __qed64TestExports?: Hooks }).__qed64TestExports!;
  if (bound) Object.assign(hooks.rawCache.RAW_BUSY, bound);
  const memory = { buffer: new SharedArrayBuffer(RAW.length + 64) };
  const loaded: Array<{ ptr: bigint; bytes: bigint }> = [];
  hooks.frontDoor.host({
    state: "ready",
    memory,
    M: {
      _malloc: () => 16n,
      _free: () => {},
      _lean_wasm_load_snapshot_mem: (ptr: bigint, bytes: bigint) => { loaded.push({ ptr, bytes }); throw new Error("stop: the region arrived"); },
    },
  });
  /** One loadSnapshot of the cached key; resolves when the request settles, with its start time. */
  async function load(): Promise<{ started: number; error?: { code: string; message: string } }> {
    const requestId = "snap-1";
    const started = performance.now();
    listeners.message!({ data: { protocol: 1, requestId, type: "loadSnapshot", input: { url: URL_, name: "init.snap", expectedBytes: RAW.length, cacheKey: CACHE_KEY } } });
    const settled = () => posted.find((m) => m.requestId === requestId && (m.type === "error" || m.type === "result"));
    await expect.poll(settled, { timeout: 10_000, interval: 10 }).toBeTruthy();
    return { started, ...settled()! };
  }
  const busyLines = () => posted.filter((m) => m.type === "event" && m.kind === "log" && /raw cache busy/.test(m.text ?? ""));
  const phases = () => new Set(posted.filter((m) => m.type === "event" && m.kind === "progress").map((m) => m.phase));
  return { hooks, opfs, fetches, posted, loaded, memory, load, busyLines, phases };
}

/** The bound each case runs under: short, so a "busy forever" case settles in well under a second. */
const SHORT = { waitMs: 300, retryMs: 20 };
const arrived = (w: ReturnType<typeof leanWorker>) => new Uint8Array(w.memory.buffer, 16, RAW.length);

describe("lean.worker.js openRawSnapshot: a busy raw-cache handle is retried before the snapshot is streamed (R2)", () => {
  it("the default bound outlasts Blink's 2 s worker termination, in short async sleeps", () => {
    const { hooks } = leanWorker({});
    expect(hooks.rawCache.RAW_BUSY.waitMs).toBeGreaterThanOrEqual(3000);
    expect(hooks.rawCache.RAW_BUSY.retryMs).toBeGreaterThan(0);
    expect(hooks.rawCache.RAW_BUSY.retryMs).toBeLessThan(hooks.rawCache.RAW_BUSY.waitMs);
  });

  it("busy for two opens, then free: the region comes from the cache, byte-exact, and nothing is fetched or logged", async () => {
    const w = leanWorker({ [RAW_NAME]: { bytes: RAW, busyCalls: 2 } }, SHORT);
    const r = await w.load();
    expect(r.error).toMatchObject({ code: "SNAPSHOT_FAILED", message: "stop: the region arrived" });
    expect(w.loaded).toEqual([{ ptr: 16n, bytes: BigInt(RAW.length) }]);
    expect(arrived(w)).toEqual(RAW);
    expect(w.fetches).toHaveLength(0);
    expect(w.busyLines()).toHaveLength(0);
    expect(w.phases().has("snapshot-cache")).toBe(true);
    expect(w.phases().has("snapshot")).toBe(false);
    // Three opens, every one read-only (a reader shares the file with other readers where the browser knows it).
    expect(w.opfs.opens).toEqual([{ mode: "read-only" }, { mode: "read-only" }, { mode: "read-only" }]);
    expect(w.opfs.removed).toEqual([]);
  });

  it("no .raw (NotFoundError): the snapshot is streamed at once, with no open and no wait", async () => {
    // A long retry interval here: one sleep would show in the elapsed time, whatever the machine's load.
    const w = leanWorker({}, { waitMs: 3000, retryMs: 1500 });
    const r = await w.load();
    expect(r.error!.message).toBe("stop: the region arrived");
    expect(w.fetches).toHaveLength(1);
    expect(w.fetches[0]! - r.started).toBeLessThan(1500);
    expect(w.opfs.opens).toHaveLength(0);
    expect(w.busyLines()).toHaveLength(0);
    expect(arrived(w)).toEqual(RAW);
  });

  it("busy for good: one '[boot] raw cache busy' line after the bound, then the network path", async () => {
    const w = leanWorker({ [RAW_NAME]: { bytes: RAW, busyCalls: Infinity } }, SHORT);
    const r = await w.load();
    expect(r.error!.message).toBe("stop: the region arrived");
    const lines = w.busyLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text!.startsWith(`[boot] raw cache busy: ${RAW_NAME}`)).toBe(true);
    expect(lines[0]!.text).toContain("NoModificationAllowedError");
    expect(lines[0]!.at - r.started).toBeGreaterThanOrEqual(SHORT.waitMs);
    expect(w.opfs.opens.length).toBeGreaterThanOrEqual(2);
    // Streamed after the line: once, and the region arrives from the network.
    expect(w.fetches).toHaveLength(1);
    expect(w.fetches[0]!).toBeGreaterThanOrEqual(lines[0]!.at);
    expect(w.phases().has("snapshot")).toBe(true);
    expect(arrived(w)).toEqual(RAW);
    expect(w.opfs.removed).toEqual([]); // a busy region is someone's good region: never discarded
  });

  it("a non-busy error on a file of the wrong size is not retried: one open, then the network", async () => {
    const w = leanWorker({ [RAW_NAME]: { bytes: RAW.subarray(0, RAW.length - 1), busyCalls: Infinity, errorName: "InvalidStateError" } }, SHORT);
    const r = await w.load();
    expect(r.error!.message).toBe("stop: the region arrived");
    expect(w.opfs.opens).toHaveLength(1);
    expect(w.fetches).toHaveLength(1);
    expect(w.busyLines()).toHaveLength(0);
  });

  it("any open error on a file of the expected size is busy (another browser's words for the lock): retried", async () => {
    const w = leanWorker({ [RAW_NAME]: { bytes: RAW, busyCalls: 1, errorName: "InvalidStateError" } }, SHORT);
    const r = await w.load();
    expect(r.error!.message).toBe("stop: the region arrived");
    expect(w.opfs.opens.length).toBeGreaterThanOrEqual(2);
    expect(w.fetches).toHaveLength(0);
    expect(arrived(w)).toEqual(RAW);
    expect(w.busyLines()).toHaveLength(0);
  });
});
