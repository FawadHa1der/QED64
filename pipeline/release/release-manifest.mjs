#!/usr/bin/env node
// The release manifest: ONE document naming everything a QED64 release
// serves — the qed64 commit, the lean4-wasm64 toolchain release (and so the
// kernel commit) that built the runtime, every runtime chunk, snapshot and
// pack part by sha256, the base trees the snapshots were baked from, and
// (with --dist) the app shell — so a downstream can pin a release by id and
// verify any copy of it.
// docs/RELEASE-BUNDLE.md is the reader's guide; this header is the contract.
//
// PURE FUNCTION OF ITS INPUTS. `--commit <rev>` reads every tracked input
// from the commit's tree (git cat-file — the raw blob `git show <rev>:<path>`
// prints), never from the working tree, so the same commit always yields the
// same bytes, on any machine, without network: no artifact is downloaded,
// digests and sizes come from the tracked manifests (the digest roots the
// browser already trusts), the pinned toolchain record
// toolchain/lean4-wasm64-release.json and embedding/base-tree.json.
// `--worktree` reads public/ and those two files as they are on disk instead
// — the state right after an adoption's landing, before the commit —
// and records whether any input it read differs from HEAD (`qed64.dirty`;
// with --dist that includes public/workers/*, a worker the tree lacks too).
//
// FORMAT. schema "qed64.release/v1"; key order is fixed by this file (every
// object is built literally, nothing is copied through from an input), the
// file is JSON.stringify(manifest, null, 2) + "\n", and
//   digest        = "sha256:" + sha256(JSON.stringify(manifest without `digest`))
//   artifactSetId = "set-" + sha256(JSON.stringify({ runtime, snapshots, profiles }))[:16]
//   releaseId     = "qed64-" + qed64.commit[:7]
//   shell.shellId = "shell-" + shell.listingSha256[:16]
// Fields named `sha256` or `<x>Sha256` are bare hex; `digest`/`contentDigest`
// keep the "sha256:" prefix (the convention of pack.mjs and the indexes).
// Every `path` is relative to the served origin root, which is public/ in git
// (gitBlob = git's blob id of public/<path>), except toolchain.record.path and
// baseTree.path (repo paths of unserved files) and the umbrella paths inside
// baseTree (relative to a base tree's root). R2 keys follow hosting.rule.
//
// REFUSALS (exit 1, one line on stderr): the pairing facts the browser cannot
// check are checked here — the toolchain record is not a self-consistent
// lean4-wasm64.release/v1 (schema, its own digest, the fields read); it names
// another runtime than the served buildId; the runtime manifest's
// sourceRevision commit is not a prefix of the record's kernel.commit; a
// runtime/ or profiles/ file the hosting rule stores under the toolchain
// prefix (the runtime manifest and its per-build copy
// runtime/runtime-manifest.<buildId>.json, every profile manifest but the
// index, every chunk and part) is not in the record's files with that sha256 and size;
// base-tree.json names a pack (at the top or in any tree) the record does not
// carry or with other raw bytes, names the record's id with another
// releaseDigest or runtime, does not list exactly the served packs at the
// top, or has a tree other than core-lib-slim without the umbrella pair; with
// another release id its releaseDigest and runtime are recorded as null (the
// record cannot vouch for them); a snapshot entry or the profile index is paired with
// another runtime; a pack was built for another Lean version; the per-build
// manifest public/runtime/runtime-manifest.<buildId>.json (when tracked, or
// present with --worktree) is not byte-identical to the default one, or a
// per-build index copy (public/snapshots/index.<buildId>.json,
// public/snapshots/profiles-index.<buildId>.json; HARDENING #64) is not
// byte-identical to the index it copies; with
// --dist: dist/workers/* is not exactly the source's public/workers/*, the
// main bundle does not pin exactly {buildId}, or an artifact directory was
// bundled. Plus the structural checks a manifest must pass to be described
// at all (schemas, content-addressed names, sizes that add up, pack.mjs's
// content digest). Usage errors exit 2.
//
// Usage: node pipeline/release/release-manifest.mjs --help

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "qed64.release/v1";
export const QED64_REPO = "FawadHa1der/QED64";
export const KERNEL_REPO = "FawadHa1der/lean4";
export const KERNEL_BRANCH = "qed64-wasm64";
export const RECORD_SCHEMA = "lean4-wasm64.release/v1";
export const BASE_TREE_SCHEMA = "qed64.base-tree/v1";
/** The R2 key rule of decision 3 (docs/DEPLOY.md, "The toolchain release prefix"), recorded verbatim as hosting.rule. */
export const HOSTING_RULE = "a path under runtime/ or profiles/ that is not site-owned is stored at <toolchainPrefix><path>; every other path at <path>";
/** Repo-relative paths of the tracked inputs (the per-pack manifests are
 * named by the profile index). */
export const INPUTS = Object.freeze({
  toolchainRecord: "toolchain/lean4-wasm64-release.json",
  baseTree: "embedding/base-tree.json",
  runtimeManifest: "public/runtime/runtime-manifest.json",
  snapshotIndex: "public/snapshots/index.json",
  profileIndex: "public/profiles/index.json",
  workers: "public/workers",
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `usage: node pipeline/release/release-manifest.mjs [source] [--dist <dir>] [--out <file> | --check <file>]

Writes the qed64.release/v1 manifest of one release (docs/RELEASE-BUNDLE.md).

source (one of; default --commit HEAD, or for --check the file's own source):
  --commit <rev>         read every tracked input from that commit (git cat-file; ignores the working tree)
  --worktree             read public/, the toolchain record and base-tree.json as they are on disk
    --public <dir>             (worktree only) another public/ tree        [default: public]
    --toolchain-record <file>  (worktree only) another release record      [default: toolchain/lean4-wasm64-release.json]
    --base-tree <file>         (worktree only) another base-tree.json      [default: embedding/base-tree.json]
  --repo <dir>           the QED64 git checkout to read (commit objects, HEAD) [default: the checkout this script is in]

  --dist <dir>           add the app-shell section from a built dist/ (vite build output, artifacts pruned)
  --out <file>           write the manifest there (atomically) and print a one-line summary; default: stdout
  --check <file>         regenerate and compare byte for byte; exit 0 when identical, 1 when not
  --help                 this text (reads and writes nothing)

exit: 0 ok · 1 refused (one-line reason on stderr) or --check mismatch · 2 usage error`;

export class ReleaseRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseRefusal";
  }
}
const refuse = (why) => { throw new ReleaseRefusal(why); };

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** git's blob id (`git hash-object`) of these bytes, SHA-1 object format. */
export const gitBlobId = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

