#!/usr/bin/env node
// Release gate for a freshly built wasm64 runtime artifact.
//
// Runs, in order, against --artifact <stage1 dir>:
//  1. numBits smoke      — #eval System.Platform.numBits must print 64
//  2. proof smoke        — a kernel-checked rfl example, exit 0
//  3. error smoke        — a false proof must produce a positioned error
//  4. THE PARSE GATE     — garbage input must produce >=1 error diagnostic
//                          (the defect motivating the rebuild)
//  5. module semantics   — a file without `module` is NOT elaborated as a
//                          module (HARDENING #51): isModule=false, plain defs
//                          public, attributed rpc/tactic/unexpander defs
//                          compile; a `module` file still reports true
// Exits nonzero if any gate fails (all are run).
//
// Usage: node pipeline/toolchain/gate.mjs --artifact <dir>

import { execFileSync, spawnSync } from "node:child_process";
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

// Since the keepalive guard (patch 0020) and the resident transport (0031)
// the one-shot CLI prints its output and then never exits — the Emscripten
// runtime is kept alive for library-style use, which is what the product
// relies on. The CLI checks are therefore judged by OUTPUT: the runner is
// given a bounded budget and killed; `done` marks the child having printed
// its verdict line(s) before the budget ran out. (execFileSync's timeout is
// the reaper: a stability-based reaper would need a streaming child, and the
// 4-minute budget is cheap next to the bakes.)
function runLean(source, label, budgetMs = 240_000) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-gate-"));
  fs.writeFileSync(path.join(work, "input.lean"), source);
  const r = spawnSync("node", [runner, "--artifact", artifact, "--work", work, "--", "/work/input.lean"],
    { timeout: budgetMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL" });
  const timedOut = r.signal === "SIGKILL" || r.signal === "SIGTERM";
  return { stdout: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, status: r.status ?? (timedOut ? 124 : 1), timedOut };
}
/** Lean's own messages in the run's output, DEBUG/PROFILE noise stripped. */
const leanOut = (r) => r.stdout.replace(/\[(DEBUG:PROGRESS|WASM (DEBUG|PROFILE|LSP))\][^\n]*\n?/g, "");
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


// 5. module semantics (HARDENING #51). The three legacy probes share one run;
//    the `module` probe must be a file of its own (the keyword is the header).
const PROBES = path.join(root, "tests/adversarial/kernel-probes");
const legacy = runLean([
  fs.readFileSync(path.join(PROBES, "is-module.lean"), "utf8"),
  fs.readFileSync(path.join(PROBES, "private-default.lean"), "utf8").replace(/^import Lean\n/, ""),
  fs.readFileSync(path.join(PROBES, "rpc-attr.lean"), "utf8").replace(/^import Lean\n/, ""),
].join("\n"));
const legacyOut = leanOut(legacy);
gate(/isModule=false/.test(legacyOut), "legacy file: environment header says isModule=false", /isModule=true/.test(legacyOut) ? "the buffer is elaborated as a module (HARDENING #51)" : "");
gate(/\(`plainDef, false\)/.test(legacyOut) && !/_private\.[^\n]*plainDef/.test(legacyOut), "legacy file: a plain def is public", /_private\.[^\n]*plainDef/.test(legacyOut) ? "plainDef is private by default" : "");
gate(!/must be marked as `meta`|must be public|error/i.test(legacyOut), "legacy file: @[server_rpc_method], attribute [tactic …], @[app_unexpander] on plain defs compile",
  (legacyOut.match(/[^\n]*(must be marked as `meta`|must be public)[^\n]*/) || [""])[0].slice(0, 120));
const modFile = runLean(fs.readFileSync(path.join(PROBES, "module-file.lean"), "utf8"));
gate(/isModule=true/.test(leanOut(modFile)), "module file: environment header says isModule=true");

console.log(failures === 0 ? "\nGATE PASSED" : `\nGATE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
