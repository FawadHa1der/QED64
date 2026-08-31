#!/usr/bin/env node
// Adversarial E2E harness: drives the lean4monaco front end in REAL headless
// Chromium (Playwright), independent of any interactive browser. Covers:
// boot timing + overlay behavior, golden message batteries (badge/list
// consistency), UI-glitch checks (stuck pill, stale diagnostics, frame-leak
// garbage in the InfoView), editor action storms with recovery expectations,
// worker-kill recovery drill, memory telemetry per scenario, and speed
// budgets. Screenshots + console tails on every failure.
//
// Usage: node tests/adversarial/e2e.mjs [--url http://localhost:5187/] [--corpus corpus.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const url = arg("url", "http://localhost:5187/");
const corpusPath = arg("corpus", path.join(root, "tests/adversarial/corpus.json"));
const artDir = path.join(root, "work/adversarial/artifacts");
fs.mkdirSync(artDir, { recursive: true });

const corpus = fs.existsSync(corpusPath) ? JSON.parse(fs.readFileSync(corpusPath, "utf8")).items : [];
const results = [];
let consoleLog = [];

const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
const context = await browser.newContext();
let page;
let pageCrashes = 0;
function wirePage(p) {
  p.on("console", (m) => { consoleLog.push(m.text().slice(0, 300)); if (consoleLog.length > 400) consoleLog.shift(); });
  p.on("pageerror", (e) => consoleLog.push(`PAGEERROR: ${e.message.slice(0, 200)}`));
  p.on("crash", () => { pageCrashes += 1; consoleLog.push("PAGE-CRASHED"); });
}
async function freshPage() {
  try { if (page && !page.isClosed()) await page.close(); } catch { /* gone */ }
  page = await context.newPage();
  wirePage(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const r = await waitPill(/^ready$/, 480000, 1000);
  if (!r.ok) console.log(`freshPage: boot did not settle (${r.s.slice(0, 40)}) — continuing`);
}
page = await context.newPage();
wirePage(page);

const pill = () => page.evaluate(() => (document.getElementById("ptext") || {}).textContent || "");
const ivText = () => page.evaluate(() => {
  const f = document.getElementById("infoview")?.querySelector("iframe");
  return f && f.contentDocument ? f.contentDocument.body.innerText : "";
});
async function waitPill(re, timeoutMs, minMs = 0) {
  const t0 = Date.now();
  for (;;) {
    const s = await pill();
    if (Date.now() - t0 >= minMs && re.test(s)) return { ok: true, ms: Date.now() - t0, s };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, s };
    await page.waitForTimeout(400);
  }
}
async function setBuffer(text) {
  await page.evaluate((t) => { globalThis.qed64.editor.getModel().setValue(t); }, text);
}
async function memSample() {
  if (!page || page.isClosed()) return {};
  return page.evaluate(async () => {
    const out = { jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
    try {
      const tel = await globalThis.qed64.shim.qs.session.request("telemetry", {});
      if (tel.memory) { out.wasmMB = Math.round(tel.memory.currentBytes / 1048576); out.maxGiB = tel.memory.maximumBytes / 1073741824; }
    } catch { /* dead session mid-drill is fine */ }
    return out;
  });
}
async function record(name, category, pass, detail, extra = {}) {
  const entry = { name, category, pass, detail, mem: await memSample().catch(() => ({})), ...extra };
  if (!pass) {
    const shot = path.join(artDir, `${name.replace(/[^\w.-]/g, "_")}.png`);
    if (page && !page.isClosed()) await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    entry.screenshot = shot;
    entry.consoleTail = consoleLog.slice(-25);
  }
  results.push(entry);
  // Flush incrementally: a hung or killed run must not lose its findings.
  fs.writeFileSync(path.join(root, "work/adversarial/e2e-report.json"),
    JSON.stringify({ lane: "e2e", url, inProgress: true, total: results.length, failed: results.filter((r) => !r.pass).length, results }, null, 2));
  console.log(`${pass ? "ok  " : "FAIL"} [${category}] ${name}${pass ? "" : " — " + detail}`);
}
const panicsInConsole = () => consoleLog.filter((l) => /PANIC|assertion violation|Maximum call stack/.test(l)).length;
const GOLDEN_7 = {
  source: `import Mathlib.Data.Real.Basic\n\nexample : (1:ℝ) + 1 = 3 := by rfl\nexample (a : ℝ) : a * 0 = a := by simpa\nexample : Nat := "not a nat"\nnoncomputable def f (x : ℝ) : ℝ := x + unknownIdent\nexample (a b : ℝ) : a + b = b + a := by exact wrongLemma\nexample : False := sorry\nexample : (2:ℕ) < 1 := by decide\n`,
  positions: ["3:30", "4:34", "5:17", "6:39", "7:46", "8:0", "9:26"],
  frags: ["Tactic `rfl` failed", "Type mismatch", "Unknown identifier `unknownIdent`", "declaration uses `sorry`", "proved that the proposition"],
};

// ---------- scenario: cold-ish boot with overlay behavior --------------------
{
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const iso = await page.evaluate(() => crossOriginIsolated);
  const interactive = await waitPill(/^ready/, 600000);
  const settled = await waitPill(/^ready$/, 300000, 1000);
  const bootMs = Date.now() - t0;
  const overlayGone = await page.evaluate(() => { const b = document.getElementById("boot"); return !b || b.classList.contains("done"); });
  const pass = iso && interactive.ok && settled.ok && overlayGone && bootMs < 720000;
  await record("boot", "startup", pass,
    `isolated=${iso} interactive=${interactive.ok} settled=${settled.ok}@${bootMs}ms overlayGone=${overlayGone}`,
    { bootMs });
}

// ---------- scenario: golden 7-error battery + badge/list consistency --------
{
  consoleLog = [];
  await setBuffer(GOLDEN_7.source);
  await waitPill(/^ready$/, 90000, 2500);
  await page.waitForTimeout(4500);
  await page.evaluate(async () => {
    const doc = document.getElementById("infoview").querySelector("iframe").contentDocument;
    const det = [...doc.querySelectorAll("details")].find((d) => /All Messages/.test((d.querySelector("summary") || {}).textContent || ""));
    if (det && !det.open) det.querySelector("summary").click();
  });
  await page.waitForTimeout(3500);
  const t = await ivText();
  // scope position extraction to the All-Messages section (the goals panel
  // above it also renders a Probe.lean:N:N header for the cursor)
  const allIdx = t.indexOf("All Messages");
  const scoped = allIdx >= 0 ? t.slice(allIdx) : t;
  const got = (scoped.match(/Probe\.lean:(\d+:\d+)/g) || []).map((x) => x.slice(11));
  const posOk = JSON.stringify([...new Set(got)]) === JSON.stringify(GOLDEN_7.positions);
  const fragMissing = GOLDEN_7.frags.filter((f) => !t.includes(f));
  const badge = ((t.match(/All Messages \(([^)]*)\)/) || [])[1] || "").trim();
  const frameGarbage = /Content-Length|jsonrpc/.test(t);
  const pass = posOk && fragMissing.length === 0 && /6/.test(badge) && !frameGarbage && panicsInConsole() === 0;
  await record("golden-7-battery", "messages", pass,
    `positions=${posOk} missingFrags=${JSON.stringify(fragMissing)} badge='${badge}' frameGarbage=${frameGarbage} panics=${panicsInConsole()}`);
}

