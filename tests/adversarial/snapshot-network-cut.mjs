#!/usr/bin/env node
// Snapshot network cut (HARDENING #63): a lasting network failure in the
// middle of a .snapz response used to cost a whole runtime per retry. Each
// session booted its runtime (the Memory64 reservation, ~25 glue isolates),
// then downloaded the pre-open snapshot; the download failed, start()
// rejected, and the relay's reboot booted a NEW runtime while the network was
// still down: three runtimes in 26 s, and a reload right after the halt
// crashed the renderer (widgets showcase C11, headed, pin bf9d947; #55's
// pointer cage). Now a session whose page's previous boot failed with a
// network-kind cause downloads its snapshots BEFORE it boots its runtime;
// a first attempt boots as before.
//
// The lane serves nothing and writes nothing under public/: Playwright's
// context route answers the .snapz requests (the prefetch worker's and the
// Lean worker's) itself while cutting. A cut fetches the first --cut-bytes of
// the real response from the server and answers them with the full
// content-length, so the body ends short of what it announced (--cut-mode
// truncate, the default), or aborts the request with connectionreset before
// any byte (--cut-mode abort: "Failed to fetch"). Requests it does not cut
// continue untouched. In the first run (chrome-headless-shell) a truncate
// cut ended the stream CLEANLY short, with no ERR_CONTENT_LENGTH_MISMATCH:
// the gzip decoder threw "Compressed input was truncated.", which the page
// read as corrupt, so #63's network rule never fired (3 runtime starts).
// Both snapshot streams now count the compressed bytes against the
// Content-Length (the prefetch worker also against the index's transfer
// size) and name a short body "the transfer of <file> ended early: received
// <n> of <expected> bytes", a network cause; a real server's cut may instead
// error the stream ("network error"), network as before. Both cut modes
// expect the same verdicts.
//
// Scenarios (fresh context each; the buffer, default `import Mathlib`,
// makes init and mathlib pre-open loads):
//   once     cut the first .snapz response, serve the rest: the prefetch
//            warns and the checker streams the snapshot itself. PASS: ready,
//            0 deaths, exactly 1 cut, the "raw prefetch error" warning, 1
//            runtime start.
//   lasting  cut every .snapz response until the relay halts, then stop
//            cutting and reload the page. PASS before the reload: halted,
//            lastDeath bootFailed with cause kind network, more than 1 cut,
//            exactly 1 runtime start (was 3), the boot card failed; after
//            the reload: ready, 0 deaths, no renderer crash.
// Runtime starts are the `[mem] runtime-initialized` log lines (page and
// worker consoles); the lean.wasm chunk requests are printed beside them
// (a second runtime's chunks may come from the HTTP cache and not show).
// Console contract (error/warning lines and page errors): the relay's
// "QED64: the Lean checker died (bootFailed)" and "QED64: checker halted
// after repeated crashes", Chromium's "Failed to load resource: net::ERR_…"
// for the cut responses, and QED64's "[qed64] raw prefetch error: … — the
// checker will stream it instead" (the showcase's C11 allowlists the same
// shapes: bootFailure, crashBreakerTripped, networkCut); known lines of every
// page load or reload are listed as known ("Session disposed.", "Outdated RPC
// session", lean4monaco's "unsupported", the InfoView's es-module-shims
// JSON.parse warning, and the EMPTY console.error of a boot that reaches
// elaborating, paired with its own LSP -32800 reply, below); any other FAILS
// the run. Every console line is printed with the timeline; a line whose
// text is empty is printed with its arguments (JSHandle.jsonValue) and its
// source location, since msg.text() alone says nothing.
//
// The empty console.error (seen once per healthy boot in the first lane run,
// as the first "elaborating" lines arrive) is Lean's own empty RequestCancelled
// reply surfacing through monaco-vscode-api's notification service; it is
// known only when paired one-to-one with its own -32800 reply, from the
// page's main bundle (empty-console.mjs, shared with unpaired-snapshot.mjs);
// an unpaired one, or one from elsewhere, FAILS.
// Usage: node tests/adversarial/snapshot-network-cut.mjs --url http://localhost:5185/ [--scenarios once,lasting] [--cut-bytes 1000000] [--cut-mode truncate|abort] [--buffer 'import Mathlib\n\n#check (1 : Nat)\n'] [--wait-ms 300000] [--headed]
// Exit 0 = every scenario passed, 1 = one failed (2 = usage). Serve a build
// (scripts/serve-dist.mjs) and run it through the host browser lock.
import { chromium } from "playwright";
import { shownLine, shownLspErrors, trackEmptyConsole } from "./empty-console.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const USAGE = "Usage: node tests/adversarial/snapshot-network-cut.mjs --url <served build> [--scenarios once,lasting] [--cut-bytes 1000000] [--cut-mode truncate|abort] [--buffer <text>] [--wait-ms 300000] [--headed]";
if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(2); }
const url = arg("url", "http://localhost:5185/");
const SCENARIOS = arg("scenarios", "once,lasting").split(",").filter(Boolean);
const CUT_BYTES = Number(arg("cut-bytes", "1000000"));
const CUT_MODE = arg("cut-mode", "truncate");
const BUFFER = arg("buffer", "import Mathlib\n\n#check (1 : Nat)\n").replace(/\\n/g, "\n");
const WAIT = Number(arg("wait-ms", "300000"));
const HEADED = argv.includes("--headed");
if (!/^https?:\/\//.test(url) || !Number.isFinite(WAIT) || !(CUT_BYTES > 0) || !["truncate", "abort"].includes(CUT_MODE) || SCENARIOS.some((s) => !["once", "lasting"].includes(s))) {
  console.log(`snapshot-network-cut: usage: ${USAGE}`);
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALLOWED = [
  /^QED64: the Lean checker died \(bootFailed\)/,
  /^QED64: checker halted after repeated crashes/,
  /^Failed to load resource: net::ERR_(?:INTERNET_DISCONNECTED|CONTENT_LENGTH_MISMATCH|INCOMPLETE_CHUNKED_ENCODING|EMPTY_RESPONSE|CONNECTION_RESET|FAILED)$/,
  /^\[qed64\] raw prefetch error: .+ — the checker will stream it instead$/,
];
// Known lines of every page load or reload, not of this failure (the showcase allowlists the same shapes:
// N2's "Session disposed.", relayRestartOrReboot's "Outdated RPC session", lean4monaco's "unsupported"
// pageerror and the InfoView webview's es-module-shims JSON.parse warning).
const KNOWN = /^Session disposed\.$|^Outdated RPC session$|^unsupported(?:\s|$)|^TODO: catch JSON\.parse failure: +SyntaxError: Unexpected token 'e', "esms,true,/;
const PREFETCH_WARNING = /^\[qed64\] raw prefetch error: /;
const SNAPZ = /\.snapz(?:$|\?)/;

/** The first CUT_BYTES of the real response, answered with its full content-length: the body ends early. */
async function cutResponse(route) {
  if (CUT_MODE === "abort") return route.abort("connectionreset");
  const res = await fetch(route.request().url(), { headers: { "accept-encoding": "identity" } });
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  while (got < CUT_BYTES) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; }
  await reader.cancel().catch(() => {});
  const body = Buffer.concat(chunks).subarray(0, CUT_BYTES);
  const headers = Object.fromEntries([...res.headers].filter(([k]) => !/^(?:content-encoding|transfer-encoding|connection|keep-alive)$/i.test(k)));
  if (!headers["content-length"] || Number(headers["content-length"]) <= body.length) headers["content-length"] = String(body.length + 1); // never a complete body
  return route.fulfill({ status: res.status, headers, body });
}

