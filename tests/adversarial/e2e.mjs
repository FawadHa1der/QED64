#!/usr/bin/env node
// Adversarial E2E harness: drives the lean4monaco front end in REAL headless
// Chromium (Playwright; `--browser firefox` drives Playwright's Firefox instead,
// HARDENING #75), independent of any interactive browser. Covers:
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
// work/adversarial/e2e-report.json for existing scripts); the relay's
// counters (`globalThis.qed64.relay.stats`: reboots, userRestarts,
// workerDeaths, breakerTrips, stackPauses, failedInFlight, staleDeaths,
// rangedChanges) are snapshotted around every scenario and their deltas
// recorded.
//
// The page speaks ONE transport (resident: front door + relay; the pump shim
// left the page on 2026-09-04), so the taps below are direct reads of
// `qed64.status()`, `qed64.relay.stats` and `qed64.relay.session.lean` —
// an undefined tap is a harness/page defect and is reported, never passed.
//
// Usage: node tests/adversarial/e2e.mjs [--url http://localhost:5187/] [--corpus corpus.json]
//        [--only <exact scenario name>] [--run-dir <dir>] [--boot-budget-ms 480000] [--browser chromium|firefox]
import fs from "node:fs";
import path from "node:path";
import { arg, browserName, fetchJson, launchBrowser, onlyMatches as onlyMatchesName, resolveTarget, root, runDir, settleClass, settleClassFromPhase, teeLog } from "./harness.mjs";

// `--browser` is validated before the manifest fetch: a typo is this lane's refusal (exit 3), not an uncaught throw.
try { browserName(); } catch (e) { console.error(`e2e: refused — ${e.message}`); process.exit(3); }

const url = arg("url", "http://localhost:5187/");
const corpusPath = arg("corpus", path.join(root, "tests/adversarial/corpus.json"));
const bootBudgetMs = Number(arg("boot-budget-ms", "480000"));
const target = resolveTarget(url);
// The run identity (buildId + mode) comes from what the page will boot. An
// unreachable manifest is an infrastructure refusal, not a scenario result.
const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`e2e: refused — ${e.message}`); process.exit(3); });
const buildId = manifest.buildId ?? "unknown";
const dir = runDir(buildId, browserName() === "firefox" ? `${target.mode}-firefox` : target.mode);
teeLog(dir, "e2e.log");
const artDir = path.join(dir, "artifacts");
fs.mkdirSync(artDir, { recursive: true });
fs.mkdirSync(path.join(root, "work/adversarial"), { recursive: true });
console.log(`e2e: ${url} → ${buildId} (${target.mode}${browserName() === "firefox" ? ", firefox" : ""}); reports in ${path.relative(root, dir)}`);

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
const FIXED = ["golden-7-battery", "error-clear-staleness", "import-composition", "switch-init", "switch-mathlib", "import-completion", "hover-docstring", "shared-link-gate", "worker-kill-recovery", "final-memory"];
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

// A browser that does not launch (Playwright's Firefox not installed) is this lane's refusal, as a typo in the flag is.
const browser = await launchBrowser().catch((e) => { console.error(`e2e: refused — ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`); process.exit(3); });
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
 * under machine load (kernel builds push boots past 400 s) is not an
 * environment refusal; it is logged and the scenario judges it. */
async function freshPage() {
  try { if (page && !page.isClosed()) await page.close(); } catch { /* gone */ }
  page = await context.newPage();
  wirePage(page);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const interactive = await (async () => { const t0 = Date.now(); for (;;) { const s = await pill(); const ph = await phaseNow(); if (Date.now() - t0 >= 1000 && (/^ready/.test(s) || ph === "ready" || ph === "headerRefused")) return { ok: true, ms: Date.now() - t0, s }; if (Date.now() - t0 > bootBudgetMs) return { ok: false, ms: Date.now() - t0, s }; await page.waitForTimeout(250); } })();
  if (!interactive.ok) throw new InfraError(`fresh page did not boot within ${bootBudgetMs} ms (pill '${interactive.s.slice(0, 40)}', pageCrashes=${pageCrashes})`);
  const settled = await waitTerminal(bootBudgetMs, 0);
  if (!settled.ok) console.log(`fresh page: interactive at ${interactive.ms} ms but not settled after ${bootBudgetMs} ms more (pill '${settled.s.slice(0, 40)}') — continuing`);
  return Date.now() - t0;
}
/** A fresh page at `target` (a share link, say), wired and loaded to
 * domcontentloaded, nothing more: the caller watches its boot. `before(page)`
 * runs before the navigation, for listeners that must see the load itself. */
