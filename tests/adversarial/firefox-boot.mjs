#!/usr/bin/env node
// Firefox boot and check (HARDENING #75). Until 2026-10-16 QED64 never reached
// ready in Playwright's Firefox: lib/profiles.ts awaited
// navigator.storage.persist() before the first pack part, and in Firefox 153
// that promise never settled (45 s measured; Firefox prompts for persistent
// storage, and that the promise waits on the prompt is the inference), so the
// install sat at "installing the Lean core library". Chrome answers without
// a prompt, so no Chromium lane could see it. This lane boots a served build in Firefox and checks two
// proofs, so a Firefox-only stall or a Firefox-only runtime failure (wasm64
// with threads, legacy exception handling, no Atomics.waitAsync) is a FAIL
// line in the regular gate, not a report from a user.
//
// Exit codes: 0 PASS; 1 FAIL (the product: never ready, wrong diagnostics,
// deaths); 2 usage; 3 REFUSED (the harness: Firefox did not launch, or the
// served page is not cross-origin isolated, which no Firefox flag can fake).
// Firefox 134+ has Memory64 on by default and 141+ dropped the
// javascript.options.wasm_memory64 pref, so no prefs are passed.
//
// Asserts: ready within --wait-ms (default 180 s: a first visit downloads the
// core pack), 0 worker deaths, a correct proof settles with 0 errors, a wrong
// proof settles with exactly 1 error, no renderer crash, no failed request.
// Records: Firefox's version, the time to ready and to each check, the number
// of Workers, the legacy-EH deprecation warnings (Firefox prints one per
// instantiation; counted, not failed), every console error and page error.
//
// Usage: node tests/adversarial/firefox-boot.mjs --url <served url> [--wait-ms 180000] [--check-ms 120000] [--headed]
// Playwright's Firefox must be installed (npx playwright install firefox).
// Browser work: run under the host lock (docs/TESTING.md). Note: the host
// lock's cool-down and harness.mjs's stray check look for Playwright's
// Firefox binary as well as chrome-headless-shell.
import { firefox } from "playwright";
import { arg, has } from "./harness.mjs";

const URL_ = arg("url", "");
if (!URL_) { console.log("firefox-boot: usage: --url <served url> [--wait-ms N] [--check-ms N] [--headed]"); process.exit(2); }
const WAIT_MS = Number(arg("wait-ms", "180000"));
const CHECK_MS = Number(arg("check-ms", "120000"));
const GOOD = "example : (2 : Nat) + 2 = 4 := rfl\n";
const BAD = "example : (1 : Nat) + 1 = 3 := rfl\n";
const BOOT = "example : (1 : Nat) + 1 = 2 := rfl\n";

