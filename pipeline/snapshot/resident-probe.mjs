#!/usr/bin/env node
// Phase-1 spike for the resident FileWorker (docs/RESIDENT-WORKER-PLAN.md):
// boot the patch-0031 artifact under Node, configure the futex stdin ring,
// callMain the page's `--worker` command line — the REAL Lean FileWorker loop
// on the application pthread, under the page's thread setup (R3) — then
// drive initialize/didOpen through the ring and read framed
// LSP off stdout. Exit criteria: initialize answers, fileProgress flows
// (proves timed sleeps wake on the proxied pthread — the known emsdk risk),
// diagnostics arrive for a deliberate error, and the loop shuts down clean.
//
//   node pipeline/snapshot/resident-probe.mjs [--artifact <stage1>] [--lib <tree>] [--budget-ms 180000]
//                                             [--snap-dir <dir>] [--snapshots init,mathlib] [--mathlib] [--act2 | --act4 [--act4-ms 500]]
//                                             [--lean-option <name=value> ...] [--option-check]
//                                             [--probe-file <file> [--dump-messages] [--settle-ms 5000]]
//
// The page's setup (architecture review R3): the command line is
// public/workers/worker-constants.js's residentArgv (--worker
// -Dserver.reportDelayMs=0 -DElab.async=false), the task manager gets
// leanWorkers(os.availableParallelism()) workers (at most 8, HARDENING #69;
// SKIP_TASK_MANAGER=1 still skips it), and LEAN_WASM_PARKED_DEDICATED is set at
// preRun, as lean.worker.js does.
//
//   --artifact   the stage1 dir (else $QED64_LEAN_ARTIFACT, else the deprecated
//                pipeline/toolchain/work/build/stage1 of this checkout, one WARNING)
//   --snap-dir   the directory holding <name>.snap (else $QED64_SNAP_DIR, else the
//                deprecated work/snapshot of this checkout, one WARNING)
//   --snapshots  the <name>.snap files seeded into the env cache
//                before --worker starts (default: init; mathlib adds the
//                umbrella env the Mathlib probe needs — 1.1 GB raw)
//   --mathlib    probe a Mathlib header (`import Mathlib.Data.Real.Basic`)
//                instead of Init; implies --snapshots init,mathlib unless given.
//                Its text has no deliberate error, so act 1 passes when progress
//                drains with no error diagnostic (the Init probes pass on their
//                deliberate `rfl` error instead)
//   --act2       after act 1 drains, change the header via didChange and
//                expect an in-process session replacement (exit 2 + re-callMain);
//                Init probes only (it waits for their deliberate error again),
//                so --mathlib --act2 is refused
//   --act4       a full-text header switch mid-elaboration: --act4-ms after
//                the first non-empty fileProgress, send the document again
//                without its import line, and pass when progress drains with
//                no abort. With --mathlib this is the former
//                header-switch-probe.mjs (the Init-only text under a
//                Mathlib-seeded session: the step-1 crash of the 2026-09
//                gauntlets); without it, the same switch on the Init probe
//   --lean-option  an extra Lean option (repeatable), merged into the page's
//                command line as the page merges ResidentHost.leanOptions
//                (by name; yours win); a malformed one exits 2
//   --option-check the document `def idA (x : α) : α := x` passes only if Lean
//                reports α as an unknown identifier, i.e. with
//                `--lean-option autoImplicit=false` the option reached Lean
//                (without it the run is the control and fails); Init only, so
//                --mathlib, --act2 and --act4 are refused
//   --probe-file runs that document as the page does (act 1 only, no
//                EXPERIMENT requests), with --snapshots init,mathlib by
//                default: it prints `resident: reached elaboration` at the
//                first non-empty fileProgress; once progress has stayed
//                drained for --settle-ms (default 5000; a kind-2 fatalError
//                entry, which a refused header leaves standing, counts as
//                drained, as in the page's front door) it prints the final
//                diagnostics (with --dump-messages one {"caption":"",…} JSON
//                line each, snapshot-probe's shape: severity by name, pos and
//                endPos 1-based lines and LSP's UTF-16 columns), then
//                `compile: tag=0 elapsed=<ms since didOpen> errors=<n>`, and
//                exits 0 whatever the document's errors are (the compiler
//                battery's --transport fileworker judges them, review R4).
//                The budget, an abort and an exit before the settle end in
//                `RESIDENT PROBE FAIL {…}`, exit 1. Refused with --mathlib,
//                --act2, --act4 and --option-check (exit 2); --lean-option
//                applies to it
//
// Tier 3, except the surface the lean4-wasm64 gate runs and parses (kernel R10, tier 2): its flags,
// the --dump-messages and `compile:` lines, the verdict line's keys and the exits. Tell the kernel
// session before changing any of it (docs/CLI-CONTRACT.md "Tiers"; tests/unit/tool-paths.test.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import "../../public/workers/lsp-frames.js"; // publishes globalThis.Qed64LspFrames
import "../../public/workers/worker-constants.js"; // globalThis.Qed64WorkerConstants: the page's argv and thread budget (R3)
import { resolveToolPath } from "../toolchain/artifact-paths.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const USAGE = "resident-probe.mjs [--artifact <stage1>] [--lib <tree>] [--budget-ms 180000] [--snap-dir <dir>] [--snapshots init,mathlib] [--mathlib] [--act2 | --act4 [--act4-ms 500]] [--lean-option <name=value> ...] [--option-check] [--probe-file <file> [--dump-messages] [--settle-ms 5000]]";
const artifactDir = resolveToolPath({
  tool: "resident-probe", flag: "artifact", placeholder: "<dir>", value: arg("artifact", null), env: "QED64_LEAN_ARTIFACT",
  legacy: path.join(repoRoot, "pipeline/toolchain/work/build/stage1"), legacyLabel: "pipeline/toolchain/work/build/stage1 under the repo root",
  holds: (dir) => fs.existsSync(path.join(dir, "bin/lean.js")), needs: "bin/lean.js", usage: USAGE,
}).path;
const libLean = path.resolve(arg("lib", path.join(artifactDir, "lib/lean")));
const budgetMs = Number(arg("budget-ms", "180000"));
const leanJs = path.join(artifactDir, "bin/lean.js");
if (!fs.existsSync(leanJs)) { console.error(`error: ${leanJs} not found`); process.exit(2); }