const HEX64 = /^[0-9a-f]{64}$/;
const BUILD_ID = /^wasm64-[0-9a-f]{16}$/;
/** A runtime id as it appears embedded in a bundle (the vite `define`). */
const BUILD_ID_SCAN = /wasm64-[0-9a-f]{16}(?![0-9a-f])/g;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ARTIFACT_DIRS = ["runtime", "profiles", "snapshots"];

const strip = (digest) => (typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest.slice(7) : null);
const isSize = (n) => Number.isSafeInteger(n) && n > 0;
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

// ------------------------------------------------------------------- git --
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, maxBuffer: 1 << 30 });
  if (r.error) refuse(`git ${args[0]} could not run in ${cwd} (${r.error.message})`);
  return r;
}

function commitMeta(commit, repo) {
  const r = git(["show", "-s", "--format=%ct", commit], repo);
  const seconds = Number(r.stdout.toString().trim());
  if (r.status !== 0 || !Number.isSafeInteger(seconds)) refuse(`cannot read the commit time of ${commit}`);
  // UTC, whole seconds: a function of the commit object only (not of the
  // committer's or this machine's time zone).
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function resolveCommit(rev, repo) {
  const r = git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], repo);
  const commit = r.stdout.toString().trim();
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) refuse(`${rev} is not a commit in ${repo}`);
  return commit;
}

/** repo path → blob id at `commit`, for the paths that exist there (a
 * directory path: every file under it). */
function treeBlobIds(commit, paths, repo) {
  const out = new Map();
  if (paths.length === 0) return out;
  const r = git(["ls-tree", "-r", "-z", commit, "--", ...paths], repo);
  if (r.status !== 0) refuse(`git ls-tree ${commit.slice(0, 7)} failed (${r.stderr.toString().trim()})`);
  for (const line of r.stdout.toString("utf8").split("\0")) {
    const m = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/.exec(line);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// --------------------------------------------------------------- sources --
// A source answers three questions: the bytes of a repo path (null when
// absent), the files under a repo directory (relative, byte-ordered), and the
// qed64 identity of what it read — describe(inputs, listed): every repo path
// read as an input with its bytes, and the directories read as a whole.
// Tests construct their own.

/** Every input from one commit's tree; the working tree is never read. */
export function commitSource(rev, { repo = repoRoot } = {}) {
  const commit = resolveCommit(rev, repo);
  return {
    kind: "commit",
    label: `commit ${commit.slice(0, 7)}`,
    read(repoPath) {
      const r = git(["cat-file", "blob", `${commit}:${repoPath}`], repo);
      return r.status === 0 ? r.stdout : null;
    },
    list(repoDir) {
      const r = git(["ls-tree", "-r", "-z", "--name-only", commit, "--", `${repoDir}/`], repo);
      if (r.status !== 0) refuse(`git ls-tree ${commit.slice(0, 7)} -- ${repoDir} failed`);
      return r.stdout.toString("utf8").split("\0").filter(Boolean)
        .map((p) => p.slice(repoDir.length + 1)).sort(byteOrder);
    },
    describe() {
      return { commit, committedAt: commitMeta(commit, repo), dirty: false };
    },
  };
}

/** public/, the toolchain record and base-tree.json as they are on disk; HEAD
 * names the commit and `dirty` says whether any input differs from (or is
 * absent in) HEAD. */
export function treeSource({
  repo = repoRoot,
  publicDir = path.join(repo, "public"),
  toolchainRecord = path.join(repo, INPUTS.toolchainRecord),
  baseTree = path.join(repo, INPUTS.baseTree),
} = {}) {
  const toFile = (repoPath) => {
    if (repoPath === INPUTS.toolchainRecord) return toolchainRecord;
    if (repoPath === INPUTS.baseTree) return baseTree;
    if (repoPath === "public" || repoPath.startsWith("public/")) return path.join(publicDir, repoPath.slice("public".length));
    return refuse(`internal: ${repoPath} is not a release input`);
  };
  const shown = path.relative(repo, publicDir);
  return {
    kind: "worktree",
    label: `the working tree (${shown && !shown.startsWith("..") ? shown : publicDir})`,
    read(repoPath) {
      const file = toFile(repoPath);
      try {
        return fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
      } catch {
        return null;
      }
    },
    list(repoDir) {
      const dir = toFile(repoDir);
      return fs.existsSync(dir) ? walkFiles(dir).sort(byteOrder) : [];
    },
    describe(inputs, listed = new Set()) {
      const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], repo);
      const commit = head.stdout.toString().trim();
      if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) refuse(`--worktree needs a git checkout at ${repo} to name qed64.commit`);
      const atHead = treeBlobIds(commit, [...inputs.keys(), ...[...listed].map((d) => `${d}/`)], repo);
      // Every file of a listed directory was read, so one HEAD has there that is
      // not an input is a file the tree lacks.
      const dirty = [...inputs].some(([p, bytes]) => atHead.get(p) !== gitBlobId(bytes)) || [...atHead.keys()].some((p) => !inputs.has(p));
      return { commit, committedAt: commitMeta(commit, repo), dirty };
    },
  };
}

/** Regular files under `dir`, relative, "/"-separated. Symlinks are refused:
 * what a symlink resolves to is not a property of the tree being described. */
function walkFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
    else refuse(`${path.join(dir, rel)} is not a regular file or directory (symlink?) — refusing to describe it`);
  }
  return out;
}

// ----------------------------------------------------------------- build --
/** `/runtime/chunks/<base>` etc. → the origin-relative path, refusing any
 * other spelling (the page fetches these URLs verbatim). */
function servedPath(url, dir, what) {
  const prefix = `/${dir}/`;
  const base = typeof url === "string" && url.startsWith(prefix) ? url.slice(prefix.length) : null;
  if (base === null || !SAFE_BASENAME.test(base)) refuse(`${what}: url ${JSON.stringify(url)} is not ${prefix}<file>`);
  return `${dir}/${base}`;
}
/** Additive uploads (rclone copy) and the year-long immutable cache are only
 * sound for content-addressed names. */
function requireContentAddressed(p, sha, what) {
  if (!path.posix.basename(p).includes(sha.slice(0, 16))) refuse(`${what}: ${p} does not carry its sha256 (${sha.slice(0, 16)}…) in its name — not content-addressed`);
}

// -------------------------------------------------------- the two records --
/** "sha256:" + sha256 of the record without `digest`, two-space JSON: lean4-wasm64's
 * releaseDigest, recomputed here (decision 10: the package is never imported). */
export function recordDigest(record) {
  const { digest: _ignored, ...rest } = record;
  return `sha256:${sha256Hex(JSON.stringify(rest, null, 2))}`;
}

