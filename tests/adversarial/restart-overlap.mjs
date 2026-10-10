#!/usr/bin/env node
// Restart overlap (HARDENING #68; #55's tolerance, narrowed to named
// predecessors): a document replaces its own runtime — an embedder's or the
// stall card's api.restart(), a wedged or heartbeat-loss reboot — and the new
// runtime allocates its memory and spawns its pthread pool while Workers of
// the runtime it replaced may still be alive in the same renderer. Each run is
// a fresh browser: boot a Mathlib document to `ready`, put the predecessor in
// --mode's state and replace it, then follow the replacement to `ready` or to
// a renderer crash. A crash is DATA here (counted, timed and classified), not
// a lane failure; the lane fails on a run that did not complete or whose arm
// did not hold, or, under --rule own, on a Worker of a named predecessor alive
// at the allocation or between the pool spawn and `runtime-initialized`.
//
// Modes (the predecessor's state when it is replaced):
//   idle         ready and settled, then api.restart() (the card and embedder path)
//   busy         2 s into an edit whose `#eval` loop runs far longer, api.restart() (C21's
//                shape); the text is reverted in the same turn, so the replacement
//                elaborates what idle's does and T0 → ready stays comparable
//   wedged       the runtime thread's mailbox disabled plus an edit (liveness-faults'
//                wedge-recovery): a 'wedged' death reboot, the lean.worker still responsive
//   frozen       the lean.worker's JS thread blocked by a 30 s loop: a heartbeat-loss
//                reboot whose predecessor is truly frozen
//   frozen-card  the same freeze, then api.restart() 2 s in, before the heartbeat verdict
// T0 is the page's disposal of the predecessor: the api.restart() call, or (wedged, frozen)
// the earliest of the trace sample in which the predecessor's wanted lock is first gone, the
// first /workers/lean.worker.js request and the first lean.worker created after the action
// (t0By names the source, t0Candidates keeps all three relative to T0).
//
// Instruments (wall clock; the page and the harness read the same host clock):
//   - a lock tracer (init script, top frame only: the lock manager is the origin's, so
//     the host page of --embed sees the frame's locks): navigator.locks.query() every
//     25 ms, kept run-length — a change opens an entry {wall, until, n, alive: {runtime
//     id: alive locks held or pending}, wanted: [ids]} — in a capped ring AND pushed to
//     the harness at each change, so a renderer crash keeps the trace up to it;
//   - a Worker.prototype.postMessage wrapper (every frame) recording each `boot`'s
//     instance (id, waitMs, predecessors); under --rule tolerance it deletes
//     instance.predecessors, which on a #68 build is an old page: the control arm and
//     the back-compat check in one;
//   - the worker's `[boot] waited …` line; the allocation (the first blob request of
//     type "other" after the new /workers/lean.worker.js request, its blob URL not seen
//     before T0: the glue's importScripts, right after the memory) and the pool spawn (the
//     biggest burst of "script" requests for one such blob URL after it), as in the
//     widgets showcase's analysis; `[mem] runtime-initialized`; `ready` on the new
//     session; the page `crash` event, classified by the V8 OOM line in the browser's
//     stderr (DEBUG=pw:browser, as reload-storm.mjs; restart-overlap-<tag>-<n>.browser.log);
//   - every Worker's creation and close (page.on("worker"), nested pthread Workers
//     included): the old runtime's Workers (lean and blob, created before T0, open at
//     it) still open at the allocation and at the pool spawn, and its last Worker close
//     minus its last alive-lock sample, beside the lock figures.
// Each moment (T0, alloc, pool spawn, init) carries the tracer's bracket around it,
// <moment>BracketMs = {afterMs: the first sample at or after it minus the moment,
// beforeMs: the moment minus the last sample at or before it}; a side wider than 100 ms
// lists the moment in `imprecise`. Every page or worker call that polls or acts (status,
// restart, setDocument, the worker evaluate, the ring read) races a 15 s timeout; a run
// whose last 4 such calls all went unanswered ends 'renderer-unresponsive' (callTimeouts
// counts them per run). Old and new runtime ids: relay.session.lean.runtimeId
// (TS-private, present at run time) before and after, cross-checked against the wanted
// lock that goes and the one that comes at T0. Every page-side probe catches and records
// its own failure.
//
// Arm check (armOk, runs with a T0): --rule tolerance needs the new boot's predecessors
// stripped (strippedAtBoot) and no "replaced by this page" count in the worker's waited
// line; --rule own needs the new boot to name the old runtime (pageNamedOld). A run that
// fails it is 'arm-invalid' (armWhy; the verdict it would have had is measuredVerdict),
// excluded from the crash counts.
// Own gate (--rule own, completed runs): over the runtimes the new boot named that the
// trace saw (gate.ids; replaced runtimes it did not name are gate.otherReplaced, counted
// apart), ownAliveAtAlloc === 0 and maxOwnAliveFromPoolSpawnToInitialized === 0 (n/a only
// for a figure the renderer died before). A miss while the worker's wait budget was spent
// is ownGate 'budget-spent-overlap': reported, not a FAIL.
// Verdicts: ready | crashed (between T0 and `ready`: a start-up crash, the A/B count) |
// crashed-after-ready (not a start-up crash) | arm-invalid | not-ready-after |
// renderer-unresponsive | mode-missed | crashed-during-action (the crash is why the
// action was missed) | crashed-before-action | not-ready-before-action |
// crashed-before-replacement | no-replacement | never-ready | harness-error.
//
// Usage: node tests/adversarial/restart-overlap.mjs [--url http://localhost:5198/] [--embed]
//          [--embed-host /embed-host.html] [--ballast-mb 0] [--mode idle|busy|wedged|frozen|frozen-card]
//          [--rule own|tolerance] [--runs 1] [--tag <arm>-r<n>] [--sample-ms 0] [--headed]
//          [--run-dir <dir>] [--busy-n 30000000] [--boot-budget-ms 600000] [--after-ms 180000]
//   --embed, --embed-host, --ballast-mb, --headed, --sample-ms as reload-storm.mjs; --ballast-mb
//                needs --embed (give every arm of a ballast sweep --embed, 0 included, or the
//                frame is a confound). --url must not carry ?embed=1: the seeded stored buffer
//                is the boot document. --sample-ms is a non-negative integer (0 = no sampler);
//                procsMissing marks a run whose sampler never wrote its .procs.tsv.
//   --tag        [A-Za-z0-9._-]{1,80}; the default is <mode>-<rule>-b<ballast>-<UTC
//                yyyymmddThhmmss>-p<pid>. A tag whose restart-overlap-<tag>.json is already in
//                the run dir is refused: each invocation writes its own report.
//   --busy-n     the busy loop's length (it must outlast the 2 s before the restart)
//   --after-ms   how long a run follows the replacement after the action
// Per run (restart-overlap-<tag>.json, rewritten after each): the old runtime's lifetime
// (its last alive lock minus T0), ownAliveAtAlloc, ownAliveAtPoolSpawn (each the first
// lock sample at or after that moment, with the last one before it as *Before),
// maxOwnAliveFromPoolSpawnToInitialized, the old Workers' figures, the brackets, waitedMs,
// T0 → ready, crashed and its delay, the arm check, the own gate, and the trace itself
// (ids shown as old / new / own:<prefix> / other:<prefix>). The arm's last line is its
// verdict. A/B: one invocation per run (--runs 1 --tag <arm>-r<n>, arms interleaved) into
// one --run-dir; there is no summary tool yet, so aggregate the per-tag reports by hand.
// Run it through the host's browser lock, one Chrome at a time.
// Exit 0 = every run completed (the replacement ready again, or the renderer crashed:
// data) with its arm valid and, under --rule own, the gate held (or budget-spent-overlap);
// 1 = a run did not complete (mode-missed, not-ready-after, renderer-unresponsive,
// crashed-during-action, …), arm-invalid, or an own-gate failure; 2 = usage; 3 = refused
// (the manifest unreadable, --embed's host page without COEP, the tag's report already in
// the run dir) or no run got as far as the action (every verdict never-ready or
// harness-error).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { arg, fetchJson, has, reclaimableBytes, resolveTarget, root, runDir, stamp, teeLog } from "./harness.mjs";

