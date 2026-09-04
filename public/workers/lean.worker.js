/* QED64 Lean worker — runs the real wasm64 Lean 4 compiler in this Worker.
 *
 * Two execution modes over one Emscripten runtime:
 *
 *  - persistent: boot once (runtime init + WORKERFS pack mounts), then serve
 *    repeated `compile` requests through the fork's `lean_wasm_compile`
 *    export. The first compile for an import set pays the import; later
 *    compiles reuse the resident environment and take milliseconds.
 *
 *  - oneshot: a full CLI run (argv → main → exit) for batch checking. The
 *    runtime tears itself down afterwards (EXIT_RUNTIME=1), so the host must
 *    discard this Worker after a oneshot completes.
 *
 * Pointer discipline (wasm64): every i64-typed wasm export parameter MUST be
 * a BigInt, and i64 returns come back as BigInt. JS-side helpers normalize at
 * the boundary; addresses are < 2^53 (16 GiB cap), so Number is safe for
 * arithmetic once converted. Verified-materialization and WORKERFS patterns
 * follow the Browser64 evidence (wasm64-lean-codex, Apache-2.0).
 */

"use strict";

const PROTOCOL = 1;
const PAGE = 65536;

const MEMORY64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x04, 0x00, // memory section: flags 0x04 (memory64), min 0
]);

let state = "idle"; // idle → booting → ready → compiling | exhausted | dead
let M = null; // the live Emscripten module (window.Module is the glue's)
// Emscripten reads print/printErr ONCE at startup; route through this sink so
// each compile can claim the output stream.
let sink = null;

// ---------------------------------------------------------------------------
// LSP mode (the pump path's `lsp-init`, patch 0018, and the resident path's
// `lsp-resident-init`, patch 0031)
//
// In both modes the Lean FileWorker writes Content-Length-framed JSON-RPC to
// stdout. Frames are read BYTE BY BYTE (spec W1): `installStdoutTap` swaps
// the stdout TTY's ops so every byte reaches the shared decoder in
// lsp-frames.js the moment it is written. The glue's default `put_char`
// buffers until byte 10 and a frame body has no trailing newline, so under
// the old print() path the last frame of every burst sat in the TTY buffer
// until the NEXT write — the "stuck last frame" that the shim's tickler and
// the resident probe's tickler existed to flush (bug 1, HARDENING #27).
// Frames are byte-exact now: no newline heuristics, no CR/LF skipping, no
// orphan resync. Non-frame stdout bytes (library progress lines until the
// kernel's trace import lands, spec K3) surface as `log` events and are
// counted for the gate's `nonFrameStdoutBytes === 0` assertion.
// ---------------------------------------------------------------------------
// The decoder is shared with Node's resident-probe (one parser, not two that
// drift — architecture review A1). Absent only under the vitest vm harness,
// which loads lsp-frames.js into the sandbox itself.
//
// lsp-front-door.js is deliberately NOT loaded here: it is imported lazily by
// `frontDoorApply` on the first `lsp`/`lsp-arm` message. The pump path never
// sends either, and lean4game vendors this worker as a fixed closure
// (sync-qed64.sh PATHS + stage-game-assets.sh copy lean.worker.js,
// snapshot-prefetch.worker.js and lsp-frames.js by name) — an unconditional
// import of a file that closure lacks would throw at script load, never post
// {type:"boot"}, and hang every game session (review fix 3).
if (typeof importScripts === "function") {
  try {
    importScripts("lsp-frames.js");
  } catch (error) {
    fail(undefined, new Error(`lean.worker.js needs lsp-frames.js served beside it: ${error && error.message ? error.message : error}`), "WORKER_DEP_MISSING", false);
    throw error;
  }
}
let lspMode = false;
let lspFrames = null; // Qed64LspFrames.LspFrameDecoder, created by installStdoutTap

/** Route stdout bytes: frames to the decoder in LSP mode, otherwise the
 * glue's line-buffered path (batch compile diagnostics, boot output, and the
 * `[WASM INIT]` progress the snapshot loader parses all consume LINES —
 * HARDENING #5). Installed after FS.init has opened the standard streams:
 * `/dev/stdout` is a symlink to `/dev/tty` (device 5,0) whose ops object is
 * shared by every open stream, and `TTY.stream_ops.write` calls
 * `ops.put_char` once per byte — including writes proxied from pthreads. The
 * glue does NOT honour `Module.stdout` (verified: zero occurrences in the
 * served lean.js), so this internal is the only per-byte hook; a missing
 * TTY fails the boot loudly rather than silently reverting to line framing. */
function installStdoutTap() {
  const ttys = typeof TTY !== "undefined" && TTY.ttys ? TTY.ttys : (M.TTY && M.TTY.ttys);
  const dev = M.FS && typeof M.FS.makedev === "function" ? M.FS.makedev(5, 0) : (5 << 8) | 0;
  const tty = ttys && ttys[dev];
  if (!tty || !tty.ops || typeof tty.ops.put_char !== "function") {
    throw new Error("stdout tap: the glue's TTY for /dev/stdout is not in scope (per-byte LSP framing impossible)");
  }
  lspFrames = new Qed64LspFrames.LspFrameDecoder({
    onFrame: (body) => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        event(null, "log", { stream: "stderr", text: `lsp: unparseable ${body.length}-char frame` });
        return;
      }
      // Front-door sessions see every server frame through the machine
      // (inbound version rebasing, status from fileProgress/headerStatus —
      // §2.2(e)); the pump / lsp-resident-init transports get it raw.
      if (frontDoor) frontDoorApply({ kind: "server", msg });
      else event(null, "lsp", { msg });
    },
    onJunk: (line) => event(null, "log", { stream: "stdout", text: line }),
  });
  const orig = tty.ops;
  tty.ops = {
    ...orig,
    put_char(t, val) {
      if (!lspMode) {
        orig.put_char(t, val);
        return;
      }
      // A line begun before LSP mode started still belongs to the line path.
      if (t.output && t.output.length > 0) orig.fsync(t);
      // `null` is the glue's flush signal, never data; every other value is
      // one stream byte — NUL included, unlike the glue's default sink, so
      // Content-Length accounting stays byte-exact (Json.compress escapes
      // control characters today; the invariant is kept explicit anyway).
      if (val !== null) lspFrames.push(val);
    },
  };
}

// ---------------------------------------------------------------------------
// Resident FileWorker transport (patch 0031, docs/RESIDENT-WORKER-PLAN.md):
// the REAL `lean --worker` loop runs on the application pthread and reads
// stdin from a futex ring in shared memory; stdout keeps the normal proxied
// path, so the per-byte tap above serves both transports unchanged. The pump
// exports (lspInit/lspSend) coexist — one binary, both modes.
// ---------------------------------------------------------------------------
// 4 MiB (spec W4): at least 4× the largest full-text frame the shim may send
// once the wire is full-text (change=1); a frame over half the ring is
// refused with a structured error instead of parking the pump forever.
const RESIDENT_RING_CAP = 4 << 20;
const RESIDENT_IDX = { READ: 0, WRITE: 1, CLOSED: 2, WAKE: 3 };
let residentRingPtr = 0; // control words at ptr, byte ring at ptr + 16
let residentMode = false;
const residentEncoder = new TextEncoder();

function residentViews() {
  const buf = bootMemory.buffer; // re-take every call: shared-memory growth swaps it
  return {
    ctrl: new Int32Array(buf, residentRingPtr, 4),
    bytes: new Uint8Array(buf, residentRingPtr + 16, RESIDENT_RING_CAP),
  };
}

/** Non-blocking ring write. This outer worker IS the Emscripten main thread
 * (it services proxied stdout/FS from Lean's pthreads), so it must never
 * Atomics.wait; a full ring is polled instead. Frames are small. */
// FIFO: frames are written whole and in order. A frame that meets a full ring
// parks the pump (setTimeout) and NOTHING else may write meanwhile — without
// the queue, the next send's bytes landed between two halves of the parked
// frame and the worker's LSP stream was corrupted (architecture review C11).
const residentQueue = [];
let residentPumping = false;
/** A frame larger than half the ring could never be written without the
 * consumer draining mid-frame, and a parked pump blocks every later send:
 * refuse it (with `.bytes`) before it is queued — and, for the opening
 * sequence, before the runtime is touched (see residentInit). */
