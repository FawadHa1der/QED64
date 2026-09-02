#!/usr/bin/env node
// Seamless-editing benchmark: the same gestures against a pump-mode page and
// a resident-mode page (?resident=1). Measures what a user feels:
//   headerSwitchMs  — edit the import line → fresh fileProgress → ready
//   bodyEditMs      — introduce an error in a theorem → its diagnostic shows
//   completionMs    — import-line completion widget appears while a switch runs
//   errorClearMs    — remove the error → the diagnostic disappears
// Usage: node tests/adversarial/editing-latency.mjs --url <page url> [--label pump|resident] [--rounds 3]
import { chromium } from "playwright";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const url = arg("url", "http://localhost:5184/");
const label = arg("label", /resident=1/.test(url) ? "resident" : "pump");
const rounds = Number(arg("rounds", "3"));

const browser = await chromium.launch();
const page = await browser.newPage();
const pill = () => page.evaluate(() => document.querySelector("#ptext")?.textContent ?? "");
const ivText = () => page.evaluate(() => { const f = document.getElementById("infoview")?.querySelector("iframe"); return f && f.contentDocument ? f.contentDocument.body.innerText : ""; });
async function waitPill(re, ms, minMs = 0) { const t0 = Date.now(); for (;;) { const s = await pill(); if (Date.now() - t0 >= minMs && re.test(s)) return Date.now() - t0; if (Date.now() - t0 > ms) return -1; await page.waitForTimeout(100); } }
async function setBuffer(t) { await page.evaluate((t) => globalThis.qed64.editor.getModel().setValue(t), t); }
async function editLine(line, text) { await page.evaluate(({ line, text }) => { const m = globalThis.qed64.editor.getModel(); const c = m.getLineMaxColumn(line); m.applyEdits([{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: c }, text }]); }, { line, text }); }

await page.goto(url);
const boot = await waitPill(/^ready$/, 420000);
const BASE = "import Mathlib.Data.Real.Basic\n\nexample (a b : ℝ) : a + b = b + a := by\n  exact add_comm a b\n\ntheorem t1 : (2 : ℕ) + 2 = 4 := rfl\n";
const results = { label, bootMs: boot, rounds: [] };
for (let r = 0; r < rounds; r++) {
  await setBuffer(BASE); await waitPill(/^ready$/, 120000, 1500);
  const R = {};
  // 1) header switch: change the import line to another Mathlib module
  let t0 = Date.now();
  await editLine(1, r % 2 === 0 ? "import Mathlib.Data.Nat.Basic" : "import Mathlib.Data.Real.Basic");
  const busy = await waitPill(/imports|checking|elaborating|re-elaborating/, 15000);
  const ready = await waitPill(/^ready$/, 180000, 500);
  R.headerSwitchMs = ready >= 0 ? Date.now() - t0 : -1; R.switchBusySeenMs = busy;
  // 2) completion during a switch: retype the import segment and look for the widget
  t0 = Date.now();
  await editLine(1, "import Mathlib.Data.Re");
  await page.click(".monaco-editor .view-lines").catch(() => {});
  await page.keyboard.type("a", { delay: 30 });
  const widget = await page.waitForSelector(".suggest-widget .monaco-list-row", { timeout: 8000 }).then(() => Date.now() - t0).catch(() => -1);
  R.completionMs = widget;
  await page.keyboard.press("Escape");
  await editLine(1, "import Mathlib.Data.Real.Basic"); await waitPill(/^ready$/, 180000, 500);
  // 3) body edit → diagnostic
  t0 = Date.now();
  await editLine(6, "theorem t1 : (2 : ℕ) + 2 = 5 := rfl");
  let diag = -1;
  for (let i = 0; i < 300; i++) { if (/Type mismatch|2 \+ 2 = 5|rfl/.test(await ivText()) || /error/i.test(await ivText())) { diag = Date.now() - t0; break; } await page.waitForTimeout(100); }
  R.bodyEditToDiagMs = diag;
  // 4) error clear
  t0 = Date.now();
  await editLine(6, "theorem t1 : (2 : ℕ) + 2 = 4 := rfl");
  let clr = -1;
  for (let i = 0; i < 300; i++) { const t = await ivText(); if (!/Type mismatch|2 \+ 2 = 5/.test(t)) { clr = Date.now() - t0; break; } await page.waitForTimeout(100); }
  R.errorClearMs = clr;
  R.finalPill = await pill();
  results.rounds.push(R);
  console.log(`[${label}] round ${r + 1}: ${JSON.stringify(R)}`);
}
const med = (k) => { const v = results.rounds.map((x) => x[k]).filter((x) => x >= 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : -1; };
results.median = { headerSwitchMs: med("headerSwitchMs"), completionMs: med("completionMs"), bodyEditToDiagMs: med("bodyEditToDiagMs"), errorClearMs: med("errorClearMs") };
console.log(`SUMMARY ${JSON.stringify(results.median)} label=${label} boot=${boot}ms`);
const alive = await page.evaluate(() => !!globalThis.qed64).catch(() => false);
console.log(`alive=${alive}`);
await browser.close();
