// HARDENING #69: the worker fixes Lean's thread budget. The task manager gets min(hardwareConcurrency, 8) workers
// (never 0: that means no task manager), built at boot with _lean_init_task_manager_using(n), because main is
// marked preinitialized and never builds its own (a -j in callMain's argv would be inert); and up to 4 finished
// dedicated threads stay parked for reuse (LEAN_WASM_PARKED_DEDICATED at preRun). Source-level invariants plus the
// real leanWorkers() from the worker loaded in a vm.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const file = path.resolve(__dirname, "../../public/workers/lean.worker.js");
const src = readFileSync(file, "utf8");

function pool() {
  const workers = path.dirname(file);
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
    setTimeout, clearTimeout, setInterval, clearInterval, navigator: {},
    fetch: () => Promise.reject(new Error("no network in unit tests")),
  };
  sandbox.self = sandbox;
  sandbox.postMessage = () => {};
  sandbox.addEventListener = () => {};
  sandbox.crossOriginIsolated = true;
  sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "lean.worker.js" });
  return (sandbox as { __qed64TestExports?: { pool: { leanWorkers(hc?: unknown): number; LEAN_WORKERS_MAX: number; PARKED_DEDICATED: string; RESIDENT_ARGV: readonly string[] } } }).__qed64TestExports!.pool;
}

describe("the worker's thread budget (HARDENING #69)", () => {
  it("leanWorkers: the hardware concurrency, at most 8, never 0; 4 when the host does not say", () => {
    const p = pool();
    expect(p.LEAN_WORKERS_MAX).toBe(8);
    expect([1, 4, 8, 14, 32].map((hc) => p.leanWorkers(hc))).toEqual([1, 4, 8, 8, 8]);
    expect([undefined, 0, -3, 2.5, "8"].map((hc) => p.leanWorkers(hc))).toEqual([4, 4, 4, 4, 4]);
  });

  it("parking is one digits-only literal within the runtime's clamp, set at preRun beside the probe size", () => {
    const consts = [...src.matchAll(/const PARKED_DEDICATED = (".*?"|[^;]+);/g)].map((m) => m[1]);
    expect(consts).toEqual(['"4"']);
    expect(pool().PARKED_DEDICATED).toBe("4");
    const mount = src.slice(src.indexOf("function mountEverything()"), src.indexOf("onRuntimeInitialized()"));
    expect(mount).toContain("self.Module.ENV.LEAN_WASM_PARKED_DEDICATED = PARKED_DEDICATED;");
  });

  it("the task manager is built with an explicit worker count; the hardware-default init is only the fallback", () => {
    const init = src.slice(src.indexOf("onRuntimeInitialized()"));
    const using = init.indexOf("M._lean_init_task_manager_using(n)");
    const fallback = init.indexOf("else if (M._lean_init_task_manager) M._lean_init_task_manager();");
    expect(using).toBeGreaterThan(0);
    expect(fallback).toBeGreaterThan(using);
    expect(src).not.toMatch(/callMain\([^)]*"-j/); // inert under mark_preinitialized: never rely on it
  });
});

describe("the resident FileWorker's command line (HARDENING #70)", () => {
  it("turns asynchronous elaboration off: a blocked task would start a standard worker that never exits", () => {
    expect([...pool().RESIDENT_ARGV]).toEqual(["--worker", "-Dserver.reportDelayMs=0", "-DElab.async=false"]);
    expect(Object.isFrozen(pool().RESIDENT_ARGV)).toBe(true);
    const open = src.slice(src.indexOf("function residentOpenLoop()"));
    expect(open.slice(0, open.indexOf("\n}\n"))).toContain("M.callMain([...RESIDENT_ARGV]);");
    expect([...src.matchAll(/M\.callMain\(/g)]).toHaveLength(1); // the only entry into Lean's main
  });
});