const MODES = ["idle", "busy", "wedged", "frozen", "frozen-card"];
const RULES = ["own", "tolerance"];
const VALUE_FLAGS = ["url", "embed-host", "ballast-mb", "mode", "rule", "runs", "tag", "sample-ms", "run-dir", "busy-n", "boot-budget-ms", "after-ms"];
const BOOL_FLAGS = ["embed", "headed"];
function usage(why) {
  console.error(`restart-overlap: ${why}\nusage: node tests/adversarial/restart-overlap.mjs [--url <page url>] [--embed [--embed-host <path>] [--ballast-mb N]] [--mode ${MODES.join("|")}] [--rule ${RULES.join("|")}] [--runs N] [--tag <label>] [--sample-ms N] [--headed] [--run-dir <dir>] [--busy-n N] [--boot-budget-ms N] [--after-ms N]`);
  process.exit(2);
}
/** A refusal: nothing was measured (exit 3). */
function refuse(why) {
  console.error(`restart-overlap: refused — ${why}`);
  process.exit(3);
}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const name = a.startsWith("--") ? a.slice(2) : null;
  if (name !== null && BOOL_FLAGS.includes(name)) continue;
  if (name === null || !VALUE_FLAGS.includes(name)) usage(`unknown argument '${a}'`);
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
  i += 1;
}
const num = (name, d, ok, what) => { const v = Number(arg(name, d)); if (!Number.isFinite(v) || !ok(v)) usage(`--${name} must be ${what}`); return v; };
const url = arg("url", "http://localhost:5198/");
const MODE = arg("mode", "idle");
const RULE = arg("rule", "own");
if (!MODES.includes(MODE)) usage(`--mode must be one of ${MODES.join(", ")}`);
if (!RULES.includes(RULE)) usage(`--rule must be one of ${RULES.join(", ")}`);
const RUNS = num("runs", "1", (v) => Number.isInteger(v) && v >= 1, "a positive integer");
const BALLAST_MB = num("ballast-mb", "0", (v) => v >= 0 && v <= 3072, "a number of MiB in [0, 3072] (embed-host.html's clamp)");
const SAMPLE_RAW = arg("sample-ms", "0");
if (!/^\d{1,9}$/.test(SAMPLE_RAW)) usage("--sample-ms must be a non-negative integer (0 = no sampler)");
const SAMPLE_MS = Number(SAMPLE_RAW);
const BUSY_N = num("busy-n", "30000000", (v) => Number.isInteger(v) && v >= 1, "a positive integer");
const BOOT_BUDGET_MS = num("boot-budget-ms", "600000", (v) => v > 0, "> 0");
const AFTER_MS = num("after-ms", "180000", (v) => v > 0, "> 0");
const EMBED = has("--embed");
const HEADED = has("--headed");
if (BALLAST_MB > 0 && !EMBED) usage("--ballast-mb needs --embed (the host page holds the ballast; give every arm of a sweep --embed, 0 included)");
let target;
let qedPath;
try {
  target = resolveTarget(url);
  const u = new URL(url);
  if (u.searchParams.get("embed") === "1") usage("--url must not carry ?embed=1 (embed mode does not read the seeded stored buffer, the boot document)");
  qedPath = u.pathname + u.search;
} catch (e) { usage(`--url: ${e.message}`); }
// The default tag is unique per invocation (UTC start time and pid); a given one names a run of an A/B.
const TAG = arg("tag", `${MODE}-${RULE}-b${BALLAST_MB}-${stamp().slice(0, 15)}-p${process.pid}`);
if (!/^[A-Za-z0-9._-]{1,80}$/.test(TAG)) usage("--tag must match [A-Za-z0-9._-]{1,80} (it names the report files)");
const pageUrl = EMBED ? `${target.origin}${arg("embed-host", "/embed-host.html")}?src=${encodeURIComponent(qedPath)}${BALLAST_MB > 0 ? `&ballast=${BALLAST_MB}` : ""}` : url;
const manifest = await fetchJson(target.manifestUrl).catch((e) => refuse(e.message));
if (EMBED) {
  const r = await fetch(pageUrl, { cache: "no-cache" }).catch(() => null);
  const body = r && r.ok ? await r.text() : "";
  if (!/qed64-frame/.test(body) || r.headers.get("cross-origin-embedder-policy") !== "require-corp") refuse(`${pageUrl} is not the embed host page with COEP (dev server only)`);
}
const dir = runDir(manifest.buildId ?? "unknown", target.mode);
const reportFile = path.join(dir, `restart-overlap-${TAG}.json`);
if (fs.existsSync(reportFile)) refuse(`${path.relative(root, reportFile)} already exists (each invocation needs its own --tag)`);
teeLog(dir, `restart-overlap-${TAG}.log`);
const browserMode = HEADED ? "headed" : "headless-shell";
console.log(`restart-overlap ${TAG}: ${pageUrl}${EMBED ? " (embedded)" : ""} → ${manifest.buildId}; ${browserMode}; mode ${MODE}, rule ${RULE}, ballast ${BALLAST_MB} MiB; ${RUNS} run(s); reports in ${path.relative(root, dir)}`);
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

