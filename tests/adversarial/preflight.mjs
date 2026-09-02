#!/usr/bin/env node
// Preflight for every browser lane (review C7, HARDENING #32/#33/#35): a run
// that cannot boot must REFUSE with zero scenario rows, not fail N scenarios.
// Verifies, for the pairing the page URL will actually boot:
//   1. the runtime manifest is fetchable JSON with a buildId and chunks
//      (and matches ?runtime= when that override is present);
//   2. every chunk answers HEAD with the manifest's byte size and a non-HTML
//      content type — vite's SPA fallback served a 6373-byte index.html as
//      "chunk 0" for a whole gate;
//   3. the snapshot index parses and each entry's file answers with its size;
//   4. pairing: every index entry's `runtime` equals the manifest buildId
//      (an entry without the field is reported as "no pairing fact", the
//      pre-field indexes; the resident adapter treats that as unknown);
//   5. the profile index names a core profile (boot needs it);
//   6. one boot smoke in headless Chromium: the pill reaches `ready` within
//      the budget (skip with --no-boot for fetch-only checks).
// Exit 3 with one line `PREFLIGHT REFUSED: <reason>` on any failure.
//
// Usage: node tests/adversarial/preflight.mjs --url <page url> [--no-boot]
//        [--boot-budget-ms 180000] [--run-dir <dir>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, fetchJson, has, resolveTarget } from "./harness.mjs";

const isHtml = (r, text = "") => /text\/html/i.test(r.headers.get("content-type") ?? "") || /^\s*<!doctype html/i.test(text);

