#!/usr/bin/env node
// Phase-1 spike for the resident FileWorker (docs/RESIDENT-WORKER-PLAN.md):
// boot the patch-0031 artifact under Node, configure the futex stdin ring,
// callMain(["--worker"]) — the REAL Lean FileWorker loop on the application
// pthread — then drive initialize/didOpen through the ring and read framed
// LSP off stdout. Exit criteria: initialize answers, fileProgress flows
// (proves timed sleeps wake on the proxied pthread — the known emsdk risk),
// diagnostics arrive for a deliberate error, and the loop shuts down clean.
//
//   node pipeline/snapshot/resident-probe.mjs [--artifact <stage1>] [--lib <tree>] [--budget-ms 180000]
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import "../../public/workers/lsp-frames.js"; // publishes globalThis.Qed64LspFrames

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const artifactDir = path.resolve(arg("artifact", path.join(repoRoot, "pipeline/toolchain/work/build/stage1")));
const libLean = path.resolve(arg("lib", path.join(artifactDir, "lib/lean")));
const budgetMs = Number(arg("budget-ms", "180000"));
const leanJs = path.join(artifactDir, "bin/lean.js");
if (!fs.existsSync(leanJs)) { console.error(`error: ${leanJs} not found`); process.exit(2); }

const PROBE = (process.env.PROBE_MINIMAL ? [
  "import Init",
  "theorem two_two : (2 : Nat) + 2 = 4 := rfl",
  "example : (2 : Nat) + 2 = 5 := rfl",
] : [
  "import Init",
  "def answer : Nat := 41 + 1",
  "#eval answer",
  "theorem answer_is : answer = 42 := rfl",
  "example : answer = 43 := rfl",
]).join("\n") + "\n";

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
const seen = { initializeResponse: false, fileProgressEvents: 0, progressDrained: false, diags: [], evalInfo: false,
  act: 1, exit2: false, act2Diags: 0, act2Drained: false };
const ACT2 = process.argv.includes("--act2");
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
let finished = false;
function finish(ok, why) {
  if (finished) return;
  finished = true;
  const verdict = {
    ok,
    why,
    initializeResponse: seen.initializeResponse,
    fileProgressEvents: seen.fileProgressEvents,
    progressDrained: seen.progressDrained,
    diagnostics: seen.diags.length,
    sawExpectedError: seen.diags.some((d) => /rfl|43|Type mismatch|failed/i.test(d)),
    evalInfo: seen.evalInfo,
    frames: frames.stats.frames,
    nonFrameStdoutBytes: frames.stats.junkBytes,
    wallMs: Date.now() - t0,
  };
  console.log(`RESIDENT PROBE ${ok ? "PASS" : "FAIL"} ${JSON.stringify(verdict)}`);
  process.exit(ok ? 0 : 1);
}
setTimeout(() => finish(false, "budget exceeded"), budgetMs).unref?.();

// ---------------------------------------------------------------------------
// Framed-LSP stdout: the SAME byte-level decoder the product worker uses
// (public/workers/lsp-frames.js, spec W1) — a verbatim copy here once drifted
// from the worker's and cost hours (architecture review A1). Bytes reach it
// through a per-byte TTY sink installed right before `--worker` starts; the
// glue's default sink line-buffers, which is why the last frame of a burst
// used to sit in the TTY until the next write (the tickler's reason to exist).
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const { LspFrameDecoder } = globalThis.Qed64LspFrames;
const frames = new LspFrameDecoder({
  onFrame(body) {
    try { onMessage(JSON.parse(body)); } catch { log(`unparseable frame: ${body.slice(0, 80)}`); }
  },
  // Non-frame stdout: zero once the kernel's trace import (spec K3) routes
  // library progress off stdout; gate.mjs asserts `nonFrameStdoutBytes === 0`.
  onJunk(line) { log(`stdout-log: ${line.slice(0, 120)}`); },
});

