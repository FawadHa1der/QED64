// The library half of the embedding contract (docs/EMBEDDING.md §7):
// structured progress (every busy/progress call carries a stage), failure
// causes (the classification table against the worker's real messages),
// session files + the pre-arm hook (every boot, in order, before arm), the raw
// prefetch as a function, and the offline URL list. Over a fake Worker, a
// spied LeanSession and an OPFS stub — no wasm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deathCause, failureCauseOf, failureKindOf, stageOfWorkerPhase } from "../../frontend/src/embed/failure";
import { runtimeUrls } from "../../frontend/src/embed/urls";
import { prefetchRaw, type ProgressInfo, type Qed64Artifacts, type StatusSink } from "../../frontend/src/qed64-boot";
import { ResidentSession, type ResidentHost } from "../../frontend/src/resident-session";
import type { RuntimeManifest } from "../../src/runtime/client";

describe("failureKindOf: the worker's real messages", () => {
  it.each([
    ["SNAPSHOT_UNPAIRED", "snapshot 'mathlib.snap' was baked for runtime wasm64-aaaaaaaaaaaaaaaa; this worker booted wasm64-bbbbbbbbbbbbbbbb", "unpaired"],
    ["SNAPSHOT_FAILED", "snapshot: could not allocate 1127272685 bytes in the wasm heap", "oom"],
    ["MEMORY_FAILED", "Memory64 reservation of 6 GiB refused", "oom"],
    [undefined, "Cannot enlarge memory, requested 6442450944 bytes", "oom"],
    ["SNAPSHOT_FAILED", "snapshot fetch: HTTP 503", "network"],
    [undefined, "Failed to fetch", "network"],
    [undefined, "NetworkError when attempting to fetch resource.", "network"],
    ["RUNTIME_FETCH_FAILED", "lean.wasm chunk 3: HTTP 404", "missing"],
    ["RUNTIME_FETCH_FAILED", "lean.wasm chunk 3: HTTP 410", "missing"],
    ["RUNTIME_FETCH_FAILED", "lean.wasm chunk 3: HTTP 429", "network"],
    [undefined, "runtime manifest: Unexpected token '<', \"<!doctype \"... is not valid JSON", "missing"],
    ["SNAPSHOT_NOT_IN_INDEX", "snapshot 'x' is not in the snapshot index", "missing"],
    ["RUNTIME_FETCH_FAILED", "lean.wasm chunk 3 failed SHA-256 verification.", "corrupt"],
    ["RUNTIME_FETCH_FAILED", "lean.wasm chunk 3: 1048576 bytes, expected 4194304.", "corrupt"],
    [undefined, "incorrect header check", "corrupt"],
    [undefined, "QuotaExceededError: the quota has been exceeded", "storage"],
    ["COMPILE_CRASHED", "something else entirely", "other"],
  ] as const)("%s %s → %s", (code, message, kind) => {
    expect(failureKindOf(code, message)).toBe(kind);
  });

  it("failureCauseOf keeps a page step's own cause and classifies everything else", () => {
    const own = { kind: "corrupt" as const, stage: "snapshot" as const, subject: "init", message: "refused" };
    expect(failureCauseOf(Object.assign(new Error("x"), { cause: own }), { stage: "files" })).toEqual({ ...own, message: "refused" });
    expect(failureCauseOf(Object.assign(new Error("snapshot fetch: HTTP 404"), { code: "SNAPSHOT_FAILED" }), { stage: "snapshot", subject: "mathlib" }))
      .toEqual({ kind: "missing", httpStatus: 404, stage: "snapshot", subject: "mathlib", code: "SNAPSHOT_FAILED", message: "snapshot fetch: HTTP 404" });
    expect(failureCauseOf(Object.assign(new Error("snapshot fetch: HTTP 503"), { code: "SNAPSHOT_FAILED" }))).toMatchObject({ kind: "network", httpStatus: 503 });
    expect(failureCauseOf("plain string").kind).toBe("other");
  });

  it("deathCause: null only for a bare error event; a script that never ran is WORKER_SCRIPT_LOAD_FAILED; codes go through the table; the rest is the checker's own", () => {
    expect(deathCause("crash", "", { bare: true, beforeHello: false })).toBeNull();
    expect(deathCause("crash", "", { bare: true, beforeHello: true })).toMatchObject({ kind: "other", code: "WORKER_SCRIPT_LOAD_FAILED" });
    expect(deathCause("WORKER_DEP_MISSING", "importScripts failed", { errorCode: "WORKER_DEP_MISSING" })).toMatchObject({ kind: "other", code: "WORKER_SCRIPT_LOAD_FAILED" });
    expect(deathCause("RUNTIME_FETCH_FAILED", "lean.wasm chunk 3: HTTP 404", { errorCode: "RUNTIME_FETCH_FAILED" }, { stage: "runtime" }))
      .toEqual({ kind: "missing", httpStatus: 404, stage: "runtime", code: "RUNTIME_FETCH_FAILED", message: "lean.wasm chunk 3: HTTP 404" });
    expect(deathCause("RUNTIME_FETCH_FAILED", "lean.wasm chunk 3 failed SHA-256 verification.", { errorCode: "RUNTIME_FETCH_FAILED" })).toMatchObject({ kind: "corrupt" });
    expect(deathCause("abort", "Aborted(Cannot enlarge memory)")).toEqual({ kind: "oom", code: "abort", message: "Aborted(Cannot enlarge memory)" });
    expect(deathCause("wedged", "no frame for 16 s")).toEqual({ kind: "other", code: "wedged", message: "no frame for 16 s" });
    expect(deathCause("crash", "Uncaught RuntimeError: memory access out of bounds", { beforeHello: false })).toMatchObject({ kind: "other", code: "crash" });
  });

  it("maps every worker progress phase to a stage", () => {
    expect(stageOfWorkerPhase("runtime")).toEqual({ stage: "runtime", step: "verify" });
    expect(stageOfWorkerPhase("snapshot-init").stage).toBe("modules");
    expect(stageOfWorkerPhase("import").stage).toBe("modules");
    expect(stageOfWorkerPhase("snapshot-cache")).toEqual({ stage: "snapshot", step: "read" });
    expect(stageOfWorkerPhase("memory").stage).toBe("memory");
    expect(stageOfWorkerPhase("something-new").stage).toBe("runtime");
  });
});

