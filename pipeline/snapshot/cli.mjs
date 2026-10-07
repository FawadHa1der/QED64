#!/usr/bin/env node
// The pipeline CLI contract as data (docs/CLI-CONTRACT.md): one SPEC per
// command-line tool (script, npm alias, tier, synopsis, flags with defaults /
// required / doc, environment variables, exit codes, and the stable output
// markers downstream parses, as regexes), the ONE implementation of the
// argument grammar (cliContract), and the help text every tool prints.
//
// It lives in pipeline/snapshot/ because a downstream project vendors that
// directory whole. It is side-effect-free on import: nothing below the
// main-module check at the end runs unless this file is the entry point.
//
// Two ways a script binds to it (SPEC.binding):
//   "import" — the script imports parseCli from this module (supervised-run,
//              preflight, fetch-artifacts: they ship in the package beside this file);
//   "inline" — the script carries a generated prelude (renderPrelude) between
//              `// <cli-contract>` and `// </cli-contract>`: the same
//              cliContract source, the compact spec and the help text, so it
//              stays self-contained. lean4game's scripts/sync-qed64.sh copies
//              these files ONE BY ONE and refuses a relative import it did
//              not copy, so they must not import this module.
//
// CLI:
//   node pipeline/snapshot/cli.mjs --print-specs        the contract as JSON
//   node pipeline/snapshot/cli.mjs --help [<tool>]      a tool's help text
//   node pipeline/snapshot/cli.mjs --check-preludes     exit 1 when an inline prelude drifted from SPECS
//   node pipeline/snapshot/cli.mjs --write-preludes     regenerate every inline prelude in place

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Bumped on a breaking change to the contract (docs/CLI-CONTRACT.md "Stability"). */
export const CONTRACT_VERSION = 3;

/** Substrings new output (any line a pipeline run can print, help and
 * warnings included) must not contain: downstream log judges match them
 * anywhere in a log (supervised-run's own classifier, the showcase's
 * judge-bake.mjs and run-e2.sh). Matched case-sensitively; "line-initial"
 * entries only at the start of a line. */
export const RESERVED_OUTPUT = [
  { text: ": error", where: "anywhere" },
  { text: "error:", where: "line-initial" },
  { text: ": warning:", where: "anywhere" },
  { text: "warning:", where: "line-initial" },
  { text: "PANIC", where: "anywhere" },
  { text: "ABORT:", where: "anywhere" },
  { text: "uncaught", where: "anywhere" },
  { text: "RuntimeError", where: "anywhere" },
  { text: "object compactor:", where: "anywhere" },
];

/** First reserved substring a block of output contains, or null. */
export function reservedHit(text) {
  for (const line of String(text).split("\n")) {
    for (const r of RESERVED_OUTPUT) {
      if (r.where === "line-initial" ? line.startsWith(r.text) : line.includes(r.text)) return { line, reserved: r.text };
    }
  }
  return null;
}

/** Exit-code classes shared by every tool. */
export const EXIT_CLASSES = {
  0: "success: the job did what it was asked",
  1: "the job ran and failed (a verification, a probe, a Lean failure line), or crashed",
  2: "refused before any work: usage (a missing required flag) or a precondition (input absent, --out inside public/, an unpaired index)",
  3: "infrastructure refusal (preflight: the environment cannot run the lane); LEGACY OVERLOAD in node-runner, snapshot-probe and persistent-probe: the wasm runtime aborted (onAbort)",
};

/** Environment variables the Tier 1/2 tools read. */
export const ENV = {
  QED64_LEAN_ARTIFACT: {
    doc: "stage1 artifact dir (bin/lean.js, bin/lean.wasm, lib/lean) used when --artifact is absent (empty = unset)",
    readBy: ["bake-snapshot", "node-runner", "snapshot-probe", "persistent-probe"],
  },
  QED64_WORK: {
    doc: "the dir mounted at /work (bake-snapshot: where <name>.snap lands) used when --work is absent",
    readBy: ["bake-snapshot", "node-runner"],
  },
  QED64_STAGING: {
    doc: "the staging root used when --out is absent: --out is <QED64_STAGING>/<buildId>/{snapshots,runtime}",
    readBy: ["bake-snapshot", "chunk-runtime"],
  },
  QED64_LIB_TREE: {
    doc: "the olean tree mounted at /lib/lean (the tree the probed snapshot was baked from) used when --lib is absent",
    readBy: ["snapshot-probe"],
  },
  LEAN_COMPACTOR_RESERVE: {
    doc: "bytes the compactor reserves up front for a whole-environment save (toolchain patch 0011)",
    readBy: ["node-runner"],
    setBy: ["bake-snapshot"],
  },
  QED64_ALLOW_LEGACY_IMPORTS: {
    doc: "when set (non-empty), lets the exported-level env cache load legacy non-module packages (patch 0030; the lean4game bakes); bake-snapshot --allow-legacy-imports sets it to 1 for its runner",
    readBy: ["node-runner"],
    setBy: ["bake-snapshot"],
  },
  QED64_PROFILE_INIT: {
    doc: "when set, forwarded into the wasm environment to profile the [init] replay",
    readBy: ["node-runner", "snapshot-probe"],
  },
  QED64_RUNNER: {
    doc: "the runner script bake-snapshot spawns when --runner is absent (default: QED64's own pipeline/snapshot/node-runner.mjs)",
    readBy: ["bake-snapshot"],
  },
  LEAN4_WASM64_DIR: {
    doc: "the lean4-wasm64 package dir the forwards run (unpack, chunk-runtime, and the tier-3 inspect and gate); unset: the first node_modules/lean4-wasm64 above the cwd",
    readBy: ["unpack", "chunk-runtime"],
  },
};

/** "flag, else variable, else the deprecated repo-relative default" (docs/CLI-CONTRACT.md "Path resolution"). */
const viaEnv = (env, legacy) => `$${env}, else (deprecated, one WARNING) ${legacy}`;
const ARTIFACT_DEFAULT = viaEnv("QED64_LEAN_ARTIFACT", "pipeline/toolchain/work/build/stage1 under the repo root when it has bin/lean.js; nothing else: exit 2");

/** The two stderr lines of the one path-resolution rule (resolveToolPath in
 * pipeline/toolchain/artifact-paths.mjs), as markers of each tool that uses it. */
function pathMarkers(tool, { flag, placeholder, env, legacyLabel, legacy, needs }) {
  return [
    { id: "deprecated-default", stream: "stderr", source: "pipeline/toolchain/artifact-paths.mjs",
      template: ["${o.tool}: WARNING — the default --${o.flag} ${o.legacyLabel} (${r.path}) is deprecated; use --${o.flag} ${o.placeholder} or set ${o.env} (docs/CLI-CONTRACT.md)"],
      regex: /^(\S+): WARNING — the default --(\S+) (.+) \((.+)\) is deprecated; use --\S+ \S+ or set (\w+) \(docs\/CLI-CONTRACT\.md\)$/,
      example: `${tool}: WARNING — the default --${flag} ${legacyLabel} (${legacy}) is deprecated; use --${flag} ${placeholder} or set ${env} (docs/CLI-CONTRACT.md)` },
    { id: "no-path", stream: "stderr", source: "pipeline/toolchain/artifact-paths.mjs", prefix: true,
      template: ["${o.tool}: no --${o.flag} given and ${o.env} is unset"],
      regex: /^(\S+): no --(\S+) given and (\w+) is unset(; the deprecated default (.+) (has no \S+|is absent))? — pass --\S+ \S+ or set \w+$/,
      example: `${tool}: no --${flag} given and ${env} is unset; the deprecated default ${legacy} ${needs ? `has no ${needs}` : "is absent"} — pass --${flag} ${placeholder} or set ${env}` },
  ];
}
const ARTIFACT_PATH = { flag: "artifact", placeholder: "<dir>", env: "QED64_LEAN_ARTIFACT", legacyLabel: "pipeline/toolchain/work/build/stage1 under the repo root", legacy: "/repo/pipeline/toolchain/work/build/stage1", needs: "bin/lean.js" };

