#!/usr/bin/env node
// InfoView editor actions in REAL headless Chromium, or Firefox with
// `--browser firefox` (docs/HARDENING.md #56): lean4monaco's InfoView wiring,
// fixed in QED64.
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
//   focus-return      init only (HARDENING #85, UX parity FILL-A1): four rounds
//                     with real clicks, each from a click on the page's bar and
//                     then the editor. "apply": click [apply], then Ctrl/Cmd+Z
//                     with no other click must undo it (the editor has the
//                     focus). "click": a click in blank InfoView space takes the
//                     focus into the iframe; a click on the editor must take it
//                     back, and typed text must land. A round whose InfoView
//                     click did not take the focus fails, never passes. Firefox
//                     kept the keys in the iframe; it proves the fix only under
//                     `--browser firefox`, and Chromium is its control.
//   restart-file      init only (UX parity F1.13, HARDENING #56's F1.13 note):
//                     `#eval IO.monoNanosNow` and an `omega` example; a click on
//                     the InfoView's own Restart File button must reboot the
//                     session (reason "user"), settle ready on a new session,
//                     print a new #eval value and show the goal again. Before
//                     the fix the click re-checked nothing.
//   copy-to-comment   init only (UX parity I3.4, HARDENING #56's I3.4 note):
//                     the page's editor action "Lean 4: Copy Goal to
//                     Comment" is registered (getAction, and listed in the
//                     editor's supported actions, which the F1 palette
//                     shows); run with the cursor on `omega`, the InfoView's
//                     insertText("above") lands the goal as a `/- … -/` block
//                     above it, indented like it, which checks to ready with
//                     no error; one Ctrl/Cmd+Z restores the text.
//
// Usage: node tests/adversarial/infoview-actions.mjs [--url http://localhost:5199/] [--only <scenario>] [--browser chromium|firefox] [--run-dir <dir>]
// Run it through the host browser lock. Exit 0 all pass, 1 a scenario failed,
// 3 infrastructure refusal (an --only that selects no scenario included).
// Every scenario runs on its own page. The selection, the in-browser probes and
// the verdicts are exported for tests/unit/infoview-actions.test.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, browserName, fetchJson, launchBrowser, onlyMatches, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

export const SCENARIOS = ["capability-flag", "try-this-apply", "conv-generate", "foreign-show", "focus-return", "restart-file", "copy-to-comment"];
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
  restartFile: ".restart-file-button",
};
const DOC_A = "example (n : Nat) : n + 0 = n := by simp?\n";
const DOC_B = "import Mathlib.Tactic.Widget.Conv\n\nexample (a b c : Nat) : a + (b + c) = (c + b) + a := by\n  conv?\n  omega\n";
const DOC_R = "#eval IO.monoNanosNow\n\nexample (a b : Nat) : a + b = b + a := by\n  omega\n";
// copy-to-comment: the InfoView's block (`/-\n<goals>\n-/`, its goalsToString: no case name for the one goal, `Nat`
// without Mathlib), indented like the cursor's line; tests/unit/infoview-edits.test.ts pins the same string.
const DOC_C = "example (a b : Nat) : a + b = b + a := by\n  omega\n";
const COPIED_C = "example (a b : Nat) : a + b = b + a := by\n  /-\n  a b : Nat\n  ⊢ a + b = b + a\n  -/\n  omega\n";
const COPY_ACTION = { id: "qed64.copyGoalToComment", label: "Lean 4: Copy Goal to Comment" };
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
/** focus-return: the checks one round failed (none = pass). A round that could
 * not see the trap never passes: the editor must hold the focus before the
 * InfoView click, and a plain InfoView click must take it into the iframe (in
 * Firefox only that move traps the next click on the editor). */
