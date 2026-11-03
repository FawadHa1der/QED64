// Runtime lifetime locks (public/workers/lean.worker.js, lib/client.ts, docs/HARDENING.md #55): lifetime signals that
// nothing waits on since R16. The lock names and the prelude every pthread Worker runs before the glue, from the REAL
// worker script in a vm sandbox (the front-door.test.ts pattern); the alive lock boot() takes, through the real worker's
// message handler, against a lock table full of stopping Workers it must not look at; and the wanted lock the page
// holds, on the real LeanSession over a fake Worker (the session-serialization.test.ts pattern).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { LeanSession, type BootConfig } from "../../lib/client";

interface Lifetime {
  ALIVE_LOCK: string;
  WANTED_LOCK: string;
  pthreadPrelude(id: string, glueUrl: string): string;
}

const workers = path.resolve(__dirname, "../../public/workers");

/** The real worker script in a sandbox with this `navigator`. Its message handlers and every message it posts are
 * returned for a test that drives it. */
function loadWorker(navigator: unknown) {
  const handlers: Array<(e: { data: unknown }) => void> = [];
  const posted: Array<Record<string, unknown>> = [];
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
    setTimeout, clearTimeout, setInterval: (fn: () => void, t: number) => { const h = setInterval(fn, t); h.unref(); return h; }, clearInterval,
    fetch: async () => ({ ok: false, status: 404, headers: new Headers() }), // a boot's chunk fetch fails: it ends there
    navigator,
    crossOriginIsolated: true,
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: Record<string, unknown>) => { posted.push(m); };
  sandbox.addEventListener = (type: string, fn: (e: { data: unknown }) => void) => { if (type === "message") handlers.push(fn); };
  sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  const lifetime = (sandbox as { __qed64TestExports?: { lifetime: Lifetime } }).__qed64TestExports!.lifetime;
  return { lifetime, handlers, posted };
}