/**
 * The contract, one entry per tool. Flags: `value` present = takes a value
 * (`--flag <value>` or `--flag=<value>`), absent = boolean. `required` is a
 * list of groups; each group needs one of its flags. Markers: `stream`,
 * `template` (the format string(s) exactly as they appear in `source`,
 * default the tool's script), `prefix` (the line STARTS with the template:
 * console arguments or optional text follow), `regex` (what consumers may
 * match, applied per line), `example` (a line the script can print) and
 * optional `examples` (more such lines, e.g. an optional suffix).
 */
export const SPECS = {
  "bake-snapshot": {
    script: "pipeline/snapshot/bake-snapshot.mjs",
    npm: "bake:snapshot",
    tier: 1,
    binding: "inline",
    node: "node",
    synopsis: "bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--allow-legacy-imports] [--runner <script>]",
    summary: "Bake an environment snapshot with the exact wasm64 runtime under Node (the runner is supervised and reaped), gzip it content-addressed into the staging dir and upsert its index entry.",
    flags: [
      { name: "name", value: "<name>", default: "init", doc: "snapshot name: <work>/<name>.snap, <name>.<digest16>.snapz and the index entry" },
      { name: "probe", value: "<lean source>", default: "#check (2 + 2 : Nat)", doc: "the baked file; its import lines become the entry's imports (the env-cache key)" },
      { name: "artifact", value: "<dir>", default: ARTIFACT_DEFAULT.replace("bin/lean.js", "bin/lean.wasm"), doc: "stage1 dir whose bin/lean.wasm bakes and is stamped as `runtime`; always passed to the runner" },
      { name: "lib", value: "<olean tree>", default: "the runner's <artifact>/lib/lean", doc: "olean tree mounted at /lib/lean" },
      { name: "reserve", value: "<bytes>", default: "3758096384 (3.5 GiB)", doc: "compactor buffer reserved up front (LEAN_COMPACTOR_RESERVE for the runner)" },
      { name: "work", value: "<dir>", default: viaEnv("QED64_WORK", "work/snapshot under the repo root: the PAIRED set the probes load"), doc: "raw .snap + probe.lean; <work>/<name>.snap is deleted when the bake starts; a relative --work resolves against the repo root" },
      { name: "out", value: "<dir>", default: viaEnv("QED64_STAGING", "work/staging/<buildId>/snapshots under the repo root") + "; with QED64_STAGING, <QED64_STAGING>/<buildId>/snapshots", doc: "staged .snapz + index.json; refused inside public/; a relative --out resolves against the repo root" },
      { name: "roots", value: "<A,B,…>", default: "none (the legacy rule: an entry named mathlib serves the umbrella roots)", doc: "module roots the entry serves (docs/EMBEDDING.md §8): the page boots and widens to it for a header naming one" },
      { name: "label", value: "<text>", default: "none", doc: "the entry's human name for the page's pill and boot card" },
      { name: "initial-bytes", value: "<bytes>", default: "none (2 GiB with a non-base entry)", doc: "initial Memory64 commit when the entry is loaded" },
      { name: "allow-legacy-imports", doc: "let the runner's env cache load legacy non-module packages (patch 0030): sets QED64_ALLOW_LEGACY_IMPORTS=1 for the runner; an inherited QED64_ALLOW_LEGACY_IMPORTS does the same" },
      { name: "runner", value: "<script>", default: "$QED64_RUNNER, else QED64's own pipeline/snapshot/node-runner.mjs (not deprecated)", doc: "the runner script, spawned as <this node> --stack-size=8192 <script> --work <dir> --artifact <dir> [--lib <tree>] -- …; a relative path resolves against the cwd" },
    ],
    env: ["QED64_LEAN_ARTIFACT", "QED64_WORK", "QED64_STAGING", "QED64_RUNNER", "LEAN_COMPACTOR_RESERVE", "QED64_ALLOW_LEGACY_IMPORTS", "QED64_PROFILE_INIT"],
    exits: {
      0: "baked and the index upserted (also when the wedged runner was reaped); NOT a verdict on the probe's Lean messages",
      1: "the runner exited non-zero, or no .snap was produced",
      2: "refused before the runner: no --artifact, QED64_LEAN_ARTIFACT or deprecated default; no lean.wasm under the artifact, --out inside public/, an index paired with another runtime or with none, a malformed --roots or --initial-bytes, a --runner (or QED64_RUNNER) script that does not exist",
    },
    markers: [
      { id: "baking", stream: "stdout", template: ["baking ${name}.snap for runtime ${buildId} (probe: ${JSON.stringify(probe)}; compactor reserve ${(Number(reserve) / 1024 ** 3).toFixed(1)} GiB) → ${out}"],
        regex: /^baking (\S+)\.snap for runtime (\S+) \(probe: (.*); compactor reserve (\d+\.\d) GiB\) → (.+)$/,
        example: 'baking init.snap for runtime wasm64-0123456789abcdef (probe: "#check (2 + 2 : Nat)"; compactor reserve 3.5 GiB) → /repo/work/staging/wasm64-0123456789abcdef/snapshots' },
      { id: "reaped", stream: "stdout", template: ["bake output stable (${size} bytes) with runner quiet — reaping the wedged exit"],
        regex: /^bake output stable \((\d+) bytes\) with runner quiet — reaping the wedged exit$/,
        example: "bake output stable (342000000 bytes) with runner quiet — reaping the wedged exit" },
      { id: "compressing", stream: "stdout", template: ["compressing ${name}.snapz …"],
        regex: /^compressing (\S+)\.snapz …$/, example: "compressing init.snapz …" },
      { id: "baked", stream: "stdout",
        template: ["baked ${gzPath} (${transferBytes} bytes transfer, ${snapBytes} raw); ", "index updated (imports: [${entry.imports.join(\", \")}], runtime ${buildId})"],
        regex: /^baked (\S+\/([^/\s]+)\.([0-9a-f]{16})\.snapz) \((\d+) bytes transfer, (\d+) raw\); index updated \(imports: \[([^\]]*)\], runtime (\S+)\)$/,
        example: "baked /repo/work/staging/wasm64-0123456789abcdef/snapshots/init.0123456789abcdef.snapz (107000000 bytes transfer, 342000000 raw); index updated (imports: [], runtime wasm64-0123456789abcdef)" },
      { id: "no-snap", stream: "stderr", template: ["FAIL: snapshot file was not produced"],
        regex: /^FAIL: snapshot file was not produced$/, example: "FAIL: snapshot file was not produced" },
      { id: "no-runner", stream: "stderr", template: ["bake-snapshot: no runner script ${runner} — pass --runner <script> or set QED64_RUNNER"],
        regex: /^bake-snapshot: no runner script (.+) — pass --runner <script> or set QED64_RUNNER$/,
        example: "bake-snapshot: no runner script /tmp/missing/node-runner.mjs — pass --runner <script> or set QED64_RUNNER" },
      { id: "no-artifact", stream: "stderr", template: ["bake-snapshot: no lean.wasm under ${artifactDir} — pass --artifact <stage1 dir>"],
        regex: /^bake-snapshot: no lean\.wasm under (.+) — pass --artifact <stage1 dir>$/,
        example: "bake-snapshot: no lean.wasm under /tmp/missing — pass --artifact <stage1 dir>" },
      { id: "refuse-public", stream: "stderr", source: "pipeline/toolchain/artifact-paths.mjs", prefix: true,
        template: ["${who}: refusing --out ${target}: it resolves inside public/. "],
        regex: /^(bake-snapshot|chunk-runtime): refusing --out (.+): it resolves inside public\/\. /,
        example: "bake-snapshot: refusing --out /repo/public/snapshots: it resolves inside public/. Producers stage under work/staging/<buildId>/; use `npm run promote:staging` to publish (HARDENING #32)." },
      { id: "refuse-foreign", stream: "stderr",
        template: ["bake-snapshot: ${indexPath} already holds entries for runtime ${foreign[0].runtime} (${foreign.map((s) => s.name).join(\", \")}) — refusing to mix pairings"],
        regex: /^bake-snapshot: (.+) already holds entries for runtime (\S+) \((.*)\) — refusing to mix pairings$/,
        example: "bake-snapshot: /repo/out/index.json already holds entries for runtime wasm64-0000000000000000 (mathlib) — refusing to mix pairings" },
      { id: "refuse-unpaired", stream: "stderr", prefix: true,
        template: ["bake-snapshot: ${indexPath} holds entries with no runtime pairing (${unpaired.map((s) => s.name).join(\", \")}) — rebake "],
        regex: /^bake-snapshot: (.+) holds entries with no runtime pairing \((.*)\) — rebake /,
        example: "bake-snapshot: /repo/out/index.json holds entries with no runtime pairing (mathlib) — rebake --name mathlib against this runtime first, or bake into an empty --out (promote refuses an unpaired index)" },
      ...pathMarkers("bake-snapshot", { ...ARTIFACT_PATH, needs: "bin/lean.wasm" }),
    ],
  },

  "node-runner": {
    script: "pipeline/snapshot/node-runner.mjs",
    npm: "runner",
    tier: 2,
    binding: "inline",
    node: "node --stack-size=8192",
    synopsis: "node-runner.mjs [--artifact <dir>] [--work <dir>] [--lib <dir>] [--] <lean args...>",
    summary: "Run the wasm64 Lean CLI under Node with the host filesystem mounted (NODEFS): --work at /work (the cwd), the library tree at /lib/lean. Since patches 0020/0031 the CLI does its work and then never exits: callers judge it by output (supervised-run) or reap it.",
    flags: [
      { name: "artifact", value: "<dir>", default: ARTIFACT_DEFAULT, doc: "stage1 dir holding bin/lean.js, bin/lean.wasm and lib/lean" },
      { name: "work", value: "<dir>", default: viaEnv("QED64_WORK", "work/runner under the repo root"), doc: "host dir mounted read-write at /work, Lean's cwd; created when absent" },
      { name: "lib", value: "<dir>", default: "<artifact>/lib/lean", doc: "olean tree mounted at /lib/lean, e.g. an unpacked profile pack for bakes" },
    ],
    passthrough: { mode: "implicit", required: false, doc: "Lean's own arguments: everything after --, or from the first token that is not a runner flag (`-- --help` asks Lean, whose process then never exits)" },
    env: ["QED64_LEAN_ARTIFACT", "QED64_WORK", "LEAN_COMPACTOR_RESERVE", "QED64_ALLOW_LEGACY_IMPORTS", "QED64_PROFILE_INIT"],
    exits: {
      0: "Lean exited 0 (rare since patch 0031: the process normally stays alive after main returns)",
      1: "Lean's own non-zero exit code, passed through when the process does exit",
      2: "lean.js or the library tree not found, or no --artifact, QED64_LEAN_ARTIFACT or deprecated default",
      3: "the wasm runtime aborted (legacy overload of class 3)",
    },
    markers: [
      { id: "abort", stream: "stderr", template: ["ABORT:"], prefix: true, regex: /^ABORT: (.*)$/, example: "ABORT: RuntimeError: unreachable" },
      { id: "no-lean-js", stream: "stderr", template: ["error: ${leanJs} not found — pass --artifact or set QED64_LEAN_ARTIFACT"],
        regex: /^error: (.+) not found — pass --artifact or set QED64_LEAN_ARTIFACT$/,
        example: "error: /tmp/missing/bin/lean.js not found — pass --artifact or set QED64_LEAN_ARTIFACT" },
      { id: "no-lib", stream: "stderr", template: ["error: ${libLean} not found"], regex: /^error: (.+) not found$/, example: "error: /tmp/stage1/lib/lean not found" },
      ...pathMarkers("node-runner", ARTIFACT_PATH),
    ],
  },

  "supervised-run": {
    script: "pipeline/snapshot/supervised-run.mjs",
    npm: null,
    tier: 1,
    binding: "import",
    node: "node",
    synopsis: "supervised-run.mjs --target <file> [--quiet-ms n] [--stable-ms n] [--give-up-ms n] -- <node-runner arguments…>",
    summary: "Run node-runner for a job that writes ONE output file and judge it by that output: done when the target is stable and the runner quiet (the kept-alive CLI is reaped), failed on a failure line in the runner's output, a bad exit, or the give-up deadline.",
    flags: [
      { name: "target", value: "<file>", doc: "the one file the job writes; deleted before the runner starts" },
      { name: "quiet-ms", value: "<ms>", default: "30000", doc: "the runner must have printed nothing for this long" },
      { name: "stable-ms", value: "<ms>", default: "30000", doc: "the target's size must not have changed for this long" },
      { name: "give-up-ms", value: "<ms>", default: "7200000", doc: "fail when nothing finished by then" },
      { name: "runner", value: "<script>", default: "pipeline/snapshot/node-runner.mjs", doc: "the runner script (the unit tests substitute a fake)" },
    ],
    required: [["target"]],
    passthrough: { mode: "separator", required: true, doc: "node-runner's arguments, verbatim (its own `--` and Lean's arguments included)" },
    env: [],
    exits: {
      0: "the target is finished (stable with the runner quiet, or the runner exited 0 with it written)",
      1: "the runner printed a failure line, exited non-zero, exited 0 without the target, could not start, or the give-up deadline passed",
      2: "usage: --target or the runner arguments missing",
    },
    classifier: { template: "const FAILURE = /(^|\\n)[^\\n]*(: error[:( ]|^error:|uncaught exception|PANIC|ABORT:|RuntimeError:)/m;",
      doc: "a runner output line matching this regex fails the job, even if the target appears" },
    markers: [
      { id: "verdict", stream: "stdout", template: ["supervised-run: ${why} (${((Date.now() - started) / 1000).toFixed(0)} s)"],
        regex: /^supervised-run: (.*) \((\d+) s\)$/,
        example: "supervised-run: Essential.olean stable at 319072 bytes with the runner quiet — reaping the kept-alive CLI (95 s)" },
      { id: "done-reaped", stream: "stdout", template: ["${path.basename(target)} stable at ${size} bytes with the runner quiet — reaping the kept-alive CLI"],
        regex: /(\S+) stable at (\d+) bytes with the runner quiet — reaping the kept-alive CLI/,
        example: "Essential.olean stable at 319072 bytes with the runner quiet — reaping the kept-alive CLI" },
      { id: "done-exited", stream: "stdout", template: ["the runner exited 0 with ${path.basename(target)} at ${size} bytes"],
        regex: /the runner exited 0 with (\S+) at (\d+) bytes/, example: "the runner exited 0 with Essential.olean at 319072 bytes" },
      { id: "failed", stream: "stdout", template: ["FAILED — the runner reported: ${failure}"], regex: /FAILED — (.*)/,
        example: "FAILED — the runner reported: /work/Essential.lean:7:0: error: unknown module prefix 'Mathlib.Gone'" },
    ],
  },

  "snapshot-probe": {
    script: "pipeline/snapshot/snapshot-probe.mjs",
    npm: null,
    tier: 1,
    binding: "inline",
    node: "node --stack-size=8192",
    synopsis: "snapshot-probe.mjs (--snap <file> | --fresh-import --lib <tree>) (--probe-file <file> | --probe <source>)",
    summary: "Load a baked snapshot through the worker's exact export (lean_wasm_load_snapshot, or _mem with --via-mem), then compile a probe whose header matches it: it must be error-free and within the budget (an env-cache hit).",
    flags: [
      { name: "snap", value: "<file>", doc: "raw .snap to load (hard-linked into a scratch dir under the OS tmpdir)" },
      { name: "fresh-import", doc: "no snapshot: import the probe's header from --lib (the slim-bake differential audit)" },
      { name: "probe-file", value: "<file>", doc: "the Lean file to compile after the load" },
      { name: "probe", value: "<source>", doc: "the probe text inline (read only when --probe-file is absent)" },
      { name: "lib", value: "<tree>", default: viaEnv("QED64_LIB_TREE", "work/lib-tree under the repo root when it exists; nothing else: exit 2"), doc: "olean tree mounted at /lib/lean" },
      { name: "artifact", value: "<dir>", default: ARTIFACT_DEFAULT, doc: "stage1 dir holding bin/lean.js + bin/lean.wasm" },
      { name: "budget-ms", value: "<ms>", default: "90000", doc: "compile budget; slower means the load seeded the wrong env-cache key" },
      { name: "via-mem", doc: "stream the snapshot into a wasm-malloc'd buffer (lean_wasm_load_snapshot_mem, the browser's path)" },
      { name: "via-memfs", doc: "copy the snapshot into MEMFS in 64 MiB chunks before loading" },
      { name: "init-flags", value: "<n>", default: "1", doc: "replay-control flags passed with --via-mem (patch 0016)" },
      { name: "workspace", value: "<dir>", doc: "host dir mounted at /workspace, the compile's cwd (game probes need .lake/gamedata)" },
      { name: "dump-messages", doc: "echo every line Lean prints on stdout as `[lean:stdout] <line>`" },
      { name: "watchdog-ms", value: "<ms>", default: "--budget-ms + 120000", doc: "wall-clock limit of the run, kept by a worker thread: past it one watchdog FAIL line and the probe SIGKILLs itself (a hung lean_wasm_compile, kernel 0037 on); 0 for no watchdog" },
    ],
    required: [["snap", "fresh-import"], ["probe-file", "probe"]],
    env: ["QED64_LEAN_ARTIFACT", "QED64_LIB_TREE", "QED64_PROFILE_INIT"],
    exits: {
      0: "SNAPSHOT PROBE PASS",
      1: "SNAPSHOT PROBE FAIL (load failed, the probe has errors or blew the budget), or a crash before the runtime started (an unreadable --probe-file, a missing lean.js)",
      2: "usage: no snapshot source or no probe; a --watchdog-ms that is not a whole number; or no --artifact / --lib, its variable unset and no deprecated default",
      3: "the wasm runtime aborted (legacy overload of class 3)",
    },
    markers: [
      { id: "load-header", stream: "stdout", template: ["== load snapshot: ${path.basename(snapHost)} (${fs.statSync(snapHost).size} bytes) =="],
        regex: /^== load snapshot: (\S+) \((\d+) bytes\) ==$/, example: "== load snapshot: mathlib.snap (2760000000 bytes) ==" },
      { id: "load", stream: "stdout", template: ["load: tag=${ltag} scalar=${lscalar} elapsed=${loadMs.toFixed(0)}ms"],
        regex: /^load: tag=(\d+) scalar=(\S+) elapsed=(\d+)ms$/, example: "load: tag=0 scalar=0 elapsed=5123ms" },
      { id: "compile", stream: "stdout", template: ["compile: tag=${ioTag(cr)} elapsed=${compileMs.toFixed(0)}ms errors=${errors.length}"],
        regex: /^compile: tag=(\d+) elapsed=(\d+)ms errors=(\d+)$/, example: "compile: tag=0 elapsed=71ms errors=0" },
      { id: "pass", stream: "stdout", template: ["SNAPSHOT PROBE PASS"], regex: /^SNAPSHOT PROBE PASS$/, example: "SNAPSHOT PROBE PASS" },
      { id: "fail", stream: "stderr", template: ["SNAPSHOT PROBE FAIL:"], prefix: true, regex: /^SNAPSHOT PROBE FAIL: (.*)$/, example: "SNAPSHOT PROBE FAIL: probe compile failed" },
      { id: "watchdog", stream: "stderr", template: ["SNAPSHOT PROBE FAIL: watchdog: no verdict within ${watchdogMs} ms (lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on)"],
        regex: /^SNAPSHOT PROBE FAIL: watchdog: no verdict within (\d+) ms \(lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on\)$/,
        example: "SNAPSHOT PROBE FAIL: watchdog: no verdict within 210000 ms (lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on)" },
      { id: "lean-stdout", stream: "stdout", template: ["[lean:stdout] ${v}"], regex: /^\[lean:stdout\] (.*)$/,
        example: '[lean:stdout] {"severity":"information","pos":{"line":3,"column":0},"data":"64"}' },
      { id: "abort", stream: "stderr", template: ["ABORT:"], prefix: true, regex: /^ABORT: (.*)$/, example: "ABORT: RuntimeError: memory access out of bounds" },
      ...pathMarkers("snapshot-probe", ARTIFACT_PATH),
    ],
  },

  "persistent-probe": {
    script: "pipeline/snapshot/persistent-probe.mjs",
    npm: null,
    tier: 2,
    binding: "inline",
    node: "node --stack-size=8192",
    synopsis: "persistent-probe.mjs [--artifact <dir>]",
    summary: "Drive the persistent runtime path under Node (noInitialRun, manual init, repeated lean_wasm_compile): a good compile, a resident recompile, an error that does not kill the runtime, and survival after it.",
    flags: [
      { name: "artifact", value: "<dir>", default: ARTIFACT_DEFAULT, doc: "stage1 dir; its lib/lean is mounted at /lib/lean" },
    ],
    env: ["QED64_LEAN_ARTIFACT"],
    exits: {
      0: "PERSISTENT PROBE PASS",
      1: "PERSISTENT PROBE FAIL, or the artifact is unreadable (an unhandled ENOENT before the runtime starts)",
      2: "no --artifact, QED64_LEAN_ARTIFACT unset and no deprecated default (nothing booted)",
      3: "the wasm runtime aborted (legacy overload of class 3)",
    },
    markers: [
      { id: "pass", stream: "stdout", template: ["PERSISTENT PROBE PASS"], regex: /^PERSISTENT PROBE PASS$/, example: "PERSISTENT PROBE PASS" },
      { id: "fail", stream: "stderr", template: ["PERSISTENT PROBE FAIL:"], prefix: true, regex: /^PERSISTENT PROBE FAIL: (.*)$/, example: "PERSISTENT PROBE FAIL: compile 1 failed" },
      { id: "parse-swallowed", stream: "stdout", template: ["PARSE-ERROR-SWALLOWED (known runtime defect, see pipeline/toolchain/PATCHES.md)"],
        regex: /^PARSE-ERROR-SWALLOWED /, example: "PARSE-ERROR-SWALLOWED (known runtime defect, see pipeline/toolchain/PATCHES.md)" },
      { id: "parse-fixed", stream: "stdout", template: ["parse errors reported (${rg.errors.length}) — runtime defect is FIXED; update the app verdict copy"],
        regex: /runtime defect is FIXED/, example: "parse errors reported (1) — runtime defect is FIXED; update the app verdict copy" },
      { id: "abort", stream: "stderr", template: ["ABORT:"], prefix: true, regex: /^ABORT: (.*)$/, example: "ABORT: RuntimeError: unreachable" },
      ...pathMarkers("persistent-probe", ARTIFACT_PATH),
    ],
  },

  preflight: {
    script: "pipeline/release/preflight.mjs",
    npm: null,
    tier: 1,
    binding: "import",
    node: "node",
    synopsis: "preflight.mjs [--url <page url>] [--no-boot] [--boot-budget-ms 180000] [--run-dir <dir>]",
    summary: "Refuse a browser lane that cannot boot: for the pairing the page URL will boot, check the runtime manifest and every chunk, the snapshot index and files with their runtime pairing, the profile index, and (unless --no-boot) one headless boot smoke.",
    flags: [
      { name: "url", value: "<page url>", default: "http://localhost:5187/", doc: "the page URL; its ?runtime= / ?snapshots= / ?profiles= pick the pairing" },
      { name: "no-boot", doc: "skip the headless Chromium boot smoke (fetch-only checks)" },
      { name: "boot-budget-ms", value: "<ms>", default: "180000", doc: "the boot smoke's budget to reach the ready pill" },
      { name: "run-dir", value: "<dir>", doc: "also write <dir>/preflight.json (the directory is created)" },
    ],
    env: [],
    exits: {
      0: "PREFLIGHT OK",
      1: "a crash (e.g. a --url that is not a URL)",
      3: "PREFLIGHT REFUSED: the lane must not run",
    },
    markers: [
      { id: "target", stream: "stdout", template: ["preflight: ${target.url} (${target.mode}; manifest ${target.manifestUrl}; snapshots /${target.snapshotsDir}/)"],
        regex: /^preflight: (\S+) \((\S+); manifest (\S+); snapshots \/(\S+)\/\)$/,
        example: "preflight: http://localhost:5187/ (resident; manifest http://localhost:5187/runtime/runtime-manifest.json; snapshots /snapshots/)" },
      { id: "check", stream: "stdout", template: ["ok    ${what}"], regex: /^(ok {4}|warn {2}|FAIL {2})(.*)$/, example: "ok    manifest wasm64-0123456789abcdef (10 chunks, lean 4.34.0)" },
      { id: "refused", stream: "stdout", template: ["PREFLIGHT REFUSED: ${result.reason}"], regex: /^PREFLIGHT REFUSED: (.*)$/,
        example: "PREFLIGHT REFUSED: runtime manifest: http://localhost:5187/runtime/runtime-manifest.json: HTTP 404" },
      { id: "ok", stream: "stdout", template: ["PREFLIGHT OK buildId=${result.buildId} mode=${result.mode} snapshots=${target.snapshotsDir}"],
        regex: /^PREFLIGHT OK buildId=(\S+) mode=(\S+) snapshots=(\S+)$/, example: "PREFLIGHT OK buildId=wasm64-0123456789abcdef mode=resident snapshots=snapshots" },
    ],
  },

  "fetch-artifacts": {
    script: "pipeline/release/fetch-artifacts.mjs",
    npm: "fetch:artifacts",
    tier: 1,
    binding: "import",
    node: "node",
    synopsis: "fetch-artifacts.mjs [--out <dir>] [--manifests <dir>] [--release <dir|url>] [--origin <url|dir>] [--only runtime,profiles,snapshots] [--with-manifests]",
    summary: "Fill a public/-shaped tree with every binary the tracked manifests name (runtime chunks, profile pack parts, snapshot .snapz), each verified by sha256 and size and written by temp file + rename; files already present with the pinned digest are skipped. Runtime and profiles come from --release when given, everything else from --origin; snapshots are site-owned and never come from a release.",
    flags: [
      { name: "out", value: "<dir>", default: "this checkout's public/ (refused when that is inside node_modules)", doc: "the tree to fill; nothing is written outside it" },
      { name: "manifests", value: "<dir>", default: "this checkout's public/", doc: "the tree holding the tracked manifests (runtime/runtime-manifest.json, profiles/index.json and its manifests, snapshots/index.json); an installed package has none" },
      { name: "release", value: "<dir|url>", doc: "a fork release in the served layout (release.json, lean4-wasm64.release/v1): /runtime/* and /profiles/* come from it, each also checked against its files[] sha256 and bytes" },
      { name: "origin", value: "<url|dir>", default: "https://qed64.fawadworkaddress.workers.dev/", doc: "a QED64 site (or a served tree on disk): everything --release does not provide" },
      { name: "only", value: "<groups>", default: "runtime,profiles,snapshots", doc: "a comma list of runtime, profiles, snapshots" },
      { name: "with-manifests", doc: "also write the tracked manifests themselves into --out (for a tree that is not this checkout's public/)" },
    ],
    env: [],
    exits: {
      0: "FETCH OK: every file the manifests name is in --out with its pinned digest",
      1: "FETCH FAILED: a fetch failed (an HTTP status, the network), a size or digest mismatch (the temp file is deleted), parts that do not assemble to their whole-file pin, or a release that does not list or pin a file as the manifests do",
      2: "FETCH FAILED, refused before any write: a malformed --only, a tracked manifest missing or malformed, a manifest URL outside its directory, a target outside --out (a symlink out of the tree), or the default --out inside node_modules",
      130: "FETCH FAILED interrupted (SIGINT): the run stopped and deleted its temp files",
      143: "FETCH FAILED interrupted (SIGTERM): the run stopped and deleted its temp files",
    },
    markers: [
      { id: "plan", stream: "stderr", template: ["${TOOL}: ${group}: ${g.length} files, ${g.reduce((s, j) => s + j.bytes, 0)} bytes from ${from}"],
        regex: /^fetch-artifacts: (runtime|profiles|snapshots): (\d+) files, (\d+) bytes from (.+)$/,
        example: "fetch-artifacts: runtime: 10 files, 158847486 bytes from https://qed64.fawadworkaddress.workers.dev/" },
      { id: "fetched", stream: "stderr", template: ["${TOOL}: fetched ${j.rel} (${j.bytes} bytes)"],
        regex: /^fetch-artifacts: fetched (\S+) \((\d+) bytes\)$/, example: "fetch-artifacts: fetched runtime/chunks/lean.wasm.5500c87fb8f37d2e273a.part-000 (16777216 bytes)" },
      { id: "present", stream: "stderr", template: ["${TOOL}: present ${j.rel} (${j.bytes} bytes, verified)"],
        regex: /^fetch-artifacts: present (\S+) \((\d+) bytes, verified\)$/, example: "fetch-artifacts: present snapshots/init.b6d945e398b4d55e.snapz (32643656 bytes, verified)" },
      { id: "replacing", stream: "stderr", template: ["${TOOL}: replacing ${j.rel}: the file there does not match its pin"],
        regex: /^fetch-artifacts: replacing (\S+): /, example: "fetch-artifacts: replacing profiles/lean-core.pack.gzip.bc2709bea0127940a05b.part-000: the file there does not match its pin" },
      { id: "verified", stream: "stderr", template: ["${TOOL}: verified ${w.label} (${w.bytes} bytes, sha256 ${got.slice(0, 16)}…, ${w.rels.length} parts)"],
        regex: /^fetch-artifacts: verified (.+) \((\d+) bytes, sha256 ([0-9a-f]{16})…, (\d+) parts\)$/,
        example: "fetch-artifacts: verified runtime lean.wasm (109875453 bytes, sha256 3ab1c6a9da03bc29…, 7 parts)" },
      { id: "removed", stream: "stderr", template: ["${TOOL}: removed ${path.relative(outRoot, r.file)}, a temp file left by process ${r.pid}"],
        regex: /^fetch-artifacts: removed (\S+), a temp file left by process (\d+)$/,
        example: "fetch-artifacts: removed snapshots/.mathlib.0b7f0c1b2a3d4e5f.snapz.69478-1295a546.tmp, a temp file left by process 69478" },
      { id: "wrote", stream: "stderr", template: ["${TOOL}: wrote ${c.rel} (${c.bytes} bytes, the tracked ${c.from ?? c.rel})"],
        regex: /^fetch-artifacts: wrote (\S+) \((\d+) bytes, the tracked (\S+)\)$/,
        example: "fetch-artifacts: wrote runtime/runtime-manifest.wasm64-3ab1c6a9da03bc29.json (2858 bytes, the tracked runtime/runtime-manifest.json)" },
      { id: "ok", stream: "stdout", template: ["FETCH OK ${stats.files} files, ${stats.bytes} bytes (${stats.fetched} fetched, ${stats.present} already present)"],
        regex: /^FETCH OK (\d+) files, (\d+) bytes \((\d+) fetched, (\d+) already present\)$/, example: "FETCH OK 139 files, 1260153706 bytes (139 fetched, 0 already present)" },
      { id: "failed", stream: "stdout", template: ["FETCH FAILED ${oneLine(e.message)}"], regex: /^FETCH FAILED (.*)$/,
        example: "FETCH FAILED snapshots/init.b6d945e398b4d55e.snapz: HTTP 404 from https://qed64.fawadworkaddress.workers.dev/snapshots/init.b6d945e398b4d55e.snapz" },
    ],
  },

  "olean-imports": {
    script: "pipeline/artifacts/olean-imports.mjs",
    npm: null,
    tier: 1,
    binding: "inline",
    node: "node",
    synopsis: "olean-imports.mjs (--audit <olean tree> | --entries <olean file>)",
    summary: "--audit: the `import all` edges of an olean tree, by importing library: the static half of the slim-bake audit (`import all M` needs M.olean.private, which a slim tree lacks). --entries: one .olean's ModuleData entry counts (constant names; entries per environment extension) as one line of JSON. As a module it exports oleanImportEntries / oleanImports / oleanExtEntryCounts.",
    flags: [
      { name: "audit", value: "<olean tree>", doc: "the tree to audit (every *.olean under it)" },
      { name: "entries", value: "<olean file>", doc: "print the file's ModuleData entry counts instead (one JSON line)" },
    ],
    required: [["audit", "entries"]],
    env: [],
    exits: {
      0: "audited, or the entry counts printed",
      1: "audited, but some .olean files had no readable import table; or the --entries file has no readable ModuleData",
      2: "usage: neither --audit nor --entries, both, or the tree or file does not exist",
    },
    markers: [
      { id: "summary", stream: "stdout", prefix: true, template: ["import-all audit of ${tree}: ${files.length} modules, ${edges.length} \\`import all\\` edge(s)"],
        regex: /^import-all audit of (.+): (\d+) modules, (\d+) `import all` edge\(s\)(, (\d+) unreadable \.olean file\(s\))?$/,
        example: "import-all audit of /repo/work/lib-tree: 4354 modules, 212 `import all` edge(s)" },
      { id: "outside", stream: "stdout", template: ["  outside Init/Std/Lean/Lake: ${outside.length}"],
        regex: /^ {2}outside Init\/Std\/Lean\/Lake: (\d+)$/, example: "  outside Init/Std/Lean/Lake: 0" },
      { id: "edge", stream: "stdout", template: ["    ${importer} → import all ${imported}"],
        regex: /^ {4}(\S+) → import all (\S+)$/, example: "    Lib.A → import all Init.Core" },
      { id: "entries", stream: "stdout", template: ["entries of ${file}: ${JSON.stringify(counts)}"],
        regex: /^entries of (.+): (\{"constNames":\d+,"entries":\{.*\}\})$/,
        example: 'entries of /repo/lib/Init/Core.olean: {"constNames":1124,"entries":{"Lean.IR.declMapExt":541,"Lean.protectedExt":212}}' },
    ],
  },

  "chunk-runtime": {
    script: "pipeline/toolchain/chunk-runtime.mjs",
    npm: null,
    tier: 2,
    binding: "inline",
    node: "node",
    synopsis: "chunk-runtime.mjs --bin <dir> [--lean-version v] [--revision sha] [--upstream-base sha] [--out dir]",
    summary: "Chunk a built lean.js/lean.wasm pair into the verified runtime layout (16 MiB sha256-addressed parts + runtime-manifest.json and runtime-manifest.<buildId>.json) in a staging dir; additive, never inside public/. Deprecated forward (contract 3): after the path rule, the public/ refusal and the WARNINGs it prints one deprecation WARNING and runs lean4-wasm64 chunk with --bin, --out, --lean-version and --revision.",
    flags: [
      { name: "bin", value: "<dir>", doc: "dir holding lean.js + lean.wasm" },
      { name: "lean-version", value: "<x.y.z>", default: "4.33.0-pre, with a WARNING on stderr", doc: "the manifest's leanVersion; promote pairs packs against it" },
      { name: "revision", value: "<string>", default: "qed64-wasm64@<HEAD of pipeline/toolchain/work/lean4, relative to the cwd> (base <upstream-base>), else unspecified; git runs only when --revision is absent", doc: "the manifest's sourceRevision" },
      { name: "upstream-base", value: "<sha|tag>", default: "5732b84", doc: "the upstream base named in the default --revision" },
      { name: "out", value: "<dir>", default: viaEnv("QED64_STAGING", "work/staging/<buildId>/runtime under the repo root") + "; with QED64_STAGING, <QED64_STAGING>/<buildId>/runtime", doc: "staging dir; refused inside public/; a relative --out resolves against the repo root" },
    ],
    required: [["bin"]],
    env: ["QED64_STAGING", "LEAN4_WASM64_DIR"],
    exits: {
      0: "chunked",
      1: "a crash (lean.wasm unreadable under --bin, or the package's chunker failed)",
      2: "usage, --out inside public/, or lean4-wasm64 not found (set LEAN4_WASM64_DIR or install the devDependency)",
    },
    markers: [
      { id: "file", stream: "stdout", forwarded: "chunk-runtime.mjs", template: ["${name}: ${bytes.length} bytes, ${chunks.length} chunks, sha256:${whole.slice(0, 16)}…"],
        regex: /^(lean\.js|lean\.wasm): (\d+) bytes, (\d+) chunks, sha256:([0-9a-f]{16})…$/, example: "lean.wasm: 109869533 bytes, 7 chunks, sha256:36a96239e08fd2e0…" },
      { id: "done", stream: "stdout", forwarded: "chunk-runtime.mjs", template: ["runtime ${buildId} → ${outDir}"], regex: /^runtime (wasm64-[0-9a-f]{16}) → (.+)$/,
        example: "runtime wasm64-36a96239e08fd2e0 → /repo/work/staging/wasm64-36a96239e08fd2e0/runtime" },
      { id: "no-version", stream: "stderr", prefix: true, template: ["chunk-runtime: WARNING — no --lean-version given; the manifest will say Lean ${DEFAULT_LEAN_VERSION}."],
        regex: /^chunk-runtime: WARNING — no --lean-version given/, example: "chunk-runtime: WARNING — no --lean-version given; the manifest will say Lean 4.33.0-pre." },
      { id: "refuse-public", stream: "stderr", source: "pipeline/toolchain/artifact-paths.mjs", prefix: true,
        template: ["${who}: refusing --out ${target}: it resolves inside public/. "],
        regex: /^(bake-snapshot|chunk-runtime): refusing --out (.+): it resolves inside public\/\. /,
        example: "chunk-runtime: refusing --out /repo/public/runtime: it resolves inside public/. Producers stage under work/staging/<buildId>/; use `npm run promote:staging` to publish (HARDENING #32)." },
      { id: "deprecated", stream: "stderr", template: ["chunk-runtime: WARNING — pipeline/toolchain/chunk-runtime.mjs is deprecated; use lean4-wasm64 chunk --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string> (the fork's package) (docs/CLI-CONTRACT.md)"],
        regex: /^chunk-runtime: WARNING — pipeline\/toolchain\/chunk-runtime\.mjs is deprecated; use lean4-wasm64 chunk /,
        example: "chunk-runtime: WARNING — pipeline/toolchain/chunk-runtime.mjs is deprecated; use lean4-wasm64 chunk --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string> (the fork's package) (docs/CLI-CONTRACT.md)" },
      { id: "no-package", stream: "stderr", source: "pipeline/toolchain/artifact-paths.mjs", prefix: true, template: ["${tool}: lean4-wasm64 not found — "],
        regex: /^(\S+): lean4-wasm64 not found — set LEAN4_WASM64_DIR=<package dir> or install it: /,
        example: "chunk-runtime: lean4-wasm64 not found — set LEAN4_WASM64_DIR=<package dir> or install it: npm i -D <release tgz URL> (toolchain/lean4-wasm64-release.json names it) (docs/CLI-CONTRACT.md)" },
      pathMarkers("chunk-runtime", { flag: "out", placeholder: "<dir>", env: "QED64_STAGING", legacyLabel: "work/staging/<buildId>/runtime under the repo root", legacy: "/repo/work/staging/wasm64-36a96239e08fd2e0/runtime" })[0],
    ],
  },

  pack: {
    script: "pipeline/artifacts/pack.mjs",
    npm: "pack",
    tier: 2,
    binding: "inline",
    node: "node",
    synopsis: "pack.mjs --lib <dir> --id <name> --out <dir> [...]",
    summary: "Pack every olean/ir facet under --lib into a raw pack + browser64.artifact-manifest: 8-byte-aligned bytes, an index, gzip transport cut into 16 MiB content-addressed parts, a WORKERFS byte-range table; each module's imports read from its .olean.",
    flags: [
      { name: "lib", value: "<dir>", doc: "the olean tree to pack" },
      { name: "id", value: "<name>", doc: "pack id: <id>.pack, <id>.manifest.json, part names" },
      { name: "out", value: "<dir>", default: "work/packs, relative to the cwd", doc: "output dir" },
      { name: "mount", value: "<path>", default: "/lib/lean/library", doc: "the WORKERFS mount point recorded in the manifest" },
      { name: "lean-version", value: "<x.y.z>", default: "4.33.0-pre", doc: "content.lean.version" },
      { name: "revision", value: "<string>", default: "unpinned", doc: "content.lean.gitRevision" },
      { name: "roots", value: "<A,B,…>", default: "none", doc: "content.roots" },
      { name: "url-prefix", value: "<prefix>", default: "empty: bare part names", doc: "where the parts will be SERVED from, e.g. /profiles/" },
      { name: "release", value: "<string>", default: "<id>-<lean-version>-local", doc: "content.release" },
      { name: "no-imports", doc: "do not read imports from the .olean files (fixtures that are not real regions)" },
    ],
    required: [["lib"], ["id"]],
    env: [],
    exits: {
      0: "packed",
      1: "packed, but some .olean files had no readable import table (pass --no-imports if intended)",
      2: "usage, or no artifacts under --lib",
    },
    markers: [
      { id: "summary", stream: "stdout",
        template: ["${packId}: ${files.length} artifacts, ${Object.keys(modules).length} modules, pack ${packLength} bytes (sha256:${packDigest.slice(0, 16)}…), ", "transport ${transportBytes} bytes in ${parts.length} part(s) → ${outDir}"],
        regex: /^(\S+): (\d+) artifacts, (\d+) modules, pack (\d+) bytes \(sha256:([0-9a-f]{16})…\), transport (\d+) bytes in (\d+) part\(s\) → (.+)$/,
        example: "lean-core: 3245 artifacts, 649 modules, pack 390065102 bytes (sha256:1c5c75db0123abcd…), transport 98000000 bytes in 6 part(s) → /repo/work/packs" },
      { id: "unreadable", stream: "stderr", prefix: true, template: ["${packId}: ${unreadable} .olean file(s) had no readable import table"],
        regex: /^(\S+): (\d+) \.olean file\(s\) had no readable import table/,
        example: "fixture: 2 .olean file(s) had no readable import table (not 64-bit regions?) — their imports are recorded as []; pass --no-imports if that is intended" },
    ],
  },

  unpack: {
    script: "pipeline/artifacts/unpack.mjs",
    npm: null,
    tier: 2,
    binding: "inline",
    node: "node",
    synopsis: "unpack.mjs --manifest <file> --out <dir> [--slim]",
    summary: "Reconstruct an on-disk olean tree from a profile's verified transport parts (each part and the raw pack sha256-checked), for the Node-side bakes. Deprecated forward (contract 3): after this help and the usage check it prints one WARNING and runs lean4-wasm64 unpack with the same arguments.",
    flags: [
      { name: "manifest", value: "<file>", doc: "a profile manifest; its parts are read from the same directory by basename" },
      { name: "out", value: "<dir>", doc: "the tree to write (files are added or overwritten, never deleted)" },
      { name: "slim", doc: "do not write *.olean.private facets (lean4-wasm64 unpack --slim)" },
    ],
    required: [["manifest"], ["out"]],
    env: ["LEAN4_WASM64_DIR"],
    exits: {
      0: "unpacked",
      1: "a part, the raw pack or a path failed verification (or the manifest is unreadable)",
      2: "usage, or lean4-wasm64 not found (set LEAN4_WASM64_DIR or install the devDependency)",
    },
    markers: [
      // Group 4 is the out dir, group 5 the --slim count (absent without --slim).
      { id: "done", stream: "stdout", forwarded: "unpack.mjs", template: ["${release}: unpacked ${files} files, ${(bytes / 1e9).toFixed(2)} GB → ${outDir}${slim ? ` (--slim: ${skipped} *.olean.private left out)` : \"\"}"],
        regex: /^(\S+): unpacked (\d+) files, (\d+\.\d\d) GB → (.+?)(?: \(--slim: (\d+) \*\.olean\.private left out\))?$/, example: "lean-core-4.34.0-wasm64-36a96239e08fd2e0: unpacked 3245 files, 0.39 GB → /repo/work/lib-tree",
        examples: ["lean-core-4.34.0-wasm64-36a96239e08fd2e0: unpacked 2596 files, 0.13 GB → /repo/work/lib-tree-slim (--slim: 649 *.olean.private left out)"] },
      { id: "fail", stream: "stderr", forwarded: "unpack.mjs", template: ["FAIL: transport part ${part.url} failed verification"], regex: /^FAIL: (.*)$/,
        example: "FAIL: transport part /profiles/lean-core.pack.gzip.0123456789abcdef0123.part-000 failed verification" },
      { id: "deprecated", stream: "stderr", template: ["unpack: WARNING — pipeline/artifacts/unpack.mjs is deprecated; use lean4-wasm64 unpack (the fork's package) (docs/CLI-CONTRACT.md)"],
        regex: /^unpack: WARNING — pipeline\/artifacts\/unpack\.mjs is deprecated; use lean4-wasm64 unpack/,
        example: "unpack: WARNING — pipeline/artifacts/unpack.mjs is deprecated; use lean4-wasm64 unpack (the fork's package) (docs/CLI-CONTRACT.md)" },
      { id: "no-package", stream: "stderr", source: "pipeline/toolchain/artifact-paths.mjs", prefix: true, template: ["${tool}: lean4-wasm64 not found — "],
        regex: /^(\S+): lean4-wasm64 not found — set LEAN4_WASM64_DIR=<package dir> or install it: /,
        example: "unpack: lean4-wasm64 not found — set LEAN4_WASM64_DIR=<package dir> or install it: npm i -D <release tgz URL> (toolchain/lean4-wasm64-release.json names it) (docs/CLI-CONTRACT.md)" },
      { id: "not-package", stream: "stderr", source: "pipeline/toolchain/artifact-paths.mjs", prefix: true, template: ["${tool}: LEAN4_WASM64_DIR=${named} is not the lean4-wasm64 package (no package.json named lean4-wasm64) — "],
        regex: /^(\S+): LEAN4_WASM64_DIR=(.+) is not the lean4-wasm64 package /,
        example: "unpack: LEAN4_WASM64_DIR=/repo/vendor/qed64 is not the lean4-wasm64 package (no package.json named lean4-wasm64) — set LEAN4_WASM64_DIR=<package dir> or install it: npm i -D <release tgz URL> (toolchain/lean4-wasm64-release.json names it) (docs/CLI-CONTRACT.md)" },
    ],
  },
};