function residentCheckFrame(payload) {
  if (payload.length > RESIDENT_RING_CAP / 2) {
    throw Object.assign(
      new Error(`frame of ${payload.length} bytes exceeds half the ${RESIDENT_RING_CAP}-byte stdin ring`),
      { bytes: payload.length },
    );
  }
  return payload;
}
/** Enqueue one whole frame; `done` fires after its LAST byte is in the ring
 * (the completion ack, spec W4). `abort(error)` fires instead if the worker
 * dies while the frame is queued or parked — the ack must FAIL then, not
 * hang until the port terminates the worker. */
function residentRingWrite(payload, done, abort) {
  residentCheckFrame(payload);
  if (died) throw new Error("resident FileWorker is dead; dispose and boot a new worker");
  residentQueue.push({ payload, done, abort, off: 0 });
  if (!residentPumping) residentPump();
}
function residentPump() {
  residentPumping = true;
  const { ctrl, bytes } = residentViews();
  while (residentQueue.length > 0) {
    const item = residentQueue[0];
    while (item.off < item.payload.length) {
      const read = Atomics.load(ctrl, RESIDENT_IDX.READ);
      const write = Atomics.load(ctrl, RESIDENT_IDX.WRITE);
      const free = (read - write - 1 + RESIDENT_RING_CAP) % RESIDENT_RING_CAP;
      if (free === 0) {
        // Parked: the front door holds later didChanges (newest wins) until
        // the ring drains instead of queueing one elaboration per keystroke
        // behind a full ring (§2.4). Stay pumping; resume this item.
        if (frontDoor && !ringBusy) { ringBusy = true; frontDoorApply({ kind: "ring", busy: true }); }
        setTimeout(residentPump, 2);
        return;
      }
      const n = Math.min(free, RESIDENT_RING_CAP - write, item.payload.length - item.off);
      bytes.set(item.payload.subarray(item.off, item.off + n), write);
      item.off += n;
      Atomics.store(ctrl, RESIDENT_IDX.WRITE, (write + n) % RESIDENT_RING_CAP);
      Atomics.add(ctrl, RESIDENT_IDX.WAKE, 1);
      Atomics.notify(ctrl, RESIDENT_IDX.WAKE);
    }
    residentQueue.shift();
    if (item.done) item.done();
  }
  residentPumping = false;
  // Drained after a park: release the front door's backlog (it re-enters
  // residentRingWrite → residentPump, which is fine now that pumping is off).
  if (ringBusy) { ringBusy = false; if (frontDoor) frontDoorApply({ kind: "ring", busy: false }); }
}

function residentFrame(json) {
  const body = residentEncoder.encode(json);
  const header = residentEncoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header, 0);
  frame.set(body, header.length);
  return frame;
}

/** Open the resident loop: ring + callMain("--worker"). Shared by the
 * lsp-resident-init transport and the front door (§2.4 Ready → Open); the
 * caller writes the opening sequence. Throws before any state change. */
function residentOpenLoop() {
  if (state !== "ready") throw new Error(`Worker is '${state}', not ready.`);
  if (typeof M._lean_browser64_configure_input_ring !== "function" ||
      typeof M._lean_wasm_shell_mark_preinitialized !== "function" ||
      typeof M.callMain !== "function") {
    throw new Error("runtime lacks the resident transport exports (patch 0031)");
  }
  if (residentMode) throw new Error("resident FileWorker already started in this process");
  lspMode = true;
  // Boot already ran the full Lean initialization sequence; main must not
  // initialize (or ever finalize) again.
  M._lean_wasm_shell_mark_preinitialized();
  const raw = M._malloc(asPtr(16 + RESIDENT_RING_CAP));
  residentRingPtr = Number(asPtr(raw));
  const status = M._lean_browser64_configure_input_ring(asPtr(raw), RESIDENT_RING_CAP);
  if (Number(status) !== 0) throw new Error(`resident stdin ring rejected (${status})`);
  residentMode = true;
  // reportDelayMs=0: the reporter's first act is IO.sleep(reportDelayMs) on
  // a task pthread (the pump path sets the same via wasmLspInit).
  M.callMain(["--worker", "-Dserver.reportDelayMs=0"]);
}

/** Start the resident FileWorker: ring + callMain("--worker") + the opening
 * sequence. The FileWorker reads `initialize` then `didOpen` DIRECTLY —
 * nothing may come between them — and never answers `initialize` (that is
 * the watchdog's job; the shim answers it to the client itself). */
function residentInit(msg) {
  try {
    if (state !== "ready") throw new Error(`Worker is '${state}', not ready.`);
    // One worker, one session (W2): after `died` the runtime's session is
    // gone and the latch has fired, so a second session here could never
    // report its own death — refuse rather than swallow it (the C10 class).
    if (died) throw new Error("worker already died; dispose and boot a new worker");
    if (residentMode) throw new Error("resident FileWorker already started in this process");
    if (typeof M._lean_browser64_configure_input_ring !== "function" ||
        typeof M._lean_wasm_shell_mark_preinitialized !== "function" ||
        typeof M.callMain !== "function") {
      throw new Error("runtime lacks the resident transport exports (patch 0031)");
    }
    // Build and size-check BOTH opening frames before the runtime is touched:
    // a didOpen over cap/2 is refused with the worker exactly as it was, not
    // after mark_preinitialized + ring + callMain have left a FileWorker
    // running whose frames go nowhere and whose next init is "already started".
    const initFrame = residentCheckFrame(residentFrame(JSON.stringify({
      jsonrpc: "2.0", id: 0, method: "initialize", params: JSON.parse(msg.input.initParams || "{}"),
    })));
    const openFrame = residentCheckFrame(residentFrame(JSON.stringify({
      jsonrpc: "2.0", method: "textDocument/didOpen", params: JSON.parse(msg.input.didOpen),
    })));
    residentOpenLoop();
    residentRingWrite(initFrame);
    // Acked only once the whole opening sequence is in the ring (W4); a death
    // meanwhile fails the init instead of leaving it pending.
    residentRingWrite(openFrame, () => {
      event(null, "log", { stream: "stderr", text: "[resident] FileWorker started on the application pthread" });
      post({ type: "result", requestId: msg.requestId, result: { operation: "lsp-resident-init", tag: 0 } });
    }, (error) => fail(msg.requestId, error, "LSP_RESIDENT_INIT_FAILED", false));
  } catch (error) {
    lspMode = false;
    // An oversized opening frame was refused before anything ran: the worker
    // is intact, so the port may retry with a smaller document (recoverable).
    const oversize = error && typeof error.bytes === "number";
    fail(msg.requestId, error, "LSP_RESIDENT_INIT_FAILED", oversize, oversize ? { bytes: error.bytes } : undefined);
  }
}

function residentSend(msg) {
  try {
    if (!residentMode) throw new Error("resident FileWorker not started");
    // The result is the completion ack: posted inside the FIFO's `done`, i.e.
    // after the frame's last byte is in the ring (spec W4; the old immediate
    // ack let the port believe a parked frame had been delivered). If the
    // worker dies first the ack fails (non-recoverable) instead of hanging.
    residentRingWrite(residentFrame(msg.input.message), () => {
      post({ type: "result", requestId: msg.requestId, result: { operation: "lsp-resident-send", tag: 0 } });
    }, (error) => fail(msg.requestId, error, "LSP_RESIDENT_SEND_FAILED", false));
  } catch (error) {
    // An oversized frame is refused, not fatal: the session is intact and the
    // port can decide what to do with `bytes` — so it is recoverable.
    const oversize = error && typeof error.bytes === "number";
    fail(msg.requestId, error, "LSP_RESIDENT_SEND_FAILED", oversize, oversize ? { bytes: error.bytes } : undefined);
  }
}

// ---------------------------------------------------------------------------
// Resident front door (§2.4; pure machine in lsp-front-door.js). The page's
// `lsp` request is fire-and-forget — no requestId, no per-message ack: the
// machine queues from script load, opens the loop on the first didOpen once
// ARMED, and this host performs exactly the effects `step` returns. The host
// also owns the two data the machine cannot know — ring backpressure and the
// pthread pool — and merges them into one `status` event per change
// (§2.2(e)) plus a 2 s heartbeat once the loop is open (§2.2(f)); their loss
// is the ONLY death signal the page derives from time (§2.2 L2).
//
// Booting → Ready is an explicit `lsp-arm` request from the PAGE, not the
// wasm boot's success: the page still loads its snapshots (init, mathlib)
// AFTER `boot` resolves, and lean4monaco's initialize/didOpen arrive while
// that happens. Fed at wasm-boot success, a queued didOpen opened the loop
// before the page's loadSnapshot calls, which the K-i guard then refused
// (BAD_STATE → BootFailed → reboot → the same race → breaker), or the loop
// start met `state === "compiling"` and killed the session. The page arms as
// the LAST step of its session start (§2.3 BootOk: replay, then arm), so
// `booted` cannot precede a snapshot load (review fix 1).
// ---------------------------------------------------------------------------
let frontDoor = null; // machine state; null until the page speaks `lsp`
let frontDoorArmed = false; // set by `lsp-arm`; the one Booting → Ready fact
let ringBusy = false;
let heartbeat = null;
let hostStatus = { phase: "booting", version: null, header: null, dropped: 0 };
let lastStatusJson = "";
let ringRefused = 0; // frames over cap/2 the ring refused (a > 2 MB document)

