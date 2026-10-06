#!/usr/bin/env node
// Unpaired snapshot (HARDENING #62): a page whose snapshot index names another
// runtime (entries `runtime: wasm64-0000000000000000`) used to boot the 2 GiB
// Memory64 runtime, download and inflate the whole snapshot into the cache,
// and only then be refused by the worker (SNAPSHOT_UNPAIRED); the relay's
// three bootFailed retries paid that three times, and on a loaded host the
// renderer crashed during the second start (widgets showcase C9 on bf9d947,
// 2026-10-06). The page now refuses the pairing before the worker boots and
// before a byte of the snapshot is fetched.
//
// The lane serves nothing and writes nothing under public/: it intercepts the
// snapshot index request (served or `?snapshots=<dir>` overlay, any
// `…/index.json` outside /profiles/) with Playwright's route, fetches the real
// index and answers a copy whose every entry's `runtime` is rewritten to
// --runtime. The buffer (default `import Mathlib`) makes init and mathlib
// pre-open loads, so the refusal is the session start's.
//
// Records: every request for a .snapz (must be none), for a lean.wasm chunk
// and the worker's `[mem] runtime-initialized` log (must be none: the runtime
// never starts), the relay state over time (must reach halted), the time to
// halt, deaths, api.status().boot and lastDeath (the v1 projection the
// showcase's C9 asserts: boot {failed: true} with a non-empty message;
// lastDeath.reason "bootFailed", cause.kind "unpaired"), the page's own boot
// card (class "failed"), a renderer crash (must be none), and every console
// line and page error (all printed). Console contract: error/warning lines
// and page errors must match one of the two shapes the showcase allowlists
// for a boot failure, "QED64: the Lean checker died (bootFailed)" (the
// relay's orphaned-request reply, logged by the language client) and
// "Error: ?snapshots=<dir>: …" (main()'s catch); any other is listed and
// FAILS the run, except "Session disposed." (the showcase's known N2: the
// heap meter's telemetry request rejected by a disposal), listed as known.
// log/info/debug lines are printed, not judged.
// Usage: node tests/adversarial/unpaired-snapshot.mjs --url http://localhost:5185/ [--runtime wasm64-0000000000000000] [--buffer 'import Mathlib\n\n#check (1 : Nat)\n'] [--wait-ms 90000] [--headed]
// Exit 0 = PASS, 1 = FAIL (2 = usage). Run it through the host browser lock.
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node tests/adversarial/unpaired-snapshot.mjs --url <served build> [--runtime <buildId>] [--buffer <text>] [--wait-ms 90000] [--headed]");
  process.exit(2);
}
const url = arg("url", "http://localhost:5185/");
const FAKE = arg("runtime", "wasm64-0000000000000000");
const BUFFER = arg("buffer", "import Mathlib\n\n#check (1 : Nat)\n").replace(/\\n/g, "\n");
const WAIT = Number(arg("wait-ms", "90000"));
const HEADED = argv.includes("--headed");
if (!/^https?:\/\//.test(url) || !Number.isFinite(WAIT) || !/^wasm64-[0-9a-f]{16}$/.test(FAKE)) {
  console.log("unpaired-snapshot: usage: --url must be http(s), --wait-ms a number, --runtime wasm64-<16 hex>");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALLOWED = [/^QED64: the Lean checker died \(bootFailed\)/, /^Error: \?snapshots=(?:snapshots\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}: /];
const KNOWN_N2 = /^Session disposed\.$/;

const browser = await chromium.launch({ headless: !HEADED, args: ["--enable-features=SharedArrayBuffer"] });
let row;
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript((t) => { try { localStorage.setItem("qed64.buffer", t); } catch {} }, BUFFER);
  const t0 = Date.now();
  const at = () => Math.round(Date.now() - t0);
  const intercepted = [];
  await context.route((u) => /\/index\.json$/.test(u.pathname) && !u.pathname.startsWith("/profiles/"), async (route) => {
    const res = await route.fetch();
    let body = await res.text();
    let rewritten = 0;
    try {
      const idx = JSON.parse(body);
      if (Array.isArray(idx?.snapshots)) {
        for (const e of idx.snapshots) { e.runtime = FAKE; rewritten += 1; }
        body = JSON.stringify(idx);
      }
    } catch { /* not JSON: passed through unchanged */ }
    intercepted.push({ t: at(), url: route.request().url(), status: res.status(), rewritten });
    // The body is the decoded text: drop the transfer framing the server sent for its own bytes.
    const headers = Object.fromEntries(Object.entries(res.headers()).filter(([k]) => !/^(?:content-encoding|content-length|transfer-encoding)$/i.test(k)));
    await route.fulfill({ status: res.status(), headers: { ...headers, "content-type": "application/json" }, body });
  });
  const requests = { snapz: [], wasmChunks: [], runtimeManifests: [] };
  context.on("request", (r) => {
    const u = r.url();
    if (/\.snapz(?:$|\?)/.test(u)) requests.snapz.push({ t: at(), url: u });
    else if (/lean\.wasm/.test(u)) requests.wasmChunks.push({ t: at(), url: u });
    else if (/runtime-manifest/.test(u)) requests.runtimeManifests.push({ t: at(), url: u });
  });
  const page = await context.newPage();
  const consoleLines = [];
  const runtimeInit = [];
  let crashedAt = null;
  page.on("crash", () => { crashedAt = at(); });
  page.on("console", (m) => {
    const text = m.text();
    consoleLines.push({ t: at(), type: m.type(), text });
    if (/runtime-initialized/.test(text)) runtimeInit.push({ t: at(), text: text.slice(0, 200) });
  });
  page.on("pageerror", (e) => consoleLines.push({ t: at(), type: "pageerror", text: String(e?.message ?? e) }));
  page.on("worker", (w) => w.on("console", (m) => {
    const text = m.text();
    consoleLines.push({ t: at(), type: `worker:${m.type()}`, text });
    if (/runtime-initialized/.test(text)) runtimeInit.push({ t: at(), text: text.slice(0, 200) });
  }));
  await page.goto(url, { waitUntil: "domcontentloaded" });
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
  let last = null, haltedAt = null;
  while (at() < WAIT && crashedAt === null) {
    const s = await sample();
    if (s) {
      const key = `${s.relay}/${s.phase}/${s.session}/${s.deaths}`;
      if (!timeline.length || timeline.at(-1).key !== key) timeline.push({ t: at(), key, relay: s.relay, phase: s.phase, session: s.session, deaths: s.deaths });
      last = s;
      if (s.relay === "halted" && haltedAt === null) haltedAt = at();
    }
    if (haltedAt !== null && at() - haltedAt > 3000) break; // stragglers: a request or a log after the halt
    await sleep(250);
  }
  await context.close().catch(() => {});
  const judged = consoleLines.filter((l) => /^(?:error|warning|pageerror|worker:error|worker:warning)$/.test(l.type));
  const outside = judged.filter((l) => !ALLOWED.some((re) => re.test(l.text)) && !KNOWN_N2.test(l.text));
  const knownN2 = judged.filter((l) => KNOWN_N2.test(l.text));
  row = { url, fakeRuntime: FAKE, intercepted, requests, runtimeInit, crashedAt, haltedAt, timeline, last, consoleLines, outside, knownN2 };
} finally { await browser.close().catch(() => {}); }