/** Swap the stdout TTY's ops for a per-byte sink. /dev/stdout is a symlink to
 * /dev/tty (device 5,0); `TTY.stream_ops.write` calls `ops.put_char` once per
 * byte, and pthread writes are proxied to this (main) context first, so the
 * FileWorker's frames land here byte-exact. Same hook as the worker's
 * installStdoutTap; `Module.stdout` is not honoured by this glue. */
function installStdoutTap() {
  const M = globalThis.Module;
  const tty = globalThis.TTY?.ttys?.[M.FS.makedev(5, 0)];
  if (!tty?.ops?.put_char) return finish(false, "stdout tap: TTY for /dev/stdout not in scope");
  const orig = tty.ops;
  tty.ops = { ...orig, put_char(t, val) {
    if (t.output?.length > 0) orig.fsync(t); // a line begun before the tap stays on the line path
    if (val !== null && val !== 0) frames.push(val);
  } };
}

// Pre-tap stdout (snapshot load, Lean init) still arrives as lines via print().
function onStdout(text) {
  if (process.env.RAW_TAP) log(`RAW print: ${JSON.stringify(String(text).slice(0, 90))}`);
  for (const line of String(text).split("\n")) if (line.trim()) log(`stdout-log: ${line.slice(0, 120)}`);
}

function onMessage(msg) {
  if (process.env.DUMP_MSGS) log(`MSG ${msg.method ?? `resp#${msg.id}`}: ${JSON.stringify(msg).slice(0, 160)}`);
  // Server→client REQUESTS (id + method, e.g. workspace/inlayHint/refresh):
  // the reporter awaits the client's answer, and a client that never replies
  // blocks all further diagnostics. vscode-languageclient answers these
  // automatically in the product; a harness must too.
  if (msg.id !== undefined && msg.method !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.id === 1 && msg.result) {
    // The FileWorker consumes initialize without answering (the watchdog's
    // job in a full server) — an answer here would be a surprise, but count it.
    seen.initializeResponse = true;
    return;
  }
  if (msg.method === "$/lean/fileProgress") {
    seen.fileProgressEvents += 1;
    const processing = msg.params?.processing ?? [];
    if (seen.fileProgressEvents > 1 && processing.length === 0) seen.progressDrained = true;
    checkActs(); // the drained progress can land AFTER the last diagnostic
    return;
  }
  if (msg.method === "textDocument/publishDiagnostics") {
    for (const d of msg.params?.diagnostics ?? []) {
      seen.diags.push(String(d.message).slice(0, 120));
      if (/42/.test(String(d.message)) && d.severity >= 3) seen.evalInfo = true;
    }
    checkActs();
  }
}

// Success conditions are evaluated from BOTH the diagnostics and the
// fileProgress handlers: the burst order between them is not fixed.
function checkActs() {
  {
    // Act 1: progress drained AND our deliberate error surfaced.
    if (seen.act === 1 && seen.progressDrained && seen.diags.some((x) => /rfl|43|mismatch|failed/i.test(x))) {
      log(`act-1 diagnostics: ${JSON.stringify(seen.diags)}`);
      if (!ACT2) {
        closeRing();
        setTimeout(() => finish(true, "clean run"), 1500);
        return;
      }
      // Act 2: change the HEADER — the real worker requests restart (exit 2);
      // the keepalive keeps the runtime alive, and a fresh callMain gives a
      // new in-process session against the resident env cache. This is the
      // reboot-killer moment of the whole campaign.
      seen.act = 2;
      log("act 2: header change via didChange (expect IN-PROCESS reprocessing: no exit)");
      // Fresh accounting: act 2 succeeds when the NEW header's session drains
      // again with the deliberate error re-reported.
      seen.progressDrained = false; seen.fileProgressEvents = 0; seen.diags = [];
      seen.act2StartedAt = Date.now();
      send({ jsonrpc: "2.0", method: "textDocument/didChange", params: {
        textDocument: { uri: "file:///workspace/Probe.lean", version: 2 },
        contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          text: "import Init.Data.Queue\n" }] } });
      return;
    }
    if (seen.act === 2 && seen.progressDrained && seen.diags.some((x) => /rfl|43|mismatch|failed/i.test(x))) {
      log(`act-2 (in-process header switch) diagnostics: ${JSON.stringify(seen.diags.slice(-2))} in ${Date.now() - seen.act2StartedAt} ms`);
      closeRing();
      setTimeout(() => finish(true, "act2: in-process header switch clean"), 1500);
    }
    if (seen.act === 2 && seen.fileProgressEvents > 2) {
      // diagnostics for the re-opened session
      seen.act2Diags = seen.diags.length;
    }
  }
}

