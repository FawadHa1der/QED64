// Typed RPC client for the QED64 Lean worker.
//
// One LeanSession owns one Worker running the persistent wasm64 runtime.
// Requests are correlated by id; progress/log events stream to subscribers.
// A session that dies (capability failure, runtime abort) reports `dead` and
// the app creates a fresh session — Worker teardown is the only reliable way
// to reclaim the resident Lean environment.

export const PROTOCOL = 1;

export interface Diagnostic {
  fileName: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "information";
  message: string;
}

export interface CompileResult {
  operation: "compile";
  success: boolean;
  exitCode: number;
  elapsedMs: number;
  diagnostics: Diagnostic[];
  raw: { stream: string; text: string }[];
  memory?: MemoryTelemetry;
}

export interface MemoryTelemetry {
  currentBytes: number;
  maximumBytes?: number;
  shared: boolean;
}

export interface Capabilities {
  memory64: boolean;
  sharedArrayBuffer: boolean;
  atomics: boolean;
  crossOriginIsolated: boolean;
  ok: boolean;
}

export interface ReadyInfo {
  buildId: string;
  leanVersion: string;
  sourceRevision?: string;
  capabilities: Capabilities;
  memory?: MemoryTelemetry;
  mode: "persistent";
}

export interface ProgressEvent {
  phase: string;
  label: string;
  loaded?: number;
  total?: number;
  unit?: string;
}

export interface RuntimeManifest {
  buildId: string;
  leanVersion: string;
  sourceRevision?: string;
  files: Record<
    "lean.js" | "lean.wasm",
    { bytes: number; sha256: string; chunks: { url: string; bytes: number; sha256: string }[] }
  >;
}

export interface LibraryPack {
  id: string;
  /** Blob-backed pack (OPFS File): mounted read-only via WORKERFS. */
  blob?: Blob;
  /** Byte-backed pack: transferred and written into MEMFS by the worker. */
  bytes?: Uint8Array;
  metadata: { files: { filename: string; start: number; end: number }[] };
  mountPoint: string;
}

export interface BootConfig {
  runtime: RuntimeManifest;
  memory: { initialBytes: number; maximumCandidates: number[]; maximumBytes?: number };
  leanPath: string;
  packs: LibraryPack[];
}

export interface WorkerError {
  code: string;
  message: string;
  stack?: string;
  recoverable: boolean;
}

export type SessionState = "starting" | "booting" | "ready" | "compiling" | "dead";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error & { code?: string }) => void;
}

export class LeanSession {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private seq = 0;
  /** Runtime-owning RPCs (compile, loadSnapshot) execute strictly one at a
   * time. The worker rejects any such request that arrives while another
   * owns the runtime (BAD_STATE) — and snapshot loads are async on the
   * worker, so a compile posted mid-load DOES arrive early enough to bounce:
   * observed live as a user-facing "Compile failed: Worker is 'compiling',
   * not ready." when a check raced the boot snapshot load right after boot.
   * Serializing here makes that guard unreachable from a single session
   * regardless of caller timing. */
  private turn: Promise<unknown> = Promise.resolve();
  state: SessionState = "starting";
  onProgress: (event: ProgressEvent) => void = () => {};
  onLog: (stream: string, text: string) => void = () => {};
  onStateChange: (state: SessionState) => void = () => {};

  constructor(workerUrl = "/workers/lean.worker.js") {
    this.worker = new Worker(workerUrl);
    this.worker.addEventListener("message", (e) => this.dispatch(e.data));
    this.worker.addEventListener("error", (e) => {
      this.transition("dead");
      const error = Object.assign(new Error(`Worker crashed: ${e.message}`), { code: "WORKER_CRASHED" });
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    });
  }

  private transition(next: SessionState) {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange(next);
  }

