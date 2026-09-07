// Typed RPC client for the QED64 Lean worker.
//
// One LeanSession owns one Worker running the persistent wasm64 runtime.
// Requests are correlated by id; progress/log events stream to subscribers.
// A session that dies (capability failure, runtime abort, heartbeat loss)
// reports it exactly once through `onDied` and the relay creates a fresh
// session — Worker teardown is the only reliable way to reclaim the resident
// Lean environment.

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

/** One JSON-RPC message on the resident LSP channel (either direction). */
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** `$/qed64/headerStatus` (patch 0032 K2): the kernel's verdict for one
 * header setup — data, not a client-side re-resolution. */
export interface HeaderStatus {
  version: number;
  mode: "exact" | "covered" | "refused";
  key: string[];
  moduleCount: number;
  missing: string[];
  ms: number;
}

export type WorkerPhase = "booting" | "starting" | "elaborating" | "ready" | "headerRefused" | "dead";

/** The worker's status snapshot (architecture re-evaluation 2 §2.2(e)),
 * emitted as a `status` event on every change and read back by the page's
 * `qed64.status()` tap. */
export interface WorkerStatus {
  phase: WorkerPhase;
  /** Client-space version of the last document text the worker received. */
  version: number | null;
  header: HeaderStatus | null;
  ring: { bytesQueued: number; refused: number };
  pool: { unused: number; running: number };
  dropped: number;
  /** The front door's collision fact (`statusOf().collision`; §3 row 8,
   * HARDENING #43): names the worker's last publish reported "already
   * declared" under a COVERED header, null after a clean burst. Optional
   * only for the relay's pre-status placeholder (before the first `status`
   * event); every event the session delivers carries it (null when none). */
  collision?: { names: string[]; version: number | null } | null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error & { code?: string }) => void;
}

// Heartbeat loss (§2.2 L2; §6 first pass 6): the worker beats every 2 s once
// its loop is open; three missed beats then a telemetry probe unanswered for
// 2 s is the ONLY page-side timer with lifecycle meaning. A frozen page
// timer (HARDENING #10) fires late, never falsely.
const HEARTBEAT_LOSS_MS = 6000;
const HEARTBEAT_PROBE_MS = 2000;

let sessionSeq = 0;

export class LeanSession {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private seq = 0;
  /** Session identity: the relay filters every event by it (§2.3 — a death
   * carrying a stale session changes nothing), and the harness reads it. */
  readonly id = `s${(sessionSeq += 1)}`;
  private readonly onWorkerMessage: (e: MessageEvent) => void;
  private readonly onWorkerError: (e: ErrorEvent) => void;
  private detached = false;
  private diedReported = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  /** Runtime-owning RPCs (compile, loadSnapshot) execute strictly one at a
   * time. The worker rejects any such request that arrives while another
   * owns the runtime (BAD_STATE) — and snapshot loads are async on the
   * worker, so a compile posted mid-load DOES arrive early enough to bounce:
   * observed live as a user-facing "Compile failed: Worker is 'compiling',
   * not ready." when a check raced the boot snapshot load right after boot.
   * Serializing here makes that guard unreachable from a single session
   * regardless of caller timing. */
  private turn: Promise<unknown> = Promise.resolve();
  /** The runtime is gone (worker crash, unrecoverable error reply, dispose):
   * `exclusive()` rejects queued turns instead of posting to a terminated
   * worker and hanging forever. The typed death fact itself is `onDied`. */
  private dead = false;
  onProgress: (event: ProgressEvent) => void = () => {};
  onLog: (stream: string, text: string) => void = () => {};
  /** A server frame from the resident front door (rebased to client versions). */
  onLsp: (msg: JsonRpcMessage) => void = () => {};
  onStatus: (status: WorkerStatus) => void = () => {};
  /** The one death fact per session (K-v), fired at most once: worker
   * `error`, an unrecoverable error reply, the worker's `died` event, or
   * heartbeat loss. Never fired by `dispose()`. */
  onDied: (code: number | null, reason: string, message: string) => void = () => {};

  constructor(workerUrl = "/workers/lean.worker.js") {
    this.worker = new Worker(workerUrl);
    // Both listeners are gated on `detached` rather than removed: a disposed
    // session must observe nothing more from its worker (see dispose()).
    this.onWorkerMessage = (e) => { if (!this.detached) this.dispatch(e.data); };
    this.onWorkerError = (e) => {
      if (this.detached) return;
      this.dead = true;
      const error = Object.assign(new Error(`Worker crashed: ${e.message}`), { code: "WORKER_CRASHED" });
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      this.died(null, "crash", e.message);
    };
    this.worker.addEventListener("message", this.onWorkerMessage);
    this.worker.addEventListener("error", this.onWorkerError);
  }

  private died(code: number | null, reason: string, message: string) {
    if (this.diedReported || this.detached) return;
    this.diedReported = true;
    // Every death path (worker `died` event and heartbeat loss included, not
    // only a crash or an unrecoverable reply) closes the runtime to queued
    // turns: nothing posts to a worker that no longer answers.
    this.dead = true;
    clearTimeout(this.heartbeatTimer);
    this.onDied(code, reason, message);
  }

