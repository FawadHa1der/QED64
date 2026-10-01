#!/usr/bin/env node
// Liveness fault drills (docs/HARDENING.md #52) in REAL headless Chromium:
// the runtime-thread mailbox, its periodic kick, the Lean-side liveness
// probe and the FileWorker exit hook, each exercised by injecting the fault
// into the live lean.worker (Playwright `worker.evaluate`), never by a
// test-only build. Every edit changes the message count and every wait is
// gated on the worker having taken the new version, so no scenario can pass
// on the state from before its own edit.
//
//   mailbox-mode          the worker booted with message notifications: the
//                         glue's waitAsync flag is off, the main pthread's
//                         `waiting_async` word was never set, the glue's
//                         `checkMailbox` is the counting wrapper, proxied calls
//                         are counted, the exit hook is installed, and
//                         `status().liveness` exists from loop open.
//   idle-no-probes        a ready, idle session is never probed (25 s).
//   long-silent-command   a ~40 s CPU-bound `#eval` that prints nothing: the
//                         probe is answered while it runs (≥ 3 answers), no
//                         stall, no death, no rescue, and the right value
//                         (Σ i % 7 over [0, n) = 3n) at the end — the
//                         negative control: a busy session is not a wedge.
//   lost-wakeups-healed   10% of the runtime thread's mailbox notifications
//                         are dropped (the lost wakeup that froze the C20
//                         session) for three edits: each settles with the
//                         right messages, the kick serves the stranded work,
//                         rescues are confirmed, nobody dies; the fault is
//                         then removed and an edit settles normally.
//   wedge-recovery        the runtime thread's mailbox is disabled outright (a
//                         total freeze of every Lean thread) and an edit adds
//                         a message: the probe goes unanswered, the worker
//                         dies "wedged", the pill names the stall, the relay
//                         reboots and replays, and only the replayed text can
//                         produce the new message count and value.
//   exit-detected         the FileWorker is told to exit (a raw LSP `exit` in
//                         the ring): the death is reported at once as "exit"
//                         (not as a 22 s liveness verdict), and the relay
//                         reboots to the same messages.
//
// Usage: node tests/adversarial/liveness-faults.mjs [--url http://localhost:5197/]
//          [--only <scenario>] [--run-dir <dir>] [--boot-budget-ms 300000]
// Run it through the host's browser lock (one Chrome at a time). Exit 0 all
// pass, 1 a scenario failed, 3 infrastructure refusal (no manifest / no boot).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { arg, fetchJson, onlyMatches, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

const url = arg("url", "http://localhost:5197/");
const only = arg("only", "");
const bootBudgetMs = Number(arg("boot-budget-ms", "300000"));
const target = resolveTarget(url);
const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`liveness-faults: refused — ${e.message}`); process.exit(3); });
const dir = runDir(manifest.buildId ?? "unknown", target.mode);
teeLog(dir, "liveness-faults.log");
const runs = (name) => !only || onlyMatches(name, only);
console.log(`liveness-faults: ${url} → ${manifest.buildId} ; reports in ${path.relative(root, dir)}`);

// An init-only document (no Mathlib: the drills are about the runtime, and a
// light session keeps the shared host's memory free). Two `#eval`s: "All
// Messages (2)"; every scenario edit appends `#eval`s so its count is new.
const DOC = [
  "def f (n : Nat) : Nat := n + 1",
  "theorem t1 : f 2 = 3 := by decide",
  "example (a b : Nat) : a + b = b + a := by omega",
  "#eval f 41",
  "example : (12 : Nat) ∣ 132 := by decide",
  "def g : List Nat → Nat",
  "  | [] => 0",
  "  | x :: xs => x + g xs",
  "#eval g [1, 2, 3, 4]",
  "",
].join("\n");
/** DOC plus `k` extra `#eval f (base+j)` lines: 2 + k messages, values base+j+1. */
const withEvals = (k, base) => DOC + Array.from({ length: k }, (_, j) => `#eval f ${base + j}\n`).join("");
const longEval = (n) => `${DOC}#eval Id.run do\n  let mut s := 0\n  for i in [0:${n}] do\n    s := s + i % 7\n  return s\n`;

