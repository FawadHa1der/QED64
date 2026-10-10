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
  getNewWorker(): object | undefined;
  __qed64PoolGrowth?: boolean;
}
interface Pool {
  instrumentPoolGrowth(PT: unknown, log: (line: string) => void, now?: () => number): boolean;
  poolSample(): { unused: number; running: number; parked: number; grown: number; starts: number };
  growths(): number;
  starts(): number;
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
    // as the glue's: allocate when none is unused, then hand one out
    getNewWorker() { if (this.unusedWorkers.length === 0) this.allocateUnusedWorker(); return this.unusedWorkers.pop(); },
  };
}

describe("the pool-growth diagnostic (HARDENING #55 addendum)", () => {
  it("each growth is logged with its time, the pool's total, live and finished-unreturned threads and the starts so far; the allocation still happens", () => {
    const pool = load();
    const PT = fakePool();
    const lines: string[] = [];
    let clock = 1000;
    expect(pool.instrumentPoolGrowth(PT, (l) => lines.push(l), () => clock)).toBe(true);
    clock = 1250;
    const w = PT.getNewWorker(); // none unused: one growth, one start
    expect(w).toBeDefined(); // the glue's getNewWorker result is passed on
    PT.unusedWorkers.push({}); // a Worker came back
    PT.getNewWorker(); // a start served from the pool: no growth
    clock = 1500;
    PT.getNewWorker(); // none unused again: a growth
    expect(lines).toEqual([
      "[pool] grew to 25 Workers at 250 ms (live 22, finished-unreturned 2, unused 1, parked -1; growth 1, starts 1)",
      "[pool] grew to 25 Workers at 500 ms (live 22, finished-unreturned 2, unused 1, parked -1; growth 2, starts 3)",
    ]);
    expect([pool.growths(), pool.starts()]).toEqual([2, 3]);
    expect(pool.poolSample()).toMatchObject({ grown: 2, starts: 3 });
  });

  it("a glue without runningWorkers (e1a79c1's) counts the total as unused plus live", () => {
    const pool = load();
    const PT = fakePool() as Partial<FakePT> & FakePT;
    delete (PT as { runningWorkers?: object[] }).runningWorkers;
    const lines: string[] = [];
    pool.instrumentPoolGrowth(PT, (l) => lines.push(l), () => 0);
    PT.getNewWorker();
    expect(lines).toEqual(["[pool] grew to 23 Workers at 0 ms (live 22, finished-unreturned 2, unused 1, parked -1; growth 1, starts 1)"]);
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
    expect(pool.poolSample()).toMatchObject({ grown: 0, starts: 0 });
  });
});
