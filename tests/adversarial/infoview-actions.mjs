#!/usr/bin/env node
// InfoView editor actions in REAL headless Chromium (docs/HARDENING.md #56):
// lean4monaco's InfoView wiring, fixed in QED64.
//
//   capability-flag   globalThis.qed64.api = {version 1, capabilities.editorRpc}
//                     exists at DOMContentLoaded (an embedder's own bridge
//                     reads it and stands down).
//   try-this-apply    init only: `example (n : Nat) : n + 0 = n := by simp?`,
//                     cursor on simp?, click the core "Try this" suggestion →
//                     the line reads `by simp only [Nat.add_zero]` (applyEdit),
//                     elaborates to ready with no error.
//   conv-generate     Mathlib: `conv?` renders its ProofWidgets selection panel
//                     (an mk_rpc_widget% panel: sendClientRequest with an
//                     abortSignal — "abortSignal.addEventListener is not a
//                     function" before the fix), shift-click `c + b` in the goal,
//                     click "Generate conv" (MakeEditLink → applyEdit) → the
//                     proof reads `conv => … enter …` and the document is ready
//                     without errors.
//   foreign-show      showDocument for a file that is not the editor's document
//                     is ignored without an error (go-to-definition into Mathlib).
//
// Usage: node tests/adversarial/infoview-actions.mjs [--url http://localhost:5199/] [--only <scenario>] [--run-dir <dir>]
// Run it through the host browser lock. Exit 0 all pass, 1 a scenario failed, 3 infrastructure refusal.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { arg, fetchJson, onlyMatches, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

const url = arg("url", "http://localhost:5199/");
const only = arg("only", "");
const runs = (name) => !only || onlyMatches(name, only);
const target = resolveTarget(url);
const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`infoview-actions: refused — ${e.message}`); process.exit(3); });
const dir = runDir(manifest.buildId ?? "unknown", target.mode);
teeLog(dir, "infoview-actions.log");
console.log(`infoview-actions: ${url} → ${manifest.buildId}; reports in ${path.relative(root, dir)}`);

const SEL = {
  frame: "#infoview iframe",
  coreTryThis: "span.link.pointer.dim.font-code",
  makeEditLink: "a.link.pointer.dim",
  panelSummary: "summary",
  goalTarget: "div:has(> .goal-vdash)",
  selected: "[class*=highlight-selected]",
};
const DOC_A = "example (n : Nat) : n + 0 = n := by simp?\n";
const DOC_B = "import Mathlib.Tactic.Widget.Conv\n\nexample (a b c : Nat) : a + (b + c) = (c + b) + a := by\n  conv?\n  omega\n";

const results = [];
let failed = 0;
function record(name, ok, detail, extra = {}) {
  results.push({ name, outcome: ok ? "pass" : "fail", detail, ...extra });
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
  fs.writeFileSync(path.join(dir, "infoview-actions-report.json"), JSON.stringify({ url, buildId: manifest.buildId, total: results.length, failed, results }, null, 2));
}

