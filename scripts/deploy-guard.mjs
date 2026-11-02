#!/usr/bin/env node
// The deploy guard (architecture review R19a). scripts/deploy-app.sh runs it
// after the size check and before the deploy step, also with --dry-run.
//
// Before every deploy, every .snapz that the tracked snapshot index
// (public/snapshots/index.json) names must already answer on the live origin.
// scripts/upload-artifacts.sh uploads them before the push; a push that comes
// before its upload deploys nothing (lean4game's 90 s window on 2026-10-09;
// QED64's 2026-10-08 outage, HARDENING #64, was the reverse order: an upload before its deploy).
//
// It checks only site-owned files. Every QED64 Worker, old or new, serves
// /snapshots/*.snapz from the same bucket-root key, so the live Worker answers
// for exactly the bytes the new deploy will read.
//
// It never checks release-mapped paths (/runtime/*, /profiles/<not index.json>)
// through the origin. The live Worker maps them into ITS release, so a new
// release's chunk names would 404 and its fixed-name manifests would give a
// false pass. That check belongs to upload-artifacts.sh, which requires the
// release's release.json in R2. Every adoption rebakes the snapshots under new
// names, so the guard also refuses an adoption pushed before its upload.
//
// One HEAD per entry (redirects not followed, 20 s each); a 5xx, a network
// error or a timeout is retried after 2 s and again after 4 s (three tries).
// It reads no body. A 200 with a Content-Length must carry the index's size
// (transfer, else bytes); a Worker from before 2026-11 (QED64_LEGACY,
// artifactHead "get") sends none on HEAD, so against it the check is the
// status alone; the hardened Worker answers HEAD with the length, so the
// sizes are checked (docs/DEPLOY.md). The
// first refusal stops the check.
//
// Usage: [QED64_DEPLOY_ORIGIN=<url>|none] node scripts/deploy-guard.mjs [--index <file>] [--origin <url>]
//   --index   the snapshot index (default <repo>/public/snapshots/index.json)
//   --origin  the live origin (default $QED64_DEPLOY_ORIGIN, else fetch-artifacts'
//             DEFAULT_ORIGIN, the one place the live origin is written)
//   QED64_DEPLOY_ORIGIN=none skips the check (a first deploy: no live origin yet).
// Every line goes to stderr, each starting `deploy-guard: `: one `live …` line
// per snapshot, then `OK …`, or a last `deploy-guard: REFUSED: …` line.
// Exit 0 every snapshot is live (or skipped), 1 refused, 2 a bad argument (with
// the usage line). --help prints the usage on stdout and exits 0. Read-only;
// Node built-ins plus one constant.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORIGIN } from "../pipeline/release/fetch-artifacts.mjs";

export { DEFAULT_ORIGIN };
const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_INDEX = path.join(ROOT, "public", "snapshots", "index.json");
export const USAGE = "usage: [QED64_DEPLOY_ORIGIN=<url>|none] node scripts/deploy-guard.mjs [--index <file>] [--origin <url>]";
const PREFIX = "deploy-guard: ";
const INDEX_SCHEMA = "qed64.snapshot-index/v1";
const SNAPZ_URL = /^\/snapshots\/[A-Za-z0-9][A-Za-z0-9._-]*\.snapz$/;
const TRIES = 3;
const RETRY_MS = [2000, 4000];
const HEAD_TIMEOUT_MS = 20_000;

/** A refusal: the index or the origin cannot be checked as given. */
export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

const show = (v) => JSON.stringify(v) ?? String(v);

/** The .snapz entries of a snapshot index, `{ name, url, size }` (size = transfer ?? bytes). Throws a Refusal. */
export function entriesOf(indexFile) {
  let text;
  try {
    text = fs.readFileSync(indexFile, "utf8");
  } catch (e) {
    throw new Refusal(`index ${indexFile} cannot be read (${e?.code ?? e?.message ?? e})`);
  }
  let index;
  try {
    index = JSON.parse(text);
  } catch (e) {
    throw new Refusal(`index ${indexFile} is not JSON (${e?.message ?? e})`);
  }
  if (index === null || typeof index !== "object" || index.schema !== INDEX_SCHEMA || !Array.isArray(index.snapshots)) {
    throw new Refusal(`index ${indexFile} is not a ${INDEX_SCHEMA} index with a snapshots array`);
  }
  return index.snapshots.map((entry, i) => {
    if (entry === null || typeof entry !== "object") throw new Refusal(`index ${indexFile}: snapshots[${i}] is not an object`);
    const name = typeof entry.name === "string" && entry.name ? entry.name : `#${i}`;
    if (typeof entry.url !== "string" || !SNAPZ_URL.test(entry.url)) {
      throw new Refusal(`snapshot ${name} names ${show(entry.url)}, not a .snapz directly under /snapshots/`);
    }
    const size = entry.transfer ?? entry.bytes;
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Refusal(`snapshot ${name} (${entry.url}) gives ${show(size)} as its size (transfer ?? bytes), not a positive integer`);
    }
    return { name, url: entry.url, size };
  });
}

