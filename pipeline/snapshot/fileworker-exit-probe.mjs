#!/usr/bin/env node
// fileworker-exit-probe.mjs — browser-free proof that a resident FileWorker
// exit is a precise, immediate `died` reason "exit" (docs/HARDENING.md #52, the exit hook).
//
// It runs the REAL public/workers/lean.worker.js under Node in the glue's own
// global scope — exactly the browser's arrangement, where the worker
// importScripts() the classic-script glue into its global — and drives it with
// the page's protocol: `boot` → `loadSnapshot` (init) → `lsp-arm` → `lsp`
// initialize/didOpen. Only the network is stubbed (`materialize` and `fetch`
// read the local stage1 artifact and init snapshot). Everything the exit path
// touches is the shipped code: the preRun mailbox instrumentation and exit
// hook, the runtime keepalive push, the front door, residentOpenLoop, die().
//
// Scenarios (one per process: the glue evaluates once per global):
//   eval-exit      page didChange with `#eval (IO.Process.exit 3 : IO Unit)`:
//                  the user-reachable exit. C exit() is the glue's `exit`
//                  import (exitJS), which on a pthread proxies
//                  exitOnMainThread (table [1], async) → expect code 3.
//   exit           raw `exit` notification into the ring: the main loop
//                  returns, workerMain calls IO.Process.forceExit 0 → _Exit →
//                  proc_exit, proxied as _proc_exit (table [0], SYNC) → code 0.
//                  (Not page-reachable: the front door never forwards `exit`.)
//   shutdown-exit  raw `shutdown` request (no params) then `exit`: the
//                  FileWorker's main loop has no case for a param-less request
//                  ("Got invalid JSON-RPC message"), so it dies of the
//                  shutdown with forceExit 1 → [0], code 1.
//   batch-eval-exit  a batch `compile` of the #eval before any arm: what the
//                  non-resident path does with an exit (informational).
//
//   --no-hook      restore the glue's original table entries after the
//                  worker's preRun (the behaviour before the exit hook): the control that
//                  shows the silent stall. With --edit-after-idle the probe
//                  then edits and waits for the liveness layer's verdict.
//
//   node --stack-size=8192 pipeline/snapshot/fileworker-exit-probe.mjs --scenario exit
//     [--no-hook] [--idle-ms 20000] [--edit-after-idle] [--json <out.json>]
//     [--artifact <stage1>] [--lib <tree>] [--snap <init.snap>]
//     [--min-free-gb 14] [--wait-slot-s 1800]
// Prints `EXIT-PROBE {json}` last. exit 0 = the scenario's expectation held,
// 1 = it did not, 2 = setup error, 3 = host rule (no slot within the wait).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (f) => process.argv.includes(`--${f}`);
const SCENARIOS = {
  "eval-exit": { code: 3, via: 1 },
  exit: { code: 0, via: 0 },
  "shutdown-exit": { code: 1, via: 0 },
  "batch-eval-exit": { code: 3, via: null },
};
const SCENARIO = arg("scenario", "exit");
if (!SCENARIOS[SCENARIO]) { console.error(`unknown --scenario ${SCENARIO} (${Object.keys(SCENARIOS).join(", ")})`); process.exit(2); }
const HOOK = !has("no-hook");
const IDLE_MS = Number(arg("idle-ms", "20000"));
const EDIT_AFTER_IDLE = has("edit-after-idle");
const POST_DEATH_MS = Number(arg("post-death-ms", "5000"));
const MIN_FREE_GB = Number(arg("min-free-gb", "14"));
const WAIT_SLOT_S = Number(arg("wait-slot-s", "1800"));
const JSON_OUT = arg("json", "") && path.resolve(process.cwd(), arg("json", ""));
const artifactDir = path.resolve(arg("artifact", path.join(repoRoot, "pipeline/toolchain/work/build/stage1")));
const libLean = path.resolve(arg("lib", path.join(artifactDir, "lib/lean")));
const snapPath = path.resolve(arg("snap", path.join(repoRoot, "work/snapshot/init.snap")));
const leanJs = path.join(artifactDir, "bin/lean.js");
const leanWasm = path.join(artifactDir, "bin/lean.wasm");
const workersDir = path.join(repoRoot, "public/workers");

