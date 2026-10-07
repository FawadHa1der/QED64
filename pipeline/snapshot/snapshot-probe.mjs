#!/usr/bin/env node
// Validate a baked snapshot end to end with the exact shipped runtime: load
// it via lean_wasm_load_snapshot (the same export the worker calls), then
// compile a probe whose header imports match the snapshot's — which must be
// FAST (env-cache hit) and error-free. Guards against a snapshot that bakes
// fine but loads into the wrong cache key, which would silently degrade the
// app to the minutes-long import path.
//
// Usage: node --stack-size=8192 pipeline/snapshot/snapshot-probe.mjs \
//          --snap public/snapshots/mathlib-reals.snap \
//          --probe-file <lean file with the matching imports> \
//          [--lib <olean tree>] [--artifact <dir>] [--budget-ms 90000]
// --artifact / --lib: else $QED64_LEAN_ARTIFACT / $QED64_LIB_TREE, else the
// deprecated repo-relative default with one WARNING, else exit 2. Started
// without --stack-size, it re-execs itself with --stack-size=8192 (same PID).
// Unless --watchdog-ms 0, the probe runs as one supervised child process (the
// watchdog below, after the usage checks): kernel patch 0037 makes a task that
// never finishes hang lean_wasm_compile, and only another process can end it.
// (--help lists every flag; the contract is docs/CLI-CONTRACT.md)

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ensureStackSize, resolveToolPath } from "../toolchain/artifact-paths.mjs";

// First, before the contract prints anything: replaces this process (same PID) when
// started without --stack-size, so every line below is printed once.
ensureStackSize("snapshot-probe");