const why = (e) => {
  if (e?.name === "TimeoutError") return `no answer in ${HEAD_TIMEOUT_MS / 1000} s`;
  const cause = e?.cause;
  return String(cause?.code ?? cause?.message ?? e?.message ?? e);
};

/** One HEAD with retries: `{ status, length }` for any status below 500, else `{ status: null, error }` after three tries. */
async function head(href, fetchImpl, sleep, note) {
  let error = "";
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetchImpl(href, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(HEAD_TIMEOUT_MS) });
      try { await res.body?.cancel(); } catch {}
      if (res.status < 500) {
        const header = res.headers.get("content-length");
        return { status: res.status, length: header === null ? null : Number(header) };
      }
      error = `HTTP ${res.status}`;
    } catch (e) {
      error = why(e);
    }
    if (attempt < TRIES) {
      const ms = RETRY_MS[attempt - 1];
      note(`${href}: ${error}; try ${attempt + 1} of ${TRIES} in ${ms / 1000} s`);
      await sleep(ms);
    }
  }
  return { status: null, error };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HEAD every .snapz of `index` on `origin`, in index order, stopping at the first refusal.
 * Resolves `{ ok, lines }` (each line starts `deploy-guard: `; a refusal is the last line); never rejects.
 */
export async function checkLiveSnapshots({ index = DEFAULT_INDEX, origin = DEFAULT_ORIGIN, fetchImpl = fetch, sleep = defaultSleep } = {}) {
  const lines = [];
  const say = (line) => lines.push(PREFIX + line);
  const refuse = (line) => {
    say(`REFUSED: ${line}`);
    return { ok: false, lines };
  };
  try {
    let base;
    try {
      base = new URL(origin);
    } catch {
      throw new Refusal(`origin ${show(origin)} is not an http(s) URL`);
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Refusal(`origin ${show(origin)} is not an http(s) URL`);
    const entries = entriesOf(index);
    for (const { url, size } of entries) {
      const href = new URL(url, base).href;
      const r = await head(href, fetchImpl, sleep, (line) => say(`retry ${line}`));
      if (r.status === null) return refuse(`${url}: ${href} could not be reached (${r.error}, ${TRIES} tries)`);
      if (r.status !== 200) return refuse(`${url}: HTTP ${r.status} from ${href} — upload it first (scripts/upload-artifacts.sh), then re-run the deploy`);
      if (r.length !== null && r.length !== size) {
        return refuse(`${url}: ${href} answers ${r.length} bytes, the index says ${size} — R2 holds other bytes under this name`);
      }
      say(`live ${url} (${r.length === null ? "no length: the live Worker sends none on HEAD" : `${r.length} bytes`})`);
    }
    say(`OK ${entries.length} snapshot(s) live on ${base.href}`);
    return { ok: true, lines };
  } catch (e) {
    return refuse(e instanceof Refusal ? e.message : `unexpected error: ${e?.stack ?? e}`);
  }
}

const defaultIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/**
 * The CLI: 0 every snapshot live (or skipped), 1 refused, 2 a bad argument. Lines go to io.err, the usage of
 * --help to io.out. io.fetchImpl and io.sleep replace fetch and the retry wait (tests).
 */
export async function main(argv = process.argv.slice(2), env = process.env, io = defaultIo) {
  const err = io.err ?? defaultIo.err;
  const out = io.out ?? defaultIo.out;
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      out(USAGE);
      return 0;
    }
    const m = /^--(index|origin)(?:=(.*))?$/s.exec(arg);
    const value = m ? (m[2] ?? argv[++i]) : undefined;
    if (!m || value === undefined || value === "" || Object.hasOwn(flags, m[1])) {
      err(`${PREFIX}${!m ? `unknown argument: ${arg}` : Object.hasOwn(flags, m[1]) ? `--${m[1]} given twice` : `--${m[1]} needs a value`}`);
      err(USAGE);
      return 2;
    }
    flags[m[1]] = value;
  }
  const envOrigin = env.QED64_DEPLOY_ORIGIN || undefined;
  if (flags.origin === undefined && envOrigin === "none") {
    err(`${PREFIX}SKIPPED: QED64_DEPLOY_ORIGIN=none (a first deploy: no live origin to ask yet)`);
    return 0;
  }
  const result = await checkLiveSnapshots({
    index: flags.index === undefined ? DEFAULT_INDEX : path.resolve(flags.index),
    origin: flags.origin ?? envOrigin ?? DEFAULT_ORIGIN,
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
    ...(io.sleep ? { sleep: io.sleep } : {}),
  });
  for (const line of result.lines) err(line);
  return result.ok ? 0 : 1;
}

// Run as a CLI only when this file is the main module (realpaths: a symlinked path keeps argv[1]'s link path).
const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exitCode = await main();
