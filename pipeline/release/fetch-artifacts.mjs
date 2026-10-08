#!/usr/bin/env node
// Fill a public/-shaped tree with every binary QED64's tracked manifests name,
// verified (plan step A3b, docs/CLI-CONTRACT.md "fetch-artifacts"). A fresh
// clone has the manifests (git) but none of the bytes they pin (gitignored:
// runtime chunks, profile pack parts, snapshot .snapz); this puts them in place.
//
// What is fetched, from the manifests under --manifests (default: this
// checkout's public/):
//   runtime    every chunk of runtime/runtime-manifest.json (chunk sha256 and
//              size, then each whole file's sha256 and size over its chunks),
//              plus runtime/runtime-manifest.<buildId>.json, the digest-named
//              copy the page reads first: written from the tracked manifest's
//              own bytes, never fetched;
//   profiles   the transport parts of every profile manifest profiles/index.json
//              lists (each part's digest and byteLength, then the transport's),
//              plus snapshots/profiles-index.<buildId>.json, the per-build copy
//              of the index a pinned shell reads when the mutable one names
//              another runtime (HARDENING #64; buildId
//              = the index's runtime.buildId): written from the tracked
//              index's own bytes, never fetched;
//   snapshots  every .snapz of snapshots/index.json (digest and transfer size),
//              plus snapshots/index.<buildId>.json, its per-build copy (buildId
//              = the one runtime its entries name), written the same way.
// Sources:
//   --release <dir|url>  a fork release in the served layout (release.json,
//                        schema lean4-wasm64.release/v1): /runtime/* and
//                        /profiles/* through its hosting.mount, each file also
//                        checked against the release's files[] sha256 and bytes;
//   --origin <url|dir>   a live QED64 site (default below): everything else.
//                        Snapshots and /profiles/index.json are site-owned
//                        (release.json hosting.siteOwned): always the origin's
//                        or the tracked file, never the release's.
// Every write is a temp file in the target's directory, verified, then renamed;
// a file already present with the pinned digest is skipped; nothing is written
// outside --out (manifest URLs are confined to their group's directory, and a
// symlink out of the tree is refused before anything is written). One summary
// line on stdout: `FETCH OK …` or `FETCH FAILED <reason>` (one line: newlines in
// a reason are folded to spaces); progress on stderr. Temp files are swept: an
// interrupted run (SIGINT/SIGTERM, as the CLI) deletes its own before it exits,
// and every run first deletes the ones a dead process left beside its targets.
// Exit 0 ok, 1 a failed fetch or verification (the bad temp file is deleted),
// 2 refused before any write (usage, unreadable manifests, a path outside the
// root), 130/143 interrupted by SIGINT/SIGTERM. Node built-ins only.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseCli } from "../snapshot/cli.mjs";

export const DEFAULT_ORIGIN = "https://qed64.fawadworkaddress.workers.dev/";
export const GROUPS = ["runtime", "profiles", "snapshots"];
export const RELEASE_SCHEMA = "lean4-wasm64.release/v1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOOL = "fetch-artifacts";
/** The directory each group's manifest URLs must stay in (one path segment below it). */
const URL_DIRS = { runtime: "/runtime/chunks/", profiles: "/profiles/", snapshots: "/snapshots/" };
const IDLE_MS = 120_000;
/** Exit codes of an interrupted CLI run (128 + the signal number). */
const SIGNAL_EXITS = { SIGINT: 130, SIGTERM: 143 };
/** Every temp file this process has open and not yet renamed or removed (the signal path deletes them). */
const liveTemps = new Set();
/** A temp file's name: `.<target basename>.<pid>-<8 hex>.tmp`. */
const TEMP_NAME = /^\.(.+)\.(\d+)-[0-9a-f]{8}\.tmp$/;

/** A failure with an exit code: 1 = the job ran and failed, 2 = refused before any write, 130/143 = interrupted. */
export class FetchFailure extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
const refuse = (message) => new FetchFailure(message, 2);