const L = row.last ?? {};
const checks = [
  ["the snapshot index was intercepted and rewritten", row.intercepted.some((i) => i.rewritten > 0)],
  ["no renderer crash", row.crashedAt === null],
  ["no .snapz request", row.requests.snapz.length === 0],
  ["no lean.wasm chunk request", row.requests.wasmChunks.length === 0],
  ["no runtime-initialized log", row.runtimeInit.length === 0],
  ["the relay halted", row.haltedAt !== null],
  ["api.status().boot is {failed: true} with a message", L.boot?.failed === true && typeof L.boot?.message === "string" && L.boot.message.length > 0],
  ["lastDeath.reason is bootFailed", L.lastDeath?.reason === "bootFailed"],
  ["lastDeath.cause.kind is unpaired", L.lastDeath?.cause?.kind === "unpaired"],
  ["the page's boot card shows failed", /\bfailed\b/.test(L.bootcard ?? "")],
  ["no console error/warning outside the allowlisted shapes", row.outside.length === 0],
];
for (const l of row.consoleLines) console.log(`  console [${(l.t / 1000).toFixed(1)}s] ${l.type}: ${l.text.split("\n")[0].slice(0, 300)}`);
console.log(`  index intercepted: ${JSON.stringify(row.intercepted)}`);
console.log(`  requests: ${row.requests.snapz.length} .snapz, ${row.requests.wasmChunks.length} lean.wasm, ${row.requests.runtimeManifests.length} runtime manifest(s)`);
console.log(`  relay over time: ${row.timeline.map((x) => `${(x.t / 1000).toFixed(1)}s ${x.relay}/${x.phase} ${x.session} deaths=${x.deaths}`).join(" → ")}`);
console.log(`  halted at: ${row.haltedAt === null ? "never" : `${(row.haltedAt / 1000).toFixed(1)} s`}; deaths ${L.deaths ?? "?"}, reboots ${L.reboots ?? "?"}, breaker trips ${L.breakerTrips ?? "?"}`);
console.log(`  boot: ${JSON.stringify(L.boot ?? null)}`);
console.log(`  lastDeath: ${JSON.stringify(L.lastDeath ?? null)}`);
console.log(`  boot card: ${JSON.stringify(L.bootcard ?? null)} / ${JSON.stringify(L.bootlabel ?? null)}`);
if (row.knownN2.length) console.log(`  known N2 lines (not judged): ${row.knownN2.length}`);
for (const l of row.outside) console.log(`  OUTSIDE ALLOWLIST [${(l.t / 1000).toFixed(1)}s] ${l.type}: ${l.text.split("\n")[0].slice(0, 300)}`);
for (const [what, ok] of checks) console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
console.log(`  RESULT :: ${JSON.stringify({ ...row, consoleLines: row.consoleLines.length })}`);
const pass = checks.every(([, ok]) => ok);
console.log(`unpaired-snapshot: ${pass ? "PASS" : "FAIL"} (${checks.filter(([, ok]) => ok).length}/${checks.length} checks)`);
process.exit(pass ? 0 : 1);
