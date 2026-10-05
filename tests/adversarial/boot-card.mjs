#!/usr/bin/env node
// Boot card (S1, 2026-10-03; HARDENING #54): the first-visit card ("Loading
// Lean 4 + Mathlib into your browser") must explain the boot for as long as
// the boot runs. Each scenario is a fresh browser and context (empty HTTP
// cache and OPFS):
//
//   slow-link       the page behind a link-shaping proxy (--mbps, --rtt). Every
//                   second it records the card (shown, failed, active stage,
//                   label, numbers) and the pill. Verdict: the card is shown at
//                   every sample until the checker is ready, and the pill
//                   never reads idle before then. Reported: when each stage
//                   started, the longest stretches without numbers and without
//                   any visible change on the card, the bytes the proxy
//                   carried (and how many of them after the card went), and
//                   the browser's RSS per process type at ready.
//   check-fallback  an Init-only restored buffer that elaborates for 60 s
//                   (`#eval IO.sleep`). Verdict: the card goes about
//                   --fallback-ms after the relay starts serving, while the
//                   phase is still `elaborating`, and the page reaches `ready`.
//   restart-during-boot  the same buffer; while the card shows "Check", the
//                   page API restarts with Mathlib (what an embedder or "Load
//                   exact imports" does). Verdict: the card stays up for the
//                   whole replacement boot and its checklist shows that boot
//                   (never "Check" before the replacement elaborates), then
//                   the card goes about --fallback-ms after the replacement
//                   serves, still elaborating, and the page reaches `ready`.
//
// CDP network emulation does not reach the Lean worker's downloads (a
// dedicated worker's session answers Network.emulateNetworkConditions with
// "Not supported"), so the link is shaped below the browser: a TCP proxy whose
// downlink is ONE token bucket shared by every connection, plus RTT/2 per
// direction and one RTT per new connection. Headers pass through untouched
// (COOP/COEP intact).
//
// Usage: node tests/adversarial/boot-card.mjs [--url http://localhost:5185/]
//          [--scenario slow-link|check-fallback|restart-during-boot|all] [--mbps 16] [--rtt 40]
//          [--fallback-ms 30000] [--budget-s 1500] [--run-dir <dir>]
// Serve the production build (`npm run build:site && npm run preview:prod`)
// and run this through the host's browser lock. Exit 0 = every verdict
// passed, 1 = a verdict failed, 3 = infrastructure (unreachable, never booted).
import { execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright";
import { arg, fetchJson, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

const url = arg("url", "http://localhost:5185/");
const SCENARIO = arg("scenario", "all");
const MBPS = Number(arg("mbps", "16"));
const RTT = Number(arg("rtt", "40"));
const FALLBACK_MS = Number(arg("fallback-ms", "30000"));
const BUDGET_MS = Number(arg("budget-s", "1500")) * 1000;
const target = resolveTarget(url);
const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`boot-card: refused — ${e.message}`); process.exit(3); });
const dir = runDir(manifest.buildId ?? "unknown", target.mode);
teeLog(dir, "boot-card.log");
console.log(`boot-card: ${url} → ${manifest.buildId}; scenario ${SCENARIO}; reports in ${path.relative(root, dir)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the link: one shared downlink bucket, RTT per direction ----------
function startProxy(upstream, mbps, rttMs) {
  const bps = (mbps * 1e6) / 8;
  const link = { freeAt: 0, down: 0, up: 0, connections: 0 };
  const HIGH = 2 * 1024 * 1024; // per-connection queue before backpressure
  const pipe = (src, dst, shaped) => {
    let queued = 0;
    let pending = 0;
    let ended = false;
    const finish = () => { if (ended && pending === 0 && !dst.destroyed) dst.end(); };
    src.on("data", (chunk) => {
      for (let o = 0; o < chunk.length; o += 65536) {
        const part = chunk.subarray(o, Math.min(chunk.length, o + 65536));
        const now = Date.now();
        let at = now + rttMs / 2;
        if (shaped) {
          at = Math.max(at, link.freeAt) + (part.length / bps) * 1000;
          link.freeAt = at;
          link.down += part.length;
        } else link.up += part.length;
        queued += part.length;
        pending += 1;
        if (queued > HIGH) src.pause();
        setTimeout(() => {
          if (!dst.destroyed) dst.write(part);
          queued -= part.length;
          pending -= 1;
          if (queued <= HIGH / 2 && src.isPaused()) src.resume();
          finish();
        }, Math.max(0, at - now));
      }
    });
    src.on("end", () => { ended = true; finish(); });
    src.on("error", () => dst.destroy());
    src.on("close", () => { if (pending === 0) dst.destroy(); });
  };
  const server = net.createServer((client) => {
    link.connections += 1;
    client.pause();
    setTimeout(() => { // the handshake's round trip
      const up = net.connect(upstream.port, upstream.host, () => { pipe(client, up, false); pipe(up, client, true); client.resume(); });
      up.on("error", () => client.destroy());
      client.on("error", () => up.destroy());
    }, rttMs);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, link, close: () => server.close() })));
}

// ---------- the browser's RSS per process type (this run's tree only) ----------
function rssByType(rootPid) {
  try {
    const rows = execSync("ps -axo pid=,ppid=,rss=,command=", { maxBuffer: 1 << 26 }).toString().trim().split("\n").map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m ? { pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, cmd: m[4] } : null;
    }).filter(Boolean);
    const mine = new Set([rootPid]);
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) { mine.add(r.pid); grew = true; } }
    const by = {};
    for (const r of rows) {
      if (!mine.has(r.pid) || r.pid === rootPid || !/chrom/i.test(r.cmd)) continue;
      const t = (r.cmd.match(/--type=([\w-]+)/) || [])[1] || "browser";
      (by[t] ??= []).push(r.rss);
    }
    const gib = (n) => +(n / 1073741824).toFixed(2);
    const out = {};
    for (const [t, l] of Object.entries(by)) out[t] = l.length === 1 ? gib(l[0]) : l.map(gib);
    out.totalGiB = gib(Object.values(by).flat().reduce((a, b) => a + b, 0));
    return out;
  } catch (e) { return { error: String(e).slice(0, 120) }; }
}

// ---------- what the visitor sees, once per second ----------
const SAMPLE = () => {
  const $ = (id) => document.getElementById(id);
  const boot = $("boot");
  let s = null;
  try { s = globalThis.qed64?.status?.() ?? null; } catch { /* booting */ }
  return {
    shown: !!boot && !boot.classList.contains("done"),
    failed: !!$("bootcard")?.classList.contains("failed"),
    stage: document.querySelector("#bootstages li.active")?.dataset.stage ?? null,
    label: $("bootlabel")?.textContent ?? "",
    nums: $("bootnums")?.textContent ?? "",
    fill: $("bootfill")?.style.width ?? "",
    pill: $("ptext")?.textContent ?? "",
    pillTime: $("ptime")?.textContent ?? "",
    pillBusy: !!$("pill")?.classList.contains("busy"),
    phase: s?.phase ?? null,
    relay: s?.relay ?? null,
  };
};

async function visit({ name, pageUrl, init, link, untilMs, stopWhen, act }) {
  const browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
  const t0 = Date.now();
  const samples = [];
  let crashed = null;
  let rssAtReady = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (init) await context.addInitScript(init.fn, init.arg);
    const page = await context.newPage();
    page.on("crash", () => { crashed = Date.now() - t0; });
    const log = [];
    page.on("console", (m) => { if (/^\[qed64\]|raw prefetch/.test(m.text())) log.push(`[${((Date.now() - t0) / 1000).toFixed(1)}] ${m.text().slice(0, 200)}`); });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    let last = "";
    let lastLine = 0;
    let shotAtGone = false;
    for (;;) {
      const t = Date.now() - t0;
      if (crashed !== null || t > untilMs) break;
      const s = await Promise.race([page.evaluate(SAMPLE).catch(() => null), sleep(5000).then(() => null)]);
      if (s) {
        s.t = t;
        s.down = link?.down ?? null;
        samples.push(s);
        const key = `${s.shown}|${s.failed}|${s.stage}|${s.phase}|${s.relay}|${s.pillBusy}`;
        if (key !== last || t - lastLine >= 15000) {
          console.log(`  [${name} ${(t / 1000).toFixed(0).padStart(4)} s] card=${s.shown ? (s.failed ? "FAILED" : s.stage ?? "-") : "gone"} label=${JSON.stringify(s.label.slice(0, 60))} nums=${JSON.stringify(s.nums)} pill=${s.pillBusy ? "busy" : "IDLE"}:${JSON.stringify(s.pill.slice(0, 40))}${s.pillTime} phase=${s.phase}/${s.relay}${link ? ` link=${(link.down / 1e6).toFixed(0)} MB` : ""}`);
          last = key;
          lastLine = t;
        }
        if (!s.shown && !shotAtGone) {
          shotAtGone = true;
          await page.screenshot({ path: path.join(dir, `${name}-card-gone.png`) }).catch(() => {});
        }
        if ((s.phase === "ready" || s.phase === "headerRefused") && rssAtReady === null) {
          await page.screenshot({ path: path.join(dir, `${name}-ready.png`) }).catch(() => {});
          await sleep(8000);
          rssAtReady = rssByType(process.pid);
        }
        if (act) await act(s, page);
        if (stopWhen(s, samples)) break;
      }
      if (samples.length && samples.length % 60 === 0) await page.screenshot({ path: path.join(dir, `${name}-${(t / 1000) | 0}s.png`) }).catch(() => {});
      await sleep(1000);
    }
    fs.writeFileSync(path.join(dir, `${name}-console.log`), log.join("\n") + "\n");
  } finally {
    await browser.close().catch(() => {});
  }
  fs.writeFileSync(path.join(dir, `${name}-samples.json`), JSON.stringify(samples));
  return { samples, crashed, rssAtReady };
}

const first = (samples, f) => samples.find(f)?.t ?? null;
/** Longest run of consecutive samples (between `from` and `to`) for which `f` holds, in ms. */
function longest(samples, from, to, f) {
  let best = 0;
  let start = null;
  for (const s of samples) {
    if (s.t < from || s.t > to) continue;
    if (f(s)) { if (start === null) start = s.t; best = Math.max(best, s.t - start); } else start = null;
  }
  return best;
}
/** Longest time (between `from` and `to`) the SHOWN card's text and bar did not change, in ms. */
function longestStill(samples, from, to) {
  let best = 0;
  let since = null;
  let prev = null;
  for (const s of samples) {
    if (s.t < from || s.t > to) continue;
    if (!s.shown) { prev = null; continue; }
    const k = `${s.stage}|${s.label}|${s.nums}|${s.fill}`;
    if (k !== prev) { prev = k; since = s.t; } else best = Math.max(best, s.t - since);
  }
  return best;
}

const results = [];
let infra = false;
function verdict(name, ok, detail, extra = {}) {
  results.push({ name, ok, detail, ...extra });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

try {
  // ---------- scenario: a cold first visit over a slow link ----------
  if (SCENARIO === "all" || SCENARIO === "slow-link") {
    const u = new URL(url);
    const proxy = await startProxy({ host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname, port: Number(u.port) || 80 }, MBPS, RTT);
    const pageUrl = `http://127.0.0.1:${proxy.port}${u.pathname}${u.search}`; // the proxy listens on IPv4 loopback only
    console.log(`slow-link: ${pageUrl} through a ${MBPS} Mbit/s, ${RTT} ms link`);
    let r;
    try {
      r = await visit({ name: "slow-link", pageUrl, link: proxy.link, untilMs: BUDGET_MS, stopWhen: (s) => (s.phase === "ready" || s.phase === "headerRefused") && !s.shown });
    } finally { proxy.close(); }
    const { samples, crashed, rssAtReady } = r;
    const readyAt = first(samples, (s) => s.phase === "ready" || s.phase === "headerRefused");
    const servingAt = first(samples, (s) => s.relay === "serving");
    const goneAt = first(samples, (s) => !s.shown);
    const end = samples.at(-1);
    const downAtGone = goneAt === null ? null : samples.find((s) => s.t === goneAt).down;
    const stages = {};
    for (const s of samples) if (s.stage && stages[s.stage] === undefined) stages[s.stage] = s.t;
    const facts = {
      mbps: MBPS, rttMs: RTT, readyAt, servingAt, goneAt, crashed,
      stageStartMs: stages,
      downloadedMB: +(proxy.link.down / 1e6).toFixed(1),
      downloadedAfterCardGoneMB: downAtGone === null ? null : +((end.down - downAtGone) / 1e6).toFixed(1),
      // "64 MB / 1.05 GB · 1.9 MB/s · ~2 min left", "12 / 4192 modules", or "" (an indeterminate bar)
      longestWithoutNumbersMs: longest(samples, 0, readyAt ?? end.t, (s) => s.shown && !/ \/ /.test(s.nums)),
      longestStillCardMs: longestStill(samples, 0, readyAt ?? end.t),
      // per checklist step: the runtime download used to move only at 16 MiB chunk boundaries
      longestStillByStageMs: Object.fromEntries(Object.keys(stages).map((st) => [st, longestStill(samples.filter((s) => s.stage === st), 0, readyAt ?? end.t)])),
      rssAtReady,
    };
    console.log(`slow-link facts: ${JSON.stringify(facts)}`);
    if (readyAt === null) {
      infra = crashed === null;
      verdict("slow-link", false, `never ready within ${BUDGET_MS / 1000} s (crashed=${crashed}, last phase ${end?.phase}/${end?.relay})`, facts);
    } else {
      const hiddenEarly = samples.find((s) => !s.shown && s.t < readyAt);
      const idleEarly = samples.find((s) => !s.pillBusy && s.t < readyAt && s.pill !== "");
      const goneLate = goneAt === null || goneAt > readyAt + 2000;
      // While a snapshot downloads, the checklist's active step is the download.
      const wrongStep = samples.find((s) => s.shown && /^preparing the \w+ environment/.test(s.label) && s.stage !== "env");
      const problems = [];
      if (wrongStep) problems.push(`at ${(wrongStep.t / 1000).toFixed(0)} s the card says ${JSON.stringify(wrongStep.label)} but its active step is '${wrongStep.stage}'`);
      if (hiddenEarly) problems.push(`card hidden at ${(hiddenEarly.t / 1000).toFixed(0)} s, ${((readyAt - hiddenEarly.t) / 1000).toFixed(0)} s before ready (phase ${hiddenEarly.phase}/${hiddenEarly.relay}, ${facts.downloadedAfterCardGoneMB} MB still to download)`);
      if (idleEarly) problems.push(`pill idle at ${(idleEarly.t / 1000).toFixed(0)} s before ready: ${JSON.stringify(idleEarly.pill)}`);
      if (goneLate) problems.push(`card still shown ${goneAt === null ? "at the end" : `${goneAt - readyAt} ms after ready`}`);
      verdict("slow-link", problems.length === 0, problems.length ? problems.join("; ") : `card shown for all ${samples.filter((s) => s.t < readyAt).length} samples until ready at ${(readyAt / 1000).toFixed(0)} s, gone at ${(goneAt / 1000).toFixed(0)} s; pill busy throughout`, facts);
    }
  }

  // ---------- scenario: the check fallback (a restored buffer that keeps Lean busy) ----------
  if (SCENARIO === "all" || SCENARIO === "check-fallback") {
    if (SCENARIO === "all") await sleep(30000); // let the previous renderer's memory drain (HARDENING #26)
    const DOC = "-- boot-card check-fallback: elaborates for 60 s\n#eval (IO.sleep 60000 : IO Unit)\n";
    const { samples, crashed } = await visit({
      name: "check-fallback",
      pageUrl: url,
      init: { fn: (text) => { try { window.localStorage.setItem("qed64.buffer", text); } catch { /* storage unavailable */ } }, arg: DOC },
      untilMs: Math.min(BUDGET_MS, 600000),
      stopWhen: (s, all) => s.phase === "ready" && all.some((x) => !x.shown),
    });
    const servingAt = first(samples, (s) => s.relay === "serving");
    const goneAt = first(samples, (s) => !s.shown);
    const readyAt = first(samples, (s) => s.phase === "ready");
    const atGone = goneAt === null ? null : samples.find((s) => s.t === goneAt);
    const facts = { servingAt, goneAt, readyAt, crashed, fallbackMs: FALLBACK_MS, phaseAtGone: atGone?.phase ?? null, pillAtGone: atGone ? `${atGone.pill}${atGone.pillTime}` : null };
    console.log(`check-fallback facts: ${JSON.stringify(facts)}`);
    if (servingAt === null) {
      infra = crashed === null;
      verdict("check-fallback", false, `the relay never served (crashed=${crashed})`, facts);
    } else {
      const after = goneAt === null ? null : goneAt - servingAt;
      const ok = after !== null && Math.abs(after - FALLBACK_MS) <= 3000 && atGone.phase === "elaborating" && readyAt !== null && readyAt > goneAt;
      verdict("check-fallback", ok, after === null ? "the card never went" : `card gone ${(after / 1000).toFixed(1)} s after serving (expected ~${FALLBACK_MS / 1000} s) in phase ${atGone.phase}; ready at ${readyAt === null ? "never" : `${(readyAt / 1000).toFixed(0)} s`}`, facts);
    }
  }

  // ---------- scenario: a deliberate restart while the card shows "Check" ----------
  if (SCENARIO === "all" || SCENARIO === "restart-during-boot") {
    if (SCENARIO === "all") await sleep(30000);
    const DOC = "-- boot-card restart-during-boot: elaborates for 60 s\n#eval (IO.sleep 60000 : IO Unit)\n";
    let restartedAt = null;
    let answer = null;
    const { samples, crashed } = await visit({
      name: "restart-during-boot",
      pageUrl: url,
      init: { fn: (text) => { try { window.localStorage.setItem("qed64.buffer", text); } catch { /* storage unavailable */ } }, arg: DOC },
      untilMs: Math.min(BUDGET_MS, 900000),
      act: async (s, page) => {
        if (restartedAt !== null || !s.shown || s.relay !== "serving" || s.phase !== "elaborating" || s.stage !== "check") return;
        restartedAt = s.t;
        answer = await page.evaluate(() => globalThis.qed64.api.restart({ snapshots: ["init", "mathlib"] })).catch((e) => ({ error: String(e).slice(0, 200) }));
        console.log(`  [restart-during-boot ${(s.t / 1000).toFixed(0).padStart(4)} s] api.restart({snapshots: ["init", "mathlib"]}) → ${JSON.stringify(answer)}`);
      },
      stopWhen: (s, all) => restartedAt !== null && s.phase === "ready" && all.some((x) => !x.shown),
    });
    const after = restartedAt === null ? [] : samples.filter((s) => s.t > restartedAt);
    const replacementServingAt = first(after, (s) => s.relay === "serving");
    const until = replacementServingAt ?? Infinity;
    const boot = after.filter((s) => s.t < until);
    const goneAt = first(samples, (s) => !s.shown);
    const readyAt = first(after, (s) => s.phase === "ready");
    const atGone = goneAt === null ? null : samples.find((s) => s.t === goneAt);
    const stagesSeen = [...new Set(boot.filter((s) => s.shown).map((s) => s.stage))];
    const facts = { restartedAt, answer, replacementServingAt, goneAt, readyAt, crashed, stagesSeen, phaseAtGone: atGone?.phase ?? null, fallbackMs: FALLBACK_MS };
    console.log(`restart-during-boot facts: ${JSON.stringify(facts)}`);
    if (restartedAt === null || replacementServingAt === null) {
      infra = crashed === null && restartedAt === null;
      verdict("restart-during-boot", false, restartedAt === null ? `the card never showed "Check" while serving (crashed=${crashed})` : `the replacement never served (crashed=${crashed})`, facts);
    } else {
      const problems = [];
      if (answer?.accepted !== true) problems.push(`restart answered ${JSON.stringify(answer)}`);
      const hidden = boot.find((s) => !s.shown);
      if (hidden) problems.push(`card gone at ${(hidden.t / 1000).toFixed(0)} s while the replacement was still booting (${hidden.phase}/${hidden.relay})`);
      const stuck = boot.find((s) => s.shown && s.stage === "check" && s.phase !== "elaborating");
      if (stuck) problems.push(`at ${(stuck.t / 1000).toFixed(0)} s the checklist shows "Check" while the replacement boots: ${JSON.stringify(stuck.label.slice(0, 60))}`);
      if (!stagesSeen.some((st) => st === "runtime" || st === "env" || st === "load")) problems.push(`the checklist never showed the replacement's boot (steps seen: ${stagesSeen.join(", ") || "none"})`);
      const gap = goneAt === null ? null : goneAt - replacementServingAt;
      if (gap === null || Math.abs(gap - FALLBACK_MS) > 3000 || atGone.phase !== "elaborating") problems.push(gap === null ? "the card never went" : `card gone ${(gap / 1000).toFixed(1)} s after the replacement served (expected ~${FALLBACK_MS / 1000} s) in phase ${atGone.phase}`);
      if (readyAt === null) problems.push("never ready after the restart");
      verdict("restart-during-boot", problems.length === 0, problems.length ? problems.join("; ") : `restart at ${(restartedAt / 1000).toFixed(0)} s; card up through the replacement's boot (steps ${stagesSeen.join(" → ")}); gone ${(gap / 1000).toFixed(1)} s after it served, still elaborating; ready at ${(readyAt / 1000).toFixed(0)} s`, facts);
    }
  }
} finally {
  fs.writeFileSync(path.join(dir, "boot-card-report.json"), JSON.stringify({ url, buildId: manifest.buildId, results }, null, 2));
}
console.log(`boot-card: ${results.filter((r) => r.ok).length}/${results.length} passed; report ${path.relative(root, path.join(dir, "boot-card-report.json"))}`);
process.exit(infra && results.every((r) => !r.ok) ? 3 : results.every((r) => r.ok) ? 0 : 1);