const hex = (d) => { const m = /^(?:sha256:)?([0-9a-f]{64})$/.exec(String(d ?? "")); return m ? m[1] : null; };
const inside = (p, root) => { const rel = path.relative(root, p); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
const isUrl = (s) => /^https?:\/\//i.test(s);
/** A failure reason on one line: the summary is exactly one stdout line, whatever a parse error quotes. */
export const oneLine = (message) => String(message).replace(/\s*[\r\n]+\s*/g, " ");
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/** Delete the temp files a dead process left in `dir` for the target basenames `names`; returns what it removed. */
export async function sweepStaleTemps(dir, names) {
  let entries;
  try { entries = await fsp.readdir(dir); } catch (e) { if (e.code === "ENOENT" || e.code === "ENOTDIR") return []; throw e; }
  const removed = [];
  for (const name of entries) {
    const m = TEMP_NAME.exec(name);
    if (!m || !names.has(m[1])) continue;
    const pid = Number(m[2]);
    const file = path.join(dir, name);
    if (liveTemps.has(file) || (pid !== process.pid && alive(pid))) continue;
    await fsp.rm(file, { force: true });
    removed.push({ file, pid });
  }
  return removed;
}

/** The site path of a manifest URL, confined to `group`'s directory, without its leading slash. */
export function sitePath(group, url, where) {
  const dir = URL_DIRS[group];
  const s = String(url ?? "");
  if (!s.startsWith(dir) || !/^[A-Za-z0-9._-]+$/.test(s.slice(dir.length)) || /^\.+$/.test(s.slice(dir.length))) {
    throw refuse(`${where} names ${JSON.stringify(s)}, not a file directly under ${dir}: refusing to write outside the tree`);
  }
  return s.slice(1);
}

/** The runtime an index's per-build copy is named by: the one buildId all of
 * `ids` agree on, or null (none recorded, several, or not wasm64-<16 hex>: an
 * index that predates the pairing fields gets no copy, and the shell reads
 * the mutable path). */
function pinnedIndexId(ids) {
  const set = new Set(ids);
  const [id] = set;
  return set.size === 1 && /^wasm64-[0-9a-f]{16}$/.test(String(id)) ? id : null;
}

async function readTrackedJson(manifests, rel) {
  const file = path.join(manifests, rel);
  let text;
  try { text = await fsp.readFile(file); } catch (e) {
    throw refuse(`no tracked manifest ${file} (${e.code ?? e.message}); pass --manifests <dir>, a QED64 checkout's public/`);
  }
  try { return { file, bytes: text, json: JSON.parse(text.toString("utf8")) }; } catch (e) {
    throw refuse(`tracked manifest ${file} is not JSON (${e.message})`);
  }
}

/**
 * What the tracked manifests name for the chosen groups:
 *   items  [{ group, rel, bytes, sha256 }]  content-addressed files to fetch;
 *   wholes [{ label, rels, bytes, sha256 }] files whose concatenated parts are pinned too;
 *   copies [{ group, rel, data }]           files written from tracked bytes (never fetched): the
 *                                           per-build runtime manifest and index copies;
 *   manifests [{ group, rel, data }]        the tracked manifests themselves (--with-manifests);
 *   buildId                                 the runtime's, when runtime is chosen.
 * Throws FetchFailure(2) on a missing or malformed manifest, a URL outside its
 * group's directory, or one path pinned two ways.
 */
export async function planFromManifests(manifests, groups) {
  const plan = { items: [], wholes: [], copies: [], manifests: [], buildId: null };
  const seen = new Map();
  const add = (group, rel, bytes, sha256, where) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !sha256) throw refuse(`${where}: ${rel} has no usable size and sha256`);
    const prior = seen.get(rel);
    if (prior) {
      if (prior.bytes !== bytes || prior.sha256 !== sha256) throw refuse(`${rel} is pinned two ways (${where})`);
      return;
    }
    const item = { group, rel, bytes, sha256 };
    seen.set(rel, item);
    plan.items.push(item);
  };
  if (groups.includes("runtime")) {
    const rel = "runtime/runtime-manifest.json";
    const m = await readTrackedJson(manifests, rel);
    const { buildId, files } = m.json ?? {};
    if (!/^wasm64-[0-9a-f]{16}$/.test(String(buildId)) || !files || typeof files !== "object") throw refuse(`${m.file}: no buildId and files`);
    plan.buildId = buildId;
    for (const [name, f] of Object.entries(files)) {
      if (!Array.isArray(f?.chunks) || !f.chunks.length) throw refuse(`${m.file}: ${name} has no chunks`);
      const rels = f.chunks.map((c, i) => {
        const r = sitePath("runtime", c?.url, `${m.file} ${name} chunk ${i}`);
        add("runtime", r, c.bytes, hex(c.sha256), m.file);
        return r;
      });
      if (!hex(f.sha256) || !Number.isSafeInteger(f.bytes)) throw refuse(`${m.file}: ${name} has no whole-file sha256 and bytes`);
      plan.wholes.push({ label: `runtime ${name}`, rels, bytes: f.bytes, sha256: hex(f.sha256) });
    }
    plan.copies.push({ group: "runtime", rel: `runtime/runtime-manifest.${buildId}.json`, data: m.bytes, from: rel });
    plan.manifests.push({ group: "runtime", rel, data: m.bytes });
  }
  if (groups.includes("profiles")) {
    const rel = "profiles/index.json";
    const index = await readTrackedJson(manifests, rel);
    const profiles = index.json?.profiles;
    if (!Array.isArray(profiles)) throw refuse(`${index.file}: no profiles list`);
    plan.manifests.push({ group: "profiles", rel, data: index.bytes });
    const pinned = pinnedIndexId([index.json?.runtime?.buildId]);
    if (pinned) plan.copies.push({ group: "profiles", rel: `snapshots/profiles-index.${pinned}.json`, data: index.bytes, from: rel });
    for (const p of profiles) {
      const mrel = sitePath("profiles", p?.manifest, `${index.file} profile ${JSON.stringify(p?.id)}`);
      const m = await readTrackedJson(manifests, mrel);
      const t = m.json?.content?.pack?.transport;
      if (!Array.isArray(t?.parts) || !t.parts.length) throw refuse(`${m.file}: no content.pack.transport.parts`);
      const rels = t.parts.map((part, i) => {
        const r = sitePath("profiles", part?.url, `${m.file} part ${i}`);
        add("profiles", r, part.byteLength, hex(part.digest), m.file);
        return r;
      });
      if (!hex(t.digest) || !Number.isSafeInteger(t.byteLength)) throw refuse(`${m.file}: the transport has no digest and byteLength`);
      plan.wholes.push({ label: `${p.id} transport`, rels, bytes: t.byteLength, sha256: hex(t.digest) });
      plan.manifests.push({ group: "profiles", rel: mrel, data: m.bytes });
    }
  }
  if (groups.includes("snapshots")) {
    const rel = "snapshots/index.json";
    const index = await readTrackedJson(manifests, rel);
    const entries = index.json?.snapshots;
    if (!Array.isArray(entries)) throw refuse(`${index.file}: no snapshots list`);
    for (const e of entries) {
      const r = sitePath("snapshots", e?.url, `${index.file} snapshot ${JSON.stringify(e?.name)}`);
      add("snapshots", r, e.transfer ?? e.bytes, hex(e.digest), index.file);
    }
    const pinned = pinnedIndexId(entries.map((e) => e?.runtime));
    if (pinned) plan.copies.push({ group: "snapshots", rel: `snapshots/index.${pinned}.json`, data: index.bytes, from: rel });
    plan.manifests.push({ group: "snapshots", rel, data: index.bytes });
  }
  return plan;
}

