#!/usr/bin/env node
// Shared plumbing for the adversarial harness (review C7, migration phase 0):
//   - resolveTarget(url): the runtime/snapshot pairing a page URL will boot
//     (the same ?runtime= / ?snapshots= rules as qed64-boot.ts), so
//     preflight, e2e and the gauntlets agree on what "the run" is;
//   - runDir(): one directory per run, work/adversarial/runs/<ts>-<buildId>-<mode>/,
//     so a report is never overwritten by the next lane (`mode` is the
//     constant "resident" since the pump transport left the page, 2026-09-04;
//     the field survives so run-dir names and old report readers keep their shape);
//   - teeLog(): console output mirrored into that directory;
//   - coolDown(): the between-browser-lanes discipline of HARDENING #34
//     (refuse while a chrome-headless-shell exists — `--kill-strays` to kill
//     them instead — then wait for free+inactive memory). The memory reading
//     is macOS vm_stat, else Linux /proc/meminfo, else os.freemem() (free
//     pages only, so it waits longer); with none of them it prints
//     `cool-down: REFUSED — no memory reading (…)` and refuses.
// CLI (for shell callers such as resident-gate.sh):
//   node tests/adversarial/harness.mjs run-dir --url <url>     → prints the run dir
//   node tests/adversarial/harness.mjs cooldown [--cooldown-gb 6] [--cooldown-max-s 180] [--kill-strays]
//     exit 0: fit to start a browser; 3: refused (a stray browser, memory not
//     back within --cooldown-max-s, or no memory reading); 2: usage.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
export const has = (f) => process.argv.includes(f);

// MODE, resolveTarget and fetchJson live in the pipeline (preflight ships
// in the package and needs them); re-exported here for the lanes.
export { MODE, fetchJson, resolveTarget } from "../../pipeline/release/page-target.mjs";
import { fetchJson, resolveTarget } from "../../pipeline/release/page-target.mjs";

/** `--only` matches a WHOLE scenario name (a plain name exactly; a pattern
 * anchored), never a substring: `--only import-composition` used to also run
 * unresolvable-import-composition, which made single-scenario verdicts lie. */
export function onlyMatches(name, pattern) {
  return /[\\^$.*+?()[\]{}|]/.test(pattern) ? new RegExp(`^(?:${pattern})$`).test(name) : name === pattern;
}

/** Terminal class of a status phase — the enum `qed64.status().phase`
 * reports (the relay's `halted` on top of the front door's phases); the
 * names are the ones the corpus's `expect.terminal` uses. */
export function settleClassFromPhase(phase) {
  return phase === "ready" ? "ready" : phase === "headerRefused" ? "headerUnresolvable" : phase === "halted" ? "halted" : null;
}
/** The same classes read off the pill label (main.ts PHASE_LABEL, plus the
 * "halted — <reason>" form the pill takes after a breaker trip on a session
 * that had been ready) — the fallback for a page that exposes no status tap,
 * and what the gauntlet's console/pill watch reads. */
export function settleClass(pill) {
  return /^ready$/.test(pill) ? "ready" : /imports (incomplete|failed)/.test(pill) ? "headerUnresolvable" : /keeps crashing|^halted/.test(pill) ? "halted" : null;
}

