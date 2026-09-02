#!/usr/bin/env node
// Orchestrate the adversarial suite: pretest (front-end typecheck), dedicated
// vite on :5187, PREFLIGHT of the pairing the page will boot (refuses with
// exit 3 and zero rows), compiler battery (parallel, headless), a browser
// cool-down (HARDENING #34), then the Playwright E2E lane; one report
// directory per run under work/adversarial/runs/<ts>-<buildId>-<mode>/ plus
// the legacy work/adversarial/report.md.
// Usage: node tests/adversarial/run.mjs [--skip-compiler] [--skip-e2e] [--url <page url>]
//        [--no-boot] [--skip-pretest] [--cooldown-gb 6]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { arg, coolDown, has, resolveTarget, root, runDir, strayBrowsers, teeLog } from "./harness.mjs";
import { runPreflight } from "./preflight.mjs";

fs.mkdirSync(path.join(root, "work/adversarial"), { recursive: true });
const refuse = (why) => { console.error(`run: REFUSED — ${why}`); process.exit(3); };

// 0) pretest: `npx tsc --noEmit` at the root does not cover frontend/
// (HARDENING #35); a front end that does not type-check has broken boot in
// every mode twice, and each time a page that never became ready was the
// only signal. Refuse before spending a browser on it.
if (!has("--skip-pretest")) {
  console.log("=== pretest: typecheck:site ===");
  const tc = spawnSync("npm", ["run", "typecheck:site"], { cwd: root, stdio: "inherit" });
  if (tc.status !== 0) refuse("npm run typecheck:site failed");
}

// 1) dedicated dev server (own port; never fights interactive sessions)
const url = arg("url", "http://localhost:5187/");
const target = resolveTarget(url);
let vite = null;
const probe = () => spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", target.origin + "/"], { encoding: "utf8" }).stdout;
if (probe() !== "200") {
  const port = new URL(target.origin).port || "80";
  vite = spawn("npx", ["vite"], { cwd: path.join(root, "frontend"), env: { ...process.env, PORT: port }, stdio: "ignore", detached: true });
  for (let i = 0; i < 30; i++) {
    if (probe() === "200") break;
    spawnSync("sleep", ["1"]);
  }
}
const stopVite = () => { if (vite) { try { process.kill(-vite.pid); } catch { /* gone */ } vite = null; } };

// 2) preflight: manifest + chunks + snapshot index + pairing (+ one boot
// smoke unless --no-boot). A refusal is the whole verdict: no lanes run.
console.log("=== preflight ===");
const pre = await runPreflight(target, { boot: !has("--no-boot") && !has("--skip-e2e"), bootBudgetMs: Number(arg("boot-budget-ms", "180000")) });
const dir = runDir(pre.buildId ?? "unknown", target.mode);
teeLog(dir, "run.log");
fs.writeFileSync(path.join(dir, "preflight.json"), JSON.stringify({ target, ...pre }, null, 2));
if (!pre.ok) {
  fs.writeFileSync(path.join(root, "work/adversarial/report.md"), `# Adversarial suite report\n\n**REFUSED (preflight):** ${pre.reason}\n\nrun dir: ${path.relative(root, dir)}\n`);
  stopVite();
  refuse(`preflight: ${pre.reason}`);
}
console.log(`run dir: ${path.relative(root, dir)} (${pre.buildId}, ${target.mode})`);

let compilerCode = 0, e2eCode = 0;
if (!has("--skip-compiler")) {
  console.log("=== compiler battery ===");
  compilerCode = spawnSync("node", [path.join(root, "tests/adversarial/compiler-battery.mjs"), "--run-dir", dir], { stdio: "inherit", cwd: root }).status ?? 1;
}
if (!has("--skip-e2e")) {
  // Cool-down before the browser lane: stray chrome-headless-shell processes
  // (a probe that died before browser.close()) and slowly-reclaimed shared
  // memory turned one dead page into "the product cannot boot" for every
  // later stage (HARDENING #34). Refuse to start a browser while one exists.
  console.log("=== cool-down ===");
  if (!(await coolDown())) { stopVite(); refuse(`browser lane not started (${strayBrowsers().length} stray chrome-headless-shell)`); }
  console.log("=== e2e (headless chromium) ===");
  e2eCode = spawnSync("node", [path.join(root, "tests/adversarial/e2e.mjs"), "--url", url, "--run-dir", dir], { stdio: "inherit", cwd: root }).status ?? 1;
}
stopVite();

// merged markdown report (per-run dir + legacy path)
const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
const comp = load("compiler-report.json"), e2e = load("e2e-report.json");
const lines = [`# Adversarial suite report`, "", `run: ${path.relative(root, dir)} — runtime ${pre.buildId} (${target.mode}) — ${url}`, ""];
for (const lane of [comp, e2e].filter(Boolean)) {
  const by = (o) => lane.results.filter((r) => (r.outcome ?? (r.pass ? "pass" : "fail")) === o).length;
  lines.push(`## ${lane.lane}: ${by("pass")}/${lane.total} passed (fail ${by("fail")}, infra ${by("infra")}, aborted ${by("aborted")})`, "");
  for (const r of lane.results.filter((x) => (x.outcome ?? (x.pass ? "pass" : "fail")) !== "pass")) {
    const o = (r.outcome ?? "fail").toUpperCase();
    lines.push(`- **${o}** \`${r.name}\` [${r.category}] — ${r.detail ?? (r.failures || []).join("; ")}${r.screenshot ? ` (screenshot: ${r.screenshot})` : ""}`);
  }
  lines.push("");
}
const md = lines.join("\n");
fs.writeFileSync(path.join(dir, "report.md"), md);
fs.writeFileSync(path.join(root, "work/adversarial/report.md"), md);
console.log(`\nreport: ${path.relative(root, path.join(dir, "report.md"))} (also work/adversarial/report.md)`);
// 3 = a lane refused (infra), 1 = product failures, 0 = green.
process.exit(compilerCode === 3 || e2eCode === 3 ? 3 : compilerCode || e2eCode ? 1 : 0);