const t0 = Date.now();
const log = (s) => console.log(`[exit-probe +${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const f of [leanJs, leanWasm, snapPath]) if (!fs.existsSync(f)) { console.error(`error: ${f} not found`); process.exit(2); }

// ---------- host rules (shared 36 GB host) ----------
// One heavy wasm process at a time: wait while a browser, a node-runner, or
// another `node --stack-size=8192` probe runs, or reclaimable memory is low.
function freeInactiveGB() {
  const t = execFileSync("/usr/bin/vm_stat").toString();
  const page = Number(/page size of (\d+) bytes/.exec(t)[1]);
  const get = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(t)?.[1] ?? 0);
  return ((get("Pages free") + get("Pages inactive")) * page) / 1e9;
}
// This process and its ancestors are not peers: the shell that launched the
// probe carries the same `node --stack-size=8192` in its command line.
const self_ = new Set();
for (let pid = process.pid; pid > 1 && !self_.has(pid);) {
  self_.add(pid);
  try { pid = Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)]).toString().trim()); } catch { break; }
}
function heavyPeers() {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,command="]).toString().split("\n");
  return rows.map((r) => r.trim()).filter((r) => {
    const [pid] = r.split(/\s+/, 1);
    if (!pid || self_.has(Number(pid))) return false;
    return /chrome-headless-shell|node-runner\.mjs|\bnode\b.*--stack-size=8192/.test(r);
  }).map((r) => r.slice(0, 140));
}
async function waitForSlot() {
  const deadline = Date.now() + WAIT_SLOT_S * 1000;
  let said = "";
  for (;;) {
    const peers = heavyPeers();
    const free = freeInactiveGB();
    if (peers.length === 0 && free >= MIN_FREE_GB) {
      await sleep(1000 + Math.floor(Math.random() * 2000)); // two waiters freed at once: re-check after a jitter
      if (heavyPeers().length === 0) return free;
      continue;
    }
    const why = peers.length ? `heavy peer running: ${peers[0]}` : `free+inactive ${free.toFixed(1)} GB < ${MIN_FREE_GB} GB`;
    if (why !== said) { log(`waiting for the heavy slot — ${why}`); said = why; }
    if (Date.now() > deadline) { console.error(`refusing: no heavy slot within ${WAIT_SLOT_S} s (${why})`); process.exit(3); }
    await sleep(5000);
  }
}

// ---------- the worker's global scope ----------
// The glue is a classic script: its top-level vars and functions become
// properties of this global (`proxiedFunctionTable`, `_proc_exit`, ...), the
// worker's `self.*` reads see them, and the worker's own top-level bindings
// are reachable by name from runInThisContext — the probe reads them there.
const events = []; // every message the worker posted: { t, msg }
const waiters = new Map(); // requestId -> { resolve }
const listeners = { message: [], unhandledrejection: [] };
const st = { triggeredAt: 0, died: [], progress: { version: 0, processing: -1 }, diags: [], logsAfterDeath: [], uncaught: [] };
const QUIET_LOG = /^\s*$|^\[DEBUG:PROGRESS\]|^\[WASM INIT\]/;

globalThis.self = globalThis;
// A dedicated worker's `self.location`: the worker refuses a snapshot URL off
// its origin (HARDENING #57), so the stubbed snapshot is a path on this one.
// The glue never reads it here (`__filename` names its script first).
globalThis.location = new URL("http://qed64-probe.localhost/workers/lean.worker.js");
globalThis.postMessage = (msg) => {
  const t = Date.now();
  events.push({ t, msg });
  if (msg.type === "ready" || msg.type === "result" || msg.type === "error") {
    const w = waiters.get(msg.requestId);
    if (w) { waiters.delete(msg.requestId); w.resolve(msg); }
    if (msg.type === "error") log(`worker error reply (${msg.requestId}): ${msg.error?.code} ${msg.error?.message}`);
    return;
  }
  if (msg.type !== "event") return;
  if (msg.kind === "died") {
    st.died.push({ t, code: msg.code, reason: msg.reason, mode: msg.mode, message: msg.message });
    log(`DIED ${JSON.stringify({ code: msg.code, reason: msg.reason, mode: msg.mode, message: msg.message })}${st.triggeredAt ? ` ${t - st.triggeredAt} ms after the trigger` : ""}`);
  } else if (msg.kind === "log") {
    const text = String(msg.text ?? "");
    if (st.died.length) st.logsAfterDeath.push(text.slice(0, 200));
    if (!QUIET_LOG.test(text)) log(`worker ${msg.stream}: ${text.slice(0, 220)}`);
  } else if (msg.kind === "lsp") {
    const m = msg.msg;
    if (m.method === "$/lean/fileProgress") {
      st.progress = { version: m.params?.textDocument?.version ?? 0, processing: (m.params?.processing ?? []).length };
    } else if (m.method === "textDocument/publishDiagnostics") {
      st.diags = (m.params?.diagnostics ?? []).map((d) => d.message.slice(0, 120));
    }
  }
};
globalThis.addEventListener = (type, fn) => (listeners[type] ??= []).push(fn);
globalThis.close = () => {};
process.on("unhandledRejection", (reason) => {
  st.uncaught.push(`unhandledRejection: ${String(reason?.stack ?? reason).slice(0, 200)}`);
  for (const fn of listeners.unhandledrejection) fn({ reason, preventDefault() {} });
});
process.on("uncaughtException", (e) => { st.uncaught.push(`uncaughtException: ${String(e?.stack ?? e).slice(0, 300)}`); log(`UNCAUGHT ${String(e?.stack ?? e).slice(0, 300)}`); });

const harness = { proxiedExits: [], onExitCalls: [], hookInstalled: null };
globalThis.importScripts = (...urls) => {
  for (const url of urls) {
    const file = path.isAbsolute(url) ? url : path.join(workersDir, url);
    if (file === leanJs) prepareGlue();
    vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
  }
};

/** Just before boot evaluates the glue: Node-side globals the glue reads,
 * and one preRun after the worker's own two (its mailbox instrumentation and
 * mounts): the library tree, and the table entries this probe observes. */
function prepareGlue() {
  globalThis.require = createRequire(leanJs);
  globalThis.__filename = "/bin/lean.js";
  globalThis.__dirname = "/bin";
  const M = globalThis.Module;
  const workerOnExit = M.onExit;
  M.onExit = (code) => { harness.onExitCalls.push({ t: Date.now(), code }); return workerOnExit(code); };
  M.preRun.push(function exitProbe() {
    const FS = globalThis.Module.FS;
    FS.mount(FS.filesystems.NODEFS, { root: libLean }, "/lib/lean");
    // `lean --worker` stats its own executable's directory at startup (the
    // glue reports the stage1 path); without it main dies at once with
    // forceExit 1 — which the hook reports, but it is not the scenario.
    let dir = "";
    for (const part of artifactDir.split("/").filter(Boolean)) { dir += `/${part}`; try { FS.mkdir(dir); } catch { /* exists */ } }
    FS.mount(FS.filesystems.NODEFS, { root: artifactDir }, artifactDir);
    const T = globalThis.proxiedFunctionTable;
    const originals = [globalThis._proc_exit, globalThis.exitOnMainThread];
    harness.hookInstalled = T[0] !== originals[0] && T[1] !== originals[1];
    for (const i of [0, 1]) {
      // The control: the glue's own entries, i.e. no exit hook (the rest of
      // the worker's instrumentation — message mailbox, counting — stays).
      const inner = HOOK ? T[i] : originals[i];
      T[i] = function exitObserved(code) {
        harness.proxiedExits.push({ t: Date.now(), index: i, code: Number(code) });
        return inner.apply(this, arguments);
      };
    }
  });
}

// ---------- the page side ----------
let seq = 0;
let PROTOCOL = null;
function post(msg) {
  const data = { protocol: PROTOCOL, ...msg };
  setTimeout(() => { for (const fn of listeners.message) fn({ data }); }, 0);
}
function request(type, extra = {}, timeoutMs = 300_000) {
  const requestId = `${type}-${(seq += 1)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiters.delete(requestId); resolve({ type: "timeout", requestId }); }, timeoutMs);
    waiters.set(requestId, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
    post({ type, requestId, ...extra });
  });
}
const URI = "file:///workspace/Probe.lean";
const BASE = ["def f (n : Nat) : Nat := n + 1", "theorem t1 : f 2 = 3 := rfl", "example : (12 : Nat) ∣ 132 := by decide", ""].join("\n");
const EVAL_EXIT = "#eval (IO.Process.exit 3 : IO Unit)\n";
let version = 1;
const lsp = (msg) => post({ type: "lsp", msg: { jsonrpc: "2.0", ...msg } });
const didChange = (text) => lsp({ method: "textDocument/didChange", params: { textDocument: { uri: URI, version: (version += 1) }, contentChanges: [{ text }] } });
/** Not page-reachable: what the browser drill does — a frame straight into the ring. */
const ringRaw = (msg) => {
  const R = globalThis.__qed64TestExports.resident;
  R.residentRingWrite(R.residentFrame(JSON.stringify({ jsonrpc: "2.0", ...msg })));
};
async function until(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(20); }
  return pred();
}
const glue = () => vm.runInThisContext(`({ EXITSTATUS, keepalive: runtimeKeepaliveCounter, ABORT, runtimeExited,
  pthreads: Object.keys(PThread.pthreads).length, unused: PThread.unusedWorkers.length })`);
