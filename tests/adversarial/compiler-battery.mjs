#!/usr/bin/env node
// Adversarial compiler battery: run corpus sources against the slim Mathlib
// snapshot through the SAME wasm runtime the browser ships (snapshot-probe,
// --via-mem), in a bounded parallel pool. Checks per item:
//   - no PANIC / assertion violation anywhere in the run's output
//   - mustError / mustSucceed expectations
//   - containsMsgs substrings appear in compiler messages
//   - wall-clock budget
// Each row carries an outcome ∈ {pass, fail, infra}. `infra` is decided from
// the HARNESS'S OWN inputs and lines (review C7), never from the compiler's
// message text: Lean's message for an unresolvable import is literally
// "unknown module prefix 'X'\n\nNo directory 'X' or file 'X.olean' in the
// search path entries" (Lean/Util/Path.lean), so a text match on "No
// directory" classified four mustError header items as environment and
// refused a green battery. Infra is: a missing snapshot / artifact before any
// probe spawns (every row infra), a spawn error, or a probe that died before
// its first compile line without a wasm panic. An infra-only battery exits 3
// (refused), never 1 (product failure).
// Usage: node tests/adversarial/compiler-battery.mjs [--corpus <file>] [--jobs 3] [--run-dir <dir>]
//          [--snap <mathlib.snap>] [--artifact <stage1>] [--lib <tree>]
// The pairing under test: each flag, else QED64_MATHLIB_SNAP / QED64_LEAN_ARTIFACT /
// QED64_LIB_TREE, else (deprecated, one WARNING each) this checkout's
// work/snapshot/mathlib.snap, pipeline/toolchain/work/build/stage1 and
// work/lib-tree-slim; a deprecated default that is absent exits 2 with the usage
// line (docs/CLI-CONTRACT.md "Path resolution"). That refusal still leaves a
// record: compiler.log in --run-dir and a fresh all-infra compiler-report.json
// (work/adversarial/ and the run dir) whose rows carry the no-path line, so no
// reader sees an older run's tally as this one's. An explicit input that is
// missing is still the all-infra refusal below (exit 3).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveToolPath } from "../../pipeline/toolchain/artifact-paths.mjs";
import { arg, root, teeLog } from "./harness.mjs";

const USAGE = "compiler-battery.mjs [--corpus <file>] [--jobs 3] [--run-dir <dir>] [--snap <mathlib.snap>] [--artifact <stage1>] [--lib <tree>]";

/** The battery's pairing (snapshot, runtime, olean tree) by the one path
 * rule; `io` and `base` are the tests' (a scratch checkout root). */
export function batteryInputs(get = arg, base = root, io = undefined) {
  const one = (flag, placeholder, env, rel, holds) => resolveToolPath({
    tool: "compiler-battery", flag, placeholder, value: get(flag, null), env,
    legacy: path.join(base, rel), legacyLabel: `${rel} under the repo root`, holds, usage: USAGE,
  }, io)?.path;
  const snap = one("snap", "<file>", "QED64_MATHLIB_SNAP", "work/snapshot/mathlib.snap", fs.existsSync);
  const artifact = snap && one("artifact", "<dir>", "QED64_LEAN_ARTIFACT", "pipeline/toolchain/work/build/stage1", (d) => fs.existsSync(path.join(d, "bin/lean.wasm")));
  const lib = artifact && one("lib", "<tree>", "QED64_LIB_TREE", "work/lib-tree-slim", fs.existsSync);
  return lib ? { snap, artifact, lib } : null;
}

/** The probe's inputs that must exist before a single row can be a verdict:
 * returns the missing paths (empty = all present). */
export function missingInputs({ snap, artifact }) {
  return [snap, path.join(artifact, "bin/lean.wasm")].filter((p) => !fs.existsSync(p));
}

/** Pure verdict for one item from the probe's captured output. `code` is the
 * child's exit code (null = killed), `spawnError` the child 'error' event
 * (ENOENT/EACCES: the harness could not even start node), `budget` the
 * item's compile budget in ms. Exported so tests/unit/adversarial-harness.test.ts
 * can pin it against synthetic probe output. */
