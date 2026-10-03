// Runtime chunk progress on a slow link (HARDENING #54, reported by the
// lean4game session at a shared 300 kB/s): the worker reported runtime bytes
// only when a whole 16 MiB chunk had arrived, so the count stood still for
// ~56 s per chunk while bytes flowed. It now reports every 500 ms inside a
// chunk too, and verification (exact length, SHA-256) is unchanged. Runs the
// REAL worker source in a vm sandbox with a scripted fetch body and a fake
// clock (`performance.now`).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Posted = { type?: string; kind?: string; phase?: string; label?: string; loaded?: number; total?: number; unit?: string };
type Chunk = { url: string; bytes: number; sha256: string };
type FetchChunk = (chunk: Chunk, index: number, label: string, requestId: string, running: { loaded: number; total: number }) => Promise<Uint8Array>;

/** The worker in a sandbox whose fetch serves `parts` one read at a time, each read advancing the clock by `msPerPart`. */
function loadWorker(parts: Uint8Array[], msPerPart: number) {
  const posted: Posted[] = [];
  let clock = 0;
  const fetches: string[] = [];
  const workers = path.resolve(__dirname, "../../public/workers");
  const sandbox: Record<string, unknown> = {
    crypto, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
    performance: { now: () => clock },
    setTimeout, clearTimeout, clearInterval,
    setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref(); return t; },
    fetch: async (url: string, init: { cache?: string }) => {
      fetches.push(`${url} ${init?.cache}`);
      let i = 0;
      // highWaterMark 0: a part "arrives" (and the clock moves) only when the worker reads.
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (i < parts.length) { clock += msPerPart; c.enqueue(parts[i++]!); } else c.close();
        },
      }, { highWaterMark: 0 });
      const arrayBuffer = async () => { clock += msPerPart * parts.length; return Buffer.concat(parts).buffer; };
      return { ok: true, status: 200, headers: new Headers(), body, arrayBuffer };
    },
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: unknown) => posted.push(m as Posted);
  sandbox.addEventListener = () => {};
  sandbox.crossOriginIsolated = true;
  sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  const fetchChunk = (sandbox as { __qed64TestExports?: { fetchChunk: FetchChunk } }).__qed64TestExports!.fetchChunk;
  return { fetchChunk, posted, fetches };
}

const progressOf = (posted: Posted[]) => posted.filter((m) => m.kind === "progress" && m.phase === "runtime");

function chunkOf(size: number, pieces: number) {
  const whole = new Uint8Array(size).map((_, i) => (i * 31) & 0xff);
  const step = Math.ceil(size / pieces);
  const parts: Uint8Array[] = [];
  for (let o = 0; o < size; o += step) parts.push(whole.slice(o, Math.min(size, o + step)));
  const sha256 = createHash("sha256").update(whole).digest("hex");
  return { whole, parts, chunk: { url: "/runtime/chunks/lean.wasm.x.part-001", bytes: size, sha256 } };
}

describe("runtime chunk download progress", () => {
  it("reports bytes inside a chunk every 500 ms, then the verified count at its end", async () => {
    // 16 parts arriving 250 ms apart: a 4 s chunk, reported about every 500 ms.
    const { whole, parts, chunk } = chunkOf(1 << 20, 16);
    const { fetchChunk, posted } = loadWorker(parts, 250);
    const running = { loaded: 3 << 20, total: 8 << 20 };
    const bytes = await fetchChunk(chunk, 1, "lean.wasm", "r1", running);
    expect(Buffer.from(bytes).equals(Buffer.from(whole))).toBe(true);
    const p = progressOf(posted);
    // 7 in-chunk reports (at 500, 1000, …, 3500 ms of a 4 s chunk) + the verified one at the end.
    expect(p.length).toBe(8);
    for (const m of p) expect(m).toMatchObject({ label: "Verifying lean.wasm", total: 8 << 20, unit: "bytes" });
    const loaded = p.map((m) => m.loaded!);
    expect(loaded.every((v, i) => i === 0 || v > loaded[i - 1]!)).toBe(true); // monotone
    expect(loaded[0]).toBeGreaterThan(3 << 20); // counts on top of the chunks before this one
    expect(loaded.at(-1)).toBe((3 << 20) + (1 << 20)); // the verified count
    expect(running.loaded).toBe((3 << 20) + (1 << 20));
  });

  it("a fast chunk still reports once, at its end", async () => {
    const { parts, chunk } = chunkOf(1 << 16, 4);
    const { fetchChunk, posted } = loadWorker(parts, 10);
    await fetchChunk(chunk, 0, "lean.js", "r2", { loaded: 0, total: 1 << 16 });
    expect(progressOf(posted).map((m) => m.loaded)).toEqual([1 << 16]);
  });

  it("verification is unchanged: a wrong digest or an over-long body fails both attempts", async () => {
    const { parts, chunk } = chunkOf(1 << 16, 4);
    const bad = loadWorker(parts, 10);
    await expect(bad.fetchChunk({ ...chunk, sha256: "0".repeat(64) }, 2, "lean.wasm", "r3", { loaded: 0, total: 1 << 16 })).rejects.toThrow(/lean\.wasm chunk 2 failed SHA-256 verification/);
    expect(bad.fetches.map((f) => f.split(" ")[1])).toEqual(["force-cache", "reload"]); // the cache-bypassing retry ran
    const long = loadWorker(parts, 10);
    await expect(long.fetchChunk({ ...chunk, bytes: (1 << 16) - 1 }, 3, "lean.wasm", "r4", { loaded: 0, total: 1 << 16 })).rejects.toThrow(/lean\.wasm chunk 3: more than 65535 bytes/);
    const short = loadWorker(parts, 10);
    await expect(short.fetchChunk({ ...chunk, bytes: (1 << 16) + 1 }, 4, "lean.wasm", "r5", { loaded: 0, total: 1 << 16 })).rejects.toThrow(/lean\.wasm chunk 4: 65536 bytes, expected 65537/);
  });
});
