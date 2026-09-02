#!/usr/bin/env node
// Adversarial E2E harness: drives the lean4monaco front end in REAL headless
// Chromium (Playwright), independent of any interactive browser. Covers:
// boot timing + overlay behavior, golden message batteries (badge/list
// consistency), UI-glitch checks (stuck pill, stale diagnostics, frame-leak
// garbage in the InfoView), editor action storms with recovery expectations,
// worker-kill recovery drill, memory telemetry per scenario, and speed
// budgets. Screenshots + console tails on every failure.
//
// Harness trust (review C7, phase 0): every row carries an outcome from
// {pass, fail, infra, refused, aborted} — a page that cannot boot is ONE
// `infra` row and the run aborts (freshPage throws), never N scenario
// failures; reports go to a per-run directory
// work/adversarial/runs/<ts>-<buildId>-<mode>/ (plus the legacy
// work/adversarial/e2e-report.json for existing scripts); shim stats deltas
// are recorded per scenario once the shim exposes `stats`.
//
// Usage: node tests/adversarial/e2e.mjs [--url http://localhost:5187/] [--corpus corpus.json]
//        [--only <exact scenario name>] [--run-dir <dir>] [--boot-budget-ms 480000]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { arg, fetchJson, onlyMatches as onlyMatchesName, resolveTarget, root, runDir, settleClass, teeLog } from "./harness.mjs";

const url = arg("url", "http://localhost:5187/");
const corpusPath = arg("corpus", path.join(root, "tests/adversarial/corpus.json"));
const bootBudgetMs = Number(arg("boot-budget-ms", "480000"));
const target = resolveTarget(url);
// The run identity (buildId + mode) comes from what the page will boot. An
// unreachable manifest is an infrastructure refusal, not a scenario result.
const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`e2e: refused — ${e.message}`); process.exit(3); });
const buildId = manifest.buildId ?? "unknown";
const dir = runDir(buildId, target.mode);
teeLog(dir, "e2e.log");
const artDir = path.join(dir, "artifacts");
fs.mkdirSync(artDir, { recursive: true });
fs.mkdirSync(path.join(root, "work/adversarial"), { recursive: true });
console.log(`e2e: ${url} → ${buildId} (${target.mode}); reports in ${path.relative(root, dir)}`);

const corpus = fs.existsSync(corpusPath) ? JSON.parse(fs.readFileSync(corpusPath, "utf8")).items : [];
// Battery-only keys on an editor-action item are dead here (review C7: four
// items "passed" at 'keeps crashing' because nothing read them) — refuse
// the corpus rather than run expectations nobody evaluates.
for (const it of corpus) {
  if (!(Array.isArray(it.actions) && it.actions.length)) continue;
  const dead = ["containsMsgs", "budgetMs", "mustError"].filter((k) => k in (it.expect ?? {}));
  if (dead.length) { console.error(`corpus: action item ${it.name} carries battery-only keys ${dead.join(", ")} — use expect.terminal/mustSucceed/settleMs (exit 3)`); process.exit(3); }
  if (it.expect?.terminal && !["ready", "headerUnresolvable", "halted"].includes(it.expect.terminal)) { console.error(`corpus: ${it.name}: unknown terminal ${it.expect.terminal} (exit 3)`); process.exit(3); }
}
// --only <name>: run just that scenario — a corpus item OR one of the fixed
// scenarios below (boot always runs: it is the precondition) — the isolation
// mode for chasing one flaky scenario without cohort contamination.
// Whole-name matching lives in harness.mjs (pinned by
// tests/unit/adversarial-harness.test.ts).
const FIXED = ["golden-7-battery", "error-clear-staleness", "import-composition", "switch-init", "switch-mathlib", "import-completion", "worker-kill-recovery", "final-memory"];
const only = arg("only", "");
const onlyMatches = (name) => onlyMatchesName(name, only);
const runs = (name) => !only || onlyMatches(name);
if (only && !corpus.some((it) => onlyMatches(it.name)) && !FIXED.some(onlyMatches)) {
  console.error(`--only ${JSON.stringify(only)} matches no corpus or fixed scenario (${FIXED.join(", ")}) — refusing (exit 3)`);
  process.exit(3);
}
const results = [];
let consoleLog = [];
let pageCrashes = 0;