/** A byte source: a directory or an http(s) base URL. `stream(rel)` yields the file's bytes. */
export function openSource(spec, what) {
  if (isUrl(spec)) {
    const base = new URL(spec.endsWith("/") ? spec : `${spec}/`);
    return {
      label: base.href,
      async stream(rel, signal) {
        const url = new URL(rel, base);
        let res;
        try { res = await fetch(url, { signal, cache: "no-store" }); } catch (e) {
          throw new FetchFailure(`${rel}: ${url.href} could not be fetched (${e.cause?.code ?? e.cause?.message ?? e.message})`);
        }
        if (!res.ok || !res.body) { await res.body?.cancel().catch(() => {}); throw new FetchFailure(`${rel}: HTTP ${res.status} from ${url.href}`); }
        return Readable.fromWeb(res.body);
      },
      async json(rel) {
        const s = await this.stream(rel);
        const chunks = [];
        for await (const c of s) chunks.push(c);
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      },
    };
  }
  const dir = path.resolve(spec);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw refuse(`${what} ${spec} is neither an http(s) URL nor a directory`);
  return {
    label: dir,
    async stream(rel) {
      const file = path.join(dir, rel);
      try { await fsp.access(file, fs.constants.R_OK); } catch (e) { throw new FetchFailure(`${rel}: not in ${dir} (${e.code})`); }
      return fs.createReadStream(file);
    },
    async json(rel) { return JSON.parse(await fsp.readFile(path.join(dir, rel), "utf8")); },
  };
}

