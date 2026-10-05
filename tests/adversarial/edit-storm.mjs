#!/usr/bin/env node
// Edit storm (HARDENING #59; docs/EMBEDDING.md §7.8): a client that sends a
// full-text didChange per keystroke starts an elaboration per keystroke, and
// abandoned elaborations that never check cancellation keep their pthreads,
// so the runtime's pool grows past its preallocated Workers until V8 runs out
// of memory (lean4game, 2026-10-05). The page's own editor rarely shows it;
// this lane takes it out of the path: it sends raw didChanges through the
// test hatch (qed64.test.lsp.notify → relay → ResidentSession's edit
// coalescer → worker), exactly what a library embedder does, and samples the
// worker's pool ({unused, running}) every 100 ms.
//
// Scenarios (fresh context each; the default Mathlib document, header kept):
//   fast      a tactic line typed at 10 ms/char (59 changes in ~600 ms)
//   slow      the same at 150 ms/char
//   heavy     fast, with a cancellable `decide` below the typed line
//   sleep     fast, with `#eval IO.sleep 3000` below the typed line: each
//             abandoned elaboration holds its thread for 3 s
//   sleepreq  sleep, plus a $/lean/plainGoal request after every change
//             (lean4monaco's change-then-requests stream)
//   pagesleep the page's own editor (Monaco + vscode-languageclient +
//             InfoView), keyboard typing at 10 ms/char above the sleep
// Verdict per run: the typing happened, no renderer crash, no death or
// reboot, ready at the last version typed, and the pool (unused + running,
// the exact total: a finished thread's Worker goes back to the pool) not
// grown more than --grow-tolerance (4) Workers past its preallocation.
// Without coalescing (fd6c2ae) sleep and sleepreq crashed every run with 65-70
// running pthreads; with it they peak at 13-24.
//
// Usage: node tests/adversarial/edit-storm.mjs [--url http://localhost:5185/]
//          [--reps 2] [--scenarios sleep,sleepreq,pagesleep,fast] [--grow-tolerance 4]
// Run it through the host's browser lock (one heavy runtime at a time).
// Exit 0 = every run passed, 1 = a run failed, 3 = infrastructure.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { arg, fetchJson, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

