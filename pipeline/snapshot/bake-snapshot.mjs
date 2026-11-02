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
// The runner never exits by itself (patches 0020/0031). The bake is done once
// <work>/<name>.snap has the same nonzero size at two polls --stable-ms apart
// (the runtime writes <name>.snap.tmp.<pid> and renames it, after probe.lean's
// whole log), and then stops it (architecture review R5a). A failure line with
// no .snap and no save in progress, then --quiet-ms without output, or no
// complete .snap within --give-up-ms: exit 1. A failure line and a complete
// .snap: one WARNING and one `verdict <json>` line on stderr before compressing
// (D6's notice); for one downstream re-pin the bake still indexes and exits 0,
// then such a bake exits 1 without indexing.
//
// Stop it with SIGTERM, SIGINT or SIGHUP: it forwards the signal to its runner,
// writes no index and exits 128+n. The runner gets only PATH, HOME, TMPDIR and
// the bake's own variables (runnerEnv below).
//
// One bake per --work at a time: <work>/.bake.lock holds the bake's pid and then
// its runner's, is never taken over, and is released when the bake exits (kept
// when its runner is still running; a SIGKILLed bake leaves it: remove it once
// no bake uses --work). QED64 owns the bake and the snapshot index (architecture
// review D4 a); the writer rules are docs/SNAPSHOT-INDEX.md.
//
// Usage: node pipeline/snapshot/bake-snapshot.mjs [--name init] [--probe '#check 2+2'] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--entry-fields <json object>] [--allow-legacy-imports] [--runner <script>] [--stable-ms <ms>] [--quiet-ms <ms>] [--give-up-ms <ms>]
// Paths: each flag, else its variable (QED64_LEAN_ARTIFACT, QED64_WORK,
// QED64_STAGING), else the deprecated repo-relative default with one WARNING
// (docs/CLI-CONTRACT.md "Path resolution").
// (--help; the contract — flags, exit codes, stable output — is docs/CLI-CONTRACT.md)

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
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
  const spec = {"tool":"bake-snapshot","usage":"bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--entry-fields <json object>] [--allow-legacy-imports] [--runner <script>] [--stable-ms <ms>] [--quiet-ms <ms>] [--give-up-ms <ms>]","flags":{"name":1,"probe":1,"artifact":1,"lib":1,"reserve":1,"work":1,"out":1,"roots":1,"label":1,"initial-bytes":1,"entry-fields":1,"allow-legacy-imports":0,"runner":1,"stable-ms":1,"quiet-ms":1,"give-up-ms":1},"required":[],"passthrough":null,"passthroughRequired":false};
  spec.help = [
    "usage: bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--entry-fields <json object>] [--allow-legacy-imports] [--runner <script>] [--stable-ms <ms>] [--quiet-ms <ms>] [--give-up-ms <ms>]",
    "Bake an environment snapshot with the exact wasm64 runtime under Node: the runner, which never exits by itself, is stopped once <work>/<name>.snap is complete; gzip it content-addressed into the staging dir and upsert its index entry (docs/SNAPSHOT-INDEX.md); the index's per-build copy index.<buildId>.json is written beside it with the same bytes.",
    "run as: node pipeline/snapshot/bake-snapshot.mjs (or npm run bake:snapshot -- …)",
    "",
    "flags:",
    "  --name <name>             snapshot name, a letter or digit then letters, digits, '.', '_' or '-': <work>/<name>.snap, <name>.<digest16>.snapz and the index entry (default: init)",
    "  --probe <lean source>     the baked file; its import lines become the entry's imports (the env-cache key) (default: #check (2 + 2 : Nat))",
    "  --artifact <dir>          stage1 dir whose bin/lean.wasm bakes and is stamped as `runtime`; always passed to the runner (default: $QED64_LEAN_ARTIFACT, else (deprecated, one WARNING) pipeline/toolchain/work/build/stage1 under the repo root when it has bin/lean.wasm; nothing else: exit 2)",
    "  --lib <olean tree>        olean tree mounted at /lib/lean; a --lib that is not a directory refuses (exit 2) before anything is touched (default: the runner's <artifact>/lib/lean)",
    "  --reserve <bytes>         compactor buffer reserved up front (LEAN_COMPACTOR_RESERVE for the runner) (default: 3758096384 (3.5 GiB))",
    "  --work <dir>              raw .snap + probe.lean; <work>/<name>.snap is deleted when the bake starts; a relative --work resolves against the repo root; one bake per --work at a time (<work>/.bake.lock: the bake's and its runner's pids; never taken over) (default: $QED64_WORK, else (deprecated, one WARNING) work/snapshot under the repo root: the PAIRED set the probes load)",
    "  --out <dir>               staged .snapz, index.json and its per-build copy index.<buildId>.json (same bytes, copy first; another runtime's copy is never touched); refused inside public/; a relative --out resolves against the repo root (default: $QED64_STAGING, else (deprecated, one WARNING) work/staging/<buildId>/snapshots under the repo root; with QED64_STAGING, <QED64_STAGING>/<buildId>/snapshots)",
    "  --roots <A,B,…>           module roots the entry serves (docs/EMBEDDING.md §8): the page boots and widens to it for a header naming one (default: none (the legacy rule: an entry named mathlib serves the umbrella roots))",
    "  --label <text>            the entry's human name for the page's pill and boot card (default: none)",
    "  --initial-bytes <bytes>   initial Memory64 commit when the entry is loaded (default: none (2 GiB with a non-base entry))",
    "  --entry-fields <json object>",
    "                            more entry fields after the core keys and roots/label/initialBytes, in the object's order; refused: not a JSON object, a core key, roots/label/initialBytes (their flags validate them), and the reserved raw, lib and bakedBy (docs/SNAPSHOT-INDEX.md) (default: none)",
    "  --allow-legacy-imports    let the runner's env cache load legacy non-module packages (patch 0030): sets QED64_ALLOW_LEGACY_IMPORTS=1 for the runner; an inherited QED64_ALLOW_LEGACY_IMPORTS does the same",
    "  --runner <script>         the runner script, spawned as <this node> --stack-size=8192 <script> --work <dir> --artifact <dir> [--lib <tree>] -- …; a relative path resolves against the cwd (default: $QED64_RUNNER, else QED64's own pipeline/snapshot/node-runner.mjs (not deprecated))",
    "  --stable-ms <ms>          the poll interval: the bake is done once <work>/<name>.snap has the same size at two polls this far apart; the runner is then stopped (default: 5000)",
    "  --quiet-ms <ms>           after a failure line in the runner's output: this long without output, with no <name>.snap and no save in progress, ends the bake (exit 1) (default: 120000)",
    "  --give-up-ms <ms>         no complete <name>.snap by then ends the bake (exit 1) (default: 21600000 (6 h))",
    "  -h, --help                print this help and exit 0, before any side effect",
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
    "  0    baked: the .snap complete, compressed, and the index upserted (the runner is stopped once its .snap is complete); NOT yet a verdict on Lean messages: a failure line adds the notice WARNING and a verdict line, and exits 1 after one downstream re-pin (D6)",
    "  1    after the bake started: the runner exited non-zero, was killed by a signal this bake did not send or could not start; no .snap was produced (a failure line and then --quiet-ms of quiet, or nothing complete within --give-up-ms); compressing failed; or the index could not be written (unreadable, corrupt, foreign or unpaired under the lock, its lock held past the wait, or a failed write): a written .snapz is kept and its entry printed (unindexed entry <json>)",
    "  2    refused before the runner: no --artifact, QED64_LEAN_ARTIFACT or deprecated default; no lean.wasm under the artifact, --out inside public/, an index paired with another runtime or with none, a malformed --roots, --initial-bytes, --stable-ms, --quiet-ms or --give-up-ms, a --runner (or QED64_RUNNER) script that does not exist, an unreadable or corrupt index.json (only a missing one is a new index), a bad --name or --entry-fields, a --lib that is not a directory, or a <work>/.bake.lock that is held or cannot be created",
    "  129  SIGHUP received before the index was written: forwarded to the runner (SIGKILL 10 s later), no index write",
    "  130  SIGINT, likewise",
    "  143  SIGTERM, likewise",
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

// ---------- process state: signals, the runner, temp files ----------
// The kernel copy's rules, ported as behaviour (architecture review D4 a): no runner outlives
// its bake, a signal writes no index, and a .snapz in place but not indexed gets its entry printed.
const TOOL = "bake-snapshot";
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const state = {
  signal: null, // the first SIGINT/SIGTERM/SIGHUP this bake received
  child: null, // the runner until it has closed
  workLock: null, // <work>/.bake.lock once taken: { path, addPid(pid), release() }
  snapzTmp: null, // the .snapz temp while it is written
  unindexed: null, // the entry of a .snapz in place but not (yet) in the index
  indexed: false, // index.json and its copy written: a later signal changes nothing
};
/**
 * One whole line on stderr from the 'exit' handler, where a stream write may never be flushed:
 * fd 2 is made blocking (libuv makes a pipe non-blocking), every byte written, EAGAIN retried for
 * about 2 s. Only a stderr that is gone loses it.
 */
function lastWords(line) {
  try { process.stderr._handle?.setBlocking?.(true); } catch { /* not a pipe or TTY */ }
  const bytes = Buffer.from(`${line}\n`);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let at = 0, tries = 0; at < bytes.length;) {
    try {
      at += fs.writeSync(2, bytes, at);
    } catch (e) {
      if (e?.code !== "EAGAIN" || (tries += 1) > 200) return;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}
for (const sig of Object.keys(SIGNAL_EXIT)) {
  process.on(sig, () => {
    if (state.indexed) return; // the index is written: finish as planned
    // A second signal, or no runner to wait for: exit now (the 'exit' handler cleans up).
    if (state.signal || !state.child) process.exit(SIGNAL_EXIT[state.signal ?? sig]);
    state.signal = sig;
    process.exitCode = SIGNAL_EXIT[sig];
    const child = state.child;
    child.kill(sig);
    // a runner that ignores it is SIGKILLed: no runner outlives its bake
    setTimeout(() => { if (state.child === child) child.kill("SIGKILL"); }, 10_000).unref();
  });
}
// Every exit ends here. A runner still running (a crash mid-bake, or a second signal) is killed,
// and the --work lock that names it is KEPT: the lock lists every process that may write into
// --work, and SIGKILL is not instant. Otherwise the lock is released (only while it is ours).
// A .snapz temp is removed; a .snapz in place but not indexed gets its entry printed.
process.on("exit", () => {
  if (state.child) {
    try { state.child.kill("SIGKILL"); } catch { /* gone */ }
    lastWords(`${TOOL}: the bake ended with its runner (pid ${state.child.pid}) still running: killed${state.workLock ? `; ${state.workLock.path} is kept: remove it once no bake uses --work` : ""}`);
  } else {
    state.workLock?.release();
  }
  if (state.snapzTmp) try { fs.rmSync(state.snapzTmp, { force: true }); } catch { /* left behind */ }
  if (state.unindexed) lastWords(`${TOOL}: unindexed entry ${JSON.stringify(state.unindexed)}`);
});
// The bake's own output is best effort once its reader is gone (`bake | head`, a dead log
// consumer): a closed stdout or stderr never ends a bake, whose runner would be left behind.
for (const s of [process.stdout, process.stderr]) s.on("error", () => {});

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const USAGE = "bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--entry-fields <json object>] [--allow-legacy-imports] [--runner <script>] [--stable-ms <ms>] [--quiet-ms <ms>] [--give-up-ms <ms>]";
// The supervision's clock (R5a; supervised-run's names): the poll interval of the completion rule,
// the failure guard's quiet window and the give-up deadline (6 h, a backstop only).
const TIMING = [["stable-ms", 5000], ["quiet-ms", 120000], ["give-up-ms", 21600000]];
// D6/R5a: a failure line (docs/CLI-CONTRACT.md, bake-snapshot): supervised-run's `: error` rule scoped to
// probe.lean's own diagnostics, plus the runtime's failure lines. SPECS["bake-snapshot"].classifier pins this source line.
const FAILURE = /^(?:\S*\/)?probe\.lean:\d+:\d+: error[:( ]|PANIC|ABORT:|RuntimeError|object compactor:|uncaught exception/;
// A failure line's kind, the first match in this order (no kind name holds a reserved substring).
const FAILURE_KINDS = [
  ["lean-error", /^(?:\S*\/)?probe\.lean:\d+:\d+: error[:( ]/],
  ["compactor", /object compactor:/],
  ["abort", /ABORT:/],
  ["panic", /PANIC/],
  ["runtime-trap", /RuntimeError/],
  ["exception", /uncaught exception/],
];
const failureKind = (line) => FAILURE_KINDS.find(([, re]) => re.test(line))[0];
// A runner line is judged by its first 64 KiB (the scan's memory bound; a diagnostic's position comes first).
const LINE_MAX = 65536;
// Overlay metadata (docs/EMBEDDING.md §8), written into the entry only when
// given: the module roots the environment serves, a label, an initial commit.
const ROOT = /^[A-Za-z_][\w']*(?:\.[A-Za-z_][\w']*)*$/;
// A snapshot name: it is joined into <work>/<name>.snap, <name>.<digest16>.snapz and the entry.
const SNAPSHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// The entry keys docs/SNAPSHOT-INDEX.md gives a meaning: --entry-fields may add any other key.
const CORE_KEYS = ["name", "url", "digest", "bytes", "transfer", "imports", "runtime"];
const PAGE_FIELD_FLAGS = { roots: "roots", label: "label", initialBytes: "initial-bytes" };
const RESERVED_KEYS = ["raw", "lib", "bakedBy"];

/**
 * --entry-fields: one JSON object whose keys go after the core keys and the page fields, in the
 * object's order → { fields } or { refusal }. Refused: not a JSON object, a core key, roots / label
 * / initialBytes (only through their validating flags: one malformed entry makes the page refuse
 * the whole index), and the reserved keys.
 */
function parseEntryFields(text) {
  const refuse = (why) => ({ refusal: `bake-snapshot: refusing --entry-fields ${JSON.stringify(text)}: ${why}` });
  let fields;
  try { fields = JSON.parse(text); } catch { return refuse("expected a JSON object"); }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return refuse("expected a JSON object");
  for (const key of Object.keys(fields)) {
    if (CORE_KEYS.includes(key)) return refuse(`${JSON.stringify(key)} is a core entry key, written by the bake`);
    if (Object.hasOwn(PAGE_FIELD_FLAGS, key)) return refuse(`${JSON.stringify(key)} goes through --${PAGE_FIELD_FLAGS[key]}, which validates it`);
    if (RESERVED_KEYS.includes(key)) return refuse(`${JSON.stringify(key)} is reserved (docs/SNAPSHOT-INDEX.md)`);
  }
  return { fields };
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Only ENOENT is a new index; anything else is refused, never replaced (it would drop every sibling entry). */
function readIndex(indexPath) {
  let text;
  try { text = fs.readFileSync(indexPath, "utf8"); }
  catch (e) {
    if (e?.code === "ENOENT") return { index: { schema: "qed64.snapshot-index/v1", snapshots: [] } };
    return { refusal: `bake-snapshot: cannot read ${indexPath} (${e?.code ?? e?.message}) — refusing to replace it` };
  }
  let index, problem = null;
  try { index = JSON.parse(text); } catch { problem = "it is not JSON"; }
  if (!problem) {
    if (!index || typeof index !== "object" || Array.isArray(index)) problem = "it is not a JSON object";
    else if (index.schema !== "qed64.snapshot-index/v1") problem = `its schema is ${JSON.stringify(index.schema)}, not qed64.snapshot-index/v1`;
    else if (!Array.isArray(index.snapshots)) problem = "it has no snapshots array";
    else {
      const bad = index.snapshots.findIndex((s) => !s || typeof s !== "object" || Array.isArray(s) || typeof s.name !== "string");
      if (bad >= 0) problem = `snapshots[${bad}] is not an entry with a string name`;
    }
  }
  return problem ? { refusal: `bake-snapshot: ${indexPath} is not a snapshot index: ${problem} — refusing to replace it` } : { index };
}

/**
 * The index this bake upserts into is ONE pairing: entries baked by another runtime must not
 * survive next to this one (they would be served under this manifest and trap in the browser),
 * and entries with no `runtime` at all (pre-field bakes) would leave promote refusing with "none
 * recorded" and the user guessing which names to rebake. The refusal line, or null.
 */
function pairingRefusal(index, name, buildId, indexPath) {
  const siblings = index.snapshots.filter((s) => s.name !== name);
  const foreign = siblings.filter((s) => s.runtime && s.runtime !== buildId);
  if (foreign.length) return `bake-snapshot: ${indexPath} already holds entries for runtime ${foreign[0].runtime} (${foreign.map((s) => s.name).join(", ")}) — refusing to mix pairings`;
  const unpaired = siblings.filter((s) => !s.runtime);
  if (unpaired.length) return `bake-snapshot: ${indexPath} holds entries with no runtime pairing (${unpaired.map((s) => s.name).join(", ")}) — rebake ${unpaired.map((s) => `--name ${s.name}`).join(", ")} against this runtime first, or bake into an empty --out (promote refuses an unpaired index)`;
  return null;
}

/** The ORDERED header imports of a probe (the runtime keys its env cache by exactly that list). */
function importsOf(source) {
  const found = [];
  for (const line of source.split("\n")) {
    const m = /^(?:public\s+|private\s+)?(?:meta\s+)?import\s+([A-Za-z_][\w.«»]*)/.exec(line.trim());
    if (m) found.push(m[1]);
  }
  return found;
}

/** true when `pid` is a process on this host (EPERM: alive, another user's); only reported, never acted on. */
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const pidLabel = (pid) => `pid ${pid} (${pidAlive(Number(pid)) ? "running" : "not running"} on this host)`;

/**
 * An existing lock's holder, read without following a link: { text } for a regular file,
 * { gone: true } when it was released meanwhile (ENOENT), else { unreadable }. An exclusive create
 * never makes a symlink, so one at the lock path (dangling or not) is no bake's lock, and neither is
 * a directory: each is named at once, never retried, since open() keeps answering EEXIST for them
 * while no read succeeds (a retry there spun at 100% CPU). Shared by both locks.
 */
function lockHolder(lockPath) {
  try {
    const st = fs.lstatSync(lockPath);
    if (st.isSymbolicLink()) return { unreadable: "a symlink" };
    if (st.isDirectory()) return { unreadable: "a directory" };
    if (!st.isFile()) return { unreadable: "not a regular file" };
    return { text: fs.readFileSync(lockPath, "utf8") };
  } catch (e) {
    return e.code === "ENOENT" ? { gone: true } : { unreadable: `unreadable: ${e.code ?? e.message}` };
  }
}

/**
 * Take the --work lock `lockPath`: an exclusive create holding `<bake pid>\n`, never waited for and
 * never taken over (whatever its holder: running, not running, unreadable; or its age), since two
 * bakes sharing --work bake each other's probe.lean and the runtime's <name>.snap.tmp.<pid> (its
 * getpid() is a constant under Emscripten) and can exit 0 with a wrong snapshot. → { lock } or
 * { refusal } (held, or it cannot be created). lock.addPid(pid) appends `<pid>\n` through the fd
 * that created it (a lock someone removed and another bake re-created is never written);
 * lock.release() closes that fd once and removes the lock only while it reads every line this
 * bake wrote.
 */
function takeWorkLock(lockPath, work) {
  let text = `${process.pid}\n`;
  for (let vanished = 0; ;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (e) {
      if (e?.code !== "EEXIST") return { refusal: `bake-snapshot: cannot create ${lockPath} (${e?.code ?? e?.message})` };
      const held = lockHolder(lockPath);
      if (held.gone && (vanished += 1) <= 100) continue; // released between the create and the read
      const m = held.text === undefined ? null : /^(\d+)\n(?:(\d+)\n)?$/.exec(held.text);
      const who = m
        ? `bake ${pidLabel(m[1])}${m[2] ? ` and runner ${pidLabel(m[2])}` : ""}`
        : `a holder it cannot read (${held.unreadable ?? (held.gone ? "unreadable: ENOENT" : JSON.stringify(held.text.slice(0, 200)))})`;
      return { refusal: `bake-snapshot: --work ${work} is in use (lock ${lockPath} held by ${who}); a lock is never taken over: once no bake uses ${work}, remove it and rerun` };
    }
    try {
      fs.writeSync(fd, text);
    } catch (e) {
      try { fs.closeSync(fd); } catch { /* the write's error is the one reported */ }
      fs.rmSync(lockPath, { force: true }); // ours, just created: never left behind for the next bake to refuse on
      return { refusal: `bake-snapshot: cannot create ${lockPath} (${e?.code ?? e?.message})` };
    }
    let open = true;
    return {
      lock: {
        path: lockPath,
        addPid(pid) {
          const line = `${pid}\n`;
          fs.writeSync(fd, line);
          text += line;
        },
        release() {
          if (open) {
            open = false;
            try { fs.closeSync(fd); } catch { /* closed */ }
          }
          try { if (fs.readFileSync(lockPath, "utf8") === text) fs.rmSync(lockPath, { force: true }); } catch { /* gone, or unreadable: left */ }
        },
      },
    };
  }
}

/** True while the runtime has a save of `name` open: its <name>.snap.tmp.<pid> (stale ones were removed under the --work lock). */
function saveInProgress(work, name) {
  try { return fs.readdirSync(work).some((f) => f.startsWith(`${name}.snap.tmp.`)); } catch { return false; }
}

/**
 * Run the runner and supervise it until its .snap is complete (R5a). spawn, not execFile: no
 * output buffer whose limit kills the runner (execFile's 64 MiB maxBuffer did). Since patches
 * 0020/0031 the runner never exits by itself. The runtime writes the region to
 * <name>.snap.tmp.<pid> and renames it into place after every message of probe.lean has been
 * printed (fork module.cpp:316-423, Frontend.lean:370-405), so the bake is done once `target` has
 * the same nonzero size at two polls `stableMs` apart: it prints `completed` and SIGKILLs the
 * runner. Two guards end a run that cannot finish: a failure line (FAILURE) with no .snap, no
 * <name>.snap.tmp.* (no save in progress) and `quietMs` without output (a header Lean rejects
 * never saves); and `giveUpMs`. The target was unlinked before, so a stale file never counts.
 * Resolves once, on 'close' (the process exited and both pipes closed): { code, signal, stopped,
 * failure } with `stopped` null (the runner exited by itself), "completed", "failure" or
 * "give-up" and `failure` the first failure line ({ kind, stream, line }) or null; or { error }
 * when it could not start.
 */
function supervise({ args, env, target, work, name, stableMs, quietMs, giveUpMs }) {
  return new Promise((resolve) => {
    let done = false;
    let watch = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearInterval(watch);
      state.child = null;
      resolve(result);
    };
    const child = spawn(process.execPath, ["--stack-size=8192", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    state.child = child;
    if (child.pid) {
      try {
        state.workLock?.addPid(child.pid);
      } catch (e) {
        console.error(`${TOOL}: WARNING — could not record the runner's pid ${child.pid} in ${state.workLock.path} (${e?.code ?? e?.message})`);
      }
    }
    child.on("error", (error) => finish({ error }));
    const started = Date.now();
    let lastActivity = started;
    let lastSize = -1;
    let stopped = null;
    let failure = null;
    // The runner's output goes to the bake's (if that reader is gone the runner is drained instead)
    // and is scanned line by line, per stream, for the first failure line.
    for (const [stream, from, to] of [["stdout", child.stdout, process.stdout], ["stderr", child.stderr, process.stderr]]) {
      from.pipe(to);
      to.once("error", () => { from.unpipe(to); from.resume(); });
      const decoder = new StringDecoder("utf8");
      let carry = "";
      let n = 0;
      const scan = (line) => {
        n += 1;
        if (!failure && FAILURE.test(line)) failure = { kind: failureKind(line), stream, line: n };
      };
      from.on("data", (chunk) => {
        lastActivity = Date.now();
        const lines = (carry + decoder.write(chunk)).split("\n");
        carry = lines.pop().slice(0, LINE_MAX);
        for (const line of lines) scan(line.slice(0, LINE_MAX));
      });
      from.on("end", () => {
        const rest = (carry + decoder.end()).slice(0, LINE_MAX);
        if (rest) scan(rest);
      });
    }
    const stop = (why) => {
      stopped = why;
      clearInterval(watch);
      child.kill("SIGKILL");
    };
    watch = setInterval(() => {
      if (stopped || state.signal) return;
      let size = -1;
      try { size = fs.statSync(target).size; } catch { /* not yet */ }
      if (size > 0 && size === lastSize) {
        console.log(`bake output complete (${size} bytes, unchanged across two polls ${stableMs} ms apart) — stopping the runner`);
        return stop("completed");
      }
      lastSize = size;
      if (failure && size < 0 && Date.now() - lastActivity > quietMs && !saveInProgress(work, name)) {
        console.error(`${TOOL}: the runner printed a failure line (${failure.kind}, ${failure.stream} line ${failure.line}) and, after ${quietMs} ms of quiet, wrote no ${name}.snap and began no save (--quiet-ms) — stopping it`);
        return stop("failure");
      }
      if (Date.now() - started > giveUpMs) {
        console.error(`${TOOL}: no complete ${name}.snap within ${giveUpMs} ms (--give-up-ms) — the runner is stopped, nothing compressed, the index is not written`);
        return stop("give-up");
      }
    }, stableMs);
    child.on("close", (code, signal) => finish({ code, signal, stopped, failure }));
  });
}

async function main() {
  const name = arg("name", "init");
  if (!SNAPSHOT_NAME.test(name)) {
    console.error(`bake-snapshot: refusing --name ${JSON.stringify(name)}: expected a letter or digit, then letters, digits, '.', '_' or '-' (it names <work>/<name>.snap, the .snapz and the index entry)`);
    return 2;
  }
  const probe = arg("probe", "#check (2 + 2 : Nat)");
  const rootsArg = arg("roots", null);
  const roots = rootsArg === null ? null : rootsArg.split(",").map((r) => r.trim()).filter(Boolean);
  if (roots !== null && (roots.length === 0 || !roots.every((r) => ROOT.test(r)))) {
    console.error(`bake-snapshot: refusing --roots ${JSON.stringify(rootsArg)}: expected comma-separated module roots (e.g. Mathlib,ProofWidgets)`);
    return 2;
  }
  const label = arg("label", null);
  const initialBytesArg = arg("initial-bytes", null);
  const initialBytes = initialBytesArg === null ? null : Number(initialBytesArg);
  if (initialBytes !== null && !(Number.isSafeInteger(initialBytes) && initialBytes > 0)) {
    console.error(`bake-snapshot: refusing --initial-bytes ${JSON.stringify(initialBytesArg)}: expected a positive whole number of bytes`);
    return 2;
  }
  const entryFieldsArg = arg("entry-fields", null);
  let fields = null;
  if (entryFieldsArg !== null) {
    const r = parseEntryFields(entryFieldsArg);
    if (r.refusal) {
      console.error(r.refusal);
      return 2;
    }
    fields = r.fields;
  }
  const timing = {};
  for (const [flag, fallback] of TIMING) {
    const text = arg(flag, null);
    const ms = text === null ? fallback : /^\d+$/.test(text) ? Number(text) : NaN;
    if (!(Number.isSafeInteger(ms) && ms > 0)) {
      console.error(`bake-snapshot: refusing --${flag} ${JSON.stringify(text)}: expected a positive whole number of milliseconds`);
      return 2;
    }
    timing[flag] = ms;
  }
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
    return 2;
  }
  const out = resolveToolPath({
    tool: "bake-snapshot", flag: "out", placeholder: "<dir>", value: arg("out", null), base: root,
    env: "QED64_STAGING", envTo: (staging) => path.join(staging, buildId, "snapshots"),
    legacy: stagingDir(root, buildId, "snapshots"), legacyLabel: "work/staging/<buildId>/snapshots under the repo root", usage: USAGE,
  }).path;
  refuseInsidePublic(root, out, "bake-snapshot");

  // The index this bake will upsert into is read and its pairing checked before the runner
  // starts (a refusal after a 20-minute bake is the expensive kind). A missing index is a new
  // one; an unreadable or corrupt one is refused, never replaced.
  const indexPath = path.join(out, "index.json");
  const read = readIndex(indexPath);
  const refusal = read.refusal ?? pairingRefusal(read.index, name, buildId, indexPath);
  if (refusal) {
    console.error(refusal);
    return 2;
  }

  // The runner: --runner, else QED64_RUNNER, else QED64's own node-runner (the
  // default, not deprecated). Checked before --work is created or the paired
  // .snap unlinked.
  const runner = toolPath({ value: arg("runner", null), env: "QED64_RUNNER", legacy: path.join(root, "pipeline/snapshot/node-runner.mjs") }).path;
  if (!fs.existsSync(runner)) {
    console.error(`bake-snapshot: no runner script ${runner} — pass --runner <script> or set QED64_RUNNER`);
    return 2;
  }
  // An explicit --lib that is not a directory refuses here, before the paired .snap is unlinked
  // (the runner failed on it after). It is passed to the runner as given; an absent one is the
  // runner's own <artifact>/lib/lean.
  const lib = arg("lib", null);
  if (lib && !isDir(path.resolve(lib))) {
    console.error(`bake-snapshot: no olean tree ${path.resolve(lib)} — pass --lib <olean tree> (the tree mounted at /lib/lean)`);
    return 2;
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
  // One bake per --work (takeWorkLock): the last exit-2 check, never taken over.
  const workLockPath = path.join(work, ".bake.lock");
  const taken = takeWorkLock(workLockPath, work);
  if (taken.refusal) {
    console.error(taken.refusal);
    return 2;
  }
  state.workLock = taken.lock;
  // Stale runtime temp files of this name (a save killed mid-write; the runtime writes
  // <file>.tmp.<getpid()> and renames it): never mistaken for a save in progress or for output.
  for (const f of fs.readdirSync(work)) {
    if (f.startsWith(`${name}.snap.tmp.`)) {
      fs.rmSync(path.join(work, f), { force: true });
      console.log(`removed the stale ${path.join(work, f)} (an interrupted save's temp file)`);
    }
  }
  fs.writeFileSync(path.join(work, "probe.lean"), `${probe}\n`);

  const runnerArgs = [
    runner,
    "--work", work,
  ];
  // Always the RESOLVED artifact: the `runtime` stamped below (from
  // artifactDir's lean.wasm) must name the binary that baked, whatever the
  // runner's own resolution would have picked.
  runnerArgs.push("--artifact", artifactDir);
  if (lib) runnerArgs.push("--lib", lib);
  runnerArgs.push("--", `--incr-header-save=/work/${name}.snap`, "/work/probe.lean");

  // Reserve the compactor's output buffer in one allocation: a whole-Mathlib
  // environment compacts to >2 GiB, and growth-by-doubling would need the old
  // and new buffers to coexist — more than the 16 GiB wasm64 space holds next
  // to the environment itself (toolchain patch 0011).
  const reserve = arg("reserve", String(3.5 * 1024 ** 3));
  // Legacy non-module packages (the lean4game games) need patch 0030's gate in
  // the runner; the flag is the documented form, the inherited variable its
  // equivalent (either reaches the runner as 1).
  const allowLegacyImports = process.argv.includes("--allow-legacy-imports") || !!process.env.QED64_ALLOW_LEGACY_IMPORTS;
  // The runner's environment is exactly these (the kernel copy's rule): a host LEAN_PATH reaches
  // the VFS through lean_main's prologue after preRun and would replace --lib; NODE_OPTIONS and
  // the rest never reach the runner.
  const runnerEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR"]) if (process.env[key] !== undefined) runnerEnv[key] = process.env[key];
  runnerEnv.LEAN_COMPACTOR_RESERVE = reserve;
  if (allowLegacyImports) runnerEnv.QED64_ALLOW_LEGACY_IMPORTS = "1";
  if (process.env.QED64_PROFILE_INIT) runnerEnv.QED64_PROFILE_INIT = process.env.QED64_PROFILE_INIT;
  console.log(`baking ${name}.snap for runtime ${buildId} (probe: ${JSON.stringify(probe)}; compactor reserve ${(Number(reserve) / 1024 ** 3).toFixed(1)} GiB) → ${out}`);
  // The .snapz digest depends on the zlib build (gzip output is not reproducible across builds):
  // record a digest together with this line (docs/SNAPSHOT-INDEX.md, identity and transport).
  console.log(`build environment: node ${process.version}, zlib ${process.versions.zlib}, shared zlib ${process.config?.variables?.node_shared_zlib ?? "unknown"}`);
  // The bake must start CLEAN: a stale target satisfies the stability check
  // before the new save even begins (it cost two silently-skipped bakes).
  const snap = path.join(work, `${name}.snap`);
  try { fs.rmSync(snap); } catch { /* absent */ }
  const run = await supervise({
    args: runnerArgs, env: runnerEnv, target: snap, work, name,
    stableMs: timing["stable-ms"], quietMs: timing["quiet-ms"], giveUpMs: timing["give-up-ms"],
  });
  // Judged only now: the runner has exited and both its pipes have closed.
  if (state.signal) return SIGNAL_EXIT[state.signal];
  if (run.error) {
    console.error(`${TOOL}: cannot start the runner (${run.error.code ?? run.error.message})`);
    return 1;
  }
  const { code, signal, stopped } = run;
  if (stopped === "failure") {
    console.error("FAIL: snapshot file was not produced"); // after the failed-quiet line
    return 1;
  }
  if (stopped === "give-up") return 1; // after the gave-up line
  if (stopped === null && code === null) {
    // A terminal's Ctrl-C reaches the runner and the bake together: the bake's own handler may still be queued.
    await new Promise((resolve) => setImmediate(resolve));
    if (state.signal) return SIGNAL_EXIT[state.signal];
    console.error(`${TOOL}: the runner was killed by ${signal}, a signal this bake did not send — nothing compressed, the index is not written`);
    return 1;
  }
  if (stopped === null && code !== 0) {
    console.error(`${TOOL}: runner exited ${code}`);
    return 1;
  }
  // Completed, or the runner exited 0 by itself.
  if (!fs.existsSync(snap)) {
    console.error("FAIL: snapshot file was not produced");
    return 1;
  }
  const snapBytes = fs.statSync(snap).size;
  // D6, the notice (decided 2026-11-01): a failure line in the run (every probe.lean message is
  // printed before the save) is decided here, before anything is compressed or indexed. For one
  // downstream re-pin the bake still indexes and exits 0, with one WARNING and one machine-readable
  // verdict line; then such a bake exits 1 without indexing, and the verdict line tells a Lean
  // failure from a runner crash (docs/CLI-CONTRACT.md, bake-snapshot, "Lean failure lines").
  if (run.failure) {
    const { kind, stream, line } = run.failure;
    console.error(`${TOOL}: WARNING — the runner printed a failure line (${kind}, ${stream} line ${line}); for one downstream re-pin this bake still indexes ${name}.snap and exits 0, then it exits 1 without indexing (docs/CLI-CONTRACT.md, bake-snapshot, Lean failure lines)`);
    console.error(`${TOOL}: verdict ${JSON.stringify({ verdict: "failed", kind, stream, line, name, bytes: snapBytes })}`);
  }
  fs.mkdirSync(out, { recursive: true });
  try { fs.rmSync(`${snap}.deps`); } catch {}

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
  // caching correct. The temp is per process, so two bakes of one name never share it.
  const tmpPath = path.join(out, `${name}.snapz.${process.pid}.tmp`);
  state.snapzTmp = tmpPath;
  const hasher = createHash("sha256");
  try {
    await pipeline(
      fs.createReadStream(snap),
      createGzip({ level: 6 }),
      async function* (chunks) { for await (const c of chunks) { hasher.update(c); yield c; } },
      fs.createWriteStream(tmpPath),
    );
  } catch (e) {
    fs.rmSync(tmpPath, { force: true });
    state.snapzTmp = null;
    if (state.signal) return SIGNAL_EXIT[state.signal];
    console.error(`${TOOL}: compressing ${snap} failed (${e?.code ?? e?.message})`);
    return 1;
  }
  const digest = hasher.digest("hex");
  const gzName = `${name}.${digest.slice(0, 16)}.snapz`;
  const gzPath = path.join(out, gzName);
  fs.renameSync(tmpPath, gzPath);
  state.snapzTmp = null;
  // Older bakes of the same logical name are LEFT IN PLACE: content-addressed
  // files never collide, and a producer that unlinks is how the served tree was
  // lost (review C6: additive only; garbage-collect deliberately, later).
  const transferBytes = fs.statSync(gzPath).size;

  // Upsert the snapshot index the app consumes: each entry records the ORDERED
  // header imports its environment was baked for (the runtime keys its env
  // cache by exactly that list; empty = the default no-import header) and the
  // `runtime` it is binary-paired with.
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
    ...(fields ?? {}), // --entry-fields, in the object's order (docs/SNAPSHOT-INDEX.md)
  };
  state.unindexed = entry; // printed by the 'exit' handler on any exit before the index has it
  // THE PER-BUILD COPY (HARDENING #64). Beside index.json the bake writes
  // index.<buildId>.json, the same bytes, named by the runtime this index is
  // paired with (the refusals above keep one --out to one pairing): the copy a
  // page pinned to that runtime reads when the mutable index.json beside it
  // names another runtime (loadSnapshotIndex's `pairedBuildId`,
  // lib/snapshots.ts). Another runtime's copy in --out is never touched.
  // QED64's own path does not need it: promote-staging derives public/'s copy
  // from the staged index.json and ignores this one, and upload-artifacts.sh
  // sends no copy at all (since D2 QED64's indexes ship in its deploy). It suits only
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
  // holder's pid. A lock is never taken over: without link(2) no takeover is
  // race-free (two waiters that judge one dead lock can both remove it, the
  // second removing the lock the first has just created), a pid means
  // nothing on an --out shared between hosts, and another tool's lock may
  // not be in this format. A bake waits for the lock at most LOCK_WAIT_MS,
  // then fails (exit 1): one line names the lock, its holder and whether
  // that pid runs on this host, and the 'exit' handler prints the entry it could
  // not index; its .snapz is in place and neither index is touched, so once no
  // bake writes this --out, removing the lock and rerunning finishes the upsert.
  // With the lock, the index is re-read under readIndex's rules and its pairing
  // re-checked (a refusal is exit 1, nothing written): a concurrent bake of a
  // sibling name re-reads, merges and writes after this one, never
  // interleaved with it, so its entry is not lost and the two files are never
  // written by different bakes; a sibling bake of another runtime that upserted
  // meanwhile is refused, never mixed in. Both files go through temp file + rename
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
  const lockWaitStart = Date.now();
  let lockVanished = 0;
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - lockWaitStart > LOCK_WAIT_MS) {
        // Read without following a link (lockHolder). A lock released between the open and the
        // read (ENOENT) sends the bake back to open(), at most 100 times.
        const held = lockHolder(lockPath);
        if (held.gone && ++lockVanished <= 100) continue; // released meanwhile
        const holder = held.text === undefined ? null : /^(\d+)\n$/.exec(held.text);
        const who = holder
          ? pidLabel(holder[1])
          : `a holder it cannot read (${held.unreadable ?? (held.gone ? "unreadable: ENOENT" : JSON.stringify(held.text.slice(0, 200)))})`;
        console.error(`bake-snapshot: index lock ${lockPath} is held by ${who} for over ${LOCK_WAIT_MS} ms; a lock is never taken over: once no bake writes ${out}, remove it and rerun (the .snapz is in place, the index is not updated)`);
        return 1; // the 'exit' handler prints the entry
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
    // Re-read under the same rules and re-check the pairing: a concurrent bake may have upserted meanwhile.
    const reread = readIndex(indexPath);
    const refusal = reread.refusal ?? pairingRefusal(reread.index, name, buildId, indexPath);
    if (refusal) {
      console.error(refusal);
      return 1; // nothing written; the lock is released below and the 'exit' handler prints the entry
    }
    const index = reread.index;
    index.snapshots = index.snapshots.filter((s) => s.name !== name).concat([entry]);
    const indexText = JSON.stringify(index, null, 2);
    const writes = [copyPath, indexPath].map((to) => ({ to, tmp: `${to}.${process.pid}.tmp` }));
    try {
      for (const { tmp } of writes) fs.writeFileSync(tmp, indexText);
      for (const { to, tmp } of writes) fs.renameSync(tmp, to);
    } catch (e) {
      console.error(`${TOOL}: writing the index failed (${e?.code ?? e?.message}): the .snapz is in place, index.json is not updated (its copy may be)`);
      return 1;
    } finally {
      for (const { tmp } of writes) fs.rmSync(tmp, { force: true });
    }
    state.indexed = true;
    state.unindexed = null;
  } finally {
    // Released only while it is still this bake's.
    try { if (fs.readFileSync(lockPath, "utf8") === `${process.pid}\n`) fs.rmSync(lockPath, { force: true }); } catch { /* gone */ }
  }
  console.log(
    `baked ${gzPath} (${transferBytes} bytes transfer, ${snapBytes} raw); ` +
      `index updated (imports: [${entry.imports.join(", ")}], runtime ${buildId})`,
  );
  console.log(`index copy ${copyPath} written (runtime ${buildId})`);
  return 0;
}

let code;
try { code = await main(); } catch (e) { if (!state.signal) console.error(`${TOOL}: the bake crashed: ${e?.stack ?? e}`); code = 1; }
// exitCode, not process.exit: the stdout lines (`baked`) flush to a pipe.
process.exitCode = state.signal && !state.indexed ? SIGNAL_EXIT[state.signal] : code;