// ---------------------------------------------------------------------------
// Stdin ring writer (contract org.lean-browser64.resident-transport/v1)
// ---------------------------------------------------------------------------
const CAP = 1 << 20;
let ring = null; // { ctrlPtr, mem }
const IDX = { READ: 0, WRITE: 1, CLOSED: 2, WAKE: 3 };
function views() {
  const mem = globalThis.Module.wasmMemory ?? globalThis.wasmMemory ?? { buffer: globalThis.Module.HEAPU8?.buffer };
  const buf = mem.buffer; // re-take every call: shared-memory growth swaps it
  return {
    ctrl: new Int32Array(buf, ring.ctrlPtr, 4),
    bytes: new Uint8Array(buf, ring.ctrlPtr + 16, CAP),
  };
}
function ringWrite(payload, done) {
  let off = 0;
  const pump = () => {
    const { ctrl, bytes } = views();
    while (off < payload.length) {
      const read = Atomics.load(ctrl, IDX.READ);
      const write = Atomics.load(ctrl, IDX.WRITE);
      const free = (read - write - 1 + CAP) % CAP;
      if (free === 0) { setTimeout(pump, 2); return; } // poll; Node JS thread must not block
      const contiguous = Math.min(free, CAP - write, payload.length - off);
      bytes.set(payload.subarray(off, off + contiguous), write);
      off += contiguous;
      Atomics.store(ctrl, IDX.WRITE, (write + contiguous) % CAP);
      Atomics.add(ctrl, IDX.WAKE, 1);
      Atomics.notify(ctrl, IDX.WAKE);
    }
    done?.();
  };
  pump();
}
function send(obj) {
  const body = enc.encode(JSON.stringify(obj));
  const header = enc.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header, 0); frame.set(body, header.length);
  ringWrite(frame);
}
function closeRing() {
  const { ctrl } = views();
  Atomics.store(ctrl, IDX.CLOSED, 1);
  Atomics.add(ctrl, IDX.WAKE, 1);
  Atomics.notify(ctrl, IDX.WAKE);
  log("ring closed");
}