/** Thrown when the page cannot boot: the run is not measuring the product. */
class InfraError extends Error {}

const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
const context = await browser.newContext();
let page;
function wirePage(p) {
  p.on("console", (m) => { consoleLog.push(m.text().slice(0, 300)); if (consoleLog.length > 400) consoleLog.shift(); });
  p.on("pageerror", (e) => consoleLog.push(`PAGEERROR: ${e.message.slice(0, 200)}`));
  p.on("crash", () => { pageCrashes += 1; consoleLog.push("PAGE-CRASHED"); });
}
/** A fresh page that MUST boot; anything else is an InfraError that aborts
 * the run (today's "continuing" turned an unbootable runtime into a cascade
 * of scenario failures — HARDENING #32/#33). Infra means the page never
 * became INTERACTIVE (`ready…`) — a page that is alive but slow to settle
 * under machine load (kernel builds push pump boots past 400 s) is not an
 * environment refusal; it is logged and the scenario judges it. */
async function freshPage() {
  try { if (page && !page.isClosed()) await page.close(); } catch { /* gone */ }
  page = await context.newPage();
  wirePage(page);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const interactive = await waitPill(/^ready/, bootBudgetMs, 1000);
  if (!interactive.ok) throw new InfraError(`fresh page did not boot within ${bootBudgetMs} ms (pill '${interactive.s.slice(0, 40)}', pageCrashes=${pageCrashes})`);
  const settled = await waitPill(/^ready$/, bootBudgetMs, 0);
  if (!settled.ok) console.log(`fresh page: interactive at ${interactive.ms} ms but not settled after ${bootBudgetMs} ms more (pill '${settled.s.slice(0, 40)}') — continuing`);
  return Date.now() - t0;
}
page = await context.newPage();
wirePage(page);

// A rejected evaluate is a page that is gone (crashed, closed, navigated
// away) — waitPill must see that in one poll, not after the full settle
// budget (up to 420 s) elapses on an empty string.
const DEAD = "\0dead";
const pill = () => page.evaluate(() => (document.getElementById("ptext") || {}).textContent || "").catch(() => DEAD);
const ivText = () => Promise.race([
  page.evaluate(() => {
    const f = document.getElementById("infoview")?.querySelector("iframe");
    return f && f.contentDocument ? f.contentDocument.body.innerText : "";
  }).catch(() => ""),
  new Promise((res) => setTimeout(() => res(""), 10000)),
]);
async function waitPill(re, timeoutMs, minMs = 0) {
  const t0 = Date.now();
  let deadPolls = 0;
  for (;;) {
    const s = await pill();
    // Two consecutive rejections a second apart: the page is dead, not
    // mid-navigation. Short-circuit so the alive probe + freshPage run now.
    if (s === DEAD) {
      if (++deadPolls >= 2) return { ok: false, ms: Date.now() - t0, s: "dead", dead: true };
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    deadPolls = 0;
    if (Date.now() - t0 >= minMs && re.test(s)) return { ok: true, ms: Date.now() - t0, s };
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0, s };
    await page.waitForTimeout(400);
  }
}
// Terminal classes the pill can settle in today (pump-era labels, see
// harness.settleClass). When the shim exposes a phase enum (attacks.txt #3)
// this becomes a read of `qed64.status().phase`; the corpus keys
// (`expect.terminal`) already use the enum names so the corpus never changes again.
const SETTLE_RE = /^ready$|imports (incomplete|failed)|keeps crashing/;
async function setBuffer(text) {
  await page.evaluate((t) => { globalThis.qed64.editor.getModel().setValue(t); }, text);
}
async function memSample() {
  if (!page || page.isClosed()) return {};
  // The telemetry request inside goes to the worker — a wedged worker never
  // answers, and an unresolved evaluate would hang record() (and the run).
  return Promise.race([
    new Promise((res) => setTimeout(() => res({ stale: true }), 8000)),
    page.evaluate(async () => {
    const out = { jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
    try {
      const tel = await globalThis.qed64.shim.qs.session.request("telemetry", {});
      if (tel.memory) { out.wasmMB = Math.round(tel.memory.currentBytes / 1048576); out.maxGiB = tel.memory.maximumBytes / 1073741824; }
    } catch { /* dead session mid-drill is fine */ }
    return out;
  }).catch(() => ({})),
  ]);
}
/** Shim counters (`globalThis.qed64.shim.stats`, landing with the shim
 * rewrite) — null until they exist; never a reason to fail. */
async function statsSnap() {
  if (!page || page.isClosed()) return null;
  return Promise.race([
    new Promise((res) => setTimeout(() => res(null), 3000)),
    page.evaluate(() => {
      const s = globalThis.qed64?.shim?.stats;
      return s && typeof s === "object" ? JSON.parse(JSON.stringify(s)) : null;
    }).catch(() => null),
  ]);
}
const statsDelta = (before, after) => {
  if (!before || !after) return null;
  const d = {};
  for (const k of Object.keys(after)) if (typeof after[k] === "number" && typeof before[k] === "number") d[k] = after[k] - before[k];
  return d;
};
function writeReport(inProgress) {
  const counts = { total: results.length, failed: results.filter((r) => r.outcome !== "pass").length };
  for (const o of ["pass", "fail", "infra", "refused", "aborted"]) counts[o] = results.filter((r) => r.outcome === o).length;
  const report = { lane: "e2e", url, buildId, mode: target.mode, runDir: dir, inProgress, ...counts, results };
  const text = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(dir, "e2e-report.json"), text);
  fs.writeFileSync(path.join(root, "work/adversarial/e2e-report.json"), text);
}
/** One row per scenario. `outcome` is the verdict; `pass` stays for the
 * scripts that read the old report shape. */
