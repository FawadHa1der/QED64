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
//              preflight: no downstream copies them without this file);
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
export const CONTRACT_VERSION = 1;

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
    doc: "stage1 artifact dir (bin/lean.js, bin/lean.wasm, lib/lean) used when --artifact is absent",
    readBy: ["bake-snapshot", "node-runner", "snapshot-probe", "persistent-probe"],
  },
  LEAN_COMPACTOR_RESERVE: {
    doc: "bytes the compactor reserves up front for a whole-environment save (toolchain patch 0011)",
    readBy: ["node-runner"],
    setBy: ["bake-snapshot"],
  },
  QED64_ALLOW_LEGACY_IMPORTS: {
    doc: "when set, lets the exported-level env cache load legacy non-module packages (patch 0030; the lean4game bakes)",
    readBy: ["node-runner"],
  },
  QED64_PROFILE_INIT: {
    doc: "when set, forwarded into the wasm environment to profile the [init] replay",
    readBy: ["node-runner", "snapshot-probe"],
  },
};

const ARTIFACT_DEFAULT = "$QED64_LEAN_ARTIFACT, else pipeline/toolchain/work/build/stage1";
const SIBLING_STAGE1 = "../../wasm64-lean-codex/experiments/lean4-wasm64-build/stage1";

/**
 * The contract, one entry per tool. Flags: `value` present = takes a value
 * (`--flag <value>` or `--flag=<value>`), absent = boolean. `required` is a
 * list of groups; each group needs one of its flags. Markers: `stream`,
 * `template` (the format string(s) exactly as they appear in `source`,
 * default the tool's script), `prefix` (the line STARTS with the template:
 * console arguments or optional text follow), `regex` (what consumers may
 * match, applied per line), `example` (a line the script can print).
 */
