#!/usr/bin/env node
// thread-storm-probe.mjs — browser-free reproduction harness for the "elaborating
// forever" freeze (docs/HARDENING.md #52): drive the REAL resident FileWorker of
// the served runtime through the stdin ring with an edit/request/cancel storm
// that maximises Lean task-manager thread churn, and diagnose a freeze when one
// happens.
//
// One cycle (the shape of the consumer's C20 test, generalised):
//   1. full-text didChange (a "reset"), then a burst of the requests an editor +
//      InfoView send for a cursor (hover, plainGoal, codeAction, documentHighlight,
//      semanticTokens, documentSymbol, foldingRange, inlayHint, RPC goals/diags/
//      widgets);
//   2. after a jitter, a second didChange that appends an `example … := by decide`
//      (the MakeEditLink click), a `$/cancelRequest` for every request still in
//      flight, and the request burst again for the new version;
//   3. wait until `$/lean/fileProgress` drains at the newest version.
// FREEZE = no server frame for --hang-ms while work is outstanding. On a freeze
// the probe dumps the runtime state and then tries, in order, recovery probes
// that discriminate the lost wakeup: (1) a stdin-ring kick, (2) the wasm
// `_emscripten_check_mailbox` on the main runtime thread (pending-but-unnoticed
// main-thread mailbox), (3) the glue's `checkMailbox()` (re-arm + process),
// (4) a `checkMailbox` message to every pthread Worker. The first probe after
// which server frames resume names the mechanism.
//
//
// Mailbox experiments (the worker's fix, lean.worker.js `useMessageMailbox` +
// the liveness tick's mailbox kick, measured here without a browser):
//   --message-mailbox   main-thread mailbox notifications by postMessage (the
//                       glue's own non-waitAsync mode) instead of the single
//                       re-armed Atomics.waitAsync waiter;
//   --kick-ms <ms>      serve the main-thread mailbox directly every <ms> (the
//                       liveness tick); counts the kicks that served a proxied
//                       call no notification had delivered ("rescues");
//   --drop-notify <p>   FAULT INJECTION: drop each notification-driven main
//                       mailbox check with probability p (a lost wakeup).
//
//   node --stack-size=8192 pipeline/snapshot/thread-storm-probe.mjs [--minutes 20]
//     [--hang-ms 30000] [--seed 1] [--mathlib] [--artifact <stage1>] [--lib <tree>]
//     [--burst 1] [--cancel-all] [--min-free-gb 8] [--json <out.json>]
//     [--message-mailbox] [--kick-ms 1000] [--drop-notify 0.001]
// exit 0 = no freeze within the budget, 1 = freeze reproduced, 2 = setup error, 3 = host rule.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import "../../public/workers/lsp-frames.js"; // globalThis.Qed64LspFrames

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (f) => process.argv.includes(`--${f}`);
const artifactDir = path.resolve(arg("artifact", path.join(repoRoot, "pipeline/toolchain/work/build/stage1")));
const libLean = path.resolve(arg("lib", has("mathlib") ? path.join(repoRoot, "work/lib-tree-slim") : path.join(artifactDir, "lib/lean")));
const snapDir = path.resolve(arg("snap-dir", path.join(repoRoot, "work/snapshot")));
const MINUTES = Number(arg("minutes", "20"));
const HANG_MS = Number(arg("hang-ms", "30000"));
const BURST = Number(arg("burst", "1")); // request bursts per version
const MIN_FREE_GB = Number(arg("min-free-gb", "8"));
const JSON_OUT = arg("json", "") && path.resolve(process.cwd(), arg("json", ""));
const MESSAGE_MAILBOX = has("message-mailbox");
const KICK_MS = Number(arg("kick-ms", "0"));
const DROP_NOTIFY = Number(arg("drop-notify", "0"));
const leanJs = path.join(artifactDir, "bin/lean.js");
if (!fs.existsSync(leanJs)) { console.error(`error: ${leanJs} not found`); process.exit(2); }