  private dispatch(msg: any) {
    if (!msg || msg.protocol !== PROTOCOL) return;
    switch (msg.type) {
      case "boot":
        return; // worker script loaded
      case "event":
        if (msg.kind === "progress") this.onProgress(msg as ProgressEvent & { kind: string });
        else if (msg.kind === "log") this.onLog(msg.stream, msg.text);
        return;
      case "ready": {
        this.transition("ready");
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          p.resolve(msg.ready);
        }
        return;
      }
      case "result": {
        if (this.state === "compiling") this.transition("ready");
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          p.resolve(msg.result);
        }
        return;
      }
      case "error": {
        const error: WorkerError = msg.error;
        const p = msg.requestId ? this.pending.get(msg.requestId) : undefined;
        if (p && msg.requestId) {
          this.pending.delete(msg.requestId);
          p.reject(Object.assign(new Error(error.message), { code: error.code }));
        }
        if (!error.recoverable) {
          // The runtime is gone: every other in-flight request dies with it.
          this.transition("dead");
          this.rejectAll(Object.assign(new Error(`Worker unrecoverable: ${error.message}`), { code: error.code }));
        } else if (this.state === "compiling") {
          this.transition("ready");
        }
        return;
      }
    }
  }

  /** Take the next runtime turn: wait for every earlier compile/loadSnapshot
   * to settle (success or failure alike), then run `op` — unless the session
   * died while queued, in which case reject instead of posting to a
   * terminated worker and hanging forever. */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> =>
      this.state === "dead"
        ? Promise.reject(Object.assign(new Error("Session is dead; request not sent."), { code: "DEAD" }))
        : op();
    const turn = this.turn.then(run, run);
    this.turn = turn.catch(() => {});
    return turn;
  }

  private request<T>(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    const requestId = `r${(this.seq += 1)}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ protocol: PROTOCOL, requestId, type, ...payload }, transfer);
    });
  }

  capabilities(): Promise<Capabilities> {
    return this.request("capabilities");
  }

  async boot(config: BootConfig): Promise<ReadyInfo> {
    this.transition("booting");
    // Transfer byte-backed pack buffers instead of structured-cloning ~GBs.
    // Transfer DETACHES the page-side buffers: reject already-detached ones
    // up front (a re-boot must reinstall memory-backed profiles), and report
    // which packs this boot consumed via config so callers can mark them.
    const transfer: Transferable[] = [];
    for (const pack of config.packs) {
      if (!pack.bytes) continue;
      if (pack.bytes.buffer.byteLength === 0 && pack.bytes.byteLength === 0) {
        throw Object.assign(
          new Error(`Pack ${pack.id} was already transferred to a previous worker; reinstall it.`),
          { code: "PACK_CONSUMED" },
        );
      }
      if (pack.bytes.byteOffset === 0 && pack.bytes.byteLength === pack.bytes.buffer.byteLength) {
        transfer.push(pack.bytes.buffer);
      }
    }
    const ready = await this.request<ReadyInfo>("boot", { config }, transfer);
    this.transition("ready");
    return ready;
  }

  compile(source: string, fileName?: string): Promise<CompileResult> {
    return this.exclusive(async () => {
      this.transition("compiling");
      try {
        return await this.request<CompileResult>("compile", { input: { source, fileName } });
      } finally {
        if (this.state === "compiling") this.transition("ready");
      }
    });
  }

  loadSnapshot(
    url: string,
    name?: string,
    expectedBytes?: number,
    cacheKey?: string,
  ): Promise<{ success: boolean; elapsedMs: number }> {
    return this.exclusive(() => this.request("loadSnapshot", { input: { url, name, expectedBytes, cacheKey } }));
  }

  telemetry(): Promise<{ state: string; memory?: MemoryTelemetry }> {
    return this.request("telemetry");
  }

  private rejectAll(error: Error & { code?: string }) {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  dispose() {
    this.transition("dead");
    this.rejectAll(Object.assign(new Error("Session disposed."), { code: "DISPOSED" }));
    void this.request("dispose").catch(() => {});
    // Give the worker a beat to acknowledge, then hard-terminate.
    setTimeout(() => this.worker.terminate(), 250);
  }
}

/** Fast local probe (mirrors the worker's, callable before any Worker spawn). */
export function probeMemory64(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00]),
    );
  } catch {
    return false;
  }
}

/** Memory-maximum candidates, largest first, tuned by device memory.
 * The maximum is ADDRESS-SPACE RESERVATION, not commit: browser64's
 * certified Chrome/Firefox runs reserve the full 16 GiB the linked module
 * declares, and capping lower turns heavy sessions (whole-environment
 * work, library search) into unrecoverable "Cannot enlarge memory" aborts.
 * The boot loop already walks down the ladder when a reservation is
 * refused, so leading with 16 costs nothing on machines that refuse it. */
export function memoryCandidates(): number[] {
  const GiB = 1024 ** 3;
  const device = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const ladder = device >= 8 ? [16, 12, 8, 6, 4, 3] : device >= 4 ? [8, 6, 4, 3, 2] : [4, 3, 2];
  return ladder.map((g) => g * GiB);
}
