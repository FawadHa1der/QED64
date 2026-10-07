#!/usr/bin/env node
// Reload storm (HARDENING #53, #55): a ready page reloaded while its runtime is
// live — the old page's Lean runtime (the lean.worker and every pthread
// Worker) and the new one coexist in one renderer for a moment. Each run is
// a fresh browser: boot the page to `ready`, reload at 0, 3, 6, 9 and 12 s
// (waitUntil "commit"), then wait for `ready` again; every 250 ms count the
// live dedicated workers (page.on("worker") minus "close", nested pthread
// Workers included) and record a renderer crash. The verdict per run is
// crashed / survived; the report keeps the pool at ready (status().pool:
// unused / running / parked) and the peak of live workers.
//
// Oracle: the page `crash` event, classified by the V8 OOM line in the
// browser's stderr (captured through DEBUG=pw:browser into
// reload-storm-<tag>-<n>.browser.log): V1 = "Scavenger: semi-space copy"
// (#53), V2 = "MarkCompactCollector: young object promotion failed" (#55).
// Every worker's creation and close is kept with its kind (lean / blob =
// the pthread glue / prefetch / other) and wall-clock epoch, so a report
// lines up with the sampler.
//
// Usage: node tests/adversarial/reload-storm.mjs [--url http://localhost:5198/] [--runs 5]
//          [--reloads 5] [--interval-ms 3000] [--run-dir <dir>] [--tag <label>]
//          [--headed] [--embed] [--embed-host /embed-host.html] [--ballast-mb 0] [--sample-ms 100] [--ready-each] [--console-log]
//   --headed     Chrome for Testing in a real window (the default is chrome-headless-shell),
//                with --force-device-scale-factor=1 and a 1440×900 viewport
//   --embed      load the QED64 page (--url) as the only iframe of the same-origin host
//                page public/embed-host.html (dev server only) and reload the HOST, as an
//                embedding site does; ready = the frame's qed64.status()
//   --ballast-mb N (with --embed) the host page first holds N MiB of live JS objects: a heavy
//                embedding page sharing the renderer's pointer cage (HARDENING #55 residual)
//   --console-log keep the worker's [lean:*] console lines with their times (boot phases per instance)
//   --ready-each time every reload to `ready` (a latency probe: use an interval longer than a boot)
//   --sample-ms  run tests/adversarial/renderer-sampler.py for each browser: every child
//                process's RSS / footprint / threads every N ms (reload-storm-<tag>-<n>.procs.tsv)
// A/B: one invocation per run (--runs 1 --tag <arm>-r<n>, arms interleaved) into one --run-dir, then
// tests/adversarial/reload-storm-summary.py <run-dir> (crash counts, Fisher tests, per-reload process facts).
// Run it through the host's browser lock. Exit 0 = no crash in any run,
// 1 = at least one crash, 3 = the page never booted.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { arg, fetchJson, has, reclaimableBytes, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