/** Tier 3 — diagnostic tools with no stability promise (no SPEC, no prelude). */
export const DIAGNOSTIC = [
  "pipeline/snapshot/thread-storm-probe.mjs",
  "pipeline/snapshot/fileworker-exit-probe.mjs",
  "pipeline/snapshot/resident-probe.mjs", // --snapshots/--mathlib/--act4 absorbed header-switch-probe.mjs (2026-10)
  "pipeline/artifacts/inspect.mjs",
];

/**
 * The argument grammar — the ONE implementation (docs/CLI-CONTRACT.md
 * "Argument grammar"). `spec` is compactSpec(tool); `args` excludes node and
 * the script. --help/-h anywhere in the tool's own arguments (a flag's value
 * position included) prints spec.help and exits 0 before anything else.
 * Otherwise every WARNING is printed, then a missing required flag prints the
 * usage line and exits 2. Returns { values, passthrough, args }: values
 * without empty ones (an empty value counts as absent, as `arg()` always
 * treated it), and `args` normalized to the two-token form (--flag value)
 * with each later occurrence of a repeated value flag dropped, so a script's
 * own parser reads the first value whether it keeps the first (`indexOf`) or
 * the last (node-runner's loop).
 *
 * Self-contained on purpose: renderPrelude() inlines this function's SOURCE
 * into the scripts downstream vendors without this module, so it may use
 * nothing but its parameters and Node globals.
 */
