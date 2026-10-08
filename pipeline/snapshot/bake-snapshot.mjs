#!/usr/bin/env node
// Bake an environment snapshot with the exact wasm64 runtime under Node.
//
// Snapshots embed closure relocations keyed to the producing binary's function
// table ("wasm-main" pseudo-library), so they MUST be baked by the same
// lean.js/lean.wasm the browser runs. The app preloads the result to replace
// the first import with a seconds-long region load.
//
// Output is a STAGING tree (work/staging/<buildId>/snapshots by default, where
// <buildId> is the identity of the artifact's lean.wasm — the same function
// chunk-runtime.mjs uses), and every index entry records that `runtime`, so
// the pairing is a datum rather than prose (review C6). `--out` inside
// public/ is refused before the runner starts; promotion is a separate step.
//
// Usage: node pipeline/snapshot/bake-snapshot.mjs [--name init] [--probe '#check 2+2'] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--allow-legacy-imports] [--runner <script>]
// Paths: each flag, else its variable (QED64_LEAN_ARTIFACT, QED64_WORK,
// QED64_STAGING), else the deprecated repo-relative default with one WARNING
// (docs/CLI-CONTRACT.md "Path resolution").
// (--help; the contract — flags, exit codes, stable output — is docs/CLI-CONTRACT.md)

import { execFileSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildIdOfArtifact, refuseInsidePublic, resolveToolPath, stagingDir, toolPath } from "../toolchain/artifact-paths.mjs";