// The supervised child (QED64_PROBE_CHILD=1, the watchdog below) parses the arguments its
// supervisor already parsed and warned about: it drops the repeat of those WARNING lines
// (only those), so each is printed once.
const supervisedChild = process.env.QED64_PROBE_CHILD === "1";
const consoleError = console.error;
if (supervisedChild) console.error = (...a) => { if (!String(a[0]).startsWith("snapshot-probe: WARNING — ")) consoleError(...a); };
// <cli-contract> generated from SPECS["snapshot-probe"] in pipeline/snapshot/cli.mjs. Do not edit:
// `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts
// fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.
// It runs before any side effect: --help/-h prints the help and exits 0, a missing required
// flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and
// --flag=value is rewritten to the two-token form this script reads, with the later values
// of a repeated flag dropped so the first wins here too (docs/CLI-CONTRACT.md).
{
  const spec = {"tool":"snapshot-probe","usage":"snapshot-probe.mjs (--snap <file> | --fresh-import --lib <tree>) (--probe-file <file> | --probe <source>)","flags":{"snap":1,"fresh-import":0,"probe-file":1,"probe":1,"lib":1,"artifact":1,"budget-ms":1,"via-mem":0,"via-memfs":0,"init-flags":1,"workspace":1,"dump-messages":0,"watchdog-ms":1},"required":[["snap","fresh-import"],["probe-file","probe"]],"passthrough":null,"passthroughRequired":false};
  spec.help = [
    "usage: snapshot-probe.mjs (--snap <file> | --fresh-import --lib <tree>) (--probe-file <file> | --probe <source>)",
    "Load a baked snapshot through the worker's exact export (lean_wasm_load_snapshot, or _mem with --via-mem), then compile a probe whose header matches it: it must be error-free and within the budget (an env-cache hit).",
    "run as: node --stack-size=8192 pipeline/snapshot/snapshot-probe.mjs",
    "",
    "flags:",
    "  --snap <file>        raw .snap to load (hard-linked into a scratch dir under the OS tmpdir) [one of --snap, --fresh-import is required]",
    "  --fresh-import       no snapshot: import the probe's header from --lib (the slim-bake differential audit) [one of --snap, --fresh-import is required]",
    "  --probe-file <file>  the Lean file to compile after the load [one of --probe-file, --probe is required]",
    "  --probe <source>     the probe text inline (read only when --probe-file is absent) [one of --probe-file, --probe is required]",
    "  --lib <tree>         olean tree mounted at /lib/lean (default: $QED64_LIB_TREE, else (deprecated, one WARNING) work/lib-tree under the repo root when it exists; nothing else: exit 2)",
    "  --artifact <dir>     stage1 dir holding bin/lean.js + bin/lean.wasm (default: $QED64_LEAN_ARTIFACT, else (deprecated, one WARNING) pipeline/toolchain/work/build/stage1 under the repo root when it has bin/lean.js; nothing else: exit 2)",
    "  --budget-ms <ms>     compile budget; slower means the load seeded the wrong env-cache key (default: 90000)",
    "  --via-mem            stream the snapshot into a wasm-malloc'd buffer (lean_wasm_load_snapshot_mem, the browser's path)",
    "  --via-memfs          copy the snapshot into MEMFS in 64 MiB chunks before loading",
    "  --init-flags <n>     replay-control flags passed with --via-mem (patch 0016) (default: 1)",
    "  --workspace <dir>    host dir mounted at /workspace, the compile's cwd (game probes need .lake/gamedata)",
    "  --dump-messages      echo every line Lean prints on stdout as `[lean:stdout] <line>`",
    "  --watchdog-ms <ms>   wall-clock limit of the supervised probe process (one child, QED64_PROBE_CHILD=1): past it the child is SIGKILLed and the run fails (a hung lean_wasm_compile, kernel 0037 on); 0 runs the probe in this process with no watchdog (default: --budget-ms + 120000)",
    "  -h, --help           print this help and exit 0, before any side effect",
    "",
    "environment:",
    "  QED64_LEAN_ARTIFACT  stage1 artifact dir (bin/lean.js, bin/lean.wasm, lib/lean) used when --artifact is absent (empty = unset)",
    "  QED64_LIB_TREE       the olean tree mounted at /lib/lean (the tree the probed snapshot was baked from) used when --lib is absent",
    "  QED64_PROFILE_INIT   when set, forwarded into the wasm environment to profile the [init] replay",
    "  QED64_PROBE_CHILD    internal: \"1\" marks the probe process snapshot-probe's watchdog supervises (it runs the probe in-process and does not repeat the argument WARNINGs); snapshot-probe sets it for its child",
    "  QED64_PROBE_SCRATCH  internal, read only with QED64_PROBE_CHILD=1: the scratch dir the supervised probe process creates, named by its supervisor, which removes it even when the child is killed",
    "",
    "exit codes:",
    "  0  SNAPSHOT PROBE PASS",
    "  1  SNAPSHOT PROBE FAIL (load failed, the probe has errors or blew the budget; the watchdog: no verdict within --watchdog-ms; the probe process killed by a signal), or a crash before the runtime started (an unreadable --probe-file, a missing lean.js)",
    "  2  usage: no snapshot source or no probe; a --watchdog-ms that is not a whole number; or no --artifact / --lib, its variable unset and no deprecated default",
    "  3  the wasm runtime aborted (legacy overload of class 3)",
    "",
    "tier 1 (downstream-stable). Contract: docs/CLI-CONTRACT.md",
  ].join("\n");
  const args = process.argv.slice(2);
  const normalized = (function cliContract(spec, args, io = { out: (s) => console.log(s), err: (s) => console.error(s), exit: (c) => process.exit(c) }) {
    const values = {};
    const warnings = [];
    const normalized = [];
    let passthrough = [];
    let help = false;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (token === "--help" || token === "-h") { help = true; continue; }
      if (token === "--" && spec.passthrough) { passthrough = args.slice(i + 1); normalized.push(...args.slice(i)); break; }
      const m = /^--([^=]+)(=[\s\S]*)?$/.exec(token);
      const arity = m && Object.hasOwn(spec.flags, m[1]) ? spec.flags[m[1]] : -1;
      if (arity < 0 || (arity === 0 && m[2] !== undefined)) {
        if (spec.passthrough === "implicit") { passthrough = args.slice(i); normalized.push(...passthrough); break; }
        warnings.push(token.startsWith("-") ? `unknown flag ${token} ignored` : `unexpected argument ${token} ignored`);
        normalized.push(token);
        continue;
      }
      const name = m[1];
      const repeated = Object.hasOwn(values, name);
      let value = true;
      if (arity === 1) {
        value = m[2] !== undefined ? m[2].slice(1) : i + 1 < args.length ? args[(i += 1)] : undefined;
        if (value === "--help" || value === "-h") help = true;
        if (!repeated) normalized.push(`--${name}`, ...(value === undefined ? [] : [value]));
        if (!value) warnings.push(`flag --${name} has no value; ignored`);
      } else normalized.push(token);
      if (!repeated) values[name] = value ?? "";
      else if (arity === 1) warnings.push(`flag --${name} repeated; the first value wins`);
    }
    if (help) { io.out(spec.help); io.exit(0); return null; }
    for (const w of warnings) io.err(`${spec.tool}: WARNING — ${w}`);
    for (const name of Object.keys(values)) if (values[name] === "") delete values[name];
    const missing = (spec.required || []).some((group) => !group.some((name) => Object.hasOwn(values, name)));
    if (missing || (spec.passthroughRequired && passthrough.length === 0)) { io.err(`usage: ${spec.usage}`); io.exit(2); return null; }
    return { values, passthrough, args: normalized };
  })(spec, args)?.args ?? args;
  if (normalized.join("\0") !== args.join("\0")) process.argv.splice(2, args.length, ...normalized);
}
// </cli-contract>
console.error = consoleError;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const snapHost = path.resolve(arg("snap", ""));
const probeFile = arg("probe-file", "");
const probeSource = probeFile ? fs.readFileSync(path.resolve(probeFile), "utf8") : arg("probe", "");
const budgetMs = Number(arg("budget-ms", "90000"));
// Optional host dir NODEFS-mounted at /workspace (the worker cwd) — game
// probes need `.lake/gamedata/*.json` visible to GameServer's Runner.
const workspaceDir = arg("workspace", "") ? path.resolve(arg("workspace", "")) : "";
// --via-memfs copies the snapshot into MEMFS in bounded chunks before loading —
// the worker's exact path — instead of reading it through a NODEFS mount (a
// single read() of a >2 GiB file trips Node's per-call I/O limits).
const viaMemfs = process.argv.includes("--via-memfs");
// --via-mem streams the snapshot into a wasm-malloc'd buffer and loads through
// lean_wasm_load_snapshot_mem — the browser worker's direct path.
const viaMem = process.argv.includes("--via-mem");
// --fresh-import: no snapshot at all — the probe's header is imported from
// the mounted --lib tree by lean_wasm_compile (getOrCreateWasmEnvFor), which
// is what a native import with every facet present would produce. Its only
// use is the differential half of the slim-bake audit (docs/REBUILD.md §3):
// the SAME probe file through a slim snapshot and through a fresh import of
// the fat tree must print byte-identical messages. The compile budget is the
// import's, so pass a large --budget-ms.
const freshImport = process.argv.includes("--fresh-import");
if ((!snapHost && !freshImport) || !probeSource) {
  console.error("usage: snapshot-probe.mjs (--snap <file> | --fresh-import --lib <tree>) (--probe-file <file> | --probe <source>)");
  process.exit(2);
}
// After the usage check, before any side effect (the scratch dir below).
const USAGE = "snapshot-probe.mjs (--snap <file> | --fresh-import --lib <tree>) (--probe-file <file> | --probe <source>)";

