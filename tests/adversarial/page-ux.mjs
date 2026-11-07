#!/usr/bin/env node
// The plain page's own UX (the UX parity batch of 2026-11-06) in REAL headless
// Chromium, or Firefox with `--browser firefox`. Every scenario runs on a page
// of its own and boots an Init-only document: no Mathlib download.
//
//   a11y-status   (UX A1.3) the pill's screen-reader echo: `#pstatus` has
//                 role="status" and is clipped, not hidden; #pill, #ptext and
//                 #ptime are not live. It announces the boot (the restored
//                 buffer, then "ready" last) but never the worker's streamed
//                 progress or `elaborating`, and three edits after ready
//                 announce nothing while the pill visibly flips. Its embed
//                 half (silent under ?embed=1) is page-api.mjs embed-code.
//
// Usage: node tests/adversarial/page-ux.mjs [--url http://localhost:5199/] [--only <scenario>] [--browser chromium|firefox] [--run-dir <dir>]
// Run it through the host browser lock. Exit 0 all pass, 1 a scenario failed,
// 3 infrastructure refusal (an --only that selects no scenario included).
// Embed-mode checks live in page-api.mjs embed-code, which already frames the
// page. Verdicts are inline check maps; only the selection is exported, for
// tests/unit/page-ux.test.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, browserName, fetchJson, launchBrowser, onlyMatches, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

export const SCENARIOS = ["a11y-status"];
/** The scenarios `--only` selects, in run order. An empty selection is refused (exit 3), never "0/0 pass". */
export const selectScenarios = (only) => SCENARIOS.filter((name) => !only || onlyMatches(name, only));
/** 0 all pass, 1 a scenario failed, 3 nothing was judged. */
export const exitCodeFor = (total, failed) => (total === 0 ? 3 : failed ? 1 : 0);

const INIT_DOC = "theorem two : 1 + 1 = 2 := rfl\n";
// a11y-status: the first edit sleeps, so the pill reads `elaborating` long enough to be seen.
const EDITS = ["theorem two : 1 + 1 = 2 := rfl\n#eval IO.sleep 500\n", "theorem three : 1 + 2 = 3 := rfl\n", "theorem four : 2 + 2 = 4 := rfl\n"];
// The worker's streamed progress labels (public/workers/lean.worker.js), which must never be announced.
const WORKER_PROGRESS = /^(Verifying |Importing modules|Loading environment snapshot|Loading the environment into Lean|Mounting |Initializing |Starting the Emscripten|Shared Memory64)/;

// ---------- helpers, copied from infoview-actions.mjs (lanes do not import each other's internals; `text` and
// `cursorAt` are for the scenarios that follow) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, every = 200) {
  const t0 = Date.now();
  for (;;) { const v = await pred(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every); }
}
const text = (page) => page.evaluate(() => globalThis.qed64.editor.getModel().getValue());
const cursorAt = (page, lineNumber, column) => page.evaluate(([l, c]) => { const e = globalThis.qed64.editor; e.setPosition({ lineNumber: l, column: c }); e.focus(); }, [lineNumber, column]);

// ---------- init scripts (Playwright sends each as source text: self-contained) ----------
/** a11y-status: every text #pstatus (the announcer) and #ptext (the pill) take, from the end of parsing:
 * readyState "interactive" comes before the module script runs, so the page's first label is caught. */