const TRACE_TICK_MS = 25;
const TRACE_CAP = 4000; // run-length entries: a run changes lock state a few hundred times at most
const SETTLE_MS = 5000; // after the first `ready`: the boot's transient Workers are gone
const BUSY_RESTART_AFTER_MS = 2000;
const FREEZE_MS = 30000;
const CARD_AFTER_FREEZE_MS = 2000;
const POLL_MS = 100;
const CALL_TIMEOUT_MS = 15000; // a page or worker call unanswered this long counts as a timeout
const UNRESPONSIVE_AFTER = 4; // that many timeouts in a row end the run 'renderer-unresponsive'
const IMPRECISE_MS = 100; // a moment whose tracer bracket is wider on either side is marked imprecise
const CRASH_GRACE_MS = 2000; // a crash event this soon after an action was judged missed is its reason
const LEAN_WORKER_RE = /\/workers\/lean\.worker\.js(?:[?#]|$)/;
const COMPLETED = new Set(["ready", "crashed", "crashed-after-ready"]);
const INFRA = new Set(["never-ready", "harness-error"]); // nothing got as far as the action
class Unresponsive extends Error {}
// A Mathlib document (the umbrella snapshot boots for it), seeded as the stored buffer.
const DOC = ["import Mathlib", "", "example (a b c : ℝ) : c * b * a = b * (a * c) := by ring", "", "example (x y : ℝ) (h1 : x < y) (h2 : 0 < x) : x * 2 < y * 2 := by", "  linarith", ""].join("\n");
const BUSY_DOC = `${DOC}#eval Id.run do\n  let mut s := 0\n  for i in [0:${BUSY_N}] do\n    s := s + i % 7\n  return s\n`;
const WEDGE_DOC = `${DOC}#eval 6 * 7\n`; // work owed: the liveness probe needs an unanswered edit

/** Init script, every frame: record each `boot` the page posts to a Worker
 * (its instance), and under --rule tolerance delete instance.predecessors from
 * it; in the top frame only, the lock tracer. Serialized into the page: it
 * must be self-contained, and nothing in it may throw into the page. */
function laneProbes({ rule, tickMs, cap }) {
  const sink = (kind, payload) => {
    try { const f = globalThis.__qed64LaneSink; if (typeof f === "function") Promise.resolve(f(kind, payload)).catch(() => {}); } catch { /* no binding: the in-page ring is the record */ }
  };
  try {
    const W = globalThis.Worker;
    const post = W && W.prototype && W.prototype.postMessage;
    if (typeof post === "function") {
      const boots = (globalThis.__qed64LaneBoots = []);
      W.prototype.postMessage = function postMessage(msg, ...rest) {
        let out = msg;
        try {
          const inst = msg && typeof msg === "object" && msg.type === "boot" ? msg.instance : null;
          if (inst && typeof inst === "object") {
            const named = Array.isArray(inst.predecessors) ? inst.predecessors.slice(0, 16).map(String) : null;
            const strip = rule === "tolerance" && Object.prototype.hasOwnProperty.call(inst, "predecessors");
            if (strip) { const kept = { ...inst }; delete kept.predecessors; out = { ...msg, instance: kept }; }
            const r = { wall: Date.now(), id: typeof inst.id === "string" ? inst.id : null, waitMs: inst.waitMs ?? null, named, stripped: strip, frame: location.pathname };
            if (boots.length < 16) boots.push(r);
            sink("boot", r);
          }
        } catch (e) { out = msg; sink("probe-error", { where: "boot post", error: String(e).slice(0, 160) }); }
        return post.call(this, out, ...rest);
      };
    }
  } catch (e) { sink("probe-error", { where: "boot wrapper", error: String(e).slice(0, 160) }); }
  if (window.top !== window) return;
  const ALIVE = "qed64-alive:", WANTED = "qed64-wanted:";
  const trace = (globalThis.__qed64LockTrace = { entries: [], ticks: 0, dropped: 0, errors: 0, lastError: null, maxGapMs: 0, maxQueryMs: 0 });
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks || typeof locks.query !== "function") { trace.lastError = "no navigator.locks.query"; sink("probe-error", { where: "lock tracer", error: trace.lastError }); return; }
  let key = null, cur = null, last = 0;
  const tick = async () => {
    const asked = Date.now();
    if (last) trace.maxGapMs = Math.max(trace.maxGapMs, asked - last);
    last = asked;
    try {
      const { held = [], pending = [] } = await locks.query();
      const wall = Date.now();
      trace.maxQueryMs = Math.max(trace.maxQueryMs, wall - asked);
      trace.ticks += 1;
      if (trace.ticks % 20 === 0) sink("lock-beat", { wall }); // the open entry's last sample, should the renderer crash
      // The worker's own count (lean.worker.js waitForUnwantedRuntimes): alive locks held or pending, wanted held.
      const alive = {};
      for (const l of [...held, ...pending]) if (l && typeof l.name === "string" && l.name.startsWith(ALIVE)) { const id = l.name.slice(ALIVE.length); alive[id] = (alive[id] || 0) + 1; }
      const wanted = [...new Set(held.filter((l) => l && typeof l.name === "string" && l.name.startsWith(WANTED)).map((l) => l.name.slice(WANTED.length)))].sort();
      const k = JSON.stringify([Object.keys(alive).sort().map((id) => [id, alive[id]]), wanted]);
      if (cur && k === key) { cur.until = wall; cur.n += 1; }
      else {
        if (cur) sink("lock-close", { wall: cur.wall, until: cur.until, n: cur.n });
        key = k;
        cur = { wall, until: wall, n: 1, alive, wanted };
        trace.entries.push(cur);
        if (trace.entries.length > cap) { trace.entries.shift(); trace.dropped += 1; }
        sink("lock", cur);
      }
    } catch (e) {
      trace.errors += 1;
      trace.lastError = String(e).slice(0, 160);
      if (trace.errors <= 5) sink("probe-error", { where: "locks.query", error: trace.lastError });
    }
    setTimeout(tick, tickMs);
  };
  tick();
}

/** In the QED64 page (top level, or the frame of --embed): the relay's datum plus the internal ids. */
const STATUS = () => {
  try {
    const q = globalThis.qed64;
    if (!q || typeof q.status !== "function") return null;
    const s = q.status();
    let runtimeId = null;
    try { runtimeId = q.relay && q.relay.session && q.relay.session.lean ? q.relay.session.lean.runtimeId : null; } catch { /* the internal tap moved */ }
    const d = s.lastDeath;
    return {
      phase: s.phase, relay: s.relay, session: s.session, version: s.version ?? null, pool: s.pool ?? null,
      lastDeath: d ? { reason: d.reason, seq: d.seq, session: d.session, message: String(d.message ?? "").slice(0, 160) } : null,
      stats: q.relay && q.relay.stats ? { ...q.relay.stats } : null,
      runtimeId: typeof runtimeId === "string" ? runtimeId : null,
    };
  } catch (e) { return { error: String(e).slice(0, 160) }; }
};
/** The worker's boot-wait line (lean.worker.js boot(); the replaced-runtime suffix is LAST). */
function parseWaited(text) {
  const n = (re) => { const m = re.exec(text); return m ? m.slice(1).map(Number) : null; };
  return {
    waitedMs: (n(/waited (\d+) ms/) || [null])[0],
    stopping: (n(/for (\d+) stopping runtime/) || [null])[0],
    workers: n(/\((\d+) → (\d+) Workers alive\)/),
    budgetSpent: / — budget spent/.test(text),
    lockError: /lock query failed/.test(text),
    own: n(/; (\d+) → (\d+) of them replaced by this page/),
  };
}
const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? Math.round(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};

const runs = [];
for (let n = 1; n <= RUNS; n++) {
  const marker = `--qed64-restart-overlap=${process.pid}-${n}`;
  const out = { n, mode: MODE, rule: RULE, browser: browserMode, embed: EMBED, ballastMb: BALLAST_MB, host: hostState() };
  browserLog = path.join(dir, `restart-overlap-${TAG}-${n}.browser.log`);
  const oomsBefore = ooms.length;
  const browser = await chromium.launch({ headless: !HEADED, args: [...(HEADED ? ["--force-device-scale-factor=1"] : []), marker] });
  let sampler = null;
  let samplerExit = null;
  if (SAMPLE_MS > 0) {
    out.procs = path.relative(root, path.join(dir, `restart-overlap-${TAG}-${n}.procs.tsv`));
    sampler = spawn("python3", [path.join(root, "tests/adversarial/renderer-sampler.py"), `--marker=${marker}`, "--out", path.join(root, out.procs), "--interval-ms", String(SAMPLE_MS)], { stdio: "ignore" });
    sampler.on("error", (e) => { samplerExit = { error: String(e?.message ?? e).slice(0, 160) }; });
    sampler.on("exit", (code, signal) => { if (samplerExit === null) samplerExit = { code, signal, wall: Date.now() }; });
  }
  // Everything the page pushes (the binding survives a crash up to its last call) and the harness observes.
  const rec = { locks: [], closes: new Map(), lastBeat: null, boots: [], probeErrors: [], net: [], notes: [], workers: [], pageErrors: [] };
  let crashed = null;
  // Page and worker calls: each races CALL_TIMEOUT_MS; UNRESPONSIVE_AFTER timeouts in a row end the run.
  const calls = { timeouts: 0, inARow: 0, log: [] };
  const unresponsive = () => calls.inARow >= UNRESPONSIVE_AFTER;
  const timed = (what, p) => {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Unresponsive(`${what}: unresponsive (no answer within ${CALL_TIMEOUT_MS} ms)`)), CALL_TIMEOUT_MS); });
    return Promise.race([p, limit]).then(
      (v) => { clearTimeout(timer); calls.inARow = 0; return v; },
      (e) => {
        clearTimeout(timer);
        if (e instanceof Unresponsive) { calls.timeouts += 1; calls.inARow += 1; if (calls.log.length < 20) calls.log.push({ wall: Date.now(), what }); }
        else calls.inARow = 0; // an error is an answer
        throw e;
      },
    );
  };
  try {
    out.browserVersion = browser.version();
    const context = await browser.newContext(HEADED ? { viewport: { width: 1440, height: 900 } } : {});
    await context.exposeBinding("__qed64LaneSink", (_source, kind, p) => {
      try {
        if (kind === "lock") rec.locks.push(p);
        else if (kind === "lock-close") rec.closes.set(p.wall, p);
        else if (kind === "lock-beat") rec.lastBeat = p.wall;
        else if (kind === "boot") rec.boots.push(p);
        else if (rec.probeErrors.length < 50) rec.probeErrors.push({ kind, ...p, recv: Date.now() });
      } catch { /* a malformed push is dropped */ }
    });
    await context.addInitScript((text) => { try { window.localStorage.setItem("qed64.buffer", text); } catch { /* storage off */ } }, DOC);
    await context.addInitScript(laneProbes, { rule: RULE, tickMs: TRACE_TICK_MS, cap: TRACE_CAP });
    // Blob and worker-script requests (dedicated Workers' included): the glue import and the pool spawn.
    context.on("request", (rq) => {
      try {
        const u = rq.url();
        if (rec.net.length < 3000 && (/^blob:/.test(u) || /\/workers\//.test(u))) rec.net.push({ wall: Date.now(), type: rq.resourceType(), path: u.replace(target.origin, "") });
      } catch { /* a request the context cannot describe */ }
    });
    const page = await context.newPage();
    const runStart = Date.now();
    out.runStartEpoch = runStart;
    page.on("crash", () => { if (crashed === null) crashed = Date.now(); });
    page.on("pageerror", (e) => { if (rec.pageErrors.length < 20) rec.pageErrors.push(String(e).slice(0, 200)); });
    page.on("worker", (w) => { const r = { wall: Date.now(), kind: workerKind(w.url()), closed: null }; if (rec.workers.length < 600) rec.workers.push(r); w.on("close", () => { r.closed = Date.now(); }); });
    // The worker's boot and memory notes arrive as page console lines ('[lean:stderr] …', resident-session.ts onLog).
    page.on("console", (m) => {
      const s = m.text();
      if (rec.notes.length < 600 && (/^\[lean:stderr\] \[(?:boot|mem)\]/.test(s) || /^\[qed64\]/.test(s))) rec.notes.push({ wall: Date.now(), text: s.slice(0, 240) });
    });
    let frame = null;
    const qedFrame = async () => {
      if (!EMBED) return page.mainFrame();
      if (frame && !frame.isDetached()) return frame;
      const el = await page.$("#qed64-frame").catch(() => null);
      frame = el ? await el.contentFrame().catch(() => null) : null;
      return frame;
    };
    const inQed = async (fn, a) => { const f = await qedFrame(); if (!f) throw new Error("no QED64 frame"); return f.evaluate(fn, a); };
    const status = () => timed("status", inQed(STATUS)).catch(() => null);
    /** The live lean.worker (before the replacement there is one). */
    const inWorker = (fn, a) => timed("lean.worker evaluate", (async () => {
      const w = page.workers().find((x) => LEAN_WORKER_RE.test(x.url()));
      if (!w) throw new Error("no lean.worker in page.workers()");
      return w.evaluate(fn, a);
    })());
    const until = async (pred, ms, every = POLL_MS) => {
      const t = Date.now();
      for (;;) {
        if (crashed !== null || unresponsive()) return null;
        const v = await pred();
        if (v) return v;
        if (crashed !== null || unresponsive() || Date.now() - t > ms) return null;
        await sleep(every);
      }
    };
    /** After a call timed out: poll the status until it answers (false) or UNRESPONSIVE_AFTER timeouts in a row (true). */
    const confirmUnresponsive = async () => {
      for (;;) {
        if (crashed !== null) return false;
        if (unresponsive()) return true;
        const answered = await timed("status", inQed(STATUS)).then(() => true, (e) => !(e instanceof Unresponsive));
        if (answered) return false;
      }
    };
    const restart = (revert = null) => timed("api.restart", inQed((text) => {
      const at = Date.now();
      const answer = globalThis.qed64.api.restart();
      if (text !== null) globalThis.qed64.api.setDocument(text).catch(() => {});
      return { at, answer };
    }, revert));
    const setDoc = (text) => timed("api.setDocument", inQed((t) => { globalThis.qed64.api.setDocument(t).catch(() => {}); return true; }, text));
    const missedNow = (a, why) => ({ ...a, missed: why, missedAt: Date.now() });

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    const first = await until(async () => { const s = await status(); return s && s.phase === "ready" ? s : null; }, BOOT_BUDGET_MS, 250);
    if (first) { out.firstReadyMs = Date.now() - runStart; await sleep(SETTLE_MS); }
    const before = crashed === null && !unresponsive() ? await status() : null;
    if (!first || !before || before.phase !== "ready") out.verdict = crashed !== null ? "crashed-before-action" : unresponsive() ? "renderer-unresponsive" : first ? "not-ready-before-action" : "never-ready";
    else {
      out.reachedAction = true;
      const oldSession = before.session;
      out.ids = { old: before.runtimeId, new: null };
      // ---------- the predecessor's state, then its replacement ----------
      let action;
      try {
        if (MODE === "idle") action = { how: "api.restart", ...(await restart()) };
        else if (MODE === "busy") {
          const v0 = before.version;
          const editAt = Date.now();
          await setDoc(BUSY_DOC);
          const busy = await until(async () => { const s = await status(); return s && s.phase === "elaborating" && (v0 === null || (s.version ?? -1) > v0) ? s : null; }, 60000);
          if (!busy) action = missedNow({ how: "api.restart" }, "the busy edit never reached phase 'elaborating'");
          else {
            await sleep(BUSY_RESTART_AFTER_MS);
            const s = await status();
            action = s?.phase !== "elaborating" ? missedNow({ how: "api.restart" }, `phase '${s?.phase}' ${BUSY_RESTART_AFTER_MS} ms into the busy edit (raise --busy-n)`) : { how: "api.restart", busyForMs: Date.now() - editAt, ...(await restart(DOC)) };
          }
        } else if (MODE === "wedged") {
          await inWorker(() => { globalThis.__emscripten_check_mailbox = () => {}; return true; });
          const at = Date.now();
          await setDoc(WEDGE_DOC);
          action = { how: "wedged death", at, expect: "wedged" };
        } else {
          const at = Date.now();
          // Return first, freeze on the next task: the evaluate itself must not wait out the loop.
          await inWorker((ms) => { setTimeout(() => { const end = Date.now() + ms; while (Date.now() < end) { /* the lean.worker's JS thread, frozen */ } }, 0); return true; }, FREEZE_MS);
          if (MODE === "frozen") action = { how: "heartbeat death", at, expect: "heartbeat" };
          else {
            await sleep(CARD_AFTER_FREEZE_MS);
            const s = await status();
            action = !s || s.session !== oldSession || s.lastDeath ? missedNow({ how: "api.restart", freezeAt: at }, `the card's restart came too late (session ${s?.session}, death ${s?.lastDeath?.reason ?? null})`) : { how: "api.restart", freezeAt: at, ...(await restart()) };
          }
        }
      } catch (e) {
        // A renderer crash can fail the evaluate before its crash event lands; an unanswered call is confirmed by polling.
        if (!(e instanceof Unresponsive) && crashed === null) await sleep(500);
        action = missedNow({ how: MODE }, `the action failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`);
        if (e instanceof Unresponsive) action.unresponsiveConfirmed = await confirmUnresponsive();
      }
      if (!action.missed && action.answer && action.answer.accepted !== true) Object.assign(action, { missed: `api.restart() answered ${JSON.stringify(action.answer)}`, missedAt: Date.now() });
      out.action = action;
      // ---------- follow the replacement ----------
      let death = null, sessionAt = null, readyAt = null;
      const end = action.missed ? null : await until(async () => {
        const s = await status();
        if (!s || s.error) return null;
        if (s.lastDeath && !death && s.lastDeath.session === oldSession) death = { wall: Date.now(), reason: s.lastDeath.reason, message: s.lastDeath.message };
        if (s.session !== oldSession) {
          if (sessionAt === null) sessionAt = Date.now();
          if (!out.ids.new && s.runtimeId && s.runtimeId !== out.ids.old) out.ids.new = s.runtimeId;
          if (s.phase === "ready") { readyAt = Date.now(); return s; }
        }
        return s.phase === "halted" ? s : null;
      }, AFTER_MS);
      out.deathReason = death?.reason ?? null;
      // A death mode needs its own death; a renderer crash before one was seen is judged by the trace below.
      if (!action.missed && action.expect && (death ? death.reason !== action.expect : crashed === null)) Object.assign(action, { missed: `expected a '${action.expect}' death, saw ${death ? `'${death.reason}'` : "none"}`, missedAt: death ? death.wall : Date.now() });
      out.statsBefore = before.stats;
      out.statsAfter = end?.stats ?? null;
      // The replaced runtime's last Workers: keep tracing a little past `ready`.
      if (readyAt !== null && out.ids.old) await until(async () => { const l = rec.locks.at(-1); return l && !(l.alive[out.ids.old] > 0) ? l : null; }, 10000, 250);
      const ring = crashed === null ? await timed("lock ring read", page.evaluate(() => { const t = globalThis.__qed64LockTrace; return t ? { entries: t.entries, ticks: t.ticks, dropped: t.dropped, errors: t.errors, lastError: t.lastError, maxGapMs: t.maxGapMs, maxQueryMs: t.maxQueryMs } : null; })).catch(() => null) : null;

      // ---------- the trace: the in-page ring when whole (every entry's last sample), else the pushes ----------
      const pushed = rec.locks.map((e) => { const c = rec.closes.get(e.wall); return { ...e, until: c?.until ?? e.until, n: c?.n ?? e.n }; }).sort((a, b) => a.wall - b.wall);
      const open = pushed.at(-1);
      if (open && !rec.closes.has(open.wall)) open.until = Math.max(open.until, rec.lastBeat ?? 0); // sampled until the tracer's last beat
      const useRing = !!ring && ring.dropped === 0 && Array.isArray(ring.entries) && ring.entries.length >= pushed.length;
      const trace = useRing ? ring.entries : pushed;
      const sampledUntil = trace.reduce((m, e) => Math.max(m, e.until), 0);
      out.traceInfo = { source: useRing ? "ring" : "pushed", entries: trace.length, ticks: ring?.ticks ?? null, maxGapMs: ring?.maxGapMs ?? null, maxQueryMs: ring?.maxQueryMs ?? null, errors: ring?.errors ?? null, lastError: ring?.lastError ?? null, probeErrors: rec.probeErrors };
      const actAt = action.at ?? action.freezeAt ?? null;
      const wantedBefore = new Set(trace.filter((e) => actAt !== null && e.wall < actAt).flatMap((e) => e.wanted));
      if (!out.ids.old && wantedBefore.size === 1) out.ids.old = [...wantedBefore][0];
      const oldId = out.ids.old;
      // Every runtime this document wanted before the action is one it replaced (one, unless a self-widen came first).
      const replaced = new Set([oldId, ...wantedBefore].filter(Boolean));
      // T0, the disposal: a restart disposes inside its call; a death reboot at the earliest sign of the replacement.
      let T0 = null, t0By = null;
      const t0Seen = {};
      if (!action.missed && action.how === "api.restart") { T0 = action.at ?? null; t0By = T0 === null ? null : "api.restart() call"; }
      else if (!action.missed && actAt !== null) {
        t0Seen["old wanted lock gone (trace)"] = oldId && wantedBefore.has(oldId) ? trace.find((e) => e.wall > actAt && !e.wanted.includes(oldId))?.wall ?? null : null;
        t0Seen["new lean.worker.js request"] = rec.net.find((r) => r.wall > actAt && LEAN_WORKER_RE.test(r.path))?.wall ?? null;
        t0Seen["new lean.worker created"] = rec.workers.find((w) => w.wall > actAt && w.kind === "lean")?.wall ?? null;
        const best = Object.entries(t0Seen).filter(([, w]) => w !== null).sort((a, b) => a[1] - b[1])[0];
        if (best) { t0By = best[0]; T0 = best[1]; }
        else if (sessionAt !== null) { T0 = sessionAt; t0By = "status poll (no trace sample, request or Worker)"; }
      }
      out.t0Epoch = T0;
      out.t0By = t0By;
      if (T0 !== null && Object.keys(t0Seen).length) out.t0Candidates = Object.fromEntries(Object.entries(t0Seen).map(([k, w]) => [k, w === null ? null : w - T0]));
      const newFromTrace = T0 === null ? null : trace.find((e) => e.wall >= T0 - 50 && e.wanted.some((id) => !replaced.has(id)))?.wanted.find((id) => !replaced.has(id)) ?? null;
      if (!out.ids.new) out.ids.new = newFromTrace;
      let newId = out.ids.new;
      if (newId) replaced.delete(newId);
      // The gate's runtimes: the ones the new boot named that the trace saw; replaced runtimes it did not name are counted apart.
      const gateIds = new Set();
      const otherIds = new Set();
      const label = (id) => (id === null || id === undefined ? null : id === oldId ? "old" : id === newId ? "new" : replaced.has(id) || gateIds.has(id) ? `own:${String(id).slice(0, 8)}` : `other:${String(id).slice(0, 8)}`);
      if (T0 !== null) {
        const rel = (w) => (w === null || w === undefined ? null : w - T0);
        // A moment's state is bracketed by the tracer's last sample before it and its first at or after it. The
        // harness hears of a request a few ms late and samples are 25 ms apart, so the figures below are the later
        // sample (a lower bound, and no false overlap under --rule own, where the worker allocates once it counts 0),
        // with the earlier one beside them (*Before, an upper bound). Entries are constant from `wall` to `until`.
        const sampleFrom = (wall) => trace.find((e) => e.until >= wall) ?? null;
        const stateBefore = (wall) => { let e = null; for (const x of trace) { if (x.wall <= wall) e = x; else break; } return e; };
        // The two samples around a moment: within a run of identical samples their times are estimated from its
        // spacing (n samples from wall to until); an entry pushed without its count (the open one, when a crash
        // took the ring) is taken at its ends.
        const bracket = (M) => {
          if (M === null || M === undefined) return null;
          let prev = null, next = null;
          for (const e of trace) { if (e.wall <= M) prev = e; else { next = e; break; } }
          let before = null, after = null;
          if (prev && prev.until >= M) {
            const step = prev.n > 1 ? (prev.until - prev.wall) / (prev.n - 1) : 0;
            if (step > 0) { before = prev.wall + Math.floor((M - prev.wall) / step) * step; after = before === M ? M : Math.min(prev.until, before + step); }
            else if (prev.until === prev.wall) before = after = M;
            else { before = prev.wall; after = prev.until; }
          } else { before = prev ? prev.until : null; after = next ? next.wall : null; }
          return { afterMs: after === null ? null : Math.round(after - M), beforeMs: before === null ? null : Math.round(M - before) };
        };
        const impreciseOf = (b) => !!b && (b.afterMs === null || b.afterMs > IMPRECISE_MS || (b.beforeMs !== null && b.beforeMs > IMPRECISE_MS));
        // The network after the new lean.worker.js request, blob URLs seen before T0 left out (the old runtime's):
        // the glue import is the allocation; the pool is the biggest burst of one blob script after it.
        const net = rec.net.filter((r) => r.wall >= T0);
        const blobsBefore = new Set(rec.net.filter((r) => r.wall < T0 && /^blob:/.test(r.path)).map((r) => r.path));
        const freshBlob = (r) => /^blob:/.test(r.path) && !blobsBefore.has(r.path);
        const leanAt = net.findIndex((r) => LEAN_WORKER_RE.test(r.path));
        const allocAt = leanAt < 0 ? -1 : net.findIndex((r, i) => i > leanAt && r.type === "other" && freshBlob(r));
        const allocWall = allocAt < 0 ? null : net[allocAt].wall;
        let pool = null;
        if (allocAt >= 0) {
          const by = new Map();
          for (const r of net.slice(allocAt)) if (r.type === "script" && freshBlob(r)) { const g = by.get(r.path) ?? { wall: r.wall, count: 0 }; g.count += 1; by.set(r.path, g); }
          for (const g of by.values()) if (g.count >= 4 && (!pool || g.count > pool.count)) pool = g;
        }
        const notes = rec.notes.filter((x) => x.wall >= T0);
        const waitedNote = notes.find((x) => /\[boot\] waited/.test(x.text)) ?? null;
        const initWall = notes.find((x) => /\[mem\] runtime-initialized/.test(x.text))?.wall ?? null;
        const waited = waitedNote ? parseWaited(waitedNote.text) : null;
        const windowEnd = initWall ?? crashed ?? (sampledUntil || null);
        // The new runtime's boot post: by its id, else (no id yet) the first boot after T0 of a runtime not replaced.
        const newBoot = (newId ? rec.boots.find((b) => b.id === newId) : rec.boots.find((b) => b.wall >= T0 - 50 && b.id && !replaced.has(b.id))) ?? null;
        if (!newId && newBoot) { newId = newBoot.id; out.ids.new = newId; out.ids.newBy = "boot post"; }
        const traceIds = new Set(trace.flatMap((e) => [...Object.keys(e.alive), ...e.wanted]));
        const named = newBoot && Array.isArray(newBoot.named) ? newBoot.named : null;
        for (const id of named ? named.filter((x) => traceIds.has(x) && x !== newId) : replaced) gateIds.add(id);
        for (const id of replaced) if (!gateIds.has(id)) otherIds.add(id);
        out.gate = { by: named ? "named by the new boot, seen in the trace" : "inferred (no named predecessors at the new boot)", ids: [...gateIds].map(label), otherReplaced: [...otherIds].map(label), namedNotInTrace: named ? named.filter((x) => !traceIds.has(x)).map((x) => `${label(x)}`) : null };
        const countOf = (ids) => (e) => (e && ids.size ? [...ids].reduce((s, id) => s + (e.alive[id] || 0), 0) : null);
        const own = countOf(gateIds);
        const other = countOf(otherIds);
        const stoppingOf = (e) => (e ? Object.entries(e.alive).filter(([id]) => id !== newId && !e.wanted.includes(id)).reduce((s, [, c]) => s + c, 0) : null);
        const maxOwn = (from, to) => { const hits = trace.filter((e) => e.until >= from && e.wall <= to); const xs = (hits.length ? hits : [sampleFrom(from)]).map(own).filter((c) => c !== null); return xs.length ? Math.max(...xs) : null; };
        // The replaced runtime's lifetime: its last sample with an alive lock, and the first sample without one after it.
        let lastAlive = null, goneAt = null;
        if (gateIds.size) for (const x of trace) {
          if (x.until < T0) continue;
          if (own(x) > 0) { lastAlive = x; goneAt = null; } else if (goneAt === null) goneAt = x.wall;
        }
        // The per-Worker records: the old runtime's Workers (lean and pthread blobs, created before T0, open at it).
        const oldWorkers = rec.workers.filter((w) => (w.kind === "lean" || w.kind === "blob") && w.wall < T0 && (w.closed === null || w.closed >= T0));
        const openAt = (wall) => (wall === null || wall === undefined || !oldWorkers.length ? null : oldWorkers.filter((w) => w.closed === null || w.closed > wall).length);
        const oldLastClose = oldWorkers.length && oldWorkers.every((w) => w.closed !== null) ? Math.max(...oldWorkers.map((w) => w.closed)) : null;
        const oldLastLock = oldId ? trace.reduce((m, e) => ((e.alive[oldId] || 0) > 0 ? Math.max(m, e.until) : m), -Infinity) : -Infinity;
        const brackets = { T0: bracket(T0), alloc: bracket(allocWall), poolSpawn: bracket(pool?.wall), init: bracket(initWall) };
        // The arm: --rule tolerance stripped the named predecessors and the worker counted none; --rule own named the old runtime.
        const pageNamedOld = newBoot ? !!oldId && Array.isArray(newBoot.named) && newBoot.named.includes(oldId) : null;
        const workerOwn = waited && waited.own ? waited.own : null;
        let armWhy = null;
        if (!newBoot) armWhy = "no boot post of the new runtime seen";
        else if (RULE === "tolerance") {
          if (newBoot.stripped !== true) armWhy = "the new boot carried no instance.predecessors to strip (a build before HARDENING #68?)";
          else if (workerOwn) armWhy = `the worker still counted ${workerOwn.join(" → ")} Workers replaced by this page`;
        } else if (pageNamedOld !== true) armWhy = Array.isArray(newBoot.named) ? "the new boot did not name the old runtime" : "the new boot named no predecessors (a build before HARDENING #68?)";
        Object.assign(out, {
          oldLifetimeMs: !gateIds.size || goneAt === null ? null : lastAlive ? lastAlive.until - T0 : 0,
          oldGoneMs: rel(goneAt),
          ownAliveAtT0: own(sampleFrom(T0)),
          ownAliveAtTraceEnd: goneAt === null ? own(trace.at(-1)) : 0,
          ownAliveAtAlloc: allocWall === null ? null : own(sampleFrom(allocWall)),
          ownAliveAtAllocBefore: allocWall === null ? null : own(stateBefore(allocWall)),
          ownAliveAtPoolSpawn: pool === null ? null : own(sampleFrom(pool.wall)),
          ownAliveAtPoolSpawnBefore: pool === null ? null : own(stateBefore(pool.wall)),
          maxOwnAliveFromPoolSpawnToInitialized: pool === null || windowEnd === null ? null : maxOwn(pool.wall, windowEnd),
          windowEndBy: initWall !== null ? "runtime-initialized" : crashed !== null ? "crash" : "trace end",
          otherReplacedAliveAtAlloc: allocWall === null || !otherIds.size ? null : other(sampleFrom(allocWall)),
          otherReplacedAliveAtPoolSpawn: pool === null || !otherIds.size ? null : other(sampleFrom(pool.wall)),
          stoppingAtAlloc: allocWall === null ? null : stoppingOf(sampleFrom(allocWall)),
          newAliveAtAlloc: allocWall === null || !newId || !sampleFrom(allocWall) ? null : sampleFrom(allocWall).alive[newId] || 0,
          oldWorkersAtT0: oldWorkers.length,
          oldWorkersAliveAtAlloc: openAt(allocWall),
          oldWorkersAliveAtPoolSpawn: openAt(pool?.wall),
          oldWorkersOpenAtEnd: oldWorkers.filter((w) => w.closed === null).length,
          oldLastWorkerCloseMs: rel(oldLastClose),
          oldLastCloseMinusLastLockMs: oldLastClose !== null && oldLastLock > -Infinity ? oldLastClose - oldLastLock : null,
          t0BracketMs: brackets.T0,
          allocBracketMs: brackets.alloc,
          poolSpawnBracketMs: brackets.poolSpawn,
          initBracketMs: brackets.init,
          imprecise: Object.entries(brackets).filter(([, b]) => impreciseOf(b)).map(([k]) => k),
          allocBy: leanAt < 0 ? "no new lean.worker.js request seen" : allocAt < 0 ? "no fresh blob import after the lean.worker.js request" : "glue import after the lean.worker.js request",
          waitedMs: waited ? waited.waitedMs : null,
          waitedLine: waitedNote ? waitedNote.text.replace(/^.*\[boot\] /, "") : null,
          waited,
          leanWorkerMs: rel(leanAt < 0 ? null : net[leanAt].wall),
          waitedLineMs: rel(waitedNote?.wall),
          allocMs: rel(allocWall),
          poolSpawnMs: rel(pool?.wall),
          poolSize: pool?.count ?? null,
          runtimeInitializedMs: rel(initWall),
          t0ToReadyMs: rel(readyAt),
          deathMs: rel(death?.wall),
          pageNamedOld,
          strippedAtBoot: newBoot ? newBoot.stripped : null,
          armOk: armWhy === null,
          armWhy,
        });
      }
      if (out.armOk === undefined) out.armOk = null; // no replacement: the arm was not exercised
      Object.assign(out.ids, { oldFromTrace: [...wantedBefore], newFromTrace, agree: !!oldId && wantedBefore.size === 1 && wantedBefore.has(oldId) && !!newId && newFromTrace === newId, own: [...replaced] });
      // What each boot named and whether --rule tolerance stripped it; the trace, the network and the notes, ids as labels.
      const ref = T0 ?? actAt ?? runStart;
      out.bootPosts = rec.boots.map((b) => ({ t: b.wall - ref, id: label(b.id), named: Array.isArray(b.named) ? b.named.map(label) : null, stripped: b.stripped, waitMs: b.waitMs }));
      out.trace = trace.map((e) => ({ t: e.wall - ref, ms: e.until - e.wall, n: e.n, alive: Object.fromEntries(Object.entries(e.alive).map(([id, c]) => [label(id), c])), wanted: e.wanted.map(label) }));
      out.net = rec.net.filter((r) => r.wall >= ref - 1000).slice(0, 200).map((r) => ({ t: r.wall - ref, type: r.type, path: r.path.slice(0, 60) }));
      out.notes = rec.notes.slice(0, 300).map((x) => ({ t: x.wall - ref, text: x.text }));
      out.workers = rec.workers.filter((w) => w.closed === null || w.closed >= ref - 1000).map((w) => ({ kind: w.kind, t: w.wall - ref, closed: w.closed === null ? null : w.closed - ref }));
      out.crashed = crashed !== null;
      out.crashDelayMs = crashed !== null && T0 !== null ? crashed - T0 : null;
      out.crashAfterReadyMs = crashed !== null && readyAt !== null && crashed >= readyAt ? crashed - readyAt : null;
      const measured = T0 === null
        ? (crashed !== null ? "crashed-before-replacement" : unresponsive() ? "renderer-unresponsive" : "no-replacement")
        : crashed !== null ? (readyAt !== null && crashed >= readyAt ? "crashed-after-ready" : "crashed")
          : unresponsive() ? "renderer-unresponsive" : readyAt !== null ? "ready" : "not-ready-after";
      if (action.missed) out.verdict = crashed !== null && crashed <= (action.missedAt ?? Infinity) + CRASH_GRACE_MS ? "crashed-during-action" : unresponsive() ? "renderer-unresponsive" : "mode-missed";
      else if (out.armOk === false) { out.verdict = "arm-invalid"; out.measuredVerdict = measured; }
      else out.verdict = measured;
    }
    if (out.crashed === undefined) out.crashed = crashed !== null;
    out.pageErrors = rec.pageErrors;
  } catch (e) {
    out.verdict = "harness-error";
    out.error = String(e?.message ?? e).split("\n")[0].slice(0, 200);
    out.crashed = crashed !== null;
  } finally {
    await browser.close().catch(() => {});
    if (sampler) {
      sampler.kill();
      out.procsMissing = !fs.existsSync(path.join(root, out.procs));
      if (samplerExit) out.samplerExit = samplerExit;
    }
  }
  out.callTimeouts = calls.timeouts;
  out.callTimeoutsInARowAtEnd = calls.inARow;
  if (calls.log.length) out.callTimeoutLog = calls.log.map((c) => ({ ...c, tRun: out.runStartEpoch ? c.wall - out.runStartEpoch : null }));
  out.crashedAtMs = crashed !== null ? crashed - out.runStartEpoch : null;
  out.oom = ooms.slice(oomsBefore).map((o) => ({ ...o, kind: oomKind(o.text), tRun: out.runStartEpoch ? o.epoch - out.runStartEpoch : null, tT0: out.t0Epoch ? o.epoch - out.t0Epoch : null }));
  out.oomKind = out.oom.length ? [...new Set(out.oom.map((o) => o.kind))].join("+") : null;
  out.completed = COMPLETED.has(out.verdict);
  // The own gate (--rule own, completed runs): no Worker of a named predecessor in the first sample at or after the
  // allocation, nor in any sample from the pool spawn to runtime-initialized (a figure is n/a only when the renderer
  // died before it: a start-up crash). A miss with the worker's wait budget spent is its own outcome, not a FAIL.
  if (RULE !== "own") out.ownGate = "n/a (rule tolerance)";
  else if (!out.completed) out.ownGate = "n/a (not completed)";
  else {
    const died = out.verdict === "crashed";
    const atAlloc = out.ownAliveAtAlloc, span = out.maxOwnAliveFromPoolSpawnToInitialized;
    const ok = (atAlloc === 0 || (atAlloc === null && died)) && (span === 0 || (span === null && died));
    out.ownGate = ok ? "ok" : atAlloc > 0 || span > 0 ? (out.waited?.budgetSpent ? "budget-spent-overlap" : "overlap") : "unmeasured";
  }
  runs.push(out);
  const f = (v) => (v === null || v === undefined ? "-" : v);
  const br = (b) => (b ? `+${f(b.afterMs)}/-${f(b.beforeMs)} ms` : "-");
  const line = [
    `run ${n}: ${out.verdict}${out.verdict === "arm-invalid" ? ` (${out.armWhy}; measured '${out.measuredVerdict}')` : ""}${out.action?.missed ? ` (${out.action.missed})` : ""}${out.crashed ? ` crash at ${f(out.crashDelayMs)} ms after T0${out.crashAfterReadyMs !== null && out.crashAfterReadyMs !== undefined ? ` (${out.crashAfterReadyMs} ms after ready)` : ""}` : ""}${out.oomKind ? ` [${out.oomKind}, ${out.oom.length} OOM line(s)]` : ""}${out.error ? ` (${out.error})` : ""}`,
    `arm ${out.armOk === undefined || out.armOk === null ? "-" : out.armOk ? "ok" : "INVALID"}, own gate ${out.ownGate}`,
    ...(out.callTimeouts ? [`${out.callTimeouts} page call(s) unanswered in ${CALL_TIMEOUT_MS / 1000} s`] : []),
    `first ready ${f(out.firstReadyMs)} ms`,
    `T0 by ${f(out.t0By)}${out.deathReason ? ` (death '${out.deathReason}' at ${f(out.deathMs)} ms)` : ""}`,
    `old runtime alive ${f(out.ownAliveAtT0)} at T0, gone ${f(out.oldGoneMs)} ms (lifetime ${f(out.oldLifetimeMs)} ms${out.ownAliveAtTraceEnd ? `, ${out.ownAliveAtTraceEnd} still alive at the trace's end` : ""})`,
    `own alive at alloc ${f(out.ownAliveAtAlloc)} (${f(out.ownAliveAtAllocBefore)} just before; old Workers open ${f(out.oldWorkersAliveAtAlloc)}), at pool ${f(out.ownAliveAtPoolSpawn)} (${f(out.ownAliveAtPoolSpawnBefore)}; Workers ${f(out.oldWorkersAliveAtPoolSpawn)}), max to init ${f(out.maxOwnAliveFromPoolSpawnToInitialized)}; old last Worker close − last lock ${f(out.oldLastCloseMinusLastLockMs)} ms`,
    ...(out.gate?.otherReplaced?.length ? [`other replaced ${out.gate.otherReplaced.join(",")}: alive at alloc ${f(out.otherReplacedAliveAtAlloc)}, at pool ${f(out.otherReplacedAliveAtPoolSpawn)}`] : []),
    `T0 → worker ${f(out.leanWorkerMs)}, alloc ${f(out.allocMs)}, pool ${f(out.poolSpawnMs)} (${f(out.poolSize)}), init ${f(out.runtimeInitializedMs)}, ready ${f(out.t0ToReadyMs)} ms`,
    ...(out.imprecise?.length ? [`IMPRECISE ${out.imprecise.map((k) => `${k} ${br(out[`${k === "T0" ? "t0" : k}BracketMs`])}`).join(", ")}`] : []),
    out.waitedLine ? `waited: ${out.waitedLine}` : "no waited line",
    `named ${out.pageNamedOld === null || out.pageNamedOld === undefined ? "-" : out.pageNamedOld ? "old" : "not old"}${out.strippedAtBoot ? " (stripped)" : ""}${out.t0Epoch && out.ids && out.ids.agree === false ? "; ids DISAGREE (page vs trace)" : ""}`,
    `trace ${out.traceInfo ? `${out.traceInfo.source} ${out.traceInfo.entries} entries, max gap ${f(out.traceInfo.maxGapMs)} ms` : "-"}`,
    ...(out.procsMissing ? [`procs MISSING (sampler ${JSON.stringify(out.samplerExit ?? null)})`] : []),
    `host ${out.host.reclaimableGB} GB reclaimable`,
  ];
  console.log(line.join("; "));
  fs.writeFileSync(reportFile, JSON.stringify({ url: pageUrl, qed64Url: url, mode: MODE, rule: RULE, embed: EMBED, ballastMb: BALLAST_MB, browser: browserMode, buildId: manifest.buildId, tag: TAG, runs }, null, 1));
  if (n < RUNS) await sleep(5000); // let the dead browser's memory drain before the next run
}
const completed = runs.filter((r) => r.completed);
const startupCrashes = runs.filter((r) => r.verdict === "crashed"); // arm-invalid and after-ready crashes are not counted
const afterReady = runs.filter((r) => r.verdict === "crashed-after-ready");
const armInvalid = runs.filter((r) => r.verdict === "arm-invalid");
const incomplete = runs.filter((r) => !r.completed && r.verdict !== "arm-invalid");
const gateBad = runs.filter((r) => r.ownGate === "overlap" || r.ownGate === "unmeasured");
const budgetSpent = runs.filter((r) => r.ownGate === "budget-spent-overlap");
const impreciseRuns = runs.filter((r) => r.imprecise && r.imprecise.length);
const valid = runs.filter((r) => r.verdict !== "arm-invalid");
const kinds = startupCrashes.map((r) => r.oomKind || "no OOM line").reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {});
const list = (k) => runs.map((r) => (r[k] === null || r[k] === undefined ? "-" : r[k])).join("/");
const allInfra = runs.every((r) => INFRA.has(r.verdict));
const why = [
  incomplete.length ? `${incomplete.length} run(s) did not complete (${[...new Set(incomplete.map((r) => r.verdict))].join(", ")})` : "",
  armInvalid.length ? `${armInvalid.length} run(s) arm-invalid (${[...new Set(armInvalid.map((r) => r.armWhy))].join("; ")})` : "",
  gateBad.length ? `under --rule own, ${gateBad.filter((r) => r.ownGate === "overlap").length} run(s) had a named predecessor's Worker alive at the allocation or before runtime-initialized and ${gateBad.filter((r) => r.ownGate === "unmeasured").length} measured none there` : "",
].filter(Boolean);
const outcome = allInfra ? `INFRA: no run got as far as the action (${[...new Set(runs.map((r) => r.verdict))].join(", ")})` : why.length ? `FAIL: ${why.join("; ")}` : "PASS";
console.log(`RESTART-OVERLAP ${TAG}: ${completed.length}/${runs.length} completed, ${startupCrashes.length} start-up crash(es)${startupCrashes.length ? ` ${JSON.stringify(kinds)} at ${startupCrashes.map((r) => r.crashDelayMs ?? "-").join("/")} ms after T0` : ""}${afterReady.length ? `, ${afterReady.length} crashed after ready` : ""}${armInvalid.length ? `, ${armInvalid.length} arm-invalid (not counted)` : ""}${budgetSpent.length ? `, ${budgetSpent.length} budget-spent-overlap` : ""}; own alive at alloc ${list("ownAliveAtAlloc")}, at pool ${list("ownAliveAtPoolSpawn")}, max to init ${list("maxOwnAliveFromPoolSpawnToInitialized")}; old Workers open at alloc ${list("oldWorkersAliveAtAlloc")}${impreciseRuns.length ? `; ${impreciseRuns.length} run(s) with an imprecise moment` : ""}; old lifetime ~${median(valid.map((r) => r.oldLifetimeMs)) ?? "-"} ms; waited ~${median(valid.map((r) => r.waitedMs)) ?? "-"} ms; T0 → ready ~${median(valid.map((r) => r.t0ToReadyMs)) ?? "-"} ms — ${MODE}, rule ${RULE}, ballast ${BALLAST_MB} MiB, ${browserMode}${EMBED ? " embedded" : ""} (${manifest.buildId}) — ${outcome}`);
process.exitCode = allInfra ? 3 : why.length ? 1 : 0;