// The watchdog (docs/CLI-CONTRACT.md §snapshot-probe). From kernel patch 0037 on,
// lean_wasm_compile returns only after every task a command recorded has finished, so a task
// that never finishes (a timed sleep inside an async proof) hangs the call, and the call blocks
// this thread: no timer of this process can fire. So, unless QED64_PROBE_CHILD is "1", this
// process supervises: it runs the probe as ONE child (this script, the same Node flags with
// --stack-size kept, the same arguments, QED64_PROBE_CHILD=1, stdio inherited, so every line is
// the child's and a normal run prints nothing more) and exits with the child's code. Past
// --watchdog-ms it SIGKILLs the child and prints one FAIL line; SIGINT/SIGTERM/SIGHUP are passed
// on. --watchdog-ms 0 runs the probe in this process, as before the watchdog.
const watchdogArg = arg("watchdog-ms", null);
const watchdogMs = watchdogArg === null ? Math.ceil(Number.isFinite(budgetMs) ? budgetMs : 90000) + 120000 : Number(watchdogArg);
if (!Number.isSafeInteger(watchdogMs) || watchdogMs < 0) {
  console.error(`snapshot-probe: --watchdog-ms takes a whole number of ms, 0 for no watchdog (got ${watchdogArg})`);
  console.error(`usage: ${USAGE}`);
  process.exit(2);
}
if (watchdogMs > 0 && !supervisedChild) process.exit(await superviseProbe(watchdogMs));

