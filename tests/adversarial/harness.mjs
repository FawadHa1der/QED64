#!/usr/bin/env node
// Shared plumbing for the adversarial harness (review C7, migration phase 0):
//   - resolveTarget(url): the runtime/snapshot pairing a page URL will boot
//     (the same ?runtime= / ?snapshots= / ?resident= rules as qed64-boot.ts),
//     so preflight, e2e and the gauntlets agree on what "the run" is;
//   - runDir(): one directory per run, work/adversarial/runs/<ts>-<buildId>-<mode>/,
//     so a report is never overwritten by the next lane;
//   - teeLog(): console output mirrored into that directory;
//   - coolDown(): the between-browser-lanes discipline of HARDENING #34
//     (refuse while a chrome-headless-shell exists — `--kill-strays` to kill
//     them instead — then wait for free+inactive memory).
// CLI (for shell callers such as resident-gate.sh):
//   node tests/adversarial/harness.mjs run-dir --url <url>     → prints the run dir
//   node tests/adversarial/harness.mjs cooldown [--cooldown-gb 6] [--cooldown-max-s 180] [--kill-strays]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
export const has = (f) => process.argv.includes(f);

/** What a page at `url` will boot: manifest and snapshot-index URLs, mode. */
export function resolveTarget(url) {
  const u = new URL(url);
  const runtimeOverride = u.searchParams.get("runtime");
  const snapshotsDir = u.searchParams.get("snapshots") || "snapshots";
  const mode = u.searchParams.get("resident") === "0" ? "pump" : "resident"; // resident is the default transport
  return {
    url: u.toString(),
    origin: u.origin,
    mode,
    runtimeOverride,
    snapshotsDir,
    manifestUrl: `${u.origin}/runtime/runtime-manifest${runtimeOverride ? `.${runtimeOverride}` : ""}.json`,
    indexUrl: `${u.origin}/${snapshotsDir}/index.json`,
    profilesUrl: `${u.origin}/profiles/index.json`,
  };
}

/** GET a JSON document; throws with a one-line reason on any failure
 * (status, content type, parse) so callers can classify it as infra. */
export async function fetchJson(url, timeoutMs = 15000) {
  const r = await fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const ct = r.headers.get("content-type") ?? "";
  const text = await r.text();
  // Vite's SPA fallback answers every unknown path with index.html (200,
  // text/html) — the exact shape that let a whole gate run unbootable.
  if (/text\/html/i.test(ct) || /^\s*<!doctype html/i.test(text)) throw new Error(`${url}: served HTML (SPA fallback), not JSON`);
  try { return JSON.parse(text); } catch (e) { throw new Error(`${url}: not JSON (${String(e).slice(0, 60)})`); }
}

/** `--only` matches a WHOLE scenario name (a plain name exactly; a pattern
 * anchored), never a substring: `--only import-composition` used to also run
 * unresolvable-import-composition, which made single-scenario verdicts lie. */
export function onlyMatches(name, pattern) {
  return /[\\^$.*+?()[\]{}|]/.test(pattern) ? new RegExp(`^(?:${pattern})$`).test(name) : name === pattern;
}

/** The terminal class a pill label settles in (pump-era labels); the enum
 * names are the ones `expect.terminal` uses so the corpus survives the move
 * to a phase enum tap (attacks.txt #3). */
/** Terminal class of a status phase (the enum the front door / shim report). */
export function settleClassFromPhase(phase) {
  return phase === "ready" ? "ready" : phase === "headerRefused" ? "headerUnresolvable" : phase === "halted" ? "halted" : null;
}
export function settleClass(pill) {
  return /^ready$/.test(pill) ? "ready" : /imports (incomplete|failed)/.test(pill) ? "headerUnresolvable" : /keeps crashing/.test(pill) ? "halted" : null;
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
  const out = fs.createWriteStream(file, { flags: "a" });
  const wrap = (orig) => (...a) => { const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); out.write(line + "\n"); orig(...a); };
  console.log = wrap(console.log.bind(console));
  console.error = wrap(console.error.bind(console));
  return file;
}

/** Bytes the OS could hand a new browser right now: free + inactive on
 * macOS (a dead page's committed shared memory drains into "inactive"
 * slowly — HARDENING #26/#34), MemAvailable on Linux. */
export function reclaimableBytes() {
  if (process.platform === "darwin") {
    const vm = spawnSync("vm_stat", { encoding: "utf8" }).stdout || "";
    const page = Number((/page size of (\d+)/.exec(vm) || [])[1] || 16384);
    const n = (label) => Number((new RegExp(`${label}:\\s+(\\d+)`).exec(vm) || [])[1] || 0);
    return (n("Pages free") + n("Pages inactive") + n("Pages speculative")) * page;
  }
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    return Number((/MemAvailable:\s+(\d+)/.exec(mi) || [])[1] || 0) * 1024;
  } catch { return os.freemem(); }
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
export async function coolDown({ minFreeGB = Number(arg("cooldown-gb", "6")), maxWaitS = Number(arg("cooldown-max-s", "180")), killStrays = has("--kill-strays"), log = console.log } = {}) {
  let strays = strayBrowsers();
  if (strays.length && killStrays) {
    log(`cool-down: --kill-strays — SIGKILL ${strays.length} chrome-headless-shell process(es):\n  ${strays.map((s) => s.slice(0, 160)).join("\n  ")}`);
    spawnSync("pkill", ["-9", "-f", "chrome-headless-shell"]);
    await new Promise((r) => setTimeout(r, 2000));
    strays = strayBrowsers();
  }
  if (strays.length) {
    log(`cool-down: ${strays.length} chrome-headless-shell process(es) alive${killStrays ? " after SIGKILL" : " (another run's, or a leak — pass --kill-strays to kill leaks)"} — refusing to start a browser lane:\n  ${strays.map((s) => s.slice(0, 160)).join("\n  ")}`);
    return false;
  }
  const need = minFreeGB * 1024 ** 3;
  const t0 = Date.now();
  for (;;) {
    const have = reclaimableBytes();
    const gb = (have / 1024 ** 3).toFixed(1);
    if (have >= need) { log(`cool-down: ${gb} GB reclaimable (need ${minFreeGB}) after ${((Date.now() - t0) / 1000).toFixed(0)} s — ok`); return true; }
    if (Date.now() - t0 > maxWaitS * 1000) { log(`cool-down: only ${gb} GB reclaimable after ${maxWaitS} s (need ${minFreeGB}) — refusing to start a browser lane`); return false; }
    log(`cool-down: ${gb} GB reclaimable, waiting for ${minFreeGB} …`);
    await new Promise((r) => setTimeout(r, 5000));
  }
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
