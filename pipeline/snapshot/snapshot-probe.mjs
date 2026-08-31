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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const builtHere = path.join(repoRoot, "pipeline/toolchain/work/build/stage1");
const artifactDir = path.resolve(
  arg("artifact", process.env.QED64_LEAN_ARTIFACT || builtHere),
);
const snapHost = path.resolve(arg("snap", ""));
const probeFile = arg("probe-file", "");
const probeSource = probeFile ? fs.readFileSync(path.resolve(probeFile), "utf8") : arg("probe", "");
const libDir = path.resolve(arg("lib", path.join(repoRoot, "work/lib-tree")));
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
if (!snapHost || !probeSource) {
  console.error("usage: snapshot-probe.mjs --snap <file> (--probe-file <file> | --probe <source>)");
  process.exit(2);
}
const leanJs = path.join(artifactDir, "bin/lean.js");

// The runtime expects a .deps sidecar next to the snapshot (the worker writes
// "[]"); stage both into a scratch dir so the real snapshot dir stays clean.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-snap-probe-"));
fs.linkSync(snapHost, path.join(scratch, "probe.snap"));
fs.writeFileSync(path.join(scratch, "probe.snap.deps"), "[]");
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

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
      let t0 = performance.now();
      let lr;
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

      console.log("== compile the probe against the seeded environment ==");
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