// <cli-contract> generated from SPECS["bake-snapshot"] in pipeline/snapshot/cli.mjs. Do not edit:
// `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts
// fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.
// It runs before any side effect: --help/-h prints the help and exits 0, a missing required
// flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and
// --flag=value is rewritten to the two-token form this script reads, with the later values
// of a repeated flag dropped so the first wins here too (docs/CLI-CONTRACT.md).
{
  const spec = {"tool":"bake-snapshot","usage":"bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--allow-legacy-imports] [--runner <script>]","flags":{"name":1,"probe":1,"artifact":1,"lib":1,"reserve":1,"work":1,"out":1,"roots":1,"label":1,"initial-bytes":1,"allow-legacy-imports":0,"runner":1},"required":[],"passthrough":null,"passthroughRequired":false};
  spec.help = [
    "usage: bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--allow-legacy-imports] [--runner <script>]",
    "Bake an environment snapshot with the exact wasm64 runtime under Node (the runner is supervised and reaped), gzip it content-addressed into the staging dir and upsert its index entry; the index's per-build copy index.<buildId>.json is written beside it with the same bytes.",
    "run as: node pipeline/snapshot/bake-snapshot.mjs (or npm run bake:snapshot -- …)",
    "",
    "flags:",
    "  --name <name>            snapshot name: <work>/<name>.snap, <name>.<digest16>.snapz and the index entry (default: init)",
    "  --probe <lean source>    the baked file; its import lines become the entry's imports (the env-cache key) (default: #check (2 + 2 : Nat))",
    "  --artifact <dir>         stage1 dir whose bin/lean.wasm bakes and is stamped as `runtime`; always passed to the runner (default: $QED64_LEAN_ARTIFACT, else (deprecated, one WARNING) pipeline/toolchain/work/build/stage1 under the repo root when it has bin/lean.wasm; nothing else: exit 2)",
    "  --lib <olean tree>       olean tree mounted at /lib/lean (default: the runner's <artifact>/lib/lean)",
    "  --reserve <bytes>        compactor buffer reserved up front (LEAN_COMPACTOR_RESERVE for the runner) (default: 3758096384 (3.5 GiB))",
    "  --work <dir>             raw .snap + probe.lean; <work>/<name>.snap is deleted when the bake starts; a relative --work resolves against the repo root (default: $QED64_WORK, else (deprecated, one WARNING) work/snapshot under the repo root: the PAIRED set the probes load)",
    "  --out <dir>              staged .snapz, index.json and its per-build copy index.<buildId>.json (same bytes, copy first; another runtime's copy is never touched); refused inside public/; a relative --out resolves against the repo root (default: $QED64_STAGING, else (deprecated, one WARNING) work/staging/<buildId>/snapshots under the repo root; with QED64_STAGING, <QED64_STAGING>/<buildId>/snapshots)",
    "  --roots <A,B,…>          module roots the entry serves (docs/EMBEDDING.md §8): the page boots and widens to it for a header naming one (default: none (the legacy rule: an entry named mathlib serves the umbrella roots))",
    "  --label <text>           the entry's human name for the page's pill and boot card (default: none)",
    "  --initial-bytes <bytes>  initial Memory64 commit when the entry is loaded (default: none (2 GiB with a non-base entry))",
    "  --allow-legacy-imports   let the runner's env cache load legacy non-module packages (patch 0030): sets QED64_ALLOW_LEGACY_IMPORTS=1 for the runner; an inherited QED64_ALLOW_LEGACY_IMPORTS does the same",
    "  --runner <script>        the runner script, spawned as <this node> --stack-size=8192 <script> --work <dir> --artifact <dir> [--lib <tree>] -- …; a relative path resolves against the cwd (default: $QED64_RUNNER, else QED64's own pipeline/snapshot/node-runner.mjs (not deprecated))",
    "  -h, --help               print this help and exit 0, before any side effect",
    "",
    "environment:",
    "  QED64_LEAN_ARTIFACT       stage1 artifact dir (bin/lean.js, bin/lean.wasm, lib/lean) used when --artifact is absent (empty = unset)",
    "  QED64_WORK                the dir mounted at /work (bake-snapshot: where <name>.snap lands) used when --work is absent",
    "  QED64_STAGING             the staging root used when --out is absent: --out is <QED64_STAGING>/<buildId>/{snapshots,runtime}",
    "  QED64_RUNNER              the runner script bake-snapshot spawns when --runner is absent (default: QED64's own pipeline/snapshot/node-runner.mjs)",
    "  LEAN_COMPACTOR_RESERVE    bytes the compactor reserves up front for a whole-environment save (toolchain patch 0011)",
    "  QED64_ALLOW_LEGACY_IMPORTS",
    "                            when set (non-empty), lets the exported-level env cache load legacy non-module packages (patch 0030; the lean4game bakes); bake-snapshot --allow-legacy-imports sets it to 1 for its runner",
    "  QED64_PROFILE_INIT        when set, forwarded into the wasm environment to profile the [init] replay",
    "",
    "exit codes:",
    "  0  baked and the index upserted (also when the wedged runner was reaped); NOT a verdict on the probe's Lean messages",
    "  1  the runner exited non-zero, or no .snap was produced",
    "  2  refused before the runner: no --artifact, QED64_LEAN_ARTIFACT or deprecated default; no lean.wasm under the artifact, --out inside public/, an index paired with another runtime or with none, a malformed --roots or --initial-bytes, a --runner (or QED64_RUNNER) script that does not exist",
    "",
    "tier 1 (downstream-stable). Contract: docs/CLI-CONTRACT.md",
  ].join("\n");
  const args = process.argv.slice(2);
  const normalized = (function cliContract(spec, args, io = { out: (s) => console.log(s), err: (s) => console.error(s), exit: (c) => process.exit(c) }) {
    const values = {};
    const warnings = [];
    const normalized = [];
    let passthrough = [];
    let help = false;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (token === "--help" || token === "-h") { help = true; continue; }
      if (token === "--" && spec.passthrough) { passthrough = args.slice(i + 1); normalized.push(...args.slice(i)); break; }
      const m = /^--([^=]+)(=[\s\S]*)?$/.exec(token);
      const arity = m && Object.hasOwn(spec.flags, m[1]) ? spec.flags[m[1]] : -1;
      if (arity < 0 || (arity === 0 && m[2] !== undefined)) {
        if (spec.passthrough === "implicit") { passthrough = args.slice(i); normalized.push(...passthrough); break; }
        warnings.push(token.startsWith("-") ? `unknown flag ${token} ignored` : `unexpected argument ${token} ignored`);
        normalized.push(token);
        continue;
      }
      const name = m[1];
      const repeated = Object.hasOwn(values, name);
      let value = true;
      if (arity === 1) {
        value = m[2] !== undefined ? m[2].slice(1) : i + 1 < args.length ? args[(i += 1)] : undefined;
        if (value === "--help" || value === "-h") help = true;
        if (!repeated) normalized.push(`--${name}`, ...(value === undefined ? [] : [value]));
        if (!value) warnings.push(`flag --${name} has no value; ignored`);
      } else normalized.push(token);
      if (!repeated) values[name] = value ?? "";
      else if (arity === 1) warnings.push(`flag --${name} repeated; the first value wins`);
    }
    if (help) { io.out(spec.help); io.exit(0); return null; }
    for (const w of warnings) io.err(`${spec.tool}: WARNING — ${w}`);
    for (const name of Object.keys(values)) if (values[name] === "") delete values[name];
    const missing = (spec.required || []).some((group) => !group.some((name) => Object.hasOwn(values, name)));
    if (missing || (spec.passthroughRequired && passthrough.length === 0)) { io.err(`usage: ${spec.usage}`); io.exit(2); return null; }
    return { values, passthrough, args: normalized };
  })(spec, args)?.args ?? args;
  if (normalized.join("\0") !== args.join("\0")) process.argv.splice(2, args.length, ...normalized);
}
// </cli-contract>

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const name = arg("name", "init");
const probe = arg("probe", "#check (2 + 2 : Nat)");
// Overlay metadata (docs/EMBEDDING.md §8), written into the entry only when
// given: the module roots the environment serves, a label, an initial commit.
const ROOT = /^[A-Za-z_][\w']*(?:\.[A-Za-z_][\w']*)*$/;
const rootsArg = arg("roots", null);
const roots = rootsArg === null ? null : rootsArg.split(",").map((r) => r.trim()).filter(Boolean);
if (roots !== null && (roots.length === 0 || !roots.every((r) => ROOT.test(r)))) {
  console.error(`bake-snapshot: refusing --roots ${JSON.stringify(rootsArg)}: expected comma-separated module roots (e.g. Mathlib,ProofWidgets)`);
  process.exit(2);
}
const label = arg("label", null);
const initialBytesArg = arg("initial-bytes", null);
const initialBytes = initialBytesArg === null ? null : Number(initialBytesArg);
if (initialBytes !== null && !(Number.isSafeInteger(initialBytes) && initialBytes > 0)) {
  console.error(`bake-snapshot: refusing --initial-bytes ${JSON.stringify(initialBytesArg)}: expected a positive whole number of bytes`);
  process.exit(2);
}
const USAGE = "bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--allow-legacy-imports] [--runner <script>]";
// The runtime identity comes from the artifact that will do the baking,
// never from a manifest in public/ — a bake must not inherit whatever the
// served tree happens to say.
const artifactDir = resolveToolPath({
  tool: "bake-snapshot", flag: "artifact", placeholder: "<dir>", value: arg("artifact", null), env: "QED64_LEAN_ARTIFACT",
  legacy: path.join(root, "pipeline/toolchain/work/build/stage1"), legacyLabel: "pipeline/toolchain/work/build/stage1 under the repo root",
  holds: (dir) => fs.existsSync(path.join(dir, "bin/lean.wasm")) || fs.existsSync(path.join(dir, "lean.wasm")), needs: "bin/lean.wasm", usage: USAGE,
}).path;
const buildId = buildIdOfArtifact(artifactDir);
if (!buildId) {
  console.error(`bake-snapshot: no lean.wasm under ${artifactDir} — pass --artifact <stage1 dir>`);
  process.exit(2);
}
const out = resolveToolPath({
  tool: "bake-snapshot", flag: "out", placeholder: "<dir>", value: arg("out", null), base: root,
  env: "QED64_STAGING", envTo: (staging) => path.join(staging, buildId, "snapshots"),
  legacy: stagingDir(root, buildId, "snapshots"), legacyLabel: "work/staging/<buildId>/snapshots under the repo root", usage: USAGE,
}).path;
refuseInsidePublic(root, out, "bake-snapshot");

