// Runtime lifetime locks (public/workers/lean.worker.js, docs/HARDENING.md #55,
// #68): the predecessor wait a booting runtime runs before it allocates its
// memory and its pool, against a fake `navigator.locks` whose lock table the
// test edits while the wait polls, the validation of the runtimes a page names
// as replaced, and the prelude every pthread Worker runs before the glue — all
// loaded from the REAL worker script in a vm sandbox (the front-door.test.ts
// pattern).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Lock = { name: string; mode?: string };
interface Table { held: Lock[]; pending: Lock[] }
interface Waited { ids: string[]; waitedMs: number; timedOut: boolean; workers: [number, number]; own: [number, number] }
interface Lifetime {
  ALIVE_LOCK: string;
  WANTED_LOCK: string;
  STOPPING_WORKERS_TOLERATED: number;
  MAX_NAMED_PREDECESSORS: number;
  namedPredecessors(instance: unknown, selfId: string | null): string[];
  waitForUnwantedRuntimes(selfId: string | null, budgetMs: number, named?: string[]): Promise<Waited>;
  waitedLine(waited: Partial<Waited> & { ids: string[]; waitedMs: number; error?: string }): string;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  it("exactly 12 with nothing named returns at once (the tolerance's boundary)", async () => {
    const w = await loadWorker({ held: alive("old", 12), pending: [] }).waitForUnwantedRuntimes("me", 5000);
    expect(w).toMatchObject({ ids: ["old"], timedOut: false, workers: [12, 12], own: [0, 0] });
    expect(w.waitedMs).toBeLessThan(100);
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

describe("named predecessors (HARDENING #68): the runtimes this page replaced are waited for to their last Worker", () => {
  it("waits for every Worker of a named predecessor, even within the tolerance", async () => {
    const table: Table = { held: alive("old", 9), pending: [] };
    const L = loadWorker(table);
    let settled = false;
    const p = L.waitForUnwantedRuntimes("me", 5000, ["old"]).then((w) => { settled = true; return w; });
    await sleep(120);
    expect(settled).toBe(false); // 9 ≤ 12, but every one is the replaced runtime's (its busy pthreads in their grace)
    table.held = alive("old", 1);
    await sleep(120);
    expect(settled).toBe(false); // its last Worker
    table.held = [];
    const w = await p;
    expect(w).toMatchObject({ ids: ["old"], timedOut: false, workers: [9, 0], own: [9, 0] });
    expect(w.waitedMs).toBeGreaterThanOrEqual(200);
  });

  it("a named predecessor already gone costs nothing; other stopping runtimes keep the tolerance", async () => {
    const w = await loadWorker({ held: alive("prev-doc", 11), pending: [] }).waitForUnwantedRuntimes("me", 5000, ["old"]);
    expect(w).toMatchObject({ ids: ["prev-doc"], timedOut: false, workers: [11, 11], own: [0, 0] });
    expect(w.waitedMs).toBeLessThan(100);
  });

  it("others above the tolerance still wait, and exactly 12 releases", async () => {
    const table: Table = { held: alive("prev-doc", 13), pending: [] };
    const L = loadWorker(table);
    let settled = false;
    const p = L.waitForUnwantedRuntimes("me", 5000, ["old"]).then((w) => { settled = true; return w; });
    await sleep(120);
    expect(settled).toBe(false); // 13 > 12
    table.held = alive("prev-doc", 12);
    const w = await p;
    expect(w).toMatchObject({ ids: ["prev-doc"], timedOut: false, workers: [13, 12], own: [0, 0] });
  });

  it("a named runtime that is still wanted is never waited for", async () => {
    const w = await loadWorker({ held: [...alive("live", 25), wanted("live")], pending: [] }).waitForUnwantedRuntimes("me", 5000, ["live"]);
    expect(w).toMatchObject({ ids: [], timedOut: false, workers: [0, 0], own: [0, 0] });
  });

  it("a named predecessor that never dies spends the budget, and says so", async () => {
    const w = await loadWorker({ held: alive("old", 3), pending: [] }).waitForUnwantedRuntimes("me", 150, ["old"]);
    expect(w).toMatchObject({ ids: ["old"], timedOut: true, workers: [3, 3], own: [3, 3] });
    expect(w.waitedMs).toBeGreaterThanOrEqual(150);
  });

  it("never names itself", async () => {
    const L = loadWorker({ held: alive("me", 25), pending: [] });
    const w = await L.waitForUnwantedRuntimes("me", 5000, ["me"]);
    expect(w).toMatchObject({ ids: [], timedOut: false, workers: [0, 0], own: [0, 0] });
    expect(w.waitedMs).toBeLessThan(100);
    expect(L.namedPredecessors({ predecessors: ["me"] }, "me")).toEqual([]);
  });

  it("namedPredecessors keeps id-shaped strings, deduplicated, never itself, the newest 8; anything else names none", () => {
    const L = loadWorker({ held: [], pending: [] });
    expect(L.MAX_NAMED_PREDECESSORS).toBe(8);
    // An older page's boot (no field) and a malformed field are today's behaviour, never a failed boot.
    for (const instance of [undefined, null, {}, { predecessors: "x" }]) expect(L.namedPredecessors(instance, "me")).toEqual([]);
    expect(L.namedPredecessors({ predecessors: [1, null, "", "x".repeat(65), "a b", "a", "a", "me", "b"] }, "me")).toEqual(["a", "b"]);
    const twenty = Array.from({ length: 20 }, (_, i) => `rt-${i}`);
    expect(L.namedPredecessors({ predecessors: twenty }, "me")).toEqual(twenty.slice(-8));
    // Both id formats client.ts makes: randomUUID, and its fallback.
    const ids = [crypto.randomUUID(), `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`];
    expect(L.namedPredecessors({ predecessors: ids }, "me")).toEqual(ids);
  });
});

// HARDENING #68: the waited line is parsed downstream, and boot() must hand the page's list to the wait.
describe("the [boot] waited line and boot()'s wiring of the page's named predecessors (HARDENING #68)", () => {
  // The widgets showcase's parser (qed64-showcase tests/ux/lib/qed64.mjs BOOT_WAITED_RE), applied to the worker's
  // stderr as the page logs it ("[lean:stderr] " + line). Copied verbatim: a change here must be agreed with it.
  const BOOT_WAITED_RE = /^\[lean:stderr\] \[boot\] waited (\d+) ms for (\d+) stopping runtime\(s\) \(([^)]*) Workers alive\)( — budget spent, booting anyway)?/;
  const lt = loadWorker({ held: [], pending: [] });
  const parse = (line: string) => BOOT_WAITED_RE.exec(`[lean:stderr] ${line}`);

  it("the suffix stays LAST: budget spent is still right after 'Workers alive)', and the start parses", () => {
    const both = lt.waitedLine({ ids: ["old"], waitedMs: 6001, timedOut: true, workers: [9, 3], own: [9, 3] });
    expect(both).toBe("[boot] waited 6001 ms for 1 stopping runtime(s) (9 → 3 Workers alive) — budget spent, booting anyway; 9 → 3 of them replaced by this page");
    expect(parse(both)?.slice(1)).toEqual(["6001", "1", "9 → 3", " — budget spent, booting anyway"]);
    const suffixOnly = lt.waitedLine({ ids: ["old"], waitedMs: 412, timedOut: false, workers: [9, 0], own: [9, 0] });
    expect(suffixOnly).toBe("[boot] waited 412 ms for 1 stopping runtime(s) (9 → 0 Workers alive); 9 → 0 of them replaced by this page");
    expect(parse(suffixOnly)?.slice(1)).toEqual(["412", "1", "9 → 0", undefined]);
  });

  it("no named Worker alive at either count: no suffix (today's line); alive only at the last count: suffix", () => {
    expect(lt.waitedLine({ ids: ["prev-doc"], waitedMs: 0, timedOut: false, workers: [11, 11], own: [0, 0] }))
      .toBe("[boot] waited 0 ms for 1 stopping runtime(s) (11 → 11 Workers alive)");
    expect(lt.waitedLine({ ids: ["prev-doc"], waitedMs: 0, timedOut: false, workers: [11, 11] }))
      .toBe("[boot] waited 0 ms for 1 stopping runtime(s) (11 → 11 Workers alive)");
    expect(lt.waitedLine({ ids: ["old"], waitedMs: 6002, timedOut: true, workers: [13, 2], own: [0, 2] }))
      .toMatch(/ — budget spent, booting anyway; 0 → 2 of them replaced by this page$/);
  });

  it("boot() passes the page's instance.predecessors into the wait: a named runtime with one Worker alive keeps it polling; without the field it returns at once", async () => {
    const workers = path.resolve(__dirname, "../../public/workers");
    const sha = "3ab1c6a9da03bc29" + "f".repeat(48);
    const file = (bytes: number, sha256: string) => ({ bytes, sha256, chunks: [{ url: `/runtime/chunks/${sha256}.0`, bytes, sha256 }] });
    const runtime = { buildId: `wasm64-${sha.slice(0, 16)}`, leanVersion: "4.34.0", files: { "lean.js": file(10, "a".repeat(64)), "lean.wasm": file(20, sha) } };
    async function queriesDuring(instance: unknown, ms: number) {
      let queries = 0;
      const handlers: Array<(e: { data: unknown }) => void> = [];
      const sandbox: Record<string, unknown> = {
        crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
        setTimeout, clearTimeout, setInterval: (fn: () => void, t: number) => { const h = setInterval(fn, t); h.unref(); return h; }, clearInterval,
        fetch: async () => ({ ok: false, status: 404, headers: new Headers() }), // the chunk fetch fails; the wait was already started
        navigator: { locks: {
          request: async () => undefined,
          query: async () => { queries += 1; return { held: [{ name: "qed64-alive:old", mode: "shared" }], pending: [] }; },
        } },
        crossOriginIsolated: true,
      };
      sandbox.self = sandbox;
      sandbox.postMessage = () => {};
      sandbox.addEventListener = (type: string, fn: (e: { data: unknown }) => void) => { if (type === "message") handlers.push(fn); };
      sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
      vm.createContext(sandbox);
      vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
      const msg = { protocol: 1, type: "boot", requestId: "r1", instance, config: { runtime, memory: { initialBytes: 256 * 1048576, maximumCandidates: [1073741824] }, leanPath: "/lib/lean" } };
      for (const h of handlers) h({ data: msg });
      await new Promise((r) => setTimeout(r, ms));
      return queries;
    }
    const named = await queriesDuring({ id: "me", waitMs: 5000, predecessors: ["old"] }, 300);
    const unnamed = await queriesDuring({ id: "me", waitMs: 5000 }, 300);
    expect(unnamed).toBe(1); // one Worker of an unnamed runtime is within the tolerance: one query, no wait
    expect(named).toBeGreaterThan(4); // the named runtime's Worker keeps the 25 ms poll going
  });
});