async function run(browser, sc) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript((t) => { try { localStorage.setItem("qed64.buffer", t); } catch {} }, BUFFER);
  const t0 = Date.now();
  const at = () => Math.round(Date.now() - t0);
  let cutting = true;
  const cuts = [], snapz = [], wasmChunks = [];
  const empty = await trackEmptyConsole(context, at);
  await context.route((u) => SNAPZ.test(u.pathname), async (route) => {
    const cutThis = cutting && (sc === "lasting" || cuts.length === 0);
    snapz.push({ t: at(), url: route.request().url(), cut: cutThis });
    if (!cutThis) return route.continue();
    cuts.push({ t: at(), url: route.request().url() });
    try { await cutResponse(route); } catch (e) { console.log(`  route error (${String(e?.message ?? e).slice(0, 160)}): aborting instead`); await route.abort("connectionreset").catch(() => {}); }
  });
  context.on("request", (r) => { if (/lean\.wasm/.test(r.url())) wasmChunks.push({ t: at(), url: r.url() }); });
  const page = await context.newPage();
  const consoleLines = [], runtimeInit = [];
  let crashedAt = null;
  const onLine = (type, text) => {
    const line = { t: at(), type, text };
    consoleLines.push(line);
    if (/runtime-initialized/.test(text)) runtimeInit.push({ t: at(), text: text.slice(0, 200) });
    return line;
  };
  page.on("crash", () => { crashedAt = at(); });
  page.on("console", (m) => empty.describe(m, onLine(m.type(), m.text())));
  page.on("pageerror", (e) => onLine("pageerror", String(e?.message ?? e)));
  page.on("worker", (w) => w.on("console", (m) => empty.describe(m, onLine(`worker:${m.type()}`, m.text()))));
  const sample = () => page.evaluate(() => {
    const q = globalThis.qed64;
    const r = q?.test?.rawStatus?.() ?? q?.status?.();
    const api = q?.api?.status?.();
    const st = q?.test?.stats?.() ?? q?.relay?.stats;
    const card = document.getElementById("bootcard");
    return {
      relay: r?.relay ?? null, phase: r?.phase ?? null, session: r?.session ?? null,
      deaths: st?.workerDeaths ?? null, reboots: st?.reboots ?? null, breakerTrips: st?.breakerTrips ?? null,
      boot: api?.boot ?? null, lastDeath: api?.lastDeath ?? null,
      bootcard: card ? card.className : null, bootlabel: document.getElementById("bootlabel")?.textContent ?? null,
    };
  }).catch(() => null);
  const timeline = [];
  /** Sample until `done(s)` or the wait runs out; `phase` labels the timeline rows. */
  async function watch(phase, done) {
    const start = at();
    let last = null;
    while (at() - start < WAIT && crashedAt === null) {
      const s = await sample();
      if (s) {
        const key = `${phase}/${s.relay}/${s.phase}/${s.session}/${s.deaths}`;
        if (!timeline.length || timeline.at(-1).key !== key) timeline.push({ t: at(), key, phase, relay: s.relay, ph: s.phase, session: s.session, deaths: s.deaths });
        last = s;
        if (done(s)) return { last, at: at() };
      }
      await sleep(250);
    }
    return { last, at: null };
  }
  const row = { sc, cutMode: CUT_MODE, cutBytes: CUT_BYTES };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await empty.noteMainBundle(page, url);
    if (sc === "once") {
      const w = await watch("boot", (s) => s.phase === "ready" || s.relay === "halted");
      await sleep(2000); // stragglers
      Object.assign(row, { readyAt: w.last?.phase === "ready" ? w.at : null, last: w.last, cuts: cuts.length, runtimeStarts: runtimeInit.length });
    } else {
      const w = await watch("cut", (s) => s.relay === "halted");
      await sleep(3000); // stragglers: a request or a log after the halt
      Object.assign(row, { haltedAt: w.at, last: w.last, cuts: cuts.length, runtimeStarts: runtimeInit.length, wasmChunksBeforeReload: wasmChunks.length });
      cutting = false;
      const tReload = at();
      const initBefore = runtimeInit.length;
      if (crashedAt === null) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await empty.noteMainBundle(page, url);
        const r = await watch("reload", (s) => s.phase === "ready" || s.relay === "halted");
        Object.assign(row, { reload: { readyAfterMs: r.last?.phase === "ready" && r.at !== null ? r.at - tReload : null, last: r.last, runtimeStarts: runtimeInit.length - initBefore } });
      }
    }
  } finally {
    await empty.settle(); // the argument handles die with the context
    await context.close().catch(() => {});
  }
  const judged = consoleLines.filter((l) => /^(?:error|warning|pageerror|worker:error|worker:warning)$/.test(l.type));
  // The empty NotificationService console.error, explained by its OWN LSP RequestCancelled reply (empty-console.mjs).
  const paired = empty.paired(judged);
  const pairedEmpty = (l) => paired.has(l);
  const known = (l) => KNOWN.test(l.text) || pairedEmpty(l);
  Object.assign(row, {
    crashedAt, mainBundles: [...empty.mainBundles], snapz, cutsAt: cuts, runtimeInit, wasmChunks: wasmChunks.length, timeline, consoleLines, lspErrors: empty.lspErrors,
    prefetchWarning: judged.some((l) => PREFETCH_WARNING.test(l.text)),
    outside: judged.filter((l) => !ALLOWED.some((re) => re.test(l.text)) && !known(l)),
    known: judged.filter(known).length,
    pairedEmpty: judged.filter(pairedEmpty).length,
    shapes: ALLOWED.map((re) => ({ shape: re.source, count: judged.filter((l) => re.test(l.text)).length })),
  });
  return row;
}