// The index this bake will upsert into is ONE pairing, checked before the
// runner starts (a refusal after a 20-minute bake is the expensive kind):
// entries baked by another runtime must not survive next to this one (they
// would be served under this manifest and trap in the browser), and entries
// with no `runtime` at all (pre-field bakes) would leave promote refusing
// with "none recorded" and the user guessing which names to rebake.
const indexPath = path.join(out, "index.json");
let index = { schema: "qed64.snapshot-index/v1", snapshots: [] };
try { index = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch {}
const siblings = index.snapshots.filter((s) => s.name !== name);
const foreign = siblings.filter((s) => s.runtime && s.runtime !== buildId);
if (foreign.length) {
  console.error(`bake-snapshot: ${indexPath} already holds entries for runtime ${foreign[0].runtime} (${foreign.map((s) => s.name).join(", ")}) — refusing to mix pairings`);
  process.exit(2);
}
const unpaired = siblings.filter((s) => !s.runtime);
if (unpaired.length) {
  console.error(`bake-snapshot: ${indexPath} holds entries with no runtime pairing (${unpaired.map((s) => s.name).join(", ")}) — rebake ${unpaired.map((s) => `--name ${s.name}`).join(", ")} against this runtime first, or bake into an empty --out (promote refuses an unpaired index)`);
  process.exit(2);
}

// The runner: --runner, else QED64_RUNNER, else QED64's own node-runner (the
// default, not deprecated). Checked before --work is created or the paired
// .snap unlinked.
const runner = toolPath({ value: arg("runner", null), env: "QED64_RUNNER", legacy: path.join(root, "pipeline/snapshot/node-runner.mjs") }).path;
if (!fs.existsSync(runner)) {
  console.error(`bake-snapshot: no runner script ${runner} — pass --runner <script> or set QED64_RUNNER`);
  process.exit(2);
}

// The raw .snap lands here. The default, work/snapshot, is the PAIRED set the
// Node probes and the compiler battery load against the served binary — a
// bake for any other runtime (a version import, an experiment) must pass
// --work <dir> or it silently unpairs them (the binary-pairing invariant, docs/REBUILD.md §3).
const work = resolveToolPath({
  tool: "bake-snapshot", flag: "work", placeholder: "<dir>", value: arg("work", null), base: root, env: "QED64_WORK",
  legacy: path.join(root, "work/snapshot"), legacyLabel: "work/snapshot under the repo root", usage: USAGE,
}).path;
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, "probe.lean"), `${probe}\n`);

