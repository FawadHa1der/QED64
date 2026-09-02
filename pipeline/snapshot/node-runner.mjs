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

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
fs.mkdirSync(workDir, { recursive: true });

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
