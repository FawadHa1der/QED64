#!/usr/bin/env node
// The page API (docs/EMBEDDING.md §2–§3) in REAL headless Chromium, the way an
// embedder uses it — through `qed64.api` and its events only, never the
// internal `qed64.relay` / `qed64.status()` taps.
//
//   code-top-level ?embed=1#code=<doc> opened as a TOP-LEVEL page: the
//                  document is ignored (a boot document in the URL is code;
//                  only a same-origin parent frame may supply it) and the
//                  page boots the empty document instead.
//   embed-code     ?embed=1#code=<doc> in a same-origin frame (the dev/prod
//                  server's /embed-host.html): boots with exactly that document,
//                  `qed64:api` fired before boot, the examples menu is hidden,
//                  localStorage["qed64.buffer"] is neither read (a seeded
//                  sentinel does not appear) nor written (an edit leaves the
//                  sentinel), settled() resolves ready, an Init-only document
//                  booted light (snapshots ["init"]).
//   embed-setdoc   ?embed=1 without #code: setDocument from the `qed64:api`
//                  listener becomes the boot document.
//   events         plain mode: boot events carry stages and end with done;
//                  setDocument of a broken proof → settled({version}) →
//                  a `document` event with that text, a `diagnostics` event
//                  with an error at that version, a `ready` event; identical
//                  text resolves unchanged with no new version.
//   restart        api.restart() → a `reboot` event to a new session and
//                  settled() again on the same document.
//   bad-param      ?snapshots=/attacker.example/x fails the boot with a message
//                  naming the parameter, and sends no request off-origin.
//
// Usage: node tests/adversarial/page-api.mjs [--url http://localhost:5199/] [--only <scenario>]
// Run it through the host browser lock. Exit 0 all pass, 1 a scenario failed, 3 infrastructure refusal.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { arg, fetchJson, onlyMatches, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

const url = arg("url", "http://localhost:5199/");
const only = arg("only", "");
const runs = (name) => !only || onlyMatches(name, only);
const target = resolveTarget(url);
const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`page-api: refused — ${e.message}`); process.exit(3); });
const dir = runDir(manifest.buildId ?? "unknown", target.mode);
teeLog(dir, "page-api.log");
console.log(`page-api: ${url} → ${manifest.buildId}; reports in ${path.relative(root, dir)}`);

const INIT_DOC = "theorem two : 1 + 1 = 2 := rfl\n";
const BROKEN = "theorem two : 1 + 1 = 3 := rfl\n";
const SENTINEL = "-- sentinel: embed mode must not read or write this\n";
const withQuery = (q, hash = "") => { const u = new URL(url); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v); u.hash = hash; return u.toString(); };

const results = [];
let failed = 0;
function record(name, ok, detail) {
  results.push({ name, outcome: ok ? "pass" : "fail", detail });
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
  fs.writeFileSync(path.join(dir, "page-api-report.json"), JSON.stringify({ url, buildId: manifest.buildId, total: results.length, failed, results }, null, 2));
}

const browser = await chromium.launch();
/** A page with an embedder's recorder installed before any page script runs.
 * `framed`: load it as the only iframe of the same-origin /embed-host.html and
 * return that frame as `page` (evaluate/waitForFunction work the same). */
async function open(pageUrl, { seed = null, setDocOnApi = null, framed = false } = {}) {
  const context = await browser.newContext();
  await context.addInitScript(([seedText, doc]) => {
    if (seedText !== null) { try { localStorage.setItem("qed64.buffer", seedText); } catch { /* storage off */ } }
    window.__rec = { apiEvent: false, events: [] };
    window.addEventListener("qed64:api", (e) => {
      const api = e.detail;
      window.__rec.apiEvent = true;
      for (const t of ["boot", "status", "ready", "document", "diagnostics", "death", "reboot"]) {
        api.on(t, (p) => window.__rec.events.push({ t, p: t === "status" ? { phase: p.phase, session: p.session, version: p.version } : p }));
      }
      if (doc !== null) void api.setDocument(doc);
    });
  }, [seed, setDocOnApi]);
  const top = await context.newPage();
  const offOrigin = [];
  top.on("request", (r) => { if (new URL(r.url()).origin !== new URL(url).origin) offOrigin.push(r.url()); });
  if (!framed) {
    await top.goto(pageUrl, { waitUntil: "domcontentloaded" });
    return { page: top, context, offOrigin };
  }
  const u = new URL(pageUrl);
  await top.goto(`${u.origin}/embed-host.html?src=${encodeURIComponent(`${u.pathname}${u.search}${u.hash}`)}`, { waitUntil: "domcontentloaded" });
  const frame = await (await top.waitForSelector("#qed64-frame")).contentFrame();
  await frame.waitForFunction(() => !!globalThis.qed64?.api, null, { timeout: 60000 });
  return { page: frame, context, offOrigin };
}
const settle = (page, opts = {}, ms = 300000) => page.evaluate(([o, t]) => Promise.race([
  globalThis.qed64.api.whenReady().then(() => globalThis.qed64.api.settled(o)),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`not settled in ${t} ms`)), t)),
]), [opts, ms]);
const events = (page, t) => page.evaluate((type) => window.__rec.events.filter((e) => e.t === type).map((e) => e.p), t);