const browser = await chromium.launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A fresh page booted to `ready` on `doc`. */
async function boot(doc, budgetMs) {
  const context = await browser.newContext();
  await context.addInitScript((text) => { try { window.localStorage.setItem("qed64.buffer", text); } catch { /* storage off */ } }, doc);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => { const m = String(e); if (!/unsupported/.test(m) || /abortSignal/.test(m)) errors.push(m.slice(0, 200)); });
  page.on("console", (m) => { const t = m.text(); if (/abortSignal|is not a function|Unrecognised error|unsupported/.test(t)) errors.push(`console: ${t.slice(0, 200)}`); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const t0 = Date.now();
  for (;;) {
    const ph = await page.evaluate(() => globalThis.qed64?.status?.()?.phase ?? null).catch(() => null);
    if (ph === "ready") break;
    if (Date.now() - t0 > budgetMs) throw new Error(`not ready within ${budgetMs} ms (phase ${ph})`);
    await sleep(250);
  }
  return { page, context, errors };
}
const text = (page) => page.evaluate(() => globalThis.qed64.editor.getModel().getValue());
const cursorAt = (page, lineNumber, column) => page.evaluate(([l, c]) => { const e = globalThis.qed64.editor; e.setPosition({ lineNumber: l, column: c }); e.focus(); }, [lineNumber, column]);
const ready = (page) => page.evaluate(() => globalThis.qed64.status().phase === "ready");
async function waitFor(pred, ms, every = 200) {
  const t0 = Date.now();
  for (;;) { const v = await pred(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every); }
}
/** Diagnostics of severity Error the client received last (the relay's client port). */
async function installDiagTap(page) {
  await page.evaluate(() => {
    globalThis.__diags = null;
    globalThis.qed64.relay.clientPort.addEventListener("message", (e) => { const m = e.data; if (m && m.method === "textDocument/publishDiagnostics") globalThis.__diags = m.params; });
  });
}
const errorDiags = (page) => page.evaluate(() => (globalThis.__diags?.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message.slice(0, 120)));

try {
  // ---------- capability-flag ----------
  if (runs("capability-flag")) {
    const context = await browser.newContext();
    const page = await context.newPage();
    let early = null;
    page.on("domcontentloaded", async () => { early = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.qed64?.api ?? null))).catch(() => null); });
    await page.goto(url, { waitUntil: "load" });
    const atLoad = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.qed64?.api ?? null)));
    const frozen = await page.evaluate(() => Object.isFrozen(globalThis.qed64?.api) && Object.isFrozen(globalThis.qed64?.api?.capabilities));
    const ok = atLoad?.version === 1 && atLoad?.capabilities?.editorRpc === true && frozen;
    record("capability-flag", ok, `at DOMContentLoaded ${JSON.stringify(early)}; at load ${JSON.stringify(atLoad)}; frozen ${frozen}`);
    await context.close();
  }

  // ---------- try-this-apply ----------
  if (runs("try-this-apply")) {
    const { page, context, errors } = await boot(DOC_A, 300000);
    await installDiagTap(page);
    await cursorAt(page, 1, DOC_A.indexOf("simp?") + 3);
    const iv = page.frameLocator(SEL.frame);
    const link = iv.locator(SEL.coreTryThis, { hasText: "simp only" }).first();
    await link.waitFor({ timeout: 60000 });
    const before = await text(page);
    await link.click();
    const after = await waitFor(async () => { const t = await text(page); return t !== before ? t : null; }, 10000);
    const settled = after ? await waitFor(() => ready(page), 60000) : null;
    const errs = settled ? await errorDiags(page) : ["not settled"];
    const ok = after === "example (n : Nat) : n + 0 = n := by simp only [Nat.add_zero]\n" && !!settled && errs.length === 0 && errors.length === 0;
    record("try-this-apply", ok, `text after click ${JSON.stringify(after)}; ready ${!!settled}; error diagnostics ${JSON.stringify(errs)}; page errors ${JSON.stringify(errors)}`);
    await page.screenshot({ path: path.join(dir, "try-this-applied.png") }).catch(() => {});
    await context.close();
  }

  // ---------- conv-generate ----------
  if (runs("conv-generate")) {
    const { page, context, errors } = await boot(DOC_B, 600000);
    await installDiagTap(page);
    await cursorAt(page, 4, 5);
    const iv = page.frameLocator(SEL.frame);
    const panel = iv.locator(SEL.panelSummary, { hasText: "Conv" }).first();
    const shown = await panel.waitFor({ timeout: 90000 }).then(() => true, () => false);
    const panelErr = await iv.getByText(/abortSignal|Unrecognised error/).count();
    let after = null, selected = 0, settled = null, errs = ["not reached"];
    if (shown && panelErr === 0) {
      const goal = iv.locator(SEL.goalTarget).first();
      await goal.waitFor({ timeout: 30000 });
      await goal.locator("span", { hasText: "c + b" }).last().click({ modifiers: ["Shift"] });
      selected = await waitFor(async () => (await iv.locator(SEL.selected).count()) || null, 10000) ?? 0;
      const gen = iv.locator(SEL.makeEditLink, { hasText: "Generate conv" }).first();
      await gen.waitFor({ timeout: 20000 });
      const before = await text(page);
      await gen.click();
      after = await waitFor(async () => { const t = await text(page); return t !== before ? t : null; }, 10000);
      settled = after ? await waitFor(() => ready(page), 120000) : null;
      errs = settled ? await errorDiags(page) : ["not settled"];
    }
    const ok = shown && panelErr === 0 && selected > 0 && !!after && /conv =>/.test(after) && /enter/.test(after) && !/conv\?/.test(after) && !!settled && errs.length === 0 && errors.length === 0;
    record("conv-generate", ok, `panel ${shown}, panel error text ${panelErr}, selected ${selected}; text after ${JSON.stringify(after)}; ready ${!!settled}; error diagnostics ${JSON.stringify(errs)}; page errors ${JSON.stringify(errors)}`);
    await page.screenshot({ path: path.join(dir, "conv-generated.png") }).catch(() => {});

    // ---------- foreign-show (same page) ----------
    if (runs("foreign-show")) {
      const res = await page.evaluate(async () => {
        const hook = globalThis.__qed64InfoviewEditorApi;
        if (typeof hook !== "function") return { error: "no hook" };
        const api = hook({});
        const t0 = globalThis.qed64.editor.getModel().getValue();
        await api.showDocument({ uri: "file:///lib/lean/Mathlib/Order/Basic.lean", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
        return { unchanged: globalThis.qed64.editor.getModel().getValue() === t0 };
      }).catch((e) => ({ error: String(e).slice(0, 120) }));
      record("foreign-show", res.unchanged === true, JSON.stringify(res));
    }
    await context.close();
  }
} catch (e) {
  record("harness", false, `threw: ${String(e?.stack ?? e).slice(0, 400)}`);
} finally {
  await browser.close().catch(() => {});
}
console.log(`infoview-actions: ${results.length - failed}/${results.length} pass; report ${path.relative(root, path.join(dir, "infoview-actions-report.json"))}`);
process.exitCode = failed ? 1 : 0;