const worker = () => ({ ...globalThis.__qed64TestExports.resident.snapshot(), frontDoor: globalThis.__qed64TestExports.frontDoor.status() });

// ---------- run ----------
let verdict = null;
function finish(code, why) {
  const exp = SCENARIOS[SCENARIO];
  const r = {
    ok: code === 0, why, scenario: SCENARIO, hook: HOOK, hookInstalled: harness.hookInstalled,
    expected: { code: exp.code, tableIndex: exp.via },
    proxiedExits: harness.proxiedExits.map((p) => ({ ...p, t: p.t - t0 })),
    onExitCalls: harness.onExitCalls.map((p) => ({ ...p, t: p.t - t0 })),
    died: st.died.map((d) => ({ ...d, t: d.t - t0, afterTriggerMs: st.triggeredAt ? d.t - st.triggeredAt : null })),
    ...verdict, uncaught: st.uncaught, wallMs: Date.now() - t0,
  };
  log(`EXIT-PROBE ${JSON.stringify(r)}`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(r, null, 2));
  process.exit(code);
}
const free = await waitForSlot();
// The budget starts with the slot: waiting for it is the host's time, not the run's.
setTimeout(() => finish(2, "probe budget (15 min) exceeded"), 15 * 60_000).unref();
log(`slot acquired (free+inactive ${free.toFixed(1)} GB); scenario ${SCENARIO}, exit hook ${HOOK ? "ON (shipped)" : "OFF (control)"}`);
process.chdir("/");
process.argv[1] = "/bin/lean"; // thisProgram: IO.appPath reports /bin/lean (the worker mkdirs /bin)
vm.runInThisContext(fs.readFileSync(path.join(workersDir, "lean.worker.js"), "utf8"), { filename: path.join(workersDir, "lean.worker.js") });
PROTOCOL = vm.runInThisContext("PROTOCOL");
// The network, stubbed: the runtime from the stage1 tree, the snapshot from disk.
globalThis.materialize = async (_file, label) => (label === "lean.js" ? leanJs : leanWasm);
const SNAP_URL = "/snapshots/init.snap"; // on the worker's origin (see `location` above)
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => (url === SNAP_URL
  ? new Response(Readable.toWeb(fs.createReadStream(snapPath, { highWaterMark: 8 << 20 })), { status: 200 })
  : realFetch(url, init));