const runnerArgs = [
  runner,
  "--work", work,
];
// Always the RESOLVED artifact: the `runtime` stamped below (from
// artifactDir's lean.wasm) must name the binary that baked, whatever the
// runner's own resolution would have picked.
runnerArgs.push("--artifact", artifactDir);
const lib = arg("lib", null);
if (lib) runnerArgs.push("--lib", lib);
runnerArgs.push("--", `--incr-header-save=/work/${name}.snap`, "/work/probe.lean");

// Reserve the compactor's output buffer in one allocation: a whole-Mathlib
// environment compacts to >2 GiB, and growth-by-doubling would need the old
// and new buffers to coexist — more than the 16 GiB wasm64 space holds next
// to the environment itself (toolchain patch 0011).
const reserve = arg("reserve", String(3.5 * 1024 ** 3));
// Legacy non-module packages (the lean4game games) need patch 0030's gate in
// the runner; the flag is the documented form, the inherited variable its
// equivalent (node-runner forwards either into the wasm environment).
const allowLegacyImports = process.argv.includes("--allow-legacy-imports");
console.log(`baking ${name}.snap for runtime ${buildId} (probe: ${JSON.stringify(probe)}; compactor reserve ${(Number(reserve) / 1024 ** 3).toFixed(1)} GiB) → ${out}`);
// Patch 0031 (PROXY_TO_PTHREAD): the runner's process EXIT wedges — the
// proxied exit is swallowed by the 0020 mailbox keepalive — while the actual
// bake (save + probe) completes fine. Supervise: once the target .snap has
// been stable for a while after the runner goes quiet, reap the child.
// The bake must start CLEAN: a stale target satisfies the stability check
// before the new save even begins (it cost two silently-skipped bakes).
try { fs.rmSync(path.join(work, `${name}.snap`)); } catch { /* absent */ }
await new Promise((resolve, reject) => {
  const child = execFile(process.execPath, ["--stack-size=8192", ...runnerArgs], {
    env: { ...process.env, LEAN_COMPACTOR_RESERVE: reserve, ...(allowLegacyImports ? { QED64_ALLOW_LEGACY_IMPORTS: "1" } : {}) },
    maxBuffer: 64 * 1024 * 1024,
  }, () => {});
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  let lastActivity = Date.now();
  child.stdout.on("data", () => { lastActivity = Date.now(); });
  child.stderr.on("data", () => { lastActivity = Date.now(); });
  const target = path.join(work, `${name}.snap`);
  let lastSize = -1;
  let stableSince = 0;
  const watch = setInterval(() => {
    const size = fs.existsSync(target) ? fs.statSync(target).size : -1;
    if (size !== lastSize) { lastSize = size; stableSince = Date.now(); }
    // The compactor is CPU-silent for many minutes between the last import
    // line and the finished save — quiet alone means nothing, and stability
    // only counts because the target was unlinked at bake start.
    const quiet = Date.now() - lastActivity > 300000;
    const stable = size > 0 && Date.now() - stableSince > 120000;
    if (quiet && stable) {
      clearInterval(watch);
      console.log(`bake output stable (${size} bytes) with runner quiet — reaping the wedged exit`);
      child.kill("SIGKILL");
      resolve();
    }
  }, 5000);
  child.on("exit", (code) => {
    clearInterval(watch);
    if (code === 0 || code === null) resolve();
    else reject(new Error(`runner exited ${code}`));
  });
});