export function cliContract(spec, args, io = { out: (s) => console.log(s), err: (s) => console.error(s), exit: (c) => process.exit(c) }) {
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
}

/** What cliContract needs of a SPEC (and all an inline prelude carries). */
export function compactSpec(tool) {
  const s = SPECS[tool];
  if (!s) throw new Error(`no CLI spec named ${tool}`);
  return {
    tool,
    usage: s.synopsis,
    flags: Object.fromEntries(s.flags.map((f) => [f.name, f.value ? 1 : 0])),
    required: s.required ?? [],
    passthrough: s.passthrough?.mode ?? null,
    passthroughRequired: Boolean(s.passthrough?.required),
    help: formatHelp(tool),
  };
}

/** Parse the running script's arguments by the contract (help, usage, warnings). */
export function parseCli(tool, args = process.argv.slice(2), io = undefined) {
  return cliContract(compactSpec(tool), args, io);
}

const TIER_NAMES = { 1: "downstream-stable", 2: "internal-stable", 3: "diagnostic, no promise" };

/** The help text --help prints (stdout, exit 0). Its first line is the usage line. */
export function formatHelp(tool) {
  const s = SPECS[tool];
  if (!s) throw new Error(`no CLI spec named ${tool}`);
  const rows = (pairs) => {
    const width = Math.min(26, Math.max(...pairs.map(([k]) => k.length)) + 2);
    return pairs.map(([k, v]) => (k.length + 2 > width ? `  ${k}\n  ${" ".repeat(width)}${v}` : `  ${k.padEnd(width)}${v}`));
  };
  const lines = [`usage: ${s.synopsis}`, s.summary, `run as: ${s.node} ${s.script}${s.npm ? ` (or npm run ${s.npm} -- …)` : ""}`, "", "flags:"];
  const requiredBy = new Map();
  for (const group of s.required ?? []) for (const name of group) requiredBy.set(name, group);
  lines.push(...rows([
    ...s.flags.map((f) => {
      const group = requiredBy.get(f.name);
      const req = !group ? "" : group.length === 1 ? " [required]" : ` [one of ${group.map((n) => `--${n}`).join(", ")} is required]`;
      return [`--${f.name}${f.value ? ` ${f.value}` : ""}`, `${f.doc}${f.default !== undefined ? ` (default: ${f.default})` : ""}${req}`];
    }),
    ["-h, --help", "print this help and exit 0, before any side effect"],
  ]));
  if (s.passthrough) lines.push("", `arguments${s.passthrough.mode === "separator" ? " after --" : ""}${s.passthrough.required ? " [required]" : ""}: ${s.passthrough.doc}`);
  if (s.env.length) lines.push("", "environment:", ...rows(s.env.map((name) => [name, ENV[name].doc])));
  lines.push("", "exit codes:", ...rows(Object.entries(s.exits).map(([code, doc]) => [code, doc])));
  lines.push("", `tier ${s.tier} (${TIER_NAMES[s.tier]}). Contract: docs/CLI-CONTRACT.md`);
  return lines.join("\n");
}