/** Check a release.json against the plan; return a rel → release-path resolver for the release's mounts. */
export function releaseResolver(release, plan, groups) {
  if (release?.schema !== RELEASE_SCHEMA) throw new FetchFailure(`release.json schema is ${JSON.stringify(release?.schema)}, not ${RELEASE_SCHEMA}`);
  const hosting = release.hosting ?? {};
  if (hosting.layout !== "served") throw new FetchFailure(`release ${release.id}: hosting.layout is ${JSON.stringify(hosting.layout)}, not "served"`);
  if (groups.includes("runtime") && release.runtime?.buildId !== plan.buildId) {
    throw new FetchFailure(`release ${release.id} carries runtime ${release.runtime?.buildId}; the tracked manifests pin ${plan.buildId}`);
  }
  const files = new Map((Array.isArray(release.files) ? release.files : []).map((f) => [f.path, f]));
  const mounts = Object.entries(hosting.mount ?? {});
  const siteOwned = Array.isArray(hosting.siteOwned) ? hosting.siteOwned : [];
  return (item) => {
    const site = `/${item.rel}`;
    if (siteOwned.some((o) => (o.endsWith("/") ? site.startsWith(o) : site === o))) throw new FetchFailure(`${item.rel}: site-owned in release ${release.id} (hosting.siteOwned); take it from --origin`);
    const mount = mounts.find(([prefix]) => site.startsWith(prefix));
    if (!mount) throw new FetchFailure(`${item.rel}: release ${release.id} mounts no directory for it (hosting.mount)`);
    const rpath = mount[1] + site.slice(mount[0].length);
    const listed = files.get(rpath);
    if (!listed) throw new FetchFailure(`${item.rel}: release ${release.id} does not list ${rpath} in files[]`);
    if (listed.sha256 !== item.sha256 || listed.bytes !== item.bytes) {
      throw new FetchFailure(`${item.rel}: release ${release.id} lists ${rpath} as sha256 ${listed.sha256} (${listed.bytes} bytes); the tracked manifest pins ${item.sha256} (${item.bytes} bytes)`);
    }
    return rpath;
  };
}

/** sha256 and size of a file on disk, or null when it is absent. */
async function fileDigest(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return { bytes: -1, sha256: null };
    const h = createHash("sha256");
    for await (const c of fs.createReadStream(file)) h.update(c);
    return { bytes: st.size, sha256: h.digest("hex") };
  } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