const MATHLIB = process.argv.includes("--mathlib");
const ACT2 = process.argv.includes("--act2");
const ACT4 = process.argv.includes("--act4");
const ACT4_MS = Number(arg("act4-ms", process.env.ACT4_MS || "500"));
if (MATHLIB && ACT2) { console.error("error: --act2 needs the Init probe's deliberate error; it cannot judge --mathlib (use --mathlib --act4 for a Mathlib header switch)"); process.exit(2); }
if (ACT2 && ACT4) { console.error("error: --act2 and --act4 are separate experiments; pass one"); process.exit(2); }
// Repeatable (tier 3); a --lean-option with no value is the empty, malformed entry.
const LEAN_OPTIONS = process.argv.flatMap((a, i) => (a === "--lean-option" ? [process.argv[i + 1] ?? ""] : []));
const OPTION_CHECK = process.argv.includes("--option-check");
let ARGV; // the page's command line with LEAN_OPTIONS merged by name (worker-constants.js residentArgv)
try { ARGV = Qed64WorkerConstants.residentArgv(LEAN_OPTIONS); } catch (e) { console.error(`error: --lean-option: ${e.message}`); process.exit(2); }
if (OPTION_CHECK && (MATHLIB || ACT2 || ACT4)) { console.error("error: --option-check judges one Init document; it cannot be combined with --mathlib, --act2 or --act4"); process.exit(2); }
// File mode (review R4, the compiler battery's --transport fileworker): one document, act 1 only, judged by the caller.
const PROBE_FILE = arg("probe-file", null);
const DUMP = process.argv.includes("--dump-messages");
const SETTLE_MS = Number(arg("settle-ms", "5000"));
if (PROBE_FILE && (MATHLIB || ACT2 || ACT4 || OPTION_CHECK)) { console.error("error: --probe-file runs one document (act 1 only); it cannot be combined with --mathlib, --act2, --act4 or --option-check"); process.exit(2); }
if (PROBE_FILE && !fs.existsSync(PROBE_FILE)) { console.error(`error: --probe-file ${PROBE_FILE} not found`); process.exit(2); }
if (!(Number.isFinite(SETTLE_MS) && SETTLE_MS >= 0)) { console.error(`error: --settle-ms must be a number of milliseconds >= 0 (got ${arg("settle-ms", "")})`); process.exit(2); }
/** The option check's verdict: Lean refused the auto-bound α (v4.35 words it "Unknown identifier `α`"). */
const OPTION_ERROR = /unknown identifier [`'‘]α[`'’]/i;
const SNAPSHOTS = arg("snapshots", MATHLIB || PROBE_FILE ? "init,mathlib" : "init").split(",").map((s) => s.trim()).filter(Boolean);
const SNAP_DIR = resolveToolPath({
  tool: "resident-probe", flag: "snap-dir", placeholder: "<dir>", value: arg("snap-dir", null), env: "QED64_SNAP_DIR",
  legacy: path.join(repoRoot, "work/snapshot"), legacyLabel: "work/snapshot under the repo root", holds: fs.existsSync, usage: USAGE,
}).path;

const PROBE = PROBE_FILE ? ((t) => (t.endsWith("\n") ? t : `${t}\n`))(fs.readFileSync(PROBE_FILE, "utf8")) : (OPTION_CHECK ? [
  "import Init",
  "def idA (x : α) : α := x",
] : MATHLIB ? [
  "import Mathlib.Data.Real.Basic",
  "",
  "example (a b : ℝ) : a + b = b + a := by",
  "  exact add_comm a b",
  "",
  "theorem t1 : (2 : ℕ) + 2 = 4 := rfl",
] : process.env.PROBE_MINIMAL ? [
  "import Init",
  "theorem two_two : (2 : Nat) + 2 = 4 := rfl",
  "example : (2 : Nat) + 2 = 5 := rfl",
] : [
  "import Init",
  "def answer : Nat := 41 + 1",
  "#eval answer",
  "theorem answer_is : answer = 42 := rfl",
  "example : answer = 43 := rfl",
]).join("\n") + "\n"; // the array branches only; --probe-file's text is taken as is (one final newline)

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
const seen = { initializeResponse: false, fileProgressEvents: 0, progressDrained: false, diags: [], errors: 0, evalInfo: false,
  act: 1, exit2: false, act2Diags: 0, act2Drained: false, act4Armed: false, act4SentAt: 0 };
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
// File mode: the latest diagnostics set (LSP publishes the whole set each time), whether
// elaboration started (any progress entry) and whether work was seen (kind 1), the
// stable-drain timer, the didOpen time, and whether the result is out.
let fileDiags = []; let reachedElab = false; let sawProcessing = false; let settleTimer = null; let openedAt = 0; let fileDone = false;
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
    errors: seen.errors,
    evalInfo: seen.evalInfo,
    frames: frames.stats.frames,
    nonFrameStdoutBytes: frames.stats.junkBytes,
    wallMs: Date.now() - t0,
    argv: ARGV,
    optionError: seen.diags.some((d) => OPTION_ERROR.test(d)),
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
    if (val !== null) frames.push(val); // null = the glue's flush signal; NUL is a byte (as in the worker)
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
    if (PROBE_FILE) {
      // Done once progress has stayed drained for SETTLE_MS; any new work restarts the wait.
      // FileProgressKind 2 (fatalError) is terminal, not work: after a refused header the
      // FileWorker reports one kind-2 entry for the whole file and never clears it (the
      // page's front door, lsp-front-door.js, counts it the same way).
      if (processing.length > 0 && !reachedElab) { reachedElab = true; log("resident: reached elaboration"); }
      const working = processing.filter((e) => !e || e.kind !== 2);
      if (working.length > 0) {
        sawProcessing = true; clearTimeout(settleTimer); settleTimer = null;
      } else if (sawProcessing || seen.fileProgressEvents > 1) {
        seen.progressDrained = true;
        if (!settleTimer) settleTimer = setTimeout(finishFile, SETTLE_MS);
      }
      return;
    }
    if (ACT4) {
      // Act 4: the first non-empty progress means the header's session is
      // elaborating; ACT4_MS later the whole document arrives again WITHOUT
      // its import line (the page's full-text didChange after a header edit).
      if (!seen.act4Armed && processing.length > 0) {
        seen.act4Armed = true;
        log(`ACT4: first non-empty fileProgress — sending headerless full text in ${ACT4_MS} ms`);
        setTimeout(() => {
          seen.act4SentAt = Date.now();
          send({ jsonrpc: "2.0", method: "textDocument/didChange", params: {
            textDocument: { uri: "file:///workspace/Probe.lean", version: 2 },
            contentChanges: [{ text: PROBE.replace(/^import [^\n]*\n/, "") }] } });
        }, ACT4_MS);
      }
      if (seen.act4SentAt && processing.length === 0 && seen.fileProgressEvents > 3) {
        log(`ACT4 PASS: drained ${Date.now() - seen.act4SentAt} ms after the headerless switch`);
        return finish(true, "act4 drained");
      }
    }
    if (seen.fileProgressEvents > 1 && processing.length === 0) seen.progressDrained = true;
    checkActs(); // the drained progress can land AFTER the last diagnostic
    return;
  }
  if (msg.method === "textDocument/publishDiagnostics") {
    if (PROBE_FILE) {
      const ds = msg.params?.diagnostics ?? [];
      // The FileWorker's notice that the ring closed is not the document's; keep the set before it.
      if (!ds.some((d) => /^Cannot read LSP message: Stream was closed/.test(String(d.message)))) {
        fileDiags = ds;
        seen.diags = ds.map((d) => String(d.message).slice(0, 120));
        seen.errors = ds.filter((d) => d.severity === 1).length;
      }
      return;
    }
    for (const d of msg.params?.diagnostics ?? []) {
      seen.diags.push(String(d.message).slice(0, 120));
      // The FileWorker's own notice that the probe closed its stdin ring is not an error of the document.
      if (d.severity === 1 && !/^Cannot read LSP message: Stream was closed/.test(String(d.message))) seen.errors += 1;
      if (/42/.test(String(d.message)) && d.severity >= 3) seen.evalInfo = true;
    }
    checkActs();
  }
}