export const PRELUDE_BEGIN = "// <cli-contract>";
export const PRELUDE_END = "// </cli-contract>";

/** The generated block an "inline" script carries (unindented). */
export function renderPrelude(tool) {
  const spec = compactSpec(tool);
  const { help, ...rest } = spec;
  const fn = cliContract.toString().split("\n").map((line, i) => (i === 0 ? line : `  ${line}`)).join("\n");
  return [
    `${PRELUDE_BEGIN} generated from SPECS[${JSON.stringify(tool)}] in pipeline/snapshot/cli.mjs. Do not edit:`,
    "// `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts",
    "// fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.",
    "// It runs before any side effect: --help/-h prints the help and exits 0, a missing required",
    "// flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and",
    "// --flag=value is rewritten to the two-token form this script reads, with the later values",
    "// of a repeated flag dropped so the first wins here too (docs/CLI-CONTRACT.md).",
    "{",
    `  const spec = ${JSON.stringify(rest)};`,
    "  spec.help = [",
    ...help.split("\n").map((line) => `    ${JSON.stringify(line)},`),
    '  ].join("\\n");',
    "  const args = process.argv.slice(2);",
    `  const normalized = (${fn})(spec, args)?.args ?? args;`,
    '  if (normalized.join("\\0") !== args.join("\\0")) process.argv.splice(2, args.length, ...normalized);',
    "}",
    PRELUDE_END,
  ].join("\n");
}

