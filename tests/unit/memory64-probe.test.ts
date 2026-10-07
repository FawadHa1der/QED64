// The Memory64 probe bytes have ONE source, public/workers/memory64-probe.js
// (docs/EMBEDDING.md §7.0): a classic script that publishes
// globalThis.Qed64Memory64. public/workers/lean.worker.js importScripts it for
// its capabilities report and refuses a copy of another revision (§7.7);
// lib/client.ts imports the same file for its side effect and
// re-exports MEMORY64_PROBE and probeMemory64 (and `qed64/embed` re-exports
// those). So an embedder that refuses an incapable browser before spawning the
// worker runs exactly the worker's test.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { MEMORY64_PROBE, probeMemory64 } from "../../lib/client";
import * as embed from "../../lib/index";

const root = path.resolve(__dirname, "../..");
const workers = path.join(root, "public/workers");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const worker = read("public/workers/lean.worker.js");
const probeSource = read("public/workers/memory64-probe.js");
const ledger = (JSON.parse(read("embedding/closure.json")) as { workerProtocol: { revision: string } }).workerProtocol.revision;
type Probe = { MEMORY64_PROBE: Uint8Array; probeMemory64(): boolean; REVISION: string };
type Posted = { type: string; requestId?: string; result?: { memory64?: boolean }; error?: { code: string; message: string; recoverable: boolean } };

/** lean.worker.js in a VM whose importScripts serves the real siblings, except
 * memory64-probe.js as `probe(source)` returns it (null: not served). */
function loadWorker(probe: (src: string) => string | null = (src) => src) {
  const posted: Posted[] = [];
  const imported: string[] = [];
  const listeners: Record<string, (e: { data: unknown }) => void> = {};
  const sandbox: Record<string, unknown> = { crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console, setTimeout, clearTimeout };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: Posted) => posted.push(m);
  sandbox.addEventListener = (type: string, fn: (e: { data: unknown }) => void) => { listeners[type] = fn; };
  sandbox.importScripts = (name: string) => {
    imported.push(name);
    const src = fs.readFileSync(path.join(workers, name), "utf8");
    const served = name === "memory64-probe.js" ? probe(src) : src;
    if (served === null) throw new Error(`NetworkError: Failed to execute 'importScripts': The script at '${name}' failed to load.`);
    vm.runInContext(served, sandbox, { filename: name });
  };
  vm.createContext(sandbox);
  let thrown: unknown = null;
  try { vm.runInContext(worker, sandbox, { filename: "lean.worker.js" }); } catch (e) { thrown = e; }
  return { sandbox, posted, imported, thrown, deliver: (data: unknown) => listeners.message!({ data }) };
}

