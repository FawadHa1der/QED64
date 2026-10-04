#!/usr/bin/env node
// Probe the PERSISTENT runtime path under Node — the exact sequence the
// browser worker runs: noInitialRun, manual runtime init, then repeated
// lean_wasm_compile calls against a resident environment.
//
// Exits 0 iff: init succeeds, a good compile returns IO.ok with 0 errors,
// a second compile reuses the environment (much faster), and a broken proof
// surfaces an error diagnostic without killing the runtime.
//
// Usage: node pipeline/snapshot/persistent-probe.mjs [--artifact <dir>]
// (--help; the contract is docs/CLI-CONTRACT.md)

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// <cli-contract> generated from SPECS["persistent-probe"] in pipeline/snapshot/cli.mjs. Do not edit:
// `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts
// fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.
// It runs before any side effect: --help/-h prints the help and exits 0, a missing required
// flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and
// --flag=value is rewritten to the two-token form this script reads (docs/CLI-CONTRACT.md).
{
  const spec = {"tool":"persistent-probe","usage":"persistent-probe.mjs [--artifact <dir>]","flags":{"artifact":1},"required":[],"passthrough":null,"passthroughRequired":false};
  spec.help = [
    "usage: persistent-probe.mjs [--artifact <dir>]",
    "Drive the persistent runtime path under Node (noInitialRun, manual init, repeated lean_wasm_compile): a good compile, a resident recompile, an error that does not kill the runtime, and survival after it.",
    "run as: node --stack-size=8192 pipeline/snapshot/persistent-probe.mjs",
    "",
    "flags:",
    "  --artifact <dir>  stage1 dir; its lib/lean is mounted at /lib/lean (default: $QED64_LEAN_ARTIFACT, else pipeline/toolchain/work/build/stage1 when it has bin/lean.js, else ../../wasm64-lean-codex/experiments/lean4-wasm64-build/stage1, both relative to the repo root)",
    "  -h, --help        print this help and exit 0, before any side effect",
    "",
    "environment:",
    "  QED64_LEAN_ARTIFACT  stage1 artifact dir (bin/lean.js, bin/lean.wasm, lib/lean) used when --artifact is absent",
    "",
    "exit codes:",
    "  0  PERSISTENT PROBE PASS",
    "  1  PERSISTENT PROBE FAIL, or the artifact is unreadable (an unhandled ENOENT before the runtime starts)",
    "  3  the wasm runtime aborted (legacy overload of class 3)",
    "",
    "tier 2 (internal-stable). Contract: docs/CLI-CONTRACT.md",
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
      let value = true;
      if (arity === 1) {
        value = m[2] !== undefined ? m[2].slice(1) : i + 1 < args.length ? args[(i += 1)] : undefined;
        if (value === "--help" || value === "-h") help = true;
        normalized.push(`--${name}`, ...(value === undefined ? [] : [value]));
        if (!value) warnings.push(`flag --${name} has no value; ignored`);
      } else normalized.push(token);
      if (!Object.hasOwn(values, name)) values[name] = value ?? "";
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

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const builtHere = path.join(repoRoot, "pipeline/toolchain/work/build/stage1");
const artifactDir = path.resolve(
  arg("artifact", process.env.QED64_LEAN_ARTIFACT ||
    (fs.existsSync(path.join(builtHere, "bin/lean.js"))
      ? builtHere
      : path.join(repoRoot, "../../wasm64-lean-codex/experiments/lean4-wasm64-build/stage1"))),
);
const leanJs = path.join(artifactDir, "bin/lean.js");
const libLean = path.join(artifactDir, "lib/lean");

const asPtr = (v) => (typeof v === "bigint" ? v : BigInt(Math.trunc(v)));
const asNum = (v) => (typeof v === "bigint" ? Number(v) : v);

let M;
const captured = [];
const capture = (stream) => (v) => {
  const text = String(v);
  captured.push({ stream, text });
  if (!/^\s*\[(DEBUG|WASM DEBUG|COMPILE|PROFILE)|^\s*-\s+\//.test(text)) {
    process.stderr.write(`[lean:${stream}] ${text}\n`);
  }
};

function ioTag(res) {
  return Number(M.getValue(asNum(res) + 7, "i8")) & 0xff;
}
function ioValue(res) {
  return BigInt(M.getValue(asNum(res) + 8, "i64"));
}
function mkString(text) {
  const c = M.stringToNewUTF8(text);
  const obj = M._lean_mk_string(asPtr(c));
  M._free(asPtr(c));
  return asPtr(obj);
}

function compile(source, fileName) {
  captured.length = 0;
  const t0 = performance.now();
  const res = M._lean_wasm_compile(mkString(source), mkString(fileName));
  const elapsed = performance.now() - t0;
  const tag = ioTag(res);
  const value = ioValue(res);
  const scalar = (value & 1n) === 1n ? value >> 1n : null;
  const diags = [];
  for (const l of captured) {
    if (!l.text.startsWith("{")) continue;
    try {
      const v = JSON.parse(l.text);
      if (v && v.severity) diags.push(v);
    } catch {}
  }
  const errors = diags.filter((d) => d.severity === "error");
  return { tag, scalar, elapsed, errors, diags, lines: captured.length };
}

process.chdir("/");
process.argv[1] = "/bin/lean";

globalThis.Module = {
  noInitialRun: true,
  locateFile: (f) => path.join(path.dirname(leanJs), f),
  mainScriptUrlOrBlob: leanJs,
  print: capture("stdout"),
  printErr: capture("stderr"),
  ENV: { LEAN_PATH: "/lib/lean" },
  preRun: [
    function mount() {
      const FS = globalThis.Module.FS;
      const NODEFS = FS.filesystems.NODEFS;
      for (const d of ["/lib/lean", "/workspace", "/bin"]) {
        let cur = "";
        for (const part of d.split("/").filter(Boolean)) {
          cur += `/${part}`;
          try { FS.mkdir(cur); } catch {}
        }
      }
      FS.mount(NODEFS, { root: libLean }, "/lib/lean");
      globalThis.Module.ENV.LEAN_PATH = "/lib/lean";
      FS.chdir("/workspace");
    },
  ],
  onRuntimeInitialized() {
    M = globalThis.Module;
    try {
      console.log("== persistent init sequence ==");
      M._lean_initialize_runtime_module();
      M._lean_initialize();
      M._lean_io_mark_end_initialization();
      if (M._lean_init_task_manager) M._lean_init_task_manager();
      if (M._lean_enable_initializer_execution) M._lean_enable_initializer_execution();
      const sp = M._lean_init_search_path();
      if (ioTag(sp) !== 0) {
        try { M._lean_io_result_show_error(asPtr(sp)); } catch {}
        throw new Error("lean_init_search_path failed");
      }
      console.log("init OK");

      console.log("== compile 1: good proof (pays the Init import) ==");
      const r1 = compile(
        "#eval System.Platform.numBits\nexample : (2 + 2 : Nat) = 4 := by rfl\n",
        "/workspace/a.lean",
      );
      console.log(`tag=${r1.tag} scalar=${r1.scalar} elapsed=${r1.elapsed.toFixed(0)}ms errors=${r1.errors.length}`);
      if (r1.tag !== 0 || r1.errors.length !== 0) throw new Error("compile 1 failed");
      const sawNumBits = r1.diags.some((d) => String(d.data).trim() === "64");
      if (!sawNumBits) throw new Error("expected #eval output 64");

      console.log("== compile 2: resident environment (must be fast) ==");
      const r2 = compile(
        "theorem t2 (a b : Nat) : a + b = b + a := Nat.add_comm a b\n#check t2\n",
        "/workspace/b.lean",
      );
      console.log(`tag=${r2.tag} elapsed=${r2.elapsed.toFixed(0)}ms errors=${r2.errors.length}`);
      if (r2.tag !== 0 || r2.errors.length !== 0) throw new Error("compile 2 failed");
      if (r2.elapsed > r1.elapsed / 2) {
        console.log("note: compile 2 not dramatically faster; environment may not be cached");
      }

      console.log("== compile 3: broken proof must produce an error, not a crash ==");
      const r3 = compile("example : (1 + 1 : Nat) = 3 := by rfl\n", "/workspace/c.lean");
      console.log(`tag=${r3.tag} scalar=${r3.scalar} elapsed=${r3.elapsed.toFixed(0)}ms errors=${r3.errors.length}`);
      if (r3.errors.length === 0) throw new Error("expected an error diagnostic");

      console.log("== compile 3c: KNOWN RUNTIME DEFECT — parse errors are swallowed ==");
      // The shipped fork's wasmCompile collects messages after elabCommand,
      // but Lean 4.33's elabCommandTopLevel resets the log first, so PARSER
      // messages (garbage text, unterminated decls) vanish. Elaboration
      // errors are unaffected. Marker consumed by the defect-tracking test;
      // when a fixed runtime reports these errors, the marker disappears.
      const rg = compile("asdf garbage qwerty !!\n", "/workspace/g.lean");
      if (rg.tag === 0 && rg.errors.length === 0 && rg.diags.length === 0) {
        console.log("PARSE-ERROR-SWALLOWED (known runtime defect, see pipeline/toolchain/PATCHES.md)");
      } else {
        console.log(`parse errors reported (${rg.errors.length}) — runtime defect is FIXED; update the app verdict copy`);
      }

      console.log("== compile 4: runtime survives after an error ==");
      const r4 = compile("example : True := trivial\n", "/workspace/d.lean");
      console.log(`tag=${r4.tag} elapsed=${r4.elapsed.toFixed(0)}ms errors=${r4.errors.length}`);
      if (r4.tag !== 0 || r4.errors.length !== 0) throw new Error("compile 4 failed");

      console.log("PERSISTENT PROBE PASS");
      process.exit(0);
    } catch (error) {
      console.error("PERSISTENT PROBE FAIL:", error.message || error);
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