function poolSample() {
  // In a MODULARIZE glue `PThread` is factory-local; only an
  // EXPORTED_RUNTIME_METHODS build publishes it as `Module.PThread`. Prefer
  // that, fall back to a global, and report -1 (not measured) otherwise so
  // the §6 attack-3 gauntlet can tell "≤ 20 running" from "never sampled".
  const PT = M && M.PThread ? M.PThread : typeof PThread !== "undefined" ? PThread : null;
  return {
    unused: PT && PT.unusedWorkers ? PT.unusedWorkers.length : -1,
    running: PT ? Object.keys(PT.pthreads || {}).length : -1,
  };
}

function ringQueuedBytes() {
  return residentQueue.reduce((n, item) => n + item.payload.length - item.off, 0);
}

function emitStatus(delta) {
  if (delta) Object.assign(hostStatus, delta);
  const s = { ...hostStatus, ring: { bytesQueued: ringQueuedBytes(), refused: ringRefused }, pool: poolSample() };
  const json = JSON.stringify(s);
  if (json === lastStatusJson) return;
  lastStatusJson = json;
  event(null, "status", s);
}

function frontDoorApply(frame) {
  // Lazy load (see the import note at the top): synchronous and legal at any
  // time in a classic worker; the vitest vm harness injects the file itself.
  if (typeof Qed64LspFrontDoor === "undefined" && typeof importScripts === "function") importScripts("lsp-front-door.js");
  const FD = Qed64LspFrontDoor;
  if (frontDoor === null) {
    frontDoor = FD.initialState();
    // The page may speak `lsp` before or after the arm; the machine starts in
    // Booting either way and moves on with the fact it missed. Only the
    // arm (never the wasm boot) supplies `booted`.
    if (state === "dead") frontDoor = FD.step(frontDoor, { kind: "died" }).state;
    else if (frontDoorArmed && frame.kind !== "booted") frontDoor = FD.step(frontDoor, { kind: "booted" }).state;
  }
  const r = FD.step(frontDoor, frame);
  frontDoor = r.state;
  if (r.startLoop) {
    try {
      residentOpenLoop();
      // The beat is the liveness fact only (§2.2(f)); status is emitted per
      // machine change (every server frame samples ring + pool) and on ring
      // park/drain, not on a 2 s cadence that would re-render the pill and
      // spam the harness's status stream with pool drift.
      heartbeat = setInterval(() => {
        event(null, "heartbeat", { t: Math.round(performance.now()) });
      }, 2000);
    } catch (error) {
      // The loop never opened: that is a session death, not a request error.
      event(null, "log", { stream: "stderr", text: `[front-door] loop start failed: ${error && error.message}` });
      die(null, "start", error && error.message ? error.message : String(error));
      return;
    }
  }
  for (const msg of r.replies) event(null, "lsp", { msg });
  for (const msg of r.ringWrites) {
    try {
      residentRingWrite(residentFrame(JSON.stringify(msg)));
    } catch (error) {
      ringRefused += 1;
      event(null, "log", { stream: "stderr", text: `[front-door] frame refused: ${error && error.message}` });
    }
  }
  emitStatus(r.statusDelta);
}

/** `lsp-arm`: the page's Booting → Ready fact (§2.4), sent as the LAST step
 * of its session start — after boot AND after every pre-open snapshot load
 * (§2.3 BootOk order: replay into the queue, then arm). Refused while any
 * runtime-owning request is in flight so a queued didOpen can never open
 * the loop under a snapshot load; idempotent once armed (a repeated
 * `booted` is a no-op in the machine). */
function frontDoorArm(msg) {
  if (state !== "ready") {
    fail(msg.requestId, new Error(`Worker is '${state}', not ready; arm after boot and the pre-open snapshot loads.`), "BAD_STATE", state !== "dead");
    return;
  }
  frontDoorArmed = true;
  frontDoorApply({ kind: "booted" });
  post({ type: "result", requestId: msg.requestId, result: { operation: "lsp-arm", open: residentMode } });
}

function lspInit(msg) {
  try {
    if (state !== "ready") throw new Error(`Worker is '${state}', not ready.`);
    lspMode = true;
    const rc = callP(M._lean_wasm_lsp_init, mkLeanString(msg.input.initParams), mkLeanString(msg.input.didOpen));
    // wasmLspInit reports failure as a SUCCESSFUL IO returning 1 (its catch
    // prints the error and returns 1) — the IO-level tag alone reads such a
    // failure as success, which left the shim believing a session existed
    // after a bad import ("send without a session" forever, diagnostics
    // frozen). Unbox the returned value like loadSnapshot does.
    const tag = ioResultTag(rc);
    const scalar = unboxScalar(ioResultValue(rc));
    // Preserve the RETURNED VALUE: 0 = session initialized, 1 = hard failure,
    // 2 = header unresolvable with the previous session kept intact.
    const value = tag !== 0 ? 1 : Number(scalar ?? 0n);
    post({ type: "result", requestId: msg.requestId, result: { operation: "lsp-init", tag: value } });
  } catch (error) {
    lspMode = false;
    fail(msg.requestId, error, "LSP_INIT_FAILED", false);
  }
}

function lspSend(msg) {
  try {
    const rc = callP(M._lean_wasm_lsp_send, mkLeanString(msg.input.message));
    const sTag = ioResultTag(rc);
    const sVal = unboxScalar(ioResultValue(rc));
    const sOk = sTag === 0 && (sVal === null || sVal === 0n);
    post({ type: "result", requestId: msg.requestId, result: { operation: "lsp-send", tag: sOk ? 0 : 1 } });
  } catch (error) {
    fail(msg.requestId, error, "LSP_SEND_FAILED", false);
  }
}
/** Write host-provided files into the worker's virtual FS (MEMFS). Game
 * builds use this to place `.lake/gamedata/*.json` where GameServer's
 * `Runner` reads them at proof-check time; generic for any small aux file.
 * input: { files: [{ path: string, text?: string, bytes?: Uint8Array }] } */
function writeFiles(msg) {
  try {
    const FS = M.FS;
    let written = 0;
    for (const f of msg.input?.files ?? []) {
      if (typeof f?.path !== "string" || !f.path.startsWith("/")) {
        throw new Error(`writeFiles: bad path ${String(f?.path)}`);
      }
      const dir = f.path.slice(0, f.path.lastIndexOf("/"));
      FS.mkdirTree ? FS.mkdirTree(dir) : mkdirTree(dir);
      FS.writeFile(f.path, f.bytes instanceof Uint8Array ? f.bytes : String(f.text ?? ""));
      written += 1;
    }
    post({ type: "result", requestId: msg.requestId, result: { operation: "write-files", written } });
  } catch (error) {
    fail(msg.requestId, error, "WRITE_FILES_FAILED", false);
  }
}

let bootConfig = null;
let bootMemory = null; // the shared Memory64 this worker created; heap writes re-read .buffer after growth
let currentRequest = null;
let compileSeq = 0;

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

function post(msg) {
  self.postMessage({ protocol: PROTOCOL, ...msg });
}
function event(requestId, kind, payload) {
  post({ type: "event", requestId, kind, ...payload });
}
function progress(requestId, phase, label, loaded, total, unit) {
  event(requestId, "progress", { phase, label, loaded, total, unit });
}
/** `extra` carries structured data beside the code (e.g. `{bytes}` for a
 * refused frame, the two build ids for SNAPSHOT_UNPAIRED) so callers act on
 * facts, not on message text. */
function fail(requestId, error, code, recoverable, extra) {
  post({
    type: "error",
    requestId,
    error: {
      code: code || "UNKNOWN",
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack,
      recoverable: Boolean(recoverable),
      ...(extra || {}),
    },
  });
}