async function record(name, category, outcome, detail, extra = {}) {
  if (typeof outcome === "boolean") outcome = outcome ? "pass" : "fail";
  const entry = { name, category, outcome, pass: outcome === "pass", detail, mem: outcome === "aborted" ? {} : await memSample().catch(() => ({})), ...extra };
  if (outcome === "fail" || outcome === "infra") {
    const shot = path.join(artDir, `${name.replace(/[^\w.-]/g, "_")}.png`);
    if (page && !page.isClosed()) await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    entry.screenshot = shot;
    entry.consoleTail = consoleLog.slice(-25);
  }
  results.push(entry);
  // Flush incrementally: a hung or killed run must not lose its findings.
  writeReport(true);
  console.log(`${outcome === "pass" ? "ok  " : outcome.toUpperCase().padEnd(4)} [${category}] ${name}${outcome === "pass" ? "" : " — " + detail}`);
}
const panicsInConsole = () => consoleLog.filter((l) => /PANIC|assertion violation|Maximum call stack/.test(l)).length;
const GOLDEN_7 = {
  source: `import Mathlib.Data.Real.Basic\n\nexample : (1:ℝ) + 1 = 3 := by rfl\nexample (a : ℝ) : a * 0 = a := by simpa\nexample : Nat := "not a nat"\nnoncomputable def f (x : ℝ) : ℝ := x + unknownIdent\nexample (a b : ℝ) : a + b = b + a := by exact wrongLemma\nexample : False := sorry\nexample : (2:ℕ) < 1 := by decide\n`,
  positions: ["3:30", "4:34", "5:17", "6:39", "7:46", "8:0", "9:26"],
  frags: ["Tactic `rfl` failed", "Type mismatch", "Unknown identifier `unknownIdent`", "declaration uses `sorry`", "proved that the proposition"],
};

// Scenario names in run order, so an abort can list what it never reached.
const actionItems = corpus.filter((it) => Array.isArray(it.actions) && it.actions.length)
  .filter((it) => !only || onlyMatches(it.name));
const planned = ["boot", ...FIXED.slice(0, 5).filter(runs), ...actionItems.map((it) => it.name), ...FIXED.slice(5).filter(runs)];
const remainingAfter = (name) => planned.slice(planned.indexOf(name) + 1).filter((n) => !results.some((r) => r.name === n));
let exitCode = 0;