describe("the alive lock (the worker's half)", () => {
  it("the names stay, and the test surface is the names and the prelude: there is no wait left to test", () => {
    const { lifetime } = loadWorker({});
    expect(Object.keys(lifetime).sort()).toEqual(["ALIVE_LOCK", "WANTED_LOCK", "pthreadPrelude"]);
    expect(lifetime.ALIVE_LOCK).toBe("qed64-alive:");
    expect(lifetime.WANTED_LOCK).toBe("qed64-wanted:");
  });

  it("the pthread prelude takes the runtime's alive lock (shared, held for good) before it loads the glue", async () => {
    const L = loadWorker({}).lifetime;
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
    // The real boot wires the prelude in, both halves: pthreadUrl holds the prelude, and the pool's Workers start from
    // pthreadUrl. No lane reads `qed64-alive:` any more.
    const src = readFileSync(path.join(workers, "lean.worker.js"), "utf8");
    expect(src).toMatch(/const pthreadUrl = instanceId\s*\?\s*URL\.createObjectURL\(new Blob\(\[pthreadPrelude\(instanceId, scriptUrl\)\]/);
    expect(src).toContain("mainScriptUrlOrBlob: pthreadUrl");
  });

  // boot() up to its chunk fetch, which fails here (RUNTIME_FETCH_FAILED, before the allocation).
  const sha = "3ab1c6a9da03bc29" + "f".repeat(48);
  const file = (bytes: number, sha256: string) => ({ bytes, sha256, chunks: [{ url: `/runtime/chunks/${sha256}.0`, bytes, sha256 }] });
  const runtime = { buildId: `wasm64-${sha.slice(0, 16)}`, leanVersion: "4.34.0", files: { "lean.js": file(10, "a".repeat(64)), "lean.wasm": file(20, sha) } };
  async function boot(instance: unknown) {
    const requests: string[] = [];
    let queries = 0;
    const { handlers, posted } = loadWorker({ locks: {
      request: (name: string, opts: { mode: string }, cb: () => Promise<unknown>) => { requests.push(`${name} ${opts.mode}`); return cb(); },
      // 25 Workers of a stopping runtime: what a boot used to wait for.
      query: async () => { queries += 1; return { held: Array.from({ length: 25 }, () => ({ name: "qed64-alive:old", mode: "shared" })), pending: [] }; },
    } });
    const msg = { protocol: 1, type: "boot", requestId: "r1", instance, config: { runtime, memory: { initialBytes: 256 * 1048576, maximumCandidates: [1073741824] }, leanPath: "/lib/lean" } };
    for (const h of handlers) h({ data: msg });
    await vi.waitFor(() => expect(JSON.stringify(posted)).toContain("RUNTIME_FETCH_FAILED"));
    return { requests, queries, text: JSON.stringify(posted) };
  }

  it("boot() holds its alive lock and never looks at the lock table, whatever a stopping runtime has alive", async () => {
    const b = await boot({ id: "me" });
    expect(b.requests).toEqual(["qed64-alive:me shared"]);
    expect(b.queries).toBe(0);
    expect(b.text).not.toMatch(/\[boot\] waited/);
  });

  it("an older page's instance.waitMs and instance.predecessors are ignored; a boot with no id holds nothing", async () => {
    const old = await boot({ id: "me", waitMs: 6000, predecessors: ["old"] });
    expect(old.requests).toEqual(["qed64-alive:me shared"]);
    expect(old.queries).toBe(0);
    const none = await boot(undefined);
    expect(none.requests).toEqual([]);
    expect(none.queries).toBe(0);
  });
});

describe("the wanted lock (the page's half)", () => {
  class FakeWorker {
    static last: FakeWorker;
    posted: Array<{ type: string; instance?: unknown }> = [];
    constructor(_url: string) { FakeWorker.last = this; }
    addEventListener() {}
    removeEventListener() {}
    postMessage(msg: { type: string; instance?: unknown }) { this.posted.push(msg); }
    terminate() {}
  }
  const CONFIG: BootConfig = {
    runtime: {} as BootConfig["runtime"],
    memory: { initialBytes: 256 * 1024 * 1024, maximumCandidates: [4 * 1024 * 1024 * 1024] },
    leanPath: "/lib/lean",
    packs: [],
  };
  const stillHeld = (held: Promise<unknown>) => Promise.race([held.then(() => "released"), new Promise((r) => setTimeout(() => r("still held"), 20))]);

  beforeEach(() => { vi.stubGlobal("Worker", FakeWorker); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a session holds qed64-wanted:<its runtime id> from construction until dispose(), and boots with just that id", async () => {
    const requests: Array<{ name: string; held: Promise<unknown> }> = [];
    vi.stubGlobal("navigator", { locks: { request: (name: string, cb: () => Promise<unknown>) => { const held = cb(); requests.push({ name, held }); return held; } } });
    const session = new LeanSession("/fake.worker.js");
    expect(requests.map((r) => r.name)).toEqual([expect.stringMatching(/^qed64-wanted:.+/)]);
    const id = requests[0]!.name.slice("qed64-wanted:".length);
    expect(await stillHeld(requests[0]!.held)).toBe("still held");
    session.boot(CONFIG).catch(() => {}); // posted synchronously, never answered: the dispose rejects it
    // An older worker in a mixed cache reads the missing waitMs as its 6 s budget.
    expect(FakeWorker.last.posted.find((m) => m.type === "boot")?.instance).toEqual({ id });
    session.dispose();
    expect(await stillHeld(requests[0]!.held)).toBe("released");
  });

  it("a session without Web Locks still constructs and boots", () => {
    vi.stubGlobal("navigator", {});
    const session = new LeanSession("/fake.worker.js");
    session.boot(CONFIG).catch(() => {});
    expect(FakeWorker.last.posted.find((m) => m.type === "boot")?.instance).toEqual({ id: expect.any(String) });
    session.dispose();
  });
});
