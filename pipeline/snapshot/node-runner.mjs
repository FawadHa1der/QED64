#!/usr/bin/env node
// Run the wasm64 Lean CLI under Node with real-filesystem access.
//
// The browser workers mount WORKERFS packs; this driver mounts the host
// filesystem through NODEFS instead, so pipeline jobs (snapshot baking,
// integration tests, artifact probes) can run the exact runtime bytes that
// ship to browsers. Node 24+ has Memory64 on by default.
//
// The vm.runInThisContext + global-Module pattern (instead of require) and
// the argv[0]/cwd adjustments follow the proven cauli-project Node runner:
// the Emscripten glue expects `var Module` at global scope and derives the
// Lean sysroot from the virtual executable path.
//
// Usage:
//   node pipeline/snapshot/node-runner.mjs [--artifact <dir>] [--work <dir>] [--] <lean args...>
//
//   <dir> must contain bin/lean.js + bin/lean.wasm and lib/lean (the olean tree).
//   Default: $QED64_LEAN_ARTIFACT, else the sibling wasm64-lean-codex stage1 build.
//   The work dir is mounted at /work (read-write); the artifact library tree is
//   mounted read-only in practice (Lean only reads it) at /lib/lean.
//   --help/-h among the runner's own flags prints the runner's help; Lean's
//   own help is `-- --help` (docs/CLI-CONTRACT.md).

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// <cli-contract> generated from SPECS["node-runner"] in pipeline/snapshot/cli.mjs. Do not edit:
// `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts
// fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.
// It runs before any side effect: --help/-h prints the help and exits 0, a missing required
// flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and
// --flag=value is rewritten to the two-token form this script reads (docs/CLI-CONTRACT.md).
{
  const spec = {"tool":"node-runner","usage":"node-runner.mjs [--artifact <dir>] [--work <dir>] [--lib <dir>] [--] <lean args...>","flags":{"artifact":1,"work":1,"lib":1},"required":[],"passthrough":"implicit","passthroughRequired":false};
  spec.help = [
    "usage: node-runner.mjs [--artifact <dir>] [--work <dir>] [--lib <dir>] [--] <lean args...>",
    "Run the wasm64 Lean CLI under Node with the host filesystem mounted (NODEFS): --work at /work (the cwd), the library tree at /lib/lean. Since patches 0020/0031 the CLI does its work and then never exits: callers judge it by output (supervised-run) or reap it.",
    "run as: node --stack-size=8192 pipeline/snapshot/node-runner.mjs (or npm run runner -- …)",
    "",
    "flags:",
    "  --artifact <dir>  stage1 dir holding bin/lean.js, bin/lean.wasm and lib/lean (default: $QED64_LEAN_ARTIFACT, else pipeline/toolchain/work/build/stage1 when it has bin/lean.js, else ../../wasm64-lean-codex/experiments/lean4-wasm64-build/stage1, both relative to the repo root)",
    "  --work <dir>      host dir mounted read-write at /work, Lean's cwd; created when absent (default: work/runner under the repo root)",
    "  --lib <dir>       olean tree mounted at /lib/lean, e.g. an unpacked profile pack for bakes (default: <artifact>/lib/lean)",
    "  -h, --help        print this help and exit 0, before any side effect",
    "",
    "arguments: Lean's own arguments: everything after --, or from the first token that is not a runner flag (`-- --help` asks Lean, whose process then never exits)",
    "",
    "environment:",
    "  QED64_LEAN_ARTIFACT       stage1 artifact dir (bin/lean.js, bin/lean.wasm, lib/lean) used when --artifact is absent",
    "  LEAN_COMPACTOR_RESERVE    bytes the compactor reserves up front for a whole-environment save (toolchain patch 0011)",
    "  QED64_ALLOW_LEGACY_IMPORTS",
    "                            when set, lets the exported-level env cache load legacy non-module packages (patch 0030; the lean4game bakes)",
    "  QED64_PROFILE_INIT        when set, forwarded into the wasm environment to profile the [init] replay",
    "",
    "exit codes:",
    "  0  Lean exited 0 (rare since patch 0031: the process normally stays alive after main returns)",
    "  1  Lean's own non-zero exit code, passed through when the process does exit",
    "  2  lean.js or the library tree not found",
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

function parseArgs(argv) {
  const out = { artifact: null, work: null, lib: null, leanArgs: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--artifact") {
      out.artifact = argv[i + 1];
      i += 2;
    } else if (a === "--lib") {
      out.lib = argv[i + 1];
      i += 2;
    } else if (a === "--work") {
      out.work = argv[i + 1];
      i += 2;
    } else if (a === "--") {
      out.leanArgs = argv.slice(i + 1);
      break;
    } else {
      out.leanArgs = argv.slice(i);
      break;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const builtHere = path.join(repoRoot, "pipeline/toolchain/work/build/stage1");
const artifactDir = path.resolve(
  args.artifact ||
    process.env.QED64_LEAN_ARTIFACT ||
    (fs.existsSync(path.join(builtHere, "bin/lean.js"))
      ? builtHere
      : path.join(repoRoot, "../../wasm64-lean-codex/experiments/lean4-wasm64-build/stage1")),
);
const workDir = path.resolve(args.work || path.join(repoRoot, "work/runner"));

const leanJs = path.join(artifactDir, "bin/lean.js");
// --lib overrides the library tree (e.g. an unpacked profile pack) so bakes
// run against exactly the artifact set the browser mounts.
const libLean = args.lib ? path.resolve(args.lib) : path.join(artifactDir, "lib/lean");
if (!fs.existsSync(leanJs)) {
  console.error(`error: ${leanJs} not found — pass --artifact or set QED64_LEAN_ARTIFACT`);
  process.exit(2);
}
if (!fs.existsSync(libLean)) {
  console.error(`error: ${libLean} not found`);
  process.exit(2);
}
// Created only once the inputs are known to exist: a refused run (exit 2)
// leaves the filesystem as it found it (docs/CLI-CONTRACT.md, exit class 2).
fs.mkdirSync(workDir, { recursive: true });

// The glue chdirs the virtual FS to the host cwd during startup; only '/' is
// guaranteed to exist in the virtual tree, so pin the host cwd to '/'.
process.chdir("/");
// Emscripten forwards process.argv[1] as argv[0]; present the virtual install
// layout so Lean derives /lib/lean as its sysroot.
process.argv[1] = "/bin/lean";

globalThis.Module = {
  arguments: args.leanArgs,
  locateFile: (file) => path.join(path.dirname(leanJs), file),
  mainScriptUrlOrBlob: leanJs,
  preRun: [
    function mountHost() {
      const FS = globalThis.Module.FS;
      const NODEFS = FS.filesystems.NODEFS;
      const mkdirTree = (p) => {
        let cur = "";
        for (const part of p.split("/").filter(Boolean)) {
          cur += `/${part}`;
          try {
            FS.mkdir(cur);
          } catch {
            /* exists */
          }
        }
      };
      for (const dir of ["/lib/lean", "/work", "/bin", "/workspace"]) mkdirTree(dir);
      FS.mount(NODEFS, { root: libLean }, "/lib/lean");
      FS.mount(NODEFS, { root: workDir }, "/work");
      // Patch 0031 runs main on a pthread whose Node context derives the app
      // path from HOST argv; Lean then stats that host path inside the VFS.
      // Mirror the stage1 tree at its own host path so discovery succeeds.
      mkdirTree(artifactDir);
      try { FS.mount(NODEFS, { root: artifactDir }, artifactDir); } catch { /* mounted */ }
      globalThis.Module.ENV.LEAN_PATH = "/lib/lean";
      // Game packages (lean4game ecosystem) are legacy non-`module` Lean
      // packages; patch 0030's gate lets the exported-level wasm env cache
      // load their self-contained oleans. Opt-in via host env, mirrored here.
      if (process.env.QED64_ALLOW_LEGACY_IMPORTS) {
        globalThis.Module.ENV.QED64_ALLOW_LEGACY_IMPORTS = "1";
      }
      // Whole-environment saves need the region buffer reserved up front (see
      // toolchain patch 0011); the bake passes the size through this env var.
      if (process.env.LEAN_COMPACTOR_RESERVE) {
        globalThis.Module.ENV.LEAN_COMPACTOR_RESERVE = process.env.LEAN_COMPACTOR_RESERVE;
      }
      if (process.env.QED64_PROFILE_INIT) {
        globalThis.Module.ENV.QED64_PROFILE_INIT = process.env.QED64_PROFILE_INIT;
      }
      FS.chdir("/work");
    },
  ],
  onExit: (code) => {
    process.exitCode = code;
  },
  onAbort: (what) => {
    console.error("ABORT:", what);
    process.exit(3);
  },
};

// CommonJS facilities the glue expects at script scope.
globalThis.require = createRequire(leanJs);
globalThis.__filename = "/bin/lean.js";
globalThis.__dirname = "/bin";

vm.runInThisContext(fs.readFileSync(leanJs, "utf8"), { filename: leanJs });