// Success conditions are evaluated from BOTH the diagnostics and the
// fileProgress handlers: the burst order between them is not fixed.
let optionCheckTimer = null;
function checkActs() {
  if (PROBE_FILE) return; // file mode settles from fileProgress alone (finishFile)
  if (ACT4) return; // act 4 judges itself from fileProgress alone
  if (OPTION_CHECK) {
    // One verdict, 1.5 s after the first drain: the diagnostics may land after it.
    if (seen.progressDrained && !optionCheckTimer) {
      optionCheckTimer = setTimeout(() => {
        const hit = seen.diags.some((x) => OPTION_ERROR.test(x));
        log(`option-check diagnostics: ${JSON.stringify(seen.diags)}`);
        closeRing();
        finish(hit, hit ? "option-check: Lean reported the auto-bound α as unknown (the option reached it)"
          : "option-check: no \"Unknown identifier `α`\" (the option did not reach Lean, or autoImplicit is on)");
      }, 1500);
    }
    return;
  }
  {
    // Act 1: progress drained AND our deliberate error surfaced (Init probes),
    // or progress drained with no error at all (the Mathlib probe has none).
    const act1Done = MATHLIB ? seen.progressDrained : seen.progressDrained && seen.diags.some((x) => /rfl|43|mismatch|failed/i.test(x));
    if (seen.act === 1 && act1Done) {
      log(`act-1 diagnostics: ${JSON.stringify(seen.diags)}`);
      if (!ACT2) {
        // The Mathlib verdict is the document's errors when its progress drained (they precede the drain).
        const errorsAtDrain = seen.errors;
        closeRing();
        setTimeout(() => (MATHLIB && errorsAtDrain > 0 ? finish(false, `mathlib probe: ${errorsAtDrain} error diagnostic(s)`) : finish(true, "clean run")), 1500);
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

/** File mode's result, once the drain has settled: the document's final diagnostics in
 * snapshot-probe's --dump-messages shape, then its `compile:` line. A document with errors
 * still exits 0: the caller (compiler-battery.mjs --transport fileworker) judges it. */
function finishFile() {
  if (fileDone || finished) return;
  fileDone = true;
  const SEV = { 1: "error", 2: "warning", 3: "information", 4: "hint" };
  if (DUMP) for (const d of fileDiags) console.log(JSON.stringify({ caption: "", severity: SEV[d.severity] ?? String(d.severity),
    pos: { line: d.range.start.line + 1, column: d.range.start.character }, endPos: { line: d.range.end.line + 1, column: d.range.end.character },
    data: String(d.message) }));
  const errors = fileDiags.filter((d) => d.severity === 1).length;
  console.log(`compile: tag=0 elapsed=${Date.now() - openedAt}ms errors=${errors}`);
  closeRing();
  setTimeout(() => finish(true, "progress drained (file probe)"), 500);
}

// ---------------------------------------------------------------------------
// Stdin ring writer (contract org.lean-browser64.resident-transport/v1)
// ---------------------------------------------------------------------------
// The product's ring size (lean.worker.js RESIDENT_RING_CAP, spec W4) so the
// probe exercises the shipped geometry; the two are asserted equal at startup
// because the worker is a classic script the probe cannot import.
const CAP = 64 << 20;
{
  const src = fs.readFileSync(new URL("../../public/workers/lean.worker.js", import.meta.url), "utf8");
  const m = /const RESIDENT_RING_CAP = (\d+) << (\d+);/.exec(src);
  const workerCap = m ? Number(m[1]) << Number(m[2]) : NaN;
  if (workerCap !== CAP) throw new Error(`resident-probe CAP ${CAP} != lean.worker.js RESIDENT_RING_CAP ${workerCap}`);
}
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
    globalThis.Module.ENV.LEAN_WASM_PARKED_DEDICATED = Qed64WorkerConstants.PARKED_DEDICATED; // the page's parking (HARDENING #69)
    FS.chdir("/workspace");
  }],
  onRuntimeInitialized() {
    const M = globalThis.Module;
    // Full Lean initialization before ANY Lean entry point (snapshot-probe's
    // sequence): loading a snapshot on an uninitialized runtime panics.
    M._lean_initialize_runtime_module();
    M._lean_initialize();
    M._lean_io_mark_end_initialization();
    let taskManager = "skipped (SKIP_TASK_MANAGER)";
    if (!process.env.SKIP_TASK_MANAGER) {
      // The page's thread budget (HARDENING #69), sized from this host as the page sizes it from navigator.
      if (M._lean_init_task_manager_using) {
        const n = Qed64WorkerConstants.leanWorkers(os.availableParallelism());
        M._lean_init_task_manager_using(n);
        taskManager = `${n} worker(s)`;
      } else if (M._lean_init_task_manager) { M._lean_init_task_manager(); taskManager = "the hardware default (no _lean_init_task_manager_using)"; }
    }
    if (M._lean_enable_initializer_execution) M._lean_enable_initializer_execution();
    const sp = M._lean_init_search_path();
    M._lean_wasm_shell_mark_preinitialized();
    log(`lean initialized (search path tag via ${typeof sp}); task manager: ${taskManager}, parked dedicated threads: ${Qed64WorkerConstants.PARKED_DEDICATED}; argv ${JSON.stringify(ARGV)}`);
    { const mu = process.memoryUsage(); log(`MEMUSAGE after-init rss=${(mu.rss/1e9).toFixed(2)}GB arrayBuffers=${(mu.arrayBuffers/1e9).toFixed(2)}GB external=${(mu.external/1e9).toFixed(2)}GB heapUsed=${(mu.heapUsed/1e6).toFixed(0)}MB`); }
    // Seed the prebuilt env FIRST: the resident worker's header processing
    // cannot import oleans on its elaboration pthread (the long-documented
    // hang prepareHeader exists for) — a loaded snapshot publishes a
    // covering env (Shell.lean publish line in patch 0031) it finds instead.
    // --snapshots names them in load order (init first, then the umbrella).
    for (const snapName of SNAPSHOTS) {
      const snapHost = path.join(SNAP_DIR, `${snapName}.snap`);
      if (!fs.existsSync(snapHost)) {
        log(`WARNING: ${snapHost} missing — a header it covers will try olean import (known hang)`);
        continue;
      }
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
      log(`${snapName}.snap loaded (${total} bytes, io tag via ${typeof lr})`);
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
    M.callMain([...ARGV]); // The page's command line (worker-constants.js, R3).
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
    openedAt = Date.now();
    send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
      textDocument: { uri: "file:///workspace/Probe.lean", languageId: "lean4", version: 1, text: (process.env.PROBE_HEADER ? process.env.PROBE_HEADER + "\n" : "") + PROBE } } });
    // Discriminator experiment (phase-1 blocker): after the reporter goes
    // quiet, send requests that DON'T depend on the reporter. rpc/connect
    // answers immediately through the stdout writer; hover needs a body
    // elaboration snapshot. Their arrival (or not) tells reporter-wedged vs
    // writer-stalled vs elaboration-stuck apart. Not under --act4: that act
    // measures one switch, and the extra requests would blur its drain; not
    // under --probe-file: the page sends no such requests on its own.
    if (!ACT4 && !PROBE_FILE) setTimeout(() => {
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
    // File mode: the FileWorker exits once finishFile closes the ring; before that, an exit is a failure.
    if (PROBE_FILE) { if (!fileDone) finish(false, `exit code=${code} before the drain settled`); return; }
    if (seen.act === 2 && !seen.exit2) {
      seen.exit2 = true;
      log("worker requested restart — re-callMain in the SAME process");
      setTimeout(() => {
        const M = globalThis.Module;
        const raw = M._malloc(16 + CAP);
        ring = { ctrlPtr: typeof raw === "bigint" ? Number(raw) : raw };
        const st = M._lean_browser64_configure_input_ring(typeof raw === "bigint" ? raw : BigInt(raw), CAP);
        if (st !== 0) return finish(false, `act2 ring rejected: ${st}`);
        M.callMain([...ARGV]);
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