// ---------- scenario: introduce/remove error clears (staleness) --------------
{
  await setBuffer("import Mathlib.Data.Real.Basic\n\nexample (a b : ℝ) : a + b = b + a := add_comm a b\n");
  await waitPill(/^ready$/, 60000, 1500);
  await page.evaluate(() => {
    const m = globalThis.qed64.editor.getModel();
    const col = m.getValue().split("\n")[2].indexOf("add_comm") + 1;
    m.applyEdits([{ range: { startLineNumber: 3, startColumn: col, endLineNumber: 3, endColumn: col }, text: "zzz" }]);
  });
  const errIn = await (async () => { const t0 = Date.now(); for (;;) { if (/zzzadd|Unknown identifier/.test(await ivText())) return true; if (Date.now() - t0 > 25000) return false; await page.waitForTimeout(400); } })();
  await page.evaluate(() => {
    const m = globalThis.qed64.editor.getModel();
    const col = m.getValue().split("\n")[2].indexOf("zzz") + 1;
    m.applyEdits([{ range: { startLineNumber: 3, startColumn: col, endLineNumber: 3, endColumn: col + 3 }, text: "" }]);
  });
  const t0 = Date.now();
  let clearedMs = null;
  for (;;) { if (!/zzzadd|Unknown identifier/.test(await ivText())) { clearedMs = Date.now() - t0; break; } if (Date.now() - t0 > 30000) break; await page.waitForTimeout(300); }
  await record("error-clear-staleness", "messages", errIn && clearedMs !== null && clearedMs < 15000,
    `errShown=${errIn} clearedMs=${clearedMs}`, { clearedMs });
}