// One death event (spec W2): `died` is emitted AT MOST ONCE per worker, from
// whichever of onAbort (post-boot), onExit, or an unhandled rejection fires
// first. It replaces `resident-exit`; pre-boot failures keep their error
// replies (the boot's settled-once guard) and are not deaths of a session.
// The payload carries `mode` because not every death is a crashed LSP
// session: `reason:"exit"` with code 0 is `lean --worker` returning normally
// (a watchdog restart request), and mode "batch" means no session existed —
// the port must key on {mode, reason, code}, not on the event's presence.
let died = false;
function die(code, reason, message) {
  if (died) return;
  died = true;
  const mode = residentMode ? "resident" : lspMode ? "pump" : "batch";
  residentMode = false;
  if (heartbeat !== null) { clearInterval(heartbeat); heartbeat = null; }
  if (frontDoor) frontDoorApply({ kind: "died" });
  // The consumer is gone: nothing queued for the ring will ever drain. Fail
  // every pending ack now (the port's FailPending-on-Died covers requests it
  // tracks; these are the ones only the worker knows about) and let a parked
  // pump find an empty queue instead of re-arming its 2 ms timer forever.
  const stranded = residentQueue.splice(0, residentQueue.length);
  const cause = new Error(`resident FileWorker died (${reason}${code === null || code === undefined ? "" : ` ${code}`}): ${message}`);
  for (const item of stranded) if (item.abort) item.abort(cause);
  event(null, "died", { code, reason, message, mode });
}

// A rejection nobody awaits (e.g. an allocation failure inside Emscripten's
// async materialization) must not strand the host mid-phase with no signal:
// observed live as a boot hung forever at "Mounting verified library packs"
// after "RangeError: Array buffer allocation failed" went uncaught. Fail the
// in-flight request so the app can show a real error instead of a spinner.
// `inFlightBootFail` routes through boot's settled-once guard while a boot
// is pending; a compile in flight fails per-request; anything else is logged.
let inFlightBootFail = null;
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  const error = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
  if (inFlightBootFail) {
    inFlightBootFail(error);
    return;
  }
  if (currentRequest !== null && state === "compiling") {
    const inFlight = currentRequest;
    currentRequest = null;
    state = "ready";
    fail(inFlight, error, "UNHANDLED_REJECTION", true);
  } else {
    // Post-boot with nothing in flight: a fact the port must hear once (W2)
    // rather than a log line it cannot act on. No exit code exists here.
    // Only a worker with an LSP session (pump or resident) can die of it — a
    // batch worker's stray rejection (e.g. a best-effort OPFS `removeEntry`
    // in openRawSnapshot's self-heal) is a log line, not a false death.
    event(null, "log", { stream: "stderr", text: `unhandled rejection: ${error.message}` });
    if (lspMode && state !== "idle" && state !== "booting") die(null, "unhandled", error.message);
  }
});

// ---------------------------------------------------------------------------
// wasm64 pointer helpers
// ---------------------------------------------------------------------------

/** Coerce any pointer-like value to BigInt for an i64 wasm parameter. */
function asPtr(v) {
  return typeof v === "bigint" ? v : BigInt(Math.trunc(v));
}
/** Coerce any pointer-like value to a JS Number address (< 2^53 by cap). */
function asNum(v) {
  if (typeof v === "bigint") {
    if (v > 9007199254740991n) throw new RangeError(`Address ${v} exceeds 2^53-1.`);
    return Number(v);
  }
  return v;
}
/** Call a wasm export whose parameters are all i64 pointers. */
function callP(fn, ...args) {
  return fn(...args.map(asPtr));
}

/** Read one byte of a Lean object header/payload. The build exports getValue
 * (not the HEAP views), so all memory reads go through it. */
function peekU8(addr) {
  return Number(M.getValue(asNum(addr), "i8")) & 0xff;
}
/** Read a pointer-sized field (8 bytes, little-endian) as BigInt. */
function peekU64(addr) {
  return BigInt(M.getValue(asNum(addr), "i64"));
}

/** Lean IO.Result inspection: constructor tag byte lives at offset 7. */
function ioResultTag(resPtr) {
  return peekU8(asNum(resPtr) + 7);
}
/** First object field (offset 8, pointer width). */
function ioResultValue(resPtr) {
  return peekU64(asNum(resPtr) + 8);
}
/** Decode a Lean tagged scalar (odd ⇒ boxed scalar n = v >> 1). */
function unboxScalar(v) {
  return (v & 1n) === 1n ? v >> 1n : null;
}