/** Run this probe as one supervised child; resolves with the exit code to pass on. */
function superviseProbe(ms) {
  // One line, written synchronously: process.exit follows at once.
  const fail = (line) => { try { fs.writeSync(2, `${line}\n`); } catch {} };
  // The child's scratch dir (it creates it) is named here and removed here on exit too, so a
  // child that dies by a signal (the watchdog's SIGKILL) leaves no hard link to the snapshot.
  const childScratch = path.join(os.tmpdir(), `qed64-snap-probe-${randomBytes(6).toString("hex")}`);
  process.on("exit", () => fs.rmSync(childScratch, { recursive: true, force: true }));
  const execArgv = process.execArgv.some((a) => /^--stack-size(=|$)/.test(a)) ? process.execArgv : [...process.execArgv, "--stack-size=8192"];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...execArgv, ...process.argv.slice(1)], {
      stdio: "inherit",
      env: { ...process.env, QED64_PROBE_CHILD: "1", QED64_PROBE_SCRATCH: childScratch },
    });
    let settled = false;
    let watchdogFired = false;
    let forwarded = null;
    const timers = [];
    const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
    // Passed on; a child still alive 5 s later (its thread blocked in wasm) is SIGKILLed.
    const forward = (signal) => {
      forwarded ??= signal;
      try { child.kill(signal); } catch {}
      timers.push(setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000));
    };
    const settle = (code) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      for (const s of SIGNALS) process.off(s, forward);
      resolve(code);
    };
    // A deadline, re-armed in steps: setTimeout clamps a delay over 2^31-1 ms to 1 ms.
    const deadline = Date.now() + ms;
    const arm = () => {
      const left = deadline - Date.now();
      if (left > 0) { timers.push(setTimeout(arm, Math.min(left, 2 ** 31 - 1))); return; }
      watchdogFired = true;
      try { child.kill("SIGKILL"); } catch {}
    };
    arm();
    for (const s of SIGNALS) process.on(s, forward);
    child.on("error", (e) => {
      fail(`SNAPSHOT PROBE FAIL: could not start the probe process (${e?.code ?? e?.message})`);
      settle(1);
    });
    child.on("exit", (code, signal) => {
      if (watchdogFired) {
        fail(`SNAPSHOT PROBE FAIL: watchdog: no verdict within ${ms} ms (lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on)`);
        settle(1);
      } else if (signal) {
        fail(`SNAPSHOT PROBE FAIL: the probe process was killed by ${signal}${forwarded ? ` (${forwarded} passed on by the supervisor)` : ""}`);
        settle(1);
      } else settle(code ?? 1);
    });
  });
}

// The supervised child dies with its supervisor: a supervisor that is itself SIGKILLed (a
// caller's timeout) cannot pass that on, and this thread may be blocked inside
// lean_wasm_compile, so a worker thread watches the parent PID and SIGKILLs this process when
// it changes (the parent died and the child was re-parented).
if (supervisedChild) {
  const guard = new Worker(
    'const { workerData } = require("node:worker_threads"); setInterval(() => { if (process.ppid !== workerData) process.kill(process.pid, "SIGKILL"); }, 250);',
    { eval: true, workerData: process.ppid },
  );
  guard.on("error", () => {});
  guard.unref();
}
const artifactDir = resolveToolPath({
  tool: "snapshot-probe", flag: "artifact", placeholder: "<dir>", value: arg("artifact", null), env: "QED64_LEAN_ARTIFACT",
  legacy: path.join(repoRoot, "pipeline/toolchain/work/build/stage1"), legacyLabel: "pipeline/toolchain/work/build/stage1 under the repo root",
  holds: (dir) => fs.existsSync(path.join(dir, "bin/lean.js")), needs: "bin/lean.js", usage: USAGE,
}).path;
const libDir = resolveToolPath({
  tool: "snapshot-probe", flag: "lib", placeholder: "<tree>", value: arg("lib", null), env: "QED64_LIB_TREE",
  legacy: path.join(repoRoot, "work/lib-tree"), legacyLabel: "work/lib-tree under the repo root", holds: fs.existsSync, usage: USAGE,
}).path;
const leanJs = path.join(artifactDir, "bin/lean.js");