const sizeOf = (f) => fs.statSync(f).size;
// The manifest describes the artifact truthfully: the worker refuses one whose buildId is not
// "wasm64-" + sha256(lean.wasm)[:16] (RUNTIME_MANIFEST_MISMATCH, docs/EMBEDDING.md §7.2).
const sha256Of = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const wasmSha = sha256Of(leanWasm);
const booted = await request("boot", { config: {
  runtime: { buildId: `wasm64-${wasmSha.slice(0, 16)}`, leanVersion: "stage1", files: {
    "lean.js": { bytes: sizeOf(leanJs), sha256: sha256Of(leanJs), chunks: [] }, "lean.wasm": { bytes: sizeOf(leanWasm), sha256: wasmSha, chunks: [] } } },
  memory: { initialBytes: 134217728, maximumCandidates: [17179869184, 8589934592] },
  leanPath: "/lib/lean", packs: [],
} });
if (booted.type !== "ready") finish(2, `boot failed: ${JSON.stringify(booted.error ?? booted)}`);
log(`booted; exit hook installed by the worker: ${harness.hookInstalled}; glue ${JSON.stringify(glue())}`);
const snap = await request("loadSnapshot", { input: { url: SNAP_URL, name: "init.snap", expectedBytes: sizeOf(snapPath) } });
if (snap.type !== "result" || !snap.result?.success) finish(2, `snapshot load failed: ${JSON.stringify(snap.error ?? snap.result)}`);
log(`init snapshot loaded in ${Math.round(snap.result.elapsedMs)} ms`);

