// A .snapz body that ENDS before the bytes it announced is a transfer failure
// (network), not a corrupt snapshot (HARDENING #63, the browser lane's
// truncate mode). The lane served the first 1,000,000 bytes of a response
// that announced its full Content-Length; the stream ended cleanly short, the
// gzip decoder threw "Compressed input was truncated.", and failureKindOf
// read "truncated" as corrupt, so #63's network rule never fired: three
// runtimes again. Both snapshot streams now count the compressed bytes and
// fail a short one with "the transfer of <file> ended early: received <n> of
// <expected> bytes"; a body that arrived in full and fails the decoder stays
// corrupt.
//
// The REAL worker scripts in a vm sandbox (the front-door.test.ts pattern):
// public/workers/snapshot-prefetch.worker.js over a fake OPFS, and
// lean.worker.js's loadSnapshot over a fake heap (frontDoor.host), both with
// a scripted fetch. No wasm, no browser.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { failureKindOf, TRANSFER_ENDED_EARLY } from "../../lib/failure";

const workers = path.resolve(__dirname, "../../public/workers");
const ORIGIN = "http://localhost:5295";
const FILE = "init.b6d945e398b4d55e.snapz";
const URL_ = `/snapshots/${FILE}`;

/** A region: the "olean" magic, then incompressible bytes (deterministic), so a cut lands mid-stream. */
function region(n: number): Uint8Array {
  const out = new Uint8Array(n);
  out.set([0x6f, 0x6c, 0x65, 0x61, 0x6e]);
  let x = 0x9e3779b9;
  for (let i = 5; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const RAW = region(400_000);
const GZ = new Uint8Array(zlib.gzipSync(RAW));
const HALF = GZ.subarray(0, GZ.length >> 1);
/** A gzip header with every flag bit set: the decoder refuses it at once (before the input ends). */
const BAD_HEADER = (() => { const b = new Uint8Array(GZ); b[3] = 0xff; return b; })();

/** Node's DecompressionStream rejects with an EMPTY message where Chromium's names the failure. The stand-in
 * keeps Node's inflater and words its errors as Blink does: a failure once the input has ended is "Compressed input
 * was truncated.", one before "The compressed data was not valid.". An abort (the source errored) keeps its reason. */
class ChromiumDecompressionStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  constructor(format: "gzip") {
    const inner = new DecompressionStream(format);
    const w = inner.writable.getWriter();
    const r = inner.readable.getReader();
    let ended = false;
    this.writable = new WritableStream<Uint8Array>({
      write: (c) => w.write(c as Uint8Array<ArrayBuffer>),
      close: () => { ended = true; return w.close(); },
      abort: (reason) => w.abort(reason),
    });
    this.readable = new ReadableStream<Uint8Array>({
      async pull(c) {
        let step: ReadableStreamReadResult<Uint8Array>;
        try { step = await r.read(); } catch (e) {
          if ((e as Error)?.message) throw e;
          throw new TypeError(ended ? "Compressed input was truncated." : "The compressed data was not valid.");
        }
        if (step.done) c.close(); else c.enqueue(step.value);
      },
      cancel: (reason) => r.cancel(reason),
    });
  }
}

interface Served {
  /** The bytes the body yields before it ends (or errors). */
  bytes: Uint8Array;
  /** Response headers (Content-Length is NOT derived from `bytes`: a cut announces the whole). */
  headers?: Record<string, string>;
  /** Error the body with this after its bytes instead of ending cleanly (a transport cut). */
  error?: Error;
}
/** A scripted fetch answer: 64 KiB chunks, then a clean end or an error. */
function respond(s: Served) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < s.bytes.length; i += 65536) c.enqueue(s.bytes.slice(i, i + 65536));
      if (s.error) c.error(s.error); else c.close();
    },
  });
  return { ok: true, status: 200, redirected: false, url: `${ORIGIN}${URL_}`, headers: new Headers(s.headers ?? {}), body };
}
const announced = (n: number) => ({ "content-type": "application/octet-stream", "content-length": String(n) });