describe("runtimeUrls", () => {
  it("lists both manifests, every chunk once in order, and the four workers", () => {
    const m = {
      buildId: "wasm64-3ab1c6a9da03bc29", leanVersion: "4.34.0",
      files: {
        "lean.js": { bytes: 2, sha256: "", chunks: [{ url: "/runtime/chunks/lean.js.a.part-000", bytes: 1, sha256: "" }, { url: "/runtime/chunks/lean.js.a.part-001", bytes: 1, sha256: "" }] },
        "lean.wasm": { bytes: 1, sha256: "", chunks: [{ url: "/runtime/chunks/lean.wasm.b.part-000", bytes: 1, sha256: "" }, { url: "/runtime/chunks/lean.wasm.b.part-000", bytes: 1, sha256: "" }] },
      },
    } as RuntimeManifest;
    expect(runtimeUrls(m)).toEqual({
      manifests: ["/runtime/runtime-manifest.wasm64-3ab1c6a9da03bc29.json", "/runtime/runtime-manifest.json"],
      chunks: ["/runtime/chunks/lean.js.a.part-000", "/runtime/chunks/lean.js.a.part-001", "/runtime/chunks/lean.wasm.b.part-000"],
      workers: ["/workers/lean.worker.js", "/workers/lsp-frames.js", "/workers/lsp-front-door.js", "/workers/snapshot-prefetch.worker.js"],
    });
  });
});

// ---------------------------------------------------------------- prefetchRaw