export function focusReturnFailures(r) {
  const before = { "the editor had the focus before the InfoView click": r.before?.editorFocus === true };
  const checks = r.kind === "apply"
    ? {
        ...before,
        "[apply] landed": r.applied === true,
        "the editor has the focus after [apply]": r.afterAction?.editorFocus === true,
        "Ctrl/Cmd+Z after [apply] undid it": r.undone === true,
      }
    : {
        ...before,
        "the InfoView click took the focus": r.afterInfoview?.focus === "IFRAME",
        "the editor has the focus after a click on it": r.afterAction?.editorFocus === true,
        "typed text landed in the editor": r.typed === true,
      };
  return Object.keys(checks).filter((k) => !checks[k]);
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
/** A real mouse click on the editor at (line, column), through the browser's input as a visitor's. */
async function clickEditorAt(page, lineNumber, column) {
  const xy = await page.evaluate(([l, c]) => {
    const e = globalThis.qed64.editor;
    const p = e.getScrolledVisiblePosition({ lineNumber: l, column: c });
    const r = e.getDomNode().getBoundingClientRect();
    return p ? { x: r.left + p.left + 2, y: r.top + p.top + p.height / 2 } : null;
  }, [lineNumber, column]);
  if (!xy) throw new Error(`clickEditorAt: ${lineNumber}:${column} is not visible`);
  await page.mouse.click(xy.x, xy.y);
}
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
/** The `#eval` output on line 1 the client received last (an information diagnostic). */
const evalOutput = (page) => page.evaluate(() => (globalThis.__diags?.diagnostics ?? []).find((d) => d.range.start.line === 0 && d.severity === 3)?.message ?? null);

async function main() {
  try { browserName(); } catch (e) { console.error(`infoview-actions: refused — ${e.message}`); process.exit(3); }
  const firefox = browserName() === "firefox";
  const SLOW = firefox ? 2 : 1; // Playwright's Firefox runs wasm several times slower
  const url = arg("url", "http://localhost:5199/");
  const only = arg("only", "");
  const scenarios = selectScenarios(only);
  if (scenarios.length === 0) { console.error(`infoview-actions: refused — --only ${JSON.stringify(only)} selects none of ${SCENARIOS.join(", ")}`); process.exit(3); }
  const target = resolveTarget(url);
  const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`infoview-actions: refused — ${e.message}`); process.exit(3); });
  const dir = runDir(manifest.buildId ?? "unknown", firefox ? `${target.mode}-firefox` : target.mode);
  teeLog(dir, "infoview-actions.log");
  console.log(`infoview-actions: ${url} → ${manifest.buildId} (${browserName()}); ${scenarios.join(", ")}; reports in ${path.relative(root, dir)}`);

  const results = [];
  let failed = 0;
  function record(name, ok, detail, extra = {}) {
    results.push({ name, outcome: ok ? "pass" : "fail", detail, ...extra });
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
    fs.writeFileSync(path.join(dir, "infoview-actions-report.json"), JSON.stringify({ url, buildId: manifest.buildId, browser: browserName(), total: results.length, failed, results }, null, 2));
  }

  const browser = await launchBrowser().catch((e) => { console.error(`infoview-actions: refused — ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`); process.exit(3); });
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
      if (Date.now() - t0 > budgetMs * SLOW) throw new Error(`not ready within ${budgetMs * SLOW} ms (phase ${ph})`);
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

    "focus-return": async () => {
      // HARDENING #85 (UX parity FILL-A1): the proof runs under --browser firefox; Chromium is the control.
      const { page, context, errors } = await boot(DOC_A, 300000);
      const iv = page.frameLocator(SEL.frame);
      const link = iv.locator(SEL.coreTryThis, { hasText: "[apply]" }).first();
      const col = DOC_A.indexOf("simp?") + 3;
      const rounds = [];
      for (const kind of ["apply", "click", "apply", "click"]) {
        await waitFor(() => ready(page), 60000 * SLOW); // an undo or a setDocument re-checks DOC_A: no stale [apply]
        // A known start: a failed round leaves the focus in the iframe, and there the next InfoView click is no move
        // into it (a round on the unfixed build then passed). A click on the bar's title brings it back to this page.
        await page.locator("#bar .title").click();
        await clickEditorAt(page, 1, col);
        await link.waitFor({ timeout: 60000 * SLOW });
        const r = { kind, before: await page.evaluate(editorView) };
        if (kind === "apply") {
          await link.click();
          r.applied = !!(await waitFor(async () => ((await text(page)) !== DOC_A) || null, 10000));
          await sleep(300);
          r.afterAction = await page.evaluate(editorView);
          await page.keyboard.press("ControlOrMeta+KeyZ"); // no click first: Firefox lost this key (the study's log-ff2.json)
          r.undone = !!(await waitFor(async () => ((await text(page)) === DOC_A) || null, 3000));
        } else {
          const box = await page.locator(SEL.frame).last().boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12); // blank InfoView space below its content
          await sleep(300);
          r.afterInfoview = await page.evaluate(editorView);
          await clickEditorAt(page, 1, col);
          await sleep(300);
          r.afterAction = await page.evaluate(editorView);
          await page.keyboard.type("zz", { delay: 50 });
          r.typed = !!(await waitFor(async () => (await text(page)).includes("zz") || null, 3000));
        }
        rounds.push({ kind, before: r.before.focus, afterInfoview: r.afterInfoview?.focus, afterAction: r.afterAction?.focus, failures: focusReturnFailures(r) });
        if ((await text(page)) !== DOC_A) await page.evaluate((t) => globalThis.qed64.api.setDocument(t), DOC_A);
      }
      const failures = rounds.flatMap((r, i) => r.failures.map((f) => `round ${i + 1} (${r.kind}): ${f}`));
      record("focus-return", failures.length === 0 && errors.length === 0, `${browserName()}; failed checks ${JSON.stringify(failures)}; rounds ${JSON.stringify(rounds)}; page errors ${JSON.stringify(errors)}`);
      await page.screenshot({ path: path.join(dir, `focus-return-${browserName()}.png`) }).catch(() => {});
      await context.close();
    },

    "restart-file": async () => {
      // UX parity F1.13 (HARDENING #56's F1.13 note): before the fix the click re-checked nothing (same #eval value, no reboot).
      const { page, context, errors } = await boot("-- restart-file\n", 300000);
      await installDiagTap(page); // before the document, so its publish is seen
      await page.evaluate(async (t) => { const api = globalThis.qed64.api; await api.setDocument(t); await api.settled({ timeoutMs: 120000 }); }, DOC_R);
      const v1 = await waitFor(() => evalOutput(page), 10000);
      const before = await page.evaluate(() => {
        globalThis.__reboots = [];
        globalThis.qed64.api.on("reboot", (p) => globalThis.__reboots.push(p));
        return globalThis.qed64.api.status().session;
      });
      await cursorAt(page, 4, 3);
      const iv = page.frameLocator(SEL.frame);
      const button = iv.locator(SEL.restartFile).first();
      const found = await button.waitFor({ timeout: 30000 }).then(() => true, () => false);
      let reboot = null, settled = null, v2 = null, goalNoMove = false, goalAfterMove = false;
      if (found) {
        await button.click();
        reboot = await waitFor(() => page.evaluate((b) => globalThis.__reboots.find((x) => x.fromSession === b) ?? null, before), 30000);
        settled = reboot ? await page.evaluate((b) => globalThis.qed64.api.settled({ afterSession: b, timeoutMs: 180000 }).then((s) => ({ phase: s.phase, session: s.session }), (e) => ({ error: String(e?.message ?? e) })), before) : null;
        v2 = await waitFor(async () => { const v = await evalOutput(page); return v !== null && v !== v1 ? v : null; }, 20000);
        // The InfoView writes `a b : Nat` with a no-break space.
        const goal = () => iv.locator("body").innerText().then((t) => /a b : Nat/.test(t.replace(/\u00a0/g, " ")) || null, () => null);
        goalNoMove = !!(await waitFor(goal, 20000, 500));
        if (!goalNoMove) { await cursorAt(page, 3, 1); await cursorAt(page, 4, 3); goalAfterMove = !!(await waitFor(goal, 20000, 500)); }
      }
      const ok = found && reboot?.reason === "user" && settled?.phase === "ready" && settled.session !== before
        && v1 !== null && v2 !== null && (goalNoMove || goalAfterMove) && errors.length === 0;
      record("restart-file", ok, `button ${found}; reboot ${JSON.stringify(reboot)}; settled ${JSON.stringify(settled)}; #eval before ${v1} after ${v2}; goal without a cursor move ${goalNoMove}, after one ${goalAfterMove}; page errors ${JSON.stringify(errors)}`);
      await page.screenshot({ path: path.join(dir, "restart-file.png") }).catch(() => {});
      await context.close();
    },

    "copy-to-comment": async () => {
      // UX parity I3.4: before the change the page registered no such action (lean4monaco drops VS Code's menus).
      const { page, context, errors } = await boot(DOC_C, 300000);
      await installDiagTap(page);
      await cursorAt(page, 2, 3);
      // The InfoView answers copyToComment only with a goal at the cursor. It writes `a b : Nat` with a no-break space.
      const iv = page.frameLocator(SEL.frame);
      const goal = () => iv.locator("body").innerText().then((t) => /⊢ a \+ b = b \+ a/.test(t.replace(/\u00a0/g, " ")) || null, () => null);
      const goalShown = !!(await waitFor(goal, 60000 * SLOW, 500));
      // getAction takes the id given to addAction; the action's own `id` is Monaco's `<editor id>:<id>`.
      const action = await page.evaluate(({ id }) => {
        const e = globalThis.qed64.editor, a = e.getAction(id);
        return { label: a?.label ?? null, listed: !!a && e.getSupportedActions().includes(a) };
      }, COPY_ACTION);
      let copied = null, phase = null, errs = ["not reached"], undone = null;
      if (action.label) {
        await page.evaluate(({ id }) => globalThis.qed64.editor.getAction(id).run(), COPY_ACTION);
        copied = await waitFor(async () => { const t = await text(page); return t !== DOC_C ? t : null; }, 10000);
        phase = copied ? await page.evaluate((ms) => globalThis.qed64.api.settled({ timeoutMs: ms }).then((s) => s.phase, (e) => `threw ${e}`), 120000 * SLOW) : null;
        errs = phase === "ready" ? await errorDiags(page) : ["not settled"];
        await page.screenshot({ path: path.join(dir, "copy-to-comment.png") }).catch(() => {});
        // One undo with the real keys: the InfoView's insertText gave the editor the keyboard (HARDENING #85).
        await page.keyboard.press("ControlOrMeta+KeyZ");
        undone = await waitFor(async () => ((await text(page)) === DOC_C ? true : null), 5000);
      }
      const checks = {
        "the InfoView shows the goal": goalShown,
        "the action is registered with its label": action.label === COPY_ACTION.label,
        "it is among the editor's supported actions (the F1 palette)": action.listed,
        "it lands the goal as a comment above the cursor's line": copied === COPIED_C,
        "that checks to ready with no error": phase === "ready" && errs.length === 0,
        "one Ctrl/Cmd+Z restores the text": !!undone,
        "no page errors": errors.length === 0,
      };
      const failures = Object.keys(checks).filter((k) => !checks[k]);
      record("copy-to-comment", failures.length === 0, `failed checks ${JSON.stringify(failures)}; action ${JSON.stringify(action)}; text after ${JSON.stringify(copied)}; phase ${phase}; error diagnostics ${JSON.stringify(errs)}; page errors ${JSON.stringify(errors)}`);
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
