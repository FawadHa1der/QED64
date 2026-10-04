// Runtime lifetime locks (public/workers/lean.worker.js, docs/HARDENING.md #55):
// the predecessor wait a booting runtime runs before it allocates its memory
// and its pool, against a fake `navigator.locks` whose lock table the test
// edits while the wait polls, and the prelude every pthread Worker runs before
// the glue — both loaded from the REAL worker script in a vm sandbox (the
// front-door.test.ts pattern).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Lock = { name: string; mode?: string };
interface Table { held: Lock[]; pending: Lock[] }
interface Waited { ids: string[]; waitedMs: number; timedOut: boolean; workers: [number, number] }
interface Lifetime {
  ALIVE_LOCK: string;
  WANTED_LOCK: string;
  STOPPING_WORKERS_TOLERATED: number;
  waitForUnwantedRuntimes(selfId: string | null, budgetMs: number): Promise<Waited>;
  pthreadPrelude(id: string, glueUrl: string): string;
}

function loadWorker(table: Table | null) {
  const workers = path.resolve(__dirname, "../../public/workers");
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error("no network in unit tests")),
    navigator: table ? { locks: { query: async () => ({ held: [...table.held], pending: [...table.pending] }) } } : {},
  };
  sandbox.self = sandbox;
  sandbox.postMessage = () => {};
  sandbox.addEventListener = () => {};
  sandbox.crossOriginIsolated = true;
  sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  return (sandbox as { __qed64TestExports?: { lifetime: Lifetime } }).__qed64TestExports!.lifetime;
}

const alive = (id: string, n: number): Lock[] => Array.from({ length: n }, () => ({ name: `qed64-alive:${id}`, mode: "shared" }));
const wanted = (id: string): Lock => ({ name: `qed64-wanted:${id}`, mode: "exclusive" });

describe("predecessor wait (HARDENING #55)", () => {
  it("returns at once when no runtime is stopping, and when Web Locks are missing", async () => {
    const L = loadWorker({ held: [], pending: [] });
    const w = await L.waitForUnwantedRuntimes("me", 1000);
    expect(w).toMatchObject({ ids: [], timedOut: false, workers: [0, 0] });
    expect(w.waitedMs).toBeLessThan(100);
    const none = loadWorker(null);
    expect(await none.waitForUnwantedRuntimes("me", 1000)).toMatchObject({ ids: [], timedOut: false });
    expect(await L.waitForUnwantedRuntimes(null, 1000)).toMatchObject({ ids: [], timedOut: false });
  });

  it("never waits for itself or for a runtime that is still wanted (another tab, another frame)", async () => {
    const table: Table = { held: [...alive("me", 25), wanted("me"), ...alive("other-tab", 25), wanted("other-tab")], pending: [] };
    const w = await loadWorker(table).waitForUnwantedRuntimes("me", 1000);
    expect(w).toMatchObject({ ids: [], timedOut: false, workers: [0, 0] });
  });

  it("waits while a stopping runtime keeps more Workers alive than tolerated, counting pending requests too", async () => {
    const table: Table = { held: [...alive("old", 20)], pending: alive("old", 5) };
    const L = loadWorker(table);
    expect(L.STOPPING_WORKERS_TOLERATED).toBe(12);
    let settled = false;
    const p = L.waitForUnwantedRuntimes("me", 5000).then((w) => { settled = true; return w; });
    await new Promise((r) => setTimeout(r, 120));
    expect(settled).toBe(false); // 25 alive
    table.held = alive("old", 13); table.pending = []; // the idle Workers went
    await new Promise((r) => setTimeout(r, 120));
    expect(settled).toBe(false); // 13 > 12
    table.held = alive("old", 11); // only busy pthreads in their 2 s grace remain
    const w = await p;
    expect(w).toMatchObject({ ids: ["old"], timedOut: false, workers: [25, 11] });
    expect(w.waitedMs).toBeGreaterThanOrEqual(200);
  });

  it("gives up when the budget is spent, and says so", async () => {
    const L = loadWorker({ held: alive("stuck", 25), pending: [] });
    const w = await L.waitForUnwantedRuntimes("me", 150);
    expect(w).toMatchObject({ ids: ["stuck"], timedOut: true, workers: [25, 25] });
    expect(w.waitedMs).toBeGreaterThanOrEqual(150);
  });

  it("the pthread prelude takes the runtime's alive lock (shared, held for good) before it loads the glue", async () => {
    const L = loadWorker({ held: [], pending: [] });
    const calls: string[] = [];
    let held: Promise<unknown> | null = null;
    const pthread = vm.createContext({
      navigator: { locks: { request: (name: string, opts: { mode: string }, cb: () => Promise<unknown>) => { calls.push(`lock ${name} ${opts.mode}`); held = cb(); return held; } } },
      importScripts: (url: string) => calls.push(`import ${url}`),
    });
    vm.runInContext(L.pthreadPrelude("rt-1", "blob:http://x/glue"), pthread);
    expect(calls).toEqual(["lock qed64-alive:rt-1 shared", "import blob:http://x/glue"]);
    const raced = await Promise.race([held, new Promise((r) => setTimeout(() => r("still held"), 50))]);
    expect(raced).toBe("still held");
    // A context without Web Locks still loads the glue.
    const bare: string[] = [];
    vm.runInContext(L.pthreadPrelude("rt-2", "blob:http://x/glue"), vm.createContext({ navigator: {}, importScripts: (u: string) => bare.push(u) }));
    expect(bare).toEqual(["blob:http://x/glue"]);
  });
});
