// The library half of the embedding contract (docs/EMBEDDING.md §7):
// structured progress (every busy/progress call carries a stage), failure
// causes (the classification table against the worker's real messages),
// session files + the pre-arm hook (every boot, in order, before arm), the raw
// prefetch as a function, and the offline URL list. Over a fake Worker, a
// spied LeanSession and an OPFS stub — no wasm.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deathCause, failureCauseOf, failureKindOf, stageOfWorkerPhase } from "../../lib/failure";
import { runtimeUrls } from "../../lib/urls";
import { PREFETCH_SILENCE_MS, prefetchRaw, type ProgressInfo, type Qed64Artifacts, type StatusSink } from "../../lib/qed64-boot";
import { LspRelay, type RestartOptions } from "../../lib/lsp-relay";
import { ResidentSession, type ResidentHost, type SessionFile } from "../../lib/resident-session";
import type { ReadyInfo, RuntimeManifest } from "../../lib/client";
import * as embed from "../../lib/index";

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
    ["WORKER_DEP_MISMATCH", "lsp-front-door.js is revision \"2\", lean.worker.js needs 1 (a deploy mixed versions; reload)", "stale"],
    [undefined, "Uncaught Error: lsp-frames.js is revision missing, lean.worker.js needs 1 (a deploy mixed versions; reload)", "stale"],
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
    // A sibling of another revision: the site was deployed under the page (stale), by its code, or by the words of
    // the same refusal's uncaught error event, which can arrive before the hello (never "probe the link").
    const mismatch = "lsp-frames.js is revision \"2\", lean.worker.js needs 1 (a deploy mixed versions; reload)";
    expect(deathCause("WORKER_DEP_MISMATCH", mismatch, { errorCode: "WORKER_DEP_MISMATCH" }, { stage: "files" }))
      .toEqual({ kind: "stale", stage: "files", code: "WORKER_DEP_MISMATCH", message: mismatch });
    expect(deathCause("crash", `Uncaught Error: ${mismatch}`, { beforeHello: true })).toMatchObject({ kind: "stale", code: "WORKER_DEP_MISMATCH" });
    expect(failureCauseOf(Object.assign(new Error(mismatch), { code: "WORKER_DEP_MISMATCH" }))).toEqual({ kind: "stale", code: "WORKER_DEP_MISMATCH", message: mismatch });
    // The same refusal's uncaught error event can reach LeanSession first: it rejects with WORKER_CRASHED, or a
    // page error carries the words alone. Its cause is still stale with WORKER_DEP_MISMATCH (§7.2: always that code).
    const crashed = `Worker crashed: Uncaught Error: ${mismatch}`;
    expect(failureCauseOf(Object.assign(new Error(crashed), { code: "WORKER_CRASHED" }))).toEqual({ kind: "stale", code: "WORKER_DEP_MISMATCH", message: crashed });
    expect(failureCauseOf(new Error(crashed))).toEqual({ kind: "stale", code: "WORKER_DEP_MISMATCH", message: crashed });
    expect(failureCauseOf(Object.assign(new Error("x"), { cause: { kind: "stale", code: "WORKER_CRASHED", message: "x" } }))).toMatchObject({ kind: "stale", code: "WORKER_DEP_MISMATCH" });
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
      workers: ["/workers/lean.worker.js", "/workers/lsp-frames.js", "/workers/lsp-front-door.js", "/workers/memory64-probe.js", "/workers/snapshot-prefetch.worker.js"],
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

  function session(extra: Partial<ResidentHost> = {}, opts: RestartOptions = { snapshots: ["init", "mathlib"] }) {
    return stubbed(new ResidentSession({ artifacts: artifacts(), ui, headerText: "import Mathlib\n", ...extra }, opts));
  }
  /** `s` with its worker calls spied: boot, the snapshot loads and writeFiles succeed, in `order`. */
  function stubbed<S extends ResidentSession>(s: S) {
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

  it("lsp(): a burst of full-text didChanges reaches the worker at most once per 300 ms, the newest last, requests behind it; editCoalesceMs 0 forwards each (HARDENING #59)", () => {
    vi.useFakeTimers();
    try {
      const ch = (v: number) => ({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: "file:///a.lean", version: v }, contentChanges: [{ text: `t${v}` }] } }) as never;
      const versions = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => (c[0] as { params?: { textDocument?: { version?: number } } }).params?.textDocument?.version ?? (c[0] as { method: string }).method);
      const { s } = session();
      const lsp = vi.spyOn(s.lean, "lsp").mockImplementation(() => {});
      for (let v = 2; v <= 10; v += 1) { s.lsp(ch(v)); vi.advanceTimersByTime(25); } // lean4game's trigger: 9 changes in ~230 ms
      expect(versions(lsp)).toEqual([2]);
      vi.advanceTimersByTime(300);
      expect(versions(lsp)).toEqual([2, 10]);
      const replies: unknown[] = [];
      s.onLsp = (m) => replies.push(m); // the relay's hook: a superseded request's answer takes the worker's path
      s.lsp(ch(11)); // v10's forward reopened the window: held
      s.lsp({ jsonrpc: "2.0", id: 9, method: "textDocument/semanticTokens/full", params: { textDocument: { uri: "file:///a.lean" } } } as never); // made against v11
      s.lsp(ch(12)); // replaces v11: the request is answered ContentModified now, never forwarded
      expect(replies).toEqual([{ jsonrpc: "2.0", id: 9, error: expect.objectContaining({ code: -32801 }) }]);
      s.lsp({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: {} } as never); // waits behind v12
      expect(versions(lsp)).toEqual([2, 10]);
      vi.advanceTimersByTime(300);
      expect(versions(lsp)).toEqual([2, 10, 12, "textDocument/hover"]);
      s.lsp(ch(13));
      s.dispose(); // a held change dies with the session (the relay replays its last text)
      vi.advanceTimersByTime(1000);
      expect(versions(lsp)).toEqual([2, 10, 12, "textDocument/hover"]);
      const { s: raw } = session({ editCoalesceMs: 0 });
      const rawLsp = vi.spyOn(raw.lean, "lsp").mockImplementation(() => {});
      for (let v = 2; v <= 5; v += 1) raw.lsp(ch(v));
      expect(versions(rawLsp)).toEqual([2, 3, 4, 5]);
    } finally { vi.useRealTimers(); }
  });

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

  // lean4game QD-API-1: the boot's wait for another tab writing the same raw region was PREFETCH_SILENCE_MS with
  // no way for a host to set it; ResidentHost.busyWaitMs is that bound (loadSnapshotByName → prefetchRaw "wait").
  it("busyWaitMs bounds each boot's wait for another tab writing the region, then the worker streams it; default PREFETCH_SILENCE_MS", async () => {
    vi.useFakeTimers();
    try {
      // OPFS without the region, and another tab holding its writer lock for good (Web Locks grant a task later).
      const dir = { getFileHandle: async () => { throw new Error("NotFoundError"); } };
      const locks = {
        request: (_name: string, opts: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (lock: null) => unknown) => opts.ifAvailable
          ? new Promise((resolve) => setTimeout(() => resolve(cb(null)), 0))
          : new Promise((_resolve, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true })),
      };
      vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) }, locks });
      const set = session({ busyWaitMs: 500 }, { snapshots: ["init"] });
      const started = set.s.start();
      await vi.advanceTimersByTimeAsync(499);
      expect(set.order).toEqual(["boot"]); // waiting for the other tab
      expect(calls).toContainEqual(expect.objectContaining({ kind: "progress", label: expect.stringMatching(/waiting for another tab/), info: expect.objectContaining({ stage: "snapshot", subject: "init" }) }));
      await vi.advanceTimersByTimeAsync(1);
      await started;
      expect(set.order).toEqual(["boot", "snapshot:init.snap"]); // gave up waiting: the worker streams it
      const unset = session({}, { snapshots: ["init"] });
      const defaulted = unset.s.start();
      await vi.advanceTimersByTimeAsync(PREFETCH_SILENCE_MS - 1);
      expect(unset.order).toEqual(["boot"]);
      await vi.advanceTimersByTimeAsync(1);
      await defaulted;
      expect(unset.order).toEqual(["boot", "snapshot:init.snap"]);
    } finally { vi.useRealTimers(); }
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

  it("a death while booting carries the boot stage — through the arm, the relay's last boot step; once armed none", async () => {
    const { s } = session();
    vi.spyOn(s.lean, "arm").mockResolvedValue(undefined);
    const got: unknown[] = [];
    s.onDied = (_c, reason, _m, cause) => { got.push([reason, cause]); };
    s.lean.onDied(null, "RUNTIME_FETCH_FAILED", "lean.wasm chunk 1: HTTP 404", { errorCode: "RUNTIME_FETCH_FAILED" });
    await s.start();
    // Between start() and the arm the relay is still booting (the lazy front door loads on its replay).
    s.lean.onDied(null, "WORKER_DEP_MISSING", "lean.worker.js needs lsp-front-door.js served beside it", { errorCode: "WORKER_DEP_MISSING" });
    await s.arm();
    s.lean.onDied(null, "abort", "boom");
    s.lean.onDied(null, "crash", "", { bare: true, beforeHello: false });
    expect(got).toEqual([
      ["RUNTIME_FETCH_FAILED", { kind: "missing", httpStatus: 404, stage: "runtime", code: "RUNTIME_FETCH_FAILED", message: "lean.wasm chunk 1: HTTP 404" }],
      ["WORKER_DEP_MISSING", { kind: "other", stage: "files", code: "WORKER_SCRIPT_LOAD_FAILED", message: "lean.worker.js needs lsp-front-door.js served beside it" }],
      ["abort", { kind: "other", code: "abort", message: "boom" }],
      ["crash", null],
    ]);
  });

  // Review g4 #18/#30: only lean.boot, the snapshots and writeFiles carried a cause, so a host's files() fetch
  // failing (lean4game's shape) reached Death and the page API as `cause: null` — "no evidence".
  it("every boot failure carries a cause: the host's files() and beforeArm, a pack download, an arm the worker refuses", async () => {
    const a = session({ files: async () => { throw new TypeError("Failed to fetch"); } });
    await expect(a.s.start()).rejects.toMatchObject({ message: "Failed to fetch", cause: { kind: "network", stage: "files", message: "Failed to fetch" } });
    const b = session({ beforeArm: async () => { throw new Error("level.json: HTTP 404"); } });
    await expect(b.s.start()).rejects.toMatchObject({ message: "level.json: HTTP 404", cause: { kind: "missing", httpStatus: 404, stage: "files" } });
    // "Load exact imports": the essential pack is installed before the boot, and its manifest is gone.
    vi.stubGlobal("fetch", async () => new Response("Not Found", { status: 404 }));
    const withPack = artifacts();
    withPack.index.profiles.push({ id: "essential", manifest: "/profiles/essential.json", release: "r", modules: 1 });
    const c = session({ artifacts: withPack }, { snapshots: ["init"], packs: ["essential"] });
    await expect(c.s.start()).rejects.toMatchObject({ message: "Manifest /profiles/essential.json: HTTP 404", cause: { kind: "missing", httpStatus: 404, stage: "profile", subject: "essential" } });
    expect(c.order).toEqual([]); // nothing booted
    // The relay's last boot step: an arm the worker refuses.
    const d = session();
    await d.s.start();
    vi.spyOn(d.s.lean, "arm").mockRejectedValue(Object.assign(new Error("Worker is 'dead', not ready; arm after boot and the pre-open snapshot loads."), { code: "BAD_STATE" }));
    await expect(d.s.arm()).rejects.toMatchObject({ cause: { kind: "other", stage: "files", code: "BAD_STATE" } });
  });

  it("a worker that refuses a sibling of another revision dies stale through ResidentSession into the relay's Death, which reboots", async () => {
    const sessions: ResidentSession[] = [];
    const relay = new LspRelay(() => { const s = session().s; vi.spyOn(s.lean, "arm").mockResolvedValue(undefined); sessions.push(s); return s; }, { status() {} }, () => Promise.resolve());
    await vi.waitFor(() => expect(relay.state.kind).toBe("serving"));
    const message = "lsp-front-door.js is revision \"2\", lean.worker.js needs 1 (a deploy mixed versions; reload)";
    sessions[0]!.lean.onDied(null, "WORKER_DEP_MISMATCH", message, { errorCode: "WORKER_DEP_MISMATCH" });
    expect(relay.lastDeath).toMatchObject({ reason: "WORKER_DEP_MISMATCH", cause: { kind: "stale", code: embed.WORKER_DEP_MISMATCH, message } });
    expect(relay.status()).toMatchObject({ relay: "rebooting", rebootReason: "crash" }); // the relay heals: a replacement loads the new scripts
    expect(sessions).toHaveLength(2);
    relay.clientPort.close();
  });

  it("...and that cause is the relay's Death.cause, which the page API reports", async () => {
    const relay = new LspRelay(() => session({ files: async () => { throw new TypeError("Failed to fetch"); } }).s, { status() {} }, () => new Promise<void>(() => {}));
    await vi.waitFor(() => expect(relay.lastDeath).not.toBeNull());
    expect(relay.lastDeath).toMatchObject({ reason: "bootFailed", message: "Failed to fetch", seq: 1, cause: { kind: "network", stage: "files" } });
    relay.clientPort.close();
  });

  // Review g4 #19: a TS `private files` collided with lean4game's subclass (TS2415 under `tsc`), and at runtime its
  // own `files` replaced the base's, so the base wrote the game data and the subclass wrote it again.
  it("a subclass's own members never collide with the base's (lean4game's GameSession declares `files`)", async () => {
    class GameSession extends ResidentSession {
      constructor(host: ResidentHost, private readonly files: SessionFile[], opts?: RestartOptions) { super(host, opts); }
      override async start(): Promise<void> { await super.start(); await this.lean.writeFiles(this.files); }
    }
    const level = [{ path: "/game/level.json", text: "{}" }];
    const g = stubbed(new GameSession({ artifacts: artifacts(), ui, headerText: "import Mathlib\n" }, level, { snapshots: ["init"] }));
    await g.s.start();
    expect(g.order).toEqual(["boot", "snapshot:init.snap", "files:1"]);
    expect(g.writeFiles).toHaveBeenCalledTimes(1);
  });

  // Review g4 #23: the worker commits min(request, rung) on the rung it reserves; status().memory read the request.
  it("initialBytes is the commit the worker made once booted (its per-rung clamp can make less than the request)", async () => {
    const GiB = 1024 ** 3;
    const { s } = session({}, { snapshots: ["init"], initialBytes: 6 * GiB });
    expect(s.initialBytes).toBe(6 * GiB); // the 8 GiB-device ladder under the 6 GiB cap starts at 6
    vi.mocked(s.lean.boot).mockResolvedValue({ memory: { currentBytes: 4 * GiB, initialBytes: 4 * GiB, maximumBytes: 4 * GiB, shared: true } } as ReadyInfo);
    await s.start();
    expect(s.initialBytes).toBe(4 * GiB);
    // A worker that reports no memory leaves the request standing.
    const old = session({}, { snapshots: ["init"], initialBytes: 2 * GiB });
    await old.s.start();
    expect(old.s.initialBytes).toBe(2 * GiB);
  });

  it("a runtime boot failure keeps its message and gains a runtime-stage cause", async () => {
    const { s } = session();
    vi.mocked(s.lean.boot).mockImplementation(async () => { throw Object.assign(new Error("Memory64 reservation of 6 GiB refused"), { code: "MEMORY_FAILED" }); });
    await expect(s.start()).rejects.toMatchObject({ message: "Memory64 reservation of 6 GiB refused", cause: { kind: "oom", stage: "runtime", code: "MEMORY_FAILED" } });
  });
});

