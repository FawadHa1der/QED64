#!/usr/bin/env node
// Seamless-editing benchmark: the same gestures against a pump-mode page and
// a resident-mode page (?resident=1). Measures what a user feels:
//   headerSwitchMs    — edit the import line → ready at the editor's version
//   switchBusySeenMs  — edit the import line → the FIRST $/lean/fileProgress
//                       after the edit (the covered-switch metric the design
//                       budgets at ≤ 300 ms, ux item 4); read from the shim's
//                       progress clock, never from a busy pill label that a
//                       fast switch may never render (attacks.txt #4)
//   bodyEditMs        — introduce an error in a theorem → its diagnostic shows
//   completionMs      — import-line completion widget appears while a switch runs
//   errorClearMs      — remove the error → the diagnostic disappears
// Results (JSON + log) go to the run directory; the browser closes in `finally`.
// Usage: node tests/adversarial/editing-latency.mjs --url <page url> [--label pump|resident] [--rounds 3] [--run-dir <dir>]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { arg, fetchJson, resolveTarget, root, runDir, teeLog } from "./harness.mjs";
const url = arg("url", "http://localhost:5184/");
const label = arg("label", /resident=1/.test(url) ? "resident" : "pump");
const rounds = Number(arg("rounds", "3"));
const target = resolveTarget(url);
const manifest = await fetchJson(target.manifestUrl).catch(() => null);
const dir = runDir(manifest?.buildId ?? "unknown", target.mode);
teeLog(dir, `latency-${label}.log`);

const browser = await chromium.launch();
const page = await browser.newPage();
const pill = () => page.evaluate(() => document.querySelector("#ptext")?.textContent ?? "");
const ivText = () => page.evaluate(() => { const f = document.getElementById("infoview")?.querySelector("iframe"); return f && f.contentDocument ? f.contentDocument.body.innerText : ""; });
async function waitPill(re, ms, minMs = 0) { const t0 = Date.now(); for (;;) { const s = await pill(); if (Date.now() - t0 >= minMs && re.test(s)) return Date.now() - t0; if (Date.now() - t0 > ms) return -1; await page.waitForTimeout(100); } }
async function setBuffer(t) { await page.evaluate((t) => globalThis.qed64.editor.getModel().setValue(t), t); }
async function editLine(line, text) { await page.evaluate(({ line, text }) => { const m = globalThis.qed64.editor.getModel(); const c = m.getLineMaxColumn(line); m.applyEdits([{ range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: c }, text }]); }, { line, text }); }
// The shim stamps `lastProgressAt = performance.now()` on every
// $/lean/fileProgress (watchdog-shim.ts). Sample it in-page around the edit;
// -2 = the shim does not expose it (fall back to the busy-label wait).
const progressClock = () => page.evaluate(() => { const v = globalThis.qed64?.shim?.lastProgressAt; return typeof v === "number" ? v : null; });
async function waitFirstProgressAfter(mark, ms) {
  const t0 = Date.now();
  for (;;) {
    const at = await progressClock();
    if (at !== null && at > mark) return Date.now() - t0;
    if (Date.now() - t0 > ms) return -1;
    await page.waitForTimeout(50);
  }
}

const results = { label, url, buildId: manifest?.buildId ?? null, bootMs: -1, rounds: [] };
try {
  await page.goto(url);
  results.bootMs = await waitPill(/^ready$/, 420000);
  const BASE = "import Mathlib.Data.Real.Basic\n\nexample (a b : ℝ) : a + b = b + a := by\n  exact add_comm a b\n\ntheorem t1 : (2 : ℕ) + 2 = 4 := rfl\n";
  for (let r = 0; r < rounds; r++) {
    await setBuffer(BASE); await waitPill(/^ready$/, 120000, 1500);
    const R = {};
    // 1) header switch: change the import line to another Mathlib module
    const mark = await progressClock();
    let t0 = Date.now();
    await editLine(1, r % 2 === 0 ? "import Mathlib.Data.Nat.Basic" : "import Mathlib.Data.Real.Basic");
    // `progressClock`: the shim's lastProgressAt; `busy-label`: the fallback
    // (15 s ceiling, cannot see a covered switch) — recorded so a shim that
    // stops exposing the clock degrades VISIBLY in the report.
    R.progressClockSource = mark !== null ? "shim.lastProgressAt" : "busy-label";
    // Header switch = edit → the worker's NEXT header verdict for this document
    // has landed AND the phase is ready. Reads the status tap (front door / shim
    // status()); a page without one falls back to the pill (pump era, 500 ms floor).
    const status = () => page.evaluate(() => { try { return globalThis.qed64?.status?.() ?? null; } catch { return null; } }).catch(() => null);
    const st0 = await status();
    // Only a page that already holds a header FACT can be measured by facts;
    // the pump shim's status() reports header: null (it never receives one),
    // so it takes the pill path below (measured: pump headerSwitchMs=-1).
    if (st0 && st0.header) {
      // Completion = the DOCUMENT version has advanced past the edit and the
      // phase is ready again. (The header fact's version is not usable: the
      // kernel stamps later header setups with the initial document version —
      // a FileWorker closure binding, harmless to the UI, kernel follow-up.)
      const v0 = st0.version;
      let firstMove = -1, done = -1;
      for (let i = 0; i < 3600; i++) {
        const st = await status();
        if (st) {
          if (firstMove < 0 && (st.phase !== "ready" || st.version !== v0)) firstMove = Date.now() - t0;
          if (st.version !== v0 && st.phase === "ready" && i > 2) { done = Date.now() - t0; break; }
        }
        await page.waitForTimeout(50);
      }
      R.switchBusySeenMs = firstMove; R.headerSwitchMs = done; R.progressClockSource = "status()";
    } else {
      R.switchBusySeenMs = mark !== null ? await waitFirstProgressAfter(mark, 15000) : await waitPill(/imports|checking|elaborating|re-elaborating/, 15000);
      const ready = await waitPill(/^ready$/, 180000, 500);
      R.headerSwitchMs = ready >= 0 ? Date.now() - t0 : -1;
    }
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
  results.median = { headerSwitchMs: med("headerSwitchMs"), switchBusySeenMs: med("switchBusySeenMs"), completionMs: med("completionMs"), bodyEditToDiagMs: med("bodyEditToDiagMs"), errorClearMs: med("errorClearMs") };
  console.log(`SUMMARY ${JSON.stringify(results.median)} label=${label} boot=${results.bootMs}ms`);
  results.alive = await page.evaluate(() => !!globalThis.qed64).catch(() => false);
  console.log(`alive=${results.alive}`);
} catch (e) {
  results.error = String(e).slice(0, 200);
  console.log(`latency: threw ${results.error}`);
} finally {
  fs.writeFileSync(path.join(dir, `latency-${label}.json`), JSON.stringify(results, null, 2));
  console.log(`results: ${path.relative(root, path.join(dir, `latency-${label}.json`))}`);
  await browser.close().catch(() => {});
}
process.exit(results.error ? 1 : 0);