const url = arg("url", "http://localhost:5198/");
const RUNS = Number(arg("runs", "5"));
const RELOADS = Number(arg("reloads", "5"));
const INTERVAL = Number(arg("interval-ms", "3000"));
const TAG = arg("tag", "run");
const HEADED = has("--headed");
const EMBED = has("--embed");
const SAMPLE_MS = Number(arg("sample-ms", "0"));
const READY_EACH = has("--ready-each");
const CONSOLE_LOG = has("--console-log");
const target = resolveTarget(url);
const qedPath = new URL(url).pathname + new URL(url).search;
const BALLAST_MB = Number(arg("ballast-mb", "0"));
const pageUrl = EMBED ? `${target.origin}${arg("embed-host", "/embed-host.html")}?src=${encodeURIComponent(qedPath)}${BALLAST_MB > 0 ? `&ballast=${BALLAST_MB}` : ""}` : url;
const manifest = await fetchJson(target.runtimeOverride ? target.manifestUrl : target.manifestUrl).catch((e) => { console.error(`reload-storm: refused — ${e.message}`); process.exit(3); });
if (EMBED) {
  const r = await fetch(pageUrl, { cache: "no-cache" }).catch(() => null);
  const body = r && r.ok ? await r.text() : "";
  if (!/qed64-frame/.test(body) || r.headers.get("cross-origin-embedder-policy") !== "require-corp") { console.error(`reload-storm: refused — ${pageUrl} is not the embed host page with COEP (dev server only)`); process.exit(3); }
}
const dir = runDir(manifest.buildId ?? "unknown", target.mode);
teeLog(dir, `reload-storm-${TAG}.log`);
const browserMode = HEADED ? "headed" : "headless-shell";
console.log(`reload-storm ${TAG}: ${pageUrl}${EMBED ? " (embedded)" : ""} → ${manifest.buildId}; ${browserMode}; ${RUNS} run(s) × ${RELOADS} reloads every ${INTERVAL} ms; reports in ${path.relative(root, dir)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The browser's stderr (the V8 OOM line) reaches us only through Playwright's
// debug logger, which reads DEBUG when it loads: set it, then import.
process.env.DEBUG = [process.env.DEBUG, "pw:browser"].filter(Boolean).join(",");
let browserLog = null;
const ooms = [];
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const s = String(chunk);
  if (!/pw:browser/.test(s)) return stderrWrite(chunk, ...rest);
  if (browserLog) fs.appendFileSync(browserLog, s);
  for (const line of s.split("\n")) {
    const m = /V8 (?:javascript|process) OOM \(([^)]*)\)|Fatal (?:JavaScript|process) out of memory[^\n]*/.exec(line);
    if (m) ooms.push({ epoch: Date.now(), pid: Number((/\]\s*\[(\d+):/.exec(line) || [])[1]) || null, text: (m[1] || m[0]).slice(0, 160) });
  }
  return true;
};
const { chromium } = await import("playwright");
const oomKind = (t) => (/semi-space copy/.test(t) ? "V1" : /young object promotion failed/.test(t) ? "V2" : `other: ${t}`);
const workerKind = (u) => (/lean\.worker\.js/.test(u) ? "lean" : /^blob:/.test(u) ? "blob" : /snapshot-prefetch/.test(u) ? "prefetch" : "other");
const sh = (cmd, args) => (spawnSync(cmd, args, { encoding: "utf8" }).stdout || "").trim();
const hostState = () => ({
  reclaimableGB: Math.round(reclaimableBytes() / 1e8) / 10,
  swapUsed: (/used = ([\d.]+\w)/.exec(sh("sysctl", ["vm.swapusage"])) || [])[1] ?? null,
  load1: Math.round(os.loadavg()[0] * 10) / 10,
  foreignHeadlessShell: sh("pgrep", ["-f", "chrome-headless-shell"]).split("\n").filter(Boolean).length,
  wasmNode: sh("pgrep", ["-f", "node --stack-size=8192"]).split("\n").filter(Boolean).length,
});

const runs = [];
let booted = 0;
for (let n = 1; n <= RUNS; n++) {
  const marker = `--qed64-storm=${process.pid}-${n}`;
  const out = { n, mode: browserMode, embed: EMBED, ballastMb: BALLAST_MB, host: hostState() };
  browserLog = path.join(dir, `reload-storm-${TAG}-${n}.browser.log`);
  const oomsBefore = ooms.length;
  const browser = await chromium.launch({ headless: !HEADED, args: [...(HEADED ? ["--force-device-scale-factor=1"] : []), marker] });
  let sampler = null;
  if (SAMPLE_MS > 0) {
    out.procs = path.relative(root, path.join(dir, `reload-storm-${TAG}-${n}.procs.tsv`));
    sampler = spawn("python3", [path.join(root, "tests/adversarial/renderer-sampler.py"), `--marker=${marker}`, "--out", path.join(root, out.procs), "--interval-ms", String(SAMPLE_MS)], { stdio: "ignore" });
  }
  try {
    out.browserVersion = browser.version();
    const page = await (await browser.newContext(HEADED ? { viewport: { width: 1440, height: 900 } } : {})).newPage();
    const t0 = Date.now();
    out.t0Epoch = t0;
    const workers = [];
    page.on("worker", (w) => { const r = { t: Date.now() - t0, kind: workerKind(w.url()), url: w.url().replace(target.origin, "").slice(0, 80), closed: null }; workers.push(r); w.on("close", () => { r.closed = Date.now() - t0; }); });
    let crashed = null;
    page.on("crash", () => { crashed = Date.now() - t0; });
    // The worker's boot notes (HARDENING #55: "[boot] waited N ms for M stopping runtime(s)").
    const waits = [];
    const notes = [];
    page.on("console", (m) => {
      const s = m.text();
      if (/\[boot\] waited/.test(s)) waits.push({ t: Date.now() - t0, text: s.replace(/^.*\[boot\] /, "").slice(0, 120) });
      if (CONSOLE_LOG && /^\[lean:/.test(s) && notes.length < 400) notes.push({ t: Date.now() - t0, text: s.slice(0, 120) });
    });
    const alive = () => workers.filter((w) => w.closed === null).length;
    const status = () => page.evaluate((embed) => {
      try {
        let w = globalThis;
        if (embed) { const f = document.getElementById("qed64-frame"); w = f && f.contentWindow; }
        const s = w && w.qed64 && w.qed64.status();
        return s ? { phase: s.phase, relay: s.relay, pool: s.pool } : null;
      } catch { return null; }
    }, EMBED).catch(() => null);
    const waitReady = async (ms) => { const t = Date.now(); for (;;) { if (crashed !== null) return null; const st = await status(); if (st && st.phase === "ready") return Date.now() - t; if (Date.now() - t > ms) return null; await sleep(250); } };
    const samples = [];
    let sampling = true;
    (async () => { while (sampling) { samples.push(alive()); await sleep(250); } })();
    await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
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
        const r = { i, at: Date.now() - ts, t: Date.now() - t0, aliveBefore: alive() };
        try { await page.reload({ waitUntil: "commit" }); r.ok = true; } catch (e) { r.ok = false; r.error = String(e.message).split("\n")[0].slice(0, 100); }
        r.commitMs = Date.now() - t0 - r.t;
        out.reloads.push(r);
        // --ready-each (latency, not a storm): time each reload to `ready`, within the interval.
        if (READY_EACH && i < RELOADS - 1) r.readyMs = await waitReady(Math.max(0, (i + 1) * INTERVAL - (Date.now() - ts) - 250));
      }
      out.readyAfterMs = crashed === null ? await waitReady(300000) : null;
      out.verdict = crashed !== null ? "crashed" : out.readyAfterMs !== null ? "survived" : "not-ready-after";
    }
    sampling = false;
    await sleep(300);
    out.crashedAtMs = crashed;
    if (crashed !== null && out.reloads?.length) {
      const prev = out.reloads.filter((r) => r.t <= crashed).pop();
      out.crashAfterReload = prev ? { reload: prev.i, ms: crashed - prev.t } : null;
    }
    out.peakAlive = Math.max(0, ...samples);
    out.workers = workers;
    out.predecessorWaits = waits;
    if (CONSOLE_LOG) out.console = notes;
  } catch (e) {
    out.verdict = "harness-error";
    out.error = String(e?.message ?? e).split("\n")[0].slice(0, 200);
  } finally {
    await browser.close().catch(() => {});
    if (sampler) sampler.kill();
  }
  out.oom = ooms.slice(oomsBefore).map((o) => ({ ...o, kind: oomKind(o.text), tRun: out.t0Epoch ? o.epoch - out.t0Epoch : null }));
  out.oomKind = out.oom.length ? [...new Set(out.oom.map((o) => o.kind))].join("+") : null;
  runs.push(out);
  const ca = out.crashAfterReload;
  console.log(`run ${n}: ${out.verdict}${out.crashedAtMs !== null && out.crashedAtMs !== undefined ? ` at ${out.crashedAtMs} ms${ca ? ` (${ca.ms} ms after reload ${ca.reload})` : ""}` : ""}${out.oomKind ? ` [${out.oomKind}, ${out.oom.length} OOM line(s)]` : ""}; first ready ${out.firstReadyMs} ms; at ready ${JSON.stringify(out.atReady ?? null)}; peak live workers ${out.peakAlive}${out.predecessorWaits?.length ? `; waited for predecessors ${out.predecessorWaits.length}× (${out.predecessorWaits.map((w) => (/waited (\d+) ms/.exec(w.text) || [])[1]).join("/")} ms)` : ""}; ready after storm ${out.readyAfterMs ?? null} ms${READY_EACH ? `; reload→ready ${(out.reloads || []).map((r) => r.readyMs ?? "-").join("/")} ms` : ""}; host ${out.host.reclaimableGB} GB reclaimable`);
  fs.writeFileSync(path.join(dir, `reload-storm-${TAG}.json`), JSON.stringify({ url: pageUrl, qed64Url: url, embed: EMBED, ballastMb: BALLAST_MB, mode: browserMode, buildId: manifest.buildId, tag: TAG, runs }, null, 1));
  await sleep(5000); // let the dead browser's memory drain before the next run
}
const crashedRuns = runs.filter((r) => r.verdict === "crashed" || r.verdict === "crashed-before-ready");
const kinds = crashedRuns.map((r) => r.oomKind || "no OOM line").reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {});
console.log(`RELOAD-STORM ${TAG}: ${crashedRuns.length}/${runs.length} crashed${crashedRuns.length ? ` ${JSON.stringify(kinds)}` : ""} (${booted} booted) — ${browserMode}${EMBED ? " embedded" : ""} ${pageUrl} (${manifest.buildId})`);
process.exitCode = booted === 0 ? 3 : crashedRuns.length > 0 ? 1 : 0;