function sandboxBase(fetchImpl: () => unknown) {
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, Headers, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
    ReadableStream, WritableStream, TransformStream, DecompressionStream: ChromiumDecompressionStream,
    setTimeout, clearTimeout, clearInterval,
    setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref(); return t; },
    location: new URL(`${ORIGIN}/workers/x.js`),
    fetch: async () => fetchImpl(),
  };
  sandbox.self = sandbox;
  return sandbox;
}

// ------------------------------------------------------------ snapshot-prefetch.worker.js

/** A fake OPFS directory: what rawPrefetch touches (file handles, a sync access handle, move, removeEntry).
 * `seed`: files already there (an old compressed `<cacheKey>` entry, which rawPrefetch prefers to the network). */
function fakeOpfs(seed: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const notFound = () => Object.assign(new Error("not found"), { name: "NotFoundError" });
  const dir = {
    async getDirectoryHandle() { return dir; },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name)) { if (!opts?.create) throw notFound(); files.set(name, new Uint8Array(0)); }
      let cur = name;
      return {
        async getFile() { const b = files.get(cur); if (!b) throw notFound(); return { size: b.length, stream: () => new Blob([b as Uint8Array<ArrayBuffer>]).stream() }; },
        async createSyncAccessHandle() {
          return {
            write(v: Uint8Array, { at }: { at: number }) {
              const old = files.get(cur)!;
              const next = new Uint8Array(Math.max(old.length, at + v.length));
              next.set(old); next.set(v, at); files.set(cur, next);
              return v.length;
            },
            flush() {}, close() {},
          };
        },
        async move(to: string) { files.set(to, files.get(cur)!); files.delete(cur); cur = to; },
      };
    },
    async removeEntry(name: string) { if (!files.delete(name)) throw notFound(); },
  };
  return { files, navigator: { storage: { getDirectory: async () => dir } } };
}

type Report = { status: string; error?: string; bytes?: number };
/** Run the real prefetch worker once: post one request, resolve with its final report. `served: null` = a fetch
 * would fail the test (counted in `fetches`). */
async function prefetch(served: Served | null, extra: Record<string, unknown> = {}, seed: Record<string, Uint8Array> = {}): Promise<{ last: Report; files: Map<string, Uint8Array>; fetches: number }> {
  const opfs = fakeOpfs(seed);
  let fetches = 0;
  const sandbox = sandboxBase(() => { fetches++; if (!served) throw new Error("fetch must not be called"); return respond(served); });
  sandbox.navigator = opfs.navigator;
  const reports: Report[] = [];
  sandbox.postMessage = (m: Report) => reports.push(m);
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(workers, "snapshot-prefetch.worker.js"), "utf8"), sandbox, { filename: "snapshot-prefetch.worker.js" });
  await (sandbox.onmessage as (e: { data: unknown }) => Promise<void>)({ data: { url: URL_, cacheKey: "init.k", rawBytes: RAW.length, ...extra } });
  return { last: reports.at(-1)!, files: opfs.files, fetches };
}