const snap = path.join(work, `${name}.snap`);
if (!fs.existsSync(snap)) {
  console.error("FAIL: snapshot file was not produced");
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
try { fs.rmSync(`${snap}.deps`); } catch {}
const snapBytes = fs.statSync(snap).size;

// Serve gzip: region dumps compress ~2×, and the worker inflates through
// DecompressionStream. Only the .gz is published.
console.log(`compressing ${name}.snapz …`);
// `.snapz`, not `.gz`: a recognised gzip extension makes servers add Content-Encoding
// and the browser pre-inflates, defeating the worker's compressed OPFS cache.
// The published name is CONTENT-ADDRESSED (`<name>.<digest16>.snapz`):
// snapshots are binary-paired to the runtime, and a rebuilt runtime produces
// a region of the *identical raw size* (same env content, different
// relocation values) — so a fixed name behind immutable HTTP caching let a
// stale snapshot pass every size check and trap "memory access out of
// bounds" against the new binary. The digest in the URL makes immutable
// caching correct.
const tmpPath = path.join(out, `${name}.snapz.tmp`);
const hasher = createHash("sha256");
await pipeline(
  fs.createReadStream(snap),
  createGzip({ level: 6 }),
  async function* (chunks) { for await (const c of chunks) { hasher.update(c); yield c; } },
  fs.createWriteStream(tmpPath),
);
const digest = hasher.digest("hex");
const gzName = `${name}.${digest.slice(0, 16)}.snapz`;
const gzPath = path.join(out, gzName);
fs.renameSync(tmpPath, gzPath);
// Older bakes of the same logical name are LEFT IN PLACE: content-addressed
// files never collide, and a producer that unlinks is how the served tree was
// lost (review C6: additive only; garbage-collect deliberately, later).
const transferBytes = fs.statSync(gzPath).size;

// Upsert the snapshot index the app consumes: each entry records the ORDERED
// header imports its environment was baked for (the runtime keys its env
// cache by exactly that list; empty = the default no-import header) and the
// `runtime` it is binary-paired with.
const importsOf = (source) => {
  const found = [];
  for (const line of source.split("\n")) {
    const m = /^(?:public\s+|private\s+)?(?:meta\s+)?import\s+([A-Za-z_][\w.«»]*)/.exec(line.trim());
    if (m) found.push(m[1]);
  }
  return found;
};
const entry = {
  name,
  url: `/snapshots/${gzName}`,
  digest: `sha256:${digest}`,
  bytes: snapBytes,
  transfer: transferBytes,
  imports: importsOf(probe),
  runtime: buildId,
  ...(roots ? { roots } : {}),
  ...(label ? { label } : {}),
  ...(initialBytes ? { initialBytes } : {}),
};
// THE PER-BUILD COPY (HARDENING #64). Beside index.json the bake writes
// index.<buildId>.json, the same bytes, named by the runtime this index is
// paired with (the refusals above keep one --out to one pairing): the copy a
// page pinned to that runtime reads when the mutable index.json beside it
// names another runtime (loadSnapshotIndex's `pairedBuildId`,
// lib/snapshots.ts). Another runtime's copy in --out is never touched.
// QED64's own path does not need it: promote-staging derives public/'s copy
// from the staged index.json and ignores this one, and upload-artifacts.sh
// sends no local copy (it writes R2's from the mutable file). It suits only
// a consumer that serves its staging dir UNMERGED (uploads --out as baked):
// the copy arrives with the index, so a page pinned to this runtime keeps
// reading its pairing when that consumer's next pairing is uploaded ahead of
// its deploy. This file is the STAGING index (only this --out's bakes); a
// consumer that merges staged entries into its served index (lean4game's
// scripts/stage-snapshots.py keeps other names) must derive its copy from
// that merged index instead, or a pinned page would miss every entry not
// rebaked here (HARDENING #64, the relay to lean4game).
//
// The upsert runs under the index's lock (index.json.lock, created by an
// exclusive open, O_CREAT|O_EXCL, which every local filesystem the staging
// dir may sit on supports: link(2) is refused by exFAT/FAT and some FUSE or
// SMB mounts, and its failure came AFTER the runner. The lock holds its
// holder's pid. A lock whose pid is dead on this host is a crashed holder's
// and is taken over; a live holder is waited for, at most LOCK_WAIT_MS, and
// then the bake fails (exit 1) naming it, rather than breaking a lock that a
// slow disk or a stopped process still owns; an empty lock older than
// LOCK_EMPTY_STALE_MS is a holder that died between the create and the pid
// write; the lean4-wasm64 package's port of this bake uses the same rule): a concurrent
// bake of a sibling name re-reads, merges and writes after this one, never
// interleaved with it, so its entry is not lost and the two files are never
// written by different bakes. Both files go through temp file + rename
// (both temps written first: a full disk fails before either switches),
// the COPY FIRST and index.json LAST, as promote-staging switches public/:
// index.json is the commit record. Every version of either file names this
// runtime only, so no order can show a reader a mispaired index. Copy-first
// means the copy is never OLDER than index.json: at every instant it holds
// index.json's bytes or the next version's (whose .snapz is already in
// place), so a reader that falls back to it never loses an entry the index
// has committed; a crash between the renames leaves the copy one version
// ahead, never behind, and the next bake of this --out rewrites both.
const copyPath = path.join(out, `index.${buildId}.json`);
const lockPath = `${indexPath}.lock`;
// The wait bound; QED64_BAKE_LOCK_WAIT_MS overrides it for tests only (not a contract variable).
const LOCK_WAIT_MS = Number(process.env.QED64_BAKE_LOCK_WAIT_MS) > 0 ? Number(process.env.QED64_BAKE_LOCK_WAIT_MS) : 120000;
const LOCK_EMPTY_STALE_MS = 5000;
/** true when `pid` is a process on this host (EPERM: alive, another user's). */
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const lockWaitStart = Date.now();
for (;;) {
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let text = "";
    let age = 0;
    try { text = fs.readFileSync(lockPath, "utf8"); age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; } // released meanwhile
    const holder = /^(\d+)\n$/.exec(text);
    if (holder ? !pidAlive(Number(holder[1])) : age > LOCK_EMPTY_STALE_MS) { fs.rmSync(lockPath, { force: true }); continue; }
    if (Date.now() - lockWaitStart > LOCK_WAIT_MS) {
      console.error(`bake-snapshot: index lock ${lockPath} is held by live pid ${holder ? holder[1] : "(unwritten)"} for over ${LOCK_WAIT_MS} ms; not taking it over (the .snapz is in place, the index is not updated)`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    continue;
  }
  try {
    fs.writeSync(fd, `${process.pid}\n`);
  } catch (e) {
    fs.rmSync(lockPath, { force: true }); // ours, just created: never left behind for the next bake to wait out
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  break;
}
try {
  // Re-read: a concurrent bake of a sibling name may have upserted meanwhile.
  try { index = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch {}
  index.snapshots = index.snapshots.filter((s) => s.name !== name).concat([entry]);
  const indexText = JSON.stringify(index, null, 2);
  const writes = [copyPath, indexPath].map((to) => ({ to, tmp: `${to}.${process.pid}.tmp` }));
  try {
    for (const { tmp } of writes) fs.writeFileSync(tmp, indexText);
    for (const { to, tmp } of writes) fs.renameSync(tmp, to);
  } finally {
    for (const { tmp } of writes) fs.rmSync(tmp, { force: true });
  }
} finally {
  // Released only while it is still this bake's.
  try { if (fs.readFileSync(lockPath, "utf8") === `${process.pid}\n`) fs.rmSync(lockPath, { force: true }); } catch { /* gone */ }
}
console.log(
  `baked ${gzPath} (${transferBytes} bytes transfer, ${snapBytes} raw); ` +
    `index updated (imports: [${entry.imports.join(", ")}], runtime ${buildId})`,
);
console.log(`index copy ${copyPath} written (runtime ${buildId})`);
