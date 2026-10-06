#!/usr/bin/env node
// Chunk a built lean.js/lean.wasm pair into the app's verified runtime layout:
// ≤16 MiB SHA-256-addressed parts under <out>/chunks plus a
// runtime-manifest.json carrying per-chunk and whole-file identities.
//
// DEPRECATED FORWARD (contract 3, plan B2a): the chunker is the fork's
// package's, `lean4-wasm64 chunk --bin <dir> --out <dir> --lean-version <x.y.z>
// --revision <string>` (byte-identical output; its tests pin the manifest
// bytes). This script keeps QED64's front half — the contract prelude, the
// buildId (runtimeBuildId of <bin>/lean.wasm), the --out path rule and the
// refusal inside public/, the no-version and no-revision WARNINGs and their
// defaults — then prints one deprecation WARNING and replaces itself with the
// package's chunk-runtime.mjs, handing it all four flags. --upstream-base is
// accepted but never forwarded (it only feeds the default --revision).
// Located by LEAN4_WASM64_DIR or the cwd's node_modules/lean4-wasm64 (never
// imported); absent: one line, exit 2.
//
// The output is a STAGING tree (work/staging/<buildId>/runtime by default),
// never public/: the chunker once ran with `--out public/runtime`, rewrote the
// tracked default manifest and destroyed the served (gitignored) chunks
// (HARDENING #32, review C6). Promotion into public/ is a separate, additive
// step: `npm run promote:staging -- --staging work/staging/<buildId>`. A
// release-adopted runtime is not chunked at all: adopt-release.sh stages the
// release's own chunks.
//
// Usage:
//   node pipeline/toolchain/chunk-runtime.mjs --bin <dir with lean.js+lean.wasm> \
//        [--lean-version 4.33.0-pre] [--revision <githash>] [--upstream-base 5732b84] \
//        [--out work/staging/<buildId>/runtime]
//
// --lean-version is what the product bar shows and what promote-staging pairs
// the library packs against (profiles/index.json runtime.leanVersion, each
// pack's content.lean.version): omitting it is a loud warning, not an error.
// --out: else <$QED64_STAGING>/<buildId>/runtime, else (deprecated, one
// WARNING) work/staging/<buildId>/runtime under the repo root.
// (--help; the contract is docs/CLI-CONTRACT.md)

import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forwardToLean4Wasm64, refuseInsidePublic, resolveToolPath, runtimeBuildId, stagingDir } from "./artifact-paths.mjs";

