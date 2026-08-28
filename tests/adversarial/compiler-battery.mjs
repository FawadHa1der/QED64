#!/usr/bin/env node
// Adversarial compiler battery: run corpus sources against the slim Mathlib
// snapshot through the SAME wasm runtime the browser ships (snapshot-probe,
// --via-mem), in a bounded parallel pool. Checks per item:
//   - no PANIC / assertion violation anywhere in the run's output
//   - mustError / mustSucceed expectations
//   - containsMsgs substrings appear in compiler messages
//   - wall-clock budget
// Usage: node tests/adversarial/compiler-battery.mjs [--corpus <file>] [--jobs 3]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const corpusPath = arg("corpus", path.join(root, "tests/adversarial/corpus.json"));
const jobs = Number(arg("jobs", "3"));
const snap = arg("snap", path.join(root, "work/snapshot/mathlib.snap"));
const artifact = arg("artifact", path.join(root, "pipeline/toolchain/work/build/stage1"));

const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8")).items
  .filter((it) => typeof it.source === "string" && it.source.length > 0 && !(it.actions && it.actions.length));
const scratch = fs.mkdtempSync(path.join(root, "work/adv-"));

// Mirror the production shim's alias rewrite: the browser rewrites the first
// umbrella-alias import to QED64.Essential before the worker ever sees it, so
// the battery must test the same text the runtime actually receives.
function rewriteAliases(src) {
  let first = true;
  return src.split("\n").map((l) => {
    const m = /^(\s*)import\s+(Mathlib|Mathlib\.Tactic|Batteries|MIL\.Common)\s*$/.exec(l);
    if (!m) return l;
    if (first) { first = false; return `${m[1]}import QED64.Essential`; }
    return `-- ${l}`;
  }).join("\n");
}

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
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const killer = setTimeout(() => { child.kill("SIGKILL"); }, budget + 60000);
    child.on("close", (code) => {
      clearTimeout(killer);
      const wallMs = Date.now() - t0;
      // Snapshot load adds ~10-15 s of fixed overhead per probe process; the
      // budget applies to the whole run minus that allowance.
      const msgs = [...out.matchAll(/\{"caption":.*/g)].map((m) => m[0]);
      const msgText = msgs.join("\n");
      const hasError = /"severity":\s*2|"kind":"error"|errors=[1-9]\d*/.test(out)
        || /compile: tag=1|probe compile failed|returned an IO error|No directory|does not exist/.test(out);
      const failures = [];
      const panic = /PANIC at|assertion violation|Maximum call stack|INTERNAL PANIC/.test(out);
      if (item.expect.panicFree && panic && !item.expect.knownPanic) failures.push("PANIC detected in output");
      const knownPanicNote = panic && item.expect.knownPanic ? "known-panic (tracked upstream)" : undefined;
      if (item.expect.mustError && !hasError) failures.push("expected errors, saw none");
      if (item.expect.mustSucceed && hasError) failures.push("expected success, saw errors");
      for (const frag of item.expect.containsMsgs ?? []) {
        if (!msgText.includes(frag) && !out.includes(frag)) failures.push(`missing message fragment: ${JSON.stringify(frag)}`);
      }
      if (wallMs > budget + 45000) failures.push(`over budget: ${wallMs}ms (budget ${budget}ms + load allowance)`);
      if (code === null) failures.push("killed (hang)");
      if (/snapshot probe crashed|Worker unrecoverable|unwind/i.test(out)) failures.push("runtime crashed");
      resolve({ name: item.name, category: item.category, wallMs, pass: failures.length === 0, failures,
        note: knownPanicNote,
        excerpt: failures.length ? out.slice(-600) : undefined });
    });
  });
}

const queue = [...corpus];
const results = [];
async function workerLoop() {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    const r = await runOne(item);
    results.push(r);
    console.log(`${r.pass ? "ok  " : "FAIL"} ${r.name} (${r.wallMs}ms)${r.pass ? "" : " — " + r.failures.join("; ")}`);
  }
}
await Promise.all(Array.from({ length: jobs }, workerLoop));
fs.rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
const report = { lane: "compiler", total: results.length, failed: failed.length, results };
fs.mkdirSync(path.join(root, "work/adversarial"), { recursive: true });
fs.writeFileSync(path.join(root, "work/adversarial/compiler-report.json"), JSON.stringify(report, null, 2));
console.log(`\ncompiler battery: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