/** Locate the prelude region of a script's source: { start, end, indent } (line indices, inclusive) or null. */
export function findPrelude(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith(PRELUDE_BEGIN));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === PRELUDE_END);
  if (end < 0) return null;
  return { start, end, indent: /^\s*/.exec(lines[start])[0], lines };
}

/** The source with its prelude region replaced by the current rendering. */
export function withPrelude(source, tool) {
  const at = findPrelude(source);
  if (!at) throw new Error(`${SPECS[tool].script}: no ${PRELUDE_BEGIN} … ${PRELUDE_END} region`);
  const block = renderPrelude(tool).split("\n").map((l) => (l ? at.indent + l : l));
  return [...at.lines.slice(0, at.start), ...block, ...at.lines.slice(at.end + 1)].join("\n");
}

/** SPECS as plain JSON (regexes as their source text). */
export function specsJson() {
  const specs = {};
  for (const [tool, s] of Object.entries(SPECS)) {
    specs[tool] = { ...s, markers: s.markers.map((m) => ({ ...m, regex: m.regex.source })) };
  }
  return { contractVersion: CONTRACT_VERSION, exitClasses: EXIT_CLASSES, reservedOutput: RESERVED_OUTPUT, env: ENV, specs, diagnostic: DIAGNOSTIC };
}