const out = { ok: true, why: [], consoleErrors: [], pageErrors: [], failed: [], legacyEhWarnings: 0, workers: 0, crashed: false };
const fail = (why) => { out.ok = false; out.why.push(why); };
let browser;
try {
  browser = await firefox.launch({ headless: !has("--headed") });
} catch (e) {
  console.log(`firefox-boot: REFUSED Firefox did not launch: ${String(e).split("\n")[0].slice(0, 160)} (npx playwright install firefox)`);
  process.exit(3);
}
out.firefox = browser.version();
let refused = null;
try {
  const context = await browser.newContext();
  await context.addInitScript((t) => { try { localStorage.setItem("qed64.buffer", t); } catch {} }, BOOT);
  // The last Lean diagnostics publish, for the checks below.
  await context.addInitScript(() => { const hook = () => { const a = globalThis.qed64?.api; if (!a) return setTimeout(hook, 20); a.on("diagnostics", (d) => { if (d.origin === "lean") globalThis.__d = d; }); }; hook(); });
  const page = await context.newPage();
  page.on("console", (m) => {
    const text = m.text();
    if (/exception handling 'try' instruction is deprecated/.test(text)) out.legacyEhWarnings += 1;
    else if (m.type() === "error" && out.consoleErrors.length < 20) out.consoleErrors.push(text.slice(0, 200));
  });
  page.on("pageerror", (e) => { if (out.pageErrors.length < 10) out.pageErrors.push(String(e).split("\n")[0].slice(0, 160)); });
  page.on("worker", () => { out.workers += 1; });
  page.on("requestfailed", (r) => { if (out.failed.length < 10) out.failed.push(`${r.url().slice(0, 120)} ${r.failure()?.errorText ?? ""}`); });
  page.on("crash", () => { out.crashed = true; });

  const t0 = Date.now();
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  const isolated = await page.evaluate(() => globalThis.crossOriginIsolated === true).catch(() => false);
  if (!isolated) { refused = `${URL_} is not cross-origin isolated (COOP/COEP missing): Firefox cannot run the shared Memory64 runtime there`; throw new Error(refused); }
  const settle = (ms) => page.evaluate((ms) => globalThis.qed64.api.settled({ timeoutMs: ms }).then(() => "ready", (e) => String(e?.message ?? e)), ms).catch((e) => String(e));
  await page.waitForFunction(() => globalThis.qed64?.api?.settled, null, { timeout: 60_000 }).catch(() => {});
  const boot = await settle(WAIT_MS);
  out.readyMs = Date.now() - t0;
  if (boot !== "ready") fail(`boot: ${boot}`);

  // settled() is pinned to the new document version, but Lean's fast path sends the progress-done frame before the
  // final publishDiagnostics, so the diagnostics are read by VERSION (setDocument's), not by time.
  const check = async (name, text) => {
    const t = Date.now();
    const r = await page.evaluate((x) => globalThis.qed64.api.setDocument(x), text);
    const s = await settle(CHECK_MS);
    const want = r?.version ?? -1;
    await page.waitForFunction((v) => (globalThis.__d?.version ?? -1) >= v, want, { timeout: CHECK_MS }).catch(() => {});
    const d = await page.evaluate(() => globalThis.__d ?? null).catch(() => null);
    const current = d !== null && (d.version ?? -1) >= want;
    const errors = current ? d.diagnostics.filter((x) => x.severity === 1).map((x) => String(x.message).slice(0, 80)) : [];
    out[name] = { ms: Date.now() - t, settled: s, version: want, diagnosticsVersion: d?.version ?? null, errors };
    if (s !== "ready") fail(`${name} check: ${s}`);
    else if (!current) fail(`${name} check: no Lean diagnostics for version ${want} (last ${d?.version ?? "none"})`);
    return errors;
  };
  if (out.ok) {
    const good = await check("good", GOOD);
    if (good.length !== 0) fail(`good check: ${good.length} error(s): ${good.join(" | ")}`);
    const bad = await check("bad", BAD);
    if (bad.length !== 1) fail(`bad check: ${bad.length} error(s), expected exactly 1`);
  }
  const stats = await page.evaluate(() => globalThis.qed64.test?.stats?.() ?? null).catch(() => null);
  out.deaths = stats?.workerDeaths ?? null;
  if (out.deaths !== 0) fail(`worker deaths: ${out.deaths}`);
  if (out.crashed) fail("renderer crashed");
  if (out.failed.length) fail(`failed requests: ${out.failed.join("; ")}`);
} catch (e) {
  if (!refused) fail(`harness: ${String(e).slice(0, 200)}`);
} finally {
  await browser.close().catch(() => {});
}
if (refused) { console.log(`firefox-boot: REFUSED ${refused} (Firefox ${out.firefox})`); process.exit(3); }
console.log(`RESULT firefox-boot :: ${JSON.stringify(out)}`);
if (out.ok) {
  console.log(`firefox-boot: PASS ready in ${(out.readyMs / 1000).toFixed(1)} s, good check ${out.good.ms} ms (0 errors), bad check ${out.bad.ms} ms (1 error), 0 deaths, ${out.workers} Workers, ${out.legacyEhWarnings} legacy-EH warnings (Firefox ${out.firefox})`);
} else {
  console.log(`firefox-boot: FAIL ${out.why.join("; ")} (Firefox ${out.firefox})`);
}
process.exit(out.ok ? 0 : 1);