/** The realpath of `p`, through its nearest existing ancestor. */
function realish(p) {
  let cur = p;
  const rest = [];
  while (!fs.existsSync(cur)) { rest.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(fs.realpathSync.native(cur), ...rest);
}

/** Stream `source` into a temp file beside `target`, verify size and sha256, rename. */
async function writeVerified(input, target, expect, rel, signal) {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  liveTemps.add(tmp);
  const h = createHash("sha256");
  let n = 0;
  let idle;
  const ac = new AbortController();
  const onAbort = () => ac.abort(signal.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new FetchFailure(`${rel}: no bytes for ${IDLE_MS / 1000} s`)), IDLE_MS); };
  try {
    arm();
    const stream = await input(ac.signal);
    await pipeline(
      stream,
      new Transform({
        transform(chunk, _enc, done) {
          arm();
          n += chunk.length;
          if (n > expect.bytes) return done(new FetchFailure(`${rel}: size mismatch (more than the ${expect.bytes} bytes the manifest pins)`));
          h.update(chunk);
          done(null, chunk);
        },
      }),
      fs.createWriteStream(tmp, { flags: "wx", flush: true }),
      { signal: ac.signal },
    );
    if (n !== expect.bytes) throw new FetchFailure(`${rel}: size mismatch (${n} bytes; the manifest pins ${expect.bytes})`);
    const got = h.digest("hex");
    if (got !== expect.sha256) throw new FetchFailure(`${rel}: digest mismatch (sha256 ${got}; the manifest pins ${expect.sha256})`);
    await fsp.rename(tmp, target);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    if (e instanceof FetchFailure) throw e;
    if (ac.signal.aborted && ac.signal.reason instanceof FetchFailure) throw ac.signal.reason;
    throw new FetchFailure(`${rel}: ${e.message}`);
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener("abort", onAbort);
    liveTemps.delete(tmp);
  }
}

/**
 * Fetch and verify. Options: out (dir), manifests (dir), only (group list),
 * release (dir|url|undefined), origin (dir|url), withManifests, concurrency,
 * log (a stderr line), signal (an AbortSignal: aborting stops the run, its
 * temp files deleted, and it rejects with the abort reason when that is a
 * FetchFailure). Resolves { files, bytes, fetched, present }; rejects with
 * FetchFailure (code 1 or 2, or the reason's).
 */