/** Build a Lean string object from a JS string; returns a BigInt pointer. */
function mkLeanString(text) {
  const cstr = M.stringToNewUTF8(text);
  const obj = callP(M._lean_mk_string, cstr);
  M._free(asPtr(cstr));
  return asPtr(obj);
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

function capabilities() {
  const memory64 =
    typeof WebAssembly === "object" &&
    typeof BigInt === "function" &&
    WebAssembly.validate(MEMORY64_PROBE);
  // What boot actually needs is a working SHARED Memory64 — probe by
  // construction. crossOriginIsolated is normally its precondition, but
  // proxied environments (cypress strips COOP/COEP) can still grant SAB via
  // the SharedArrayBuffer feature flag; refusing to boot there only breaks
  // test harnesses. Report COI honestly, gate on the constructive probe.
  let sharedMemory64 = false;
  try {
    new WebAssembly.Memory({ initial: 1n, maximum: 2n, shared: true, address: "i64" });
    sharedMemory64 = true;
  } catch {
    sharedMemory64 = false;
  }
  return {
    memory64,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    atomics: typeof Atomics === "object",
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedMemory64,
    ok:
      memory64 &&
      typeof SharedArrayBuffer === "function" &&
      typeof Atomics === "object" &&
      sharedMemory64,
  };
}

// ---------------------------------------------------------------------------
// Verified runtime materialization (chunks → SHA-256 → Blob URLs)
// ---------------------------------------------------------------------------

function hex(buffer) {
  let out = "";
  for (const b of new Uint8Array(buffer)) out += b.toString(16).padStart(2, "0");
  return out;
}
async function sha256(blobOrBytes) {
  const bytes = blobOrBytes instanceof Blob ? await blobOrBytes.arrayBuffer() : blobOrBytes;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function fetchChunkOnce(chunk, index, label, cacheMode) {
  const response = await fetch(chunk.url, { cache: cacheMode });
  if (!response.ok) throw new Error(`${label} chunk ${index}: HTTP ${response.status}`);
  const encoding = response.headers.get("Content-Encoding");
  if (encoding && encoding !== "identity") {
    throw new Error(`${label} chunk ${index} was transformed by Content-Encoding: ${encoding}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== chunk.bytes) {
    throw new Error(`${label} chunk ${index}: ${bytes.byteLength} bytes, expected ${chunk.bytes}.`);
  }
  if ((await sha256(bytes)) !== chunk.sha256) {
    throw new Error(`${label} chunk ${index} failed SHA-256 verification.`);
  }
  return bytes;
}

async function fetchChunk(chunk, index, label, requestId, running) {
  let bytes;
  try {
    bytes = await fetchChunkOnce(chunk, index, label, "force-cache");
  } catch {
    // The HTTP cache can hold a poisoned response for this URL (e.g. an SPA
    // fallback page cached before the artifact was deployed). Content
    // addressing makes the retry safe: bypass the cache once and re-verify.
    bytes = await fetchChunkOnce(chunk, index, label, "reload");
  }
  running.loaded += bytes.byteLength;
  progress(requestId, "runtime", `Verifying ${label}`, running.loaded, running.total, "bytes");
  return bytes;
}

async function materialize(file, label, mime, requestId, running) {
  const pieces = [];
  for (let i = 0; i < file.chunks.length; i += 1) {
    pieces.push(await fetchChunk(file.chunks[i], i, label, requestId, running));
  }
  const whole = new Blob(pieces, { type: mime });
  if (whole.size !== file.bytes) {
    throw new Error(`${label}: reconstructed ${whole.size} bytes, expected ${file.bytes}.`);
  }
  if ((await sha256(whole)) !== file.sha256) {
    throw new Error(`${label} failed whole-file SHA-256 verification.`);
  }
  return URL.createObjectURL(whole);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function createSharedMemory64(initialBytes, maxCandidatesBytes) {
  const initial = BigInt(Math.ceil(initialBytes / PAGE));
  for (const maxBytes of maxCandidatesBytes) {
    const maximum = BigInt(Math.floor(maxBytes / PAGE));
    try {
      const memory = new WebAssembly.Memory({
        initial,
        maximum,
        shared: true,
        address: "i64",
      });
      return { memory, initialBytes: Number(initial) * PAGE, maximumBytes: Number(maximum) * PAGE };
    } catch {
      // Try the next, smaller reservation.
    }
  }
  throw new Error("Could not allocate a shared Memory64 heap at any candidate size.");
}

// Wasm memory never shrinks, so the latest byteLength IS the session's
// high-water; labeled checkpoints attribute growth to boot phases (a
// browser64 measurement technique) and survive an OOM kill as the last
// sample the host saw.
const memCheckpoints = [];
function memCheckpoint(label) {
  try {
    // M.wasmMemory attaches late; bootMemory is the same Memory object from
    // the moment we created it.
    const mem = (M && M.wasmMemory) || bootMemory;
    const b = mem ? mem.buffer.byteLength : 0;
    memCheckpoints.push({ label, t: Math.round(performance.now()), bytes: b });
    if (memCheckpoints.length > 64) memCheckpoints.shift();
    event(null, "log", { stream: "stderr", text: `[mem] ${label}: ${(b / 1048576) | 0} MiB` });
  } catch { /* telemetry must never break the runtime */ }
}

// Aggregate accounting for the page's honest memory line: raw region bytes
// living inside the wasm heap, and pack bytes copied into MEMFS (zero when
// packs are Blob-backed WORKERFS mounts, the normal healthy-OPFS path).
let regionBytesTotal = 0;
let memfsPackBytesTotal = 0;

function memoryTelemetry() {
  try {
    const buffer = M && M.wasmMemory ? M.wasmMemory.buffer : null;
    if (!buffer) return undefined;
    return {
      currentBytes: buffer.byteLength,
      initialBytes: bootConfig ? bootConfig.memory.initialBytes : undefined,
      maximumBytes: bootConfig ? bootConfig.memory.maximumBytes : undefined,
      shared: typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer,
      regionBytes: regionBytesTotal,
      memfsPackBytes: memfsPackBytesTotal,
      checkpoints: memCheckpoints.slice(-16),
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

function mkdirp(FS, dirPath) {
  let current = "";
  for (const part of dirPath.split("/").filter(Boolean)) {
    current += `/${part}`;
    try {
      FS.mkdir(current);
    } catch {
      /* exists */
    }
  }
}

function validatePackEntry(file, blobSize, label) {
  if (typeof file.filename !== "string" || !file.filename.startsWith("/")) {
    throw new TypeError(`${label}: pack filename must be absolute: ${file.filename}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(file.filename) || file.filename.includes("..")) {
    throw new TypeError(`${label}: unsafe pack filename: ${file.filename}`);
  }
  if (
    !Number.isSafeInteger(file.start) ||
    !Number.isSafeInteger(file.end) ||
    file.start < 0 ||
    file.end < file.start ||
    file.end > blobSize
  ) {
    throw new RangeError(`${label}: invalid byte range for ${file.filename}`);
  }
}

// Lean's importer opportunistically opens EVERY companion facet present and
// retains every opened region (browser64's audited finding on the same
// pinned Lean): `.olean.private` alone is ~60% of our pack bytes (core
// 246/370 MiB, essential 2006/3328 MiB) and elaboration output is identical
// without it — hiding it from the mount cuts resident import memory by half
// or more. Flip to false to compare behavior.
const HIDE_PRIVATE_FACETS = true;

function mountPacks(FS, packs, defaultMountPoint) {
  const grouped = new Map();
  for (const pack of packs) {
    let files = pack.metadata && pack.metadata.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new TypeError(`Pack ${pack.id}: missing pack metadata.`);
    }
    if (HIDE_PRIVATE_FACETS) {
      const before = files.length;
      files = files.filter((f) => !String(f.filename).endsWith(".olean.private"));
      if (files.length !== before) {
        event(null, "log", { stream: "stderr", text: `[packs] ${pack.id}: hiding ${before - files.length} .olean.private facets from the mount` });
      }
    }
    const mountPoint = pack.mountPoint || defaultMountPoint;
    if (pack.bytes) {
      // Byte-backed segment: write each file into MEMFS. Contents live in the
      // worker's JS heap (not wasm linear memory, not Blob storage); Lean's
      // region loader copies bytes into the wasm heap on open, exactly as it
      // would from a WORKERFS read.
      const bytes = pack.bytes instanceof Uint8Array ? pack.bytes : new Uint8Array(pack.bytes);
      memfsPackBytesTotal += bytes.byteLength;
      for (const file of files) validatePackEntry(file, bytes.byteLength, pack.id);
      mkdirp(FS, mountPoint);
      for (const file of files) {
        const target = `${mountPoint}${file.filename}`;
        mkdirp(FS, target.slice(0, target.lastIndexOf("/")));
        FS.writeFile(target, bytes.subarray(file.start, file.end));
      }
      continue;
    }
    if (!(pack.blob instanceof Blob)) throw new TypeError(`Pack ${pack.id}: no payload.`);
    for (const file of files) validatePackEntry(file, pack.blob.size, pack.id);
    if (!grouped.has(mountPoint)) grouped.set(mountPoint, []);
    grouped.get(mountPoint).push({ metadata: { ...pack.metadata, files }, blob: pack.blob });
  }
  for (const [mountPoint, packages] of grouped) {
    mkdirp(FS, mountPoint);
    FS.mount(FS.filesystems.WORKERFS, { packages }, mountPoint);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const DIAG_RE = /^(.*?):(\d+):(\d+):\s+(error|warning|information):\s?([\s\S]*)$/;

function parseDiagnostic(text, fallbackFile) {
  // The CLI's --json mode emits one JSON object per diagnostic; the persistent
  // shell prints classic `file:line:col: severity: message` lines.
  if (text.startsWith("{")) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && value.severity) {
        return {
          fileName: value.fileName || fallbackFile,
          line: value.pos ? value.pos.line : 1,
          column: value.pos ? value.pos.column : 0,
          endLine: value.endPos ? value.endPos.line : undefined,
          endColumn: value.endPos ? value.endPos.column : undefined,
          severity: value.severity,
          message: typeof value.data === "string" ? value.data : value.message || "",
        };
      }
    } catch {
      /* fall through to the plain form */
    }
  }
  const match = DIAG_RE.exec(text);
  if (!match) return null;
  return {
    fileName: match[1] || fallbackFile,
    line: Number(match[2]),
    column: Number(match[3]),
    severity: match[4],
    message: match[5] || "",
  };
}

/** Stream collector: groups multi-line diagnostics (continuation lines are
 * indented or lack the file:line:col prefix) under the last diagnostic. */
function makeOutputCollector(requestId, fallbackFile) {
  const diagnostics = [];
  const raw = [];
  let importProgressSeen = 0;
  function push(stream, value) {
    const text = String(value);
    const m = /\[DEBUG:PROGRESS\]\s*(\d+)\/(\d+)/.exec(text);
    if (m) {
      progress(requestId, "import", "Importing modules", Number(m[1]), Number(m[2]), "modules");
      return;
    }
    if (/^\s*-\s+\/.*\.olean\s*$/.test(text)) {
      importProgressSeen += 1;
      if (importProgressSeen % 25 === 0) {
        progress(requestId, "import", "Importing modules", importProgressSeen, undefined, "modules");
      }
      return;
    }
    if (/^\s*\[(WASM DEBUG|DEBUG|PROFILE|PWORKER|COMPILE)/.test(text)) return;
    const diagnostic = parseDiagnostic(text, fallbackFile);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    } else if (diagnostics.length > 0 && /^\s/.test(text)) {
      // Continuation of the previous message (goal states are multi-line).
      diagnostics[diagnostics.length - 1].message += `\n${text}`;
    } else {
      raw.push({ stream, text });
    }
    event(requestId, "log", { stream, text });
  }
  return { diagnostics, raw, push };
}

// ---------------------------------------------------------------------------
// Boot (persistent runtime)
// ---------------------------------------------------------------------------

async function boot(msg) {
  if (state !== "idle") {
    fail(msg.requestId, new Error(`Worker is '${state}'; boot requires a fresh Worker.`), "BAD_STATE", true);
    return;
  }
  // Validate the config shape before any state transition: a malformed boot
  // must produce exactly one error reply, never a silently wedged worker.
  const cfg = msg.config;
  const filesOk =
    cfg && cfg.runtime && cfg.runtime.files &&
    cfg.runtime.files["lean.js"] && Array.isArray(cfg.runtime.files["lean.js"].chunks) &&
    cfg.runtime.files["lean.wasm"] && Array.isArray(cfg.runtime.files["lean.wasm"].chunks) &&
    cfg.memory && Number.isFinite(cfg.memory.initialBytes) && Array.isArray(cfg.memory.maximumCandidates) &&
    typeof cfg.leanPath === "string";
  if (!filesOk) {
    fail(msg.requestId, new Error("Malformed boot config."), "INVALID_MESSAGE", false);
    state = "dead";
    return;
  }
  state = "booting";
  const caps = capabilities();
  if (!caps.ok) {
    state = "dead";
    fail(
      msg.requestId,
      new Error("Missing capability: Memory64, SharedArrayBuffer, Atomics, or cross-origin isolation."),
      "CAPABILITY_MISSING",
      false,
    );
    return;
  }

  bootConfig = msg.config;
  const requestId = msg.requestId;
  const files = bootConfig.runtime.files;
  const running = {
    loaded: 0,
    total: files["lean.js"].bytes + files["lean.wasm"].bytes,
  };

  let scriptUrl;
  let wasmUrl;
  try {
    scriptUrl = await materialize(files["lean.js"], "lean.js", "text/javascript", requestId, running);
    wasmUrl = await materialize(files["lean.wasm"], "lean.wasm", "application/wasm", requestId, running);
  } catch (error) {
    state = "dead";
    fail(requestId, error, "RUNTIME_FETCH_FAILED", false);
    return;
  }

  let mem;
  try {
    mem = createSharedMemory64(bootConfig.memory.initialBytes, bootConfig.memory.maximumCandidates);
  } catch (error) {
    state = "dead";
    fail(requestId, error, "MEMORY_FAILED", false);
    return;
  }
  bootConfig.memory.maximumBytes = mem.maximumBytes;
  bootMemory = mem.memory;
  progress(requestId, "memory", `Shared Memory64 heap: ${(mem.initialBytes / 1048576) | 0} MiB → ${(mem.maximumBytes / 1073741824)} GiB max`);

  const collector = makeOutputCollector(requestId, "<boot>");
  sink = collector;

  await new Promise((resolve) => {
    let settled = false;
    const finishBoot = (ok, error) => {
      if (settled) return;
      settled = true;
      inFlightBootFail = null;
      if (ok) {
        state = "ready";
        post({
          type: "ready",
          requestId,
          ready: {
            buildId: bootConfig.runtime.buildId,
            leanVersion: bootConfig.runtime.leanVersion,
            capabilities: caps,
            memory: memoryTelemetry(),
            mode: "persistent",
          },
        });
        // NOT Booting → Ready for the front door: the page's snapshot loads
        // follow this reply; only its `lsp-arm` moves the machine (see above).
      } else {
        state = "dead";
        fail(requestId, error || new Error("Lean runtime failed to initialize."), "INIT_FAILED", false);
      }
      resolve();
    };
    inFlightBootFail = (error) => finishBoot(false, error);

    self.Module = {
      wasmMemory: mem.memory,
      INITIAL_MEMORY: mem.initialBytes,
      noInitialRun: true,
      locateFile(p) {
        return p.endsWith(".wasm") ? wasmUrl : new URL(p, scriptUrl).href;
      },
      mainScriptUrlOrBlob: scriptUrl,
      // Resident mode: `lean --worker`'s main returning (a watchdog-restart
      // request, a fatal header error) is a death FACT for the port (W2) —
      // the runtime keepalive keeps every environment resident, but the
      // session is gone.
      onExit: (code) => die(code, "exit", `lean --worker exited with code ${code}`),
      // Line-buffered stdout only ever reaches print() outside LSP mode
      // (installStdoutTap takes the bytes first); batch parsing is unchanged.
      print: (v) => sink && sink.push("stdout", v),
      printErr: (v) => {
        if (sink) sink.push("stderr", v);
        // Outside a compile (LSP mode, background tasks) stderr still matters:
        // surface it as log events instead of dropping it.
        else event(null, "log", { stream: "stderr", text: String(v) });
      },
      ENV: { LEAN_PATH: bootConfig.leanPath },
      preRun: [
        function mountEverything() {
          progress(requestId, "filesystem", "Mounting verified library packs");
          const FS = self.Module.FS;
          // /bin must exist: lean_init_search_path stats the executable's
          // virtual directory (IO.appPath reports /bin/lean).
          mkdirp(FS, "/bin");
          mkdirp(FS, "/workspace");
          mkdirp(FS, "/snapshots");
          for (const dir of String(bootConfig.leanPath).split(":")) mkdirp(FS, dir);
          mountPacks(FS, bootConfig.packs || [], String(bootConfig.leanPath).split(":")[0]);
          self.Module.ENV.LEAN_PATH = bootConfig.leanPath;
          try {
            FS.chdir("/workspace");
          } catch {
            /* mkdirp reported the real problem */
          }
        },
      ],
      onRuntimeInitialized() {
        memCheckpoint("runtime-initialized");
        try {
          progress(requestId, "initialize", "Initializing the Lean runtime");
          M = self.Module;
          // After initRuntime's FS.init (the standard streams exist) and
          // before any Lean output: the per-byte stdout sink (W1).
          installStdoutTap();
          // Persistent embedding: no main() ever runs, so the runtime
          // keepalive counter is 0 and the FIRST event-loop-serviced proxied
          // call from a pthread would end in maybeExit() → _exit(): the glue's
          // callUserCallback wraps the mailbox check, tearing down the runtime
          // and terminating the caller thread mid-emscripten_proxy_sync (the
          // proxied op runs, its ACK never lands). One keepalive ref makes the
          // runtime persistent, which is exactly what this worker is.
          if (typeof runtimeKeepalivePush === "function") {
            runtimeKeepalivePush();
            event(null, "log", { stream: "stderr", text: "[boot] runtime keepalive pushed" });
          } else {
            event(null, "log", { stream: "stderr", text: "[boot] WARNING: runtimeKeepalivePush not in scope" });
          }
          M._lean_initialize_runtime_module();
          M._lean_initialize();
          M._lean_io_mark_end_initialization();
          if (M._lean_init_task_manager) M._lean_init_task_manager();
          if (M._lean_enable_initializer_execution) M._lean_enable_initializer_execution();
          const sp = M._lean_init_search_path();
          if (ioResultTag(sp) !== 0) {
            try {
              callP(M._lean_io_result_show_error, sp);
            } catch {
              /* diagnostics already flowed through printErr */
            }
            throw new Error("lean_init_search_path failed (see log).");
          }
          finishBoot(true);
        } catch (error) {
          finishBoot(false, error);
        }
      },
      onAbort(reason) {
        memCheckpoint("abort");
        if (!settled) {
          finishBoot(false, new Error(`Lean aborted during boot: ${reason || "unknown"}`));
          return;
        }
        // A post-boot abort means the wasm runtime is gone for good: report
        // the in-flight request (if any) as unrecoverable and go dead. The
        // error reply is what the pump path's port keys on; `died` is the
        // one death fact (W2) for the resident port.
        state = "dead";
        fail(currentRequest, new Error(`Lean runtime aborted: ${reason || "unknown"}`), "RUNTIME_ABORTED", false);
        die(null, "abort", String(reason || "unknown"));
      },
    };

    try {
      progress(requestId, "runtime", "Starting the Emscripten runtime");
      importScripts(scriptUrl);
    } catch (error) {
      finishBoot(false, error);
    }
  });
}

// ---------------------------------------------------------------------------
// Persistent compile
// ---------------------------------------------------------------------------

function compile(msg) {
  if (residentMode) {
    // K-i: once the loop is open the header verdict must stay a pure function
    // of the header text — no publish, no compile on the main thread that the
    // loop's pthreads are proxying through. Exact sessions compile BEFORE open.
    fail(msg.requestId, new Error("the resident loop is open; compile is pre-open only."), "BAD_STATE", true);
    return;
  }
  if (state !== "ready") {
    fail(msg.requestId, new Error(`Worker is '${state}', not ready.`), "BAD_STATE", state === "compiling");
    return;
  }
  if (!msg.input || typeof msg.input.source !== "string") {
    fail(msg.requestId, new Error("Malformed compile input."), "INVALID_MESSAGE", true);
    return;
  }
  state = "compiling";
  currentRequest = msg.requestId;
  const started = performance.now();
  compileSeq += 1;
  const fileName = msg.input.fileName || `/workspace/input${compileSeq}.lean`;
  const collector = makeOutputCollector(msg.requestId, fileName);
  const savedSink = sink;
  sink = collector;

  let exitCode = 1;
  let runtimeError = null;
  try {
    const codeObj = mkLeanString(String(msg.input.source || ""));
    const nameObj = mkLeanString(fileName);
    const res = callP(M._lean_wasm_compile, codeObj, nameObj);
    const tag = ioResultTag(res);
    if (tag === 0) {
      const scalar = unboxScalar(ioResultValue(res));
      // The shell returns a UInt32: 0 = clean, otherwise the error count. A
      // 64-bit build boxes UInt32 as a tagged scalar; treat a non-scalar value
      // conservatively as success-with-diagnostics.
      exitCode = scalar === null ? 0 : Number(scalar);
    } else {
      try {
        callP(M._lean_io_result_show_error, res);
      } catch {
        /* already logged */
      }
      const tail = (collector.raw || [])
        .filter((l) => l.stream === "stderr" && l.text.trim() && !l.text.startsWith("[WASM"))
        .slice(-3)
        .map((l) => l.text.trim().slice(0, 220));
      runtimeError = new Error(
        "lean_wasm_compile returned an IO error" + (tail.length ? `: ${tail.join(" · ")}` : " (see log)."),
      );
    }
  } catch (error) {
    runtimeError = error;
  } finally {
    // Keep the sink on this compile's collector: Emscripten pthreads can
    // proxy output back after the call returns, and late lines belong to the
    // last compile rather than the boot log. (savedSink is only restored if
    // a newer collector never replaces it — i.e. never.)
    void savedSink;
    if (state === "compiling") state = "ready";
    currentRequest = null;
  }
  if (state === "dead") {
    // onAbort already reported the failure; do not also post a result.
    return;
  }

  if (runtimeError && collector.diagnostics.length === 0) {
    fail(msg.requestId, runtimeError, "COMPILE_CRASHED", true);
    return;
  }
  const hasErrors =
    exitCode !== 0 || collector.diagnostics.some((d) => d.severity === "error") || Boolean(runtimeError);
  post({
    type: "result",
    requestId: msg.requestId,
    result: {
      operation: "compile",
      success: !hasErrors,
      exitCode,
      elapsedMs: performance.now() - started,
      diagnostics: collector.diagnostics,
      raw: collector.raw,
      memory: memoryTelemetry(),
    },
  });
}

// ---------------------------------------------------------------------------
// Snapshot loading (optional fast boot)
// ---------------------------------------------------------------------------
// Exactly two load paths, both ending in the wasm heap and both handed to
// `_lean_wasm_load_snapshot_mem` — the only browser loader (architecture
// re-evaluation 2, §2.2 L0/L1 (a); T9 "one writer, one reader"):
//
//   1. warm: the prefetch worker (snapshot-prefetch.worker.js) is the SOLE
//      OPFS producer of `qed64-snapshots/<cacheKey>.raw` (network → gunzip
//      → OPFS in a disposable heap); this worker only ever sync-reads that
//      inflated region straight into a wasm allocation — no gunzip, no
//      per-chunk JS buffer;
//   2. cold / no OPFS: fetch → sniff → DecompressionStream → the same wasm
//      allocation. Kept as the fallback because embedders lie about storage
//      and an origin's OPFS view can rot mid-session (HARDENING #6, #16), so
//      a missing or unreadable `.raw` must still boot from the network.
//
// Deleted in W5 (dead on the raw path, and a second multi-GB copy in the JS
// heap on the cold path): the compressed `.snapz` OPFS cache and its
// transactional writer, the download tee that fed it, the MEMFS staging
// file, and the `_lean_wasm_load_snapshot` path-loader branch. A cache
// failure of any kind is a log line and a network boot, never a failed load.

async function snapshotCacheDir() {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle("qed64-snapshots", { create: true });
  } catch {
    return null;
  }
}

