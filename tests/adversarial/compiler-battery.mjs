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
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, root, teeLog } from "./harness.mjs";

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

// Mirror the production shim's alias rewrite: the browser rewrites the first
// umbrella-alias import to QED64.Essential before the worker ever sees it, so
// the battery must test the same text the runtime actually receives.
export function rewriteAliases(src) {
  let first = true;
  return src.split("\n").map((l) => {
    const m = /^(\s*)import\s+(Mathlib|Mathlib\.Tactic|Batteries|MIL\.Common)\s*$/.exec(l);
    if (!m) return l;
    if (first) { first = false; return `${m[1]}import QED64.Essential`; }
    return `-- ${l}`;
  }).join("\n");
}

async function main() {
  const corpusPath = arg("corpus", path.join(root, "tests/adversarial/corpus.json"));
  const jobs = Number(arg("jobs", "3"));
  const snap = arg("snap", path.join(root, "work/snapshot/mathlib.snap"));
  const artifact = arg("artifact", path.join(root, "pipeline/toolchain/work/build/stage1"));
  const dir = arg("run-dir", "");
  if (dir) { fs.mkdirSync(dir, { recursive: true }); teeLog(dir, "compiler.log"); }

  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8")).items
    .filter((it) => typeof it.source === "string" && it.source.length > 0 && !(it.actions && it.actions.length));
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(root, "work/adv-"));

  function runOne(item) {
    return new Promise((resolve) => {
      const file = path.join(scratch, `${item.name.replace(/[^\w.-]/g, "_")}.lean`);
      const src = rewriteAliases(item.source);
      fs.writeFileSync(file, src.endsWith("\n") ? src : src + "\n");
      const budget = Math.min(item.expect.budgetMs ?? 20000, 120000);
      const t0 = Date.now();
      const child = spawn("node", ["--stack-size=8192", path.join(root, "pipeline/snapshot/snapshot-probe.mjs"),
        "--snap", snap, "--probe-file", file, "--budget-ms", String(budget + 30000),
        "--via-mem", "--init-flags", "1", "--artifact", artifact,
        "--lib", path.join(root, "work/lib-tree-slim"), "--dump-messages"], { cwd: root });
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
    for (const item of corpus) results.push({ name: item.name, category: item.category, wallMs: 0, outcome: "infra", pass: false, failures: [`infra: missing ${missing.join(", ")}`] });
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
  const failed = results.filter((r) => r.outcome !== "pass");
  const infra = results.filter((r) => r.outcome === "infra").length;
  const report = { lane: "compiler", total: results.length, failed: failed.length, infra, results };
  fs.mkdirSync(path.join(root, "work/adversarial"), { recursive: true });
  const text = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(root, "work/adversarial/compiler-report.json"), text);
  if (dir) fs.writeFileSync(path.join(dir, "compiler-report.json"), text);
  console.log(`\ncompiler battery: ${results.length - failed.length}/${results.length} passed${infra ? ` (${infra} infra)` : ""}`);
  // Product failures → 1; infra-only failures → 3 (the run is not a verdict).
  process.exit(failed.length === 0 ? 0 : failed.length === infra ? 3 : 1);
}

// Only the CLI runs the battery; vitest imports the classifier.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
