#!/usr/bin/env node
// Reload storm (HARDENING #53): a ready page reloaded while its runtime is
// live — the old page's Lean runtime (the lean.worker and every pthread
// Worker) and the new one coexist in one renderer for a moment. Each run is
// a fresh browser: boot the page to `ready`, reload at 0, 3, 6, 9 and 12 s
// (waitUntil "commit"), then wait for `ready` again; every 250 ms count the
// live dedicated workers (page.on("worker") minus "close", nested pthread
// Workers included) and record a renderer crash. The verdict per run is
// crashed / survived; the report keeps the pool at ready (status().pool:
// unused / running / parked) and the peak of live workers.
//
// Usage: node tests/adversarial/reload-storm.mjs [--url http://localhost:5198/] [--runs 5]
//          [--reloads 5] [--interval-ms 3000] [--run-dir <dir>] [--tag <label>]
// Run it through the host's browser lock. Exit 0 = no crash in any run,
// 1 = at least one crash, 3 = the page never booted.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { arg, fetchJson, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

const url = arg("url", "http://localhost:5198/");
const RUNS = Number(arg("runs", "5"));
const RELOADS = Number(arg("reloads", "5"));
const INTERVAL = Number(arg("interval-ms", "3000"));
const TAG = arg("tag", "run");
const target = resolveTarget(url);
const manifest = await fetchJson(target.runtimeOverride ? target.manifestUrl : target.manifestUrl).catch((e) => { console.error(`reload-storm: refused — ${e.message}`); process.exit(3); });
const dir = runDir(manifest.buildId ?? "unknown", target.mode);
teeLog(dir, `reload-storm-${TAG}.log`);
console.log(`reload-storm ${TAG}: ${url} → ${manifest.buildId}; ${RUNS} run(s) × ${RELOADS} reloads every ${INTERVAL} ms; reports in ${path.relative(root, dir)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runs = [];
let booted = 0;
for (let n = 1; n <= RUNS; n++) {
  const browser = await chromium.launch();
  const out = { n };
  try {
    const page = await (await browser.newContext()).newPage();
    const t0 = Date.now();
    const workers = [];
    page.on("worker", (w) => { const r = { t: Date.now() - t0, closed: null }; workers.push(r); w.on("close", () => { r.closed = Date.now() - t0; }); });
    let crashed = null;
    page.on("crash", () => { crashed = Date.now() - t0; });
    const alive = () => workers.filter((w) => w.closed === null).length;
    const status = () => page.evaluate(() => { try { const s = globalThis.qed64 && globalThis.qed64.status(); return s ? { phase: s.phase, relay: s.relay, pool: s.pool } : null; } catch { return null; } }).catch(() => null);
    const waitReady = async (ms) => { const t = Date.now(); for (;;) { if (crashed !== null) return null; const st = await status(); if (st && st.phase === "ready") return Date.now() - t; if (Date.now() - t > ms) return null; await sleep(250); } };
    const samples = [];
    let sampling = true;
    (async () => { while (sampling) { samples.push(alive()); await sleep(250); } })();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    out.firstReadyMs = await waitReady(600000);
    if (out.firstReadyMs === null) { out.verdict = crashed !== null ? "crashed-before-ready" : "never-ready"; }
    else {
      booted += 1;
      const st = await status();
      out.atReady = { alive: alive(), pool: st?.pool ?? null };
      const ts = Date.now();
      out.reloads = [];
      for (let i = 0; i < RELOADS && crashed === null; i++) {
        if (i) await sleep(Math.max(0, i * INTERVAL - (Date.now() - ts)));
        const r = { i, at: Date.now() - ts, aliveBefore: alive() };
        try { await page.reload({ waitUntil: "commit" }); r.ok = true; } catch (e) { r.ok = false; r.error = String(e.message).split("\n")[0].slice(0, 100); }
        out.reloads.push(r);
      }
      out.readyAfterMs = crashed === null ? await waitReady(300000) : null;
      out.verdict = crashed !== null ? "crashed" : out.readyAfterMs !== null ? "survived" : "not-ready-after";
    }
    sampling = false;
    await sleep(300);
    out.crashedAtMs = crashed;
    out.peakAlive = Math.max(0, ...samples);
  } catch (e) {
    out.verdict = "harness-error";
    out.error = String(e?.message ?? e).split("\n")[0].slice(0, 200);
  } finally {
    await browser.close().catch(() => {});
  }
  runs.push(out);
  console.log(`run ${n}: ${out.verdict}${out.crashedAtMs !== null && out.crashedAtMs !== undefined ? ` at ${out.crashedAtMs} ms` : ""}; first ready ${out.firstReadyMs} ms; at ready ${JSON.stringify(out.atReady ?? null)}; peak live workers ${out.peakAlive}; ready after storm ${out.readyAfterMs ?? null} ms`);
  fs.writeFileSync(path.join(dir, `reload-storm-${TAG}.json`), JSON.stringify({ url, buildId: manifest.buildId, tag: TAG, runs }, null, 1));
  await sleep(5000); // let the dead browser's memory drain before the next run
}
const crashedRuns = runs.filter((r) => r.verdict === "crashed" || r.verdict === "crashed-before-ready").length;
console.log(`RELOAD-STORM ${TAG}: ${crashedRuns}/${runs.length} crashed (${booted} booted) — ${url} (${manifest.buildId})`);
process.exitCode = booted === 0 ? 3 : crashedRuns > 0 ? 1 : 0;