/** HEAD (GET fallback when HEAD carries no length) — returns {bytes, type}. */
async function probeFile(url) {
  let r = await fetch(url, { method: "HEAD", cache: "no-cache", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  if (isHtml(r)) throw new Error(`${url}: served HTML (SPA fallback) instead of the file`);
  let bytes = Number(r.headers.get("content-length"));
  if (!Number.isFinite(bytes) || bytes <= 0) {
    r = await fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    bytes = 0;
    for await (const part of r.body) {
      if (bytes === 0 && isHtml(r, Buffer.from(part).toString("utf8", 0, 32))) throw new Error(`${url}: served HTML (SPA fallback) instead of the file`);
      bytes += part.length;
    }
  }
  return { bytes, type: r.headers.get("content-type") ?? "" };
}

/** Run the checks; returns {ok, reason, buildId, mode, checks}. Never throws. */
export async function runPreflight(target, { boot = true, bootBudgetMs = 180000, log = console.log } = {}) {
  const checks = [];
  const ok = (what) => { checks.push({ ok: true, what }); log(`ok    ${what}`); };
  const warn = (what) => { checks.push({ ok: true, warn: true, what }); log(`warn  ${what}`); };
  const refuse = (reason, buildId = null) => { checks.push({ ok: false, what: reason }); log(`FAIL  ${reason}`); return { ok: false, reason, buildId, mode: target.mode, checks }; };
  let manifest;
  try {
    manifest = await fetchJson(target.manifestUrl);
  } catch (e) { return refuse(`runtime manifest: ${e.message}`); }
  const buildId = manifest?.buildId;
  if (typeof buildId !== "string" || !manifest.files) return refuse(`runtime manifest ${target.manifestUrl} has no buildId/files`);
  if (target.runtimeOverride && buildId !== target.runtimeOverride) return refuse(`?runtime=${target.runtimeOverride} but the manifest says ${buildId}`, buildId);
  let chunkCount = 0;
  for (const [name, file] of Object.entries(manifest.files)) {
    if (!Array.isArray(file.chunks) || file.chunks.length === 0) return refuse(`manifest ${buildId}: ${name} lists no chunks`, buildId);
    chunkCount += file.chunks.length;
  }
  ok(`manifest ${buildId} (${chunkCount} chunks, lean ${manifest.leanVersion ?? "?"})`);
  for (const [name, file] of Object.entries(manifest.files)) {
    for (const [i, chunk] of file.chunks.entries()) {
      let p;
      try { p = await probeFile(target.origin + chunk.url); } catch (e) { return refuse(`${name} chunk ${i}: ${e.message}`, buildId); }
      if (p.bytes !== chunk.bytes) return refuse(`${name} chunk ${i}: ${p.bytes} bytes served, manifest says ${chunk.bytes} (${chunk.url})`, buildId);
    }
    ok(`${name}: ${file.chunks.length} chunks answer with their manifest sizes`);
  }

  let index;
  try { index = await fetchJson(target.indexUrl); } catch (e) { return refuse(`snapshot index: ${e.message}`, buildId); }
  if (index?.schema !== "qed64.snapshot-index/v1" || !Array.isArray(index.snapshots)) return refuse(`snapshot index ${target.indexUrl}: unexpected schema`, buildId);
  for (const entry of index.snapshots) {
    if (typeof entry.url !== "string" || typeof entry.name !== "string") return refuse(`snapshot index: malformed entry ${JSON.stringify(entry).slice(0, 80)}`, buildId);
    // qed64-boot.ts re-roots /snapshots/ urls under ?snapshots=<dir>.
    const url = target.origin + entry.url.replace(/^\/snapshots\//, `/${target.snapshotsDir}/`);
    let p;
    try { p = await probeFile(url); } catch (e) { return refuse(`snapshot ${entry.name}: ${e.message}`, buildId); }
    const want = entry.transfer ?? entry.bytes;
    if (p.bytes !== want) return refuse(`snapshot ${entry.name}: ${p.bytes} bytes served, index says ${want}`, buildId);
    if (entry.runtime === undefined) warn(`snapshot ${entry.name}: index carries no runtime pairing (pre-field bake) — pairing with ${buildId} is unverified`);
    else if (entry.runtime !== buildId) return refuse(`snapshot ${entry.name} is paired with runtime ${entry.runtime}, page boots ${buildId}`, buildId);
    else ok(`snapshot ${entry.name}: ${want} bytes, paired with ${buildId}`);
  }
  if (index.snapshots.length === 0) warn("snapshot index lists no snapshots");

  try {
    const profiles = await fetchJson(target.profilesUrl);
    if (!profiles?.profiles?.some((p) => p.id === "core")) return refuse("profile index has no core profile", buildId);
    ok(`profiles: ${profiles.profiles.map((p) => p.id).join(", ")}`);
  } catch (e) { return refuse(`profile index: ${e.message}`, buildId); }

  if (boot) {
    const r = await bootSmoke(target.url, bootBudgetMs);
    if (!r.ok) return refuse(`boot smoke: ${r.reason}`, buildId);
    ok(`boot smoke: ready in ${r.ms} ms`);
  } else {
    warn("boot smoke skipped (--no-boot)");
  }
  return { ok: true, reason: null, buildId, mode: target.mode, checks };
}

/** One headless page must reach the `ready` pill within the budget. The
 * browser is closed in `finally` whatever happens (HARDENING #34). */
export async function bootSmoke(url, budgetMs) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
  const tail = [];
  try {
    const page = await browser.newPage();
    page.on("console", (m) => { tail.push(m.text().slice(0, 200)); if (tail.length > 20) tail.shift(); });
    page.on("pageerror", (e) => tail.push(`PAGEERROR: ${e.message.slice(0, 200)}`));
    let crashed = false;
    page.on("crash", () => { crashed = true; });
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const iso = await page.evaluate(() => crossOriginIsolated).catch(() => false);
    if (!iso) return { ok: false, reason: "page is not cross-origin isolated (COOP/COEP headers missing)" };
    let pill = "";
    for (;;) {
      if (crashed) return { ok: false, reason: `page crashed after ${Date.now() - t0} ms; console tail: ${tail.slice(-5).join(" | ")}` };
      pill = await Promise.race([
        page.evaluate(() => (document.getElementById("ptext") || {}).textContent || "").catch(() => ""),
        new Promise((res) => setTimeout(() => res(""), 5000)),
      ]);
      if (/^ready/.test(pill)) return { ok: true, ms: Date.now() - t0 };
      if (Date.now() - t0 > budgetMs) return { ok: false, reason: `pill '${pill.slice(0, 60)}' after ${budgetMs} ms; console tail: ${tail.slice(-5).join(" | ")}` };
      await new Promise((res) => setTimeout(res, 1000));
    }
  } catch (e) {
    return { ok: false, reason: `${String(e).slice(0, 160)}; console tail: ${tail.slice(-5).join(" | ")}` };
  } finally {
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = resolveTarget(arg("url", "http://localhost:5187/"));
  console.log(`preflight: ${target.url} (${target.mode}; manifest ${target.manifestUrl}; snapshots /${target.snapshotsDir}/)`);
  const result = await runPreflight(target, { boot: !has("--no-boot"), bootBudgetMs: Number(arg("boot-budget-ms", "180000")) });
  const dir = arg("run-dir", "");
  if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "preflight.json"), JSON.stringify({ target, ...result }, null, 2)); }
  if (!result.ok) { console.log(`PREFLIGHT REFUSED: ${result.reason}`); process.exit(3); }
  console.log(`PREFLIGHT OK buildId=${result.buildId} mode=${result.mode} snapshots=${target.snapshotsDir}`);
}
