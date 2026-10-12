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
//   legal   (not in the default list) the other side of the guard: a proof
//           that is deep but within a browser's stack (--legal <source>,
//           seeded at boot as the whole buffer, so `import` lines are its
//           own) must CHECK: no error diagnostic (in particular no "stack is
//           exhausted"), no death, no halt, no crash. Kernel patch 0036's
//           engine-stack probe reserved 128 KiB of a Chrome Worker's
//           ~500 KiB stack, so proofs needing ~370-500 KiB that checked
//           before it failed after it (widgets showcase, 2026-10-09).
//   theorems (not in the default list; HARDENING #70) many theorems in one
//           Mathlib file, seeded at boot: 10 nlinarith + 10 ring, then one
//           wrong `decide`. Under Lean's default Elab.async every blocked
//           theorem task started a standard worker that never exits: this
//           file held ~46 pthreads and crashed the renderer at ~16 s. PASS =
//           the legal checks, except exactly one error, on the last line.
//   pause   (not in the default list; HARDENING #72) the stack-overflow pause:
//           an Init-only `example : True := by` over a 25-step `<;>` chain of
//           `trivial`, seeded, kills the FileWorker at any probe size. PASS =
//           within --wait-ms exactly 1 worker death, relay "halted", lastDeath
//           code ENGINE_STACK_OVERFLOW, still 1 death 10 s later (no reboot
//           loop), the QED64 note with code ENGINE_STACK_OVERFLOW published;
//           then setDocument("example : True := trivial") settles ready with
//           no further death.
// Records: final phase/relay, deaths, reboots, halts, lastDeath, every console
// line mentioning "Maximum call stack" or "RangeError", page crash, pool peak.
// Verdict per scenario: PASS when no renderer crash, no "Maximum call stack"
// line, no worker death and no halt (the checker answered the line with a
// diagnostic instead); FAIL otherwise (`pause` has its own, above). Run it
// through the host browser lock.
// Usage: node tests/adversarial/deep-recursion.mjs --url http://localhost:5185/ [--scenarios seeded,typing,legal,theorems,pause] [--legal <lean source>] [--wait-ms 120000]
// Exit 0 = every scenario passed, 1 = one failed.
import { chromium } from "playwright";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const url = arg("url", "http://localhost:5185/");
const SCENARIOS = arg("scenarios", "seeded,typing").split(",");
const WAIT = Number(arg("wait-ms", "120000"));
const LINE = "example : ∀ n : Fin 40, ∀ m : Fin 40, n * m = m * n := by decide";
const HEADER = "import Mathlib\n\n";
const LEGAL = arg("legal", null)?.replace(/\\n/g, "\n") ?? null;
const THEOREMS = HEADER + [
  ...Array.from({ length: 10 }, (_, i) => `theorem amgm${i + 1} (x y : ℝ) : 2 * (${i + 1} * x) * y ≤ (${i + 1} * x) ^ 2 + y ^ 2 := by nlinarith [sq_nonneg (${i + 1} * x - y)]`),
  ...Array.from({ length: 10 }, (_, i) => `theorem cube${i + 1} (x : ℝ) : (x + ${i + 1}) ^ 3 = x ^ 3 + 3 * ${i + 1} * x ^ 2 + 3 * ${i + 1} ^ 2 * x + ${i + 1} ^ 3 := by ring`),
  "theorem wrong : (2 : ℕ) + 2 = 5 := by decide",
].join("\n");
const THEOREMS_LAST = THEOREMS.split("\n").length - 1; // 0-based line of the wrong theorem
const PAUSE = `example : True := by ${Array(25).fill("trivial").join(" <;> ")}\n`; // HARDENING #72: overruns the engine stack
if (SCENARIOS.includes("legal") && !LEGAL) { console.log("deep-recursion: usage: --scenarios legal needs --legal <lean source>"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function run(browser, sc) {
  const context = await browser.newContext();
  const seed = sc === "seeded" ? HEADER + LINE + "\n" : sc === "legal" ? `${LEGAL}\n` : sc === "theorems" ? `${THEOREMS}\n` : sc === "pause" ? PAUSE : HEADER + "theorem warm : 1 + 1 = 2 := rfl\n";
  await context.addInitScript((t) => { try { localStorage.setItem("qed64.buffer", t); } catch {} }, seed);
  // The checker's own diagnostics for the document (origin "lean"), and the page's own notes (origin "qed64"), newest last.
  await context.addInitScript(() => {
    const hook = () => { const a = globalThis.qed64?.api; if (!a) return setTimeout(hook, 20); a.on("diagnostics", (d) => { if (d.origin === "lean") globalThis.__deepDiags = d; else globalThis.__qedNote = d; }); };
    hook();
  });
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
  let legal = null;
  let pause = null;
  if (sc === "pause") {
    const record = async () => { const s = await sample(); if (s) { s.t = Date.now() - t0; samples.push(s); } return s; };
    let at = null;
    while (Date.now() - t0 < WAIT && crashedAt === null) { const s = await record(); if (s?.relay === "halted") { at = s; break; } await sleep(500); }
    await sleep(10000); // a reboot loop would show further deaths here
    const later = await record();
    const d = await page.evaluate(() => globalThis.__qedNote ?? null).catch(() => null);
    const note = (d?.diagnostics ?? []).find((x) => x.source === "QED64" && x.code === "ENGINE_STACK_OVERFLOW") ?? null;
    await page.evaluate(() => globalThis.qed64.api.setDocument("example : True := trivial\n")).catch(() => {});
    let resumed = null;
    const tEdit = Date.now();
    while (Date.now() - tEdit < WAIT && crashedAt === null) { const s = await record(); if (s?.phase === "ready" && s.relay === "serving") { resumed = s; break; } await sleep(500); }
    pause = { at, later, note: note ? { line: note.range?.start?.line ?? null, message: String(note.message).slice(0, 160) } : null, resumed };
  } else if (sc === "legal" || sc === "theorems") {
    // Wait for the checker to settle on the seeded document, then read its last diagnostics.
    const settled = page.evaluate((ms) => globalThis.qed64.api.settled({ timeoutMs: ms }).then(() => true, (e) => String(e?.message ?? e)), WAIT).catch((e) => String(e));
    let result = null;
    while (crashedAt === null && result === null) {
      const s = await sample(); if (s) { s.t = Date.now() - t0; samples.push(s); }
      result = await Promise.race([settled, sleep(250).then(() => null)]);
    }
    await sleep(2000); // stragglers: a late diagnostics frame
    const d = await page.evaluate(() => globalThis.__deepDiags ?? null).catch(() => null);
    const errs = (d?.diagnostics ?? []).filter((x) => x.severity === 1);
    const errors = errs.map((x) => String(x.message).slice(0, 240));
    legal = { settled: result, settledAt: samples.at(-1)?.t ?? null, version: d?.version ?? null, diagnostics: d?.diagnostics?.length ?? null, errors, errorLines: errs.map((x) => x.range?.start?.line ?? null) };
  } else if (sc === "typing") {
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
  const row = { sc, crashedAt, last, legal, pause, peakPool, peakRunning: Math.max(-1, ...samples.map((s) => s.pool?.running ?? -1)), halted: samples.some((s) => s.relay === "halted"), phases: [...new Set(samples.map((s) => `${s.phase}/${s.relay}`))], stackLines: stackLines.slice(0, 8), stackLineCount: stackLines.length };
  await context.close().catch(() => {});
  return row;
}

const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
try {
  for (const sc of SCENARIOS) {
    const row = await run(browser, sc);
    const p = row.pause;
    const ok = sc === "pause"
      ? row.crashedAt === null && p?.at?.deaths === 1 && p.at.lastDeath?.code === "ENGINE_STACK_OVERFLOW" && p.later?.deaths === 1 && p.later.relay === "halted" && p.note !== null && p.resumed?.deaths === 1
      : row.crashedAt === null && row.stackLineCount === 0 && !row.halted && (row.last?.deaths ?? 1) === 0
        && (sc !== "legal" || (row.legal?.settled === true && row.legal.diagnostics !== null && row.legal.errors.length === 0))
        && (sc !== "theorems" || (row.legal?.settled === true && row.legal.errorLines.length === 1 && row.legal.errorLines[0] === THEOREMS_LAST));
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${sc}: ${row.crashedAt !== null ? `renderer crashed at ${(row.crashedAt / 1000).toFixed(1)} s` : `${row.last?.deaths ?? "?"} death(s), ${row.halted ? "halted" : "not halted"}, ${row.stackLineCount} stack-overflow line(s)`}; pool peak ${row.peakPool}`);
    if (p) console.log(`  pause: ${p.at ? `halted at ${(p.at.t / 1000).toFixed(1)} s, code ${p.at.lastDeath?.code ?? "none"}` : "never halted"}; 10 s later ${p.later?.deaths ?? "?"} death(s); note ${p.note ? `on line ${p.note.line}` : "missing"}; after the edit ${p.resumed ? `ready, ${p.resumed.deaths} death(s) in all` : "not ready"}`);
    if (row.legal) console.log(`  ${sc}: settled ${JSON.stringify(row.legal.settled)}, ${row.legal.diagnostics ?? "no"} diagnostic(s) at version ${row.legal.version}, errors: ${row.legal.errors.length ? row.legal.errors.map((e) => JSON.stringify(e)).join("; ") : "none"}`);
    console.log(`  RESULT ${sc} :: ${JSON.stringify(row)}`);
    await sleep(5000);
  }
} finally { await browser.close().catch(() => {}); }
console.log(`deep-recursion: ${results.filter(Boolean).length}/${results.length} pass`);
process.exit(results.every(Boolean) ? 0 : 1);