// Run as a CLI only when this file is the main module. Compare realpaths: through a symlinked
// install (file: dependency, npm link, workspace, pnpm) Node loads the main module by its realpath
// while process.argv[1] keeps the symlink path, so a plain path compare would skip main() and exit 0.
const invokedDirectly = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const [cmd, tool] = process.argv.slice(2);
  const usage = "usage: cli.mjs (--print-specs | --help [<tool>] | --check-preludes | --write-preludes)";
  if (cmd === "--print-specs") {
    console.log(JSON.stringify(specsJson(), null, 2));
  } else if ((cmd === "--help" || cmd === "-h") && tool) {
    if (!SPECS[tool]) { console.error(`cli.mjs: no CLI spec named ${tool} (known: ${Object.keys(SPECS).join(", ")})`); process.exit(2); }
    console.log(formatHelp(tool));
  } else if (cmd === "--help" || cmd === "-h") {
    console.log(`${usage}\nThe pipeline CLI contract (docs/CLI-CONTRACT.md). Tools: ${Object.keys(SPECS).join(", ")}.`);
  } else if (cmd === "--check-preludes" || cmd === "--write-preludes") {
    let drift = 0;
    for (const [name, s] of Object.entries(SPECS)) {
      if (s.binding !== "inline") continue;
      const file = path.join(root, s.script);
      const source = fs.readFileSync(file, "utf8");
      const next = withPrelude(source, name);
      if (next === source) continue;
      if (cmd === "--write-preludes") { fs.writeFileSync(file, next); console.log(`rewrote the prelude of ${s.script}`); } else { console.log(`DRIFT ${s.script}`); drift += 1; }
    }
    if (drift) { console.log(`${drift} prelude(s) differ from SPECS: run node pipeline/snapshot/cli.mjs --write-preludes`); process.exit(1); }
    if (cmd === "--check-preludes") console.log("preludes match SPECS");
  } else {
    console.error(usage);
    process.exit(2);
  }
}