export async function fetchArtifacts({ out, manifests, only = GROUPS, release, origin = DEFAULT_ORIGIN, withManifests = false, concurrency = 4, log = () => {}, signal }) {
  const outRoot = path.resolve(out);
  const plan = await planFromManifests(path.resolve(manifests), only);
  const releaseSrc = release ? openSource(release, "--release") : null;
  // The origin serves what the release does not: everything without --release, else the snapshots.
  const originSrc = !releaseSrc || only.includes("snapshots") ? openSource(origin, "--origin") : null;
  let toRelease = null;
  if (releaseSrc) {
    let rj;
    try { rj = await releaseSrc.json("release.json"); } catch (e) { throw e instanceof FetchFailure ? e : new FetchFailure(`release.json: ${e.message}`); }
    toRelease = releaseResolver(rj, plan, only);
  }

  // Route and confine every target before anything is written.
  const rootReal = realish(outRoot);
  const jobs = plan.items.map((item) => {
    const target = path.resolve(outRoot, item.rel);
    if (!inside(target, outRoot) || !inside(realish(path.dirname(target)), rootReal)) throw refuse(`${item.rel} resolves outside --out ${outRoot}: refusing to write there`);
    const fromRelease = toRelease && item.group !== "snapshots";
    const srcRel = fromRelease ? toRelease(item) : item.rel;
    return { ...item, target, src: fromRelease ? releaseSrc : originSrc, srcRel };
  });
  const writes = [...plan.copies, ...(withManifests ? plan.manifests : [])].map((c) => {
    const target = path.resolve(outRoot, c.rel);
    if (!inside(target, outRoot) || !inside(realish(path.dirname(target)), rootReal)) throw refuse(`${c.rel} resolves outside --out ${outRoot}: refusing to write there`);
    return { ...c, target, bytes: c.data.length, sha256: createHash("sha256").update(c.data).digest("hex") };
  });

  for (const group of only) {
    const g = jobs.filter((j) => j.group === group);
    const from = [...new Set(g.map((j) => j.src.label))].join(", ") || "-";
    log(`${TOOL}: ${group}: ${g.length} files, ${g.reduce((s, j) => s + j.bytes, 0)} bytes from ${from}`);
  }

  // Temp files a dead process left beside these targets (an earlier run killed outright).
  const byDir = new Map();
  for (const t of [...jobs, ...writes]) {
    const dir = path.dirname(t.target);
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir).add(path.basename(t.target));
  }
  for (const [dir, names] of byDir) {
    for (const r of await sweepStaleTemps(dir, names)) log(`${TOOL}: removed ${path.relative(outRoot, r.file)}, a temp file left by process ${r.pid}`);
  }

  const stats = { files: 0, bytes: 0, fetched: 0, present: 0 };
  const ac = new AbortController();
  let failure = null;
  const stop = () => {
    if (failure) return;
    const r = signal.reason;
    failure = r instanceof FetchFailure ? r : new FetchFailure(`aborted (${r?.message ?? r})`);
    ac.abort(failure);
  };
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    let next = 0;
    const worker = async () => {
      while (!failure && next < jobs.length) {
        const j = jobs[next++];
        try {
          const have = await fileDigest(j.target);
          if (have && have.bytes === j.bytes && have.sha256 === j.sha256) {
            stats.present += 1;
            log(`${TOOL}: present ${j.rel} (${j.bytes} bytes, verified)`);
          } else {
            if (have) log(`${TOOL}: replacing ${j.rel}: the file there does not match its pin`);
            await writeVerified((signal) => j.src.stream(j.srcRel, signal), j.target, j, j.rel, ac.signal);
            stats.fetched += 1;
            log(`${TOOL}: fetched ${j.rel} (${j.bytes} bytes)`);
          }
          stats.files += 1;
          stats.bytes += j.bytes;
        } catch (e) {
          if (!failure) { failure = e instanceof FetchFailure ? e : new FetchFailure(`${j.rel}: ${e.message}`); ac.abort(failure); }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
    if (failure) throw failure;

    // Whole files: the concatenated parts, as the manifests pin them.
    for (const w of plan.wholes) {
      if (failure) throw failure;
      const h = createHash("sha256");
      let n = 0;
      for (const rel of w.rels) for await (const c of fs.createReadStream(path.resolve(outRoot, rel))) { h.update(c); n += c.length; }
      const got = h.digest("hex");
      if (n !== w.bytes || got !== w.sha256) throw new FetchFailure(`${w.label}: its parts assemble to ${n} bytes, sha256 ${got}; the manifest pins ${w.bytes} bytes, ${w.sha256}`);
      log(`${TOOL}: verified ${w.label} (${w.bytes} bytes, sha256 ${got.slice(0, 16)}…, ${w.rels.length} parts)`);
    }

    for (const c of writes) {
      if (failure) throw failure;
      const have = await fileDigest(c.target);
      if (have && have.sha256 === c.sha256) { stats.present += 1; log(`${TOOL}: present ${c.rel} (${c.bytes} bytes, verified)`); }
      else {
        await writeVerified(async () => Readable.from([c.data]), c.target, c, c.rel, ac.signal);
        stats.fetched += 1;
        log(`${TOOL}: wrote ${c.rel} (${c.bytes} bytes, the tracked ${c.from ?? c.rel})`);
      }
      stats.files += 1;
      stats.bytes += c.bytes;
    }
    if (failure) throw failure;
    return stats;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/** --only: a comma list of GROUPS, or null when malformed. */
export function parseOnly(value) {
  if (value === undefined) return [...GROUPS];
  const list = String(value).split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.some((g) => !GROUPS.includes(g))) return null;
  return GROUPS.filter((g) => list.includes(g));
}

/** Delete every temp file this process still has open, synchronously (the signal path). */
function removeLiveTemps() {
  for (const tmp of liveTemps) { try { fs.rmSync(tmp, { force: true }); } catch {} }
  liveTemps.clear();
}

const defaultIo = { out: (s) => console.log(s), err: (s) => console.error(s) };

/**
 * The CLI. Returns the exit code; `io` captures output in tests. Options:
 * repoRoot (whose public/ the default --out and --manifests are; tests),
 * handleSignals (the process entry point sets it: SIGINT/SIGTERM abort the
 * run, delete its temp files and resolve 130/143 with `FETCH FAILED
 * interrupted (<signal>)`; a second signal, or 5 s without the run ending,
 * exits the process at once after the same cleanup).
 */
export async function main(argv = process.argv.slice(2), io = defaultIo, { repoRoot = REPO_ROOT, handleSignals = false } = {}) {
  let exitCode = null;
  const parsed = parseCli("fetch-artifacts", argv, { out: io.out, err: io.err, exit: (c) => { exitCode = c; } });
  if (!parsed) return exitCode ?? 2;
  const v = parsed.values;
  let said = false;
  const failed = (e) => { if (!said) { said = true; io.out(`FETCH FAILED ${oneLine(e.message)}`); } return e.code ?? 1; };
  const only = parseOnly(v.only);
  if (!only) return failed(refuse(`--only ${v.only}: not a comma list of ${GROUPS.join(", ")}`));
  const out = v.out ?? path.join(repoRoot, "public");
  if (v.out === undefined && path.resolve(out).split(path.sep).includes("node_modules")) {
    return failed(refuse(`the default --out ${out} is inside node_modules (an installed package); pass --out <dir>`));
  }
  const ac = new AbortController();
  const onSignal = (sig) => {
    const interrupted = new FetchFailure(`interrupted (${sig})`, SIGNAL_EXITS[sig]);
    removeLiveTemps();
    if (ac.signal.aborted) return hardExit(interrupted);
    ac.abort(interrupted);
    setTimeout(() => hardExit(interrupted), 5_000).unref();
  };
  const hardExit = (e) => {
    removeLiveTemps();
    if (!said) {
      said = true;
      const line = `FETCH FAILED ${oneLine(e.message)}`;
      if (io === defaultIo) { try { fs.writeSync(1, `${line}\n`); } catch {} } else io.out(line);
    }
    process.exit(e.code);
  };
  const handlers = handleSignals ? Object.keys(SIGNAL_EXITS).map((sig) => [sig, () => onSignal(sig)]) : [];
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    const stats = await fetchArtifacts({
      out,
      manifests: v.manifests ?? path.join(repoRoot, "public"),
      only,
      release: v.release,
      origin: v.origin ?? DEFAULT_ORIGIN,
      withManifests: v["with-manifests"] === true,
      log: io.err,
      signal: ac.signal,
    });
    io.out(`FETCH OK ${stats.files} files, ${stats.bytes} bytes (${stats.fetched} fetched, ${stats.present} already present)`);
    return 0;
  } catch (e) {
    return failed(ac.signal.aborted ? ac.signal.reason : e instanceof FetchFailure ? e : new FetchFailure(e.message));
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

// Run as a CLI only when this file is the main module (realpaths: a symlinked install keeps argv[1]'s link path).
const invokedDirectly = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) process.exitCode = await main(undefined, undefined, { handleSignals: true });
