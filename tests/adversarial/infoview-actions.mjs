#!/usr/bin/env node
// InfoView editor actions in REAL headless Chromium (docs/HARDENING.md #56):
// lean4monaco's InfoView wiring, fixed in QED64.
//
//   capability-flag   globalThis.qed64.api = {version 1, capabilities.editorRpc}
//                     exists at DOMContentLoaded (an init script's listener
//                     records it then — an embedder's own bridge reads it at
//                     that point and stands down) and at load, frozen.
//   try-this-apply    init only: `example (n : Nat) : n + 0 = n := by simp?`,
//                     cursor on simp?, click the core "Try this" [apply] link →
//                     the line reads `by simp only [Nat.add_zero]` (applyEdit),
//                     elaborates to ready with no error.
//   conv-generate     Mathlib: `conv?` renders its ProofWidgets selection panel
//                     (an mk_rpc_widget% panel: sendClientRequest with an
//                     abortSignal — "abortSignal.addEventListener is not a
//                     function" before the fix), shift-click `c + b` in the goal,
//                     click "Generate conv" (MakeEditLink → applyEdit) → the
//                     proof reads `conv => … enter …` and the document is ready
//                     without errors.
//   foreign-show      init only: showDocument sent from INSIDE the InfoView
//                     iframe, as the InfoView's own RPC puts it on the wire, for
//                     a Mathlib file (go-to-definition into Mathlib) leaves the
//                     text, the selection and the focus (on the InfoView) alone,
//                     with no error; the same call for the editor's own document
//                     selects and focuses (the control: the check can see a
//                     showDocument at all).
//
// Usage: node tests/adversarial/infoview-actions.mjs [--url http://localhost:5199/] [--only <scenario>] [--run-dir <dir>]
// Run it through the host browser lock. Exit 0 all pass, 1 a scenario failed,
// 3 infrastructure refusal (an --only that selects no scenario included).
// Every scenario runs on its own page. The selection, the in-browser probes and
// the verdicts are exported for tests/unit/infoview-actions.test.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, fetchJson, onlyMatches, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

export const SCENARIOS = ["capability-flag", "try-this-apply", "conv-generate", "foreign-show"];
/** The scenarios `--only` selects, in run order. An empty selection is refused
 * (exit 3): `--only foreign-show` once ran nothing and reported "0/0 pass". */
export const selectScenarios = (only) => SCENARIOS.filter((name) => !only || onlyMatches(name, only));
/** 0 all pass, 1 a scenario failed, 3 nothing was judged. */
export const exitCodeFor = (total, failed) => (total === 0 ? 3 : failed ? 1 : 0);

const SEL = {
  frame: "#infoview iframe",
  // Lean 4.34's core "Try this": `Try this: [apply] simp only […]`, the link is the
  // separate "[apply]" span (title "Apply suggestion"), not the suggestion text.
  coreTryThis: 'span.link.pointer[title="Apply suggestion"]',
  makeEditLink: "a.link.pointer.dim",
  panelSummary: "summary",
  goalTarget: "div:has(> .goal-vdash)",
  selected: "[class*=highlight-selected]",
};
const DOC_A = "example (n : Nat) : n + 0 = n := by simp?\n";
const DOC_B = "import Mathlib.Tactic.Widget.Conv\n\nexample (a b c : Nat) : a + (b + c) = (c + b) + a := by\n  conv?\n  omega\n";
// foreign-show: a go-to-definition target in Mathlib, and the own-document
// control's range (`n + 0 = n` in DOC_A). The probe's seqNums sit far above the
// iframe Rpc's own, which count up from 1.
const FOREIGN_SHOW = { uri: "file:///lib/lean/Mathlib/Order/Basic.lean", selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } };
const OWN_AT = DOC_A.indexOf("n + 0 = n");
const OWN_SELECTION = { start: { line: 0, character: OWN_AT }, end: { line: 0, character: OWN_AT + 9 } };
const RPC_SEQ = 2 ** 30;

// ---------- in-browser probes ----------
// Playwright sends each as source text (fn.toString()) and calls it with one
// argument, so they are self-contained; the last parameter defaults to the
// browser's global, and the unit test passes its fakes there instead.