class FakePrefetch {
  static instances: FakePrefetch[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor(readonly url: string) { FakePrefetch.instances.push(this); }
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  addEventListener() {}
  emit(data: unknown) { this.onmessage?.({ data }); }
}
const entry = { name: "mathlib", url: "/snapshots/mathlib.x.snapz", bytes: 1000, transfer: 400, digest: `sha256:${"ab".repeat(32)}`, imports: [] };
/** OPFS stub: `cached` = the size of an existing raw file, or null for none; `opfs: false` = no OPFS at all. */
function opfs(cached: number | null, available = true) {
  const dir = { getFileHandle: async () => { if (cached === null) throw new Error("NotFoundError"); return { getFile: async () => ({ size: cached }) }; } };
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => { if (!available) throw new Error("SecurityError"); return { getDirectoryHandle: async () => dir }; } } });
}
async function spawned(): Promise<FakePrefetch> {
  for (let i = 0; i < 20 && FakePrefetch.instances.length === 0; i++) await vi.advanceTimersByTimeAsync(0);
  expect(FakePrefetch.instances).toHaveLength(1);
  return FakePrefetch.instances[0]!;
}

describe("prefetchRaw", () => {
  beforeEach(() => { vi.useFakeTimers(); FakePrefetch.instances = []; vi.stubGlobal("Worker", FakePrefetch); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("cached: a complete raw region spawns no worker", async () => {
    opfs(1000);
    await expect(prefetchRaw(entry)).resolves.toEqual({ status: "cached", bytes: 1000 });
    expect(FakePrefetch.instances).toHaveLength(0);
  });
  it("unavailable: no OPFS spawns no worker", async () => {
    opfs(null, false);
    await expect(prefetchRaw(entry)).resolves.toEqual({ status: "unavailable" });
    expect(FakePrefetch.instances).toHaveLength(0);
  });
  it("done: progress is reported with its step, the worker is terminated, workerUrl is honoured", async () => {
    opfs(400); // a partial raw file is not a cache hit
    const seen: unknown[] = [];
    const r = prefetchRaw(entry, { onProgress: (p) => seen.push(p), workerUrl: "/game/workers/snapshot-prefetch.worker.js" });
    const w = await spawned();
    expect(w.url).toBe("/game/workers/snapshot-prefetch.worker.js");
    expect(w.posted[0]).toMatchObject({ url: entry.url, rawBytes: 1000 });
    w.emit({ status: "progress", bytes: 300, total: 1000, phase: "download" });
    w.emit({ status: "progress", bytes: 900, total: 1000, phase: "inflate" });
    w.emit({ status: "done", bytes: 1000 });
    await expect(r).resolves.toEqual({ status: "done", bytes: 1000 });
    expect(seen).toEqual([{ loaded: 300, total: 1000, step: "download" }, { loaded: 900, total: 1000, step: "inflate" }]);
    expect(w.terminated).toBe(true);
  });
  it("error: the worker's failure comes back classified", async () => {
    opfs(null);
    const r = prefetchRaw(entry);
    (await spawned()).emit({ status: "error", error: "snapshot fetch: HTTP 404" });
    await expect(r).resolves.toEqual({ status: "error", error: { kind: "missing", httpStatus: 404, stage: "snapshot", subject: "mathlib", message: "snapshot fetch: HTTP 404" } });
  });
  it("silent: no message for silenceMs terminates it", async () => {
    opfs(null);
    const r = prefetchRaw(entry, { silenceMs: 5000 });
    const w = await spawned();
    await vi.advanceTimersByTimeAsync(4999);
    expect(w.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(r).resolves.toEqual({ status: "silent" });
    expect(w.terminated).toBe(true);
  });
  it("aborted: the signal terminates it (and an already-aborted signal spawns nothing)", async () => {
    opfs(null);
    const ac = new AbortController();
    const r = prefetchRaw(entry, { signal: ac.signal });
    const w = await spawned();
    ac.abort();
    await expect(r).resolves.toEqual({ status: "aborted" });
    expect(w.terminated).toBe(true);
    await expect(prefetchRaw(entry, { signal: ac.signal })).resolves.toEqual({ status: "aborted" });
    expect(FakePrefetch.instances).toHaveLength(1);
  });
});

// ------------------------------------------------- ResidentSession.start()

class FakeLeanWorker {
  constructor(_url: string) {}
  addEventListener() {}
  postMessage() {}
  terminate() {}
}
const runtime = { buildId: "wasm64-3ab1c6a9da03bc29", leanVersion: "4.34.0", files: { "lean.js": { bytes: 0, sha256: "", chunks: [] }, "lean.wasm": { bytes: 0, sha256: "", chunks: [] } } } as RuntimeManifest;
const snap = (name: string) => ({ name, url: `/snapshots/${name}.x.snapz`, bytes: 100, transfer: 50, digest: `sha256:${"cd".repeat(32)}`, imports: [], runtime: runtime.buildId });
const artifacts = (): Qed64Artifacts => ({ runtime, index: { schema: "qed64.profile-index/v1", profiles: [] } as unknown as Qed64Artifacts["index"], installed: new Map(), snapshots: { schema: "qed64.snapshot-index/v1", snapshots: [snap("init"), snap("mathlib")] } as unknown as Qed64Artifacts["snapshots"] });

describe("ResidentSession.start(): stages, files, beforeArm, causes", () => {
  let calls: Array<{ kind: "busy" | "progress"; label: string; info?: ProgressInfo }>;
  let ui: StatusSink;
  beforeEach(() => {
    vi.stubGlobal("Worker", FakeLeanWorker);
    opfs(null, false); // no OPFS: the prefetch is skipped, the worker streams
    calls = [];
    ui = { busy: (label, info) => calls.push({ kind: "busy", label, info }), progress: (label, info) => calls.push({ kind: "progress", label, info }), idle() {} };
  });
  afterEach(() => vi.unstubAllGlobals());

  function session(extra: Partial<ResidentHost> = {}, snapshots = ["init", "mathlib"]) {
    const s = new ResidentSession({ artifacts: artifacts(), ui, headerText: "import Mathlib\n", ...extra }, { snapshots });
    const order: string[] = [];
    vi.spyOn(s.lean, "boot").mockImplementation(async () => { order.push("boot"); s.lean.onProgress({ phase: "runtime", label: "Verifying lean.wasm", loaded: 1, total: 2, unit: "bytes" }); return {} as never; });
    const loadSnapshot = vi.spyOn(s.lean, "loadSnapshot").mockImplementation(async (_u, name) => {
      order.push(`snapshot:${name}`);
      s.lean.onProgress({ phase: "snapshot-init", label: "Mathlib.Order.Basic", loaded: 3, total: 9, unit: "modules" });
      return { success: true, elapsedMs: 1 };
    });
    const writeFiles = vi.spyOn(s.lean, "writeFiles").mockImplementation(async (files) => { order.push(`files:${files.length}`); return { written: files.length }; });
    return { s, order, loadSnapshot, writeFiles };
  }

  it("every busy/progress call carries a stage; snapshot and module progress name the snapshot", async () => {
    const { s } = session();
    await s.start();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.info?.stage, `${c.kind}("${c.label}")`).toBeDefined();
    expect(calls).toContainEqual(expect.objectContaining({ info: expect.objectContaining({ stage: "runtime", step: "verify", subject: "lean.wasm" }) }));
    expect(calls).toContainEqual(expect.objectContaining({ info: expect.objectContaining({ stage: "modules", subject: "mathlib", loaded: 3, total: 9 }) }));
    expect(calls).toContainEqual(expect.objectContaining({ kind: "busy", info: { stage: "snapshot", subject: "init", step: "load" } }));
  });

  it("files are written after the snapshots, then beforeArm runs last — on every boot of the host", async () => {
    const files = [{ path: "/game/level.json", text: "{}" }, { path: "/game/data.bin", bytes: new Uint8Array([1, 2]) }];
    const hooked: unknown[] = [];
    let log: string[] = [];
    const host = { files: async () => files, beforeArm: async (lean: unknown) => { hooked.push(lean); log.push("beforeArm"); } };
    const first = session(host);
    log = first.order;
    await first.s.start();
    expect(first.order).toEqual(["boot", "snapshot:init.snap", "snapshot:mathlib.snap", "files:2", "beforeArm"]);
    expect(first.writeFiles).toHaveBeenCalledWith(files);
    // A reboot is a new session from the same host: the files and the hook come again.
    const again = session(host);
    log = again.order;
    await again.s.start();
    expect(again.order).toEqual(["boot", "snapshot:init.snap", "snapshot:mathlib.snap", "files:2", "beforeArm"]);
    expect(hooked).toEqual([first.s.lean, again.s.lean]);
  });

  it("no files and no hook: nothing is written", async () => {
    const { s, writeFiles } = session();
    await s.start();
    expect(writeFiles).not.toHaveBeenCalled();
  });

  it("a snapshot that fails to load throws the same message with a classified cause", async () => {
    const { s, loadSnapshot } = session();
    loadSnapshot.mockImplementation(async () => { throw Object.assign(new Error("snapshot fetch: HTTP 503"), { code: "SNAPSHOT_FAILED" }); });
    const err = await s.start().then(() => null, (e: Error & { cause?: unknown }) => e);
    expect(err?.message).toBe("snapshot 'init' failed to load");
    expect(err?.cause).toEqual({ kind: "network", httpStatus: 503, stage: "snapshot", subject: "init", code: "SNAPSHOT_FAILED", message: "snapshot fetch: HTTP 503" });
    expect(calls).toContainEqual(expect.objectContaining({ kind: "progress", info: expect.objectContaining({ stage: "snapshot", subject: "init", error: expect.objectContaining({ kind: "network" }) }) }));
  });

  it("a region the loader refuses is corrupt; an unpaired one is unpaired", async () => {
    const a = session();
    a.loadSnapshot.mockImplementation(async () => ({ success: false, elapsedMs: 1 }));
    await expect(a.s.start()).rejects.toMatchObject({ message: "snapshot 'init' failed to load", cause: { kind: "corrupt", stage: "snapshot", subject: "init", code: "SNAPSHOT_LOAD_RESULT" } });
    const b = session();
    b.loadSnapshot.mockImplementation(async () => { throw Object.assign(new Error("snapshot 'init.snap' was baked for runtime wasm64-aaaaaaaaaaaaaaaa; this worker booted wasm64-3ab1c6a9da03bc29"), { code: "SNAPSHOT_UNPAIRED" }); });
    await expect(b.s.start()).rejects.toMatchObject({ cause: { kind: "unpaired", code: "SNAPSHOT_UNPAIRED" } });
  });

  it("a death while booting carries the boot stage; after start() none", async () => {
    const { s } = session();
    const got: unknown[] = [];
    s.onDied = (_c, reason, _m, cause) => { got.push([reason, cause]); };
    s.lean.onDied(null, "RUNTIME_FETCH_FAILED", "lean.wasm chunk 1: HTTP 404", { errorCode: "RUNTIME_FETCH_FAILED" });
    await s.start();
    s.lean.onDied(null, "abort", "boom");
    s.lean.onDied(null, "crash", "", { bare: true, beforeHello: false });
    expect(got).toEqual([
      ["RUNTIME_FETCH_FAILED", { kind: "missing", httpStatus: 404, stage: "runtime", code: "RUNTIME_FETCH_FAILED", message: "lean.wasm chunk 1: HTTP 404" }],
      ["abort", { kind: "other", code: "abort", message: "boom" }],
      ["crash", null],
    ]);
  });

  it("a runtime boot failure keeps its message and gains a runtime-stage cause", async () => {
    const { s } = session();
    vi.mocked(s.lean.boot).mockImplementation(async () => { throw Object.assign(new Error("Memory64 reservation of 6 GiB refused"), { code: "MEMORY_FAILED" }); });
    await expect(s.start()).rejects.toMatchObject({ message: "Memory64 reservation of 6 GiB refused", cause: { kind: "oom", stage: "runtime", code: "MEMORY_FAILED" } });
  });
});