function recordStatusText() {
  globalThis.__said = [];
  globalThis.__shown = [];
  document.addEventListener("readystatechange", () => {
    if (document.readyState !== "interactive") return;
    for (const [id, into] of [["pstatus", globalThis.__said], ["ptext", globalThis.__shown]]) {
      const el = document.getElementById(id);
      if (el) new MutationObserver(() => into.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    }
  });
}

async function main() {
  try { browserName(); } catch (e) { console.error(`page-ux: refused — ${e.message}`); process.exit(3); }
  const firefox = browserName() === "firefox";
  const BOOT_MS = firefox ? 600000 : 300000; // Playwright's Firefox runs wasm several times slower
  const url = arg("url", "http://localhost:5199/");
  const only = arg("only", "");
  const scenarios = selectScenarios(only);
  if (scenarios.length === 0) { console.error(`page-ux: refused — --only ${JSON.stringify(only)} selects none of ${SCENARIOS.join(", ")}`); process.exit(3); }
  const target = resolveTarget(url);
  const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`page-ux: refused — ${e.message}`); process.exit(3); });
  const dir = runDir(manifest.buildId ?? "unknown", firefox ? `${target.mode}-firefox` : target.mode);
  teeLog(dir, "page-ux.log");
  console.log(`page-ux: ${url} → ${manifest.buildId} (${browserName()}); ${scenarios.join(", ")}; reports in ${path.relative(root, dir)}`);
  // Playwright makes its temporary browser profiles in os.tmpdir(): put them under the run dir, so a run that dies
  // leaves them beside its report (a Firefox profile holds the cached runtime) instead of in the system temp dir.
  const profiles = path.join(dir, "profiles");
  fs.mkdirSync(profiles, { recursive: true });
  process.env.TMPDIR = profiles;

  const results = [];
  let failed = 0;
  function record(name, ok, detail) {
    results.push({ name, outcome: ok ? "pass" : "fail", detail });
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
    fs.writeFileSync(path.join(dir, "page-ux-report.json"), JSON.stringify({ url, buildId: manifest.buildId, browser: browserName(), total: results.length, failed, results }, null, 2));
  }

  const browser = await launchBrowser().catch((e) => { console.error(`page-ux: refused — ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`); process.exit(3); });
  const withQuery = (q, hash = "") => { const u = new URL(url); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v); u.hash = hash; return u.toString(); };
  /** A fresh context and page on `url` with `query` and `hash`. `doc` (null: none) is seeded as the stored buffer
   * once per tab, in the top frame only (a sessionStorage guard, so a reload keeps what the page itself saved).
   * `init` (called with `initArg`) is one more init script; `context` goes to browser.newContext (viewport,
   * colorScheme, …). `wait: "ready"` polls until the phase is ready within `budgetMs`; "none" returns at
   * domcontentloaded. `errors`: page errors except the shapes every load carries, and the console lines
   * infoview-actions.mjs counts. */
  async function open(doc, { init = null, initArg = undefined, context: contextOptions = {}, query = {}, hash = "", wait = "ready", budgetMs = BOOT_MS } = {}) {
    const context = await browser.newContext(contextOptions);
    await context.addInitScript((seed) => {
      if (seed === null || window !== window.top) return;
      try {
        if (sessionStorage.getItem("pageux.seeded")) return;
        localStorage.setItem("qed64.buffer", seed);
        sessionStorage.setItem("pageux.seeded", "1");
      } catch { /* storage off */ }
    }, doc);
    if (init) await context.addInitScript(init, initArg);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => { const m = String(e); if (!/unsupported|Session disposed\.|Outdated RPC session/.test(m) || /abortSignal/.test(m)) errors.push(m.slice(0, 200)); });
    page.on("console", (m) => { const t = m.text(); if (/abortSignal|is not a function|Unrecognised error|unsupported/.test(t)) errors.push(`console: ${t.slice(0, 200)}`); });
    await page.goto(withQuery(query, hash), { waitUntil: "domcontentloaded" });
    if (wait === "ready") {
      const t0 = Date.now();
      for (;;) {
        const ph = await page.evaluate(() => globalThis.qed64?.status?.()?.phase ?? null).catch(() => null);
        if (ph === "ready") break;
        if (Date.now() - t0 > budgetMs) throw new Error(`not ready within ${budgetMs} ms (phase ${ph})`);
        await sleep(250);
      }
    }
    return { page, context, errors };
  }

  const lanes = {
    "a11y-status": async () => {
      // UX A1.3: on the base build there is no #pstatus, so every announcement check fails.
      const { page, context, errors } = await open(INIT_DOC, { init: recordStatusText });
      const said = () => page.evaluate(() => globalThis.__said.slice());
      const aria = await page.evaluate(() => {
        const a = (id) => { const e = document.getElementById(id); return e ? { role: e.getAttribute("role"), live: e.getAttribute("aria-live") } : null; };
        const p = document.getElementById("pstatus");
        const cs = p ? getComputedStyle(p) : null;
        const r = p?.getBoundingClientRect();
        return { pstatus: a("pstatus"), pill: a("pill"), ptext: a("ptext"), ptime: a("ptime"), clipped: !!p && cs.display !== "none" && cs.visibility !== "hidden" && r.width <= 1 && r.height <= 1 };
      });
      // The region reads "ready" once the restored-buffer note and the first check are done.
      const atReady = (await waitFor(async () => { const s = await said(); return s.at(-1) === "ready" ? s : null; }, 10000)) ?? (await said());
      const s0 = await page.evaluate(() => globalThis.__shown.length);
      for (const doc of EDITS) {
        const r = await page.evaluate((t) => globalThis.qed64.api.setDocument(t), doc);
        await page.evaluate((v) => globalThis.qed64.api.settled({ version: v, timeoutMs: 60000 }), r.version);
      }
      await sleep(1500); // the relay repeats `ready` several times a second: a missing same-label guard shows here
      const afterEdits = await said();
      const editShown = await page.evaluate((s) => globalThis.__shown.slice(s), s0);
      const checks = {
        "#pstatus is role=status": aria.pstatus?.role === "status",
        "#pill, #ptext, #ptime are not live": [aria.pill, aria.ptext, aria.ptime].every((x) => x && !x.role && !x.live),
        "#pstatus is clipped, not hidden": aria.clipped,
        "the boot ends on ready": atReady.at(-1) === "ready",
        "the boot announced the restored buffer": atReady.includes("restored your last buffer"),
        "no worker progress announced": !afterEdits.some((t) => WORKER_PROGRESS.test(t ?? "")),
        "never elaborating": !afterEdits.includes("elaborating"),
        "the pill flipped during the edits": editShown.includes("elaborating"), // else the next check is vacuous
        "the edits announced nothing": afterEdits.length === atReady.length,
        "no page errors": errors.length === 0,
      };
      const failures = Object.keys(checks).filter((k) => !checks[k]);
      record("a11y-status", failures.length === 0, `failed ${JSON.stringify(failures)}; aria ${JSON.stringify(aria)}; boot said ${JSON.stringify(atReady)}; edits said ${JSON.stringify(afterEdits.slice(atReady.length))}; pill during the edits ${JSON.stringify(editShown.slice(0, 8))}; page errors ${JSON.stringify(errors)}`);
      await context.close();
    },
  };

  try {
    for (const name of scenarios) {
      try { await lanes[name](); } catch (e) { record(name, false, `threw: ${String(e?.stack ?? e).slice(0, 400)}`); }
    }
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(profiles, { recursive: true, force: true }); // Playwright removed its own; this drops the empty dir
  }
  console.log(`page-ux: ${results.length - failed}/${results.length} pass; report ${path.relative(root, path.join(dir, "page-ux-report.json"))}`);
  process.exitCode = exitCodeFor(results.length, failed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