  /** Each beat re-arms the loss window; on loss, one probe decides. */
  private armHeartbeat() {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (this.detached || this.diedReported) return;
      let answered = false;
      this.telemetry().then(() => { answered = true; }, () => {});
      this.heartbeatTimer = setTimeout(() => {
        if (answered) this.armHeartbeat();
        else this.died(null, "heartbeat", `no heartbeat for ${HEARTBEAT_LOSS_MS} ms and the telemetry probe went unanswered`);
      }, HEARTBEAT_PROBE_MS);
    }, HEARTBEAT_LOSS_MS);
  }

  /** Fire-and-forget LSP message to the resident front door (§2.2 L2): no
   * promise, no ack — a booting worker queues it, a dead one drops it. */
  lsp(msg: JsonRpcMessage, replay = false): void {
    if (this.detached || this.diedReported) return;
    this.worker.postMessage({ protocol: PROTOCOL, type: "lsp", msg, ...(replay ? { replay: true } : {}) });
  }

  private dispatch(msg: any) {
    if (!msg || msg.protocol !== PROTOCOL) return;
    switch (msg.type) {
      case "boot":
        return; // worker script loaded
      case "event":
        if (msg.kind === "progress") this.onProgress(msg as ProgressEvent & { kind: string });
        else if (msg.kind === "log") this.onLog(msg.stream, msg.text);
        else if (msg.kind === "lsp") this.onLsp(msg.msg as JsonRpcMessage);
        // The declared fields only — the event envelope (type/kind/requestId)
        // must not leak into a datum the harness JSON-diffs (§2.2(e)).
        // `collision` rides along because the page's "Load exact imports"
        // offer keys on it (§3 row 8) — rebuilding from declared fields
        // silently dropped it once; keep the list and WorkerStatus in step.
        else if (msg.kind === "status") this.onStatus({ phase: msg.phase, version: msg.version ?? null, header: msg.header ?? null, ring: msg.ring, pool: msg.pool, dropped: msg.dropped ?? 0, collision: msg.collision ?? null });
        else if (msg.kind === "heartbeat") this.armHeartbeat();
        // The worker's one death fact (W2): code, reason and the message the
        // relay carries into its status (`lastDeath`) for the page to render.
        else if (msg.kind === "died") this.died(msg.code ?? null, String(msg.reason ?? "died"), String(msg.message ?? ""));
        return;
      case "ready": {
        const p = this.pending.get(msg.requestId);
        if (p) {
          this.pending.delete(msg.requestId);
          p.resolve(msg.ready);
        }
        return;
      }
      case "result": {
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
          this.dead = true;
          this.rejectAll(Object.assign(new Error(`Worker unrecoverable: ${error.message}`), { code: error.code }));
          this.died(null, error.code, error.message);
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
      this.dead
        ? Promise.reject(Object.assign(new Error("Session is dead; request not sent."), { code: "DEAD" }))
        : op();
    const turn = this.turn.then(run, run);
    this.turn = turn.catch(() => {});
    return turn;
  }

  /** One correlated worker request. Public for the raw taps the page and the
   * harness use (`relay.session.lean.request("telemetry")`); the typed
   * methods below are the product surface. */
  request<T>(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    const requestId = `r${(this.seq += 1)}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ protocol: PROTOCOL, requestId, type, ...payload }, transfer);
    });
  }

  async boot(config: BootConfig): Promise<ReadyInfo> {
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
    return this.request<ReadyInfo>("boot", { config }, transfer);
  }

  compile(source: string, fileName?: string): Promise<CompileResult> {
    return this.exclusive(() => this.request<CompileResult>("compile", { input: { source, fileName } }));
  }

  loadSnapshot(
    url: string,
    name?: string,
    expectedBytes?: number,
    cacheKey?: string,
    runtime?: string
  ): Promise<{ success: boolean; elapsedMs: number }> {
    return this.exclusive(() => this.request("loadSnapshot", { input: { url, name, expectedBytes, cacheKey, runtime} }));
  }

  telemetry(): Promise<{ state: string; memory?: MemoryTelemetry }> {
    return this.request("telemetry");
  }

  /** The front door's Booting → Ready fact (§2.4), sent by the page as the
   * LAST step of a session start — after boot and every pre-open snapshot
   * load (§2.3 BootOk: replay, then arm). Takes a runtime turn so it can
   * never overtake a queued loadSnapshot; the worker refuses it BAD_STATE
   * while anything owns the runtime. */
  arm(): Promise<void> {
    return this.exclusive(() => this.request<{ operation: string }>("lsp-arm")).then(() => undefined);
  }

  private rejectAll(error: Error & { code?: string }) {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  /** Deliberate teardown. Listeners detach FIRST (§2.2 L2): nothing the
   * dying worker still posts, and nothing this method does, reaches
   * `onLsp`/`onStatus`/`onDied` — a disposed session is never a death, so a
   * relay reboot cannot re-enter death handling (bug class C4). */
  dispose() {
    this.detached = true;
    clearTimeout(this.heartbeatTimer);
    this.onLsp = () => {};
    this.onStatus = () => {};
    this.onDied = () => {};
    this.dead = true;
    this.rejectAll(Object.assign(new Error("Session disposed."), { code: "DISPOSED" }));
    // The ack can no longer be observed (listeners are gone); the worker
    // still closes itself on `dispose`, and the terminate below is the floor.
    this.worker.postMessage({ protocol: PROTOCOL, requestId: `r${(this.seq += 1)}`, type: "dispose" });
    // Give the worker a beat to acknowledge, then hard-terminate.
    setTimeout(() => this.worker.terminate(), 250);
  }

  /** Kill the worker NOW. `dispose()` above defers its `Worker.terminate()`
   * 250 ms behind a timer a closing document never runs, so a reload storm
   * stacked dead multi-GiB heaps until the OS jetsammed the renderer — the
   * pump shim's `disposeHard` terminated inline for exactly that reason, and
   * the relay's `unload()` (pagehide) calls this through the adapter's
   * `terminate()`. Disposes first when the caller has not (listeners detach,
   * pending RPCs reject DISPOSED, never a death); the terminate is immediate
   * and idempotent, so the polite dispose's own timer firing later is inert. */
  terminate(): void {
    if (!this.detached) this.dispose();
    this.worker.terminate();
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