const results = [];
let failed = 0;
function record(name, ok, detail, extra = {}) {
  results.push({ name, outcome: ok ? "pass" : "fail", detail, ...extra });
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
  fs.writeFileSync(path.join(dir, "liveness-report.json"), JSON.stringify({ url, buildId: manifest.buildId, total: results.length, failed, results }, null, 2));
}

const browser = await chromium.launch();
const pageErrors = [];
const consoleLines = [];
let page;
try {
  const context = await browser.newContext();
  await context.addInitScript((text) => { try { window.localStorage.setItem("qed64.buffer", text); } catch { /* storage off */ } }, DOC);
  page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  // Everything (the worker's stderr arrives as `[lean:stderr] …` page console lines), capped.
  page.on("console", (m) => { if (consoleLines.length < 20000) consoleLines.push(`${new Date().toISOString()} ${m.type()} ${m.text().slice(0, 400)}`); });

  // ---------- taps ----------
  const status = () => page.evaluate(() => { try { return JSON.parse(JSON.stringify(globalThis.qed64.status())); } catch { return null; } }).catch(() => null);
  const stats = () => page.evaluate(() => ({ ...globalThis.qed64.relay.stats })).catch(() => null);
  const setBuffer = (t) => page.evaluate((t) => globalThis.qed64.editor.getModel().setValue(t), t);
  const editorText = () => page.evaluate(() => globalThis.qed64.editor.getModel().getValue()).catch(() => null);
  const pill = () => page.evaluate(() => (document.getElementById("ptext") || {}).textContent || "").catch(() => "");
  const infoview = () => page.evaluate(() => {
    const f = document.getElementById("infoview")?.querySelector("iframe");
    return f && f.contentDocument ? f.contentDocument.body.innerText : "";
  }).catch(() => "");
  const badge = async () => (((await infoview()).match(/All Messages \(([^)]*)\)/) || [])[1] || "").trim();
  // The messages themselves: the InfoView's "All Messages" list is collapsed,
  // so its text has no values. A listener on the relay's client port (the
  // LSP client's end of the channel; the relay outlives every session) keeps
  // the last publishDiagnostics the client received.
  const installDiagTap = () => page.evaluate(() => {
    if (globalThis.__qed64DiagTap) return;
    globalThis.__qed64DiagTap = true;
    globalThis.qed64.relay.clientPort.addEventListener("message", (e) => {
      const m = e.data;
      if (m && m.method === "textDocument/publishDiagnostics") globalThis.__qed64Diags = m.params;
    });
  });
  const diagText = () => page.evaluate(() => (globalThis.__qed64Diags?.diagnostics ?? []).map((d) => d.message).join("\n")).catch(() => "");
  /** The live lean.worker (a reboot replaces it: always look it up again). */
  const leanWorker = () => page.workers().find((w) => /\/workers\/lean\.worker\.js(\?|$)/.test(w.url())) ?? null;
  async function inWorker(fn, a) {
    const w = leanWorker();
    if (!w) throw new Error("no lean.worker in page.workers()");
    return w.evaluate(fn, a);
  }
  /** The worker's own liveness counters and mailbox counts (not the status copy). */
  const counters = () => inWorker(() => {
    const t = globalThis.__qed64TestExports.liveness;
    const L = t.state();
    return { liveness: L ? { ...L.counters } : null, mailbox: { ...t.runtimeMailbox } };
  }).catch(() => null);
  async function waitFor(pred, ms, every = 200) {
    const t0 = Date.now();
    for (;;) {
      const v = await pred();
      if (v) return { ok: true, ms: Date.now() - t0, v };
      if (Date.now() - t0 > ms) return { ok: false, ms: Date.now() - t0, v };
      await page.waitForTimeout(every);
    }
  }
  /** Ready at a version past `fromVersion` with `want` messages (and every `contains` string among them). */
  const settledAfter = (fromVersion, want, ms, contains = [], onPoll = null) => waitFor(async () => {
    if (onPoll) await onPoll();
    const s = await status();
    if (!(s?.phase === "ready" && s.version !== null && (fromVersion === null || s.version > fromVersion))) return null;
    if ((await badge()) !== String(want)) return null;
    const msgs = contains.length ? (await diagText()).split("\n") : [];
    return contains.every((c) => msgs.includes(c)) ? s : null;
  }, ms, 250);
  /** Edit and wait for THIS edit to settle. */
  async function edit(text, want, ms, contains = [], onPoll = null) {
    const v0 = (await status())?.version ?? null;
    const t0 = Date.now();
    await setBuffer(text);
    const r = await settledAfter(v0, want, ms, contains, onPoll ? () => onPoll(t0) : null);
    return { ...r, ms: Date.now() - t0 };
  }
  /** A screenshot into the run directory (UX review); never fails a scenario. */
  const shot = (name) => page.screenshot({ path: path.join(dir, `${name}.png`) }).catch(() => {});
  const delta = (a, b) => (a && b ? Object.fromEntries(Object.keys(b).map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)])) : null);

  // ---------- boot ----------
  const tBoot = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const booted = await settledAfter(null, 2, bootBudgetMs);
  if (!booted.ok) {
    console.error(`liveness-faults: refused — the page did not settle (phase ${(await status())?.phase}, badge '${await badge()}', pill '${await pill()}') within ${bootBudgetMs} ms`);
    console.error(`status: ${JSON.stringify(await status()).slice(0, 1500)}`);
    console.error(`last console lines:\n  ${consoleLines.slice(-40).join("\n  ")}`);
    process.exitCode = 3;
  } else {
    console.log(`boot: ready with 2 messages in ${Date.now() - tBoot} ms`);
    await shot("01-boot-ready");
    await installDiagTap();
    // Prove the tap before any scenario relies on it: one edit, exact values.
    const tap = await edit(withEvals(1, 1), 3, 120000, ["42", "10", "2"]);
    if (!tap.ok) record("diagnostics-tap", false, `the edit adding '#eval f 1' did not publish ["42","10","2"] (got ${JSON.stringify(await diagText())})`);
    await edit(DOC, 2, 120000, ["42", "10"]);

    // ---------- mailbox-mode ----------
    if (runs("mailbox-mode")) {
      const m = await inWorker(() => {
        const g = globalThis;
        const ptr = Number(g._pthread_self());
        const mem = g.Module?.wasmMemory ?? g.wasmMemory;
        const H = mem ? new Int32Array(mem.buffer) : null;
        const t = g.__qed64TestExports.liveness;
        return {
          polyfilled: g.waitAsyncPolyfilled,
          wrapper: typeof g.checkMailbox === "function" ? g.checkMailbox.name : null,
          waitingAsync: H ? H[(ptr + 204) / 4] : null,
          mailbox: { ...t.runtimeMailbox },
          livenessArmed: !!t.state(),
        };
      });
      const st = (await status())?.liveness ?? null;
      const word = await inWorker(() => globalThis.__qed64TestExports.liveness.readMailboxWord());
      const ok = m.polyfilled === true && m.wrapper === "checkMailboxCounted" && m.waitingAsync === 0 && m.livenessArmed
        && m.mailbox.mode === "message" && m.mailbox.counting && m.mailbox.exitHooked && m.mailbox.notified > 0 && m.mailbox.served > 0
        && m.mailbox.mailboxPtr !== null && [0, 1, 2].includes(word) && st !== null;
      record("mailbox-mode", ok, `${JSON.stringify(m)} word=${word} status.liveness=${JSON.stringify(st)}`);
    }

    // ---------- idle-no-probes ----------
    if (runs("idle-no-probes")) {
      const before = await counters();
      await page.waitForTimeout(25000);
      const after = await counters();
      const d = delta(before?.liveness, after?.liveness);
      const ok = !!d && d.probes === 0 && d.stalls === 0 && d.rescues === 0 && (await status())?.phase === "ready";
      record("idle-no-probes", ok, `liveness delta over 25 s idle ${JSON.stringify(d)}`);
    }

    // ---------- long-silent-command ----------
    if (runs("long-silent-command")) {
      // Calibrate from the loop time alone: two runs, n0 and 2·n0, cancel the
      // fixed overhead (debounce, hops, compile, publish, polling).
      const n0 = 1_400_000; // multiples of 7 throughout: the value is exactly 3n
      const c1 = await edit(longEval(n0), 3, 300000, [String(3 * n0)]);
      const c2 = await edit(longEval(2 * n0), 3, 300000, [String(6 * n0)]);
      const perIter = Math.max(1e-6, (c2.ms - c1.ms) / n0);
      const sized = (ms) => Math.max(n0, Math.min(60 * n0, Math.floor(ms / perIter / 7) * 7));
      let n = sized(40000);
      await edit(DOC, 2, 120000);
      const s0 = await stats();
      const k0 = await counters();
      // The page is never silent for 6 s on its own (frames arrive more than
      // once a second while a command runs: progress, refreshes, answers), so
      // every 8 s the drill makes the watchdog believe it has been and runs
      // its tick at once (a later tick would see the next frame first): the
      // REAL probe is written into the ring and must be answered by the
      // FileWorker while the command runs.
      let forced = 0;
      const forcedPhases = [];
      const force = async (t0) => {
        if (Date.now() - t0 < (forced + 1) * 8000) return;
        forced += 1;
        const r = await inWorker(() => {
          const t = globalThis.__qed64TestExports.liveness;
          const L = t.state();
          if (!L || L.probe !== null) return null;
          L.lastFrameAt -= 7000;
          t.step();
          return { phase: globalThis.__qed64TestExports.frontDoor.status().phase ?? null, probed: L.probe !== null };
        }).catch((e) => ({ error: String(e).slice(0, 80) }));
        forcedPhases.push(r);
      };
      let longRun = await edit(longEval(n), 3, 600000, [String(3 * n)], force);
      if (longRun.ok && longRun.ms < 25000 && n < 60 * n0) { // too short to prove anything: rescale once
        n = Math.min(60 * n0, Math.floor((n * 40000) / Math.max(1, longRun.ms) / 7) * 7);
        await edit(DOC, 2, 120000);
        forced = 0;
        longRun = await edit(longEval(n), 3, 600000, [String(3 * n)], force);
      }
      const k1 = await counters();
      const d = delta(s0, await stats());
      const lv = delta(k0?.liveness, k1?.liveness);
      const ok = c1.ok && c2.ok && longRun.ok && longRun.ms >= 25000 && d?.workerDeaths === 0 && lv?.stalls === 0 && lv?.rescues === 0 && lv?.answered >= 2 && lv?.answered === lv?.probes;
      record("long-silent-command", ok,
        `calibration ${c1.ms}/${c2.ms} ms → n=${n}; command settled=${longRun.ok} in ${longRun.ms} ms (value ${3 * n}); ${forced} forced silences ${JSON.stringify(forcedPhases.slice(0, 4))}; liveness ${JSON.stringify(lv)}; deaths +${d?.workerDeaths}`,
        { n, commandMs: longRun.ms, liveness: lv });
      await edit(DOC, 2, 120000);
    }

    // ---------- lost-wakeups-healed ----------
    if (runs("lost-wakeups-healed")) {
      const s0 = await stats();
      const k0 = await counters();
      await inWorker(() => {
        const g = globalThis;
        const deliver = g.checkMailbox;
        g.__qed64Fault = { p: 0.1, dropped: 0, restore: deliver };
        g.checkMailbox = function checkMailboxFault() {
          if (Math.random() < g.__qed64Fault.p) { g.__qed64Fault.dropped += 1; return; }
          return deliver.apply(this, arguments);
        };
      });
      const rounds = [];
      for (let i = 1; i <= 3; i++) {
        const r = await edit(withEvals(i, 100 * i), 2 + i, 240000, [String(100 * i + i)]);
        rounds.push({ ok: r.ok, ms: r.ms });
      }
      const dropped = await inWorker(() => { const g = globalThis; const n = g.__qed64Fault.dropped; g.checkMailbox = g.__qed64Fault.restore; return n; });
      await page.waitForTimeout(2500); // let the last candidate rescue be confirmed by the next kicks
      const k1 = await counters();
      const after = await edit(withEvals(1, 500), 3, 120000, ["501"]);
      const d = delta(s0, await stats());
      const lv = delta(k0?.liveness, k1?.liveness);
      // Every confirmed rescue is a dropped notification (several drops can share one stall, so ≤).
      const ok = rounds.every((r) => r.ok) && after.ok && d?.workerDeaths === 0 && dropped > 0 && lv?.rescues > 0 && lv?.rescues <= dropped;
      record("lost-wakeups-healed", ok,
        `rounds ${rounds.map((r) => `${r.ok ? "ok" : "STUCK"}@${r.ms}ms`).join(", ")}; dropped ${dropped} notifications, liveness ${JSON.stringify(lv)}, deaths +${d?.workerDeaths}; fault removed → settled ${after.ok} in ${after.ms} ms`,
        { rounds, dropped, liveness: lv });
      await edit(DOC, 2, 120000);
    }

    // ---------- wedge-recovery ----------
    if (runs("wedge-recovery")) {
      const s0 = await stats();
      const session0 = (await status())?.session;
      await inWorker(() => { globalThis.__emscripten_check_mailbox = () => {}; });
      const text = withEvals(1, 7); // a third message, "8": only a replayed text produces it
      const t0 = Date.now();
      await setBuffer(text);
      let sawWedged = null, sawLabel = null;
      const recovered = await waitFor(async () => {
        const s = await status();
        if (s?.lastDeath?.reason === "wedged" && !sawWedged) sawWedged = { ms: Date.now() - t0, message: s.lastDeath.message };
        const p = await pill();
        if (/stopped responding/.test(p) && !sawLabel) { sawLabel = { ms: Date.now() - t0, pill: p }; await shot("02-wedge-restarting"); }
        if (!(s?.phase === "ready" && s.session !== session0)) return null;
        return (await badge()) === "3" && (await diagText()).split("\n").includes("8") ? s : null;
      }, 300000, 200);
      await shot("03-wedge-recovered");
      const d = delta(s0, await stats());
      const editorIntact = (await editorText()) === text;
      const ok = recovered.ok && !!sawWedged && sawWedged.ms <= 45000 && d?.workerDeaths === 1 && d?.reboots === 1 && d?.breakerTrips === 0 && !!sawLabel && editorIntact;
      record("wedge-recovery", ok,
        `death 'wedged' at ${sawWedged ? sawWedged.ms + " ms" : "NEVER"}; pill ${sawLabel ? `'${sawLabel.pill}' at ${sawLabel.ms} ms` : "NEVER named the stall"}; replayed text settled (3 messages, '8') ${recovered.ok} at ${recovered.ms} ms on a new session; stats ${JSON.stringify(d)}; editor intact (no page reload) ${editorIntact}`,
        { wedged: sawWedged, label: sawLabel, recoveryMs: recovered.ms, stats: d });
      await edit(DOC, 2, 120000);
    }

    // ---------- exit-detected ----------
    if (runs("exit-detected")) {
      const s0 = await stats();
      const session0 = (await status())?.session;
      const t0 = Date.now();
      // A raw LSP `exit` (no params: Lean's mainLoop returns) straight into the ring.
      await inWorker(() => {
        const r = globalThis.__qed64TestExports.resident;
        r.residentRingWrite(r.residentFrame(JSON.stringify({ jsonrpc: "2.0", method: "exit" })));
      });
      let sawExit = null;
      const recovered = await waitFor(async () => {
        const s = await status();
        if (s?.lastDeath && !sawExit) sawExit = { ms: Date.now() - t0, reason: s.lastDeath.reason, message: s.lastDeath.message };
        if (!(s?.phase === "ready" && s.session !== session0)) return null;
        return (await badge()) === "2" && (await diagText()).split("\n").includes("42") ? s : null;
      }, 300000, 200);
      const d = delta(s0, await stats());
      const ok = recovered.ok && sawExit?.reason === "exit" && sawExit.ms <= 10000 && d?.workerDeaths === 1 && d?.reboots === 1;
      record("exit-detected", ok,
        `death ${sawExit ? `'${sawExit.reason}' at ${sawExit.ms} ms (${sawExit.message})` : "NEVER seen"}; ready again ${recovered.ok} at ${recovered.ms} ms on a new session; stats ${JSON.stringify(d)}`,
        { exit: sawExit, recoveryMs: recovered.ms, stats: d });
    }
  }
} catch (e) {
  record("harness", false, `threw: ${String(e?.stack ?? e).slice(0, 400)}`);
} finally {
  fs.writeFileSync(path.join(dir, "liveness-console.log"), consoleLines.join("\n") + "\n");
  if (pageErrors.length) console.log(`page errors (${pageErrors.length}): ${pageErrors.slice(0, 5).join(" | ")}`);
  await browser.close().catch(() => {});
}
console.log(`liveness-faults: ${results.length - failed}/${results.length} pass; report ${path.relative(root, path.join(dir, "liveness-report.json"))}`);
if (!process.exitCode) process.exitCode = failed ? 1 : 0;