function checksOf(row) {
  const L = row.last ?? {};
  const common = [
    ["no renderer crash", row.crashedAt === null],
    ["no console error/warning outside the allowlisted shapes", row.outside.length === 0],
  ];
  if (row.sc === "once") {
    return [
      ["exactly one .snapz response was cut", row.cuts === 1],
      ["the page reached ready", row.readyAt !== null],
      ["0 deaths", L.deaths === 0],
      ["the prefetch warned and the checker streamed it itself", row.prefetchWarning],
      ["exactly 1 runtime start", row.runtimeStarts === 1],
      ...common,
    ];
  }
  const R = row.reload?.last ?? {};
  return [
    ["more than one .snapz response was cut", row.cuts > 1],
    ["the relay halted", row.haltedAt !== null],
    ["lastDeath.reason is bootFailed", L.lastDeath?.reason === "bootFailed"],
    ["lastDeath.cause.kind is network", L.lastDeath?.cause?.kind === "network"],
    ["api.status().boot is {failed: true}", L.boot?.failed === true],
    ["the page's boot card shows failed", /\bfailed\b/.test(L.bootcard ?? "")],
    ["exactly 1 runtime start before the halt (was 3)", row.runtimeStarts === 1],
    ["after the network returns, a reload reaches ready", row.reload?.readyAfterMs != null],
    ["0 deaths after the reload", R.deaths === 0],
    ...common,
  ];
}

