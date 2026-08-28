#!/usr/bin/env node
// Orchestrate the adversarial suite: dedicated vite on :5187, compiler
// battery (parallel, headless) + Playwright E2E (sequential), merged report.
// Usage: node tests/adversarial/run.mjs [--skip-compiler] [--skip-e2e]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const has = (f) => process.argv.includes(f);
fs.mkdirSync(path.join(root, "work/adversarial"), { recursive: true });

// 1) dedicated dev server (own port; never fights interactive sessions)
let vite = null;
const up = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:5187/"], { encoding: "utf8" });
if (up.stdout !== "200") {
  vite = spawn("npx", ["vite"], { cwd: path.join(root, "frontend"), env: { ...process.env, PORT: "5187" }, stdio: "ignore", detached: true });
  for (let i = 0; i < 30; i++) {
    const r = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://localhost:5187/"], { encoding: "utf8" });
    if (r.stdout === "200") break;
    spawnSync("sleep", ["1"]);
  }
}

let compilerCode = 0, e2eCode = 0;
if (!has("--skip-compiler")) {
  console.log("=== compiler battery ===");
  compilerCode = spawnSync("node", [path.join(root, "tests/adversarial/compiler-battery.mjs")], { stdio: "inherit", cwd: root }).status ?? 1;
}
if (!has("--skip-e2e")) {
  console.log("=== e2e (headless chromium) ===");
  e2eCode = spawnSync("node", [path.join(root, "tests/adversarial/e2e.mjs"), "--url", "http://localhost:5187/"], { stdio: "inherit", cwd: root }).status ?? 1;
}
if (vite) { try { process.kill(-vite.pid); } catch { /* gone */ } }

// merged markdown report
const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(root, "work/adversarial", f), "utf8")); } catch { return null; } };
const comp = load("compiler-report.json"), e2e = load("e2e-report.json");
const lines = ["# Adversarial suite report", ""];
for (const lane of [comp, e2e].filter(Boolean)) {
  lines.push(`## ${lane.lane}: ${lane.total - lane.failed}/${lane.total} passed`, "");
  for (const r of lane.results.filter((x) => !x.pass)) {
    lines.push(`- **FAIL** \`${r.name}\` [${r.category}] — ${r.detail ?? (r.failures || []).join("; ")}${r.screenshot ? ` (screenshot: ${r.screenshot})` : ""}`);
  }
  lines.push("");
}
fs.writeFileSync(path.join(root, "work/adversarial/report.md"), lines.join("\n"));
console.log(`\nreport: work/adversarial/report.md`);
process.exit(compilerCode || e2eCode ? 1 : 0);
