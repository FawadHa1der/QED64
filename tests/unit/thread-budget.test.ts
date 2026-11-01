// HARDENING #69: the worker fixes Lean's thread budget. The task manager gets min(hardwareConcurrency, 8) workers
// (never 0: that means no task manager), built at boot with _lean_init_task_manager_using(n), because main is
// marked preinitialized and never builds its own (a -j in callMain's argv would be inert); and up to 4 finished
// dedicated threads stay parked for reuse (LEAN_WASM_PARKED_DEDICATED at preRun). HARDENING #70: the resident
// FileWorker's command line turns asynchronous elaboration off.
//
// The values live in public/workers/worker-constants.js (architecture review R3), which lean.worker.js loads
// eagerly and its Node twins import: this test imports the script itself (the real values and residentArgv) and
// checks lean.worker.js's source for the places that read them, plus the sibling load in a vm.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import "../../public/workers/worker-constants.js";

type WorkerConstants = {
  LEAN_WORKERS_MAX: number;
  PARKED_DEDICATED: string;
  leanWorkers(hc?: unknown): number;
  RESIDENT_ARGV: readonly string[];
  residentArgv(leanOptions?: unknown): readonly string[];
  REVISION: string;
};
const WC = (globalThis as unknown as { Qed64WorkerConstants: WorkerConstants }).Qed64WorkerConstants;
const workers = path.resolve(__dirname, "../../public/workers");
const src = readFileSync(path.join(workers, "lean.worker.js"), "utf8");
const constantsSrc = readFileSync(path.join(workers, "worker-constants.js"), "utf8");