async function openPage(target, before = () => {}) {
  try { if (page && !page.isClosed()) await page.close(); } catch { /* gone */ }
  page = await context.newPage();
  wirePage(page);
  await before(page);
  await page.goto(target, { waitUntil: "domcontentloaded" });
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
/** The page's status phase, or null when the page does not expose status(). */
async function phaseNow() {
  return page.evaluate(() => { try { return globalThis.qed64?.status?.()?.phase ?? null; } catch { return null; } }).catch(() => null);
}
/** The page's header FACT (`status().header.mode`: the last
 * `$/qed64/headerStatus` verdict — exact / covered / refused), or null when
 * the page carries none. */
async function headerModeNow() {
  return page.evaluate(() => { try { return globalThis.qed64?.status?.()?.header?.mode ?? null; } catch { return null; } }).catch(() => null);
}
/** Wait for a TERMINAL state: the phase enum from `qed64.status()` (ready /
 * headerRefused / halted — the relay's status is the oracle, the pill is
 * `render(status)` of the same datum), with the pill labels as the fallback
 * for a page that has not installed the tap yet. Returns {ok, ms, s, terminal}. */
async function waitTerminal(ms, minMs = 0) {
  const t0 = Date.now();
  for (;;) {
    const s = await pill();
    const ph = await phaseNow();
    const terminal = (ph !== null ? settleClassFromPhase(ph) : null) ?? settleClass(s);
    if (Date.now() - t0 >= minMs && terminal) return { ok: true, ms: Date.now() - t0, s, terminal };
    if (Date.now() - t0 > ms) return { ok: false, ms: Date.now() - t0, s, terminal: null };
    await page.waitForTimeout(100);
  }
}
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
async function setBuffer(text) {
  await page.evaluate((t) => { globalThis.qed64.editor.getModel().setValue(t); }, text);
}
/** Memory sample: the JS heap plus the worker's own telemetry
 * (`qed64.relay.session.lean.telemetry()` — LeanSession's public wrapper of
 * the worker 'telemetry' op → memory.currentBytes / maximumBytes). `wasmMB`
 * is a number when the live session answered;
 * otherwise `error` says why (no session, the tap is missing, the worker
 * did not answer within 8 s) — callers that NEED the number (final-memory)
 * fail on its absence instead of passing on `undefined`. */
async function memSample() {
  if (!page || page.isClosed()) return { error: "page closed" };
  // The telemetry request inside goes to the worker — a wedged worker never
  // answers, and an unresolved evaluate would hang record() (and the run).
  return Promise.race([
    new Promise((res) => setTimeout(() => res({ error: "telemetry unanswered within 8 s" }), 8000)),
    page.evaluate(async () => {
      const out = { jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
      const lean = globalThis.qed64?.relay?.session?.lean;
      if (!lean || typeof lean.telemetry !== "function") return { ...out, error: "qed64.relay.session.lean.telemetry is not a function (tap missing)" };
      try {
        const tel = await lean.telemetry();
        if (!tel || !tel.memory || typeof tel.memory.currentBytes !== "number") return { ...out, error: `telemetry carried no memory (${JSON.stringify(tel).slice(0, 80)})` };
        const max = tel.memory.maximumBytes;
        return { ...out, wasmMB: Math.round(tel.memory.currentBytes / 1048576), maxGiB: typeof max === "number" ? max / 1073741824 : null, workerState: tel.state };
      } catch (e) { return { ...out, error: `telemetry threw: ${String(e).slice(0, 100)}` }; }
    }).catch((e) => ({ error: `evaluate failed: ${String(e).slice(0, 100)}` })),
  ]);
}
/** The relay's counters (`globalThis.qed64.relay.stats`: reboots,
 * userRestarts, workerDeaths, breakerTrips, stackPauses, failedInFlight,
 * staleDeaths, rangedChanges — lib/lsp-relay.ts). Null only when the page
 * cannot be read (dead / closed / no relay); the kill drill treats null as
 * a failure, the corpus loop records it. */
async function statsSnap() {
  if (!page || page.isClosed()) return null;
  return Promise.race([
    new Promise((res) => setTimeout(() => res(null), 3000)),
    page.evaluate(() => {
      const s = globalThis.qed64?.relay?.stats;
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
  const report = { lane: "e2e", url, buildId, mode: target.mode, browser: browserName(), runDir: dir, inProgress, ...counts, results };
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
const panicsInConsole = () => consoleLog.filter((l) => /PANIC|assertion violation|Maximum call stack|too much recursion/.test(l)).length;
/** The in-kernel resolver's refusal note (patch 0032, FileWorker.setupImports):
 * `modules [...] are not loaded in this session — use "Load exact imports"`.
 * Pinned in ONE place so a kernel wording change fails import-composition
 * loudly instead of letting its note checks pass on a string nobody emits
 * (the pump-era check matched "do not resolve", a shim-only text, and was
 * vacuous on this transport). */
const REFUSED_NOTE = "are not loaded in this session";
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
  // Without a #code=/#codez= fragment the share-link gate (HARDENING #77) is never built.
  const noGate = await page.evaluate(() => document.querySelector("#sharedlink") === null);
  const detail = `isolated=${iso} interactive=${interactive.ok} settled=${settled.ok}@${bootMs}ms overlayGone=${overlayGone} noGate=${noGate}`;
  // A page that never becomes interactive is infrastructure (runtime,
  // artifacts, headers), and nothing after it measures the product.
  if (!iso || !interactive.ok) throw new InfraError(`boot: ${detail} (pill '${interactive.s.slice(0, 40)}')`);
  await record("boot", "startup", settled.ok && overlayGone && noGate && bootMs < 720000, detail, { bootMs });
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
// "import Mathlib.Da" is a refused header. The in-kernel resolver answers it
// with a FACT — `$/qed64/headerStatus{refused}`, read as
// `status().header.mode` — and a NOTE — one error diagnostic on the header
// line whose text carries REFUSED_NOTE, rendered by the InfoView. Finishing
// the line must clear both without a reboot. Every leg is asserted: the fact
// and the note, shown and then withdrawn (LSP diagnostics are whole-document
// replacements, so the note vanishing is the proof the refusal was retired).
if (runs("import-composition")) {
  consoleLog = [];
  await setBuffer("");
  await page.waitForTimeout(5000);
  await page.evaluate(() => globalThis.qed64.editor.getModel().applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "import Mathlib.Da" }]));
  const incomplete = await (async () => { const t0 = Date.now(); for (;;) { const ph = await phaseNow(); const s = await pill(); if (ph === "headerRefused" || /imports incomplete/.test(s)) return { ok: true, ms: Date.now() - t0, s }; if (Date.now() - t0 > 30000) return { ok: false, ms: Date.now() - t0, s }; await page.waitForTimeout(100); } })();
  const modeDuring = await headerModeNow();
  // The InfoView paints the publish a beat after the phase flips — poll for
  // the note rather than read it once.
  const noteSeen = await (async () => { const t0 = Date.now(); for (;;) { if ((await ivText()).includes(REFUSED_NOTE)) return true; if (Date.now() - t0 > 15000) return false; await page.waitForTimeout(250); } })();
  const noChurn = !consoleLog.some((l) => /Starting the Emscripten runtime/.test(l));
  await page.evaluate(() => { const m = globalThis.qed64.editor.getModel(); const c = m.getLineMaxColumn(1);
    m.applyEdits([{ range: { startLineNumber: 1, startColumn: c, endLineNumber: 1, endColumn: c }, text: "ta.Real.Basic\n\nexample (a b : ℝ) : a + b = b + a := add_comm a b\n" }]); });
  const done = await waitPill(/^ready$/, 60000, 2000);
  const modeAfter = await headerModeNow();
  const noteGone = !(await ivText()).includes(REFUSED_NOTE);
  // The fact must have read `refused` while incomplete and a real, non-refused
  // verdict (exact / covered) after recovery — a null after `ready` would mean
  // the page lost its header fact, which is a defect, not a pass.
  const factOk = modeDuring === "refused" && typeof modeAfter === "string" && modeAfter !== "refused";
  await record("import-composition", "functional", incomplete.ok && factOk && noteSeen && done.ok && noteGone && noChurn,
    `incomplete=${incomplete.ok} headerMode=${modeDuring}→${modeAfter} noteSeen=${noteSeen} recovered=${done.ok}@${done.ms}ms noteGone=${noteGone} noRebootChurn=${noChurn}`);
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
        case "clickAction": await page.waitForSelector("#action", { timeout: a.ms ?? 60000 }); await page.click("#action"); break;
        case "waitAction": await page.waitForSelector("#action", { timeout: a.ms ?? 60000 }).catch(() => {}); break;
        case "undo": await page.evaluate(() => globalThis.qed64.editor.trigger("t", "undo")); break;
        case "redo": await page.evaluate(() => globalThis.qed64.editor.trigger("t", "redo")); break;
        case "setCursor": await page.evaluate(({ l, c }) => globalThis.qed64.editor.setPosition({ lineNumber: l || 1, column: c || 1 }), { l: a.line, c: a.col }); break;
        case "pause": await page.waitForTimeout(Math.min(a.ms ?? 500, 20000)); break;
      }
    }
    // settle: alive AND in a terminal state (ready / actionable import note / breaker)
    const settle = await waitTerminal(item.expect.settleMs ?? 120000, 2000);
    const alive = settle.dead ? false : await aliveProbe();
    const panics = panicsInConsole();
    // zeroErrors: the InfoView's All Messages badge must reach zero errors
    // (innerText renders "All Messages ( <errs> <warns>)"). Transient error
    // states are allowed on the way — e.g. the covering env's collision
    // errors before the faithful reboot lands — so poll until the badge is
    // clean WITH the pill at ready, up to the scenario's settle budget.
    let errCount = null;
    // actionOffered / noteContains: the explain-and-offer contract for umbrella
    // name collisions (an explicit "Load exact imports" beside the pill and an
    // information diagnostic naming the collision and the alternatives).
    let actionOk = true, noteOk = true;
    if (item.expect.actionOffered) actionOk = await page.$("#action").then((h) => !!h).catch(() => false);
    if (item.expect.noteContains) noteOk = (await ivText()).includes(item.expect.noteContains);
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
    // expect.stats: max allowed deltas per relay counter (e.g. {reboots: 0,
    // workerDeaths: 0}); a page that could not be read before AND after
    // (delta null) records no verdict on them — the row's other checks stand.
    const statsBad = delta && item.expect.stats
      ? Object.entries(item.expect.stats).filter(([k, max]) => typeof delta[k] === "number" && delta[k] > max).map(([k, max]) => `${k}=${delta[k]}>${max}`)
      : [];
    const terminal = settle.terminal ?? settleClass(settle.s);
    const wantTerminal = item.expect.terminal ?? (item.expect.mustSucceed ? "ready" : null);
    const pass = alive && settle.ok && (item.expect.panicFree ? panics === 0 : true)
      && (wantTerminal ? terminal === wantTerminal : true)
      && (item.expect.zeroErrors ? errCount === 0 : true)
      && actionOk && noteOk
      && statsBad.length === 0;
    await record(item.name, `editor/${item.category}`, pass,
      `alive=${alive} settled='${settle.s.slice(0, 40)}'@${settle.ms}ms terminal=${terminal}${wantTerminal ? `/${wantTerminal}` : ""} panics=${panics}${errCount !== null ? ` errBadge=${errCount}` : ""}${item.expect.actionOffered ? ` action=${actionOk}` : ""}${item.expect.noteContains ? ` note=${noteOk}` : ""}${statsBad.length ? ` stats:${statsBad.join(",")}` : ""}`,
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

// ---------- scenario: the hover of an imported name carries its docstring ---
// Kernel patch 0042 imports at the `.server` level, where the docstrings live;
// the 4.34 pairings imported at `.exported` and a hover showed the signature
// and the defining module only (2026-10-22 probe). Lean's hover markdown is
// "```lean sig```", then `***`-separated parts: the docstring, "*import M*".
// The request goes through the relay as the editor's own does (the client
// port is the test hatch the InfoView lane also listens on). Go-to-definition
// stays empty: no .lean sources are served.
if (runs("hover-docstring")) {
  await setBuffer("import Mathlib\n\n#check List.map\n#check Finset.sum\n");
  const settled = await waitTerminal(420000, 1500);
  const hover = (line, character) => Promise.race([
    deadline(30000, "hover request"),
    page.evaluate(({ line, character }) => new Promise((resolve) => {
      const relay = globalThis.qed64.relay;
      const id = `e2e-hover-${line}-${character}`;
      const port = relay.clientPort;
      const on = (e) => { const m = e.data; if (m && m.id === id) { port.removeEventListener("message", on); resolve(m.error ? { error: String(m.error.message ?? m.error).slice(0, 120) } : { md: m.result?.contents?.value ?? null }); } };
      port.addEventListener("message", on); port.start?.();
      relay.fromClient({ jsonrpc: "2.0", id, method: "textDocument/hover", params: { textDocument: { uri: relay.doc.uri }, position: { line, character } } });
    }), { line, character }),
  ]).catch((e) => ({ error: String(e).slice(0, 120) }));
  const docOf = (md) => { const parts = String(md ?? "").split(/\n\*\*\*\n/); return parts.length >= 3 ? parts.slice(1, -1).join("\n").trim() : ""; };
  const rows = [];
  for (const [name, line, character] of [["List.map", 2, 9], ["Finset.sum", 3, 10]]) {
    const h = settled.ok ? await hover(line, character) : { error: "not settled" };
    rows.push({ name, doc: docOf(h.md), error: h.error ?? null, signature: Boolean(h.md && h.md.includes(name)) });
  }
  const pass = settled.ok && settled.terminal === "ready" && rows.every((r) => r.signature && r.doc.length > 0);
  await record("hover-docstring", "functional", pass,
    `terminal=${settled.terminal} ${rows.map((r) => `${r.name}: ${r.error ? `error ${r.error}` : `signature=${r.signature} doc='${r.doc.replace(/\s+/g, " ").slice(0, 60)}'`}`).join("; ")}`);
}

// ---------- scenario: a share link opens behind the consent gate ------------
// HARDENING #77 (docs/EMBEDDING.md §3.1): a top-level `#codez=` page boots as
// it would without the fragment, with the panel up from module start; Open
// puts the snippet in the editor, drops the fragment and switches this load's
// persistence off after writing an edit the save debounce still owes, so
// localStorage["qed64.buffer"] keeps the visitor's text (none on a first visit). The
// literal is lz-string's compressToBase64 of SHARED_SNIPPET without padding
// (tests/unit/lz-string.test.ts pins the page's port to the npm package).
if (runs("shared-link-gate")) {
  const SHARED_SNIPPET = "example : (2 : Nat) + 2 = 4 := rfl\n";
  const SHARED_CODEZ = "KYDwhgtgDgNsAEAueAKATE+A5MAXAlPANTwYC88ALEhQE4BmMAUEA";
  // Console errors, judged as the other browser lanes judge them: a non-empty
  // console.error or a pageerror outside the shapes every page load carries
  // (lean4monaco's "unsupported" stub, the InfoView's es-module-shims warning,
  // "Session disposed." / "Outdated RPC session" on a session change).
  const KNOWN_CONSOLE = /^Session disposed\.$|^Outdated RPC session$|^unsupported(?:\s|$)|^TODO: catch JSON\.parse failure: +SyntaxError: Unexpected token 'e', "esms,true,/;
  const errors = [];
  // Two visits, each with its storage set before any page script runs (HARDENING #77): a FIRST visit, nothing saved,
  // after which Open must not have created a buffer (the 2026-10-18 live finding: it stored the default example), and
  // a visitor with a SAVED buffer who edits it just before Open: that edit is kept, the snippet and later documents
  // are never stored. Without the explicit storage, the corpus only ever reached the second case.
  const OWN = "-- the visitor's own buffer\nexample : True := trivial\n";
  const OWN_EDITED = OWN + "-- edited just before Open\n";
  const visit = async (seed) => {
    const t0 = Date.now();
    await openPage(`${url}#codez=${SHARED_CODEZ}`, (p) => {
      p.on("console", (m) => { const t = m.text(); if (m.type() === "error" && t.trim() && !KNOWN_CONSOLE.test(t)) errors.push(t.slice(0, 200)); });
      p.on("pageerror", (e) => { if (!KNOWN_CONSOLE.test(e.message)) errors.push(`PAGEERROR: ${e.message.slice(0, 160)}`); });
      // Top frame only: the InfoView iframe is same-origin and loads after Open.
      return p.addInitScript((v) => { if (window !== window.top) return; try { if (v === null) localStorage.removeItem("qed64.buffer"); else localStorage.setItem("qed64.buffer", v); } catch { /* no storage */ } }, seed);
    });
    const gateState = () => page.evaluate(() => ({
      gate: document.querySelector("#sharedlink") !== null,
      preview: document.getElementById("sharedlink-text")?.textContent ?? null,
      flag: document.getElementById("sharedlink-flag") !== null,
      phase: globalThis.qed64?.status?.()?.phase ?? null,
      hash: location.hash,
      doc: globalThis.qed64?.editor?.getModel?.()?.getValue?.() ?? null,
      stored: localStorage.getItem("qed64.buffer"),
      // Centered over the page (2026-10-18): the panel's middle within 2 px of the viewport's, horizontally and vertically.
      centered: (() => { const r = document.querySelector("#sharedlink")?.getBoundingClientRect(); return !!r && Math.abs(r.left + r.width / 2 - innerWidth / 2) <= 2 && Math.abs(r.top + r.height / 2 - innerHeight / 2) <= 2; })(),
    })).catch(() => null);
    // The panel is built at module start, so it is there before the page is
    // interactive: poll from domcontentloaded.
    let whileBooting = null;
    for (;;) {
      const st = await gateState();
      if (st?.gate) { whileBooting = st; break; }
      if (Date.now() - t0 > 20000) break;
      await page.waitForTimeout(100);
    }
    const gateWhileBooting = !!whileBooting && whileBooting.phase !== "ready";
    const booted = await waitTerminal(bootBudgetMs, 1000);
    const atReady = await gateState();
    const notOpened = !!atReady && atReady.doc !== null && atReady.doc !== SHARED_SNIPPET && (seed === null || atReady.doc === seed);
    const gateAtReady = !!atReady && atReady.gate && atReady.centered && atReady.hash === `#codez=${SHARED_CODEZ}` && atReady.preview === SHARED_SNIPPET && !atReady.flag;
    if (seed !== null) {
      // The visitor's last edit, still inside the page's 400 ms save debounce when Open is clicked (if the debounce
      // fires first, the store holds the same text: either way the edit is the expected buffer).
      await page.evaluate((v) => { void globalThis.qed64.api.setDocument(v); }, OWN_EDITED).catch(() => {});
      for (let i = 0; i < 50 && (await gateState())?.doc !== OWN_EDITED; i++) await page.waitForTimeout(20);
    }
    await page.click("#sharedlink-open").catch(() => {});
    const opened = await (async () => { const t1 = Date.now(); for (;;) { const st = await gateState(); if (st?.doc === SHARED_SNIPPET) return { ok: true, ms: Date.now() - t1, ...st }; if (Date.now() - t1 > 10000) return { ok: false, ms: Date.now() - t1, ...(st ?? {}) }; await page.waitForTimeout(100); } })();
    const settledOpen = await waitPill(/^ready$/, 120000, 1000);
    // One more document after Open: the page's 400 ms save debounce must not write it.
    await page.evaluate(() => globalThis.qed64.api.setDocument("example : (3 : Nat) + 3 = 6 := rfl\n")).catch(() => {});
    await page.waitForTimeout(1500);
    const storedAfter = await page.evaluate(() => localStorage.getItem("qed64.buffer")).catch(() => "UNREADABLE");
    const bufferKept = storedAfter === (seed === null ? null : OWN_EDITED);
    const pass = gateWhileBooting && booted.ok && gateAtReady && notOpened && opened.ok && opened.gate === false && opened.hash === "" && settledOpen.ok && bufferKept;
    const shown = storedAfter === null ? "none" : storedAfter === OWN_EDITED ? "own+edit" : JSON.stringify(String(storedAfter).slice(0, 40));
    return { pass, ms: opened.ms, gateState, detail: `gateWhileBooting=${gateWhileBooting}(phase=${whileBooting?.phase ?? "none"}) booted=${booted.ok}@${booted.ms}ms gateAtReady=${gateAtReady} notOpenedBeforeClick=${notOpened} opened=${opened.ok}@${opened.ms}ms gateGone=${opened.gate === false} hash='${opened.hash ?? "?"}' settled=${settledOpen.ok} stored=${shown} bufferKept=${bufferKept}` };
  };
  // The corpus shares one context: put back what the scenarios before this one saved, so the next scenario boots
  // as it did before this one ran (the saved-buffer visit's Init-only text would make worker-kill-recovery boot
  // light and widen first). The page left open has persistence off, so nothing writes the key back.
  const storedBefore = await page.evaluate(() => localStorage.getItem("qed64.buffer")).catch(() => null);
  const first = await visit(null);
  const saved = await visit(OWN);
  // The same link pasted into this tab, already booted with the snippet opened (2026-10-18, the owner's report): a
  // fragment-only change is a same-document navigation, no reload, and the panel must follow it; Open still loads
  // it, and the store keeps the visitor's text (this load's persistence is off since the first Open).
  const pasted = await (async () => {
    const g = saved.gateState;
    const origin = await page.evaluate(() => performance.timeOrigin).catch(() => null);
    await page.goto(`${url}#codez=${SHARED_CODEZ}`, { waitUntil: "domcontentloaded" }).catch(() => {});
    let st = null;
    for (let i = 0; i < 30; i++) { st = await g(); if (st?.gate) break; await page.waitForTimeout(100); }
    const reloaded = (await page.evaluate(() => performance.timeOrigin).catch(() => null)) !== origin;
    const shown = !!st?.gate && st.preview === SHARED_SNIPPET && st.centered;
    await page.click("#sharedlink-open").catch(() => {});
    let after = null;
    for (let i = 0; i < 100; i++) { after = await g(); if (after?.doc === SHARED_SNIPPET) break; await page.waitForTimeout(100); }
    const ok = !reloaded && shown && after?.doc === SHARED_SNIPPET && after.gate === false && after.hash === "" && after.stored === OWN_EDITED;
    return { ok, detail: `reloaded=${reloaded} shown=${shown} opened=${after?.doc === SHARED_SNIPPET} gateGone=${after?.gate === false} hash='${after?.hash ?? "?"}' storedKept=${after?.stored === OWN_EDITED}` };
  })();
  await page.evaluate((v) => { if (v === null) localStorage.removeItem("qed64.buffer"); else localStorage.setItem("qed64.buffer", v); }, storedBefore).catch(() => {});
  await record("shared-link-gate", "functional", first.pass && saved.pass && pasted.ok && errors.length === 0,
    `first visit: ${first.detail}; saved buffer: ${saved.detail}; pasted into the open tab: ${pasted.detail}; consoleErrors=${errors.length}${errors.length ? " " + JSON.stringify(errors.slice(0, 3)) : ""}`,
    { openMs: saved.ms });
}

// ---------- recovery drill: hard worker kill ---------------------------------
if (runs("worker-kill-recovery")) {
  await freshPage();
  await page.selectOption("#examples", "mathlib").catch(() => {});
  await waitPill(/^ready$/, 90000, 2000);
  const statsBefore = await statsSnap();
  const sessionBefore = await page.evaluate(() => globalThis.qed64?.relay?.session?.id ?? null).catch(() => null);
  // Kill the live worker underneath the relay: `qed64.relay.session` is the
  // ResidentSession adapter, `.lean` its LeanSession, `.lean.worker` the
  // Worker. `terminate()` is silent (no error event), so the death the relay
  // sees is the heartbeat-loss path (6 s without a beat + a 2 s unanswered
  // telemetry probe — lib/client.ts), which is the point of the drill.
  await page.evaluate(() => {
    const w = globalThis.qed64?.relay?.session?.lean?.worker;
    if (!w || typeof w.terminate !== "function") throw new Error("kill drill: qed64.relay.session.lean.worker is not a Worker (tap missing)");
    w.terminate();
  });
  const tKill = Date.now();
  // Death detected = the status phase leaves `ready` (dead → the relay's
  // replacement session's booting), not a pill regex; the design budgets
  // ≤ 10 s (§3 row 10), the gate allows 3× that for machine load.
  const detected = await (async () => { for (;;) { const ph = await phaseNow(); if (ph !== null && ph !== "ready") return { ok: true, ms: Date.now() - tKill, phase: ph }; if (Date.now() - tKill > 30000) return { ok: false, ms: Date.now() - tKill, phase: ph }; await page.waitForTimeout(100); } })();
  const recovered = await waitPill(/^ready$/, 180000, 4000);
  // give the replayed elaboration a beat to republish diagnostics
  let badge = "";
  for (let i = 0; i < 30; i++) {
    badge = (((await ivText()).match(/All Messages \(([^)]*)\)/) || [])[1] || "").trim();
    if (/2/.test(badge)) break;
    await page.waitForTimeout(1000);
  }
  const statsAfter = await statsSnap();
  const delta = statsDelta(statsBefore, statsAfter);
  const sessionAfter = await page.evaluate(() => globalThis.qed64?.relay?.session?.id ?? null).catch(() => null);
  // Non-vacuous by construction: the relay must have COUNTED exactly one
  // worker death and one (crash) reboot, and be serving a different session;
  // unreadable counters are a failure, not a pass (the old drill passed on
  // `undefined` stats).
  const counted = !!delta && delta.workerDeaths === 1 && delta.reboots === 1 && (delta.userRestarts ?? 0) === 0;
  const replaced = sessionBefore !== null && sessionAfter !== null && sessionAfter !== sessionBefore;
  await record("worker-kill-recovery", "recovery", detected.ok && recovered.ok && /2/.test(badge) && counted && replaced,
    `detected=${detected.ok}@${detected.ms}ms(phase=${detected.phase}) recovered=${recovered.ok}@${recovered.ms}ms badge='${badge}' session=${sessionBefore}→${sessionAfter} stats=${delta ? JSON.stringify(delta) : "UNREADABLE"}`,
    { recoveryMs: recovered.ms, deathDetectedMs: detected.ms, stats: delta ? { before: statsBefore, after: statsAfter, delta } : undefined });
}

// ---------- final: memory + stuck-pill sweep ---------------------------------
if (runs("final-memory")) {
  const mem = await memSample();
  // A sample without the number is a broken tap or a dead worker — both are
  // failures here (this row passed vacuously on `undefined` before 2026-09-04).
  const measured = typeof mem.wasmMB === "number";
  const wasmOk = measured && mem.wasmMB < 3800;
  await record("final-memory", "memory", wasmOk,
    `wasm=${measured ? mem.wasmMB : "UNMEASURED"}MB js=${mem.jsHeapMB}MB max=${mem.maxGiB ?? "?"}GiB (budget wasm<3800MB)${mem.error ? ` error='${mem.error}'` : ""}`);
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