// ---------- scenario: import composition (calm path) -------------------------
{
  consoleLog = [];
  await setBuffer("");
  await page.waitForTimeout(5000);
  await page.evaluate(() => globalThis.qed64.editor.getModel().applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "import Mathlib.Da" }]));
  const incomplete = await waitPill(/imports incomplete/, 30000);
  const noChurn = !consoleLog.some((l) => /Starting the Emscripten runtime/.test(l));
  await page.evaluate(() => { const m = globalThis.qed64.editor.getModel(); const c = m.getLineMaxColumn(1);
    m.applyEdits([{ range: { startLineNumber: 1, startColumn: c, endLineNumber: 1, endColumn: c }, text: "ta.Real.Basic\n\nexample (a b : ℝ) : a + b = b + a := add_comm a b\n" }]); });
  const done = await waitPill(/^ready$/, 60000, 2000);
  const noteGone = !/do not resolve/.test(await ivText());
  await record("import-composition", "functional", incomplete.ok && done.ok && noteGone && noChurn,
    `incomplete=${incomplete.ok} recovered=${done.ok}@${done.ms}ms noteGone=${noteGone} noRebootChurn=${noChurn}`);
}

// ---------- scenario: example switch speed budget ----------------------------
{
  for (const [target, budget] of [["init", 20000], ["mathlib", 25000]]) {
    const t0 = Date.now();
    await page.selectOption("#examples", target);
    const r = await waitPill(/^ready$/, budget + 30000, 2500);
    await record(`switch-${target}`, "speed", r.ok && r.ms < budget + 5000, `readyMs=${r.ms} budget=${budget}`, { switchMs: r.ms });
    await page.waitForTimeout(1500);
  }
}

// ---------- corpus editor-action scripts -------------------------------------
// Heavy scenarios accumulate wasm/JS heap in the shared session; a fresh page
// every few scenarios keeps deaths attributable to the SCENARIO, not the pile.
// --only <regex> narrows the corpus action scripts (isolation reruns of a
// flaky scenario get a fresh page and no cohort contamination).
const only = arg("only", "");
const actionItems = corpus.filter((it) => Array.isArray(it.actions) && it.actions.length)
  .filter((it) => !only || new RegExp(only).test(it.name));
let sinceFresh = 0;
for (const item of actionItems) {
  consoleLog = [];
  if (sinceFresh >= 4) { await freshPage(); sinceFresh = 0; }
  sinceFresh += 1;
  try {
    for (const a of item.actions) {
      switch (a.op) {
        case "setValue": await setBuffer(a.text ?? ""); break;
        case "typeAppend": await page.evaluate((t) => { const m = globalThis.qed64.editor.getModel(); const ln = m.getLineCount(); const c = m.getLineMaxColumn(ln); m.applyEdits([{ range: { startLineNumber: ln, startColumn: c, endLineNumber: ln, endColumn: c }, text: t } ]); }, a.text ?? ""); break;
        case "typeAt": await page.evaluate(({ t, l, c }) => { const m = globalThis.qed64.editor.getModel(); const ln = Math.min(l || 1, m.getLineCount()); const col = Math.min(c || 1, m.getLineMaxColumn(ln)); m.applyEdits([{ range: { startLineNumber: ln, startColumn: col, endLineNumber: ln, endColumn: col }, text: t }]); }, { t: a.text ?? "", l: a.line, c: a.col }); break;
        case "deleteRange": await page.evaluate(({ l, c, el, ec }) => { const m = globalThis.qed64.editor.getModel(); m.applyEdits([{ range: { startLineNumber: l, startColumn: c, endLineNumber: el, endColumn: ec }, text: "" }]); }, { l: a.line ?? 1, c: a.col ?? 1, el: a.endLine ?? 1, ec: a.endCol ?? 1 }).catch(() => {}); break;
        case "switchExample": await page.selectOption("#examples", a.value ?? "mathlib"); break;
        case "undo": await page.evaluate(() => globalThis.qed64.editor.trigger("t", "undo")); break;
        case "redo": await page.evaluate(() => globalThis.qed64.editor.trigger("t", "redo")); break;
        case "setCursor": await page.evaluate(({ l, c }) => globalThis.qed64.editor.setPosition({ lineNumber: l || 1, column: c || 1 }), { l: a.line, c: a.col }); break;
        case "pause": await page.waitForTimeout(Math.min(a.ms ?? 500, 20000)); break;
      }
    }
    // settle: alive AND in a terminal state (ready / actionable import note / breaker)
    const settle = await waitPill(/^ready$|imports (incomplete|failed)|keeps crashing/, 120000, 2000);
    const alive = await page.evaluate(() => !!globalThis.qed64).catch(() => false);
    const panics = panicsInConsole();
    const pass = alive && settle.ok && (item.expect.panicFree ? panics === 0 : true)
      && (item.expect.mustSucceed ? /^ready$/.test(settle.s) : true);
    await record(item.name, `editor/${item.category}`, pass,
      `alive=${alive} settled='${settle.s.slice(0, 40)}'@${settle.ms}ms panics=${panics}`);
  } catch (e) {
    const alive = await page.evaluate(() => !!globalThis.qed64).catch(() => false);
    results.push({ name: item.name, category: `editor/${item.category}`, pass: false,
      detail: `threw: ${String(e).slice(0, 140)} alive=${alive} pageCrashes=${pageCrashes}`,
      consoleTail: consoleLog.slice(-20) });
    console.log(`FAIL [editor/${item.category}] ${item.name} — threw (alive=${alive})`);
    if (!alive) await freshPage();
  }
}