// <cli-contract> generated from SPECS["chunk-runtime"] in pipeline/snapshot/cli.mjs. Do not edit:
// `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts
// fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.
// It runs before any side effect: --help/-h prints the help and exits 0, a missing required
// flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and
// --flag=value is rewritten to the two-token form this script reads, with the later values
// of a repeated flag dropped so the first wins here too (docs/CLI-CONTRACT.md).
{
  const spec = {"tool":"chunk-runtime","usage":"chunk-runtime.mjs --bin <dir> [--lean-version v] [--revision sha] [--upstream-base sha] [--out dir]","flags":{"bin":1,"lean-version":1,"revision":1,"upstream-base":1,"out":1},"required":[["bin"]],"passthrough":null,"passthroughRequired":false};
  spec.help = [
    "usage: chunk-runtime.mjs --bin <dir> [--lean-version v] [--revision sha] [--upstream-base sha] [--out dir]",
    "Chunk a built lean.js/lean.wasm pair into the verified runtime layout (16 MiB sha256-addressed parts + runtime-manifest.json and runtime-manifest.<buildId>.json) in a staging dir; additive, never inside public/. Deprecated forward (contract 3): after the path rule, the public/ refusal and the WARNINGs it prints one deprecation WARNING and runs lean4-wasm64 chunk with --bin, --out, --lean-version and --revision.",
    "run as: node pipeline/toolchain/chunk-runtime.mjs",
    "",
    "flags:",
    "  --bin <dir>               dir holding lean.js + lean.wasm [required]",
    "  --lean-version <x.y.z>    the manifest's leanVersion; promote pairs packs against it (default: 4.33.0-pre, with a WARNING on stderr)",
    "  --revision <string>       the manifest's sourceRevision (default: qed64-wasm64@<HEAD of pipeline/toolchain/work/lean4, relative to the cwd> (base <upstream-base>), else unspecified; git runs only when --revision is absent)",
    "  --upstream-base <sha|tag>",
    "                            the upstream base named in the default --revision (default: 5732b84)",
    "  --out <dir>               staging dir; refused inside public/; a relative --out resolves against the repo root (default: $QED64_STAGING, else (deprecated, one WARNING) work/staging/<buildId>/runtime under the repo root; with QED64_STAGING, <QED64_STAGING>/<buildId>/runtime)",
    "  -h, --help                print this help and exit 0, before any side effect",
    "",
    "environment:",
    "  QED64_STAGING     the staging root used when --out is absent: --out is <QED64_STAGING>/<buildId>/{snapshots,runtime}",
    "  LEAN4_WASM64_DIR  the lean4-wasm64 package dir the forwards run (unpack, chunk-runtime, and the tier-3 inspect and gate); unset: the first node_modules/lean4-wasm64 above the cwd",
    "",
    "exit codes:",
    "  0  chunked",
    "  1  a crash (lean.wasm unreadable under --bin, or the package's chunker failed)",
    "  2  usage, --out inside public/, or lean4-wasm64 not found (set LEAN4_WASM64_DIR or install the devDependency)",
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const binDir = path.resolve(arg("bin", ""));
const DEFAULT_LEAN_VERSION = "4.33.0-pre";
const leanVersion = arg("lean-version", null) ?? DEFAULT_LEAN_VERSION;
if (arg("lean-version", null) === null) {
  console.error(
    `chunk-runtime: WARNING — no --lean-version given; the manifest will say Lean ${DEFAULT_LEAN_VERSION}.\n` +
      "  After a version import that is WRONG: the page shows it, and promote-staging refuses a runtime whose\n" +
      "  leanVersion differs from the packs'. Pass --lean-version <x.y.z>.",
  );
}
// Default the source revision to the fork checkout that (by the old
// build-then-chunk sequence) produced the binary being chunked. The upstream
// base is the lean4 commit the qed64-wasm64 branch sits on: 5732b84 for the
// 4.33.0-pre line; --upstream-base <tag or sha> names another. Only the
// default --revision string uses it — an explicit --revision wins.
const UPSTREAM_BASE = arg("upstream-base", "5732b84");
function forkRevision() {
  try {
    const head = execSync("git -C pipeline/toolchain/work/lean4 rev-parse --short=9 HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return `qed64-wasm64@${head} (base ${UPSTREAM_BASE})`;
  } catch {
    return "unspecified";
  }
}
// Lazy: git runs only when the default is needed (an explicit --revision touches no checkout).
const revision = arg("revision", null) ?? forkRevision();
if (!binDir) {
  console.error("usage: chunk-runtime.mjs --bin <dir> [--lean-version v] [--revision sha] [--upstream-base sha] [--out dir]");
  process.exit(2);
}
// The default revision describes pipeline/toolchain/work/lean4. For a binary
// built anywhere else that checkout is NOT the compiler that produced it —
// say so rather than record it quietly.
if (arg("revision", null) === null && path.relative(path.join(root, "pipeline/toolchain/work"), binDir).startsWith("..")) {
  console.error(
    `chunk-runtime: WARNING — no --revision given for a binary outside pipeline/toolchain/work; sourceRevision will be "${revision}",\n` +
      "  which describes pipeline/toolchain/work/lean4, not this build. Pass --revision \"qed64-wasm64@<built commit> (base <upstream>)\".",
  );
}

const buildId = runtimeBuildId(fs.readFileSync(path.join(binDir, "lean.wasm")));
// The staging default is keyed by the build so two chunk runs never share a
// tree; an explicit --out inside public/ is refused before anything is written.
const outDir = resolveToolPath({
  tool: "chunk-runtime", flag: "out", placeholder: "<dir>", value: arg("out", null), base: root,
  env: "QED64_STAGING", envTo: (staging) => path.join(staging, buildId, "runtime"),
  legacy: stagingDir(root, buildId, "runtime"), legacyLabel: "work/staging/<buildId>/runtime under the repo root",
  usage: "chunk-runtime.mjs --bin <dir> [--lean-version v] [--revision sha] [--upstream-base sha] [--out dir]",
}).path;
refuseInsidePublic(root, outDir, "chunk-runtime");

console.error("chunk-runtime: WARNING — pipeline/toolchain/chunk-runtime.mjs is deprecated; use lean4-wasm64 chunk --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string> (the fork's package) (docs/CLI-CONTRACT.md)");
forwardToLean4Wasm64("chunk-runtime", "chunk-runtime.mjs", ["--bin", binDir, "--out", outDir, "--lean-version", leanVersion, "--revision", revision]);