if (SCENARIO === "batch-eval-exit") {
  // No arm, no loop: the batch path (header warm-compiles use it in the app).
  st.triggeredAt = Date.now();
  const res = await request("compile", { input: { source: EVAL_EXIT } }, 60_000);
  await sleep(2000);
  verdict = { compile: res.type === "result" ? { success: res.result.success, exitCode: res.result.exitCode, diagnostics: res.result.diagnostics?.map((d) => d.message?.slice(0, 120)) } : { type: res.type, error: res.error }, glue: glue(), worker: worker() };
  finish(0, "batch path observed (informational)");
}

const armed = await request("lsp-arm");
if (armed.type !== "result") finish(2, `arm failed: ${JSON.stringify(armed.error ?? armed)}`);
lsp({ id: 1, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
lsp({ method: "textDocument/didOpen", params: { textDocument: { uri: URI, languageId: "lean4", version: 1, text: BASE } } });
if (!(await until(() => st.progress.version >= 1 && st.progress.processing === 0, 180_000))) finish(2, `document never drained (${JSON.stringify(st.progress)})`);
log(`document open and drained; diagnostics ${JSON.stringify(st.diags)}; glue ${JSON.stringify(glue())}`);
await sleep(500);

st.triggeredAt = Date.now();
if (SCENARIO === "eval-exit") {
  log("trigger: didChange appending `#eval (IO.Process.exit 3 : IO Unit)` (through the front door)");
  didChange(BASE + EVAL_EXIT);
} else if (SCENARIO === "exit") {
  log("trigger: raw `exit` notification into the ring");
  ringRaw({ method: "exit" });
} else {
  log("trigger: raw `shutdown` request (no params), then `exit`, into the ring");
  ringRaw({ id: 900, method: "shutdown" });
  ringRaw({ method: "exit" });
}

const expected = SCENARIOS[SCENARIO];
if (HOOK) {
  await until(() => st.died.length > 0, 15_000);
  const d = st.died[0] ?? null;
  const atDeath = { glue: glue(), worker: worker() };
  // After the death: the runtime is NOT quiescent —
  // the exiting thread is parked in its proxied call, the others run on. The
  // death path must hold anyway: a page edit is dropped, a raw ring write is
  // refused, nothing dies twice, the liveness tick and heartbeat are stopped.
  const before = events.length;
  didChange(BASE + "example : True := trivial\n");
  let ringAfter = "accepted";
  try { ringRaw({ id: 901, method: "textDocument/hover", params: { textDocument: { uri: URI }, position: { line: 0, character: 4 } } }); } catch (e) { ringAfter = `refused: ${e.message}`; }
  await sleep(POST_DEATH_MS);
  const after = events.slice(before).map((e) => e.msg);
  const count = (k) => after.filter((m) => m.type === "event" && m.kind === k).length;
  verdict = {
    latencyMs: d ? d.t - st.triggeredAt : null, atDeath, end: { glue: glue(), worker: worker() },
    postDeath: { windowMs: POST_DEATH_MS, lsp: count("lsp"), status: count("status"), heartbeat: count("heartbeat"), died: count("died"), log: count("log"),
      livenessLogs: st.logsAfterDeath.filter((l) => l.startsWith("[liveness]")), ringWriteAfterDeath: ringAfter },
  };
  const checks = {
    died: d !== null,
    reason: d?.reason === "exit",
    code: d?.code === expected.code,
    mode: d?.mode === "resident",
    immediate: d !== null && d.t - st.triggeredAt < 5000,
    once: st.died.length === 1,
    proxied: harness.proxiedExits.some((p) => p.code === expected.code && (expected.via === null || p.index === expected.via)),
    onExitSilent: harness.onExitCalls.length === 0, // the glue's own path never fires with the keepalive held
    editDropped: (atDeath.worker.frontDoor.dropped ?? 0) < (verdict.end.worker.frontDoor.dropped ?? 0),
    ringRefused: ringAfter.startsWith("refused"),
    timersStopped: count("heartbeat") === 0 && verdict.postDeath.livenessLogs.length === 0,
    noUncaught: st.uncaught.length === 0,
  };
  verdict.checks = checks;
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  finish(failed.length ? 1 : 0, failed.length ? `expectation failed: ${failed.join(", ")}` : `died "exit" code ${d.code} in ${d.t - st.triggeredAt} ms`);
} else {
  // The control: the exit happens (the proxied call runs on this thread and
  // EXITSTATUS is set) but nothing reports it.
  await until(() => st.died.length > 0, IDLE_MS);
  const idle = { diedWithinIdle: st.died.length > 0, glue: glue(), worker: worker() };
  log(`idle window ${IDLE_MS} ms: ${idle.diedWithinIdle ? `died ${JSON.stringify(st.died[0])}` : "NO death reported"}; glue ${JSON.stringify(idle.glue)}`);
  let afterEdit = null;
  if (EDIT_AFTER_IDLE && st.died.length === 0) {
    const at = Date.now();
    log("edit after idle: a didChange — only now is work owed, so only now can the liveness layer notice");
    didChange(BASE + "example : True := trivial\n");
    await until(() => st.died.length > 0, 45_000);
    afterEdit = st.died[0] ? { reason: st.died[0].reason, code: st.died[0].code, afterEditMs: st.died[0].t - at } : null;
  }
  verdict = { idle, afterEdit };
  const exited = harness.proxiedExits.some((p) => p.code === expected.code) && idle.glue.EXITSTATUS === expected.code;
  const silent = SCENARIO === "eval-exit" ? !st.died.some((d) => d.reason === "exit") : !idle.diedWithinIdle;
  verdict.checks = { exited, silent, onExitSilent: harness.onExitCalls.length === 0 };
  const failed = Object.entries(verdict.checks).filter(([, v]) => !v).map(([k]) => k);
  finish(failed.length ? 1 : 0, failed.length ? `control expectation failed: ${failed.join(", ")}` : "control: the exit ran and nothing reported it as an exit");
}