// ---------- scenario: import-path completion (live parity) -------------------
{
  await setBuffer("");
  await page.waitForTimeout(4000);
  await page.click(".monaco-editor .view-lines").catch(() => {});
  await page.keyboard.type("import Mathlib.Data.Re", { delay: 40 });
  const rowSel = ".suggest-widget .monaco-list-row";
  const appeared = await page.waitForSelector(rowSel, { timeout: 10000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(1500);
  const focused = appeared ? await page.$eval(`${rowSel}.focused`, (r) => r.getAttribute("aria-label")).catch(() => null) : null;
  if (appeared) await page.keyboard.press("Tab");
  await page.waitForTimeout(800);
  const line1 = await page.evaluate(() => globalThis.qed64.editor.getModel().getValue().split("\n")[0]);
  const accepted = /^import Mathlib\.Data\.Re[\w.]+$/.test(line1) && line1 !== "import Mathlib.Data.Re";
  await record("import-completion", "functional", appeared && focused !== null && accepted,
    `widget=${appeared} focused='${focused}' line1='${line1}'`);
}

// ---------- recovery drill: hard worker kill ---------------------------------
{
  await freshPage();
  await page.selectOption("#examples", "mathlib").catch(() => {});
  await waitPill(/^ready$/, 90000, 2000);
  await page.evaluate(() => { globalThis.qed64.shim.qs.session.worker.terminate(); });
  const recovered = await waitPill(/^ready$/, 180000, 4000);
  // give the replayed elaboration a beat to republish diagnostics
  let badge = "";
  for (let i = 0; i < 30; i++) {
    badge = (((await ivText()).match(/All Messages \(([^)]*)\)/) || [])[1] || "").trim();
    if (/2/.test(badge)) break;
    await page.waitForTimeout(1000);
  }
  await record("worker-kill-recovery", "recovery", recovered.ok && /2/.test(badge),
    `recovered=${recovered.ok}@${recovered.ms}ms badge='${badge}'`, { recoveryMs: recovered.ms });
}

// ---------- final: memory + stuck-pill sweep ---------------------------------
{
  const mem = await memSample();
  const wasmOk = mem.wasmMB === null || mem.wasmMB === undefined || mem.wasmMB < 3800;
  await record("final-memory", "memory", wasmOk, `wasm=${mem.wasmMB}MB js=${mem.jsHeapMB}MB (budget wasm<3800MB)`);
}

const failed = results.filter((r) => !r.pass);
fs.writeFileSync(path.join(root, "work/adversarial/e2e-report.json"), JSON.stringify({ lane: "e2e", url, total: results.length, failed: failed.length, results }, null, 2));
console.log(`\ne2e: ${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
