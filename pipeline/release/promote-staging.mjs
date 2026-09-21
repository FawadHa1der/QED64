#!/usr/bin/env node
// Promote a staged runtime + snapshot set — and, when staged, the library
// packs — into public/ in one step.
//
// Snapshots are binary-paired, so a runtime and its snapshots must never be
// served in a mixed state: stage both (chunk-runtime, bake-snapshot — their
// default --out is work/staging/<buildId>/{runtime,snapshots}), then promote
// together. The promote is ADDITIVE (review C6, HARDENING #32): chunks,
// snapshot files and pack parts are content-addressed, so they are copied in
// next to whatever is already there and nothing referenced by any manifest
// under public/ is ever deleted; the mutable files (the default runtime
// manifest, the snapshot index, the profile manifests and the profile index)
// are switched by atomic rename.
//
// PACKS. A version import also replaces the library packs (oleans are only
// loadable by the Lean version that wrote them; the githash gate is compiled
// off, docs/REBUILD.md §2). If <staging>/profiles/index.json exists, the
// packs it lists are verified and promoted in the SAME step; if
// <staging>/profiles is absent this is a kernel-only bump and the served
// packs stay.
//
// OWNER OF public/profiles/index.json `runtime`. The field means "the runtime
// these profiles are SERVED with" (its only writer before this script,
// sync-artifacts.mjs, records the runtime it installs beside the packs; the
// packs' PRODUCER is already in each entry's `release` and in the manifest's
// content.lean). Nothing re-pointed it on a promote, so it went stale. This
// script owns it now: every promote — kernel-only included — switches the
// index with runtime = the promoted {buildId, leanVersion}, and refuses when
// a listed pack's content.lean.version is not the promoted runtime's
// leanVersion (that assertion would be false, and the page has no guard
// against foreign oleans). verify-release checks the same invariant.
//
// ORDER, and why.
//  1. Verify everything staged (sizes, sha256, pairing) — nothing is touched
//     until the whole plan is known to be good.
//  2. Copy every content-addressed file (chunks, snapshots, pack parts), each
//     to a temp name and renamed into place, so a crash never leaves a short
//     file under a final name (an existing file is kept only if its bytes
//     match; a mismatch is a leftover of exactly that crash and is replaced).
//  3. Write ALL mutable files beside their targets first (a full disk fails
//     here, before anything switched), then rename them back to back —
//     the mixed window is a handful of rename(2) calls, not a 7 MB write.
//     Leaves before roots, last-read first: per-build runtime manifest (a new
//     name, nothing points at it yet), profile manifests, snapshot index,
//     default runtime manifest, and profiles/index.json LAST. Every file a
//     mutable file references exists before it is switched in (no reader can
//     see a manifest naming a missing part/chunk/snapshot), and the profile
//     index is the commit record: its runtime.buildId names the new runtime
//     only once everything else is in place, so an interrupted promote
//     leaves an index verify-release rejects — rerun the promote, it is
//     idempotent. The page reads index → runtime manifest → core manifest →
//     snapshot index over seconds, not in a transaction, so no writer order
//     can make a reader that straddles the switch consistent; switching in
//     the reverse of that read order only guarantees a reader that saw the
//     NEW runtime manifest sees new packs and snapshots too. The straddling
//     reader is what the pairing fields are for (snapshot entry.runtime is
//     enforced by the worker; index.runtime is the same handle for packs).
//
// Usage: node pipeline/release/promote-staging.mjs --staging work/staging/<buildId>
//        [--public public] [--dry-run]

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dryRun = process.argv.includes("--dry-run");
const staging = path.resolve(root, arg("staging", "work/staging"));
const publicDir = path.resolve(root, arg("public", "public"));
const stagedRuntime = path.join(staging, "runtime");
const stagedSnapshots = path.join(staging, "snapshots");
const stagedProfiles = path.join(staging, "profiles");
const fail = (why) => { console.error(`promote: ${why}`); process.exit(2); };
const rel = (file) => path.relative(root, file);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stripSha = (digest) => (typeof digest === "string" ? digest.replace(/^sha256:/, "") : null);
// Every staged file is re-derived against the digest its manifest/index
// carries (files are ≤ 16 MiB chunks/parts and gzip snapshots — cheap): a
// truncated or half-written staging file would otherwise be promoted and
// fail only in the browser's verification, one boot later. Streamed, so a
// ~1 GB snapshot never has to fit one Buffer.
const sha256File = (file) => {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
};
const verifyDigest = (file, expected, what) => {
  if (!expected) return;
  const got = sha256File(file);
  if (got !== expected) fail(`${what}: ${rel(file)} has sha256 ${got.slice(0, 16)}…, manifest says ${expected.slice(0, 16)}… — restage it`);
};
const readJson = (file, what) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fail(`${what}: ${rel(file)} is not readable JSON (${e.message})`); }
};
for (const required of [
  path.join(stagedRuntime, "runtime-manifest.json"),
  path.join(stagedSnapshots, "index.json"),
]) {
  if (!fs.existsSync(required)) fail(`missing ${required}`);
}

