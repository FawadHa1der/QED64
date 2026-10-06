#!/usr/bin/env node
// Release gate for a wasm64 runtime artifact.
//
// DEPRECATED FORWARD (plan B1a): the gate is the fork's package's,
// `lean4-wasm64 gate --artifact <dir>`. This script keeps QED64's path rule
// for --artifact and then replaces itself with the package's gate.mjs, which
// runs its own probes (numBits + rfl smoke, positioned error, the persistent
// path and THE PARSE GATE, module semantics — HARDENING #51), its own runner
// and its own --stack-size. Its output keeps the ` ok `/`FAIL` lines and
// GATE PASSED / GATE FAILED (n); only those markers are parsed downstream.
// Located by LEAN4_WASM64_DIR or the cwd's node_modules/lean4-wasm64 (never
// imported); absent: one line, exit 2.
//
// Usage: node pipeline/toolchain/gate.mjs --artifact <dir>
//   (else $QED64_LEAN_ARTIFACT; the old default, the cwd when it holds
//   bin/lean.js, is deprecated and prints one WARNING; nothing else: exit 2)

import fs from "node:fs";
import path from "node:path";
import { forwardToLean4Wasm64, resolveToolPath } from "./artifact-paths.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const artifact = resolveToolPath({
  tool: "gate", flag: "artifact", placeholder: "<dir>", value: arg("artifact", null), env: "QED64_LEAN_ARTIFACT",
  legacy: process.cwd(), legacyLabel: "the current directory", holds: (dir) => fs.existsSync(path.join(dir, "bin/lean.js")),
  needs: "bin/lean.js", usage: "gate.mjs --artifact <dir>",
}).path;
if (!fs.existsSync(path.join(artifact, "bin/lean.js"))) {
  console.error(`gate: ${artifact}/bin/lean.js not found`);
  process.exit(2);
}

console.error("gate: WARNING — pipeline/toolchain/gate.mjs is deprecated; use lean4-wasm64 gate --artifact <dir> (the fork's package) (docs/CLI-CONTRACT.md)");
forwardToLean4Wasm64("gate", "gate.mjs", ["--artifact", artifact]);
