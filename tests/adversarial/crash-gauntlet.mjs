// Crash gauntlet: the documented killer recipe — rapid dropdown switches +
// garbage bursts + header flips, sustained. Reports survived/crashed/halted.
// The full log goes to the run directory (harness.mjs runDir; --run-dir to
// reuse one); exit 1 on a page crash / dead page, 2 on the breaker's
// `halted`, 0 otherwise. The browser is closed in `finally` (HARDENING #34).
// Usage: node tests/adversarial/crash-gauntlet.mjs [url] [minutes] [mixed|imports] [--run-dir <dir>]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { fetchJson, resolveTarget, root, runDir } from "./harness.mjs";
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
const URL = positional[0] ?? "http://localhost:5184/";
const MINUTES = Number(positional[1] ?? 3);
const MODE = positional[2] ?? "mixed";
const target = resolveTarget(URL);
const manifest = await fetchJson(target.manifestUrl).catch(() => null);
const dir = runDir(manifest?.buildId ?? "unknown", target.mode);
const logFile = path.join(dir, `gauntlet-${MODE}.log`);

const browser = await chromium.launch();
const page = await browser.newPage();
let crashed = false, pageErrors = 0;
const log = [];
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(0);
const push = (line) => { log.push(line); fs.appendFileSync(logFile, line + "\n"); };
push(`gauntlet ${MODE} ${MINUTES} min — ${URL} (runtime ${manifest?.buildId ?? "unknown"}, ${target.mode})`);
page.on("crash", () => { crashed = true; push(`[${ts()}s] PAGE CRASHED`); });
page.on("pageerror", (e) => { pageErrors++; const m = String(e).slice(0, 100); if (!/unsupported/.test(m)) push(`[${ts()}s] pageerror: ${m}`); });
page.on("console", (m) => { const t = m.text(); if (/keeps crashing|PANIC|Maximum call|unwind|restarted/.test(t)) push(`[${ts()}s] con: ${t.slice(0, 120)}`); });
let step = 0, alive = false, halted = false, finalPill = "";
try {
  await page.goto(URL, { timeout: 60000 });
  await page.waitForFunction(() => (document.querySelector("#ptext")?.textContent ?? "") === "ready", null, { timeout: 300000 }).catch(() => push("boot never settled"));
  push(`[${ts()}s] boot ready — storm begins`);
  const GARBAGE = ["⟨⟨⟨]]]∀∀ fun => by by", "@[simp]{{{→→", "theorem x : := fdksljf", "match , with | =>", "import Mathlib.Da", "example : 1+1=3 := by rfl\nend end"];
  const EX = ["init", "mathlib", "mil"];
  const deadline = Date.now() + MINUTES * 60000;
  const IMPORTS = ["Mathlib.Data.Real.Basic", "Mathlib.Topology.Basic", "Mathlib.Algebra.Algebra.Basic", "Mathlib.Tactic", "Mathlib.Data.Nat.Prime.Basic"];
  async function importStormStep() {
    // go to top, rewrite the import line the way a human does: select it,
    // retype module path char by char, occasionally pause long enough for
    // the debounce to fire a real switch mid-composition.
    await page.evaluate(() => {
      const ed = globalThis.qed64?.editor; if (!ed) return;
      const m = ed.getModel();
      const text = m.getValue().split("\n"); text[0] = "";
      m.setValue(text.join("\n"));
      ed.setPosition({ lineNumber: 1, column: 1 }); ed.focus();
    }).catch(() => {});
    await page.click(".monaco-editor .view-lines", { timeout: 2000 }).catch(() => {});
    await page.keyboard.press("Control+Home").catch(() => {});
    const target = "import " + IMPORTS[step % IMPORTS.length];
    await page.keyboard.type(target.slice(0, 10 + (step % (target.length - 10))), { delay: 60 }).catch(() => {});
    // sometimes finish the line and let it switch, sometimes abandon mid-word
    if (step % 3 === 0) {
      await page.keyboard.type(target.slice(10 + (step % (target.length - 10))), { delay: 60 }).catch(() => {});
      await page.waitForTimeout(4000);
    } else {
      await page.waitForTimeout(700);
    }
  }
  try {
    while (Date.now() < deadline && !crashed) {
      step++;
      if (MODE === "imports") { await importStormStep(); continue; }
      const dice = step % 7;
      if (dice === 0) {
        await page.selectOption("#examples", EX[step % 3]).catch(() => {});
      } else if (dice === 3) {
        await page.evaluate(() => { globalThis.qed64?.editor?.getModel().setValue(""); globalThis.qed64?.editor?.focus(); }).catch(() => {});
        await page.click(".monaco-editor .view-lines", { timeout: 2000 }).catch(() => {});
        await page.keyboard.type("import Mathlib.Topo", { delay: 15 }).catch(() => {});
      } else if (dice === 5) {
        for (let u = 0; u < 8; u++) await page.evaluate(() => globalThis.qed64?.editor?.trigger("t", "undo")).catch(() => {});
      } else {
        const g = GARBAGE[step % GARBAGE.length];
        await page.evaluate((t) => { const m = globalThis.qed64?.editor?.getModel(); if (!m) return; const ln = m.getLineCount(); m.applyEdits([{ range: { startLineNumber: ln, startColumn: m.getLineMaxColumn(ln), endLineNumber: ln, endColumn: m.getLineMaxColumn(ln) }, text: "\n" + t }]); }, g).catch(() => {});
      }
      await page.waitForTimeout(400 + (step % 5) * 300);
      if (step % 20 === 0) {
        const p = await page.evaluate(() => document.querySelector("#ptext")?.textContent ?? "GONE").catch(() => "EVAL-DEAD");
        push(`[${ts()}s] step ${step} pill: ${p.slice(0, 60)}`);
      }
    }
  } catch (e) { push(`[${ts()}s] driver threw: ${String(e).slice(0, 120)}`); }
  // settle verdict: give the machinery a fair window to reach a terminal state
  for (let i = 0; i < 60; i++) {
    const p = await page.evaluate(() => document.querySelector("#ptext")?.textContent ?? "").catch(() => "DEAD");
    if (/^ready$|imports (incomplete|failed)|keeps crashing|DEAD/.test(p)) break;
    await page.waitForTimeout(2000);
  }
  alive = await page.evaluate(() => !!globalThis.qed64).catch(() => false);
  finalPill = await page.evaluate(() => document.querySelector("#ptext")?.textContent ?? "").catch(() => "DEAD");
  halted = /keeps crashing/.test(finalPill);
} catch (e) {
  push(`[${ts()}s] gauntlet threw: ${String(e).slice(0, 160)}`);
} finally {
  push(`VERDICT url=${URL} steps=${step} crashed=${crashed} alive=${alive} halted=${halted} finalPill='${finalPill.slice(0, 70)}' pageErrors=${pageErrors}`);
  console.log(log.join("\n"));
  console.log(`log: ${path.relative(root, logFile)}`);
  await browser.close().catch(() => {});
}
process.exit(crashed || !alive ? 1 : halted ? 2 : 0);