const RELEASE_ID = /^lean-v\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/;
const PATCH_ID = /^\d{4}[a-z]?$/;
/** The identity mounts the hosting rule (HOSTING_RULE) describes. */
const IDENTITY_MOUNTS = { "/runtime/": "runtime/", "/profiles/": "profiles/" };
/** "https://github.com/FawadHa1der/lean4(.git)" or "FawadHa1der/lean4" → "FawadHa1der/lean4". */
const repoSlug = (repo) => (typeof repo === "string" ? repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") : null);

/**
 * Validate the pinned lean4-wasm64.release/v1 record (the fields this manifest
 * reads, and its own digest) and return it with `siteOwned(path)` and
 * `toolchainHosted(path)` for origin-relative paths.
 */
export function toolchainRecordOf(r) {
  const at = INPUTS.toolchainRecord;
  if (r?.schema !== RECORD_SCHEMA) refuse(`${at}: schema is ${JSON.stringify(r?.schema)}, expected ${RECORD_SCHEMA}`);
  const self = recordDigest(r);
  if (r.digest !== self) refuse(`${at}: digest ${String(r.digest).slice(0, 23)}… is not its own content's ${self.slice(0, 23)}… — the record was edited after it was cut (land the release's release.json byte for byte)`);
  const bad = (field, v) => refuse(`${at}: ${field} ${JSON.stringify(v)?.slice(0, 80)} is malformed`);
  if (typeof r.id !== "string" || !RELEASE_ID.test(r.id)) bad("id", r.id);
  if (typeof r.kernel?.commit !== "string" || !/^[0-9a-f]{40}$/.test(r.kernel.commit)) bad("kernel.commit", r.kernel?.commit);
  if (typeof r.kernel.patch !== "string" || !PATCH_ID.test(r.kernel.patch)) bad("kernel.patch", r.kernel.patch);
  if (repoSlug(r.kernel.repo) !== KERNEL_REPO || r.kernel.branch !== KERNEL_BRANCH) {
    refuse(`${at}: kernel is ${r.kernel.branch} @ ${r.kernel.repo}, this generator records ${KERNEL_BRANCH} @ ${KERNEL_REPO}`);
  }
  if (typeof r.runtime?.buildId !== "string" || !BUILD_ID.test(r.runtime.buildId)) bad("runtime.buildId", r.runtime?.buildId);
  if (!Array.isArray(r.packs) || r.packs.length === 0) bad("packs", r.packs);
  const packIds = new Set();
  for (const p of r.packs) {
    if (typeof p?.id !== "string" || !p.id || packIds.has(p.id)) bad("packs[].id", p?.id);
    packIds.add(p.id);
    if (!HEX64.test(p.rawSha256 ?? "")) bad(`packs ${p.id} rawSha256`, p.rawSha256);
  }
  for (const k of ["package", "version", "tgz"]) if (typeof r.tools?.[k] !== "string" || !r.tools[k]) bad(`tools.${k}`, r.tools?.[k]);
  const h = r.hosting;
  if (h?.layout !== "served") bad("hosting.layout", h?.layout);
  const mounts = h.mount && typeof h.mount === "object" ? Object.entries(h.mount) : [];
  if (mounts.length !== 2 || mounts.some(([k, v]) => IDENTITY_MOUNTS[k] !== v)) {
    refuse(`${at}: hosting.mount ${JSON.stringify(h.mount)} is not ${JSON.stringify(IDENTITY_MOUNTS)}, the mounts this generator's hosting rule describes`);
  }
  if (!Array.isArray(h.siteOwned) || h.siteOwned.some((e) => typeof e !== "string" || !e.startsWith("/"))) bad("hosting.siteOwned", h.siteOwned);
  if (!Array.isArray(r.files) || r.files.some((f) => typeof f?.path !== "string" || !HEX64.test(f.sha256 ?? "") || !Number.isSafeInteger(f.bytes) || f.bytes < 0)) {
    refuse(`${at}: files is not a list of {path, bytes, sha256}`);
  }
  const siteOwned = (p) => h.siteOwned.some((e) => (e.endsWith("/") ? `/${p}`.startsWith(e) : `/${p}` === e));
  const toolchainHosted = (p) => (p.startsWith("runtime/") || p.startsWith("profiles/")) && !siteOwned(p);
  return { ...r, siteOwned, toolchainHosted };
}

const TREE_ORDER = ["core-lib-slim", "lib-tree-slim", "lib-tree"];
const UMBRELLA_PATH = /^QED64\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UMBRELLA_PAIR = ["QED64/Essential.olean", "QED64/Essential.olean.server"];
/** The init library's tree (adopt-release.sh): the one tree without the umbrella. */
const CORE_TREE = "core-lib-slim";

/**
 * Validate embedding/base-tree.json (qed64.base-tree/v1, adopt-helper.mjs
 * base-tree) against the record and the served packs, and return the
 * manifest's `baseTree` section, built literally: the file's identity, its
 * fields, and `umbrellaFiles`, the union of every umbrella file the trees
 * carry (what a bundle ships at umbrella/<path>).
 */
export function baseTreeOf(bt, { record, packs, tracked }) {
  const at = INPUTS.baseTree;
  if (bt?.schema !== BASE_TREE_SCHEMA) refuse(`${at}: schema is ${JSON.stringify(bt?.schema)}, expected ${BASE_TREE_SCHEMA}`);
  const bad = (field, v) => refuse(`${at}: ${field} ${JSON.stringify(v)?.slice(0, 80)} is malformed`);
  const packList = (list, field) => {
    if (!Array.isArray(list) || list.length === 0) bad(field, list);
    return list.map((p) => {
      if (typeof p?.id !== "string" || !p.id || !strip(p.rawSha256)) bad(`${field}[]`, p);
      return { id: p.id, release: typeof p.release === "string" ? p.release : null, rawSha256: strip(p.rawSha256) };
    });
  };
  const umbrellaList = (list, field) => {
    if (!Array.isArray(list)) bad(field, list);
    const seen = new Set();
    return list.map((u) => {
      if (typeof u?.path !== "string" || !UMBRELLA_PATH.test(u.path) || seen.has(u.path) || !HEX64.test(u.sha256 ?? "") || !isSize(u.bytes)) bad(`${field}[]`, u);
      seen.add(u.path);
      return { path: u.path, sha256: u.sha256, bytes: u.bytes };
    });
  };
  if (typeof bt.releaseId !== "string" || !RELEASE_ID.test(bt.releaseId)) bad("releaseId", bt.releaseId);
  if (typeof bt.slim !== "boolean") bad("slim", bt.slim);
  const top = packList(bt.packs, "packs");
  const umbrella = umbrellaList(bt.umbrella, "umbrella");
  for (const p of UMBRELLA_PAIR) if (!umbrella.some((u) => u.path === p)) refuse(`${at}: umbrella does not list ${p} (the pair every base tree carries)`);
  if (!bt.trees || typeof bt.trees !== "object" || Array.isArray(bt.trees)) bad("trees", bt.trees);
  const names = Object.keys(bt.trees).sort((a, b) => {
    const ia = TREE_ORDER.indexOf(a) === -1 ? TREE_ORDER.length : TREE_ORDER.indexOf(a);
    const ib = TREE_ORDER.indexOf(b) === -1 ? TREE_ORDER.length : TREE_ORDER.indexOf(b);
    return ia - ib || byteOrder(a, b);
  });
  const trees = {};
  for (const name of names) {
    const t = bt.trees[name];
    if (!SAFE_BASENAME.test(name) || typeof t?.slim !== "boolean" || !Number.isSafeInteger(t.files) || !Number.isSafeInteger(t.bytes) || !strip(t.digest)) bad(`trees.${name}`, t);
    trees[name] = { slim: t.slim, packs: packList(t.packs, `trees.${name}.packs`), umbrella: umbrellaList(t.umbrella, `trees.${name}.umbrella`), files: t.files, bytes: t.bytes, digest: t.digest };
  }

  // Every pack it names, at the top and in every tree, is one of the record's
  // packs with the record's raw bytes (and release, when given), whatever
  // release it names: the record is the only authority on a pack's bytes, and
  // these are the fields a downstream rebuilds the trees from.
  const recordPacks = new Map(record.packs.map((p) => [p.id, p]));
  const listed = [["packs", top], ...Object.entries(trees).map(([name, t]) => [`trees.${name}.packs`, t.packs])];
  for (const [field, list] of listed) {
    for (const p of list) {
      const q = recordPacks.get(p.id);
      if (!q) refuse(`${at}: ${field} names ${p.id}, which ${record.id} does not carry — land the adoption's $W/base-tree.json with its record`);
      if (q.rawSha256 !== p.rawSha256) {
        refuse(`${at} (release ${bt.releaseId}): ${field} names ${p.id} raw ${p.rawSha256.slice(0, 16)}…, the record ${record.id} carries ${q.rawSha256.slice(0, 16)}… — land the adoption's $W/base-tree.json with its record`);
      }
      if (p.release !== null && typeof q.release === "string" && p.release !== q.release) {
        refuse(`${at}: ${field} ${p.id} is release ${p.release}, ${record.id} carries ${q.release}`);
      }
    }
  }
  // The same release: its digest and runtime are the record's. Another
  // release (a runtime-only successor that kept the trees): the record cannot
  // vouch for that release's digest or runtime, so the manifest records null.
  const sameRelease = bt.releaseId === record.id;
  if (sameRelease) {
    if (bt.releaseDigest !== record.digest) refuse(`${at}: releaseDigest ${String(bt.releaseDigest).slice(0, 23)}… is not ${record.id}'s ${record.digest.slice(0, 23)}… — land the adoption's $W/base-tree.json with its record`);
    if (bt.runtime !== record.runtime.buildId) refuse(`${at}: runtime ${JSON.stringify(bt.runtime)} is not ${record.id}'s ${record.runtime.buildId}`);
  }
  // The top-level packs are exactly the served packs (the snapshots were baked
  // from trees unpacked from them). A record pack is served at its `manifest`
  // path (the profile index's ids are QED64's own).
  const servedIds = packs.map((s) => {
    const q = record.packs.find((r) => r.manifest === s.manifest.path);
    if (!q) refuse(`${at}: the served pack ${s.id} (${s.manifest.path}) is none of ${record.id}'s packs, so no base tree can name it`);
    return q.id;
  });
  for (const p of top) {
    const served = packs.find((s) => s.manifest.path === recordPacks.get(p.id).manifest);
    if (!served) refuse(`${at}: the base trees were unpacked from ${p.id}, which is not served (the profile index has no ${recordPacks.get(p.id).manifest})`);
    if (served.pack.sha256 !== p.rawSha256) {
      refuse(`${at}: the base trees were unpacked from ${p.id} raw ${p.rawSha256.slice(0, 16)}…, the served ${p.id} pack is ${served.pack.sha256.slice(0, 16)}… — the snapshots were baked from other trees than the served packs make`);
    }
  }
  for (const id of servedIds) if (!top.some((p) => p.id === id)) refuse(`${at}: packs does not list ${id}, a served pack — the base trees were not unpacked from the served packs`);
  if (new Set(top.map((p) => p.id)).size !== top.length) refuse(`${at}: packs lists a pack twice`);
  // Every tree but the core one carries the umbrella pair.
  for (const [name, t] of Object.entries(trees)) {
    if (name === CORE_TREE) continue;
    for (const u of UMBRELLA_PAIR) if (!t.umbrella.some((x) => x.path === u)) refuse(`${at}: trees.${name}.umbrella does not list ${u} (every tree but ${CORE_TREE} carries the pair)`);
  }
  // One umbrella file, one content, in every tree that carries it.
  const union = new Map();
  for (const u of [...umbrella, ...Object.values(trees).flatMap((t) => t.umbrella)]) {
    const seen = union.get(u.path);
    if (seen && (seen.sha256 !== u.sha256 || seen.bytes !== u.bytes)) refuse(`${at}: ${u.path} is listed with two contents (${seen.sha256.slice(0, 16)}…, ${u.sha256.slice(0, 16)}…)`);
    union.set(u.path, u);
  }
  return {
    ...tracked,
    schema: bt.schema,
    releaseId: bt.releaseId,
    releaseDigest: sameRelease ? record.digest : null,
    runtime: sameRelease ? record.runtime.buildId : null,
    packs: top,
    slim: bt.slim,
    umbrella,
    umbrellaSource: typeof bt.umbrellaSource === "string" ? bt.umbrellaSource : null,
    initLib: typeof bt.initLib === "string" ? bt.initLib : null,
    digestRule: typeof bt.digestRule === "string" ? bt.digestRule : null,
    trees,
    umbrellaFiles: [...union.values()].sort((a, b) => byteOrder(a.path, b.path)).map((u) => ({ path: u.path, sha256: u.sha256, bytes: u.bytes })),
  };
}

/**
 * Build the release manifest from a source. Throws ReleaseRefusal with a
 * one-line reason on any failed check; never touches the filesystem except to
 * read `dist`.
 */
export function buildReleaseManifest(source, { dist = null } = {}) {
  const inputs = new Map();
  const need = (repoPath, what) => {
    const bytes = source.read(repoPath);
    if (bytes === null) refuse(`${what}: ${repoPath} is not in ${source.label}`);
    inputs.set(repoPath, bytes);
    return bytes;
  };
  const parse = (bytes, repoPath, what) => {
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (e) {
      return refuse(`${what}: ${repoPath} is not JSON (${e.message})`);
    }
  };
  const tracked = (repoPath, bytes) => ({ path: repoPath.slice("public/".length), sha256: sha256Hex(bytes), gitBlob: gitBlobId(bytes) });

  // -- the pinned toolchain release (lean4-wasm64.release/v1): the kernel, the
  // runtime id, the packs and the hosting of runtime/ and profiles/
  const recBytes = need(INPUTS.toolchainRecord, "toolchain record");
  const record = toolchainRecordOf(parse(recBytes, INPUTS.toolchainRecord, "toolchain record"));
  const kernelCommit = record.kernel.commit;

  // -- runtime
  const rtBytes = need(INPUTS.runtimeManifest, "runtime manifest");
  const rt = parse(rtBytes, INPUTS.runtimeManifest, "runtime manifest");
  if (rt?.schema !== "org.lean-browser64.runtime/v1") refuse(`runtime manifest: schema is ${JSON.stringify(rt?.schema)}, expected org.lean-browser64.runtime/v1`);
  const buildId = rt.buildId;
  if (typeof buildId !== "string" || !BUILD_ID.test(buildId)) refuse(`runtime manifest: buildId ${JSON.stringify(buildId)} is not wasm64-<16 hex>`);
  if (typeof rt.leanVersion !== "string" || !rt.leanVersion) refuse("runtime manifest: no leanVersion");
  if (typeof rt.target !== "string" || !rt.target) refuse("runtime manifest: no target");
  const sourceRevision = typeof rt.sourceRevision === "string" ? rt.sourceRevision : "";
  const built = /@([0-9a-f]{7,40})(?![0-9a-f])/.exec(sourceRevision);
  if (!built) refuse(`runtime ${buildId}: sourceRevision ${JSON.stringify(sourceRevision)} names no kernel commit ("${KERNEL_BRANCH}@<commit> …")`);
  if (record.runtime.buildId !== buildId) {
    refuse(`${INPUTS.toolchainRecord} (${record.id}) names runtime ${record.runtime.buildId}, the served runtime is ${buildId} — land the adoption's runtime manifest with its record (docs/REBUILD.md §3)`);
  }
  if (!kernelCommit.startsWith(built[1])) {
    refuse(`runtime ${buildId} was built from kernel ${built[1]} (sourceRevision), ${record.id} names kernel ${kernelCommit.slice(0, 12)} — the record and the served binary disagree`);
  }
  const fileNames = Object.keys(rt.files ?? {}).sort(byteOrder);
  if (fileNames.length === 0) refuse("runtime manifest lists no files");
  const files = fileNames.map((name) => {
    const f = rt.files[name];
    const what = `runtime ${name}`;
    if (!HEX64.test(f?.sha256 ?? "") || !isSize(f.bytes)) refuse(`${what}: whole-file sha256/bytes malformed`);
    if (!Array.isArray(f.chunks) || f.chunks.length === 0) refuse(`${what}: no chunks`);
    const chunks = f.chunks.map((c, i) => {
      const p = servedPath(c?.url, "runtime/chunks", `${what} chunk ${i}`);
      if (!HEX64.test(c.sha256 ?? "") || !isSize(c.bytes)) refuse(`${what} chunk ${p}: sha256/bytes malformed`);
      requireContentAddressed(p, c.sha256, `${what} chunk`);
      return { path: p, bytes: c.bytes, sha256: c.sha256 };
    });
    const sum = chunks.reduce((n, c) => n + c.bytes, 0);
    if (sum !== f.bytes) refuse(`${what}: chunks sum to ${sum} bytes, the manifest says ${f.bytes}`);
    return { name, bytes: f.bytes, sha256: f.sha256, chunks };
  });
  // The pinned shell fetches the per-build copy FIRST (lib/qed64-boot.ts):
  // if it exists it must be the same bytes, or the pinned and unpinned paths
  // boot different chunk digests. Not an input (it is gitignored), only a check.
  const pinnedRepoPath = `public/runtime/runtime-manifest.${buildId}.json`;
  const pinned = source.read(pinnedRepoPath);
  if (pinned !== null && !pinned.equals(rtBytes)) {
    refuse(`${pinnedRepoPath} is not byte-identical to ${INPUTS.runtimeManifest} — the pinned shell would boot other bytes; re-copy it (scripts/upload-artifacts.sh does) or rerun the promote`);
  }
  const runtime = {
    buildId,
    manifest: { ...tracked(INPUTS.runtimeManifest, rtBytes), pinnedPath: `runtime/runtime-manifest.${buildId}.json` },
    files,
  };

  // -- snapshots
  const siBytes = need(INPUTS.snapshotIndex, "snapshot index");
  const si = parse(siBytes, INPUTS.snapshotIndex, "snapshot index");
  if (si?.schema !== "qed64.snapshot-index/v1" || !Array.isArray(si.snapshots)) refuse(`snapshot index: schema is ${JSON.stringify(si?.schema)}, expected qed64.snapshot-index/v1 with a snapshots array`);
  const snapshotNames = new Set();
  const entries = si.snapshots.map((e, i) => {
    const what = `snapshot ${typeof e?.name === "string" ? e.name : `#${i}`}`;
    if (typeof e?.name !== "string" || !e.name || snapshotNames.has(e.name)) refuse(`${what}: name missing or duplicated`);
    snapshotNames.add(e.name);
    const p = servedPath(e.url, "snapshots", what);
    const sha = strip(e.digest);
    if (!sha) refuse(`${what}: digest ${JSON.stringify(e.digest)} is not sha256:<64 hex>`);
    requireContentAddressed(p, sha, what);
    if (!isSize(e.transfer) || !isSize(e.bytes)) refuse(`${what}: transfer/bytes malformed`);
    if (!Array.isArray(e.imports) || e.imports.some((m) => typeof m !== "string")) refuse(`${what}: imports is not a list of module names`);
    if (e.runtime !== buildId) refuse(`${what} is paired with runtime ${e.runtime ?? "(none recorded)"}, the served runtime is ${buildId} — snapshots are binary-paired (docs/REBUILD.md §3)`);
    return { name: e.name, path: p, sha256: sha, transferBytes: e.transfer, rawBytes: e.bytes, imports: [...e.imports], runtime: e.runtime };
  });
  const snapshots = { index: tracked(INPUTS.snapshotIndex, siBytes), entries };
  // The pinned shell reads each site-owned index's per-build copy when the
  // mutable index names another runtime (HARDENING #64, lib/qed64-boot.ts):
  // present, it must be the same bytes as the index it copies. Not an input and not listed (gitignored, re-derived
  // from the tracked index by promote, fetch-artifacts and the upload; the
  // manifest's format and artifactSetId stay what they were), only a check.
  const sameCopy = (copyRepoPath, bytes, of) => {
    const copy = source.read(copyRepoPath);
    if (copy !== null && !copy.equals(bytes)) {
      refuse(`${copyRepoPath} is not byte-identical to ${of} — the pinned shell would read another pairing's index; rerun the promote (or delete the copy: the upload sends ${of}'s bytes under that name)`);
    }
  };
  sameCopy(`public/snapshots/index.${buildId}.json`, siBytes, INPUTS.snapshotIndex);

  // -- profiles
  const piBytes = need(INPUTS.profileIndex, "profile index");
  const pi = parse(piBytes, INPUTS.profileIndex, "profile index");
  if (pi?.schema !== "qed64.profile-index/v1" || !Array.isArray(pi.profiles) || pi.profiles.length === 0) refuse(`profile index: schema is ${JSON.stringify(pi?.schema)}, expected qed64.profile-index/v1 with profiles`);
  if (pi.runtime?.buildId !== buildId) refuse(`profiles/index.json is paired with runtime ${pi.runtime?.buildId ?? "(none recorded)"}, the served runtime is ${buildId} — rerun promote-staging (it re-points the index)`);
  if (pi.runtime?.leanVersion !== rt.leanVersion) refuse(`profiles/index.json says Lean ${pi.runtime?.leanVersion ?? "(none recorded)"}, the served runtime is Lean ${rt.leanVersion}`);
  const profileIds = new Set();
  const packs = pi.profiles.map((entry, i) => {
    const id = entry?.id;
    const what = `profile ${typeof id === "string" ? id : `#${i}`}`;
    if (typeof id !== "string" || !id || profileIds.has(id)) refuse(`${what}: id missing or duplicated`);
    profileIds.add(id);
    const manifestPath = servedPath(entry.manifest, "profiles", `${what} manifest`);
    if (manifestPath === "profiles/index.json") refuse(`${what}: manifest url names the index itself`);
    const repoPath = `public/${manifestPath}`;
    const bytes = need(repoPath, `${what} manifest`);
    const pm = parse(bytes, repoPath, `${what} manifest`);
    if (pm?.format !== "browser64.artifact-manifest") refuse(`${what}: manifest format is ${JSON.stringify(pm?.format)}`);
    const content = pm.content;
    const leanVersion = content?.lean?.version;
    if (leanVersion !== rt.leanVersion) {
      refuse(`${what} was packed for Lean ${leanVersion ?? "(none recorded)"}, the served runtime is Lean ${rt.leanVersion} — oleans of another Lean version are misread, not rejected`);
    }
    // pack.mjs's identity: sha256 over JSON.stringify(content).
    const contentDigest = `sha256:${sha256Hex(Buffer.from(JSON.stringify(content)))}`;
    if (pm.digest !== contentDigest) refuse(`${what}: manifest digest ${String(pm.digest).slice(0, 23)}… is not its content's ${contentDigest.slice(0, 23)}… (pipeline/artifacts/pack.mjs)`);
    const modules = Object.keys(content.modules ?? {}).length;
    if (entry.release !== content.release || entry.modules !== modules) {
      refuse(`${what}: index entry (${entry.release}, ${entry.modules} modules) does not describe its manifest (${content.release}, ${modules} modules)`);
    }
    const packSha = strip(content.pack?.digest);
    if (!packSha || !isSize(content.pack.byteLength)) refuse(`${what}: raw pack digest/byteLength malformed`);
    const transport = content.pack.transport;
    const transportSha = strip(transport?.digest);
    if (!transportSha || !isSize(transport.byteLength) || !Array.isArray(transport.parts) || transport.parts.length === 0) refuse(`${what}: transport digest/byteLength/parts malformed`);
    const parts = transport.parts.map((part, j) => {
      const p = servedPath(part?.url, "profiles", `${what} part ${j}`);
      const sha = strip(part.digest);
      if (!sha || !isSize(part.byteLength)) refuse(`${what} part ${p}: digest/byteLength malformed`);
      requireContentAddressed(p, sha, `${what} part`);
      return { path: p, sha256: sha, bytes: part.byteLength };
    });
    const sum = parts.reduce((n, p) => n + p.bytes, 0);
    if (sum !== transport.byteLength) refuse(`${what}: parts sum to ${sum} bytes, the transport says ${transport.byteLength}`);
    return {
      id,
      release: content.release,
      modules,
      manifest: { ...tracked(repoPath, bytes), contentDigest },
      lean: { version: leanVersion, gitRevision: content.lean.gitRevision ?? null },
      pack: { sha256: packSha, bytes: content.pack.byteLength },
      transport: { sha256: transportSha, bytes: transport.byteLength, parts },
    };
  });
  const profiles = { index: tracked(INPUTS.profileIndex, piBytes), packs };
  sameCopy(`public/snapshots/profiles-index.${buildId}.json`, piBytes, INPUTS.profileIndex);

  // -- the hosting rule: every runtime/ and profiles/ file that is not
  // site-owned is served from the toolchain release's prefix, so the record
  // must list it with these bytes (decision 3: QED64 uploads none of them).
  const recordFiles = new Map(record.files.map((f) => [f.path, f]));
  const hostedHere = (p, sha, bytes, what) => {
    if (!record.toolchainHosted(p)) return;
    const f = recordFiles.get(p);
    if (!f) refuse(`${what} ${p} is not in ${record.id}'s files, but the hosting rule stores it under lean4-wasm64/${record.id}/ — serve the record's ${p} or mark it site-owned there`);
    if (f.sha256 !== sha || (bytes !== null && f.bytes !== bytes)) {
      refuse(`${what} ${p} is ${sha.slice(0, 16)}… (${bytes ?? "?"} B), ${record.id}'s files say ${f.sha256.slice(0, 16)}… (${f.bytes} B) — the served tree and the pinned record disagree`);
    }
  };
  hostedHere(runtime.manifest.path, runtime.manifest.sha256, rtBytes.length, "the served runtime manifest");
  // The pinned shell fetches the per-build copy first, from the same prefix: the record must carry it too.
  hostedHere(runtime.manifest.pinnedPath, runtime.manifest.sha256, rtBytes.length, "the per-build runtime manifest (= the default one)");
  for (const f of runtime.files) for (const c of f.chunks) hostedHere(c.path, c.sha256, c.bytes, `runtime ${f.name} chunk`);
  hostedHere(profiles.index.path, profiles.index.sha256, piBytes.length, "the profile index");
  for (const p of packs) {
    hostedHere(p.manifest.path, p.manifest.sha256, inputs.get(`public/${p.manifest.path}`).length, `the served profile ${p.id} manifest`);
    for (const part of p.transport.parts) hostedHere(part.path, part.sha256, part.bytes, `profile ${p.id} part`);
  }

  // -- the base trees the snapshots were baked from (adopt-helper.mjs base-tree)
  const btBytes = need(INPUTS.baseTree, "base tree");
  const baseTree = baseTreeOf(parse(btBytes, INPUTS.baseTree, "base tree"), { record, packs, tracked: { path: INPUTS.baseTree, sha256: sha256Hex(btBytes), gitBlob: gitBlobId(btBytes) } });

  // -- shell (optional): its workers are inputs too, each file and the directory
  const listed = new Set();
  const shell = dist === null ? null : shellSection(dist, { source, buildId, inputs, listed });

  const artifactSetId = `set-${sha256Hex(JSON.stringify({ runtime, snapshots, profiles })).slice(0, 16)}`;
  const { commit, committedAt, dirty } = source.describe(inputs, listed);
  const body = {
    schema: SCHEMA,
    releaseId: `qed64-${commit.slice(0, 7)}`,
    artifactSetId,
    qed64: { repo: QED64_REPO, commit, committedAt, source: source.kind, dirty },
    lean: { version: rt.leanVersion, target: rt.target },
    kernel: { repo: KERNEL_REPO, branch: KERNEL_BRANCH, commit: kernelCommit, sourceRevision },
    toolchain: {
      releaseId: record.id,
      digest: record.digest,
      record: { path: INPUTS.toolchainRecord, sha256: sha256Hex(recBytes), gitBlob: gitBlobId(recBytes) },
      kernel: { commit: record.kernel.commit, patch: record.kernel.patch },
      runtimeBuildId: record.runtime.buildId,
      packs: record.packs.map((p) => ({ id: p.id, rawSha256: p.rawSha256 })),
      tools: { package: record.tools.package, version: record.tools.version, tgz: record.tools.tgz },
    },
    hosting: { toolchainPrefix: `lean4-wasm64/${record.id}/`, siteOwned: [...record.hosting.siteOwned], rule: HOSTING_RULE },
    baseTree,
    runtime,
    snapshots,
    profiles,
    shell,
  };
  const { schema, ...rest } = body;
  return { schema, digest: manifestDigest(body), ...rest };
}

/**
 * The app-shell section of a built dist/: a sorted `<sha256>  <relpath>`
 * listing (the format `shasum -a 256` prints), its sha256, and the runtime
 * id(s) the main bundle pins. Refuses a dist whose workers are not the
 * source's public/workers, whose bundle pins anything but `buildId`, or that
 * carries an artifact directory. The workers it reads are recorded as inputs
 * (`inputs`: each file, `listed`: the directory) for source.describe().
 */
/** The shell's own identity file (frontend/build/build-info.mjs). */
export const BUILD_INFO_FILE = "qed64-build.json";

export function shellSection(distDir, { source, buildId, inputs = new Map(), listed = new Set() }) {
  let isDir = false;
  try { isDir = fs.statSync(distDir).isDirectory(); } catch { /* absent */ }
  if (!isDir) refuse(`--dist ${distDir} is not a directory`);
  const rels = walkFiles(distDir).sort(byteOrder);
  for (const dir of ARTIFACT_DIRS) {
    if (rels.some((r) => r.startsWith(`${dir}/`))) refuse(`--dist ${distDir} contains ${dir}/ — artifacts are served from R2, never bundled (scripts/deploy-app.sh prunes them)`);
  }
  const bytesOf = new Map(rels.map((r) => [r, fs.readFileSync(path.join(distDir, r))]));
  // dist/qed64-build.json names the shell (frontend/build/build-info.mjs), so it
  // is not part of what it names: the listing covers every other file, and a
  // build-info file that disagrees with this tree is refused.
  const files = rels.filter((r) => r !== BUILD_INFO_FILE).map((r) => ({ path: r, sha256: sha256Hex(bytesOf.get(r)), bytes: bytesOf.get(r).length }));
  const listingSha256 = sha256Hex(listingOf(files));
  // The two API revisions the build stamps (frontend/build/build-info.mjs): the
  // page API's (globalThis.qed64.api.revision) and the qed64/embed barrel's.
  let apiRevision = null;
  let embedApiRevision = null;
  if (bytesOf.has(BUILD_INFO_FILE)) {
    let info = null;
    try { info = JSON.parse(bytesOf.get(BUILD_INFO_FILE).toString("utf8")); } catch { /* refused below */ }
    if (!info || info.schema !== "qed64.build/v1") refuse(`--dist: ${BUILD_INFO_FILE} is not a qed64.build/v1 file`);
    if (info.shell !== `shell-${listingSha256.slice(0, 16)}`) refuse(`--dist: ${BUILD_INFO_FILE} names ${info.shell}, the tree is shell-${listingSha256.slice(0, 16)} — files changed after the build`);
    if (info.buildId !== buildId) refuse(`--dist: ${BUILD_INFO_FILE} pairs runtime ${info.buildId}, the release runtime is ${buildId}`);
    for (const k of ["apiRevision", "embedApiRevision"]) {
      if (info[k] !== undefined && info[k] !== null && (typeof info[k] !== "string" || !info[k])) refuse(`--dist: ${BUILD_INFO_FILE} ${k} ${JSON.stringify(info[k])} is not a revision string`);
    }
    apiRevision = info.apiRevision ?? null;
    embedApiRevision = info.embedApiRevision ?? null;
  }

  // The workers are copied verbatim from public/workers by the vite build;
  // anything else means the shell was built from another tree than the one
  // this manifest describes.
  const wanted = source.list(INPUTS.workers);
  listed.add(INPUTS.workers);
  const shipped = rels.filter((r) => r.startsWith("workers/")).map((r) => r.slice("workers/".length));
  for (const name of shipped) if (!wanted.includes(name)) refuse(`--dist: workers/${name} is not in ${source.label}'s ${INPUTS.workers}`);
  for (const name of wanted) {
    const expected = source.read(`${INPUTS.workers}/${name}`);
    if (expected !== null) inputs.set(`${INPUTS.workers}/${name}`, expected);
    const got = bytesOf.get(`workers/${name}`);
    if (!got) refuse(`--dist: workers/${name} is missing (${source.label} has ${INPUTS.workers}/${name})`);
    if (expected === null || !got.equals(expected)) refuse(`--dist: workers/${name} differs from ${source.label}'s ${INPUTS.workers}/${name} — the shell was not built from this tree`);
  }

  // The main bundle: the module script(s) index.html loads.
  const html = bytesOf.get("index.html");
  if (!html) refuse(`--dist ${distDir} has no index.html`);
  const entrySet = new Set();
  for (const tag of html.toString("utf8").matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag[0])) continue;
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
    if (!src) continue;
    const rel = src.startsWith("/") ? src.slice(1) : null;
    if (rel === null || !bytesOf.has(rel)) refuse(`--dist: index.html loads ${src}, which is not a root-absolute file of the shell`);
    entrySet.add(rel);
  }
  const entries = [...entrySet].sort(byteOrder);
  if (entries.length === 0) refuse("--dist: index.html loads no module script — cannot find the main bundle");
  const idsIn = (rel) => new Set(bytesOf.get(rel).toString("latin1").match(BUILD_ID_SCAN) ?? []);
  const bundleIds = new Set(entries.flatMap((rel) => [...idsIn(rel)]));
  if (bundleIds.size !== 1 || !bundleIds.has(buildId)) {
    refuse(`--dist: the main bundle pins runtime ${bundleIds.size ? [...bundleIds].sort().join(", ") : "(none)"}, expected exactly ${buildId} — the shell was built against another public/runtime/runtime-manifest.json`);
  }
  for (const rel of rels) {
    const stray = [...idsIn(rel)].find((id) => id !== buildId);
    if (stray) refuse(`--dist: ${rel} embeds runtime ${stray}, the release runtime is ${buildId}`);
  }
  return {
    shellId: `shell-${listingSha256.slice(0, 16)}`,
    listingSha256,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    apiRevision,
    embedApiRevision,
    bundle: { entries, buildIds: [buildId] },
    files,
  };
}

