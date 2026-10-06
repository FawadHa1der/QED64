#!/usr/bin/env node
// Deep recursion (HARDENING #60): `decide` over Fin 40 × Fin 40 overflows a
// pthread's JS stack ("Uncaught RangeError: Maximum call stack size exceeded")
// before Lean's own maxRecDepth/stack guard fires; the FileWorker dies, the
// relay reboots and the breaker halts it. Reported by lean4game 2026-10-06
// (kernel 0032: also pool 26 → 77 and a tab crash while typing); reproduced
// on QED64's kernel 0035 the same day (3 deaths + halt; pool held at 24 by
// the #59 back-pressure). This lane is the regression check for the kernel
// fix: it FAILS while the overflow happens, and passes once the checker
// reports Lean's own recursion error and stays up.
//
// Scenarios (fresh context each):
//   seeded  the buffer holds the line at boot; wait up to --wait-ms
//   typing  boot a clean Mathlib buffer, then type the line at 150 ms/char
// Records: final phase/relay, deaths, reboots, halts, lastDeath, every console
// line mentioning "Maximum call stack" or "RangeError", page crash, pool peak.
// Verdict per scenario: PASS when no renderer crash, no "Maximum call stack"
// line, no worker death and no halt (the checker answered the line with a
// diagnostic instead); FAIL otherwise. Run it through the host browser lock.
// Usage: node tests/adversarial/deep-recursion.mjs --url http://localhost:5185/ [--scenarios seeded,typing] [--wait-ms 120000]
// Exit 0 = every scenario passed, 1 = one failed.
import { chromium } from "playwright";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const url = arg("url", "http://localhost:5185/");
const SCENARIOS = arg("scenarios", "seeded,typing").split(",");
const WAIT = Number(arg("wait-ms", "120000"));
const LINE = "example : ∀ n : Fin 40, ∀ m : Fin 40, n * m = m * n := by decide";
const HEADER = "import Mathlib\n\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function run(browser, sc) {
  const context = await browser.newContext();
  const seed = sc === "seeded" ? HEADER + LINE + "\n" : HEADER + "theorem warm : 1 + 1 = 2 := rfl\n";
  await context.addInitScript((t) => { try { localStorage.setItem("qed64.buffer", t); } catch {} }, seed);
  const page = await context.newPage();
  let crashedAt = null;
  const t0 = Date.now();
  const stackLines = [];
  page.on("crash", () => { crashedAt = Date.now() - t0; });
  page.on("console", (m) => { const t = m.text(); if (/Maximum call stack|RangeError/.test(t)) stackLines.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${t.slice(0, 200)}`); });
  page.on("pageerror", (e) => { const t = String(e); if (/Maximum call stack|RangeError/.test(t)) stackLines.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] pageerror ${t.slice(0, 200)}`); });
  page.on("worker", (w) => w.on("console", (m) => { const t = m.text(); if (/Maximum call stack|RangeError/.test(t)) stackLines.push(`[${((Date.now() - t0) / 1000).toFixed(1)}s] worker ${t.slice(0, 200)}`); }));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const sample = () => page.evaluate(() => { const r = globalThis.qed64?.test?.rawStatus?.(); const st = globalThis.qed64?.test?.stats?.(); return r ? { phase: r.phase, relay: r.relay, pool: r.pool, session: r.session, lastDeath: r.lastDeath ? { reason: r.lastDeath.reason, message: String(r.lastDeath.message).slice(0, 160), code: r.lastDeath.cause?.code ?? null } : null, deaths: st?.workerDeaths ?? null, reboots: st?.reboots ?? null, breakerTrips: st?.breakerTrips ?? st?.halts ?? null } : null; }).catch(() => null);
  const samples = [];
  if (sc === "typing") {
    for (;;) { const s = await sample(); if (s?.phase === "ready" || crashedAt !== null || Date.now() - t0 > 300000) break; await sleep(500); }
    await page.click(".monaco-editor .view-lines").catch(() => {});
    await page.evaluate(() => globalThis.qed64.api.setCursor({ lineNumber: 3, column: 1 })).catch(() => {});
    const typing = page.keyboard.type(LINE + "\n", { delay: 150 }).catch((e) => String(e));
    const tType = Date.now();
    while (Date.now() - tType < LINE.length * 150 + WAIT && crashedAt === null) { const s = await sample(); if (s) { s.t = Date.now() - t0; samples.push(s); } await sleep(250); }
    await typing;
  } else {
    while (Date.now() - t0 < WAIT && crashedAt === null) { const s = await sample(); if (s) { s.t = Date.now() - t0; samples.push(s); } if (s?.relay === "halted" && samples.filter((x) => x.relay === "halted").length > 8) break; await sleep(500); }
  }
  const last = samples.at(-1) ?? null;
  const peakPool = Math.max(-1, ...samples.map((s) => (s.pool ? s.pool.unused + s.pool.running : -1)));
  const row = { sc, crashedAt, last, peakPool, peakRunning: Math.max(-1, ...samples.map((s) => s.pool?.running ?? -1)), halted: samples.some((s) => s.relay === "halted"), phases: [...new Set(samples.map((s) => `${s.phase}/${s.relay}`))], stackLines: stackLines.slice(0, 8), stackLineCount: stackLines.length };
  await context.close().catch(() => {});
  return row;
}

const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
try {
  for (const sc of SCENARIOS) {
    const row = await run(browser, sc);
    const ok = row.crashedAt === null && row.stackLineCount === 0 && !row.halted && (row.last?.deaths ?? 1) === 0;
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${sc}: ${row.crashedAt !== null ? `renderer crashed at ${(row.crashedAt / 1000).toFixed(1)} s` : `${row.last?.deaths ?? "?"} death(s), ${row.halted ? "halted" : "not halted"}, ${row.stackLineCount} stack-overflow line(s)`}; pool peak ${row.peakPool}`);
    console.log(`  RESULT ${sc} :: ${JSON.stringify(row)}`);
    await sleep(5000);
  }
} finally { await browser.close().catch(() => {}); }
console.log(`deep-recursion: ${results.filter(Boolean).length}/${results.length} pass`);
process.exit(results.every(Boolean) ? 0 : 1);