try {
  if (runs("code-top-level")) {
    const { page, context } = await open(withQuery({ embed: "1" }, `#code=${encodeURIComponent(INIT_DOC)}`), { seed: SENTINEL });
    const s = await settle(page);
    const doc = await page.evaluate(() => globalThis.qed64.api.getDocument());
    const ok = doc?.text === "" && s.phase !== "halted";
    record("code-top-level", ok, `document ${JSON.stringify(doc?.text)} (the #code= document must be ignored at top level), phase ${s.phase}`);
    await context.close();
  }

  if (runs("embed-code")) {
    const { page, context } = await open(withQuery({ embed: "1" }, `#code=${encodeURIComponent(INIT_DOC)}`), { seed: SENTINEL, framed: true });
    const s = await settle(page);
    const doc = await page.evaluate(() => globalThis.qed64.api.getDocument());
    const hidden = await page.evaluate(() => getComputedStyle(document.getElementById("examples")).display === "none");
    const apiEvent = await page.evaluate(() => window.__rec.apiEvent);
    // An edit: the buffer must still hold the sentinel afterwards (no write).
    const edit = await page.evaluate(() => globalThis.qed64.api.setDocument("theorem three : 1 + 2 = 3 := rfl\n"));
    await page.waitForTimeout(1200); // past the page's 400 ms save debounce
    const stored = await page.evaluate(() => localStorage.getItem("qed64.buffer"));
    const ok = s.phase === "ready" && doc?.text === INIT_DOC && hidden && apiEvent && JSON.stringify(s.snapshots) === JSON.stringify(["init"]) && stored === SENTINEL && edit.unchanged === false;
    record("embed-code", ok, `phase ${s.phase}, snapshots ${JSON.stringify(s.snapshots)}, document ${JSON.stringify(doc?.text)}, examples hidden ${hidden}, qed64:api ${apiEvent}, buffer after edit ${stored === SENTINEL ? "untouched" : JSON.stringify(stored)}`);
    await context.close();
  }

  if (runs("embed-setdoc")) {
    const { page, context } = await open(withQuery({ embed: "1" }), { setDocOnApi: INIT_DOC, framed: true });
    const s = await settle(page);
    const doc = await page.evaluate(() => globalThis.qed64.api.getDocument());
    const ok = s.phase === "ready" && doc?.text === INIT_DOC && JSON.stringify(s.snapshots) === JSON.stringify(["init"]);
    record("embed-setdoc", ok, `phase ${s.phase}, snapshots ${JSON.stringify(s.snapshots)}, document ${JSON.stringify(doc?.text)}`);
    await context.close();
  }

  if (runs("events") || runs("restart")) {
    const { page, context } = await open(url, { seed: INIT_DOC });
    const s0 = await settle(page);
    const boots = await events(page, "boot");
    const stages = [...new Set(boots.map((b) => b.stage))];
    const bootOk = ["manifests", "profile", "runtime", "snapshot"].every((st) => stages.includes(st)) && boots.at(-1)?.done === true;
    if (runs("events")) {
      const r = await page.evaluate((t) => globalThis.qed64.api.setDocument(t), BROKEN);
      const s1 = await settle(page, { version: r.version });
      const docs = await events(page, "document");
      const diags = await events(page, "diagnostics");
      const readies = await events(page, "ready");
      const lastDoc = docs.at(-1);
      const errAt = diags.filter((d) => d.version === r.version && d.diagnostics.some((x) => x.severity === 1));
      const same = await page.evaluate((t) => globalThis.qed64.api.setDocument(t), BROKEN);
      const ok = bootOk && s0.phase === "ready" && s1.version >= r.version && lastDoc?.text === BROKEN && lastDoc?.version === r.version && errAt.length > 0
        && readies.some((x) => x.version === r.version) && same.unchanged === true && same.version === r.version;
      record("events", ok, `boot stages ${JSON.stringify(stages)} last ${JSON.stringify(boots.at(-1)?.stage)} done ${boots.at(-1)?.done}; setDocument → v${r.version}, settled v${s1.version} ${s1.phase}; document event ${JSON.stringify(lastDoc?.text)}@${lastDoc?.version}; error diagnostics at that version ${errAt.length}; ready events ${JSON.stringify(readies.map((x) => x.version))}; identical text ${JSON.stringify(same)}`);
    }
    if (runs("restart")) {
      const before = await page.evaluate(() => globalThis.qed64.api.status().session);
      const r = await page.evaluate(() => globalThis.qed64.api.restart());
      const accepted = r?.accepted === true && r.fromSession === before;
      await page.waitForFunction((b) => window.__rec.events.some((e) => e.t === "reboot" && e.p.fromSession === b), before, { timeout: 60000 }).catch(() => {});
      const s2 = await settle(page);
      const reboots = (await events(page, "reboot")).filter((x) => x.fromSession === before);
      const ok = accepted === true && reboots.length === 1 && reboots[0].reason === "user" && s2.session !== before && (s2.phase === "ready" || s2.phase === "headerRefused");
      record("restart", ok, `accepted ${accepted}; reboot ${JSON.stringify(reboots)}; after: ${s2.session} ${s2.phase}`);
    }
    await context.close();
  }

  if (runs("bad-param")) {
    const { page, context, offOrigin } = await open(withQuery({ snapshots: "/attacker.example/x" }));
    const failedBoot = await page.waitForFunction(() => globalThis.qed64.api.status().boot.failed, null, { timeout: 30000 }).then(() => true, () => false);
    const boot = await page.evaluate(() => globalThis.qed64.api.status().boot);
    const ok = failedBoot && /refused \?snapshots=/.test(boot.message ?? "") && offOrigin.length === 0;
    record("bad-param", ok, `boot ${JSON.stringify(boot)}; off-origin requests ${JSON.stringify(offOrigin.slice(0, 3))}`);
    await context.close();
  }
} catch (e) {
  record("harness", false, `threw: ${String(e?.stack ?? e).slice(0, 400)}`);
} finally {
  await browser.close().catch(() => {});
}
console.log(`page-api: ${results.length - failed}/${results.length} pass; report ${path.relative(root, path.join(dir, "page-api-report.json"))}`);
process.exitCode = failed ? 1 : 0;