/** Sync-readable RAW (inflated) snapshot region cache entry, or null.
 * browser64's audited finding: OPFS sync-handle reads land directly in the
 * wasm heap at near-memory speed (~1.5 GB in ~200 ms of read service) — a
 * warm boot from a raw cache skips gunzip AND every per-chunk JS buffer. */
async function openRawSnapshot(rawKey, expectedBytes) {
  const dir = await snapshotCacheDir();
  if (!dir || !rawKey) return null;
  let handle;
  try {
    handle = await (await dir.getFileHandle(rawKey)).createSyncAccessHandle();
  } catch {
    return null;
  }
  const size = handle.getSize();
  if (size === 0 || (expectedBytes > 0 && size !== expectedBytes)) {
    // Stale (different bake) or torn — self-heal by discarding.
    handle.close();
    dir.removeEntry(rawKey).catch(() => {});
    return null;
  }
  return { handle, size };
}

async function loadSnapshot(msg) {
  if (residentMode) {
    // K-i (see compile): a snapshot published after open would change the
    // verdict for a header Lean already elaborated and reused (`unchanged`).
    fail(msg.requestId, new Error("the resident loop is open; loadSnapshot is pre-open only."), "BAD_STATE", true);
    return;
  }
  if (state !== "ready") {
    fail(msg.requestId, new Error(`Worker is '${state}', not ready.`), "BAD_STATE", true);
    return;
  }
  if (!msg.input || typeof msg.input.url !== "string") {
    fail(msg.requestId, new Error("Malformed loadSnapshot input."), "INVALID_MESSAGE", true);
    return;
  }
  const { url, name, expectedBytes, cacheKey, runtime } = msg.input;
  const safeName = String(name || "boot.snap").replace(/[^A-Za-z0-9._-]/g, "_");
  // Pairing (phase 1): a snapshot is a compacted region of the EXACT runtime
  // that baked it; loading one against another build traps "memory access
  // out of bounds" deep in the region loader. When the index entry names its
  // `runtime` (buildId), refuse a mismatch here with a structured code the
  // page can render (bug class C6). Absent `runtime` = a pre-pairing index,
  // accepted as before.
  const booted = bootConfig && bootConfig.runtime ? bootConfig.runtime.buildId : undefined;
  if (typeof runtime === "string" && runtime.length > 0 && runtime !== booted) {
    fail(
      msg.requestId,
      new Error(`snapshot '${safeName}' was baked for runtime ${runtime}; this worker booted ${booted}`),
      "SNAPSHOT_UNPAIRED",
      true,
      { expectedRuntime: runtime, bootedRuntime: booted },
    );
    return;
  }
  // Both paths write the region into ONE wasm-malloc'd buffer sized from the
  // index entry's RAW byte count (for gzip-served snapshots content-length is
  // only the transfer size) and hand it to the in-memory loader. A runtime
  // without that export, or an index without `bytes`, cannot be served in
  // the browser at all: the MEMFS + path-loader stand-in was deleted (W5),
  // so refuse up front with a message that names the missing datum.
  const total = Number(expectedBytes) || 0;
  if (typeof M._lean_wasm_load_snapshot_mem !== "function" || !bootMemory || total <= 0) {
    fail(
      msg.requestId,
      new Error(`snapshot '${safeName}': needs _lean_wasm_load_snapshot_mem in the runtime and the raw byte count in the index (got ${String(expectedBytes)})`),
      "SNAPSHOT_FAILED",
      true,
    );
    return;
  }
  const started = performance.now();
  state = "compiling"; // snapshot loads own the runtime exactly like a compile
  let heapPtr = null;
  let received = 0;
  let reader = null;
  let rawSource = null;
  let prevSinkRef = null;
  try {
    const rawKey = cacheKey ? `${cacheKey}.raw` : null;
    rawSource = rawKey ? await openRawSnapshot(rawKey, total) : null;
    let response = null;
    if (!rawSource) {
      // Fail on HTTP status BEFORE allocating a multi-GB region, so a bad URL
      // costs nothing in the heap.
      response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`snapshot fetch: HTTP ${response.status}`);
    }
    heapPtr = asPtr(M._malloc(asPtr(total)));
    regionBytesTotal += total;
    if (heapPtr === 0n) throw new Error(`snapshot: could not allocate ${total} bytes in the wasm heap`);
    const magic = [0x6f, 0x6c, 0x65, 0x61, 0x6e]; // "olean"
    if (rawSource) {
      // Warm fast path: the inflated region sits in OPFS — sync-read it in
      // large slices DIRECTLY into the wasm allocation. Re-derive the heap
      // view per slice (a shared memory's buffer object changes on growth).
      const SLICE = 64 * 1048576;
      let off = 0;
      while (off < total) {
        const n = Math.min(SLICE, total - off);
        const view = new Uint8Array(bootMemory.buffer, Number(heapPtr) + off, n);
        const got = rawSource.handle.read(view, { at: off });
        if (got <= 0) throw new Error("raw snapshot cache truncated mid-read");
        if (off === 0 && magic.some((b, i) => view[i] !== b)) {
          throw new Error("raw snapshot cache is not a compacted-region file");
        }
        off += got;
        progress(msg.requestId, "snapshot-cache", "Loading environment snapshot", off, total, "bytes");
      }
      rawSource.handle.close();
      rawSource = null;
      received = total;
    } else {
      // Cold path. Gzip-served snapshots inflate through DecompressionStream
      // — but only if the bytes that arrive are still gzip. Servers that
      // recognise the .gz extension add `Content-Encoding: gzip` and the
      // browser inflates transparently; trusting the URL would then gunzip
      // plain olean bytes ("incorrect header check", HARDENING #19). Sniff
      // the magic on the first chunk instead.
      const rawReader = response.body.getReader();
      const head = await rawReader.read();
      if (head.done || !head.value) throw new Error("snapshot fetch: empty body");
      const isGzip = head.value.length >= 2 && head.value[0] === 0x1f && head.value[1] === 0x8b;
      const replay = new ReadableStream({
        start(controller) {
          controller.enqueue(head.value);
        },
        async pull(controller) {
          const { done, value } = await rawReader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        },
        cancel(reason) {
          return rawReader.cancel(reason);
        },
      });
      const body = isGzip ? replay.pipeThrough(new DecompressionStream("gzip")) : replay;
      reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received === 0 && (value.length < 5 || magic.some((b, i) => value[i] !== b))) {
          throw new Error("snapshot is not a compacted-region file");
        }
        if (received + value.length > total) throw new Error("snapshot: more bytes than the index declares");
        // Re-read .buffer each chunk (a shared memory's buffer object changes
        // on growth) and window the view: offsets past 2^32 are fine, a
        // whole-heap view of a multi-GiB buffer is not in every engine.
        new Uint8Array(bootMemory.buffer, Number(heapPtr) + received, value.length).set(value);
        received += value.length;
        progress(msg.requestId, "snapshot", "Loading environment snapshot", received, total, "bytes");
      }
    }
    if (received !== total) throw new Error(`snapshot: received ${received} bytes, index declares ${total}`);
    // The region load below is one synchronous wasm call (1–2 min for a
    // whole-Mathlib environment); tell the host before blocking so it can
    // show an honest "loading into Lean" stage instead of a pegged bar. The
    // runtime streams "[WASM INIT] i/n Module" lines through printErr DURING
    // the call (JS callbacks run synchronously inside it), so a temporary
    // sink turns them into live per-module progress.
    progress(msg.requestId, "snapshot-load", "Loading the environment into Lean", undefined, undefined, "");
    const prevSink = sink;
    prevSinkRef = { sink: prevSink };
    sink = {
      push(stream, text) {
        const m = /^\[WASM INIT\] (\d+)\/(\d+) (.*)$/.exec(text);
        if (m) progress(msg.requestId, "snapshot-init", m[3], Number(m[1]), Number(m[2]), "modules");
        else if (prevSink) prevSink.push(stream, text);
      },
    };
    // The runtime takes ownership of the buffer as the region's backing store.
    const owned = heapPtr;
    heapPtr = null;
    // Third arg: replay-control flags — bit 0 runs the [init] attribute
    // replay, which the app always needs (compiles die without it).
    const res = M._lean_wasm_load_snapshot_mem(owned, asPtr(received), 1n);
    sink = prevSink;
    memCheckpoint(`snapshot-loaded:${safeName}`);
    const tag = ioResultTag(res);
    const scalar = unboxScalar(ioResultValue(res));
    const ok = tag === 0 && (scalar === null || scalar === 0n);
    post({
      type: "result",
      requestId: msg.requestId,
      result: { operation: "loadSnapshot", success: ok, elapsedMs: performance.now() - started },
    });
  } catch (error) {
    // A mid-stream failure (allocation, network, torn cache) must not strand
    // a partial multi-GB region in the wasm heap: the fallback import that
    // follows runs under whatever heap this leak would have consumed.
    try { reader?.cancel(); } catch { /* stream already dead */ }
    try { rawSource?.handle.close(); } catch { /* already closed */ }
    if (heapPtr !== null) { try { M._free(heapPtr); } catch { /* best effort */ } }
    fail(msg.requestId, error, "SNAPSHOT_FAILED", true);
  } finally {
    if (prevSinkRef) sink = prevSinkRef.sink;
    if (state === "compiling") state = "ready";
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

self.addEventListener("message", (e) => {
  const msg = e.data;
  // `lsp` is fire-and-forget (§2.2 L2 "postMessage, no promise"): no
  // requestId, no reply — the machine queues it until the loop is open.
  if (msg && msg.protocol === PROTOCOL && msg.type === "lsp") {
    if (msg.msg && typeof msg.msg === "object") frontDoorApply({ kind: "client", msg: msg.msg, replay: msg.replay === true });
    return;
  }
  if (!msg || msg.protocol !== PROTOCOL || typeof msg.requestId !== "string") {
    fail(undefined, new Error("Malformed worker message."), "INVALID_MESSAGE", false);
    return;
  }
  switch (msg.type) {
    case "capabilities":
      post({ type: "result", requestId: msg.requestId, result: capabilities() });
      break;
    case "boot":
      void boot(msg);
      break;
    case "compile":
      compile(msg);
      break;
    case "loadSnapshot":
      void loadSnapshot(msg);
      break;
    case "telemetry":
      post({
        type: "result",
        requestId: msg.requestId,
        result: { operation: "telemetry", state, memory: memoryTelemetry(), status: frontDoor ? { ...hostStatus } : undefined },
      });
      break;
    case "lsp-threads": {
      const PT = typeof PThread !== "undefined" ? PThread : null;
      post({
        type: "result",
        requestId: msg.requestId,
        result: {
          operation: "lsp-threads",
          unused: PT?.unusedWorkers?.length ?? -1,
          running: PT ? Object.keys(PT.pthreads ?? {}).length : -1,
          lspBufLen: lspFrames ? lspFrames.pendingBytes : 0,
          frames: lspFrames ? { ...lspFrames.stats } : null,
          ringQueued: residentQueue.reduce((n, item) => n + item.payload.length - item.off, 0),
        },
      });
      break;
    }
    case "lsp-init":
      lspInit(msg);
      break;
    case "lsp-resident-init":
      residentInit(msg);
      break;
    case "lsp-resident-send":
      residentSend(msg);
      break;
    case "lsp-arm":
      frontDoorArm(msg);
      break;
    case "lsp-send":
      lspSend(msg);
      break;
    case "write-files":
      writeFiles(msg);
      break;
    case "dispose":
      post({ type: "result", requestId: msg.requestId, result: { operation: "dispose" } });
      self.close();
      break;
    default:
      fail(msg.requestId, new Error(`Unknown request '${msg.type}'.`), "INVALID_MESSAGE", false);
  }
});

// Pure internals exposed for the unit-test harness (no effect in production).
self.__qed64TestExports = {
  parseDiagnostic,
  makeOutputCollector,
  validatePackEntry,
  unboxScalar,
  asPtr,
  asNum,
  capabilities,
  createSharedMemory64,
  // Ring writer under test (tests/unit/ring-writer.test.ts): a fake shared
  // memory stands in for the wasm heap, and `residentMode` is forced so
  // residentSend's completion ack and cap/2 refusal run against the real code.
  resident: {
    RESIDENT_RING_CAP,
    attachRing(memory, ctrlPtr) {
      bootMemory = memory;
      residentRingPtr = ctrlPtr;
      residentMode = true;
    },
    // A fake Emscripten module with the three transport exports plus _malloc,
    // and the `ready` state, so residentInit's preflight/refusal paths run
    // against the real code without a runtime.
    attachRuntime(fakeModule, memory) {
      M = fakeModule;
      bootMemory = memory;
      state = "ready";
      residentMode = false;
      lspMode = false;
    },
    residentRingWrite,
    residentSend,
    residentInit,
    residentFrame,
    die,
    snapshot: () => ({ died, residentMode, lspMode, queued: residentQueue.length, pumping: residentPumping }),
  },
  // Front-door host wiring under test (tests/unit/front-door.test.ts): the
  // machine's state and the merged status, read-only.
  frontDoor: {
    state: () => frontDoor,
    status: () => ({ ...hostStatus }),
    armed: () => frontDoorArmed,
    open: () => residentMode,
    /** Stand in for the runtime the harness has no wasm for: the host state
     * a snapshot load or a finished boot would leave, a fake module with the
     * four resident-transport exports, and a fake shared heap for the ring. */
    host({ state: s, M: m, memory }) {
      if (s !== undefined) state = s;
      if (m !== undefined) M = m;
      if (memory !== undefined) bootMemory = memory;
    },
  },
};

post({ type: "boot" });