/** Init script (every document, before its scripts): `qed64.api` as an
 * embedder's bridge sees it when DOMContentLoaded fires. */
export function recordApiAtDomContentLoaded(_arg, g = globalThis) {
  g.document.addEventListener("DOMContentLoaded", () => { g.__qed64ApiAtDcl = JSON.parse(JSON.stringify(g.qed64?.api ?? null)); });
}
/** `qed64.api` now, whether it is frozen, and what the init script recorded. */
export function apiAtLoad(_arg, g = globalThis) {
  const api = g.qed64?.api;
  return {
    atDcl: "__qed64ApiAtDcl" in g ? g.__qed64ApiAtDcl : "not recorded",
    atLoad: JSON.parse(JSON.stringify(api ?? null)),
    frozen: !!api && Object.isFrozen(api) && Object.isFrozen(api.capabilities),
  };
}
/** In the page: cursor at 1:1, the focus on the InfoView iframe (where a click
 * in the InfoView leaves it), out of the editor. */
export function focusInfoview(frameSelector, g = globalThis) {
  g.qed64.editor.setPosition({ lineNumber: 1, column: 1 });
  g.document.activeElement?.blur?.();
  const frames = g.document.querySelectorAll(frameSelector);
  frames[frames.length - 1]?.focus();
}
/** In the page: the editor's document, its selection and who has the focus. */
export function editorView(_arg, g = globalThis) {
  const e = g.qed64.editor;
  const s = e.getSelection();
  const active = g.document.activeElement;
  return {
    uri: e.getModel().uri.toString(),
    text: e.getModel().getValue(),
    selection: s ? [s.startLineNumber, s.startColumn, s.endLineNumber, s.endColumn] : null,
    focus: active ? active.tagName : null,
    editorFocus: !!active && e.getContainerDomNode().contains(active),
  };
}
/** In the InfoView iframe: one EditorApi call as the iframe's Rpc puts it on
 * the wire (`{seqNum, name, args}` as JSON to window.parent — lean4monaco
 * webview.js), answered by what the page registered (the patched
 * infowebview.js). The answer is taken in the capture phase and stopped, so the
 * iframe's Rpc, which has no such call pending, never sees it. */
export function rpcFromInfoview({ name, args, seqNum, timeoutMs }, win = window) {
  return new Promise((resolve) => {
    const done = (answer) => { clearTimeout(timer); win.removeEventListener("message", onMessage, true); resolve(answer); };
    const timer = setTimeout(() => done({ answered: false }), timeoutMs);
    function onMessage(e) {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (!m || m.seqNum !== seqNum || m.name !== undefined) return;
      e.stopImmediatePropagation();
      done({ answered: true, exception: m.exception === undefined ? null : JSON.stringify(m.exception).slice(0, 200) });
    }
    win.addEventListener("message", onMessage, true);
    win.parent.postMessage(JSON.stringify({ seqNum, name, args }));
  });
}

// ---------- verdicts ----------
/** capability-flag: flagged at DOMContentLoaded AND at load, and frozen. */
export function capabilityVerdict({ atDcl, atLoad, frozen }) {
  const flagged = (api) => api?.version === 1 && api?.capabilities?.editorRpc === true;
  return flagged(atDcl) && flagged(atLoad) && frozen === true;
}
/** foreign-show on a booted page, given evaluate in the page and in the
 * InfoView iframe (Playwright's in the lane, fakes in the unit test). */