export const SPECS = {
  "bake-snapshot": {
    script: "pipeline/snapshot/bake-snapshot.mjs",
    npm: "bake:snapshot",
    tier: 1,
    binding: "inline",
    node: "node",
    synopsis: "bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>]",
    summary: "Bake an environment snapshot with the exact wasm64 runtime under Node (the runner is supervised and reaped), gzip it content-addressed into the staging dir and upsert its index entry.",
    flags: [
      { name: "name", value: "<name>", default: "init", doc: "snapshot name: <work>/<name>.snap, <name>.<digest16>.snapz and the index entry" },
      { name: "probe", value: "<lean source>", default: "#check (2 + 2 : Nat)", doc: "the baked file; its import lines become the entry's imports (the env-cache key)" },
      { name: "artifact", value: "<dir>", default: ARTIFACT_DEFAULT, doc: "stage1 dir whose bin/lean.wasm bakes and is stamped as `runtime`; always passed to the runner" },
      { name: "lib", value: "<olean tree>", default: "the runner's <artifact>/lib/lean", doc: "olean tree mounted at /lib/lean" },
      { name: "reserve", value: "<bytes>", default: "3758096384 (3.5 GiB)", doc: "compactor buffer reserved up front (LEAN_COMPACTOR_RESERVE for the runner)" },
      { name: "work", value: "<dir>", default: "work/snapshot under the repo root: the PAIRED set the probes load", doc: "raw .snap + probe.lean; <work>/<name>.snap is deleted when the bake starts" },
      { name: "out", value: "<dir>", default: "work/staging/<buildId>/snapshots under the repo root", doc: "staged .snapz + index.json; refused inside public/" },
      { name: "roots", value: "<A,B,…>", default: "none (the legacy rule: an entry named mathlib serves the umbrella roots)", doc: "module roots the entry serves (docs/EMBEDDING.md §8): the page boots and widens to it for a header naming one" },
      { name: "label", value: "<text>", default: "none", doc: "the entry's human name for the page's pill and boot card" },
      { name: "initial-bytes", value: "<bytes>", default: "none (2 GiB with a non-base entry)", doc: "initial Memory64 commit when the entry is loaded" },
    ],
    env: ["QED64_LEAN_ARTIFACT", "LEAN_COMPACTOR_RESERVE", "QED64_ALLOW_LEGACY_IMPORTS", "QED64_PROFILE_INIT"],
    exits: {
      0: "baked and the index upserted (also when the wedged runner was reaped); NOT a verdict on the probe's Lean messages",
      1: "the runner exited non-zero, or no .snap was produced",
      2: "refused before the runner: no lean.wasm under the artifact, --out inside public/, an index paired with another runtime or with none, a malformed --roots or --initial-bytes",
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
      { name: "artifact", value: "<dir>", default: `$QED64_LEAN_ARTIFACT, else pipeline/toolchain/work/build/stage1 when it has bin/lean.js, else ${SIBLING_STAGE1}, both relative to the repo root`, doc: "stage1 dir holding bin/lean.js, bin/lean.wasm and lib/lean" },
      { name: "work", value: "<dir>", default: "work/runner under the repo root", doc: "host dir mounted read-write at /work, Lean's cwd; created when absent" },
      { name: "lib", value: "<dir>", default: "<artifact>/lib/lean", doc: "olean tree mounted at /lib/lean, e.g. an unpacked profile pack for bakes" },
    ],
    passthrough: { mode: "implicit", required: false, doc: "Lean's own arguments: everything after --, or from the first token that is not a runner flag (`-- --help` asks Lean, whose process then never exits)" },
    env: ["QED64_LEAN_ARTIFACT", "LEAN_COMPACTOR_RESERVE", "QED64_ALLOW_LEGACY_IMPORTS", "QED64_PROFILE_INIT"],
    exits: {
      0: "Lean exited 0 (rare since patch 0031: the process normally stays alive after main returns)",
      1: "Lean's own non-zero exit code, passed through when the process does exit",
      2: "lean.js or the library tree not found",
      3: "the wasm runtime aborted (legacy overload of class 3)",
    },
    markers: [
      { id: "abort", stream: "stderr", template: ["ABORT:"], prefix: true, regex: /^ABORT: (.*)$/, example: "ABORT: RuntimeError: unreachable" },
      { id: "no-lean-js", stream: "stderr", template: ["error: ${leanJs} not found — pass --artifact or set QED64_LEAN_ARTIFACT"],
        regex: /^error: (.+) not found — pass --artifact or set QED64_LEAN_ARTIFACT$/,
        example: "error: /tmp/missing/bin/lean.js not found — pass --artifact or set QED64_LEAN_ARTIFACT" },
      { id: "no-lib", stream: "stderr", template: ["error: ${libLean} not found"], regex: /^error: (.+) not found$/, example: "error: /tmp/stage1/lib/lean not found" },
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
      { name: "lib", value: "<tree>", default: "work/lib-tree under the repo root", doc: "olean tree mounted at /lib/lean" },
      { name: "artifact", value: "<dir>", default: ARTIFACT_DEFAULT, doc: "stage1 dir holding bin/lean.js + bin/lean.wasm" },
      { name: "budget-ms", value: "<ms>", default: "90000", doc: "compile budget; slower means the load seeded the wrong env-cache key" },
      { name: "via-mem", doc: "stream the snapshot into a wasm-malloc'd buffer (lean_wasm_load_snapshot_mem, the browser's path)" },
      { name: "via-memfs", doc: "copy the snapshot into MEMFS in 64 MiB chunks before loading" },
      { name: "init-flags", value: "<n>", default: "1", doc: "replay-control flags passed with --via-mem (patch 0016)" },
      { name: "workspace", value: "<dir>", doc: "host dir mounted at /workspace, the compile's cwd (game probes need .lake/gamedata)" },
      { name: "dump-messages", doc: "echo every line Lean prints on stdout as `[lean:stdout] <line>`" },
    ],
    required: [["snap", "fresh-import"], ["probe-file", "probe"]],
    env: ["QED64_LEAN_ARTIFACT", "QED64_PROFILE_INIT"],
    exits: {
      0: "SNAPSHOT PROBE PASS",
      1: "SNAPSHOT PROBE FAIL (load failed, the probe has errors or blew the budget), or a crash before the runtime started (an unreadable --probe-file, a missing lean.js)",
      2: "usage: no snapshot source or no probe",
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
      { id: "lean-stdout", stream: "stdout", template: ["[lean:stdout] ${v}"], regex: /^\[lean:stdout\] (.*)$/,
        example: '[lean:stdout] {"severity":"information","pos":{"line":3,"column":0},"data":"64"}' },
      { id: "abort", stream: "stderr", template: ["ABORT:"], prefix: true, regex: /^ABORT: (.*)$/, example: "ABORT: RuntimeError: memory access out of bounds" },
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
      { name: "artifact", value: "<dir>", default: `$QED64_LEAN_ARTIFACT, else pipeline/toolchain/work/build/stage1 when it has bin/lean.js, else ${SIBLING_STAGE1}, both relative to the repo root`, doc: "stage1 dir; its lib/lean is mounted at /lib/lean" },
    ],
    env: ["QED64_LEAN_ARTIFACT"],
    exits: {
      0: "PERSISTENT PROBE PASS",
      1: "PERSISTENT PROBE FAIL, or the artifact is unreadable (an unhandled ENOENT before the runtime starts)",
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
    ],
  },

  preflight: {
    script: "tests/adversarial/preflight.mjs",
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

  "olean-imports": {
    script: "pipeline/artifacts/olean-imports.mjs",
    npm: null,
    tier: 1,
    binding: "inline",
    node: "node",
    synopsis: "olean-imports.mjs --audit <olean tree>",
    summary: "The `import all` edges of an olean tree, by importing library: the static half of the slim-bake audit (`import all M` needs M.olean.private, which a slim tree lacks). As a module it exports oleanImportEntries / oleanImports.",
    flags: [
      { name: "audit", value: "<olean tree>", doc: "the tree to audit (every *.olean under it)" },
    ],
    required: [["audit"]],
    env: [],
    exits: {
      0: "audited",
      1: "audited, but some .olean files had no readable import table",
      2: "usage: --audit missing or the tree does not exist",
    },
    markers: [
      { id: "summary", stream: "stdout", prefix: true, template: ["import-all audit of ${tree}: ${files.length} modules, ${edges.length} \\`import all\\` edge(s)"],
        regex: /^import-all audit of (.+): (\d+) modules, (\d+) `import all` edge\(s\)(, (\d+) unreadable \.olean file\(s\))?$/,
        example: "import-all audit of /repo/work/lib-tree: 4354 modules, 212 `import all` edge(s)" },
      { id: "outside", stream: "stdout", template: ["  outside Init/Std/Lean/Lake: ${outside.length}"],
        regex: /^ {2}outside Init\/Std\/Lean\/Lake: (\d+)$/, example: "  outside Init/Std/Lean/Lake: 0" },
      { id: "edge", stream: "stdout", template: ["    ${importer} → import all ${imported}"],
        regex: /^ {4}(\S+) → import all (\S+)$/, example: "    Lib.A → import all Init.Core" },
    ],
  },

  "chunk-runtime": {
    script: "pipeline/toolchain/chunk-runtime.mjs",
    npm: null,
    tier: 2,
    binding: "inline",
    node: "node",
    synopsis: "chunk-runtime.mjs --bin <dir> [--lean-version v] [--revision sha] [--upstream-base sha] [--out dir]",
    summary: "Chunk a built lean.js/lean.wasm pair into the verified runtime layout (16 MiB sha256-addressed parts + runtime-manifest.json and runtime-manifest.<buildId>.json) in a staging dir; additive, never inside public/.",
    flags: [
      { name: "bin", value: "<dir>", doc: "dir holding lean.js + lean.wasm" },
      { name: "lean-version", value: "<x.y.z>", default: "4.33.0-pre, with a WARNING on stderr", doc: "the manifest's leanVersion; promote pairs packs against it" },
      { name: "revision", value: "<string>", default: "qed64-wasm64@<HEAD of pipeline/toolchain/work/lean4> (base <upstream-base>), else unspecified", doc: "the manifest's sourceRevision" },
      { name: "upstream-base", value: "<sha|tag>", default: "5732b84", doc: "the upstream base named in the default --revision" },
      { name: "out", value: "<dir>", default: "work/staging/<buildId>/runtime under the repo root", doc: "staging dir; refused inside public/" },
    ],
    required: [["bin"]],
    env: [],
    exits: {
      0: "chunked",
      1: "a crash (lean.js or lean.wasm unreadable under --bin)",
      2: "usage, or --out inside public/",
    },
    markers: [
      { id: "file", stream: "stdout", template: ["${name}: ${bytes.length} bytes, ${chunks.length} chunks, sha256:${whole.slice(0, 16)}…"],
        regex: /^(lean\.js|lean\.wasm): (\d+) bytes, (\d+) chunks, sha256:([0-9a-f]{16})…$/, example: "lean.wasm: 109869533 bytes, 7 chunks, sha256:36a96239e08fd2e0…" },
      { id: "done", stream: "stdout", template: ["runtime ${buildId} → ${outDir}"], regex: /^runtime (wasm64-[0-9a-f]{16}) → (.+)$/,
        example: "runtime wasm64-36a96239e08fd2e0 → /repo/work/staging/wasm64-36a96239e08fd2e0/runtime" },
      { id: "no-version", stream: "stderr", prefix: true, template: ["chunk-runtime: WARNING — no --lean-version given; the manifest will say Lean ${DEFAULT_LEAN_VERSION}."],
        regex: /^chunk-runtime: WARNING — no --lean-version given/, example: "chunk-runtime: WARNING — no --lean-version given; the manifest will say Lean 4.33.0-pre." },
      { id: "refuse-public", stream: "stderr", source: "pipeline/toolchain/artifact-paths.mjs", prefix: true,
        template: ["${who}: refusing --out ${target}: it resolves inside public/. "],
        regex: /^(bake-snapshot|chunk-runtime): refusing --out (.+): it resolves inside public\/\. /,
        example: "chunk-runtime: refusing --out /repo/public/runtime: it resolves inside public/. Producers stage under work/staging/<buildId>/; use `npm run promote:staging` to publish (HARDENING #32)." },
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
    synopsis: "unpack.mjs --manifest <file> --out <dir>",
    summary: "Reconstruct an on-disk olean tree from a profile's verified transport parts (each part and the raw pack sha256-checked), for the Node-side bakes.",
    flags: [
      { name: "manifest", value: "<file>", doc: "a profile manifest; its parts are read from the same directory by basename" },
      { name: "out", value: "<dir>", doc: "the tree to write (files are added or overwritten, never deleted)" },
    ],
    required: [["manifest"], ["out"]],
    env: [],
    exits: {
      0: "unpacked",
      1: "a part, the raw pack or a path failed verification (or the manifest is unreadable)",
      2: "usage",
    },
    markers: [
      { id: "done", stream: "stdout", template: ["${release}: unpacked ${files} files, ${(bytes / 1e9).toFixed(2)} GB → ${outDir}"],
        regex: /^(\S+): unpacked (\d+) files, (\d+\.\d\d) GB → (.+)$/, example: "lean-core-4.34.0-wasm64-36a96239e08fd2e0: unpacked 3245 files, 0.39 GB → /repo/work/lib-tree" },
      { id: "fail", stream: "stderr", template: ["FAIL: transport part ${part.url} failed verification"], regex: /^FAIL: (.*)$/,
        example: "FAIL: transport part /profiles/lean-core.pack.gzip.0123456789abcdef0123.part-000 failed verification" },
    ],
  },
};

/** Tier 3 — diagnostic tools with no stability promise (no SPEC, no prelude). */
export const DIAGNOSTIC = [
  "pipeline/snapshot/thread-storm-probe.mjs",
  "pipeline/snapshot/fileworker-exit-probe.mjs",
  "pipeline/snapshot/header-switch-probe.mjs",
  "pipeline/snapshot/resident-probe.mjs",
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
 * treated it), and `args` normalized to the two-token form (--flag value).
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
    let value = true;
    if (arity === 1) {
      value = m[2] !== undefined ? m[2].slice(1) : i + 1 < args.length ? args[(i += 1)] : undefined;
      if (value === "--help" || value === "-h") help = true;
      normalized.push(`--${name}`, ...(value === undefined ? [] : [value]));
      if (!value) warnings.push(`flag --${name} has no value; ignored`);
    } else normalized.push(token);
    if (!Object.hasOwn(values, name)) values[name] = value ?? "";
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
    "// --flag=value is rewritten to the two-token form this script reads (docs/CLI-CONTRACT.md).",
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