describe("the worker's thread budget (HARDENING #69)", () => {
  it("leanWorkers: the hardware concurrency, at most 8, never 0; 4 when the host does not say", () => {
    expect(WC.LEAN_WORKERS_MAX).toBe(8);
    expect([1, 4, 8, 14, 32].map((hc) => WC.leanWorkers(hc))).toEqual([1, 4, 8, 8, 8]);
    expect([undefined, 0, -3, 2.5, "8"].map((hc) => WC.leanWorkers(hc))).toEqual([4, 4, 4, 4, 4]);
  });

  it("parking is one digits-only literal within the runtime's clamp, in worker-constants.js; lean.worker.js sets it at preRun", () => {
    const literal = /const PARKED_DEDICATED = (".*?"|[^;]+);/g;
    expect([...constantsSrc.matchAll(literal)].map((m) => m[1])).toEqual(['"4"']);
    expect([...src.matchAll(literal)].map((m) => m[1])).toEqual([]);
    expect(WC.PARKED_DEDICATED).toBe("4");
    const mount = src.slice(src.indexOf("function mountEverything()"), src.indexOf("onRuntimeInitialized()"));
    expect(mount).toContain("self.Module.ENV.LEAN_WASM_PARKED_DEDICATED = Qed64WorkerConstants.PARKED_DEDICATED;");
    // Values only: the environment assignments stay in lean.worker.js (the proof sheets' probe-slot refusal scans it).
    expect(constantsSrc).not.toMatch(/ENV\b|STACK_PROBE_SLOTS/);
  });

  it("the task manager is built with an explicit worker count; the hardware-default init is only the fallback", () => {
    const init = src.slice(src.indexOf("onRuntimeInitialized()"));
    const using = init.indexOf("M._lean_init_task_manager_using(n)");
    const fallback = init.indexOf("else if (M._lean_init_task_manager) M._lean_init_task_manager();");
    expect(using).toBeGreaterThan(0);
    expect(fallback).toBeGreaterThan(using);
    expect(src).toContain("Qed64WorkerConstants.leanWorkers(");
    expect(src).not.toMatch(/callMain\([^)]*"-j/); // inert under mark_preinitialized: never rely on it
  });
});

describe("the resident FileWorker's command line (HARDENING #70, architecture review R3)", () => {
  it("turns asynchronous elaboration off: a blocked task would start a standard worker that never exits", () => {
    const defaults = ["--worker", "-Dserver.reportDelayMs=0", "-DElab.async=false"];
    expect([...WC.RESIDENT_ARGV]).toEqual(defaults);
    expect(Object.isFrozen(WC.RESIDENT_ARGV)).toBe(true);
    expect([...WC.residentArgv([])]).toEqual(defaults);
    expect([...WC.residentArgv(undefined)]).toEqual(defaults);
  });

  it("residentArgv merges leanOptions by name: a default is replaced in place, a new name appended, each -D once", () => {
    const argv = WC.residentArgv(["Elab.async=true", "autoImplicit=false"]);
    expect([...argv]).toEqual(["--worker", "-Dserver.reportDelayMs=0", "-DElab.async=true", "-DautoImplicit=false"]);
    expect(Object.isFrozen(argv)).toBe(true);
    expect([...WC.residentArgv(["weak.verso.code.warnLineLength=100"])]).toEqual([
      "--worker", "-Dserver.reportDelayMs=0", "-DElab.async=false", "-Dweak.verso.code.warnLineLength=100",
    ]);
    expect([...WC.RESIDENT_ARGV]).toEqual(["--worker", "-Dserver.reportDelayMs=0", "-DElab.async=false"]); // untouched
  });

  it("residentArgv refuses an entry that is not name=value, a non-array and a repeated name (TypeError)", () => {
    for (const bad of [["autoImplicit"], ["=x"], ["-DautoImplicit=false"], ["a\nb=c"], [7], "autoImplicit=false", ["x=1", "x=2"]]) {
      expect(() => WC.residentArgv(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(() => WC.residentArgv(["autoImplicit"])).toThrow(/"autoImplicit" is not "name=value"/);
    expect(() => WC.residentArgv(["x=1", "x=2"])).toThrow(/names x twice/);
  });

  it("lean.worker.js runs the boot's argv, or the defaults, at its only callMain, and keeps no copy of the constants", () => {
    const open = src.slice(src.indexOf("function residentOpenLoop()"));
    expect(open.slice(0, open.indexOf("\n}\n"))).toContain("M.callMain([...(loopArgv ?? Qed64WorkerConstants.RESIDENT_ARGV)]);");
    expect([...src.matchAll(/M\.callMain\(/g)]).toHaveLength(1); // the only entry into Lean's main
    for (const copy of ["const RESIDENT_ARGV", "const LEAN_WORKERS_MAX", "const PARKED_DEDICATED"]) expect(src).not.toContain(copy);
  });
});

type Posted = { type: string; error?: { code: string; message: string; recoverable: boolean } };

/** lean.worker.js in a VM whose importScripts serves the real siblings, except
 * worker-constants.js as `serve(source)` returns it (null: not served). */
function loadWorker(serve: (s: string) => string | null) {
  const posted: Posted[] = [];
  const sandbox: Record<string, unknown> = { crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console, setTimeout, clearTimeout };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: Posted) => posted.push(m);
  sandbox.addEventListener = () => {};
  sandbox.importScripts = (name: string) => {
    const file = readFileSync(path.join(workers, name), "utf8");
    const served = name === "worker-constants.js" ? serve(file) : file;
    if (served === null) throw new Error(`NetworkError: Failed to execute 'importScripts': The script at '${name}' failed to load.`);
    vm.runInContext(served, sandbox, { filename: name });
  };
  vm.createContext(sandbox);
  let thrown: unknown = null;
  try { vm.runInContext(src, sandbox, { filename: "lean.worker.js" }); } catch (e) { thrown = e; }
  return { posted, thrown };
}

describe("lean.worker.js loads worker-constants.js (docs/EMBEDDING.md §7.7)", () => {
  it("a constants script that is not served is WORKER_DEP_MISSING (unrecoverable), posted before the script throws; no boot", () => {
    const w = loadWorker(() => null);
    expect(String(w.thrown)).toMatch(/failed to load/);
    expect(w.posted.filter((m) => m.type === "error").map((m) => m.error)).toEqual([
      expect.objectContaining({ code: "WORKER_DEP_MISSING", recoverable: false, message: expect.stringMatching(/^lean\.worker\.js needs worker-constants\.js served beside it: /) }),
    ]);
    expect(w.posted.filter((m) => m.type === "boot")).toEqual([]);
  });

  it("a constants script of another revision is WORKER_DEP_MISMATCH", () => {
    const w = loadWorker((s) => { const older = s.replace('REVISION: "1" }', 'REVISION: "0" }'); expect(older).not.toBe(s); return older; });
    expect(String(w.thrown)).toContain('worker-constants.js is revision "0", lean.worker.js needs 1');
    expect(w.posted.filter((m) => m.type === "error").map((m) => m.error)).toEqual([expect.objectContaining({ code: "WORKER_DEP_MISMATCH", recoverable: false })]);
    expect(w.posted.filter((m) => m.type === "boot")).toEqual([]);
  });
});