const url = arg("url", "http://localhost:5185/");
const REPS = Number(arg("reps", "2"));
const SCENARIOS = arg("scenarios", "sleep,sleepreq,pagesleep,fast").split(",");
const GROW = Number(arg("grow-tolerance", "4"));
const target = resolveTarget(url);
const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`edit-storm: refused — ${e.message}`); process.exit(3); });
const dir = runDir(manifest.buildId ?? "unknown", target.mode);
teeLog(dir, "edit-storm.log");
const OUT = path.join(dir, "edit-storm.json");
console.log(`edit-storm: ${url} → ${manifest.buildId}; scenarios ${SCENARIOS.join(",")} × ${REPS}; reports in ${path.relative(root, dir)}`);
const BODY = "example (a b : ℕ) (h : a ≤ b) : a + 1 ≤ b + 1 := by omega";
const SUFFIX = {
  fast: "", slow: "",
  heavy: "\n\ntheorem qed64_heavy : ∀ n < 60, n * n < 3600 := by decide\n",
  sleep: "\n\n#eval (IO.sleep 3000 : IO Unit)\n",
  sleepreq: "\n\n#eval (IO.sleep 3000 : IO Unit)\n",
  pagesleep: "\n\n#eval (IO.sleep 3000 : IO Unit)\n",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function run(browser, sc, rep) {
  const context = await browser.newContext();
  if (sc === "pagesleep") await context.addInitScript((t) => { try { localStorage.setItem("qed64.buffer", t); } catch {} }, "import Mathlib\n\n" + SUFFIX.pagesleep);
  const page = await context.newPage();
  let crashedAt = null;
  const t0 = Date.now();
  page.on("crash", () => { crashedAt = Date.now() - t0; });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  for (;;) {
    const ph = await page.evaluate(() => globalThis.qed64?.api?.status?.().phase ?? null).catch(() => null);
    if (ph === "ready") break;
    if (crashedAt !== null || Date.now() - t0 > 300000) { await context.close().catch(() => {}); return { sc, rep, infra: `boot: crashed=${crashedAt} phase=${ph}` }; }
    await sleep(250);
  }
  const doc = await page.evaluate(() => globalThis.qed64.api.getDocument());
  const header = doc.text.split("\n").filter((l) => /^import\s/.test(l)).join("\n") + "\n\n";
  const before = await page.evaluate(() => ({ pool: globalThis.qed64.test.rawStatus().pool, stats: globalThis.qed64.test.stats() }));
  // The typing runs inside the page (a 10 ms cadence a CDP round trip per key would distort).
  const typed = sc === "pagesleep" ? (async () => {
    await page.click(".monaco-editor .view-lines");
    await page.evaluate(() => globalThis.qed64.api.setCursor(2, 1));
    await page.keyboard.type(BODY, { delay: 10 });
    await sleep(800); // the client's 250 ms delayer, then the forward
    return page.evaluate(() => globalThis.qed64.api.getDocument().version);
  })().catch((e) => ({ error: String(e).slice(0, 200) })) : page.evaluate(async ({ uri, base, header, body, suffix, ms, req }) => {
    const line = header.split("\n").length - 1;
    const send = (version, text) => {
      globalThis.qed64.test.lsp.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
      if (req) globalThis.qed64.test.lsp.request("$/lean/plainGoal", { textDocument: { uri }, position: { line, character: text.length - header.length - suffix.length } }, 5000).catch(() => {});
    };
    let v = base;
    send(++v, header + suffix); // select-all + Backspace under the fixed header
    for (let i = 1; i <= body.length; i += 1) { await new Promise((r) => setTimeout(r, ms)); send(++v, header + body.slice(0, i) + suffix); }
    return v;
  }, { uri: doc.uri, base: doc.version ?? 1, header, body: BODY, suffix: SUFFIX[sc], ms: sc === "slow" ? 150 : 10, req: sc === "sleepreq" }).catch((e) => ({ error: String(e).slice(0, 200) }));
  const samples = [];
  let lastVersion = null; // the version the typing ended at (null until it does; stays null when it failed)
  let typedError = null;
  let typedAt = null; // when the typing ended
  const tType = Date.now();
  for (;;) {
    if (crashedAt !== null) break;
    const s = await Promise.race([page.evaluate(() => { const r = globalThis.qed64.test.rawStatus(); return { pool: r.pool, phase: r.phase, relay: r.relay, version: r.version, session: r.session }; }).catch(() => null), sleep(2000).then(() => null)]);
    if (s) { s.t = Date.now() - tType; samples.push(s); }
    if (lastVersion === null && typedError === null) {
      const v = await Promise.race([typed, sleep(0).then(() => undefined)]);
      if (typeof v === "number") { lastVersion = v; typedAt = Date.now(); } else if (v && v.error) { typedError = v.error; break; }
    }
    if (lastVersion !== null && s && s.phase === "ready" && s.version === lastVersion && s.relay === "serving") break;
    if (Date.now() - tType > 180000) break;
    await sleep(100);
  }
  const after = crashedAt !== null ? null : await page.evaluate(() => ({ stats: globalThis.qed64.test.stats(), status: globalThis.qed64.api.status() })).catch(() => null);
  const total = (p) => (p ? p.unused + p.running : -1);
  const row = {
    sc, rep, crashedAt, lastVersion, typedError,
    // ready AT the version the typing ended at (coalescing may skip the ones before it, never the last)
    settled: !!(after && lastVersion !== null && after.status.phase === "ready" && after.status.relay === "serving" && after.status.version === lastVersion),
    poolBefore: before.pool, peakRunning: Math.max(-1, ...samples.map((s) => s.pool?.running ?? -1)),
    peakPool: Math.max(-1, ...samples.map((s) => total(s.pool))), finalPool: samples.at(-1)?.pool ?? null,
    peakParked: Math.max(-1, ...samples.map((s) => s.pool?.parked ?? -1)),
    deaths: after?.stats?.workerDeaths ?? null, reboots: after?.stats?.reboots ?? null, sessions: [...new Set(samples.map((s) => s.session))],
    readyAfterFirstKeyMs: samples.at(-1)?.t ?? null, readyAfterTypingMs: typedAt === null ? null : Date.now() - typedAt, lastDeath: after?.status?.lastDeath ?? null,
  };
  fs.writeFileSync(OUT.replace(/\.json$/, `-${sc}-${rep}-samples.json`), JSON.stringify(samples));
  await context.close().catch(() => {});
  return row;
}

const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
try {
  for (let rep = 1; rep <= REPS; rep += 1) {
    for (const sc of SCENARIOS) {
      const row = await run(browser, sc, rep);
      results.push(row);
      console.log(`  ${row.infra ? "INFRA" : row.crashedAt !== null ? "CRASH" : row.typedError !== null ? "TYPING-FAILED" : row.settled ? "OK" : "UNSETTLED"} ${sc}#${rep} :: ${JSON.stringify(row)}`);
      await sleep(5000);
    }
  }
} finally {
  await browser.close().catch(() => {});
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
}
const grownBy = (r) => (r.poolBefore ? r.peakPool - (r.poolBefore.unused + r.poolBefore.running) : null);
const failed = (r) => !!r.infra || r.typedError !== null || r.lastVersion === null || r.crashedAt !== null || !r.settled || (r.deaths ?? 1) > 0 || (r.reboots ?? 1) > 0 || (grownBy(r) ?? 0) > GROW;
const why = (r) => r.typedError !== null ? `the typing failed: ${r.typedError}` : r.lastVersion === null ? "the typing never ended" : r.crashedAt !== null ? `renderer crashed at ${(r.crashedAt / 1000).toFixed(1)} s` : !r.settled ? `never ready at the last version (${r.lastVersion})` : (r.deaths ?? 1) > 0 || (r.reboots ?? 1) > 0 ? `${r.deaths} death(s), ${r.reboots} reboot(s)` : `ready at the last version, ${r.deaths} deaths`;
for (const r of results) if (!r.infra) console.log(`${failed(r) ? "FAIL" : "PASS"} ${r.sc}#${r.rep}: ${why(r)}; pool ${r.poolBefore.unused + r.poolBefore.running} → peak ${r.peakPool} (grown by ${Math.max(0, grownBy(r))}, running peak ${r.peakRunning}); ready ${r.readyAfterTypingMs ?? "-"} ms after the typing ended (${r.readyAfterFirstKeyMs} ms after its first key)`);
const bad = results.filter(failed).length;
console.log(`edit-storm: ${results.length - bad}/${results.length} pass; report ${path.relative(root, OUT)}`);
process.exit(results.some((r) => r.infra) && bad === results.length ? 3 : bad ? 1 : 0);