// The runtime expects a .deps sidecar next to the snapshot (the worker writes
// "[]"); stage both into a scratch dir so the real snapshot dir stays clean.
// Removed on every exit, a failed link included (an unreadable or cross-device --snap).
// The supervised child creates the dir its supervisor named (QED64_PROBE_SCRATCH), which the
// supervisor removes too when this process is killed.
const namedScratch = supervisedChild ? process.env.QED64_PROBE_SCRATCH : "";
const scratch = namedScratch ? (fs.mkdirSync(namedScratch, { mode: 0o700 }), namedScratch) : fs.mkdtempSync(path.join(os.tmpdir(), "qed64-snap-probe-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
if (!freshImport) {
  fs.linkSync(snapHost, path.join(scratch, "probe.snap"));
  fs.writeFileSync(path.join(scratch, "probe.snap.deps"), "[]");
}

const asPtr = (v) => (typeof v === "bigint" ? v : BigInt(Math.trunc(v)));
const asNum = (v) => (typeof v === "bigint" ? Number(v) : v);

let M;
const captured = [];
const DUMP = process.argv.includes("--dump-messages");
const capture = (stream) => (v) => {
  if (DUMP && stream === "stdout") console.log(`[lean:stdout] ${v}`);
  captured.push({ stream, text: String(v), at: performance.now() });
};
const ioTag = (res) => Number(M.getValue(asNum(res) + 7, "i8")) & 0xff;
const ioValue = (res) => BigInt(M.getValue(asNum(res) + 8, "i64"));
function mkString(text) {
  const c = M.stringToNewUTF8(text);
  const obj = M._lean_mk_string(asPtr(c));
  M._free(asPtr(c));
  return asPtr(obj);
}

process.chdir("/");
process.argv[1] = "/bin/lean";

// Provide the Memory64 ourselves (as the browser worker does) so --via-mem
// can write snapshot bytes straight into the heap; the glue does not export
// its own memory object.
const sharedMem = new WebAssembly.Memory({ address: "i64", initial: 4096n, maximum: 131072n, shared: true });

globalThis.Module = {
  noInitialRun: true,
  wasmMemory: sharedMem,
  INITIAL_MEMORY: 268435456,
  locateFile: (f) => path.join(path.dirname(leanJs), f),
  mainScriptUrlOrBlob: leanJs,
  print: capture("stdout"),
  printErr: capture("stderr"),
  ENV: {
    LEAN_PATH: "/lib/lean",
    ...(process.env.QED64_PROFILE_INIT ? { QED64_PROFILE_INIT: process.env.QED64_PROFILE_INIT } : {}),
  },
  preRun: [
    function mount() {
      const FS = globalThis.Module.FS;
      const NODEFS = FS.filesystems.NODEFS;
      for (const d of ["/lib/lean", "/workspace", "/bin", "/snapshots"]) {
        let cur = "";
        for (const part of d.split("/").filter(Boolean)) {
          cur += `/${part}`;
          try { FS.mkdir(cur); } catch {}
        }
      }
      FS.mount(NODEFS, { root: libDir }, "/lib/lean");
      FS.mount(NODEFS, { root: scratch }, "/snapshots");
      if (workspaceDir) FS.mount(NODEFS, { root: workspaceDir }, "/workspace");
      FS.chdir("/workspace");
    },
  ],
  onRuntimeInitialized() {
    M = globalThis.Module;
    try {
      M._lean_initialize_runtime_module();
      M._lean_initialize();
      M._lean_io_mark_end_initialization();
      if (M._lean_init_task_manager) M._lean_init_task_manager();
      if (M._lean_enable_initializer_execution) M._lean_enable_initializer_execution();
      const sp = M._lean_init_search_path();
      if (ioTag(sp) !== 0) throw new Error("lean_init_search_path failed");

      let lr, t0;
      if (freshImport) {
        console.log(`== fresh import: no snapshot; the header imports from ${libDir} ==`);
      } else {
      console.log(`== load snapshot: ${path.basename(snapHost)} (${fs.statSync(snapHost).size} bytes) ==`);
      let snapPath = "/snapshots/probe.snap";
      if (viaMemfs) {
        const FS = M.FS;
        const total = fs.statSync(snapHost).size;
        const fd = fs.openSync(snapHost, "r");
        const stream = FS.open("/memsnap.snap", "w");
        try { FS.ftruncate(stream.fd, total); } catch {}
        const CHUNK = 64 * 1024 * 1024;
        const buf = new Uint8Array(CHUNK);
        let at = 0;
        while (at < total) {
          const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, total - at), at);
          FS.write(stream, buf, 0, n, at);
          at += n;
        }
        FS.close(stream);
        fs.closeSync(fd);
        FS.writeFile("/memsnap.snap.deps", new Uint8Array([0x5b, 0x5d]));
        snapPath = "/memsnap.snap";
        console.log(`staged ${total} bytes into MEMFS`);
      }
      t0 = performance.now();
      lr;
      if (viaMem) {
        const total = fs.statSync(snapHost).size;
        const heapPtr = M._malloc(asPtr(total));
        if (!heapPtr) throw new Error("malloc failed");
        const fd2 = fs.openSync(snapHost, "r");
        const CH = 64 * 1024 * 1024;
        const b = new Uint8Array(CH);
        let at2 = 0;
        while (at2 < total) {
          const n = fs.readSync(fd2, b, 0, Math.min(CH, total - at2), at2);
          new Uint8Array(sharedMem.buffer, asNum(heapPtr) + at2, n).set(b.subarray(0, n));
          at2 += n;
        }
        fs.closeSync(fd2);
        console.log(`staged ${total} bytes into the wasm heap`);
        t0 = performance.now();
        const initFlags = BigInt(arg("init-flags", "1"));
        lr = M._lean_wasm_load_snapshot_mem(asPtr(heapPtr), asPtr(total), initFlags);
      } else {
        lr = M._lean_wasm_load_snapshot(mkString(snapPath));
      }
      const loadMs = performance.now() - t0;
      const ltag = ioTag(lr);
      const lval = ioValue(lr);
      const lscalar = (lval & 1n) === 1n ? lval >> 1n : null;
      console.log(`load: tag=${ltag} scalar=${lscalar} elapsed=${loadMs.toFixed(0)}ms`);
      for (const l of captured) {
        if (l.text.includes("WASM PROFILE") || l.text.includes("WASM DEBUG")) {
          console.log(`  [+${((l.at - t0) / 1000).toFixed(1)}s] ${l.text.slice(0, 170)}`);
        }
      }
      if (ltag !== 0 || (lscalar !== null && lscalar !== 0n)) {
        for (const l of captured.slice(-6)) console.error(`  [lean:${l.stream}] ${l.text.slice(0, 300)}`);
        throw new Error("snapshot load reported failure");
      }

      }
      console.log(freshImport ? "== compile the probe with a fresh import ==" : "== compile the probe against the seeded environment ==");
      captured.length = 0;
      t0 = performance.now();
      const cr = M._lean_wasm_compile(mkString(probeSource), mkString("/workspace/input.lean"));
      const compileMs = performance.now() - t0;
      const errors = [];
      for (const l of captured) {
        if (!l.text.startsWith("{")) continue;
        try {
          const v = JSON.parse(l.text);
          if (v && v.severity === "error") errors.push(v.data);
        } catch {}
      }
      console.log(`compile: tag=${ioTag(cr)} elapsed=${compileMs.toFixed(0)}ms errors=${errors.length}`);
      for (const e of errors.slice(0, 3)) console.error(`  error: ${String(e).slice(0, 120)}`);
      if (ioTag(cr) !== 0 || errors.length > 0) throw new Error("probe compile failed");
      if (compileMs > budgetMs) {
        throw new Error(
          `probe compiled in ${compileMs.toFixed(0)}ms > ${budgetMs}ms budget — ` +
            "the snapshot likely seeded the WRONG import-set cache key and the compile re-imported the closure",
        );
      }
      console.log("SNAPSHOT PROBE PASS");
      process.exit(0);
    } catch (error) {
      console.error("SNAPSHOT PROBE FAIL:", error.message || error);
      for (const l of captured.slice(-12)) console.error(`  [lean:${l.stream}] ${l.text.slice(0, 160)}`);
      process.exit(1);
    }
  },
  onAbort(what) {
    console.error("ABORT:", what);
    process.exit(3);
  },
};

globalThis.require = createRequire(leanJs);
globalThis.__filename = "/bin/lean.js";
globalThis.__dirname = "/bin";
vm.runInThisContext(fs.readFileSync(leanJs, "utf8"), { filename: leanJs });