export function classify(item, { out, code, wallMs, budget, spawnError = null }) {
  const row = (outcome, failures, extra = {}) => ({
    name: item.name, category: item.category, wallMs, outcome, pass: outcome === "pass", failures,
    excerpt: outcome === "pass" ? undefined : out.slice(-600), ...extra,
  });
  const msgs = [...out.matchAll(/\{"caption":.*/g)].map((m) => m[0]);
  const msgText = msgs.join("\n");
  const panic = /PANIC at|assertion violation|Maximum call stack|INTERNAL PANIC/.test(out);
  if (spawnError) return row("infra", [`infra: spawn failed (${spawnError.code ?? spawnError.message})`]);
  // Died before the probe reached its compile step (snapshot load failed,
  // node crashed, artifact unreadable) and nothing in the output is a wasm
  // panic: the environment, not the compiler, produced this row.
  const reachedCompile = msgs.length > 0 || /compile: tag=/.test(out);
  if (code !== 0 && code !== null && !reachedCompile && !panic) {
    const why = (/SNAPSHOT PROBE FAIL: .*|ABORT: .*|Error: .*/.exec(out) || [`exit ${code} before the compile step`])[0];
    return row("infra", [`infra: ${why.slice(0, 160)}`]);
  }
  // "No directory|does not exist" are the compiler's own unresolvable-import
  // wording (mustError items depend on them), NOT an environment signal.
  const hasError = /"severity":\s*2|"kind":"error"|errors=[1-9]\d*/.test(out)
    || /compile: tag=1|probe compile failed|returned an IO error|No directory|does not exist/.test(out);
  const failures = [];
  if (item.expect.panicFree && panic && !item.expect.knownPanic) failures.push("PANIC detected in output");
  const knownPanicNote = panic && item.expect.knownPanic ? "known-panic (tracked upstream)" : undefined;
  if (item.expect.mustError && !hasError) failures.push("expected errors, saw none");
  if (item.expect.mustSucceed && hasError) failures.push("expected success, saw errors");
  for (const frag of item.expect.containsMsgs ?? []) {
    if (!msgText.includes(frag) && !out.includes(frag)) failures.push(`missing message fragment: ${JSON.stringify(frag)}`);
  }
  // Snapshot load adds ~10-15 s of fixed overhead per probe process; the
  // budget applies to the whole run minus that allowance.
  if (wallMs > budget + 45000) failures.push(`over budget: ${wallMs}ms (budget ${budget}ms + load allowance)`);
  if (code === null) failures.push("killed (hang)");
  if (/snapshot probe crashed|Worker unrecoverable|unwind/i.test(out)) failures.push("runtime crashed");
  return row(failures.length ? "fail" : "pass", failures, { note: knownPanicNote });
}

// The four umbrella aliases (Mathlib, Mathlib.Tactic, Batteries, MIL.Common)
// are served "covered" by the QED64.Essential environment in the browser —
// the kernel's setupImports resolver (patch 0032) does that. This lane drives
// the batch compile path (`lean_wasm_compile`), whose environment cache keys
// EXACTLY, so the alias is rewritten to the umbrella's own key here: the
// battery then elaborates the same environment the resident page serves.
export function rewriteAliases(src) {
  let first = true;
  return src.split("\n").map((l) => {
    const m = /^(\s*)import\s+(Mathlib|Mathlib\.Tactic|Batteries|MIL\.Common)\s*$/.exec(l);
    if (!m) return l;
    if (first) { first = false; return `${m[1]}import QED64.Essential`; }
    return `-- ${l}`;
  }).join("\n");
}

/** One all-infra row per corpus item (nothing was spawned): `why` is the reason. */
const infraRows = (corpus, why) => corpus.map((item) => ({ name: item.name, category: item.category, wallMs: 0, outcome: "infra", pass: false, failures: [why] }));

/** The report, written fresh to work/adversarial/ and (with --run-dir) the run dir. */
function writeReport(dir, results, extra = {}) {
  const failed = results.filter((r) => r.outcome !== "pass");
  const infra = results.filter((r) => r.outcome === "infra").length;
  const text = JSON.stringify({ lane: "compiler", total: results.length, failed: failed.length, infra, ...extra, results }, null, 2);
  fs.mkdirSync(path.join(root, "work/adversarial"), { recursive: true });
  fs.writeFileSync(path.join(root, "work/adversarial/compiler-report.json"), text);
  if (dir) fs.writeFileSync(path.join(dir, "compiler-report.json"), text);
  return { failed: failed.length, infra };
}

async function main() {
  // The run dir and its log first: every line below, a refusal's included, reaches compiler.log.
  const dir = arg("run-dir", "");
  if (dir) { fs.mkdirSync(dir, { recursive: true }); teeLog(dir, "compiler.log"); }
  const corpusPath = arg("corpus", path.join(root, "tests/adversarial/corpus.json"));
  const jobs = Number(arg("jobs", "3"));
  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8")).items
    .filter((it) => typeof it.source === "string" && it.source.length > 0 && !(it.actions && it.actions.length));
  // The olean tree is the one the snapshot was baked from (a staged pairing brings its own).
  // No pairing resolved: the rule's exit 2, after a fresh all-infra report naming why.
  const said = [];
  let refusal = null;
  const inputs = batteryInputs(arg, root, { err: (l) => { said.push(l); console.error(l); }, exit: (c) => { refusal = c; }, environment: process.env });
  if (!inputs) {
    const why = said.find((l) => / no --\S+ given /.test(l)) ?? "no pairing resolved";
    writeReport(dir, infraRows(corpus, `infra: ${why}`), { refused: why });
    console.error(`compiler battery: REFUSED — ${why}`);
    process.exit(refusal ?? 2);
  }
  const { snap, artifact, lib } = inputs;
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(root, "work/adv-"));

  function runOne(item) {
    return new Promise((resolve) => {
      const file = path.join(scratch, `${item.name.replace(/[^\w.-]/g, "_")}.lean`);
      const src = rewriteAliases(item.source);
      fs.writeFileSync(file, src.endsWith("\n") ? src : src + "\n");
      const budget = Math.min(item.expect.budgetMs ?? 20000, 120000);
      const t0 = Date.now();
      // --watchdog-ms 0: the probe runs in this child, not under its own supervisor, because the
      // killer below SIGKILLs this PID; a supervisor cannot pass a SIGKILL on, and its child would
      // hold the pipes open, so 'close' would never fire.
      const child = spawn("node", ["--stack-size=8192", path.join(root, "pipeline/snapshot/snapshot-probe.mjs"),
        "--snap", snap, "--probe-file", file, "--budget-ms", String(budget + 30000),
        "--via-mem", "--init-flags", "1", "--artifact", artifact,
        "--lib", lib, "--dump-messages", "--watchdog-ms", "0"], { cwd: root });
      let out = "";
      let spawnError = null;
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("error", (e) => { spawnError = e; });
      const killer = setTimeout(() => { child.kill("SIGKILL"); }, budget + 60000);
      child.on("close", (code) => {
        clearTimeout(killer);
        resolve(classify(item, { out, code, wallMs: Date.now() - t0, budget, spawnError }));
      });
    });
  }

  const results = [];
  // Inputs first: without the snapshot or the runtime no probe can produce a
  // verdict, so every item is one `infra` row and nothing is spawned.
  const missing = missingInputs({ snap, artifact });
  if (missing.length) {
    results.push(...infraRows(corpus, `infra: missing ${missing.join(", ")}`));
    console.error(`compiler battery: REFUSED — missing ${missing.join(", ")}`);
  } else {
    const queue = [...corpus];
    async function workerLoop() {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const r = await runOne(item);
        results.push(r);
        console.log(`${r.outcome === "pass" ? "ok  " : r.outcome.toUpperCase().padEnd(4)} ${r.name} (${r.wallMs}ms)${r.pass ? "" : " — " + r.failures.join("; ")}`);
      }
    }
    await Promise.all(Array.from({ length: jobs }, workerLoop));
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  const { failed, infra } = writeReport(dir, results);
  console.log(`\ncompiler battery: ${results.length - failed}/${results.length} passed${infra ? ` (${infra} infra)` : ""}`);
  // Product failures → 1; infra-only failures → 3 (the run is not a verdict).
  process.exit(failed === 0 ? 0 : failed === infra ? 3 : 1);
}

// Only the CLI runs the battery; vitest imports the classifier.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