// lean4game cannot use a relay without these two, and v1 did not name them (docs/EMBEDDING.md §7.9).
describe("LspRelay's contract members through qed64/embed: clientPort and unload()", () => {
  it("clientPort is the client's MessagePort for the relay's life; unload() disposes and kills the session in the caller's turn", async () => {
    const log: string[] = [];
    const sessions: embed.RelaySession[] = [];
    const make = (): embed.RelaySession => {
      const s: embed.RelaySession = {
        id: `s${sessions.length + 1}`,
        start: () => new Promise<void>(() => {}), // booting: frames are queued at the worker
        arm: async () => {},
        lsp: (m) => { log.push(`lsp ${s.id} ${m.method}`); if (m.method === "initialize") s.onLsp({ jsonrpc: "2.0", id: m.id, result: { capabilities: {} } }); },
        onLsp: () => {}, onStatus: () => {}, onDied: () => {},
        dispose: () => log.push(`dispose ${s.id}`),
        terminate: () => log.push(`terminate ${s.id}`),
      };
      sessions.push(s);
      return s;
    };
    const relay = new embed.LspRelay(make, { status() {} }, () => Promise.resolve());
    const port: MessagePort = relay.clientPort;
    const unload: () => void = relay.unload;
    expect(port).toBeInstanceOf(MessagePort);
    expect(typeof unload).toBe("function");
    const replies: unknown[] = [];
    port.onmessage = (e) => replies.push(e.data);
    port.postMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    await vi.waitFor(() => expect(replies).toEqual([{ jsonrpc: "2.0", id: 0, result: { capabilities: {} } }]));
    expect(log).toEqual(["lsp s1 initialize"]);
    relay.unload();
    expect(log).toEqual(["lsp s1 initialize", "dispose s1", "terminate s1"]); // nothing awaited
    expect(relay.clientPort).toBe(port);
    port.close();
  });
});