// ---------------------------------------------------------------- verify --
const manifest = JSON.parse(fs.readFileSync(path.join(stagedRuntime, "runtime-manifest.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(stagedSnapshots, "index.json"), "utf8"));
if (typeof manifest.buildId !== "string" || !/^wasm64-[0-9a-f]{16}$/.test(manifest.buildId)) fail("staged manifest has no buildId");
const chunkFiles = [];
for (const [name, file] of Object.entries(manifest.files ?? {})) {
  for (const chunk of file.chunks ?? []) {
    const base = path.basename(chunk.url);
    const staged = path.join(stagedRuntime, "chunks", base);
    if (!fs.existsSync(staged)) fail(`manifest lists ${chunk.url} (${name}) but ${staged} is absent`);
    if (typeof chunk.bytes === "number" && fs.statSync(staged).size !== chunk.bytes) fail(`chunk ${base} (${name}) is ${fs.statSync(staged).size} bytes, manifest says ${chunk.bytes}`);
    verifyDigest(staged, chunk.sha256, `chunk ${base} (${name})`);
    chunkFiles.push({ base, from: staged, sha: chunk.sha256 ?? null });
  }
}
if (chunkFiles.length === 0) fail("staged manifest lists no chunks");
const snapshotFiles = [];
for (const entry of index.snapshots ?? []) {
  const base = path.basename(entry.url);
  const file = path.join(stagedSnapshots, base);
  if (!fs.existsSync(file)) fail(`index lists ${entry.url} but ${file} is absent`);
  // The pairing is checked here, not assumed: an index entry must name the
  // runtime that baked it, and it must be the runtime being promoted.
  if (entry.runtime !== manifest.buildId) {
    fail(`snapshot ${entry.name} is paired with runtime ${entry.runtime ?? "(none recorded)"}, not ${manifest.buildId} — rebake it against this runtime`);
  }
  verifyDigest(file, stripSha(entry.digest), `snapshot ${entry.name}`);
  snapshotFiles.push({ base, from: file, sha: stripSha(entry.digest) });
}

const publicRuntime = path.join(publicDir, "runtime");
const publicSnapshots = path.join(publicDir, "snapshots");
const publicProfiles = path.join(publicDir, "profiles");
const PROFILE_INDEX_SCHEMA = "qed64.profile-index/v1";
// What the browser would reject anyway (src/install/profiles.ts
// validateManifest): refuse it here, before it is served.
const MAX_PART_BYTES = 64 * 1024 * 1024;
const promotedRuntime = { buildId: manifest.buildId, leanVersion: manifest.leanVersion };

/** `/profiles/<basename>` → basename. The page fetches these URLs verbatim
 * (fetch(entry.manifest), fetch(part.url)) and this script installs the file
 * at public/profiles/<basename>: any other spelling — pack.mjs's bare
 * basenames included — would be promoted fine and 404 in the browser. */
const servedProfileBase = (url, what) => {
  const m = typeof url === "string" ? /^\/profiles\/([^/]+)$/.exec(url) : null;
  if (!m || m[1] === "index.json") fail(`${what}: url ${JSON.stringify(url)} is not /profiles/<file> — the page fetches it verbatim and the promote installs it under public/profiles`);
  return m[1];
};
/** A pack's Lean version must be the promoted runtime's: that is what
 * index.runtime.leanVersion asserts, and a foreign olean is not refused by
 * the runtime (githash gate compiled off) — it is simply misread. */
const requirePackVersion = (id, packManifest, where) => {
  const v = packManifest?.content?.lean?.version;
  if (v !== promotedRuntime.leanVersion) {
    fail(`profile ${id} (${where}) was packed for Lean ${v ?? "(none recorded)"}, the runtime being promoted is Lean ${promotedRuntime.leanVersion ?? "(none recorded)"} — ` +
      "stage packs for this runtime under <staging>/profiles, or restage the runtime with the right QED64_LEAN_VERSION / --lean-version");
  }
};

/** Verify <staging>/profiles against its own index and manifests. Returns
 * what to copy and what to switch; touches nothing. */
function verifyStagedProfiles() {
  const indexPath = path.join(stagedProfiles, "index.json");
  const profileIndex = readJson(indexPath, "staged profile index");
  if (profileIndex?.schema !== PROFILE_INDEX_SCHEMA) fail(`staged profile index: schema is ${JSON.stringify(profileIndex?.schema)}, expected ${PROFILE_INDEX_SCHEMA}`);
  // Pairing, like the snapshots': the index must name the runtime being
  // promoted, otherwise these packs were staged for some other build.
  if (profileIndex.runtime?.buildId !== promotedRuntime.buildId) {
    fail(`staged profile index is paired with runtime ${profileIndex.runtime?.buildId ?? "(none recorded)"}, not ${promotedRuntime.buildId} — restage the packs' index against this runtime`);
  }
  if (profileIndex.runtime?.leanVersion !== promotedRuntime.leanVersion) {
    fail(`staged profile index says Lean ${profileIndex.runtime?.leanVersion ?? "(none recorded)"}, the staged runtime manifest says Lean ${promotedRuntime.leanVersion ?? "(none recorded)"} — one of them was staged with the wrong --lean-version`);
  }
  if (!Array.isArray(profileIndex.profiles) || profileIndex.profiles.length === 0) fail("staged profile index lists no profiles");
  const ids = profileIndex.profiles.map((p) => p?.id);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) fail(`staged profile index: profile ids must be unique strings (${JSON.stringify(ids)})`);
  // qed64-boot.ts installs `core` at boot and throws without it.
  if (!ids.includes("core")) fail("staged profile index has no `core` profile — the page cannot boot without it");

  const parts = new Map(); // basename → { from, sha }
  const manifests = [];
  const summary = [];
  for (const entry of profileIndex.profiles) {
    const what = `profile ${entry.id}`;
    const manifestBase = servedProfileBase(entry.manifest, `${what} manifest`);
    const manifestFile = path.join(stagedProfiles, manifestBase);
    if (!fs.existsSync(manifestFile)) fail(`${what}: index lists ${entry.manifest} but ${manifestFile} is absent`);
    const bytes = fs.readFileSync(manifestFile);
    let pm;
    try { pm = JSON.parse(bytes.toString("utf8")); } catch (e) { fail(`${what}: ${rel(manifestFile)} is not JSON (${e.message})`); }
    if (pm?.format !== "browser64.artifact-manifest") fail(`${what}: manifest format is ${JSON.stringify(pm?.format)}`);
    const content = pm.content;
    const transport = content?.pack?.transport;
    if (transport?.encoding !== "gzip") fail(`${what}: transport encoding is ${JSON.stringify(transport?.encoding)}, the installer only inflates gzip`);
    if (!Array.isArray(transport.parts) || transport.parts.length === 0) fail(`${what}: manifest lists no transport parts`);
    // The manifest's own identity, as pack.mjs defines it: sha256 over
    // JSON.stringify(content) (key order survives a parse/stringify round
    // trip). A mismatch means the content was edited after packing — e.g.
    // part URLs rewritten to /profiles/… without re-deriving the digest.
    const derived = `sha256:${sha256(Buffer.from(JSON.stringify(content)))}`;
    if (pm.digest !== derived) {
      fail(`${what}: manifest digest is ${String(pm.digest).slice(0, 23)}…, its content hashes to ${derived.slice(0, 23)}… — ` +
        "re-derive it after the last edit: digest = \"sha256:\" + sha256(JSON.stringify(manifest.content)) (pipeline/artifacts/pack.mjs)");
    }
    const moduleCount = Object.keys(content.modules ?? {}).length;
    if (moduleCount === 0) fail(`${what}: manifest has no modules`);
    if (entry.release !== content.release) fail(`${what}: index says release ${JSON.stringify(entry.release)}, manifest says ${JSON.stringify(content.release)}`);
    if (entry.modules !== moduleCount) fail(`${what}: index says ${entry.modules} modules, manifest has ${moduleCount}`);
    requirePackVersion(entry.id, pm, "staged");

    // Parts: present, right size, right sha256 — and, concatenated in manifest
    // order, the transport stream the manifest describes.
    const whole = createHash("sha256");
    let total = 0;
    for (const part of transport.parts) {
      const base = servedProfileBase(part.url, `${what} part`);
      const expected = stripSha(part.digest);
      if (!expected || !/^[a-f0-9]{64}$/.test(expected)) fail(`${what}: part ${base} has a malformed digest`);
      if (!Number.isSafeInteger(part.byteLength) || part.byteLength <= 0 || part.byteLength > MAX_PART_BYTES) fail(`${what}: part ${base} byteLength ${part.byteLength} is out of bounds`);
      // Additive copying is only sound for content-addressed names.
      if (!base.includes(expected.slice(0, 20))) fail(`${what}: part ${base} does not carry its digest (${expected.slice(0, 20)}) in its name — not content-addressed, cannot be promoted additively`);
      const staged = path.join(stagedProfiles, base);
      if (!fs.existsSync(staged)) fail(`${what}: manifest lists ${part.url} but ${staged} is absent`);
      const size = fs.statSync(staged).size;
      if (size !== part.byteLength) fail(`${what}: part ${base} is ${size} bytes, manifest says ${part.byteLength} — restage it`);
      const data = fs.readFileSync(staged);
      const got = sha256(data);
      if (got !== expected) fail(`${what}: part ${rel(staged)} has sha256 ${got.slice(0, 16)}…, manifest says ${expected.slice(0, 16)}… — restage it`);
      whole.update(data);
      total += data.length;
      parts.set(base, { from: staged, sha: expected });
    }
    if (total !== transport.byteLength) fail(`${what}: parts sum to ${total} bytes, manifest transport says ${transport.byteLength}`);
    const transportDigest = stripSha(transport.digest);
    if (transportDigest && whole.digest("hex") !== transportDigest) fail(`${what}: the parts in manifest order do not hash to the transport digest ${transportDigest.slice(0, 16)}… — wrong part set or order`);
    // The exact staged bytes are installed (not a re-serialisation), so the
    // manifest committed to git is the file the pack lane produced.
    manifests.push({ base: manifestBase, bytes });
    summary.push(`${entry.id} (${moduleCount} modules, ${transport.parts.length} part(s), ${total / 1e6 | 0} MB wire)`);
  }
  return { parts, manifests, indexBytes: fs.readFileSync(indexPath), summary };
}

/** Kernel-only bump: the served packs stay; the served index is re-pointed at
 * the promoted runtime. Returns the new index text, or null if this public
 * tree publishes no profiles. */
function repointServedProfileIndex() {
  const servedIndexPath = path.join(publicProfiles, "index.json");
  if (!fs.existsSync(servedIndexPath)) return null;
  const served = readJson(servedIndexPath, "served profile index");
  if (served?.schema !== PROFILE_INDEX_SCHEMA || !Array.isArray(served.profiles)) fail(`served profile index ${rel(servedIndexPath)}: unexpected schema`);
  for (const entry of served.profiles) {
    const file = path.join(publicProfiles, servedProfileBase(entry.manifest, `served profile ${entry.id} manifest`));
    if (!fs.existsSync(file)) fail(`served profile ${entry.id}: ${rel(file)} is absent — cannot assert its pairing with ${promotedRuntime.buildId}`);
    requirePackVersion(entry.id, readJson(file, `served profile ${entry.id} manifest`), "served, not restaged");
  }
  return JSON.stringify({ ...served, runtime: promotedRuntime }, null, 2);
}

let stagedPacks = null;
let repointedIndex = null;
if (fs.existsSync(path.join(stagedProfiles, "index.json"))) {
  stagedPacks = verifyStagedProfiles();
} else if (fs.existsSync(stagedProfiles)) {
  // A half-staged pack lane must not silently become a kernel-only promote.
  fail(`${rel(stagedProfiles)} exists but has no index.json — finish staging the packs, or remove the directory for a kernel-only promote`);
} else {
  repointedIndex = repointServedProfileIndex();
}

// ------------------------------------------------------------------ plan --
const plan = [];
const tmpName = (to) => `${to}.${process.pid}.tmp`;
const copyAdditive = (from, toDir, base, sha) => {
  const to = path.join(toDir, base);
  if (fs.existsSync(to)) {
    if (!sha || sha256File(to) === sha) { plan.push(`keep  ${rel(to)}`); return; }
    // A content-addressed name with other bytes under it is a torn copy; the
    // name says what the bytes must be, so replacing it is a repair.
    plan.push(`fix   ${rel(to)} (the existing file's bytes do not match its recorded sha256 — a torn copy, replaced)`);
  } else {
    plan.push(`copy  ${rel(to)}`);
  }
  if (dryRun) return;
  fs.mkdirSync(toDir, { recursive: true });
  fs.copyFileSync(from, tmpName(to));
  fs.renameSync(tmpName(to), to);
};
// Atomic switch, two-phase: every new file is written beside its target
// first, then all are renamed over their targets back to back (POSIX rename
// replaces in one step, so no reader ever sees a partial or missing file).
const switches = [];
const switchFile = (to, data) => { plan.push(`swap  ${rel(to)}`); switches.push({ to, data }); };

// 2. content-addressed files
for (const { base, from, sha } of chunkFiles) copyAdditive(from, path.join(publicRuntime, "chunks"), base, sha);
for (const { base, from, sha } of snapshotFiles) copyAdditive(from, publicSnapshots, base, sha);
if (stagedPacks) for (const [base, { from, sha }] of stagedPacks.parts) copyAdditive(from, publicProfiles, base, sha);

// 3. mutable files, in switch order (see ORDER above)
const manifestText = JSON.stringify(manifest, null, 2);
// The per-build (immutable) name first, so `?runtime=<buildId>` and the
// pinned shell can find it before the default flips.
switchFile(path.join(publicRuntime, `runtime-manifest.${manifest.buildId}.json`), manifestText);
if (stagedPacks) for (const { base, bytes } of stagedPacks.manifests) switchFile(path.join(publicProfiles, base), bytes);
switchFile(path.join(publicSnapshots, "index.json"), JSON.stringify(index, null, 2));
switchFile(path.join(publicRuntime, "runtime-manifest.json"), manifestText);
if (stagedPacks) switchFile(path.join(publicProfiles, "index.json"), stagedPacks.indexBytes);
else if (repointedIndex !== null) switchFile(path.join(publicProfiles, "index.json"), repointedIndex);

if (!dryRun) {
  const written = [];
  try {
    for (const { to, data } of switches) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      written.push(tmpName(to));
      fs.writeFileSync(tmpName(to), data);
    }
  } catch (e) {
    for (const tmp of written) fs.rmSync(tmp, { force: true });
    fail(`could not write the new manifests (${e.message}) — nothing was switched; the served pairing is unchanged`);
  }
  for (const { to } of switches) fs.renameSync(tmpName(to), to);
}

// Inventory, not deletion: report chunks under public/runtime that no
// manifest there references any more. Garbage collection is a deliberate,
// separate act (docs/DEPLOY.md), never a side effect of a promote.
if (!dryRun && fs.existsSync(path.join(publicRuntime, "chunks"))) {
  const referenced = new Set();
  for (const f of fs.readdirSync(publicRuntime)) {
    if (!/^runtime-manifest.*\.json$/.test(f)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(publicRuntime, f), "utf8"));
      for (const file of Object.values(m.files ?? {})) for (const c of file.chunks ?? []) referenced.add(path.basename(c.url));
    } catch { /* not a manifest */ }
  }
  const orphans = fs.readdirSync(path.join(publicRuntime, "chunks")).filter((f) => !referenced.has(f));
  if (orphans.length) console.log(`note: ${orphans.length} chunk file(s) under public/runtime/chunks are referenced by no manifest (left in place)`);
}
// Same inventory for pack parts. Profile manifests have no per-build copies,
// so a pack switch orphans the whole previous part set at once.
if (!dryRun && stagedPacks) {
  const referenced = new Set();
  for (const f of fs.readdirSync(publicProfiles)) {
    if (!f.endsWith(".manifest.json")) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(publicProfiles, f), "utf8"));
      for (const p of m.content?.pack?.transport?.parts ?? []) referenced.add(path.basename(p.url));
    } catch { /* not a manifest */ }
  }
  const orphans = fs.readdirSync(publicProfiles).filter((f) => /\.part-\d+$/.test(f) && !referenced.has(f));
  if (orphans.length) console.log(`note: ${orphans.length} pack part file(s) under public/profiles are referenced by no manifest (left in place)`);
}

console.log(plan.join("\n"));
console.log(`${dryRun ? "DRY RUN — would promote" : "promoted"} runtime ${manifest.buildId} + ${index.snapshots.length} snapshot(s): ` +
  index.snapshots.map((s) => `${s.name} (${(s.transfer ?? s.bytes) / 1e6 | 0} MB wire)`).join(", "));
if (stagedPacks) console.log(`${dryRun ? "  would promote" : "  promoted"} ${stagedPacks.summary.length} profile(s): ${stagedPacks.summary.join(", ")}`);
else if (repointedIndex !== null) console.log(`  kernel-only: served packs kept, profiles/index.json ${dryRun ? "would be " : ""}re-pointed at ${promotedRuntime.buildId} (Lean ${promotedRuntime.leanVersion})`);
else console.log(`  kernel-only: no profiles/index.json under ${rel(publicProfiles)} — nothing to re-point`);
if (!dryRun) console.log("restart the dev server so Vite indexes the new public/ files (HARDENING #13)");
