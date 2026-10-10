// HARDENING #55 addendum: every growth of the pthread pool past its preallocated Workers is logged with what was
// live at that moment (public/workers/lean.worker.js instrumentPoolGrowth), from the REAL worker script in a vm
// sandbox, against a fake Emscripten PThread object.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

interface FakePT {
  unusedWorkers: object[];
  runningWorkers: object[];
  pthreads: Record<string, object>;
  finishedThreads: Set<number>;
  allocateUnusedWorker(): void;
  __qed64PoolGrowth?: boolean;
}
interface Pool {
  instrumentPoolGrowth(PT: unknown, log: (line: string) => void): boolean;
  poolSample(): { unused: number; running: number; parked: number; grown: number };
  growths(): number;
}

function load(): Pool {
  const workers = path.resolve(__dirname, "../../public/workers");
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
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  return (sandbox as { __qed64TestExports?: { pool: Pool } }).__qed64TestExports!.pool;
}

function fakePool(): FakePT {
  const running = Array.from({ length: 24 }, () => ({}));
  return {
    unusedWorkers: [],
    runningWorkers: running,
    pthreads: Object.fromEntries(running.slice(0, 22).map((w, i) => [String(1000 + i), w])),
    finishedThreads: new Set([7, 8]),
    allocateUnusedWorker() { this.unusedWorkers.push({}); },
  };
}

describe("the pool-growth diagnostic (HARDENING #55 addendum)", () => {
  it("each growth is logged with the pool's total, live and finished-unreturned threads, and the allocation still happens", () => {
    const pool = load();
    const PT = fakePool();
    const lines: string[] = [];
    expect(pool.instrumentPoolGrowth(PT, (l) => lines.push(l))).toBe(true);
    PT.allocateUnusedWorker();
    expect(PT.unusedWorkers).toHaveLength(1); // the original ran
    PT.allocateUnusedWorker();
    expect(lines).toEqual([
      "[pool] grew to 25 Workers (live 22, finished-unreturned 2, unused 1, parked -1; growth 1)",
      "[pool] grew to 26 Workers (live 22, finished-unreturned 2, unused 2, parked -1; growth 2)",
    ]);
    expect(pool.growths()).toBe(2);
  });

  it("instruments once, and does nothing without a pool object that can allocate", () => {
    const pool = load();
    const PT = fakePool();
    expect(pool.instrumentPoolGrowth(PT, () => {})).toBe(true);
    expect(pool.instrumentPoolGrowth(PT, () => {})).toBe(false);
    expect(pool.instrumentPoolGrowth(null, () => {})).toBe(false);
    expect(pool.instrumentPoolGrowth({ unusedWorkers: [] }, () => {})).toBe(false);
  });

  it("the pool status carries the growth count (0 before any growth)", () => {
    const pool = load();
    expect(pool.poolSample()).toMatchObject({ grown: 0 });
  });
});
