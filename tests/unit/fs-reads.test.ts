// tests/adversarial/fs-reads.mjs is R15's measurement (e2e --fs-reads): it counts the library files every
// lean.worker's Emscripten FS opens or finds, so a run can show that a stock session reads nothing under
// /lib/packs/core. The lane judges a real page; this pins the path classes, the in-worker wrapper (run as Playwright
// runs it: its source text evaluated in a separate global, here a vm context over a fake FS) and the summary.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import vm from "node:vm";
import { LEAN_WORKER_RE, classifyFsPath, createFsReads, installInWorker, normalizeFsPath, summarizeFsReads, type FsReadsRecord } from "../adversarial/fs-reads.mjs";

type Ctx = Record<string, any>;
/** A worker-like global: `self` is the global, with the host's (faked) timers. */
function workerGlobal(): Ctx {
  const ctx: Ctx = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, performance, Date, Math, JSON };
  ctx.self = ctx;
  return vm.createContext(ctx);
}
/** Playwright's evaluate: the function's source text called in the target's global, the result structured-cloned. */
const evaluateIn = (ctx: Ctx) => (fn: () => unknown) => structuredClone(vm.runInContext(`(${fn.toString()})()`, ctx));
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function fakeFS(present: Set<string>) {
  const enoent = () => Object.assign(new Error("ENOENT"), { name: "ErrnoError", errno: 44 });
  return {
    open(p: string, _flags?: unknown) { if (!present.has(p)) throw enoent(); return { fd: 3, path: p }; },
    stat(p: string, _dontFollow?: boolean) { if (!present.has(p)) throw enoent(); return { mode: 0o100644, size: 7 }; },
    readdir(p: string) { if (!present.has(p)) throw enoent(); return [".", ".."]; },
    cwd: () => "/workspace",
  } as Record<string, any>;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("classifyFsPath", () => {
  test("module files under /lib are library; other /lib paths are lib-other; the rest is outside", () => {
    for (const p of ["/lib/packs/core/Init/Data/Nat/Basic.olean", "/lib/packs/core/Init/Data/Nat/Basic.olean.server", "/lib/packs/core/Init/Data/Nat/Basic.ir.sig", "/lib/lean/Init.ir", "/lib/packs/core/Init/Prelude.olean.private", "/lib/packs/core/Init/Prelude.ilean"]) {
      expect(classifyFsPath(p), p).toBe("library");
    }
    for (const p of ["/lib/packs/core/Init", "/lib/lean/Mathlib/Data/Real/Basic.lean", "/lib"]) expect(classifyFsPath(p), p).toBe("lib-other");
    for (const p of ["/workspace/Probe.lean", "/snapshots/mathlib.snap", "/library/X.olean", "Init.olean"]) expect(classifyFsPath(p), p).toBe("outside");
  });

  test("the path is normalized first: Lean's sysroot is /bin/.., so its library directory is /bin/../lib/lean", () => {
    expect(normalizeFsPath("/bin/../lib/lean/Init.olean")).toBe("/lib/lean/Init.olean");
    expect(normalizeFsPath("/lib/packs/core/./Init//Prelude.olean")).toBe("/lib/packs/core/Init/Prelude.olean");
    expect(normalizeFsPath("/../..")).toBe("/");
    expect(classifyFsPath("/bin/../lib/lean/Init/Prelude.olean")).toBe("library");
    expect(classifyFsPath("/workspace/../lib/packs/core/Init.ir")).toBe("library");
    expect(classifyFsPath("/bin/../src/lean/Mathlib.lean")).toBe("outside");
    expect(classifyFsPath("/lib/../workspace/X.olean")).toBe("outside");
  });

  test("only the lean.worker script is instrumented, not its pthreads or the prefetch worker", () => {
    expect(LEAN_WORKER_RE.test("http://localhost:5341/workers/lean.worker.js")).toBe(true);
    expect(LEAN_WORKER_RE.test("http://localhost:5341/workers/lean.worker.js?v=2")).toBe(true);
    expect(LEAN_WORKER_RE.test("blob:http://localhost:5341/0f1e2d3c")).toBe(false);
    expect(LEAN_WORKER_RE.test("http://localhost:5341/workers/snapshot-prefetch.worker.js")).toBe(false);
    expect(LEAN_WORKER_RE.test("http://localhost:5341/workers/lean.worker.jsx")).toBe(false);
  });
});

describe("installInWorker", () => {
  test("waits for the glue's Module.FS, then records hit and miss per op and path, with LEAN_PATH", () => {
    const ctx = workerGlobal();
    const id = vm.runInContext(`(${installInWorker})()`, ctx);
    expect(typeof id).toBe("string");
    expect(ctx.__qed64FsReads.installedAt).toBeNull();
    const fake = fakeFS(new Set(["/lib/packs/core/Init/Prelude.olean", "/lib/packs/core/Init/Prelude.ir"]));
    const original = fake.open;
    ctx.Module = { ENV: { LEAN_PATH: "/lib/packs/core" }, FS: fake };
    vi.advanceTimersByTime(5);
    expect(typeof ctx.__qed64FsReads.installedAt).toBe("number");
    expect(fake.open).not.toBe(original);
    expect(ctx.Module.FS.__qed64FsReads).toBe(true);
    // The original's return value and its throw pass through.
    expect(ctx.Module.FS.open("/lib/packs/core/Init/Prelude.olean", 0)).toEqual({ fd: 3, path: "/lib/packs/core/Init/Prelude.olean" });
    expect(() => ctx.Module.FS.open("/lib/packs/core/Init/Missing.olean", 0)).toThrow("ENOENT");
    expect(ctx.Module.FS.stat("/lib/packs/core/Init/Prelude.ir")).toEqual({ mode: 0o100644, size: 7 });
    expect(() => ctx.Module.FS.stat("/lib/packs/core/Init/Missing.ir", true)).toThrow("ENOENT");
    expect(() => ctx.Module.FS.readdir("/lib/packs/core/Init")).toThrow("ENOENT");
    // An open with write access (FS.writeFile's 577, a mode string) is a write, never a read.
    ctx.Module.FS.open("/lib/packs/core/Init/Prelude.olean", 577);
    ctx.Module.FS.open("/lib/packs/core/Init/Prelude.olean", "w");
    const rec = plain(ctx.__qed64FsReads);
    expect(rec.leanPath).toBe("/lib/packs/core");
    expect(rec.paths).toEqual({
      "open-hit /lib/packs/core/Init/Prelude.olean": 1,
      "open-miss /lib/packs/core/Init/Missing.olean": 1,
      "stat-hit /lib/packs/core/Init/Prelude.ir": 1,
      "stat-miss /lib/packs/core/Init/Missing.ir": 1,
      "readdir-miss /lib/packs/core/Init": 1,
      "write-hit /lib/packs/core/Init/Prelude.olean": 2,
    });
    expect(rec.distinct).toBe(6);
    expect(rec.errors).toBe(0);
  });

  test("a second install returns the same id and does not wrap twice", () => {
    const ctx = workerGlobal();
    ctx.Module = { ENV: {}, FS: fakeFS(new Set(["/workspace/A.lean"])) };
    const id = vm.runInContext(`(${installInWorker})()`, ctx);
    const wrapped = ctx.Module.FS.open;
    expect(vm.runInContext(`(${installInWorker})()`, ctx)).toBe(id);
    expect(ctx.Module.FS.open).toBe(wrapped);
    ctx.Module.FS.open("/workspace/A.lean", 0);
    // A relative path is recorded against the FS's cwd, as the FS resolves it.
    expect(() => ctx.Module.FS.stat("../lib/packs/core/Init.olean")).toThrow("ENOENT");
    expect(plain(ctx.__qed64FsReads.paths)).toEqual({ "open-hit /workspace/A.lean": 1, "stat-miss /workspace/../lib/packs/core/Init.olean": 1 });
    // No LEAN_PATH yet (it is assigned at preRun): the record says so rather than guessing.
    expect(ctx.__qed64FsReads.leanPath).toBeNull();
  });
});

describe("summarizeFsReads", () => {
  const rec = (id: string, leanPath: string | null, installedAt: number | null, paths: Record<string, number>): FsReadsRecord =>
    ({ id, installedAt, leanPath, paths, distinct: Object.keys(paths).length, overflow: 0, errors: 0 });

  test("groups by LEAN_PATH, counts library hits and misses, keeps writes apart, and counts the blind", () => {
    const s = summarizeFsReads([
      rec("a", "/lib/packs/core", 1, {
        "open-hit /lib/packs/core/Init/Prelude.olean": 2,
        "stat-hit /lib/packs/core/Init/Prelude.ir": 1,
        "stat-miss /lib/packs/core/Foo.olean": 3,
        "readdir-hit /lib/packs/core/Init": 1,
        "open-hit /snapshots/init.snap": 1,
        "write-hit /lib/packs/core/Init/Core.olean": 1,
        "stat-miss /bin/../src/lean/Init.lean": 4,
      }),
      rec("b", "/lib/packs/core:/lib/packs/essential", 2, { "open-hit /lib/packs/essential/Mathlib/Order/Basic.olean": 5 }),
      rec("c", "/lib/packs/core", 3, { "open-hit /lib/packs/core/Init/Prelude.olean": 1, "stat-miss /bin/../lib/lean/Init/Prelude.olean": 1 }),
      rec("d", null, null, {}),
    ], { installFailures: 1 });
    expect(s.workers).toBe(4);
    expect(s.blind).toBe(1);
    expect(s.installFailures).toBe(1);
    expect(Object.keys(s.sessions).sort()).toEqual(["", "/lib/packs/core", "/lib/packs/core:/lib/packs/essential"]);
    const core = s.sessions["/lib/packs/core"]!;
    expect(core.workers).toBe(2);
    expect(core.library).toEqual({
      hits: 4, misses: 4, writes: 1, distinct: 4,
      sample: [
        { op: "open-hit", path: "/lib/packs/core/Init/Prelude.olean", n: 3 },
        { op: "stat-miss", path: "/lib/packs/core/Foo.olean", n: 3 },
        { op: "stat-hit", path: "/lib/packs/core/Init/Prelude.ir", n: 1 },
        { op: "stat-miss", path: "/bin/../lib/lean/Init/Prelude.olean", n: 1 },
      ],
    });
    expect(core.libOther).toEqual({ total: 1, sample: [{ op: "readdir-hit", path: "/lib/packs/core/Init", n: 1 }] });
    expect(core.outside).toEqual({ total: 5, sample: [{ op: "stat-miss", path: "/bin/../src/lean/Init.lean", n: 4 }, { op: "open-hit", path: "/snapshots/init.snap", n: 1 }] });
    expect(s.sessions["/lib/packs/core:/lib/packs/essential"]!.library.hits).toBe(5);
    expect(s.sessions[""]!.library.hits).toBe(0);
  });
});

describe("createFsReads", () => {
  test("installs on each lean.worker a page spawns, polls the records, and summarizes them", async () => {
    const ctx = workerGlobal();
    const hooks: { worker?: (w: unknown) => void } = {};
    const lean = { url: () => "http://localhost:5341/workers/lean.worker.js", evaluate: async (fn: () => unknown) => evaluateIn(ctx)(fn) };
    const pthread = { url: () => "blob:http://localhost:5341/1", evaluate: async () => { throw new Error("a pthread is never evaluated"); } };
    const broken = { url: () => "http://localhost:5341/workers/lean.worker.js", evaluate: async () => { throw new Error("Target closed"); } };
    const workers: unknown[] = [];
    const page = { on: (ev: string, cb: (w: unknown) => void) => { if (ev === "worker") hooks.worker = cb; }, workers: () => workers, isClosed: () => false };
    const fsReads = createFsReads({ pollMs: 1000 });
    fsReads.attach(page);
    fsReads.attach(page);
    workers.push(lean, pthread);
    hooks.worker!(lean);
    hooks.worker!(pthread);
    hooks.worker!(broken);
    await vi.advanceTimersByTimeAsync(0);
    ctx.Module = { ENV: { LEAN_PATH: "/lib/packs/core" }, FS: fakeFS(new Set(["/snapshots/init.snap", "/lib/packs/core/Init/Prelude.olean"])) };
    await vi.advanceTimersByTimeAsync(5);
    ctx.Module.FS.open("/snapshots/init.snap", 0);
    await vi.advanceTimersByTimeAsync(1000);
    ctx.Module.FS.stat("/lib/packs/core/Init/Prelude.olean");
    const s = await fsReads.finish();
    expect(s.workers).toBe(1);
    expect(s.blind).toBe(0);
    expect(s.installFailures).toBe(1);
    expect(s.sessions["/lib/packs/core"]!.outside.total).toBe(1);
    expect(s.sessions["/lib/packs/core"]!.library.hits).toBe(1);
  });
});