export async function foreignShow(inPage, inFrame, timeoutMs = 30000) {
  const show = (target, n) => inFrame(rpcFromInfoview, { name: "showDocument", args: [target], seqNum: RPC_SEQ + n, timeoutMs });
  await inPage(focusInfoview, SEL.frame);
  const before = await inPage(editorView);
  const foreign = await show(FOREIGN_SHOW, 0);
  const afterForeign = await inPage(editorView);
  const own = await show({ uri: before.uri, selection: OWN_SELECTION }, 1);
  const afterOwn = await inPage(editorView);
  return { before, foreign, afterForeign, own, afterOwn };
}
/** The foreign-show checks that failed (none = pass). */
export function foreignShowFailures({ before, foreign, afterForeign, own, afterOwn }) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const { start, end } = OWN_SELECTION;
  const checks = {
    "cursor starts at 1:1": same(before.selection, [1, 1, 1, 1]),
    "focus starts outside the editor": before.editorFocus === false,
    "foreign answered without an exception": foreign.answered === true && foreign.exception === null,
    "foreign leaves the text": afterForeign.text === before.text,
    "foreign leaves the selection": same(afterForeign.selection, before.selection),
    "foreign leaves the focus": afterForeign.focus === before.focus && afterForeign.editorFocus === false,
    "own answered without an exception": own.answered === true && own.exception === null,
    "own selects its range": same(afterOwn.selection, [start.line + 1, start.character + 1, end.line + 1, end.character + 1]),
    "own focuses the editor": afterOwn.editorFocus === true,
  };
  return Object.keys(checks).filter((k) => !checks[k]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

async function main() {
  const url = arg("url", "http://localhost:5199/");
  const only = arg("only", "");
  const scenarios = selectScenarios(only);
  if (scenarios.length === 0) { console.error(`infoview-actions: refused — --only ${JSON.stringify(only)} selects none of ${SCENARIOS.join(", ")}`); process.exit(3); }
  const target = resolveTarget(url);
  const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`infoview-actions: refused — ${e.message}`); process.exit(3); });
  const dir = runDir(manifest.buildId ?? "unknown", target.mode);
  teeLog(dir, "infoview-actions.log");
  console.log(`infoview-actions: ${url} → ${manifest.buildId}; ${scenarios.join(", ")}; reports in ${path.relative(root, dir)}`);

  const results = [];
  let failed = 0;
  function record(name, ok, detail, extra = {}) {
    results.push({ name, outcome: ok ? "pass" : "fail", detail, ...extra });
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
    fs.writeFileSync(path.join(dir, "infoview-actions-report.json"), JSON.stringify({ url, buildId: manifest.buildId, total: results.length, failed, results }, null, 2));
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
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

  const lanes = {
    "capability-flag": async () => {
      const context = await browser.newContext();
      await context.addInitScript(recordApiAtDomContentLoaded);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load" });
      const seen = await page.evaluate(apiAtLoad);
      record("capability-flag", capabilityVerdict(seen), `at DOMContentLoaded ${JSON.stringify(seen.atDcl)}; at load ${JSON.stringify(seen.atLoad)}; frozen ${seen.frozen}`);
      await context.close();
    },

    "try-this-apply": async () => {
      const { page, context, errors } = await boot(DOC_A, 300000);
      await installDiagTap(page);
      await cursorAt(page, 1, DOC_A.indexOf("simp?") + 3);
      const iv = page.frameLocator(SEL.frame);
      const link = iv.locator(SEL.coreTryThis, { hasText: "[apply]" }).first();
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
    },

    "conv-generate": async () => {
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
      await context.close();
    },

    "foreign-show": async () => {
      const { page, context, errors } = await boot(DOC_A, 300000);
      const frameEl = page.locator(SEL.frame).last();
      await frameEl.waitFor({ state: "attached", timeout: 60000 });
      const frame = await (await frameEl.elementHandle()).contentFrame();
      if (!frame) throw new Error("the InfoView iframe has no frame");
      const seen = await foreignShow((fn, a) => page.evaluate(fn, a), (fn, a) => frame.evaluate(fn, a));
      const failures = foreignShowFailures(seen);
      record("foreign-show", failures.length === 0 && errors.length === 0, `failed checks ${JSON.stringify(failures)}; ${JSON.stringify(seen)}; page errors ${JSON.stringify(errors)}`);
      await context.close();
    },
  };

  try {
    for (const name of scenarios) await lanes[name]();
  } catch (e) {
    record("harness", false, `threw: ${String(e?.stack ?? e).slice(0, 400)}`);
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`infoview-actions: ${results.length - failed}/${results.length} pass; report ${path.relative(root, path.join(dir, "infoview-actions-report.json"))}`);
  process.exitCode = exitCodeFor(results.length, failed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