export const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** Create (or reuse via --run-dir) the per-run report directory. */
export function runDir(buildId, mode, explicit = arg("run-dir", "")) {
  const dir = explicit ? path.resolve(root, explicit) : path.join(root, "work/adversarial/runs", `${stamp()}-${buildId}-${mode}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Mirror console.log/console.error into <dir>/<name> (append). */
export function teeLog(dir, name) {
  const file = path.join(dir, name);
  // Synchronous appends: a line printed just before process.exit (a refusal) still lands
  // (a write stream had not even opened the file by then, so the log was lost).
  const fd = fs.openSync(file, "a");
  const wrap = (orig) => (...a) => { const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); fs.writeSync(fd, line + "\n"); orig(...a); };
  console.log = wrap(console.log.bind(console));
  console.error = wrap(console.error.bind(console));
  return file;
}

/** Reclaimable bytes in macOS `vm_stat` output: free + inactive +
 * speculative pages (a dead page's committed shared memory drains into
 * "inactive" slowly — HARDENING #26/#34). null when it has no page size or
 * no "Pages free" line. */
export function parseVmStat(text) {
  const vm = String(text ?? "");
  const page = /page size of (\d+) bytes/.exec(vm);
  const n = (label) => { const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(vm); return m ? Number(m[1]) : null; };
  const free = n("Pages free");
  if (!page || free === null) return null;
  return (free + (n("Pages inactive") ?? 0) + (n("Pages speculative") ?? 0)) * Number(page[1]);
}

/** Reclaimable bytes in Linux /proc/meminfo: MemAvailable, else (kernels
 * before 3.14) MemFree + Buffers + Cached; null when neither is there. */
export function parseMeminfo(text) {
  const kb = (field) => { const m = new RegExp(`^${field}:\\s+(\\d+) kB\\s*$`, "m").exec(String(text ?? "")); return m ? Number(m[1]) * 1024 : null; };
  const available = kb("MemAvailable");
  if (available !== null) return available;
  const free = kb("MemFree");
  return free === null ? null : free + (kb("Buffers") ?? 0) + (kb("Cached") ?? 0);
}

/** Where the memory reading comes from, and the bytes: vm_stat on macOS,
 * else /proc/meminfo, else os.freemem() (free pages only: on macOS it
 * undercounts, so the cool-down waits longer, never shorter). With none:
 * `{ bytes: null, reason }`. The probes are injectable for the unit test. */
export function memoryReading({
  platform = process.platform,
  vmStat = () => spawnSync("vm_stat", { encoding: "utf8" }),
  meminfo = () => fs.readFileSync("/proc/meminfo", "utf8"),
  freemem = () => os.freemem(),
} = {}) {
  const tried = [];
  if (platform === "darwin") {
    const r = vmStat();
    const bytes = r.error ? null : parseVmStat(r.stdout ?? "");
    if (bytes !== null) return { bytes, source: "vm_stat (free + inactive + speculative)" };
    tried.push(r.error ? `vm_stat ${r.error.code ?? r.error.message}` : `vm_stat printed no page counts (exit ${r.status})`);
  }
  try {
    const bytes = parseMeminfo(meminfo());
    if (bytes !== null) return { bytes, source: "/proc/meminfo" };
    tried.push("/proc/meminfo has no MemAvailable or MemFree");
  } catch (e) { tried.push(`/proc/meminfo ${e.code ?? e.message}`); }
  try {
    const bytes = freemem();
    if (Number.isFinite(bytes) && bytes > 0) return { bytes, source: "os.freemem() (free pages only)" };
    tried.push(`os.freemem() returned ${bytes}`);
  } catch (e) { tried.push(`os.freemem() threw ${e.message}`); }
  return { bytes: null, reason: `no memory reading (${tried.join("; ")})` };
}

/** Bytes the OS could hand a new browser right now (memoryReading; 0 when there is no reading). */
export function reclaimableBytes() {
  return memoryReading().bytes ?? 0;
}

/** `pid cmdline` lines of every live chrome-headless-shell (pgrep -fl prints
 * the full argument list on both BSD and procps). */
export const strayBrowsers = () => (spawnSync("pgrep", ["-fl", "chrome-headless-shell"], { encoding: "utf8" }).stdout || "").split("\n").filter(Boolean);

/** Between browser lanes: a chrome-headless-shell that is not ours is either
 * a leak from a probe that died before browser.close() (HARDENING #34) or a
 * SIBLING RUN's live browser — parallel worktree tracks and interactive
 * sessions run Playwright on this machine at the same time, so the default
 * is to refuse (the spec's rule) and list what is there; `--kill-strays`
 * opts into SIGKILL for the unattended re-run case. Then wait for memory to
 * come back. Returns false (and logs why) when the machine is not fit to
 * start a browser. */
export async function coolDown({ minFreeGB = Number(arg("cooldown-gb", "6")), maxWaitS = Number(arg("cooldown-max-s", "180")), killStrays = has("--kill-strays"), log = console.log, reading = memoryReading, strays: listStrays = strayBrowsers } = {}) {
  let strays = listStrays();
  if (strays.length && killStrays) {
    log(`cool-down: --kill-strays — SIGKILL ${strays.length} chrome-headless-shell process(es):\n  ${strays.map((s) => s.slice(0, 160)).join("\n  ")}`);
    spawnSync("pkill", ["-9", "-f", "chrome-headless-shell"]);
    await new Promise((r) => setTimeout(r, 2000));
    strays = listStrays();
  }
  if (strays.length) {
    log(`cool-down: ${strays.length} chrome-headless-shell process(es) alive${killStrays ? " after SIGKILL" : " (another run's, or a leak — pass --kill-strays to kill leaks)"} — refusing to start a browser lane:\n  ${strays.map((s) => s.slice(0, 160)).join("\n  ")}`);
    return false;
  }
  const need = minFreeGB * 1024 ** 3;
  const t0 = Date.now();
  let source = null;
  for (;;) {
    const r = reading();
    if (r.bytes === null) { log(`cool-down: REFUSED — ${r.reason}`); return false; }
    if (r.source !== source) { source = r.source; log(`cool-down: memory from ${source}`); }
    const have = r.bytes;
    const gb = (have / 1024 ** 3).toFixed(1);
    if (have >= need) { log(`cool-down: ${gb} GB reclaimable (need ${minFreeGB}) after ${((Date.now() - t0) / 1000).toFixed(0)} s — ok`); return true; }
    if (Date.now() - t0 > maxWaitS * 1000) { log(`cool-down: only ${gb} GB reclaimable after ${maxWaitS} s (need ${minFreeGB}) — refusing to start a browser lane`); return false; }
    log(`cool-down: ${gb} GB reclaimable, waiting for ${minFreeGB} …`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/** The battery's argv as run.mjs starts it: the run dir, then each of
 * --snap/--artifact/--lib that run.mjs itself was given (else the battery's
 * own variables and deprecated defaults apply). */
export function batteryArgv(dir, get = arg) {
  return ["--run-dir", dir, ...["snap", "artifact", "lib"].flatMap((f) => (get(f, "") ? [`--${f}`, get(f, "")] : []))];
}

/** run.mjs's exit code: 3 = a lane refused (infra; the battery's 2 is its
 * path-rule refusal: no pairing resolved), 1 = product failures, 0 = green. */
export function suiteExitCode(compilerCode, e2eCode) {
  return compilerCode === 3 || compilerCode === 2 || e2eCode === 3 ? 3 : compilerCode || e2eCode ? 1 : 0;
}

/** The merged report's lane sections. A lane that ran (code non-null) yet left
 * no report is one REFUSED line, never silently absent; a battery report that
 * carries `refused` (its path-rule exit 2) says so above its infra rows. */
export function laneSections(lanes) {
  const lines = [];
  for (const { name, report: lane, code, log } of lanes) {
    if (!lane) {
      if (code !== null && code !== undefined && code !== 0) lines.push(`## ${name}: ${code === 2 || code === 3 ? "REFUSED" : "NO REPORT"} (exit ${code}: no ${name}-report.json was written; see ${log})`, "");
      continue;
    }
    const by = (o) => lane.results.filter((r) => (r.outcome ?? (r.pass ? "pass" : "fail")) === o).length;
    lines.push(`## ${lane.lane}: ${by("pass")}/${lane.total} passed (fail ${by("fail")}, infra ${by("infra")}, aborted ${by("aborted")})`, "");
    if (lane.refused) lines.push(`**REFUSED (exit ${code ?? "?"}):** ${lane.refused}`, "");
    for (const r of lane.results.filter((x) => (x.outcome ?? (x.pass ? "pass" : "fail")) !== "pass")) {
      const o = (r.outcome ?? "fail").toUpperCase();
      lines.push(`- **${o}** \`${r.name}\` [${r.category}] — ${r.detail ?? (r.failures || []).join("; ")}${r.screenshot ? ` (screenshot: ${r.screenshot})` : ""}`);
    }
    lines.push("");
  }
  return lines;
}

// CLI entry (shell callers).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === "run-dir") {
    const target = resolveTarget(arg("url", "http://localhost:5184/"));
    const manifest = await fetchJson(target.manifestUrl).catch(() => null);
    process.stdout.write(runDir(manifest?.buildId ?? "unknown", target.mode) + "\n");
  } else if (cmd === "cooldown") {
    process.exit((await coolDown()) ? 0 : 3);
  } else {
    console.error("usage: harness.mjs run-dir --url <url> | cooldown [--cooldown-gb N] [--cooldown-max-s N]");
    process.exit(2);
  }
}