describe("MEMORY64_PROBE: one source", () => {
  it("is memory64-probe.js's: client.ts re-exports the global it publishes, and the barrel re-exports both", () => {
    const published = (globalThis as unknown as { Qed64Memory64: Probe }).Qed64Memory64;
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.keys(published).sort()).toEqual(["MEMORY64_PROBE", "REVISION", "probeMemory64"]);
    expect(published.REVISION).toBe(ledger);
    expect(MEMORY64_PROBE).toBe(published.MEMORY64_PROBE);
    expect(probeMemory64).toBe(published.probeMemory64);
    expect(embed.MEMORY64_PROBE).toBe(MEMORY64_PROBE);
    expect(embed.probeMemory64).toBe(probeMemory64);
    expect(read("lib/client.ts")).toMatch(/^import "\.\.\/public\/workers\/memory64-probe\.js";$/m);
  });

  it("no other source file carries the probe bytes or validates a probe of its own", () => {
    const files = ["public/workers/lean.worker.js", "public/workers/lsp-frames.js", "public/workers/lsp-front-door.js", "public/workers/snapshot-prefetch.worker.js",
      ...fs.readdirSync(path.join(root, "lib")).filter((f) => /\.ts$/.test(f)).map((f) => `lib/${f}`),
      ...fs.readdirSync(path.join(root, "frontend/src"), { recursive: true }).map(String).filter((f) => /\.ts$/.test(f)).map((f) => `frontend/src/${f}`)];
    for (const f of files) {
      expect(read(f), f).not.toMatch(/0x05,\s*0x03,\s*0x01,\s*0x04/);
      expect(read(f), f).not.toMatch(/WebAssembly\.validate\(/);
    }
    expect(probeSource.match(/0x05, 0x03, 0x01, 0x04, 0x00/g)).toHaveLength(1);
    // the worker's capabilities report calls the shared check, once
    expect(worker.match(/Qed64Memory64\.probeMemory64\(\)/g)).toHaveLength(1);
  });

  it("is a wasm header plus one memory64 memory section, and fixed in shape", () => {
    expect(MEMORY64_PROBE).toBeInstanceOf(Uint8Array);
    expect(MEMORY64_PROBE.length).toBe(13);
    expect([...MEMORY64_PROBE.slice(0, 8)]).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    // section id 5 (memory), size 3, one memory, limits flags 0x04 (i64 index), min 0
    expect([...MEMORY64_PROBE.slice(8)]).toEqual([0x05, 0x03, 0x01, 0x04, 0x00]);
    expect(Object.isExtensible(MEMORY64_PROBE)).toBe(false);
    // flags 0x00 is the same module with a 32-bit memory: every engine validates that one
    const m32 = MEMORY64_PROBE.slice();
    m32[11] = 0x00;
    expect(WebAssembly.validate(m32)).toBe(true);
  });

  it("probeMemory64 validates it (Node >= 24 has Memory64 on), and is false without WebAssembly", () => {
    expect(probeMemory64()).toBe(WebAssembly.validate(MEMORY64_PROBE));
    expect(probeMemory64()).toBe(true);
    // As a classic script (what importScripts runs), in a realm without WebAssembly.
    const bare: Record<string, unknown> = { WebAssembly: undefined };
    vm.createContext(bare);
    vm.runInContext(probeSource, bare, { filename: "memory64-probe.js" });
    const p = (bare as { Qed64Memory64: Probe }).Qed64Memory64;
    expect([...p.MEMORY64_PROBE]).toEqual([...MEMORY64_PROBE]);
    expect(p.probeMemory64()).toBe(false);
  });
});

describe("lean.worker.js loads memory64-probe.js (docs/EMBEDDING.md §7.7)", () => {
  it("eagerly, beside lsp-frames.js, and reports memory64 from it", () => {
    const w = loadWorker();
    expect(w.thrown).toBeNull();
    expect(w.imported).toEqual(["lsp-frames.js", "memory64-probe.js"]);
    w.deliver({ protocol: 1, requestId: "c1", type: "capabilities" });
    expect(w.posted.find((m) => m.requestId === "c1")).toMatchObject({ type: "result", result: { memory64: true } });
    // the worker's check is the shared one: a probe file that refuses is a worker that refuses
    const no = loadWorker((src) => src.replace("return typeof WebAssembly", "return false && typeof WebAssembly"));
    no.deliver({ protocol: 1, requestId: "c2", type: "capabilities" });
    expect(no.posted.find((m) => m.requestId === "c2")).toMatchObject({ type: "result", result: { memory64: false } });
  });

  it("a probe that is not served is WORKER_DEP_MISSING (unrecoverable), posted before the script throws", () => {
    const w = loadWorker(() => null);
    expect(String(w.thrown)).toMatch(/failed to load/);
    const errors = w.posted.filter((m) => m.type === "error");
    expect(errors.map((m) => m.error)).toEqual([expect.objectContaining({ code: "WORKER_DEP_MISSING", recoverable: false, message: expect.stringMatching(/^lean\.worker\.js needs memory64-probe\.js served beside it: /) })]);
    expect(w.posted.filter((m) => m.type === "boot")).toEqual([]);
  });

  it("a probe of another revision is WORKER_DEP_MISMATCH, as for lsp-frames.js", () => {
    const w = loadWorker((src) => { const older = src.replace(/REVISION: "1" \}/, 'REVISION: "0" }'); expect(older).not.toBe(src); return older; });
    expect(String(w.thrown)).toContain('memory64-probe.js is revision "0", lean.worker.js needs 1 (a deploy mixed versions; reload)');
    expect(w.posted.filter((m) => m.type === "error").map((m) => m.error)).toEqual([expect.objectContaining({ code: "WORKER_DEP_MISMATCH", recoverable: false })]);
    const missing = loadWorker((src) => src.replace("root.Qed64Memory64 =", "root.Qed64Other ="));
    expect(String(missing.thrown)).toContain("memory64-probe.js is revision missing, lean.worker.js needs 1");
  });
});