describe("snapshot-prefetch.worker.js: a short transfer is network, a full one that fails the decoder is corrupt", () => {
  it("a complete body commits the raw region (the harness itself)", async () => {
    const { last, files } = await prefetch({ bytes: GZ, headers: announced(GZ.length) });
    expect(last).toEqual({ status: "done", bytes: RAW.length });
    expect(files.get("init.k.raw")).toEqual(RAW);
  });

  it("a body that ends cleanly short of its Content-Length (the lane's truncate cut) names the transfer: network", async () => {
    const { last, files } = await prefetch({ bytes: HALF, headers: announced(GZ.length) });
    expect(last.status).toBe("error");
    expect(last.error).toBe(`the transfer of ${FILE} ended early: received ${HALF.length} of ${GZ.length} bytes`);
    expect(failureKindOf(undefined, last.error!)).toBe("network");
    expect([...files.keys()]).toEqual([]); // the partial is dropped, nothing committed
  });

  it("no Content-Length: the index's transfer size (transferBytes) is the expectation", async () => {
    const { last } = await prefetch({ bytes: HALF, headers: { "content-type": "application/octet-stream" } }, { transferBytes: GZ.length });
    expect(last.error).toBe(`the transfer of ${FILE} ended early: received ${HALF.length} of ${GZ.length} bytes`);
    expect(failureKindOf(undefined, last.error!)).toBe("network");
  });

  it("a truncated compressed cache entry is local damage, not the transfer: transferBytes applies to the network only", async () => {
    // An old `<cacheKey>` entry (compressed, half its bytes) is the source rawPrefetch prefers; raw-cache.ts always
    // posts transferBytes, but a short LOCAL file must stay corrupt, or storage damage would arm #63's network memory.
    const { last, fetches } = await prefetch(null, { transferBytes: GZ.length }, { "init.k": HALF });
    expect(fetches).toBe(0);
    expect(last.error).toBe("Compressed input was truncated.");
    expect(failureKindOf(undefined, last.error!)).toBe("corrupt");
  });

  it("a body that ends before its first byte is the transfer too, not an empty source", async () => {
    const { last } = await prefetch({ bytes: new Uint8Array(0), headers: announced(GZ.length) });
    expect(last.error).toBe(`the transfer of ${FILE} ended early: received 0 of ${GZ.length} bytes`);
  });

  it("a body that arrived in full (as announced) and fails the decoder stays corrupt", async () => {
    // The same short gzip, but announced at its own length: every byte the server promised arrived.
    const cut = await prefetch({ bytes: HALF, headers: announced(HALF.length) });
    expect(cut.last.error).toBe("Compressed input was truncated.");
    expect(failureKindOf(undefined, cut.last.error!)).toBe("corrupt");
    const bad = await prefetch({ bytes: BAD_HEADER, headers: announced(BAD_HEADER.length) });
    expect(bad.last.error).toBe("The compressed data was not valid.");
    expect(failureKindOf(undefined, bad.last.error!)).toBe("corrupt");
  });

  it("without an expected size (no Content-Length, no transferBytes) or for an encoded body there is no check: the decoder's words, as before", async () => {
    const none = await prefetch({ bytes: HALF, headers: { "content-type": "application/octet-stream" } });
    expect(none.last.error).toBe("Compressed input was truncated.");
    const encoded = await prefetch({ bytes: HALF, headers: { ...announced(GZ.length), "content-encoding": "br" } });
    expect(encoded.last.error).toBe("Compressed input was truncated.");
  });

  it("a transport cut keeps its own words (the showcase's C11 anchors \"network error\")", async () => {
    const { last } = await prefetch({ bytes: HALF, headers: announced(GZ.length), error: new TypeError("network error") });
    expect(last.error).toBe("network error");
    expect(failureKindOf(undefined, last.error!)).toBe("network");
  });
});

// ------------------------------------------------------------ lean.worker.js loadSnapshot (the checker's own stream)

type Posted = { type: string; requestId?: string; error?: { code: string; message: string }; result?: { operation: string } };
interface Hooks { frontDoor: { host(h: { state?: string; M?: unknown; memory?: unknown }): void } }

function leanWorker() {
  let served: Served = { bytes: GZ, headers: announced(GZ.length) };
  const posted: Posted[] = [];
  const sandbox = sandboxBase(() => respond(served));
  const listeners: Record<string, (e: { data: unknown }) => void> = {};
  sandbox.postMessage = (m: Posted) => posted.push(m);
  sandbox.addEventListener = (type: string, fn: (e: { data: unknown }) => void) => { listeners[type] = fn; };
  sandbox.crossOriginIsolated = true;
  sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  const hooks = (sandbox as { __qed64TestExports?: Hooks }).__qed64TestExports!;
  // A fake heap and the three exports loadSnapshot calls; the region "load" stops the run once it has the bytes.
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
  let seq = 0;
  async function load(s: Served, extra: Record<string, unknown> = {}): Promise<{ error?: { code: string; message: string } }> {
    served = s;
    const requestId = `snap-${++seq}`;
    listeners.message!({ data: { protocol: 1, requestId, type: "loadSnapshot", input: { url: URL_, name: "init.snap", expectedBytes: RAW.length, ...extra } } });
    await expect.poll(() => posted.find((m) => m.requestId === requestId && (m.type === "error" || m.type === "result")), { timeout: 5000 }).toBeTruthy();
    hooks.frontDoor.host({ state: "ready" });
    return posted.find((m) => m.requestId === requestId && (m.type === "error" || m.type === "result"))!;
  }
  return { load, loaded, memory };
}