try {
// ---------- scenario: cold-ish boot with overlay behavior --------------------
{
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const iso = await page.evaluate(() => crossOriginIsolated);
  const interactive = await waitPill(/^ready/, 600000);
  const settled = await waitPill(/^ready$/, 300000, 1000);
  const bootMs = Date.now() - t0;
  const overlayGone = await page.evaluate(() => { const b = document.getElementById("boot"); return !b || b.classList.contains("done"); });
  const detail = `isolated=${iso} interactive=${interactive.ok} settled=${settled.ok}@${bootMs}ms overlayGone=${overlayGone}`;
  // A page that never becomes interactive is infrastructure (runtime,
  // artifacts, headers), and nothing after it measures the product.
  if (!iso || !interactive.ok) throw new InfraError(`boot: ${detail} (pill '${interactive.s.slice(0, 40)}')`);
  await record("boot", "startup", settled.ok && overlayGone && bootMs < 720000, detail, { bootMs });
}

// ---------- scenario: golden 7-error battery + badge/list consistency --------
if (runs("golden-7-battery")) {
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
if (runs("error-clear-staleness")) {
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
if (runs("import-composition")) {
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
for (const [name, budget] of [["init", 20000], ["mathlib", 25000]]) {
  if (runs(`switch-${name}`)) {
    const t0 = Date.now();
    await page.selectOption("#examples", name);
    const r = await waitPill(/^ready$/, budget + 30000, 2500);
    await record(`switch-${name}`, "speed", r.ok && r.ms < budget + 5000, `readyMs=${r.ms} budget=${budget}`, { switchMs: r.ms });
    await page.waitForTimeout(1500);
  }
}

// ---------- corpus editor-action scripts -------------------------------------
// Heavy scenarios accumulate wasm/JS heap in the shared session; a fresh page
// every few scenarios keeps deaths attributable to the SCENARIO, not the pile.
let sinceFresh = 0;
// A Playwright evaluate on a dead/reloading page never resolves (no default
// timeout), and one such hang has wedged entire runs — every scenario races
// a hard deadline, and the alive probe races its own.
const deadline = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`deadline: ${what} exceeded ${ms}ms`)), ms));
const aliveProbe = () => Promise.race([
  page.evaluate(() => !!globalThis.qed64).catch(() => false),
  new Promise((res) => setTimeout(() => res(false), 5000)),
]);
for (const item of actionItems) {
  consoleLog = [];
  if (sinceFresh >= 4) { await freshPage(); sinceFresh = 0; }
  sinceFresh += 1;
  const statsBefore = await statsSnap();
  try {
    await Promise.race([deadline(Math.max(240000, (item.expect.settleMs ?? 0) + 120000), item.name), (async () => {
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
    const settle = await waitPill(SETTLE_RE, item.expect.settleMs ?? 120000, 2000);
    const alive = settle.dead ? false : await aliveProbe();
    const panics = panicsInConsole();
    // zeroErrors: the InfoView's All Messages badge must reach zero errors
    // (innerText renders "All Messages ( <errs> <warns>)"). Transient error
    // states are allowed on the way — e.g. the covering env's collision
    // errors before the faithful reboot lands — so poll until the badge is
    // clean WITH the pill at ready, up to the scenario's settle budget.
    let errCount = null;
    if (item.expect.zeroErrors) {
      const deadlineAt = Date.now() + (item.expect.settleMs ?? 120000);
      for (;;) {
        const iv = await ivText();
        const m = /All Messages \(\s*(\d+)/.exec(iv);
        errCount = m ? Number(m[1]) : 0;
        const p = await pill();
        if (p === DEAD || (errCount === 0 && /^ready$/.test(p))) break;
        if (Date.now() > deadlineAt) break;
        await page.waitForTimeout(5000);
      }
    }
    const statsAfter = await statsSnap();
    const delta = statsDelta(statsBefore, statsAfter);
    // expect.stats: max allowed deltas per counter (e.g. {reboots: 0});
    // evaluated only once the shim reports stats — silently ignored before.
    const statsBad = delta && item.expect.stats
      ? Object.entries(item.expect.stats).filter(([k, max]) => typeof delta[k] === "number" && delta[k] > max).map(([k, max]) => `${k}=${delta[k]}>${max}`)
      : [];
    const terminal = settleClass(settle.s);
    const wantTerminal = item.expect.terminal ?? (item.expect.mustSucceed ? "ready" : null);
    const pass = alive && settle.ok && (item.expect.panicFree ? panics === 0 : true)
      && (wantTerminal ? terminal === wantTerminal : true)
      && (item.expect.zeroErrors ? errCount === 0 : true)
      && statsBad.length === 0;
    await record(item.name, `editor/${item.category}`, pass,
      `alive=${alive} settled='${settle.s.slice(0, 40)}'@${settle.ms}ms terminal=${terminal}${wantTerminal ? `/${wantTerminal}` : ""} panics=${panics}${errCount !== null ? ` errBadge=${errCount}` : ""}${statsBad.length ? ` stats:${statsBad.join(",")}` : ""}`,
      { terminal, stats: delta ? { before: statsBefore, after: statsAfter, delta } : undefined });
    })()]);
  } catch (e) {
    const alive = await aliveProbe();
    await record(item.name, `editor/${item.category}`, false,
      `threw: ${String(e).slice(0, 140)} alive=${alive} pageCrashes=${pageCrashes}`);
    if (!alive) await freshPage();
  }
}

// A corpus scenario can leave the page dead (an OOM kill). The fixed
// scenarios below used to call setBuffer on it and throw UNCAUGHT, aborting
// the run and silently skipping everything after — recover first.
if (!(await page.evaluate(() => !!globalThis.qed64).catch(() => false))) {
  console.log("page is dead after the corpus loop — recovering with a fresh page");
  await freshPage();
}

// ---------- scenario: import-path completion (live parity) -------------------
if (runs("import-completion")) {
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
if (runs("worker-kill-recovery")) {
  await freshPage();
  await page.selectOption("#examples", "mathlib").catch(() => {});
  await waitPill(/^ready$/, 90000, 2000);
  const statsBefore = await statsSnap();
  await page.evaluate(() => { globalThis.qed64.shim.qs.session.worker.terminate(); });
  const recovered = await waitPill(/^ready$/, 180000, 4000);
  // give the replayed elaboration a beat to republish diagnostics
  let badge = "";
  for (let i = 0; i < 30; i++) {
    badge = (((await ivText()).match(/All Messages \(([^)]*)\)/) || [])[1] || "").trim();
    if (/2/.test(badge)) break;
    await page.waitForTimeout(1000);
  }
  const delta = statsDelta(statsBefore, await statsSnap());
  // Once the shim counts deaths, a "recovery" that saw no death is vacuous
  // (attacks.txt #5) — the drill then also requires workerDeaths === 1.
  const deathSeen = delta && typeof delta.workerDeaths === "number" ? delta.workerDeaths === 1 : true;
  await record("worker-kill-recovery", "recovery", recovered.ok && /2/.test(badge) && deathSeen,
    `recovered=${recovered.ok}@${recovered.ms}ms badge='${badge}'${delta ? ` stats=${JSON.stringify(delta)}` : ""}`, { recoveryMs: recovered.ms, stats: delta ? { delta } : undefined });
}

// ---------- final: memory + stuck-pill sweep ---------------------------------
if (runs("final-memory")) {
  const mem = await memSample();
  const wasmOk = mem.wasmMB === null || mem.wasmMB === undefined || mem.wasmMB < 3800;
  await record("final-memory", "memory", wasmOk, `wasm=${mem.wasmMB}MB js=${mem.jsHeapMB}MB (budget wasm<3800MB)`);
}
} catch (e) {
  // InfraError: the page cannot boot — one infra row, the rest aborted, exit 3.
  // Anything else is a harness bug: also abort, but say so.
  const infra = e instanceof InfraError;
  const failing = planned.find((n) => !results.some((r) => r.name === n)) ?? "run";
  await record(failing, infra ? "infra" : "harness", infra ? "infra" : "fail", `${infra ? "" : "harness threw: "}${String(e.message ?? e).slice(0, 200)}`);
  for (const n of remainingAfter(failing)) await record(n, "aborted", "aborted", `not run: ${infra ? "infrastructure refusal" : "harness error"} at ${failing}`);
  exitCode = infra ? 3 : 1;
} finally {
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => r.outcome !== "pass");
writeReport(false);
console.log(`\ne2e: ${results.length - failed.length}/${results.length} passed` +
  ` (fail=${results.filter((r) => r.outcome === "fail").length} infra=${results.filter((r) => r.outcome === "infra").length} aborted=${results.filter((r) => r.outcome === "aborted").length}); report: ${path.relative(root, path.join(dir, "e2e-report.json"))}`);
process.exit(exitCode || (failed.length ? 1 : 0));