/** The listing whose sha256 is shell.listingSha256: one `<sha256>  <path>\n`
 * line per file except qed64-build.json, byte-ordered by path — what
 * `(cd dist && find . -type f ! -name qed64-build.json | sed 's|^\./||' | LC_ALL=C sort | xargs shasum -a 256)` prints. */
export function listingOf(files) {
  return [...files].sort((a, b) => byteOrder(a.path, b.path)).map((f) => `${f.sha256}  ${f.path}\n`).join("");
}

/** "sha256:" + sha256(JSON.stringify(manifest without `digest`)). */
export function manifestDigest(manifest) {
  const { digest: _ignored, ...body } = manifest;
  return `sha256:${sha256Hex(JSON.stringify(body))}`;
}

/** "set-" + sha256(JSON.stringify({ runtime, snapshots, profiles }))[:16]. */
export function artifactSetIdOf(manifest) {
  const { runtime, snapshots, profiles } = manifest;
  return `set-${sha256Hex(JSON.stringify({ runtime, snapshots, profiles })).slice(0, 16)}`;
}

/** The file form: two-space JSON plus a final newline. */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ------------------------------------------------------------------- CLI --
const VALUE_FLAGS = new Set(["--commit", "--public", "--toolchain-record", "--base-tree", "--repo", "--dist", "--out", "--check"]);
const BOOL_FLAGS = new Set(["--worktree", "--help"]);

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (BOOL_FLAGS.has(flag)) { opts[flag.slice(2)] = true; continue; }
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (opts[flag.slice(2)] !== undefined) throw new UsageError(`${flag} given twice`);
    opts[flag.slice(2)] = value;
    i += 1;
  }
  if (opts.commit !== undefined && opts.worktree) throw new UsageError("--commit and --worktree are exclusive");
  if (["public", "toolchain-record", "base-tree"].some((k) => opts[k] !== undefined) && !opts.worktree) throw new UsageError("--public/--toolchain-record/--base-tree apply to --worktree only");
  if (opts.out !== undefined && opts.check !== undefined) throw new UsageError("--out and --check are exclusive");
  return opts;
}