describe("lean.worker.js loadSnapshot: the checker's own stream classifies a short transfer the same way", () => {
  const w = leanWorker();

  it("a complete body reaches the region loader with every raw byte (the harness itself)", async () => {
    const r = await w.load({ bytes: GZ, headers: announced(GZ.length) });
    expect(r.error).toMatchObject({ code: "SNAPSHOT_FAILED", message: "stop: the region arrived" });
    expect(w.loaded.at(-1)).toEqual({ ptr: 16n, bytes: BigInt(RAW.length) });
    expect(new Uint8Array(w.memory.buffer, 16, RAW.length)).toEqual(RAW);
  });

  it("a body that ends cleanly short of its Content-Length names the transfer: network, and the loader never runs", async () => {
    const before = w.loaded.length;
    const r = await w.load({ bytes: HALF, headers: announced(GZ.length) });
    expect(r.error).toMatchObject({ code: "SNAPSHOT_FAILED", message: `the transfer of ${FILE} ended early: received ${HALF.length} of ${GZ.length} bytes` });
    expect(failureKindOf(r.error!.code, r.error!.message)).toBe("network");
    expect(w.loaded.length).toBe(before);
    const empty = await w.load({ bytes: new Uint8Array(0), headers: announced(GZ.length) });
    expect(empty.error!.message).toBe(`the transfer of ${FILE} ended early: received 0 of ${GZ.length} bytes`);
  });

  it("a body that arrived in full and fails the decoder stays corrupt", async () => {
    const cut = await w.load({ bytes: HALF, headers: announced(HALF.length) });
    expect(cut.error).toMatchObject({ code: "SNAPSHOT_FAILED", message: "Compressed input was truncated." });
    expect(failureKindOf(cut.error!.code, cut.error!.message)).toBe("corrupt");
    const bad = await w.load({ bytes: BAD_HEADER, headers: announced(BAD_HEADER.length) });
    expect(bad.error!.message).toBe("The compressed data was not valid.");
    expect(failureKindOf(bad.error!.code, bad.error!.message)).toBe("corrupt");
  });

  it("no Content-Length: the index's transfer size (the optional transferBytes input) is the expectation, as in the prefetch worker", async () => {
    // The shape the checker's stream decides the boot's cause in (HARDENING #63 follow-up 1): the prefetch failed
    // first, then this stream of the same URL ends short with no Content-Length (a close-delimited body).
    const before = w.loaded.length;
    const r = await w.load({ bytes: HALF, headers: { "content-type": "application/octet-stream" } }, { transferBytes: GZ.length });
    expect(r.error).toMatchObject({ code: "SNAPSHOT_FAILED", message: `the transfer of ${FILE} ended early: received ${HALF.length} of ${GZ.length} bytes` });
    expect(failureKindOf(r.error!.code, r.error!.message)).toBe("network");
    expect(w.loaded.length).toBe(before);
    // The whole body against the same expectation reaches the region loader.
    const full = await w.load({ bytes: GZ, headers: { "content-type": "application/octet-stream" } }, { transferBytes: GZ.length });
    expect(full.error!.message).toBe("stop: the region arrived");
    // A Content-Length, when present, wins over transferBytes.
    const cl = await w.load({ bytes: HALF, headers: announced(HALF.length) }, { transferBytes: GZ.length });
    expect(cl.error!.message).toBe("Compressed input was truncated.");
  });

  it("without an expected size (no Content-Length, no transferBytes) or for an encoded body, the decoder's words as before", async () => {
    const none = await w.load({ bytes: HALF, headers: { "content-type": "application/octet-stream" } });
    expect(none.error!.message).toBe("Compressed input was truncated.");
    const encoded = await w.load({ bytes: HALF, headers: { ...announced(GZ.length), "content-encoding": "gzip" } });
    expect(encoded.error!.message).not.toMatch(TRANSFER_ENDED_EARLY);
  });

  it("a transport cut keeps its own words", async () => {
    const r = await w.load({ bytes: HALF, headers: announced(GZ.length), error: new TypeError("network error") });
    expect(r.error!.message).toBe("network error");
  });
});