const browser = await chromium.launch({ headless: !HEADED, args: ["--enable-features=SharedArrayBuffer"] });
const results = [];
try {
  for (const sc of SCENARIOS) {
    const row = await run(browser, sc);
    const checks = checksOf(row);
    const ok = checks.every(([, pass]) => pass);
    results.push(ok);
    console.log(`== ${sc} (cut ${row.cutMode}, ${row.cutBytes} bytes)`);
    const shown = shownLine;
    for (const l of row.consoleLines) console.log(`  console [${(l.t / 1000).toFixed(1)}s] ${l.type}: ${shown(l)}`);
    console.log(`  LSP error replies (tap): ${shownLspErrors(row.lspErrors)}`);
    console.log(`  .snapz requests: ${row.snapz.map((x) => `${(x.t / 1000).toFixed(1)}s ${x.url.replace(/^.*\//, "")}${x.cut ? " CUT" : ""}`).join(", ") || "none"}`);
    console.log(`  runtime starts: ${row.runtimeInit.map((x) => `${(x.t / 1000).toFixed(1)}s`).join(", ") || "none"}; lean.wasm requests: ${row.wasmChunks}`);
    console.log(`  relay over time: ${row.timeline.map((x) => `${(x.t / 1000).toFixed(1)}s [${x.phase}] ${x.relay}/${x.ph} ${x.session} deaths=${x.deaths}`).join(" → ")}`);
    if (sc === "lasting") {
      console.log(`  halted at: ${row.haltedAt === null ? "never" : `${(row.haltedAt / 1000).toFixed(1)} s`}; lastDeath: ${JSON.stringify(row.last?.lastDeath ?? null)}`);
      console.log(`  boot card: ${JSON.stringify(row.last?.bootcard ?? null)} / ${JSON.stringify(row.last?.bootlabel ?? null)}`);
      console.log(`  reload: ${JSON.stringify(row.reload ?? null)}`);
    } else console.log(`  ready at: ${row.readyAt === null ? "never" : `${(row.readyAt / 1000).toFixed(1)} s`}; deaths ${row.last?.deaths ?? "?"}`);
    console.log(`  allowlisted shapes: ${row.shapes.map((x) => `${x.count}× /${x.shape}/`).join(", ")}${row.known ? `; known lines (not judged): ${row.known}, of which empty console.errors from ${row.mainBundles.join(", ") || "(no main bundle seen)"} paired one-to-one with a -32800 reply: ${row.pairedEmpty} (replies: ${row.lspErrors.filter((e) => e.code === -32800).length})` : ""}`);
    for (const l of row.outside) console.log(`  OUTSIDE ALLOWLIST [${(l.t / 1000).toFixed(1)}s] ${l.type}: ${shown(l)}`);
    for (const [what, pass] of checks) console.log(`  ${pass ? "ok  " : "FAIL"} ${what}`);
    console.log(`  RESULT ${sc} :: ${JSON.stringify({ ...row, consoleLines: row.consoleLines.length })}`);
    console.log(`${ok ? "PASS" : "FAIL"} ${sc} (${checks.filter(([, pass]) => pass).length}/${checks.length} checks)`);
    await sleep(5000);
  }
} finally { await browser.close().catch(() => {}); }
console.log(`snapshot-network-cut: ${results.filter(Boolean).length}/${results.length} pass`);
process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1);