// ---------------------------------------------------------------------------
// Boot (node-runner's vm pattern), noInitialRun, then ring + callMain
// ---------------------------------------------------------------------------
process.chdir("/");
process.argv[1] = "/bin/lean";
globalThis.Module = {
  noInitialRun: true,
  locateFile: (f) => path.join(path.dirname(leanJs), f),
  mainScriptUrlOrBlob: leanJs,
  print: onStdout,
  printErr: (t) => { if (!/^\s*$/.test(t)) log(`stderr: ${String(t).slice(0, 140)}`); },
  preRun: [function mount() {
    const FS = globalThis.Module.FS;
    const NODEFS = FS.filesystems.NODEFS;
    const mkdirTree = (p) => { let c = ""; for (const part of p.split("/").filter(Boolean)) { c += `/${part}`; try { FS.mkdir(c); } catch { /* exists */ } } };
    for (const dir of ["/lib/lean", "/bin", "/workspace"]) mkdirTree(dir);
    FS.mount(NODEFS, { root: libLean }, "/lib/lean");
    // Under PROXY_TO_PTHREAD the pthread's Node context derives the app path
    // from HOST argv; Lean then stats that host path inside the VFS. Mirror
    // the stage1 tree at its own host path so discovery simply succeeds.
    mkdirTree(artifactDir);
    FS.mount(NODEFS, { root: artifactDir }, artifactDir);
    FS.writeFile("/workspace/Probe.lean", PROBE);
    globalThis.Module.ENV.LEAN_PATH = "/lib/lean";
    // main runs on a pthread under PROXY_TO_PTHREAD; its Node worker context
    // derives the app path from HOST argv, so sysroot discovery would stat a
    // host path inside the VFS. Pin the sysroot instead of discovering it.
    globalThis.Module.ENV.LEAN_SYSROOT = "/";
    FS.chdir("/workspace");
  }],
  onRuntimeInitialized() {
    const M = globalThis.Module;
    // Full Lean initialization before ANY Lean entry point (snapshot-probe's
    // sequence): loading a snapshot on an uninitialized runtime panics.
    M._lean_initialize_runtime_module();
    M._lean_initialize();
    M._lean_io_mark_end_initialization();
    if (M._lean_init_task_manager) M._lean_init_task_manager();
    if (M._lean_enable_initializer_execution) M._lean_enable_initializer_execution();
    const sp = M._lean_init_search_path();
    M._lean_wasm_shell_mark_preinitialized();
    log(`lean initialized (search path tag via ${typeof sp})`);
    // Seed the prebuilt env FIRST: the resident worker's header processing
    // cannot import oleans on its elaboration pthread (the long-documented
    // hang prepareHeader exists for) — a loaded snapshot publishes a
    // covering env (Shell.lean publish line in patch 0031) it finds instead.
    const snapHost = path.join(repoRoot, "work/snapshot/init.snap");
    if (fs.existsSync(snapHost)) {
      const total = fs.statSync(snapHost).size;
      const heapPtrRaw = M._malloc(BigInt(total));
      const heapPtr = typeof heapPtrRaw === "bigint" ? Number(heapPtrRaw) : heapPtrRaw;
      const fd = fs.openSync(snapHost, "r");
      const CH = 64 * 1024 * 1024;
      const b = new Uint8Array(CH);
      let at = 0;
      while (at < total) {
        const n = fs.readSync(fd, b, 0, Math.min(CH, total - at), at);
        const memBuf = (globalThis.Module.wasmMemory ?? globalThis.wasmMemory).buffer;
        new Uint8Array(memBuf, heapPtr + at, n).set(b.subarray(0, n));
        at += n;
      }
      fs.closeSync(fd);
      const lr = M._lean_wasm_load_snapshot_mem(BigInt(heapPtr), BigInt(total), 1n);
      log(`init snapshot loaded (${total} bytes, io tag via ${typeof lr})`);
    } else {
      log("WARNING: work/snapshot/init.snap missing — header will try olean import (known hang)");
    }
    log("runtime initialized — configuring ring");
    const raw = M._malloc(16 + CAP);
    const ptr = typeof raw === "bigint" ? Number(raw) : raw;
    ring = { ctrlPtr: ptr };
    const rawPtr = typeof raw === "bigint" ? raw : BigInt(ptr);
    const status = M._lean_browser64_configure_input_ring(rawPtr, CAP);
    if (status !== 0) return finish(false, `ring rejected: ${status}`);
    log("ring configured — callMain --worker");
    installStdoutTap(); // from here on stdout is frames (plus counted junk), byte by byte
    M.callMain(["--worker", "-Dserver.reportDelayMs=0"]);
    // reportDelayMs=0: the reporter's first IO.sleep on a task pthread never
    // wakes under this emsdk (the pump path's wasmLspInit sets the same).
    setInterval(() => {
      const { ctrl } = views();
      const PT = globalThis.PThread ?? {};
      const cpu = process.cpuUsage();
      log(`ring state read=${Atomics.load(ctrl, 0)} write=${Atomics.load(ctrl, 1)} wake=${Atomics.load(ctrl, 3)}`
        + ` | pthreads=${Object.keys(PT.pthreads ?? {}).length} unused=${(PT.unusedWorkers ?? []).length}`
        + ` | cpuUserTotal=${(cpu.user / 1e6).toFixed(1)}s`);
    }, 5000);
    // callMain returns immediately under PROXY_TO_PTHREAD; drive the session.
    // The FileWorker consumes initialize silently and waits for didOpen —
    // send the whole opening sequence up front (the shim's discovery).
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      processId: null, rootUri: null, capabilities: {} } });
    // NO 'initialized' here: initAndRunWorker reads initialize then didOpen
    // DIRECTLY — anything between them corrupts the opening sequence.
    send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
      textDocument: { uri: "file:///workspace/Probe.lean", languageId: "lean4", version: 1, text: (process.env.PROBE_HEADER ? process.env.PROBE_HEADER + "\n" : "") + PROBE } } });
    // Discriminator experiment (phase-1 blocker): after the reporter goes
    // quiet, send requests that DON'T depend on the reporter. rpc/connect
    // answers immediately through the stdout writer; hover needs a body
    // elaboration snapshot. Their arrival (or not) tells reporter-wedged vs
    // writer-stalled vs elaboration-stuck apart.
    setTimeout(() => {
      log("EXPERIMENT: sending rpc/connect + hover");
      send({ jsonrpc: "2.0", id: 9001, method: "$/lean/rpc/connect", params: { uri: "file:///workspace/Probe.lean" } });
      send({ jsonrpc: "2.0", id: 9002, method: "textDocument/hover", params: {
        textDocument: { uri: "file:///workspace/Probe.lean" }, position: { line: 1, character: 5 } } });
    }, 12000);
    // No tickler: with the per-byte sink nothing can stay stuck in the TTY,
    // so a probe that needs a nudge to see its last frame is a real finding.
  },
  onExit: (code) => {
    log(`main exited code=${code}`);
    if (seen.act === 2 && !seen.exit2) {
      seen.exit2 = true;
      log("worker requested restart — re-callMain in the SAME process");
      setTimeout(() => {
        const M = globalThis.Module;
        const raw = M._malloc(16 + CAP);
        ring = { ctrlPtr: typeof raw === "bigint" ? Number(raw) : raw };
        const st = M._lean_browser64_configure_input_ring(typeof raw === "bigint" ? raw : BigInt(raw), CAP);
        if (st !== 0) return finish(false, `act2 ring rejected: ${st}`);
        M.callMain(["--worker", "-Dserver.reportDelayMs=0"]);
        send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
        send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
          textDocument: { uri: "file:///workspace/Probe.lean", languageId: "lean4", version: 3,
            text: "import Init.Data.Queue\n" + PROBE } } });
        // success when the NEW session drains with our deliberate error again
        const check = setInterval(() => {
          if (seen.progressDrained && seen.diags.some((x) => /rfl|43|mismatch|failed/i.test(x))) {
            clearInterval(check);
            log(`act-2 diagnostics: ${JSON.stringify(seen.diags.slice(-4))}`);
            finish(true, "act2: in-process session replacement clean");
          }
        }, 1000);
        // fresh drain accounting for act 2
        seen.progressDrained = false; seen.fileProgressEvents = 0; seen.diags = [];
      }, 300);
      return;
    }
    if (!finished && code === 0) finish(seen.progressDrained, "exit before assertions");
  },
  onAbort: (what) => finish(false, `ABORT: ${what}`),
};
globalThis.require = createRequire(leanJs);
globalThis.__filename = "/bin/lean.js";
globalThis.__dirname = "/bin";
vm.runInThisContext(fs.readFileSync(leanJs, "utf8"), { filename: leanJs });
