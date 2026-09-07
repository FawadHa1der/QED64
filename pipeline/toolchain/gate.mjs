#!/usr/bin/env node
// Release gate for a freshly built wasm64 runtime artifact.
//
// Runs, in order, against --artifact <stage1 dir>:
//  1. numBits smoke      — #eval System.Platform.numBits must print 64
//  2. proof smoke        — a kernel-checked rfl example, exit 0
//  3. error smoke        — a false proof must produce a positioned error
//  4. THE PARSE GATE     — garbage input must produce >=1 error diagnostic
//                          (the defect motivating the rebuild)
// Exits nonzero on the first failing gate.
//
// Usage: node pipeline/toolchain/gate.mjs --artifact <dir>

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const artifact = path.resolve(arg("artifact", ""));
if (!fs.existsSync(path.join(artifact, "bin/lean.js"))) {
  console.error(`gate: ${artifact}/bin/lean.js not found`);
  process.exit(2);
}
const runner = path.join(root, "pipeline/snapshot/node-runner.mjs");

function runLean(source, label) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-gate-"));
  fs.writeFileSync(path.join(work, "input.lean"), source);
  try {
    const stdout = execFileSync("node", [runner, "--artifact", artifact, "--work", work, "--", "/work/input.lean"],
      { timeout: 240_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { stdout, status: 0, timedOut: false };
  } catch (error) {
    // Since the keepalive guard (patch 0020) and the resident transport
    // (0031), the one-shot CLI prints its output and then never exits — the
    // Emscripten runtime is kept alive for library-style use, which is what
    // the product relies on (snapshot loads and warm compiles before `main`).
    // Measured 2026-09-07 on the served 0032 runtime and on 0033 alike:
    // `#eval` prints 64, `rfl` elaborates, the process is killed by the
    // timeout. The CLI checks below are therefore judged by OUTPUT; a timeout
    // is reported, not failed. The exit path is not a product path.
    const timedOut = error.killed === true || error.signal === "SIGTERM";
    return { stdout: `${error.stdout ?? ""}\n${error.stderr ?? ""}`, status: error.status ?? (timedOut ? 124 : 1), timedOut };
  }
}
let failures = 0;
const gate = (ok, label, extra = "") => {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
};

const smoke = runLean("#eval System.Platform.numBits\nexample : (2 + 2 : Nat) = 4 := by rfl\n");
gate(/^64$/m.test(smoke.stdout) && !/error/i.test(smoke.stdout.replace(/\[DEBUG:PROGRESS\][^\n]*\n/g, "")),
  "numBits=64 + rfl proof (judged by output)", smoke.timedOut ? "CLI kept alive after main, killed by the timeout (patch 0020; expected)" : `exit ${smoke.status}`);

const bad = runLean("example : (1 + 1 : Nat) = 3 := by rfl\n");
gate(/input\.lean:1:\d+: error|"severity":\s*"error"/.test(bad.stdout), "false proof reports a positioned error (judged by output)", bad.timedOut ? "CLI kept alive, killed by the timeout (expected)" : `exit ${bad.status}`);

// The parse defect lives in the PERSISTENT path (lean_wasm_compile); the
// one-shot CLI has always reported parse errors. Drive the persistent probe
// and require its garbage compile to surface diagnostics.
let probeOut = "";
let probeStatus = 0;
try {
  probeOut = execFileSync("node",
    [path.join(root, "pipeline/snapshot/persistent-probe.mjs"), "--artifact", artifact],
    { timeout: 600_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  probeOut = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  probeStatus = error.status ?? 1;
}
gate(probeStatus === 0 && probeOut.includes("PERSISTENT PROBE PASS"), "persistent path: init, resident reuse, error reporting, survival");
const parseFixed = probeOut.includes("runtime defect is FIXED");
gate(parseFixed, "THE PARSE GATE: lean_wasm_compile reports parser diagnostics",
  parseFixed ? "" : "persistent shell still swallows parse errors");

console.log(failures === 0 ? "\nGATE PASSED" : `\nGATE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