function sourceFor(opts, recorded) {
  const repo = opts.repo === undefined ? repoRoot : path.resolve(opts.repo);
  if (opts.worktree) {
    return treeSource({
      repo,
      publicDir: path.resolve(opts.public ?? path.join(repo, "public")),
      toolchainRecord: path.resolve(opts["toolchain-record"] ?? path.join(repo, INPUTS.toolchainRecord)),
      baseTree: path.resolve(opts["base-tree"] ?? path.join(repo, INPUTS.baseTree)),
    });
  }
  if (opts.commit !== undefined) return commitSource(opts.commit, { repo });
  // --check with no explicit source re-derives the way the file says it was made.
  if (recorded?.source === "worktree") return treeSource({ repo });
  if (recorded?.source === "commit" && typeof recorded.commit === "string") return commitSource(recorded.commit, { repo });
  return commitSource("HEAD", { repo });
}

function lineDiff(expected, actual, limit = 12) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < limit; i += 1) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`  line ${i + 1} file:        ${a[i].trim().slice(0, 160)}`);
    if (b[i] !== undefined) out.push(`  line ${i + 1} regenerated: ${b[i].trim().slice(0, 160)}`);
  }
  return out;
}

export function main(argv) {
  // --help first, before anything is parsed, resolved, run or written.
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`release-manifest: ${e.message}\n${USAGE}`);
    return 2;
  }
  try {
    let recordedText = null;
    let recorded = null;
    if (opts.check !== undefined) {
      try {
        recordedText = fs.readFileSync(opts.check, "utf8");
      } catch (e) {
        refuse(`--check ${opts.check}: cannot read it (${e.message})`);
      }
      try { recorded = JSON.parse(recordedText).qed64 ?? null; } catch { /* compared as text below */ }
    }
    const manifest = buildReleaseManifest(sourceFor(opts, recorded), { dist: opts.dist === undefined ? null : path.resolve(opts.dist) });
    const text = serializeManifest(manifest);
    const summary = `${manifest.releaseId} ${manifest.artifactSetId} runtime ${manifest.runtime.buildId}, ` +
      `${manifest.snapshots.entries.length} snapshot(s), ${manifest.profiles.packs.length} pack(s)` +
      `${manifest.shell ? `, ${manifest.shell.shellId}` : ""}${manifest.qed64.dirty ? " (worktree differs from HEAD)" : ""}`;
    if (opts.check !== undefined) {
      if (recordedText === text) {
        console.log(`release-manifest: ${opts.check} matches (${summary})`);
        return 0;
      }
      console.error(`release-manifest: ${opts.check} differs from the manifest regenerated from ${manifest.qed64.source === "commit" ? `commit ${manifest.qed64.commit.slice(0, 7)}` : "the working tree"}` +
        `${manifest.shell === null && /"shell": \{/.test(recordedText) ? " (the file has a shell section: pass --dist <dir>)" : ""}`);
      for (const line of lineDiff(recordedText, text)) console.error(line);
      return 1;
    }
    if (opts.out !== undefined) {
      const out = path.resolve(opts.out);
      const tmp = `${out}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, out);
      const shown = path.relative(process.cwd(), out);
      console.log(`release-manifest: ${summary} → ${shown && !shown.startsWith("..") ? shown : out}`);
      return 0;
    }
    process.stdout.write(text);
    return 0;
  } catch (e) {
    if (!(e instanceof ReleaseRefusal)) throw e;
    console.error(`release-manifest: REFUSED: ${e.message}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