const t0 = Date.now();
const log = (s) => console.log(`[storm +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

// ---------- host rules (shared 36 GB host) ----------
function freeInactiveGB() {
  const t = execFileSync("/usr/bin/vm_stat").toString();
  const page = Number(/page size of (\d+) bytes/.exec(t)[1]);
  const get = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(t)?.[1] ?? 0);
  return ((get("Pages free") + get("Pages inactive")) * page) / 1e9;
}
const free0 = freeInactiveGB();
if (free0 < MIN_FREE_GB) { console.error(`refusing: free+inactive ${free0.toFixed(1)} GB < ${MIN_FREE_GB} GB`); process.exit(3); }

// ---------- deterministic randomness ----------
let seed = Number(arg("seed", "1")) >>> 0 || 1;
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

// ---------- the document ----------
const URI = "file:///workspace/Probe.lean";
const HEADER = has("mathlib") ? "import Mathlib.Basic.Real.Basic" : "import Init";
const BASE = [
  HEADER,
  "",
  "def f (n : Nat) : Nat := n + 1",
  "theorem t1 : f 2 = 3 := by decide",
  "example : (List.range 30).length = 30 := by decide",
  "example (a b : Nat) : a + b = b + a := by omega",
  "theorem t2 (n : Nat) : f n > n := by unfold f; omega",
  "example : (12 : Nat) ∣ 132 := by decide",
  "def g : List Nat → Nat",
  "  | [] => 0",
  "  | x :: xs => x + g xs",
  "example : g [1, 2, 3] = 6 := by decide",
  "#eval g [1, 2, 3, 4]",
  "example : True := by trivial",
  "",
].join("\n");
const EXTRA = [
  "example : (3 : Nat) + 4 = 7 := by decide",
  "example : [1, 2] ++ [3] = [1, 2, 3] := by decide",
  "example : (100 : Nat) % 7 = 2 := by decide",
  "example : ¬ (5 : Nat) = 6 := by decide",
];
const lines = (t) => t.split("\n").length;

// ---------- result / state ----------
const st = {
  version: 1, doc: BASE, nextId: 100, pending: new Map(), // id -> {method, sentAt, version}
  progress: { version: 0, processing: -1 }, lastFrameAt: Date.now(), frames: 0, responses: 0, cancelled: 0,
  cycles: 0, edits: 0, spawns: 0, cleanups: 0, checkMailboxCalls: 0, rpcSession: null, errors: [],
  droppedNotifications: 0, kicks: 0, kicksServing: 0, rescues: 0, checksAtLastKick: 0,
  drainMs: [], freeze: null, poolMax: 0,
};
const result = () => ({
  ok: !st.freeze, minutes: MINUTES, header: HEADER, seed: Number(arg("seed", "1")),
  wallMs: Date.now() - t0, cycles: st.cycles, edits: st.edits, frames: st.frames, responses: st.responses,
  cancelledReplies: st.cancelled, spawns: st.spawns, cleanups: st.cleanups, checkMailboxCalls: st.checkMailboxCalls,
  mailbox: { mode: MESSAGE_MAILBOX ? "message" : "waitAsync", kickMs: KICK_MS, dropNotify: DROP_NOTIFY,
    droppedNotifications: st.droppedNotifications, kicks: st.kicks, kicksServing: st.kicksServing, rescues: st.rescues },
  poolMax: st.poolMax, drainMsMedian: median(st.drainMs), drainMsP95: pct(st.drainMs, 0.95),
  errors: st.errors.slice(0, 20), freeze: st.freeze,
});
const median = (a) => pct(a, 0.5);
function pct(a, p) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }
function finish(code, why) {
  const r = { ...result(), why };
  log(`STORM ${code === 0 ? "CLEAN" : code === 1 ? "FREEZE" : "ERROR"} ${JSON.stringify(r)}`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(r, null, 2));
  process.exit(code);
}
process.on("unhandledRejection", (e) => { st.errors.push(`unhandledRejection: ${String(e?.stack ?? e).slice(0, 300)}`); log(`UNHANDLED REJECTION ${String(e?.stack ?? e).slice(0, 300)}`); });
process.on("uncaughtException", (e) => { st.errors.push(`uncaughtException: ${String(e?.stack ?? e).slice(0, 300)}`); log(`UNCAUGHT ${String(e?.stack ?? e).slice(0, 300)}`); });

// ---------- framed stdout ----------
const enc = new TextEncoder();
const { LspFrameDecoder } = globalThis.Qed64LspFrames;
const frames = new LspFrameDecoder({
  onFrame(body) { let m; try { m = JSON.parse(body); } catch { log(`unparseable frame ${body.slice(0, 80)}`); return; } onMessage(m); },
  onJunk(line) { if (line.trim()) log(`stdout junk: ${line.slice(0, 120)}`); },
});
function installStdoutTap() {
  const M = globalThis.Module;
  const tty = globalThis.TTY?.ttys?.[M.FS.makedev(5, 0)];
  if (!tty?.ops?.put_char) finish(2, "stdout tap: TTY for /dev/stdout not in scope");
  const orig = tty.ops;
  tty.ops = { ...orig, put_char(t, val) { if (t.output?.length > 0) orig.fsync(t); if (val !== null) frames.push(val); } };
}

// ---------- ring ----------
const CAP = 64 << 20;
let ring = null;
const IDX = { READ: 0, WRITE: 1, CLOSED: 2, WAKE: 3 };
function views() {
  const buf = (globalThis.Module.wasmMemory ?? globalThis.wasmMemory).buffer;
  return { ctrl: new Int32Array(buf, ring.ctrlPtr, 4), bytes: new Uint8Array(buf, ring.ctrlPtr + 16, CAP) };
}
const queue = []; let pumping = false;
function pump() {
  pumping = true;
  const { ctrl, bytes } = views();
  while (queue.length) {
    const item = queue[0];
    while (item.off < item.buf.length) {
      const read = Atomics.load(ctrl, IDX.READ), write = Atomics.load(ctrl, IDX.WRITE);
      const free = (read - write - 1 + CAP) % CAP;
      if (free === 0) { setTimeout(pump, 2); return; }
      const n = Math.min(free, CAP - write, item.buf.length - item.off);
      bytes.set(item.buf.subarray(item.off, item.off + n), write);
      item.off += n;
      Atomics.store(ctrl, IDX.WRITE, (write + n) % CAP);
      Atomics.add(ctrl, IDX.WAKE, 1);
      Atomics.notify(ctrl, IDX.WAKE);
    }
    queue.shift();
  }
  pumping = false;
}
function send(obj) {
  const body = enc.encode(JSON.stringify(obj));
  const header = enc.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const buf = new Uint8Array(header.length + body.length);
  buf.set(header, 0); buf.set(body, header.length);
  queue.push({ buf, off: 0 });
  if (!pumping) pump();
}
function request(method, params) {
  const id = st.nextId++;
  st.pending.set(id, { method, sentAt: Date.now(), version: st.version });
  send({ jsonrpc: "2.0", id, method, params });
  return id;
}

// ---------- server messages ----------
function onMessage(msg) {
  st.frames += 1; st.lastFrameAt = Date.now();
  if (st.freeze && !st.freeze.resumedAfter) { st.freeze.resumedAfter = st.freeze.probe ?? "spontaneous"; st.freeze.resumedAtMs = Date.now() - st.freeze.atMs; log(`FRAMES RESUMED after probe '${st.freeze.resumedAfter}' (${msg.method ?? `resp#${msg.id}`})`); }
  if (msg.id !== undefined && msg.method !== undefined) { send({ jsonrpc: "2.0", id: msg.id, result: null }); return; } // workspace/*/refresh
  if (msg.id !== undefined) {
    const p = st.pending.get(msg.id); st.pending.delete(msg.id); st.responses += 1;
    if (msg.error?.code === -32800) st.cancelled += 1;
    if (p?.method === "$/lean/rpc/connect" && msg.result?.sessionId) st.rpcSession = msg.result.sessionId;
    return;
  }
  if (msg.method === "$/lean/fileProgress") {
    st.progress = { version: msg.params?.textDocument?.version ?? 0, processing: (msg.params?.processing ?? []).length };
  }
}

// ---------- the storm ----------
function didChange(text) {
  st.version += 1; st.doc = text; st.edits += 1;
  send({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: URI, version: st.version }, contentChanges: [{ text }] } });
}
function burst() {
  const td = { uri: URI };
  const L = lines(st.doc);
  const pos = () => ({ line: between(2, Math.max(2, L - 2)), character: between(0, 12) });
  const p = pos();
  request("textDocument/hover", { textDocument: td, position: p });
  request("$/lean/plainGoal", { textDocument: td, position: p });
  request("$/lean/plainTermGoal", { textDocument: td, position: p });
  request("textDocument/documentHighlight", { textDocument: td, position: p });
  request("textDocument/codeAction", { textDocument: td, range: { start: p, end: p }, context: { diagnostics: [] } });
  request("textDocument/semanticTokens/full", { textDocument: td });
  request("textDocument/documentSymbol", { textDocument: td });
  request("textDocument/foldingRange", { textDocument: td });
  request("textDocument/inlayHint", { textDocument: td, range: { start: { line: 0, character: 0 }, end: { line: L, character: 0 } } });
  if (st.rpcSession) {
    for (const method of ["Lean.Widget.getInteractiveGoals", "Lean.Widget.getInteractiveTermGoal", "Lean.Widget.getWidgets"]) {
      request("$/lean/rpc/call", { textDocument: td, position: p, sessionId: st.rpcSession, method, params: { textDocument: td, position: p } });
    }
    request("$/lean/rpc/call", { textDocument: td, position: p, sessionId: st.rpcSession, method: "Lean.Widget.getInteractiveDiagnostics", params: { lineRange: { start: 0, end: L } } });
  }
}
function cancelInFlight(all) {
  for (const [id, r] of st.pending) {
    if (r.method === "$/lean/rpc/connect") continue;
    if (all || rnd() < 0.6) send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDrained(version, budgetMs) {
  const s = Date.now();
  while (Date.now() - s < budgetMs) {
    if (st.progress.version >= version && st.progress.processing === 0) return Date.now() - s;
    if (Date.now() - st.lastFrameAt > HANG_MS && (st.pending.size > 0 || st.progress.version < version)) return -1;
    await sleep(20);
  }
  return -2;
}
async function storm() {
  const deadline = t0 + MINUTES * 60_000;
  st.storming = true;
  let extra = 0;
  st.rpcSessionAsked = request("$/lean/rpc/connect", { uri: URI });
  let lastKeepAlive = Date.now();
  while (Date.now() < deadline) {
    // reset
    didChange(BASE);
    for (let b = 0; b < BURST; b++) burst();
    await sleep(between(0, 400));
    // click: an edit that inserts an example, cancel in flight, ask again
    extra = (extra + 1) % EXTRA.length;
    didChange(BASE + EXTRA[extra] + "\n");
    cancelInFlight(has("cancel-all"));
    for (let b = 0; b < BURST; b++) burst();
    if (st.rpcSession && Date.now() - lastKeepAlive > 10_000) { send({ jsonrpc: "2.0", method: "$/lean/rpc/keepAlive", params: { uri: URI, sessionId: st.rpcSession } }); lastKeepAlive = Date.now(); }
    const ms = await waitDrained(st.version, HANG_MS * 4);
    if (ms === -1 || ms === -2) return freeze(ms === -1 ? "no server frame" : "not drained");
    st.drainMs.push(ms); st.cycles += 1;
    // let requests answered after the drain land; drop stale bookkeeping
    for (const [id, r] of st.pending) if (Date.now() - r.sentAt > 60_000) st.pending.delete(id);
    if (st.cycles % 25 === 0) {
      const PT = globalThis.PThread ?? {};
      const free = freeInactiveGB();
      log(`cycle ${st.cycles}: edits ${st.edits} frames ${st.frames} spawns ${st.spawns} cleanups ${st.cleanups} pool ${(PT.unusedWorkers ?? []).length}/${Object.keys(PT.pthreads ?? {}).length} drain median ${median(st.drainMs.slice(-25))} ms${KICK_MS || DROP_NOTIFY ? ` | dropped ${st.droppedNotifications} kicks ${st.kicks} serving ${st.kicksServing} rescues ${st.rescues}` : ""} | free ${free.toFixed(1)} GB rss ${(process.memoryUsage().rss / 1e9).toFixed(1)} GB`);
      if (free < 3) finish(3, `free+inactive fell to ${free.toFixed(1)} GB`);
    }
    await sleep(between(0, 150));
  }
  finish(0, "budget reached without a freeze");
}

// ---------- freeze diagnosis ----------
function mainThreadWords() {
  const M = globalThis.Module;
  const self = Number(globalThis._pthread_self());
  const H = new Int32Array((M.wasmMemory ?? globalThis.wasmMemory).buffer);
  return { mainPthread: self, selfWord: H[self / 4], waitingAsync: H[(self + 204) / 4] };
}
async function freeze(kind) {
  const PT = globalThis.PThread ?? {};
  const { ctrl } = views();
  st.freeze = {
    kind, atMs: Date.now(), version: st.version, progress: st.progress, msSinceLastFrame: Date.now() - st.lastFrameAt,
    pending: [...st.pending.values()].slice(0, 20).map((r) => `${r.method}@v${r.version} ${Date.now() - r.sentAt}ms`),
    ring: { read: Atomics.load(ctrl, IDX.READ), write: Atomics.load(ctrl, IDX.WRITE), wake: Atomics.load(ctrl, IDX.WAKE), queued: queue.length },
    pool: { unused: (PT.unusedWorkers ?? []).length, running: Object.keys(PT.pthreads ?? {}).length },
    spawns: st.spawns, cleanups: st.cleanups, checkMailboxCalls: st.checkMailboxCalls, main: mainThreadWords(),
    cpuUserS: process.cpuUsage().user / 1e6, probe: null, resumedAfter: null,
  };
  log(`FREEZE (${kind}) ${JSON.stringify(st.freeze)}`);
  const watch = async (name, fn) => {
    if (st.freeze.resumedAfter) return;
    st.freeze.probe = name; const before = st.frames;
    log(`probe: ${name}`);
    try { fn(); } catch (e) { log(`probe ${name} threw ${e}`); }
    await sleep(10_000);
    log(`probe ${name}: ${st.frames - before} frame(s) in 10 s; checkMailbox calls now ${st.checkMailboxCalls}`);
  };
  await sleep(5_000); // a late frame means it was slow, not frozen
  if (st.frames > 0 && Date.now() - st.lastFrameAt < 5_000) { st.freeze.resumedAfter = "spontaneous"; }
  await watch("ring-kick", () => { send({ jsonrpc: "2.0", method: "$/lean/rpc/keepAlive", params: { uri: URI, sessionId: st.rpcSession ?? "0" } }); });
  await watch("wasm-check-mailbox", () => { globalThis.__emscripten_check_mailbox(); });
  await watch("js-checkMailbox", () => { globalThis.checkMailbox(); });
  await watch("pthread-mailboxes", () => { for (const w of Object.values(PT.pthreads ?? {})) w.postMessage({ cmd: 4 }); });
  st.freeze.after = { pool: { unused: (PT.unusedWorkers ?? []).length, running: Object.keys(PT.pthreads ?? {}).length }, main: mainThreadWords(), cpuUserS: process.cpuUsage().user / 1e6 };
  finish(1, `freeze reproduced (${kind}); resumed after: ${st.freeze.resumedAfter ?? "nothing"}`);
}

// ---------- the mailbox kick (lean.worker.js liveness tick, same calls) ----------
// `proxiedJSCallArgs` is the glue's scratch array, reset by every proxied JS
// call the main thread serves: a sentinel left in it says the kick served none.
const SENTINEL = Symbol("kick");
function kick() {
  if (st.freeze || !st.storming) return;
  const scratch = Array.isArray(globalThis.proxiedJSCallArgs) ? globalThis.proxiedJSCallArgs : null;
  if (scratch) { scratch.length = 0; scratch.push(SENTINEL); }
  globalThis.__emscripten_check_mailbox();
  st.kicks += 1;
  const served = scratch !== null && !(scratch.length === 1 && scratch[0] === SENTINEL);
  if (served) {
    st.kicksServing += 1;
    // No notification-driven check since the previous kick, yet work was
    // waiting: a stalled notification path — or, rarely, a notification still
    // in flight (lean.worker.js confirms its rescues; this probe only counts
    // candidates, which is exact under --drop-notify where the drops dominate).
    if (st.checkMailboxCalls === st.checksAtLastKick) st.rescues += 1;
  }
  st.checksAtLastKick = st.checkMailboxCalls;
}

// ---------- boot ----------
process.chdir("/");
process.argv[1] = "/bin/lean";
globalThis.Module = {
  noInitialRun: true,
  locateFile: (f) => path.join(path.dirname(leanJs), f),
  mainScriptUrlOrBlob: leanJs,
  print: (t) => { for (const line of String(t).split("\n")) if (line.trim()) log(`stdout: ${line.slice(0, 120)}`); },
  printErr: (t) => {
    const s = String(t);
    if (/^\s*$/.test(s) || /^\[DEBUG:PROGRESS\]/.test(s)) return;
    if (/worker sent an error|RuntimeError|Aborted|PANIC|exception/i.test(s)) { st.errors.push(s.slice(0, 300)); log(`STDERR! ${s.slice(0, 300)}`); }
    else if (has("stderr")) log(`stderr: ${s.slice(0, 160)}`);
  },
  preRun: [function mailboxMode() {
    // Before initRuntime: the main thread's mailbox init (a static
    // constructor) arms the first waiter, reading this flag.
    if (!MESSAGE_MAILBOX) return;
    if (typeof globalThis.waitAsyncPolyfilled !== "boolean") finish(2, "glue global waitAsyncPolyfilled not found");
    globalThis.waitAsyncPolyfilled = true;
  }, function mount() {
    const FS = globalThis.Module.FS;
    const mk = (p) => { let c = ""; for (const part of p.split("/").filter(Boolean)) { c += `/${part}`; try { FS.mkdir(c); } catch { /* exists */ } } };
    for (const d of ["/lib/lean", "/workspace"]) mk(d);
    FS.mount(FS.filesystems.NODEFS, { root: libLean }, "/lib/lean");
    mk(artifactDir); FS.mount(FS.filesystems.NODEFS, { root: artifactDir }, artifactDir);
    FS.writeFile("/workspace/Probe.lean", BASE);
    globalThis.Module.ENV.LEAN_PATH = "/lib/lean";
    globalThis.Module.ENV.LEAN_SYSROOT = "/";
    FS.chdir("/workspace");
  }],
  onRuntimeInitialized() {
    const M = globalThis.Module;
    // Count every pthread spawn / return and every main-thread mailbox check.
    // The glue is a classic script: its top-level vars are globals, looked up
    // at call time, so wrapping them here instruments the real code paths.
    for (const [name, key] of [["spawnThread", "spawns"], ["cleanupThread", "cleanups"], ["checkMailbox", "checkMailboxCalls"]]) {
      const orig = globalThis[name];
      if (typeof orig !== "function") finish(2, `glue global ${name} not found`);
      const drop = name === "checkMailbox" && DROP_NOTIFY > 0;
      globalThis[name] = function (...a) {
        // FAULT INJECTION: a lost wakeup. In waitAsync mode the dropped
        // resolution also never re-arms the waiter (the chain is dead); in
        // message mode the mailbox stays PENDING, so no sender notifies again.
        // Only once the storm runs: boot is not the path under test.
        if (drop && st.storming && !st.freeze && rnd() < DROP_NOTIFY) { st.droppedNotifications += 1; return; }
        st[key] += 1; return orig.apply(this, a);
      };
    }
    if (KICK_MS > 0) setInterval(kick, KICK_MS).unref();
    M._lean_initialize_runtime_module();
    M._lean_initialize();
    M._lean_io_mark_end_initialization();
    if (M._lean_init_task_manager) M._lean_init_task_manager();
    if (M._lean_enable_initializer_execution) M._lean_enable_initializer_execution();
    M._lean_init_search_path();
    M._lean_wasm_shell_mark_preinitialized();
    for (const name of has("mathlib") ? ["init", "mathlib"] : ["init"]) {
      const host = path.join(snapDir, `${name}.snap`);
      if (!fs.existsSync(host)) finish(2, `missing ${host}`);
      const total = fs.statSync(host).size;
      const raw = M._malloc(BigInt(total)); const ptr = Number(raw);
      const fd = fs.openSync(host, "r"); const CH = 64 << 20; const b = new Uint8Array(CH); let at = 0;
      while (at < total) { const n = fs.readSync(fd, b, 0, Math.min(CH, total - at), at); new Uint8Array((M.wasmMemory ?? globalThis.wasmMemory).buffer, ptr + at, n).set(b.subarray(0, n)); at += n; }
      fs.closeSync(fd);
      M._lean_wasm_load_snapshot_mem(BigInt(ptr), BigInt(total), 1n);
      log(`${name} snapshot loaded (${(total / 1e6).toFixed(0)} MB)`);
    }
    const raw = M._malloc(BigInt(16 + CAP)); ring = { ctrlPtr: Number(raw) };
    if (M._lean_browser64_configure_input_ring(BigInt(ring.ctrlPtr), CAP) !== 0) finish(2, "ring rejected");
    installStdoutTap();
    M.callMain(["--worker", "-Dserver.reportDelayMs=0"]);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
    send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: URI, languageId: "lean4", version: 1, text: BASE } } });
    setInterval(() => { const PT = globalThis.PThread ?? {}; st.poolMax = Math.max(st.poolMax, (PT.unusedWorkers ?? []).length + Object.keys(PT.pthreads ?? {}).length); }, 500).unref();
    (async () => {
      const ms = await waitDrained(1, 180_000);
      if (ms < 0) return freeze("first drain");
      log(`opened and drained (${ms} ms); storm for ${MINUTES} min, hang threshold ${HANG_MS} ms, free ${free0.toFixed(1)} GB`);
      await storm();
    })();
  },
  onExit: (code) => { log(`main exited code=${code}`); finish(2, `worker exited ${code}`); },
  onAbort: (what) => { st.errors.push(`abort: ${what}`); finish(2, `ABORT: ${what}`); },
};
globalThis.require = createRequire(leanJs);
globalThis.__filename = "/bin/lean.js";
globalThis.__dirname = "/bin";
vm.runInThisContext(fs.readFileSync(leanJs, "utf8"), { filename: leanJs });
