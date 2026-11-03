# The pipeline CLI contract

The pipeline's command-line tools are an interface: three downstream projects
run them and parse what they print. How each one gets them (checked
2026-11-01 in their repositories):

- **lean4game** (branch `wasm64-port`) installs QED64 as a git dependency
  pinned by a full SHA in `client/package.json`
  (`"qed64": "github:FawadHa1der/QED64#<sha>"`; every Tier 1/2 tool is in the
  package's `files`, docs/EMBEDDING.md §6). Its from-source lane
  (`wasm/build-from-source.sh`) runs bake-snapshot and snapshot-probe from
  `node_modules/qed64` (or `$QED64_DIR`); its olean trees and runtime come
  from the lean4-wasm64 package. Its file-by-file copy
  (`scripts/sync-qed64.sh`) was retired in its 00bf77e (2026-10-05).
- **The proof sheets** (the Waterproof course site, branch `website-v4.35`)
  install QED64 the same way (`website/site/package.json`, with the same
  commit in `website/sources.json`) and run bake-snapshot with its default
  runner from that install or a checkout (`website/build.sh`). Their bake
  fingerprint hashes the bytes of `pipeline/snapshot/node-runner.mjs`
  (`website/scripts/fingerprint.mjs`), so an edit there rebakes every entry
  at their next re-pin.
- **The widgets showcase** runs them in place from the QED64 sources it pins:
  the git submodule `deps/qed64` at the active pin's commit, or that pin's
  worktree (`scripts/lib/qed64-src.mjs`; nothing is copied). It judges bakes
  and probes by their log lines.

This document states what those consumers may rely on.

The contract is also data: `pipeline/snapshot/cli.mjs` holds one SPEC per tool
(flags, defaults, required flags, environment, exit codes, stable output
markers as regexes). Every `--help` text is generated from it, and
`tests/unit/cli-contract.test.ts` checks it against the real scripts.

```sh
node pipeline/snapshot/cli.mjs --print-specs     # the whole contract as JSON
node pipeline/snapshot/cli.mjs --help <tool>     # one tool's help text
node pipeline/snapshot/cli.mjs --check-preludes  # exit 1 when an inline prelude drifted from SPECS
node pipeline/snapshot/cli.mjs --write-preludes  # regenerate the inline preludes after editing SPECS
```

## Tiers

| Tier | Promise |
|---|---|
| **1: downstream-stable** | Flags, defaults, exit codes and the stable markers below change only under the stability policy (a deprecation window of one downstream re-pin cycle). |
| **2: internal-stable** | Same rules, but the consumers are QED64's own scripts and, through bake-snapshot, the consumers' bakes (every one runs node-runner; the proof sheets also hash its bytes). A breaking change still needs a changelog row, and a re-pin of every consumer that runs it ("Stability policy"). |
| **3: diagnostic** | No promise. They may change or disappear without notice. |

| Tool | Script | npm alias | Tier | `--help` wiring |
|---|---|---|---|---|
| [bake-snapshot](#bake-snapshot) | `pipeline/snapshot/bake-snapshot.mjs` | `bake:snapshot` | 1 | inline prelude |
| [snapshot-probe](#snapshot-probe) | `pipeline/snapshot/snapshot-probe.mjs` | — | 1 | inline prelude |
| [supervised-run](#supervised-run) | `pipeline/snapshot/supervised-run.mjs` | — | 1 | imports `cli.mjs` |
| [preflight](#preflight) | `pipeline/release/preflight.mjs` | — | 1 | imports `cli.mjs` |
| [fetch-artifacts](#fetch-artifacts) | `pipeline/release/fetch-artifacts.mjs` | `fetch:artifacts` | 1 | imports `cli.mjs` |
| [olean-imports](#olean-imports---audit----entries) | `pipeline/artifacts/olean-imports.mjs` | — | 1 | inline prelude (inside the main-module check) |
| [resident-probe](#resident-probe) | `pipeline/snapshot/resident-probe.mjs` | — | 1, its surface below; the rest is tier 3 | imports `cli.mjs`, for `--help` only |
| [node-runner](#node-runner) | `pipeline/snapshot/node-runner.mjs` | `runner` | 2 | inline prelude |
| [persistent-probe](#persistent-probe) | `pipeline/snapshot/persistent-probe.mjs` | — | 2 | inline prelude |
| [pack](#pack) | `pipeline/artifacts/pack.mjs` (leaving for the fork: `lean4-wasm64 pack`, later) | `pack` | 2 | inline prelude |

Tier 3 tools: `pipeline/snapshot/{thread-storm-probe,fileworker-exit-probe}.mjs`,
resident-probe outside its surface below (`--help` labels those flags; the
compiler battery's FileWorker lane, `--transport fileworker`, R4, stays opt-in
and tier 3), and `pipeline/release/release-manifest.mjs` (shipped since plan
B2c), which writes `qed64.release/v1`, whose stable field paths are a
contract of their own (docs/RELEASE-BUNDLE.md, "Stable field paths"); its
flags are tier 3.
(`pipeline/release/write-bundle.mjs`, which wrote the release bundle, was
deleted on 2026-11-01: see the changelog. `header-switch-probe.mjs`, an edited copy of
resident-probe, was folded into it on 2026-10-05 as `--snapshots <a,b>`,
`--mathlib` and `--act4 [--act4-ms <ms>]`. The forwards `inspect.mjs` and
`gate.mjs` and the `gen-exports.py` stub were removed in contract 4:
[the forwards](#lean4-wasm64-the-forwards) says what to run instead.)

**resident-probe's surface is tier 1** (architecture review R4 item 4,
2026-11-02: the gate's surface, tier 2 since kernel review R10, accepted
2026-11-01, `--settle-ms`, and what the proof sheets' call adds: `--lib`,
`--lean-option` and any `--snapshots` list). The lean4-wasm64 gate (block 7, in
the fork's tools from the v4.36 cut on) runs `resident-probe.mjs` from QED64's
checkout when an adoption passes it in (`--resident-probe`) and parses what
it prints. The proof sheets plan to adopt it: `website/build.sh`'s browser
check passes `--lib`, `--snapshots init,<entry>` and its options through
`--opt`, which map to `--lean-option`. They have not adopted it yet. A change
to any of the following is told to the kernel session before it lands:

- the flags `--artifact <dir>`, `--snap-dir <dir>`, `--budget-ms <ms>`,
  `--mathlib`, `--snapshots init`, and the `--snapshots` defaults (`init`;
  `init,mathlib` with `--mathlib` or `--probe-file`);
- `--probe-file <file>` with `--dump-messages`, and `--settle-ms <ms>` (the
  gate passes none). The gate finds out whether
  the probe has the file mode by the text `--probe-file` in the script;
- on stdout, with `--dump-messages`, one line per final diagnostic,
  `{"caption":"","severity":<name>,"pos":{"line":<n>,"column":<n>},"endPos":{…},"data":<message>}`
  (`caption` first; severity `error`, `warning`, `information` or `hint`;
  lines 1-based, columns LSP's UTF-16; `endPos` is the LSP `range` end,
  which Lean shortens for a multi-line span, and `isSilent` diagnostics are
  kept), then one
  `compile: tag=0 elapsed=<ms>ms errors=<n>` line;
- one `RESIDENT PROBE PASS <json>` or `RESIDENT PROBE FAIL <json>` line,
  whose JSON has at least `why`, `diagnostics`, `frames`,
  `nonFrameStdoutBytes`, `wallMs` and `argv`; exit 0 for PASS, 1 for FAIL,
  2 for a refusal before the run (no verdict line; [its section](#resident-probe)
  lists what is refused, and a missing `.snap` is not); a crash of the probe
  itself (an uncaught throw) also exits 1, with no verdict line;
- the Init run (neither `--mathlib` nor `--probe-file`) writes only LSP
  frames on the runtime's stdout: the gate requires `nonFrameStdoutBytes` 0.

`--lib <tree>`, `--lean-option <name=value>` (repeatable) and any `--snapshots`
list are tier 1 for the proof sheets' planned call; the gate passes none of them
(of the lists, only `init`). [The tool's section](#resident-probe) words what each
really does, including what it does not refuse: an absent `--lib` tree is an
exit-1 crash with no verdict line.

`[WASM LSP] header <mode>: key=#[…]` is information only, with no promise:
the runtime prints it (stderr, which resident-probe echoes in its log), and
the gate shows it when it is there. As for every tool under the path rule,
`QED64_LEAN_ARTIFACT` and the rule's two stderr lines (`deprecated-default`,
`no-path`) are tier 1 too. The rest of resident-probe (its other flags, its
log lines, the verdict's other keys) stays tier 3.
`tests/unit/tool-paths.test.ts` ("resident-probe: the kernel gate's
surface") pins the surface as the gate runs it, with a fake glue and no
wasm, and adds a `--snapshots` list naming a missing `.snap`. The same file pins
`--lean-option`'s refusals, and `tests/integration/lean-options.test.ts` runs
that flag on real wasm. What Lean does with a wrong type or an unknown name
(that flag's row) is Lean's own, seen on real wasm on Lean 4.35, and no test
pins it. `--lib` has no unit pin (the fake glue mounts nothing); the compiler
battery's FileWorker lane passes it.

**Ownership (architecture review D4, option a; 2026-11-01).**

- QED64 owns the bake and the snapshot index: `bake-snapshot`,
  `snapshot-probe` and the index's writer rules
  ([SNAPSHOT-INDEX.md](SNAPSHOT-INDEX.md)). The fork's package drops its
  copies (`bake-snapshot.mjs`, `snapshot-index.mjs` and `.d.mts`,
  `snapshot-probe.mjs`) with its next runtime or import release. Its gate
  makes its own small raw `.snap` with its own `node-runner` (no index, no
  gzip, nothing of QED64's), and runs QED64's `resident-probe.mjs` (its
  surface tier 1, above) only when QED64's `adopt-release.sh` passes it in
  (otherwise it notes "skipped").
- QED64 owns `olean-imports` (tier 1; the showcase's G5 and `pack.mjs` run
  it). The package drops its copy once `adopt-release.sh`'s
  `--rebuild-umbrella` audit runs QED64's own script, at the next Lean import.
- `node-runner` and `persistent-probe` stay one copy per repository, each
  owned by its repository. QED64's are the bake's runner (the proof sheets'
  bake fingerprint keys on its bytes) and the integration lane's
  persistent-path probe; the package's are its gate's.
- Neither repository imports the other's (ARCHITECTURE-PLAN-QED64.md §8,
  decision 10): behaviour is ported, never imported.

## Conventions

### Runtime

- **Node ≥ 24.** Memory64 is on by default from Node 24. The pipeline is
  exercised on Node 26.
- **`node --stack-size=8192`** for any tool that boots the wasm runtime in its
  own process: node-runner, snapshot-probe and persistent-probe. Started
  without any `--stack-size`, each of the three **re-execs itself** with
  `--stack-size=8192` before it prints anything (`ensureStackSize` in
  `pipeline/toolchain/artifact-paths.mjs`, through `process.execve`): the
  process image is replaced in place, so the PID, stdin/stdout/stderr and the
  exit code are the tool's own, and a supervisor that pipes the tool and
  SIGKILLs its PID (supervised-run, bake-snapshot, a gate's timeout) still
  sees and reaps one process; nothing is orphaned (`tests/unit/tool-paths.test.ts`
  pins the PID, the stdio, the exit code and the SIGKILL). An explicit
  `--stack-size` of any size is respected. Where `process.execve` is missing
  (Windows) or the tool was forked with an IPC channel, one stderr WARNING says
  to run it as `node --stack-size=8192 …` and the tool continues as before.
  bake-snapshot and supervised-run start their runner with the flag
  themselves, so a plain `node` is enough for them; the re-exec is for direct
  runs, `npm run runner`, and any harness that spawns node-runner or
  persistent-probe without it. resident-probe boots wasm too but does not
  re-exec: its callers pass the flag (the gate, the compiler battery).
- Since toolchain patches 0020 and 0031, the one-shot Lean CLI does its work
  and then **never exits** (HARDENING #47). Whatever runs node-runner judges
  the job by its output and stops the process: bake-snapshot once its `.snap`
  is complete (two polls), supervised-run once its target is stable with the
  runner quiet; the package's gate uses a timeout.

### Argument grammar

There is one implementation of the grammar, `cliContract` in
`pipeline/snapshot/cli.mjs`. resident-probe takes only `--help`/`-h` from it
("How the tools bind").

- `--flag value` and `--flag=value` are the same thing. A value flag takes the
  next token verbatim, even when that token starts with `-`.
- A boolean flag takes no value. `--flag=x` on a boolean flag is treated as an
  unknown flag.
- **The first occurrence of a repeated flag wins.** This is the legacy
  `process.argv.indexOf` behaviour. Each later occurrence of a value flag is
  ignored, with a WARNING, and dropped from the normalized arguments. That
  holds for node-runner too, whose own parser keeps the last value it sees.
- **An empty value counts as absent.** `--out ""` or `--out=` means the
  default applies, with a WARNING. (Every legacy `arg()` already treated a
  falsy value that way.)
- **`--help` / `-h`** anywhere among a tool's own arguments prints the help
  text on stdout and exits 0. "Anywhere" includes a flag's value position. The
  help check runs **before any side effect**: no file is written, unlinked or
  created, nothing is spawned or fetched, and no wasm boots.
- **Unknown flags** produce a WARNING and the tool keeps running. So does a
  stray positional argument:

  ```
  <tool>: WARNING — unknown flag --x ignored
  <tool>: WARNING — unexpected argument x ignored
  <tool>: WARNING — flag --x has no value; ignored
  <tool>: WARNING — flag --x repeated; the first value wins
  ```

  These lines go to stderr. Unknown flags are not fatal yet (see "Open
  decisions"). The format follows the house style of the tools' other
  `<tool>: WARNING — …` lines.
- **A missing required flag** prints all WARNINGs, then exactly one line
  `usage: <synopsis>` on stderr, and exits 2. A `required` group lists
  alternatives: snapshot-probe needs one of `--snap` / `--fresh-import` and
  one of `--probe-file` / `--probe`. Where a script kept its own legacy usage
  check, that check prints the same bytes.
- **Passthrough.** supervised-run passes everything after the first `--`
  verbatim to its runner, and that tail is required. node-runner passes
  everything after `--` to Lean. It also passes the tail starting at the first
  token that is not a runner flag, so an unknown flag in runner position
  belongs to Lean and gets no warning. `--help` is the runner's only before
  that point. `node-runner -- --help` asks Lean, and that process then never
  exits.

### How the tools bind to the contract

`cli.mjs` lives in `pipeline/snapshot/` because the showcase once vendored
that directory whole. The tools SPECS marks `binding: "inline"` carry a
**generated inline prelude** between `// <cli-contract>` and
`// </cli-contract>`: the verbatim source of `cliContract`, the tool's
compact spec and its help text. The prelude's reason is gone. It existed
because a downstream copied the scripts one file at a time (lean4game's
`scripts/sync-qed64.sh`, retired 2026-10-05); every consumer now runs them in
place. The preludes become imports of `cli.mjs` with the next runtime
adoption, batched because an edit of `node-runner.mjs` rebakes the proof
sheets.

The prelude runs right after the imports (in node-runner, snapshot-probe and
persistent-probe right after `ensureStackSize`, which prints nothing; see
"Runtime"). For olean-imports it runs inside the main-module check, so
importing the module stays side-effect-free.

The path rule and the stack-size re-exec live in
`pipeline/toolchain/artifact-paths.mjs` (Node built-ins only), which every
tool under the path rule imports. The prelude rewrites `--flag=value` into
`process.argv` as the two-token form, and drops the later occurrences of a
repeated value flag, so the script's own legacy parser reads it unchanged and
sees only the first value.

Only supervised-run, preflight and fetch-artifacts (and resident-probe, below)
import `parseCli` at run time. No downstream copies any of them without `cli.mjs`: the showcase runs
them from its submodule beside `cli.mjs`, and preflight and fetch-artifacts
run in place from the QED64 checkout or the installed package (`cli.mjs`,
`supervised-run.mjs`, `preflight.mjs` and `fetch-artifacts.mjs` are in `files`
and in closure.json's `pipeline` list, with every Tier 1/2 tool;
`tests/unit/package-contract.test.ts` checks it).

resident-probe also imports `parseCli`, for `--help`/`-h` only, with the
grammar's WARNINGs off, and reads its flags with its own parser, as before:
`--flag=value` is not read, an unknown flag and a repeated value flag are
silent (the first value wins), and `--lean-option` repeats. Promoting it
(R4) changed none of that. It runs from a QED64 checkout or the package, never
without `cli.mjs` beside it.

After you edit SPECS, run `node pipeline/snapshot/cli.mjs --write-preludes`.
The unit test fails on drift.

### Path resolution

Since contract 2 (2026-10-06) every path a tool reads or writes comes from
**one rule**, implemented once (`toolPath` / `resolveToolPath` in
`pipeline/toolchain/artifact-paths.mjs`: Node built-ins only, no relative
imports, in `files` and closure.json `pipeline`):

1. **the explicit flag** (`--artifact`, `--lib`, `--work`, `--out`, `--snap`,
   `--snap-dir`, as each tool has);
2. else **its environment variable** (the table below). An empty value counts
   as unset. A relative value resolves against the cwd;
3. else **the old repo-relative default, deprecated**: kept for one downstream
   re-pin cycle, and used only when it holds (an input: the directory or file
   exists, an artifact has `bin/lean.js`, bake-snapshot's `bin/lean.wasm`; an
   output dir always holds, the tool creates it). It prints **exactly one**
   stderr line per default used, in the policy's form:

   ```
   <tool>: WARNING — the default --<flag> <where> (<absolute path>) is deprecated; use --<flag> <placeholder> or set <VARIABLE> (docs/CLI-CONTRACT.md)
   ```

4. else **exit 2, before any side effect**, with one line naming the flag and
   the variable, then the usage line:

   ```
   <tool>: no --<flag> given and <VARIABLE> is unset; the deprecated default <path> has no bin/lean.js — pass --<flag> <placeholder> or set <VARIABLE>
   usage: <synopsis>
   ```

Both lines are markers of each tool that uses the rule (`deprecated-default`,
`no-path`). An explicit flag or variable is used as given: a missing path there
meets the tool's own check, as before (node-runner's `no-lean-js`,
bake-snapshot's `no-artifact`, persistent-probe's exit 1). There is no sibling
checkout fallback any more: node-runner and persistent-probe used to fall back
to another project's stage1 build two directories above the repo, and that
step is deleted outright.

Relative flag values resolve against the **current working directory**, with
these exceptions, which resolve against the **repo root** (the directory two
levels above the script): bake-snapshot's `--work` and `--out`. The
deprecated defaults live under the repo root too.
In an installed package "the repo root" is the package root inside
`node_modules`, which is why the defaults go.

The next cycle removes step 3: a tool with neither the flag nor the variable
then always takes step 4. Every consumer already passes its paths
explicitly: lean4game's and the proof sheets' bakes pass `--work` and
`--out`, and the showcase passes absolute paths. Only QED64's own lanes still
use the defaults (the compiler battery, `resident-gate.sh`, the integration
tests); they move to the variables first. The removal lands with the next
runtime adoption, together with the prelude change.

### Exit codes

| Code | Class |
|---|---|
| 0 | Success: the job did what it was asked. |
| 1 | The job ran and failed: a verification, a probe or a Lean failure line. Also a crash (an unhandled error). |
| 2 | Refused before any work. Either a usage problem (a missing required flag) or a precondition: an input is absent, `--out` is inside `public/`, or the index is unpaired. A class-2 exit leaves the filesystem as it found it. |
| 3 | Infrastructure refusal: the environment cannot run the lane (preflight). |

**Legacy overload.** In node-runner, snapshot-probe and persistent-probe,
`3` also means *the wasm runtime aborted* (`onAbort`, logged as
`ABORT: <what>` on stderr). Consumers distinguish the two by tool. See "Open
decisions".

### Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `QED64_LEAN_ARTIFACT` | bake-snapshot, node-runner, snapshot-probe, persistent-probe, resident-probe (and the compiler battery, the integration tests) | The stage1 artifact dir when `--artifact` is absent. An empty value counts as unset everywhere (before contract 2 bake-snapshot counted it as set, meaning the cwd). |
| `QED64_WORK` | bake-snapshot, node-runner | The dir mounted at `/work` when `--work` is absent: bake-snapshot's raw `<name>.snap` and `probe.lean`, node-runner's Lean cwd. |
| `QED64_STAGING` | bake-snapshot | A staging root when `--out` is absent: `--out` is `<QED64_STAGING>/<buildId>/snapshots`. `public/` is still refused. |
| `QED64_LIB_TREE` | snapshot-probe (and the compiler battery) | The olean tree mounted at `/lib/lean` when `--lib` is absent: the tree the probed snapshot was baked from. |
| `LEAN_COMPACTOR_RESERVE` | node-runner (forwarded into the wasm env) | Bytes the compactor reserves up front for a whole-environment save (patch 0011). bake-snapshot **sets** it for its runner from `--reserve` and overrides any inherited value. |
| `QED64_ALLOW_LEGACY_IMPORTS` | node-runner (forwarded as `1` when non-empty) | Lets the exported-level env cache load legacy non-module packages (patch 0030). The documented form is `bake-snapshot --allow-legacy-imports`, which sets it to `1` for the runner; an inherited value is its equivalent and stays accepted (the showcase's bake sets the variable; the proof sheets pass the flag). |
| `QED64_PROFILE_INIT` | node-runner, snapshot-probe (forwarded) | Profiles the `[init]` replay. |
| `QED64_RUNNER` | bake-snapshot | The runner script when `--runner` is absent. Unset: QED64's own `pipeline/snapshot/node-runner.mjs` (the default, not deprecated). Resolves against the cwd. |

The QED64 lanes outside SPECS use the same rule with their own variables:

| Variable | Read by | Meaning |
|---|---|---|
| `QED64_MATHLIB_SNAP` | `tests/adversarial/compiler-battery.mjs` (`--snap`) | The raw Mathlib `.snap` under test (deprecated default `work/snapshot/mathlib.snap`). With `QED64_LEAN_ARTIFACT` and `QED64_LIB_TREE` (deprecated defaults `pipeline/toolchain/work/build/stage1`, `work/lib-tree-slim`) it is the battery's pairing; `run.mjs` forwards `--snap/--artifact/--lib`. |
| `QED64_SNAP_DIR` | `pipeline/snapshot/resident-probe.mjs` (`--snap-dir`; the flag is tier 1, the variable is tier 3), `tests/integration/lean-options.test.ts` | The dir holding `<name>.snap` (deprecated default `work/snapshot`). lean-options.test.ts passes it as `--snap-dir`; unset, it passes `QED64_INIT_SNAP`'s directory, and takes the deprecated default only when both are unset. |
| `QED64_INIT_SNAP` | `tests/integration/fileworker-exit.test.ts`, `tests/integration/lean-options.test.ts` (its directory, when `QED64_SNAP_DIR` is unset) | The init `.snap` (deprecated default `work/snapshot/init.snap`). The integration tests skip, naming the variable, when it or the artifact is absent. |

Other `QED64_*` variables belong to shell lanes, not to these tools:
`QED64_ADOPT_IGNORE_DISK`, `QED64_PUBLIC_DIR` (the served tree it compares
a release with) and `QED64_BASE_TREE` (the served base tree a reused
`--umbrella` must match) are documented in `pipeline/release/adopt-release.sh`, and
`QED64_SLOW` in docs/TESTING.md. adopt-release.sh also reads
`LEAN4_WASM64_DIR`, the lean4-wasm64 package dir when `--tools` is absent
(docs/REBUILD.md §3); since contract 4 no tool of this contract reads it.
(`QED64_LEAN_VERSION`, `QED64_ARTIFACT`,
`QED64_SNAP_WORK` and the rest left with `bump-chain.sh` in plan B2a.)

### Output streams and reserved substrings

Stable markers are matched **per line**. A marker's regex applies to one line
of the stated stream. Lean's own output passes through node-runner, and
through bake-snapshot and supervised-run (which pipe their runner), unchanged
and interleaved.

Downstream log judges grep whole logs for failure text: supervised-run's own
`FAILURE` classifier, bake-snapshot's own classifier (D6), the showcase's
`judge-bake.mjs` (J1) and `run-e2.sh`.
So **new output must not contain** any of these substrings (case-sensitive):

| Substring | Where |
|---|---|
| `: error` | anywhere |
| `error:` | at the start of a line |
| `: warning:` | anywhere |
| `warning:` | at the start of a line |
| `PANIC` | anywhere |
| `ABORT:` | anywhere |
| `uncaught` | anywhere |
| `RuntimeError` | anywhere |
| `object compactor:` | anywhere |

The rule covers help text and WARNINGs (`RESERVED_OUTPUT`, `reservedHit` in
`cli.mjs`; the unit test checks every help text). It does not cover output
that predates the contract and means exactly this, such as node-runner's
`error: … not found` and `ABORT:`. It does not cover the registry dump
`--print-specs` either. A WARNING echoes the flag the user typed verbatim.

## The tools

Each section uses the same template: tier · synopsis · flags · environment ·
inputs · outputs · stable markers · exit codes · side effects · consumers. The
regexes are exactly the ones in SPECS (`--print-specs` prints them as strings).

### bake-snapshot

**Tier 1.** `node pipeline/snapshot/bake-snapshot.mjs …` or `npm run bake:snapshot -- …`

```
usage: bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--entry-fields <json object>] [--allow-legacy-imports] [--runner <script>] [--stable-ms <ms>] [--quiet-ms <ms>] [--give-up-ms <ms>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--name <name>` | `init` | Snapshot name: `<work>/<name>.snap`, `<name>.<digest16>.snapz` and the index entry. It must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` (a letter or digit, then letters, digits, `.`, `_` or `-`); any other refuses (`refuse-name`, exit 2) before any side effect, since 2026-11-01. |
| `--probe <lean source>` | `#check (2 + 2 : Nat)` | The baked file. Its import lines become the entry's `imports`, which is the env-cache key. |
| `--artifact <dir>` | `$QED64_LEAN_ARTIFACT`, else (deprecated) `pipeline/toolchain/work/build/stage1` under the repo root when it has `bin/lean.wasm`, else exit 2 | The stage1 dir whose `bin/lean.wasm` bakes and is stamped as `runtime`. It is always passed to the runner. Resolves against the cwd. |
| `--lib <olean tree>` | the runner's `<artifact>/lib/lean` | The tree mounted at `/lib/lean`. Passed to the runner as given, so it resolves against the cwd. An explicit `--lib` that is not a directory refuses (`no-lib`, exit 2) before `<work>` is touched and the paired `.snap` unlinked, since 2026-11-01 (before, the runner failed on it after). |
| `--reserve <bytes>` | `3758096384` (3.5 GiB) | `LEAN_COMPACTOR_RESERVE` for the runner. |
| `--work <dir>` | `$QED64_WORK`, else (deprecated) `work/snapshot` under the repo root | Holds the raw `.snap` and `probe.lean`. **The deprecated default is the PAIRED set** the probes and the compiler battery load: a bake for any other runtime must pass `--work`. Resolves against the repo root. One bake per `--work` at a time: `<work>/.bake.lock` holds the bake's pid and then its runner's, and is never taken over (side effect 3; since 2026-11-01). |
| `--out <dir>` | `<$QED64_STAGING>/<buildId>/snapshots`, else (deprecated) `work/staging/<buildId>/snapshots` under the repo root | Holds the staged `.snapz`, `index.json` and its per-build copy `index.<buildId>.json`. Refused inside `public/`. Resolves against the repo root. |
| `--roots <A,B,…>` | none | Module roots the entry serves (docs/EMBEDDING.md §8): the page boots and widens to it for a header naming one. Absent: the legacy rule (an entry named `mathlib` serves the umbrella roots). |
| `--label <text>` | none | The entry's human name for the page's pill and boot card. |
| `--initial-bytes <bytes>` | none | The initial Memory64 commit when the entry is loaded (else 2 GiB with any non-base entry). |
| `--entry-fields <json object>` | none | More entry keys, written after the core keys and `roots`/`label`/`initialBytes`, in the object's order; the page ignores them ([SNAPSHOT-INDEX.md](SNAPSHOT-INDEX.md), "Rules"). Refused (exit 2, before any side effect): text that is not a JSON object, a core key (`name`, `url`, `digest`, `bytes`, `transfer`, `imports`, `runtime`), `roots`, `label` or `initialBytes` (their flags validate them) and the reserved `raw`, `lib` and `bakedBy`. Since 2026-11-01. |
| `--allow-legacy-imports` | off | Sets `QED64_ALLOW_LEGACY_IMPORTS=1` for the runner (patch 0030: the env cache loads legacy non-module packages, the lean4game games). An inherited `QED64_ALLOW_LEGACY_IMPORTS` does the same and stays accepted. |
| `--runner <script>` | `$QED64_RUNNER`, else QED64's own `pipeline/snapshot/node-runner.mjs` (not deprecated, no WARNING) | The runner script (contract 3, additive). It is spawned as `<this node> --stack-size=8192 <script> --work … --artifact … [--lib …] -- …`, so it must take node-runner's flags. Resolves against the cwd; a script that does not exist refuses (`no-runner`, exit 2) before `<work>` is created. The default stays QED64's runner: a bake through the package's `node-runner.mjs` (which pins `LEAN_PATH=/lib/lean`, mirrors only `bin/` and shadows `<artifact>/lib/lean` with `--lib`) was shown byte-identical on Lean 4.34 (2026-10-08), not yet on 4.35. |
| `--stable-ms <ms>` | `5000` | The poll interval. The bake is done once `<work>/<name>.snap` has the same nonzero size at two polls this far apart; the runner is then stopped (side effect 6). Since 2026-11-01 (architecture review R5a). |
| `--quiet-ms <ms>` | `120000` | After a failure line in the runner's output (the classifier below): this long without output, with no `<name>.snap` and no save in progress, ends the bake (`failed-quiet`, exit 1). Since 2026-11-01. |
| `--give-up-ms <ms>` | `21600000` (6 h) | No complete `<name>.snap` by then ends the bake (`gave-up`, exit 1). A backstop only. Since 2026-11-01. |

- **Environment:** `QED64_LEAN_ARTIFACT`, `QED64_WORK`, `QED64_STAGING` (the
  path rule), `QED64_RUNNER`. The runner gets exactly `PATH`, `HOME`,
  `TMPDIR`, `LEAN_COMPACTOR_RESERVE` (from `--reserve`),
  `QED64_ALLOW_LEGACY_IMPORTS=1` (with `--allow-legacy-imports` or an
  inherited non-empty one) and `QED64_PROFILE_INIT` (when non-empty): nothing
  else. A host `LEAN_PATH` would replace `--lib` inside the runtime
  (lean_main's prologue copies it after preRun). Since 2026-11-01 (the
  kernel copy's rule, architecture review D4 a); before, the runner inherited
  the bake's whole environment.
- **Failure classifier.** A runner output line (either stream, judged per
  line) matching
  `/^(?:\S*\/)?probe\.lean:\d+:\d+: error[:( ]|PANIC|ABORT:|RuntimeError|object compactor:|uncaught exception/`
  is a failure line: supervised-run's `: error` rule scoped to probe.lean's
  own error diagnostics, plus the runtime's failure lines (a failed region
  save surfaces as `uncaught exception` or `object compactor:`). Warnings and
  other files' diagnostics never count. Its kind is the first that matches, in
  this order: `lean-error` (the probe.lean alternative), `compactor`, `abort`,
  `panic`, `runtime-trap`, `exception`. Since 2026-11-01 it decides the
  failure guard (side effect 6) and D6's notice (next bullet).
- **Lean failure lines (D6, decided 2026-11-01).**
  - Now (contract 4, the notice): when the run printed a failure line and its
    `.snap` is complete (every probe.lean message is printed before the
    save), the bake prints the `notice` WARNING and one `verdict <json>` line
    on stderr before compressing, then compresses, indexes and exits 0 as
    before. The verdict is
    `{"verdict":"failed","kind":…,"stream":…,"line":…,"name":…,"bytes":…}`:
    the first failure line's kind, its stream and its line number in that
    stream, the snapshot name and the raw `.snap` size.
  - After every consumer (lean4game, the proof sheets, the showcase) has
    re-pinned past the notice, at the next runtime release (contract 5, the
    flip): a failure line and then `--quiet-ms` of quiet stop the runner; the
    bake prints the verdict, exits **1**, compresses and indexes nothing, and
    keeps the raw `.snap`. Exit 1, not a new code: 3 stays the infrastructure
    refusal ("Exit codes"), and the `verdict` line tells a Lean failure from a
    runner crash (both are class 1).
  - Only probe.lean's own error diagnostics and the runtime's failure lines
    count; warnings and other files' diagnostics never do.
  - Read the `verdict` line rather than grepping the log for failure text.
- **Inputs:** `<artifact>/bin/lean.wasm` (whose sha256 gives the buildId),
  `<out>/index.json` if present, and the `--lib` tree.
- **Outputs:**
  - `<work>/<name>.snap`, the raw region. It is kept, because the probes load
    it.
  - `<work>/probe.lean`.
  - `<work>/.bake.lock` while the bake runs (side effect 3): the bake's pid,
    then its runner's, one per line. Released when the bake exits; kept when
    its runner is still running then, and left behind by a SIGKILLed bake.
  - `<out>/<name>.<digest16>.snapz`, gzip and content-addressed.
  - `<out>/index.json` with the entry `{name, url, digest, bytes, transfer,
    imports, runtime}` upserted, plus `roots`, `label` and `initialBytes`
    when given, then the `--entry-fields` keys
    ([SNAPSHOT-INDEX.md](SNAPSHOT-INDEX.md) has the writer rules).
  - One `build environment: node …, zlib …, shared zlib …` stdout line after
    `baking`: the `.snapz` digest depends on the zlib build, so record a
    digest together with it.
  - `<out>/index.<buildId>.json`, the per-build copy (HARDENING #64):
    exactly the bytes of the new `index.json`, named by the runtime the
    index is paired with (this bake's). It is what a page pinned to that
    runtime reads when the mutable `index.json` beside it names another
    runtime (`loadSnapshotIndex`'s `pairedBuildId`, docs/EMBEDDING.md §7.0).
    Another runtime's copy in `<out>` is never touched. QED64's promote
    neither copies nor checks it and, since 2026-11 (architecture review
    D2), writes no copy under `public/`; its upload sends no local copy.
    The bake's copy is the STAGING index's (only the
    entries baked into this `<out>`), so it suits only a consumer that serves
    its staging dir unmerged; one that merges staged entries into a served
    index (lean4game's `scripts/stage-snapshots.py` keeps other names) must
    derive its copy from that merged index (docs/EMBEDDING.md §4).

| Marker | Stream | Regex |
|---|---|---|
| baking | stdout | `^baking (\S+)\.snap for runtime (\S+) \(probe: (.*); compactor reserve (\d+\.\d) GiB\) → (.+)$` |
| completed | stdout | `^bake output complete \((\d+) bytes, unchanged across two polls (\d+) ms apart\) — stopping the runner$` (since contract 4; it replaced `reaped`, `bake output stable (N bytes) with runner quiet — reaping the wedged exit`) |
| compressing | stdout | `^compressing (\S+)\.snapz …$` |
| baked | stdout | `^baked (\S+\/([^/\s]+)\.([0-9a-f]{16})\.snapz) \((\d+) bytes transfer, (\d+) raw\); index updated \(imports: \[([^\]]*)\], runtime (\S+)\)$` |
| index-copy | stdout | `^index copy (.+[\/\\]index\.(wasm64-[0-9a-f]{16})\.json) written \(runtime (wasm64-[0-9a-f]{16})\)$` (after `baked`, since 2026-10-08) |
| no-snap | stderr | `^FAIL: snapshot file was not produced$` |
| failed-quiet | stderr | `^bake-snapshot: the runner printed a failure line \(([a-z-]+), (stdout\|stderr) line (\d+)\) and, after (\d+) ms of quiet, wrote no (\S+)\.snap and began no save \(--quiet-ms\) — stopping it$` (then `no-snap`, exit 1; since 2026-11-01; the groups are the kind, the stream, the line number in that stream, `--quiet-ms` and the name) |
| gave-up | stderr | `^bake-snapshot: no complete (\S+)\.snap within (\d+) ms \(--give-up-ms\) — the runner is stopped, nothing compressed, the index is not written$` (exit 1, since 2026-11-01) |
| notice | stderr | `^bake-snapshot: WARNING — the runner printed a failure line \(([a-z-]+), (stdout\|stderr) line (\d+)\); for one downstream re-pin this bake still indexes (\S+)\.snap and exits 0, then it exits 1 without indexing \(docs\/CLI-CONTRACT\.md, bake-snapshot, Lean failure lines\)$` (D6's notice, before `compressing`; the groups are the kind, the stream, the line number in that stream and the name; since 2026-11-01, until the flip) |
| verdict | stderr | `^bake-snapshot: verdict (\{.*\})$` (right after `notice`; group 1 is one JSON object, `verdict` `"failed"`, then `kind`, `stream`, `line`, `name` and `bytes`; since 2026-11-01, and kept at the flip) |
| no-artifact | stderr | `^bake-snapshot: no lean\.wasm under (.+) — pass --artifact <stage1 dir>$` |
| no-runner | stderr | `^bake-snapshot: no runner script (.+) — pass --runner <script> or set QED64_RUNNER$` |
| refuse-public | stderr | `^(bake-snapshot\|chunk-runtime): refusing --out (.+): it resolves inside public\/\. ` (the regex is frozen, so it keeps the `chunk-runtime` alternative, removed in contract 4) |
| refuse-foreign | stderr | `^bake-snapshot: (.+) already holds entries for runtime (\S+) \((.*)\) — refusing to mix pairings$` |
| refuse-unpaired | stderr | `^bake-snapshot: (.+) holds entries with no runtime pairing \((.*)\) — rebake ` |
| refuse-index-unreadable | stderr | `^bake-snapshot: cannot read (.+) \((\S+)\) — refusing to replace it$` (exit 2 before the runner; exit 1 under the index lock) |
| refuse-index-corrupt | stderr | `^bake-snapshot: (.+) is not a snapshot index: (.+) — refusing to replace it$` (not JSON, not an object, another `schema`, no `snapshots` array, or an entry without a string `name`; exit 2 before the runner, exit 1 under the lock) |
| runner-signal | stderr | `^bake-snapshot: the runner was killed by (SIG[A-Z0-9]+), a signal this bake did not send — nothing compressed, the index is not written$` (exit 1) |
| runner-exit | stderr | `^bake-snapshot: runner exited (\d+)$` (exit 1; before 2026-11-01 an unhandled rejection with a stack trace) |
| refuse-name | stderr | `^bake-snapshot: refusing --name (.*): expected a letter or digit, then letters, digits, '\.', '_' or '-' \(it names <work>\/<name>\.snap, the \.snapz and the index entry\)$` (exit 2, since 2026-11-01) |
| no-lib | stderr | `^bake-snapshot: no olean tree (.+) — pass --lib <olean tree> \(the tree mounted at \/lib\/lean\)$` (exit 2, since 2026-11-01) |
| work-locked | stderr | `^bake-snapshot: --work (.+) is in use \(lock (.+) held by (.+)\); a lock is never taken over: once no bake uses (.+), remove it and rerun$` (exit 2, since 2026-11-01; the holder is `bake pid N (running on this host)` or `(not running on this host)`, then ` and runner pid M (…)` once the runner's pid is recorded, or `a holder it cannot read (…)`) |
| build-env | stdout | `^build environment: node (v\S+), zlib (\S+), shared zlib (\S+)$` (after `baking`, since 2026-11-01) |
| deprecated-default | stderr | `^(\S+): WARNING — the default --(\S+) (.+) \((.+)\) is deprecated; use --\S+ \S+ or set (\w+) \(docs\/CLI-CONTRACT\.md\)$` (once per deprecated default used: `--artifact`, `--out`, `--work`) |
| no-path | stderr | `^(\S+): no --(\S+) given and (\w+) is unset(; the deprecated default (.+) (has no \S+\|is absent))? — pass --\S+ \S+ or set \w+$` (then `usage: …`, exit 2) |

The runner's output (node-runner and Lean) is interleaved on both streams.

| Exit | Meaning |
|---|---|
| 0 | Baked: the `.snap` complete, compressed, and the index upserted (the runner is stopped once its `.snap` is complete, `completed`). **It is not yet a verdict on the probe's Lean messages:** the header snapshot is saved before Lean returns on errors. A failure line adds the `notice` WARNING and a `verdict` line (stderr); after one downstream re-pin such a bake exits 1 without indexing ("Lean failure lines", D6). Read the `verdict` line; the showcase's `judge-bake.mjs` judges the log. |
| 1 | After the bake started: the runner exited non-zero (`runner-exit`), was killed by a signal this bake did not send (`runner-signal`) or could not start; no `.snap` was produced (`no-snap`, after a runner that exited 0 or after `failed-quiet`: a failure line and then `--quiet-ms` of quiet; or `gave-up` alone, with no `no-snap` line: nothing complete within `--give-up-ms`); compressing failed; or the index could not be written (unreadable, corrupt, foreign or unpaired under the lock, its lock held past the wait, or a failed write). A written `.snapz` is kept and its entry printed (`unindexed entry <json>` on stderr). |
| 2 | Refused before the runner started: no `--artifact`, `QED64_LEAN_ARTIFACT` or deprecated default (`no-path`), no `lean.wasm` under the artifact, `--out` inside `public/`, an index paired with another runtime or with none, a malformed `--roots` or `--initial-bytes`, or a malformed `--stable-ms` / `--quiet-ms` / `--give-up-ms` (each a positive whole number of milliseconds, at most 2147483647), a `--runner` / `QED64_RUNNER` script that does not exist (`no-runner`), an unreadable or corrupt `index.json` (`refuse-index-unreadable`, `refuse-index-corrupt`: only a missing one is a new index), a bad `--name` (`refuse-name`) or `--entry-fields`, an explicit `--lib` that is not a directory (`no-lib`), or a `<work>/.bake.lock` that is held (`work-locked`) or cannot be created. |
| 129 | SIGHUP received before the index was written: forwarded to the runner (SIGKILL 10 s later); no index write. A `.snapz` already in place is kept and its entry printed. |
| 130 | SIGINT (Ctrl-C), likewise. |
| 143 | SIGTERM, likewise. |

**Side effects, in order:**

1. Reads and hashes `<artifact>/bin/lean.wasm`.
2. Reads `<out>/index.json`: a missing one is a new index; an unreadable or
   corrupt one is refused (`refuse-index-*`, exit 2) and never replaced, since
   rewriting it would drop every sibling entry. Then checks the runner script
   exists and that an explicit `--lib` is a directory. Every refusal but the
   `--work` lock's happens here, before anything is written (`--name`,
   `--roots`, `--initial-bytes`, `--stable-ms`, `--quiet-ms`, `--give-up-ms`
   and `--entry-fields` are checked first).
3. Creates `<work>` (`mkdir -p`), takes `<work>/.bake.lock` (an exclusive
   create holding the bake's pid; the runner's pid is appended once it is
   spawned). A held lock is exit 2 (`work-locked`, naming the bake's and the
   runner's pids and whether each runs on this host), whatever its holder or
   its age: it is never taken over, since two bakes sharing `<work>` bake each
   other's `probe.lean` and the runtime's `<name>.snap.tmp.<pid>` (its pid is
   a constant under Emscripten) and could exit 0 with a wrong snapshot. A
   SIGKILLed bake leaves it: remove it once no bake uses `<work>`. Then it
   removes stale `<name>.snap.tmp.*` files (an interrupted save's temp; one
   `removed the stale …` stdout line each) and writes `<work>/probe.lean`.
   The lock is released when the bake exits, and kept when its runner is
   still running then.
4. **Unlinks `<work>/<name>.snap`.**
5. Spawns `<process.execPath> --stack-size=8192 <runner> --work <work> --artifact <artifact> [--lib <lib>] -- --incr-header-save=/work/<name>.snap /work/probe.lean`
   (the Node running the bake, not PATH's `node`, since contract 3; `<runner>` is `--runner`, `QED64_RUNNER` or `pipeline/snapshot/node-runner.mjs`)
   with the environment above (`spawn`, no output buffer: execFile's 64 MiB
   `maxBuffer` killed a runner that printed more, before 2026-11-01).
   For the Mathlib umbrella this runs about 20 minutes and needs about 11 GB.
6. Polls every `--stable-ms` (default 5 s). Once `<work>/<name>.snap` has
   the same nonzero size at two consecutive polls, prints `completed`,
   SIGKILLs the runner and waits until it has exited and both its pipes have
   closed; only then does it judge the run. The runtime writes the region to
   `<name>.snap.tmp.<pid>` and renames it, after printing every message of
   probe.lean (fork `module.cpp:316-423`, `Frontend.lean:370-405`), so a
   complete `.snap` comes after the probe's whole log. A failure line (the
   classifier above), with no `.snap`, no `<name>.snap.tmp.*` (no save in
   progress; side effect 3 removed the stale ones) and no output for
   `--quiet-ms`: `failed-quiet`, then `no-snap`, exit 1 (a header Lean rejects
   never saves). No complete `.snap` within `--give-up-ms`: `gave-up`, exit 1.
   A probe that prints a failure line and then runs for longer than
   `--quiet-ms` without output before its save opens the temp file is cut
   short: bake probes are a header and a `#check`. A runner that exits by
   itself is judged as before (`runner-exit`, `runner-signal`, `no-snap`).
   Before contract 4 the bake waited for 300 s without output and 120 s of a
   stable size (about 4.5 min of every bake), and a probe whose header Lean
   rejected had no way to finish (HARDENING #84).
7. Creates `<out>` (`mkdir -p`), unlinks `<work>/<name>.snap.deps`, writes
   `<name>.snapz.<pid>.tmp` and renames it to the final name. A failure is one
   line and exit 1; the temp is removed.
8. Takes the index's lock `<out>/index.json.lock` (created by an exclusive
   open, `O_CREAT|O_EXCL`, holding the bake's pid; no hard link, so an
   exFAT/FAT, FUSE or SMB `<out>` works). A lock is never taken over, whatever
   its holder (live, dead or unreadable) or its age: the bake waits for it at
   most 120 s, then exits 1 with one stderr line naming the lock, its holder
   and whether that pid runs on this host (a symlink or a directory at the
   lock path is named as such, never followed), and one `unindexed entry <json>`
   line, without touching either index (its `.snapz` is already in place;
   once no bake writes `<out>`, removing the lock and rerunning redoes the
   upsert). With the lock it re-reads `index.json` under the same rules and
   re-checks the pairing (a refusal: exit 1, nothing written, the entry
   printed), writes `index.<buildId>.json.<pid>.tmp` and
   `index.json.<pid>.tmp` with the same bytes, renames the COPY first and
   `index.json` last, and releases the lock. Every version of either file is
   paired with this runtime only, so the order cannot show a mispaired
   index; copy-first keeps the copy never older than `index.json` (a crash
   between the renames leaves it one version ahead, and the next bake
   rewrites both), and `index.json` stays the commit record, as in
   `promote-staging`. A sibling bake into the same `<out>` no longer loses
   an entry to an interleaved write. A refusal (exit 2) and a run that fails
   before the upsert (exit 1) write neither file; a failed write under the
   lock (`writing the index failed (<code>)`, exit 1, the entry printed) may
   leave the copy one version ahead, as above.
9. Signals: SIGINT, SIGTERM and SIGHUP are forwarded to the runner (SIGKILL
   10 s later, so no runner outlives its bake); the bake writes no index and
   exits 128+n, printing `unindexed entry <json>` if its `.snapz` is already
   in place. A signal after the index is written changes nothing. An exit
   with the runner still running (a crash, or a second signal) SIGKILLs it
   and keeps `<work>/.bake.lock`, which names it (SIGKILL is not instant).
   A closed stdout or stderr (`bake | head`) never ends a bake: the runner's
   output is drained instead.

Older `.snapz` files are never deleted.

**Consumers:**

- The showcase's `scripts/bake.sh` runs it from the submodule with
  `--name --artifact --lib --reserve --work --out --probe` (all absolute) and
  `QED64_ALLOW_LEGACY_IMPORTS=1`.
- The showcase's `judge-bake.mjs` scans the whole log for reserved substrings
  (J1) and parses the `baked` line (J3).
- lean4game's `wasm/build-from-source.sh` bake lane runs the installed copy
  (or `$QED64_DIR`) with `--name --probe --roots --artifact --lib --reserve
  --work --out`. It sets no `QED64_ALLOW_LEGACY_IMPORTS`: patch 0030 admits
  its legacy oleans.
- The proof sheets' `website/build.sh` runs the installed copy (or a
  checkout) with `--name --probe --artifact --lib --work --out`, each overlay
  entry also with `--roots --label --allow-legacy-imports`, and the default
  runner; it greps `^baked ` from each overlay entry's bake log (under
  `set -euo pipefail`, so the line is required) and dies on a non-zero exit.
- In QED64: `pipeline/release/adopt-release.sh` (it greps `^baked`, fails
  on a `verdict` line since 2026-11-01, and its mathlib bake passes
  `--roots`, review D10), and `tests/unit/artifact-discipline.test.ts`.

### snapshot-probe

**Tier 1.** `node --stack-size=8192 pipeline/snapshot/snapshot-probe.mjs …`

```
usage: snapshot-probe.mjs (--snap <file> | --fresh-import --lib <tree>) (--probe-file <file> | --probe <source>)
```

| Flag | Default | Meaning |
|---|---|---|
| `--snap <file>` | — | The raw `.snap` to load. **Required, unless `--fresh-import` is given.** |
| `--fresh-import` | off | No snapshot: the probe's header is imported from `--lib` (the slim-bake differential audit). |
| `--probe-file <file>` | — | The Lean file to compile after the load. **Required, unless `--probe` is given.** |
| `--probe <source>` | — | The probe text inline. Read only when `--probe-file` is absent. |
| `--lib <tree>` | `$QED64_LIB_TREE`, else (deprecated) `work/lib-tree` under the repo root when it exists, else exit 2 | The tree mounted at `/lib/lean`. |
| `--artifact <dir>` | `$QED64_LEAN_ARTIFACT`, else (deprecated) `pipeline/toolchain/work/build/stage1` under the repo root when it has `bin/lean.js`, else exit 2 | The dir holding `bin/lean.js` and `bin/lean.wasm`. |
| `--budget-ms <ms>` | `90000` | The compile budget. A slower compile means the load seeded the wrong env-cache key. |
| `--via-mem` | off | Streams the snapshot into a wasm-malloc'd buffer and loads it with `lean_wasm_load_snapshot_mem`: the browser's path. **Pass it**: without it the probe loads through the deprecated path loader (one WARNING, below). |
| `--via-memfs` | off | **Deprecated** (one WARNING, below): copies the snapshot into MEMFS in 64 MiB chunks first, then loads it with the path loader `lean_wasm_load_snapshot`. |
| `--init-flags <n>` | `1` | Replay-control flags for `--via-mem` (patch 0016). |
| `--workspace <dir>` | — | Mounted at `/workspace`, the compile's cwd. Game probes need `.lake/gamedata`. |
| `--dump-messages` | off | Echoes every line Lean prints on stdout as `[lean:stdout] <line>`. |
| `--watchdog-ms <ms>` | `--budget-ms` + `120000` | The wall-clock limit of the run, kept by a worker thread (below). Past it the probe prints the `watchdog` line and SIGKILLs itself. `0`: no watchdog thread, as before the watchdog. Not a whole number: exit 2. |

- **Environment:** `QED64_LEAN_ARTIFACT`, `QED64_LIB_TREE` (the path rule),
  `QED64_PROFILE_INIT`.
- **Inputs:** the `.snap`, the probe, the `--lib` tree and the artifact.
- **Outputs:** stdout and stderr only.

**The path loader is deprecated (R11a, 2026-11).**

- Without `--via-mem` (the default) or with `--via-memfs`, the probe prints
  one `deprecated-loader` WARNING after the path rule, before any side
  effect. It then runs as before.
- Every executed caller passes `--via-mem` (the compiler battery, the
  showcase's `exact-header.mjs`, lean4game's `--verify-snapshots`).
- After both lean4game and the showcase re-pin past this commit, the two
  branches are deleted, `--via-mem` becomes the only loader and
  `CONTRACT_VERSION` is bumped. The kernel may then delete
  `lean_wasm_load_snapshot` (kernel §5 #4b).

**The watchdog.** From the kernel's patch 0037 on, `lean_wasm_compile`
returns only after every task still recorded for a command has finished, so
a task that never finishes (a timed sleep inside an async proof) hangs the
call (HARDENING #61). The call blocks the probe's main thread, so no timer on
it can fire. Unless `--watchdog-ms 0`, snapshot-probe therefore starts **one
worker thread** right after it creates its scratch dir (so after `--help`,
the usage checks and the path rule, which exit before it). The worker has its
own event loop; past `--watchdog-ms`, measured from the argument checks, it:

1. removes the scratch dir (a SIGKILL skips the exit hook, side effect 5);
2. writes exactly one stderr line, `SNAPSHOT PROBE FAIL: watchdog: no verdict
   within <ms> ms (lean_wasm_compile did not return; a task that never
   finishes hangs it from kernel 0037 on)` (the `watchdog` marker, a `fail`
   line too);
3. SIGKILLs its own process. The exit status is therefore **killed by
   SIGKILL** (a shell's `137`; Node's `signal === "SIGKILL"`), not an exit
   code: nothing on the blocked main thread can run to exit 1. Treat it as a
   FAIL, as any status other than 0 is.

The verdict and the watchdog claim one shared cell, so a run prints either
its own verdict (`SNAPSHOT PROBE PASS`, `SNAPSHOT PROBE FAIL: …` or
`ABORT: …`, with its exit code) or the `watchdog` line, never both: a
verdict reached before the deadline wins even if the exit after it is slow.

Nothing else changes. It is the same process: the PID, the stdio, every line
and its stream, the exit code of a run that reaches a verdict, and every
per-PID measure (`/usr/bin/time -l`'s maximum resident set size and peak
memory footprint, rusage, `proc_pid_rusage`) are the probe's own, the worker
adding a few MB. A caller's signals reach the probe itself, as before, and a
caller that SIGKILLs it and waits for its pipes to close (the compiler
battery) sees them close at once.

The default, `--budget-ms` + 120000 ms, is the compile budget plus a load
allowance; a probe with a slow `--via-memfs` or `--fresh-import` load passes
a larger one.

| Marker | Stream | Regex |
|---|---|---|
| load-header | stdout | `^== load snapshot: (\S+) \((\d+) bytes\) ==$` |
| load | stdout | `^load: tag=(\d+) scalar=(\S+) elapsed=(\d+)ms$` |
| compile | stdout | `^compile: tag=(\d+) elapsed=(\d+)ms errors=(\d+)$` |
| pass | stdout | `^SNAPSHOT PROBE PASS$` |
| fail | stderr | `^SNAPSHOT PROBE FAIL: (.*)$` |
| watchdog | stderr | `^SNAPSHOT PROBE FAIL: watchdog: no verdict within (\d+) ms \(lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on\)$` (the watchdog thread's; a `fail` line too; the process then dies of SIGKILL) |
| lean-stdout | stdout | `^\[lean:stdout\] (.*)$` (with `--dump-messages`; Lean's JSON messages) |
| abort | stderr | `^ABORT: (.*)$` |
| deprecated-loader | stderr | `^snapshot-probe: WARNING — (.+) is deprecated; pass --via-mem \(lean_wasm_load_snapshot_mem, the browser's path\) \(docs\/CLI-CONTRACT\.md\)$` (without `--via-mem`, or with `--via-memfs`; group 1 names the loader) |
| deprecated-default | stderr | `^(\S+): WARNING — the default --(\S+) (.+) \((.+)\) is deprecated; use --\S+ \S+ or set (\w+) \(docs\/CLI-CONTRACT\.md\)$` (`--artifact`, `--lib`) |
| no-path | stderr | `^(\S+): no --(\S+) given and (\w+) is unset(; the deprecated default (.+) (has no \S+\|is absent))? — pass --\S+ \S+ or set \w+$` |

| Exit | Meaning |
|---|---|
| 0 | `SNAPSHOT PROBE PASS`. |
| 1 | `SNAPSHOT PROBE FAIL`: the load failed, the probe has errors, or it blew the budget. Also a crash before the runtime started, such as an unreadable `--probe-file` or a missing `lean.js`. |
| 2 | Usage: no snapshot source, or no probe; a `--watchdog-ms` that is not a whole number; or no `--artifact` / `--lib`, its variable unset and no deprecated default (`no-path`). |
| 3 | The wasm runtime aborted (the legacy overload). |
| killed by SIGKILL | The watchdog fired (after its one `watchdog` line), or the caller killed the probe. |

Known limitation (docs/HARDENING.md #61, the kernel's patch 0037): `lean_wasm_compile` drops the messages of a declaration elaborated with `Elab.async=true`, so a wrong proof under `set_option Elab.async true` (or inside a command whose scope turns it on, like lean4game's `Runner`) gives `errors=0` and `SNAPSHOT PROBE PASS`. Plain top-level declarations and nested `elabCommand` without `Elab.async` are reported correctly.

**Side effects:** unless `--watchdog-ms 0`, one worker thread (the watchdog
above), no child process. Past the deadline it removes the scratch dir before
the SIGKILL, so a watchdog kill leaves no hard link behind.

1. `mkdtemp <os.tmpdir()>/qed64-snap-probe-*`.
2. **Hard-links** `--snap` into that dir. `--snap` must therefore be on the
   same filesystem as the OS tmpdir, or the link fails with exit 1.
3. Writes `probe.snap.deps` next to the link.
4. Boots wasm. With `--via-mem` it also allocates the snapshot's full size in
   the wasm heap.
5. Removes the scratch dir on exit, a failed link included (the exit hook is
   registered before the link since 2026-10-06; before, a missing or
   cross-device `--snap` left it behind).

**Consumers:**

- `tests/adversarial/compiler-battery.mjs` passes `--snap --probe-file
  --budget-ms --via-mem --init-flags --artifact --lib --dump-messages` and
  parses `SNAPSHOT PROBE FAIL`, `ABORT:`, `compile: tag=` and the JSON
  messages.
- The showcase's `scripts/headless/exact-header.mjs` (from the submodule) parses pass
  and fail, `^ABORT:`, `load:`, `compile:` and `[lean:stdout]`, and runs the
  probe under `/usr/bin/time -l` for its peak memory footprint (E1), which the
  watchdog leaves the probe's own (one process).
- lean4game's `build-from-source.sh --verify-snapshots` (the installed package).

### supervised-run

**Tier 1.** `node pipeline/snapshot/supervised-run.mjs …`

```
usage: supervised-run.mjs --target <file> [--quiet-ms n] [--stable-ms n] [--give-up-ms n] -- <node-runner arguments…>
```

| Flag | Default | Meaning |
|---|---|---|
| `--target <file>` | — | **Required.** The one file the job writes. It is deleted before the runner starts. |
| `--quiet-ms <ms>` | `30000` | How long the runner must have printed nothing. |
| `--stable-ms <ms>` | `30000` | How long the target's size must not have changed. |
| `--give-up-ms <ms>` | `7200000` | Fail when nothing has finished by then. |
| `--runner <script>` | `pipeline/snapshot/node-runner.mjs` | The runner. The unit tests substitute a fake. |
| `-- <args…>` | — | **Required.** node-runner's arguments, verbatim. |

- **Environment:** none of its own. The runner inherits the environment.
- **Inputs:** the runner's output and the target file.
- **Outputs:** the target, written by the job. The runner's output is piped
  through.
- **Failure classifier.** A runner output line matching
  `/(^|\n)[^\n]*(: error[:( ]|^error:|uncaught exception|PANIC|ABORT:|RuntimeError:)/m`
  fails the job, even if the target appears. Warnings are not failures.

| Marker | Stream | Regex |
|---|---|---|
| verdict | stdout | `^supervised-run: (.*) \((\d+) s\)$` (always the last line it prints) |
| done-reaped | stdout | `(\S+) stable at (\d+) bytes with the runner quiet — reaping the kept-alive CLI` (inside the verdict) |
| done-exited | stdout | `the runner exited 0 with (\S+) at (\d+) bytes` (inside the verdict) |
| failed | stdout | `FAILED — (.*)` (inside the verdict) |

| Exit | Meaning |
|---|---|
| 0 | The target is finished: it is stable with the runner quiet, or the runner exited 0 having written it. |
| 1 | The runner printed a failure line, exited non-zero, exited 0 without the target, or could not start; or the give-up deadline passed. |
| 2 | Usage: `--target` or the runner arguments are missing. |

**Side effects:**

1. Unlinks `--target`.
2. Spawns `node --stack-size=8192 <runner> <args…>`.
3. Polls the target.
4. SIGKILLs the runner once the job settles.

**Consumers:**

- QED64's `pipeline/release/adopt-release.sh --rebuild-umbrella` (the
  umbrella compile; on a failure it prints the log's tail).
- The showcase's `scripts/headless/run-e2.sh` (from the submodule; it reads the
  `^supervised-run: ` verdict line).
- `tests/unit/import-lane.test.ts`.
- `tests/integration/runtime-smoke.test.ts` (every run: it passes
  `--target`, `--quiet-ms`, `--stable-ms` and `--give-up-ms`, and judges each
  test by the exit code and the verdict line).

### preflight

**Tier 1.** `node pipeline/release/preflight.mjs …`. It runs in place from
the QED64 checkout or from the installed package, including when the showcase
calls it. It needs the caller's `playwright` only for the boot smoke (a
dynamic import, not taken with `--no-boot`). It resolves from the script's own
location, so an installed package finds the consumer's playwright; one that
does not resolve is the refusal `PREFLIGHT REFUSED: boot smoke: playwright not
resolvable from the caller (ERR_MODULE_NOT_FOUND)` with exit 3 (install
playwright beside the caller, or pass `--no-boot`). A playwright that resolves
but cannot load (a missing `playwright-core`, a partial install) is
`PREFLIGHT REFUSED: boot smoke: playwright could not be imported (<code>):
<the first line of its error>`, which names the missing module, and a
Chromium that does not launch refuses with its error. A refusal is always one
line: a multi-line cause (Playwright's launch errors carry a box-drawn hint)
is folded to single spaces. As a module it exports `runPreflight(target, opts)`,
`bootSmoke(url, budgetMs, opts)` and `main()`, typed in
`pipeline/release/preflight.d.mts` (shipped); `opts.importPlaywright` replaces
the import. The target comes from `resolveTarget(url)` in
`pipeline/release/page-target.mjs`.

**Moved on 2026-10-06** from `tests/adversarial/preflight.mjs`. The shim at
the old path, with its deprecation WARNING, was removed on 2026-11-03
(changelog). A QED64 commit from before the move holds the script at the old
path in its own tree.

```
usage: preflight.mjs [--url <page url>] [--no-boot] [--boot-budget-ms 180000] [--run-dir <dir>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--url <page url>` | `http://localhost:5187/` | The page URL. Its `?runtime=`, `?snapshots=` and `?profiles=` pick the pairing to check. |
| `--no-boot` | off | Skips the headless Chromium boot smoke, leaving fetch-only checks. |
| `--boot-budget-ms <ms>` | `180000` | The time the boot smoke gets to reach the ready pill. |
| `--run-dir <dir>` | — | Also writes `<dir>/preflight.json`. The dir is created. |

- **Environment:** none.
- **Inputs:** the served runtime manifest and its chunks, the snapshot index
  and its files, and the profile index.
- **Outputs:** stdout, plus `<run-dir>/preflight.json` when `--run-dir` is
  given.

| Marker | Stream | Regex |
|---|---|---|
| target | stdout | `^preflight: (\S+) \((\S+); manifest (\S+); snapshots \/(\S+)\/\)$` (the first line) |
| check | stdout | `^(ok {4}\|warn {2}\|FAIL {2})(.*)$` |
| refused | stdout | `^PREFLIGHT REFUSED: (.*)$` |
| ok | stdout | `^PREFLIGHT OK buildId=(\S+) mode=(\S+) snapshots=(\S+)$` |

| Exit | Meaning |
|---|---|
| 0 | `PREFLIGHT OK`. |
| 1 | A crash, for example a `--url` that is not a URL. |
| 3 | `PREFLIGHT REFUSED`: the lane must not run (a failed check, or a boot smoke that cannot start: playwright not resolvable, Chromium not launching). |

**Side effects:**

1. HTTP GET and HEAD requests to the page's origin: the manifest, every
   chunk, the index, each snapshot and the profiles.
2. Unless `--no-boot`, one headless Chromium launched through Playwright. It
   is always closed.
3. With `--run-dir`, creates the dir (`mkdir -p`) and writes
   `preflight.json`.

**Consumers:**

- `tests/adversarial/run.mjs` imports `runPreflight` (from the new path).
- `tests/adversarial/resident-gate.sh` passes `--url --run-dir` (the new path).
- The showcase's `scripts/preflight-overlays.sh` passes `--url [--no-boot]`.
  It runs the script in the target pin's own tree. On the showcase's branches
  `port-lean-4.35` and `release-routing` (not pushed; active locally, pin O
  `521cf3f`) it takes this path where it exists (its pins from `385a1ac` on),
  else the old path, which its pins up to `bf9d947` hold. Its pushed `main`
  (read 2026-11-03: `d60b15e`, live pin H `bf9d947`) hard-codes the old path,
  which that pin's tree holds; a re-pin on `main` past the shim's removal needs
  the lookup those branches carry.
- The showcase's `tests/experiments/x1-preflight.mjs` (likewise, at the active
  pin, with the same difference by branch).

### fetch-artifacts

**Tier 1.** `node pipeline/release/fetch-artifacts.mjs …` or `npm run fetch:artifacts -- …`

```
usage: fetch-artifacts.mjs [--out <dir>] [--manifests <dir>] [--release <dir|url>] [--origin <url|dir>] [--only runtime,profiles,snapshots] [--with-manifests]
```

A fresh clone has the tracked manifests and none of the bytes they pin (the
runtime chunks, the profile pack parts and the snapshot `.snapz` files are
gitignored). This tool puts every one of them under `--out`, verified, so the
page and the browser lanes run from the clone (docs/TESTING.md "A fresh
clone"). It replaces the retired `sync:artifacts`, which copied from the
owner's sibling checkout.

| Flag | Default | Meaning |
|---|---|---|
| `--out <dir>` | this checkout's `public/` (refused, exit 2, when that is inside `node_modules`) | The tree to fill, in the served layout (`runtime/chunks/`, `profiles/`, `snapshots/`). Nothing is written outside it. Created if absent. |
| `--manifests <dir>` | this checkout's `public/` | The tree holding the tracked manifests: `runtime/runtime-manifest.json`, `profiles/index.json` and the profile manifests it lists, `snapshots/index.json`. An installed package ships none of them (the profile manifests are 12 MB): pass a QED64 checkout's `public/` at your pin. |
| `--release <dir\|url>` | none | A fork release in the served layout (`release.json`, schema `lean4-wasm64.release/v1`). `/runtime/*` and `/profiles/*` come from it through its `hosting.mount`; each file must also be listed in its `files[]` with the sha256 and size the tracked manifest pins. The release's `runtime.buildId` must be the tracked manifest's, and its `runtime.schema` (absent = `org.lean-browser64.runtime/v1`) the tracked manifest's `schema` (when runtime is fetched). |
| `--origin <url\|dir>` | `https://qed64.fawadworkaddress.workers.dev/` | A QED64 site, or a served tree on disk: everything `--release` does not provide. Manifest URLs (`/runtime/chunks/…`) resolve against it, so an origin with a path prefix works. The live site serves `/runtime/*` and `/profiles/<not index.json>` only from the release its current record pins (no bucket-root fallback since 2026-10-25), so a checkout pinned to an older release needs `--release <that release>` for them. |
| `--only <groups>` | `runtime,profiles,snapshots` | A comma list of `runtime`, `profiles`, `snapshots`. |
| `--with-manifests` | off | Also writes the tracked manifests themselves into `--out`, for a tree that is not this checkout's `public/` (an upload, another server's root). |

What each group fetches, and against what it is verified:

| Group | Files | Verified against |
|---|---|---|
| `runtime` | every chunk of `runtime/runtime-manifest.json`, and `runtime/runtime-manifest.<buildId>.json` | each chunk's `sha256` and `bytes`, then each whole file (`lean.js`, `lean.wasm`) over its chunks in order (a v2 runtime's gzip parts each inflated first, to its `decodedBytes`). The digest-named copy is written from the tracked manifest's own bytes, never fetched. |
| `profiles` | the transport parts of every manifest `profiles/index.json` lists | each part's `digest` and `byteLength` as the profile manifest records them, then the whole transport's `digest` and `byteLength` |
| `snapshots` | every `.snapz` of `snapshots/index.json` | the entry's `digest` (the sha256 of the `.snapz` itself) and `transfer` (its size; `bytes` when an entry has no `transfer`) |

**Runtime manifest formats.** The tracked runtime manifest is
`org.lean-browser64.runtime/v1` (an absent `schema` is read as v1) or
`org.lean-browser64.runtime/v2` (the fork owns the format; its
`formats/runtime-manifest.md` gains the v2 section with the first v2
release, and the rules below are the shape it accepted on 2026-11-01).
In v2 every file names its `encoding`, `gzip` or `identity` (a closed set),
and every chunk its `decodedBytes`: a chunk's `sha256` and `bytes` are the
part as served, the file's are the decoded file's. Every part but the last
decodes to exactly 16,777,216 bytes, the last to at most that, and the
`decodedBytes` sum to the file's `bytes`; an `identity` part's
`decodedBytes` is its `bytes`. A v1 file may only be `identity` (or name no
encoding). A manifest that breaks these rules, or has another schema, is
refused before anything is written. The files land as served (the gzip
parts as they are); only the whole-file check inflates them. Served gzip
bytes are compared only with the same build's pins, never across builds.

**Site-owned files.** Snapshots and `/profiles/index.json` belong to the site
that serves them (release.json `hosting.siteOwned`): they come from the
tracked files or the origin, never from a release. With `--release`, the
snapshots still come from `--origin`; with `--release --only runtime,profiles`
the origin is not contacted at all.

Every manifest URL must name a file directly under its group's directory
(`/runtime/chunks/`, `/profiles/`, `/snapshots/`: no `..`, no subdirectory),
and every target's directory, through symlinks, must resolve inside `--out`;
otherwise the tool refuses before writing anything.

- **Environment:** none.
- **Inputs:** the tracked manifests, the release's `release.json` and files,
  the origin's files.
- **Outputs:** the files above under `--out` (and the manifests with
  `--with-manifests`), one stdout summary line, progress on stderr.

| Marker | Stream | Regex |
|---|---|---|
| plan | stderr | `^fetch-artifacts: (runtime\|profiles\|snapshots): (\d+) files, (\d+) bytes from (.+)$` (one per group, first) |
| fetched | stderr | `^fetch-artifacts: fetched (\S+) \((\d+) bytes\)$` |
| present | stderr | `^fetch-artifacts: present (\S+) \((\d+) bytes, verified\)$` (already there with its pin: skipped) |
| replacing | stderr | `^fetch-artifacts: replacing (\S+): ` (there, but not with its pin) |
| verified | stderr | `^fetch-artifacts: verified (.+) \((\d+) bytes, sha256 ([0-9a-f]{16})…, (\d+) parts\)$` (a whole file or transport) |
| removed | stderr | `^fetch-artifacts: removed (\S+), a temp file left by process (\d+)$` (a temp file of a dead process beside a target, swept before the fetch) |
| wrote | stderr | `^fetch-artifacts: wrote (\S+) \((\d+) bytes, the tracked (\S+)\)$` (the digest-named runtime manifest; `--with-manifests`: the tracked manifests) |
| ok | stdout | `^FETCH OK (\d+) files, (\d+) bytes \((\d+) fetched, (\d+) already present\)$` (the only stdout line; the totals are the whole verified set) |
| failed | stdout | `^FETCH FAILED (.*)$` (the only stdout line, always one line: a newline in the reason, such as the snippet a JSON parse error quotes, is folded with the space around it into one space; the reason starts with the file it is about, when it is about one) |

| Exit | Meaning |
|---|---|
| 0 | `FETCH OK`: every file the manifests name is under `--out` with its pinned digest. |
| 1 | `FETCH FAILED`: a fetch failed (an HTTP status such as `404`, the network, 120 s without bytes), a size or digest mismatch, parts that do not assemble to their whole-file pin, a v2 runtime part that does not inflate, or inflates to another size than its `decodedBytes`, or a release whose schema, `runtime.buildId`, `runtime.schema` or `files[]` does not match. The run stops at the first failure; files verified before it stay. |
| 2 | `FETCH FAILED`, refused before any write: a malformed `--only`, a tracked manifest missing or malformed, a runtime manifest of a schema it does not read (or whose file `encoding` or `decodedBytes` its schema does not allow), a manifest URL outside its directory, a target outside `--out`, or the default `--out` inside `node_modules`. |
| 130 | `FETCH FAILED interrupted (SIGINT)`: Ctrl-C. The run stops, its temp files are deleted; files verified before it stay. |
| 143 | `FETCH FAILED interrupted (SIGTERM)`: likewise. |

**Side effects, in order:**

1. Reads the tracked manifests; with `--release`, its `release.json`. Every
   refusal and every release mismatch happens here, before anything is
   written.
2. Deletes, in each target's directory, the temp files a dead process left
   for that target (`.<name>.<pid>-<random>.tmp` whose pid is not running:
   a run killed outright, `kill -9` or a closed terminal), one `removed` line
   each. A live process's temp files are left alone.
3. Creates the target directories under `--out` (`mkdir -p`).
4. For each file (four at a time): hashes the file already there, if any, and
   skips it when it matches its pin; otherwise GETs it into
   `.<name>.<pid>-<random>.tmp` in the target's directory, counting and
   hashing as it streams (a body longer than the pin is cut off), and renames
   it into place only when the size and sha256 match. A mismatch deletes the
   temp file. Nothing is written under a final name unverified.
5. Re-reads each whole file's parts and checks the whole-file pin (a v2
   runtime's gzip parts inflated in memory, each to its `decodedBytes`).
6. Writes the digest-named runtime manifest (and, with `--with-manifests`,
   the tracked manifests) the same way.

On SIGINT or SIGTERM the run deletes every temp file it has open at once,
stops its downloads and exits 130 or 143 with `FETCH FAILED interrupted
(<signal>)`. A second signal, or 5 s without the run ending, exits the same
way immediately. Rerunning resumes: files already verified are `present`.

Existing files that no manifest names are never touched or deleted, except
the dead process's temp files of step 2.

**Consumers:** the README's "Build from source" and docs/TESTING.md ("a fresh clone
runs G1 after fetch:artifacts"); `tests/unit/fetch-artifacts.test.ts`;
`tests/consumer/check-consumer.mjs` (`--help` through the package symlink,
and the no-manifests refusal). Neither downstream calls it yet.

### olean-imports --audit / --entries

**Tier 1.** `node pipeline/artifacts/olean-imports.mjs --audit <tree>` or
`--entries <file>`. As a module it exports `oleanImportEntries`,
`oleanImports` and `oleanExtEntryCounts` (ModuleData's constant-name count
and the entry count of each environment extension: `{ constNames, entries:
{ <extension>: count } }`, the shape of the showcase's `olean-entries.mjs`),
and importing it has no side effects.

```
usage: olean-imports.mjs (--audit <olean tree> | --entries <olean file>)
```

| Flag | Default | Meaning |
|---|---|---|
| `--audit <olean tree>` | — | The tree to audit (every `*.olean` under it). It must exist. One of `--audit` and `--entries` is **required**; both is a usage refusal. |
| `--entries <olean file>` | — | Prints one line, `entries of <file>: <JSON>`, the JSON being `oleanExtEntryCounts` of the file. It must be an existing file. |

- **Environment:** none.
- **Inputs:** the tree. The tool only reads it.
- **Outputs:** stdout only.

| Marker | Stream | Regex |
|---|---|---|
| summary | stdout | `` ^import-all audit of (.+): (\d+) modules, (\d+) `import all` edge\(s\)(, (\d+) unreadable \.olean file\(s\))?$ `` (the first line) |
| outside | stdout | `^ {2}outside Init\/Std\/Lean\/Lake: (\d+)$` |
| edge | stdout | `^ {4}(\S+) → import all (\S+)$` (at most 40 lines, then `    … N more`) |
| entries | stdout | `^entries of (.+): (\{"constNames":\d+,"entries":\{.*\}\})$` (`--entries`: the only line) |

| Exit | Meaning |
|---|---|
| 0 | Audited, or (`--entries`) the counts printed. |
| 1 | Audited, but some `.olean` files had no readable import table; or (`--entries`) the file has no readable ModuleData (`no readable ModuleData in <file>` on stdout). |
| 2 | Usage: neither `--audit` nor `--entries`, both, or the tree or file does not exist. |

**Side effects:** none.

**Consumers:**

- QED64's `adopt-release.sh --rebuild-umbrella` greps the same lines
  (`^import-all audit|outside Init`) from the package's `lean4-wasm64
  olean-imports --audit`.
- The showcase's `scripts/stage-trees.mjs` G5 (from the submodule). It parses
  `outside Init/Std/Lean/Lake: (\d+)` and the first line, under a 300 s
  watchdog.

### node-runner

**Tier 2.** `node --stack-size=8192 pipeline/snapshot/node-runner.mjs …` or `npm run runner -- …`

```
usage: node-runner.mjs [--artifact <dir>] [--work <dir>] [--lib <dir>] [--] <lean args...>
```

| Flag | Default | Meaning |
|---|---|---|
| `--artifact <dir>` | `$QED64_LEAN_ARTIFACT`, else (deprecated) `pipeline/toolchain/work/build/stage1` under the repo root when it has `bin/lean.js`, else exit 2 (the sibling-checkout fallback is deleted) | The dir holding `bin/lean.js`, `bin/lean.wasm` and `lib/lean`. |
| `--work <dir>` | `$QED64_WORK`, else (deprecated) `work/runner` under the repo root | Mounted read-write at `/work`, which is Lean's cwd. Created if absent. |
| `--lib <dir>` | `<artifact>/lib/lean` | Mounted at `/lib/lean`. |
| `[--] <lean args…>` | — | Lean's own arguments (see "Passthrough"). |

- **Environment:** `QED64_LEAN_ARTIFACT`, `QED64_WORK` (the path rule).
  `LEAN_COMPACTOR_RESERVE`, `QED64_ALLOW_LEGACY_IMPORTS` and
  `QED64_PROFILE_INIT` are forwarded into the wasm environment.
- **Inputs:** the artifact, `--lib`, and whatever Lean reads under `/work`.
- **Outputs:** whatever Lean writes under `/work`, such as `-o` oleans and
  `--incr-header-save` snapshots, plus Lean's own output.

| Marker | Stream | Regex |
|---|---|---|
| abort | stderr | `^ABORT: (.*)$` |
| no-lean-js | stderr | `^error: (.+) not found — pass --artifact or set QED64_LEAN_ARTIFACT$` |
| no-lib | stderr | `^error: (.+) not found$` |
| deprecated-default | stderr | `^(\S+): WARNING — the default --(\S+) (.+) \((.+)\) is deprecated; use --\S+ \S+ or set (\w+) \(docs\/CLI-CONTRACT\.md\)$` (`--artifact`, `--work`) |
| no-path | stderr | `^(\S+): no --(\S+) given and (\w+) is unset(; the deprecated default (.+) (has no \S+\|is absent))? — pass --\S+ \S+ or set \w+$` |

| Exit | Meaning |
|---|---|
| 0 | Lean exited 0. This is rare: since patch 0031 the process normally stays alive after `main` returns. |
| 1 | Lean's own non-zero exit code, passed through when the process does exit. |
| 2 | `lean.js` or the library tree was not found, or no `--artifact`, `QED64_LEAN_ARTIFACT` or deprecated default (`no-path`). |
| 3 | The wasm runtime aborted (the legacy overload). |

**Side effects:**

0. Without `--stack-size`, re-execs itself with `--stack-size=8192` (same
   PID; "Runtime").
1. Checks the artifact and the library tree first.
2. Resolves `--work` and creates it (`mkdir -p`) only once both exist.
3. Boots wasm with NODEFS mounts. The artifact dir is also mirrored at its own
   host path inside the VFS.
4. Does not exit after `main` returns.

**Consumers:**

- bake-snapshot: QED64's, lean4game's, the proof sheets' and the showcase's
  bakes all run this file as the default runner, and the proof sheets hash
  its bytes into their bake fingerprint.
- supervised-run.
- `tests/integration/runtime-smoke.test.ts`, through supervised-run with
  node-runner's own flags after `--`.

The package's gate runs its own runner.

### persistent-probe

**Tier 2.** `node --stack-size=8192 pipeline/snapshot/persistent-probe.mjs [--artifact <dir>]`

```
usage: persistent-probe.mjs [--artifact <dir>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--artifact <dir>` | `$QED64_LEAN_ARTIFACT`, else (deprecated) `pipeline/toolchain/work/build/stage1` under the repo root when it has `bin/lean.js`, else exit 2 | The stage1 dir. Its `lib/lean` is mounted at `/lib/lean`. |

- **Environment:** `QED64_LEAN_ARTIFACT` (the path rule).
- **Inputs:** the artifact.
- **Outputs:** stdout and stderr only.

| Marker | Stream | Regex |
|---|---|---|
| pass | stdout | `^PERSISTENT PROBE PASS$` |
| fail | stderr | `^PERSISTENT PROBE FAIL: (.*)$` |
| parse-swallowed | stdout | `^PARSE-ERROR-SWALLOWED ` |
| parse-fixed | stdout | `runtime defect is FIXED` |
| abort | stderr | `^ABORT: (.*)$` |
| deprecated-default | stderr | `^(\S+): WARNING — the default --(\S+) (.+) \((.+)\) is deprecated; use --\S+ \S+ or set (\w+) \(docs\/CLI-CONTRACT\.md\)$` |
| no-path | stderr | `^(\S+): no --(\S+) given and (\w+) is unset(; the deprecated default (.+) (has no \S+\|is absent))? — pass --\S+ \S+ or set \w+$` |

| Exit | Meaning |
|---|---|
| 0 | `PERSISTENT PROBE PASS`. |
| 1 | `PERSISTENT PROBE FAIL`, or the artifact is unreadable (an unhandled ENOENT before the runtime starts). |
| 2 | No `--artifact`, `QED64_LEAN_ARTIFACT` unset and no deprecated default (`no-path`); nothing booted. New in contract 2: that case used to fall through to the sibling-checkout path and crash with 1. |
| 3 | The wasm runtime aborted (the legacy overload). |

**Side effects:** boots wasm. It writes no files.

**Consumers:**

- lean4-wasm64's gate checks its own copy's `PERSISTENT PROBE PASS` and
  `runtime defect is FIXED`.
- `tests/integration/persistent-path.test.ts`.

### resident-probe

**Tier 1.** Its surface only ("Tiers"): the flags below not marked tier 3, the markers and the exits. `node --stack-size=8192 pipeline/snapshot/resident-probe.mjs …`

```
usage: resident-probe.mjs [--artifact <stage1>] [--lib <tree>] [--budget-ms 180000] [--snap-dir <dir>] [--snapshots init,mathlib] [--mathlib] [--act2 | --act4 [--act4-ms 500]] [--lean-option <name=value> ...] [--option-check] [--probe-file <file> [--dump-messages] [--settle-ms 5000]]
```

| Flag | Default | Meaning |
|---|---|---|
| `--artifact <dir>` | `$QED64_LEAN_ARTIFACT`, else (deprecated) `pipeline/toolchain/work/build/stage1` under the repo root when it has `bin/lean.js`, else exit 2 | The stage1 dir. Its `lib/lean` is mounted at `/lib/lean` unless `--lib` names a tree. |
| `--lib <tree>` | `<artifact>/lib/lean` | The olean tree mounted at `/lib/lean`, which is `LEAN_PATH`. A runtime-only artifact has none, so it needs this flag. Not checked before the run: an absent tree, the default included, is an exit-1 crash with no verdict line and no path named (the exits, below). A present tree's contents are not checked: a header a snapshot covers runs even on an empty one. |
| `--snap-dir <dir>` | `$QED64_SNAP_DIR` (tier 3), else (deprecated) `work/snapshot` under the repo root when it exists, else exit 2 | The directory holding `<name>.snap`. |
| `--snapshots <a,b>` | `init`; `init,mathlib` with `--mathlib` or `--probe-file` | Any comma-separated list of names (each trimmed, empty ones dropped): the `<name>.snap` files under `--snap-dir` seeded into the env cache, in load order. Nothing adds `init` (the page loads it first). A missing one is no refusal (below). |
| `--budget-ms <ms>` | `180000` | The run's budget; past it, a FAIL verdict. |
| `--mathlib` | off | The built-in Mathlib probe instead of the Init one: PASS when progress drains with no error diagnostic. |
| `--probe-file <file>` | none | Runs that document as the page does (act 1, no extra requests) and exits 0 whatever its errors are: the caller judges them. Refused with `--mathlib`, `--act2`, `--act4` and `--option-check`. |
| `--dump-messages` | off | With `--probe-file`: one `{"caption":"",…}` line per final diagnostic. |
| `--settle-ms <ms>` | `5000` | With `--probe-file`: how long progress must stay drained before the result. A number >= 0. |
| `--lean-option <name=value>` | none | An extra Lean option (repeatable), merged into the page's command line by name: it replaces a default in place or is appended, and the verdict's `argv` shows the result. A malformed entry or a name given twice exits 2. Lean judges the rest. A value of the wrong type for a name it knows when `--worker` starts (built in, or declared by a seeded snapshot) never starts the session: one log line on stdout echoing Lean's stderr, then FAIL, `budget exceeded`, when `--budget-ms` runs out. A `weak.` prefix, the form the proof sheets' `weak.verso.code.warnLineLength` takes, moves that check to after the imports: the same value is one error diagnostic at line 1 and the document is not elaborated (under `--probe-file`, exit 0 and PASS). An unknown name without the prefix ends the same way. A `weak.` name nothing declares is ignored: no diagnostic, and the document runs. |
| `--act2` | off | Tier 3. After act 1, a header change and an in-process session replacement (Init only). |
| `--act4` | off | Tier 3. A full-text header switch mid-elaboration. |
| `--act4-ms <ms>` | `500` | Tier 3. How long after the first non-empty progress `--act4` switches. |
| `--option-check` | off | Tier 3. One Init document that passes only when `--lean-option autoImplicit=false` reached Lean. |

- **Environment:** `QED64_LEAN_ARTIFACT` (the path rule). Tier 3: `QED64_SNAP_DIR`
  and the experiment switches (`PROBE_HEADER`, `PROBE_MINIMAL`,
  `SKIP_TASK_MANAGER`, `DUMP_MSGS`, `RAW_TAP`, `ACT4_MS`).
- **Inputs:** the artifact (`bin/lean.js`, `bin/lean.wasm`, and `lib/lean`
  unless `--lib` names a tree), the `.snap` files, `--probe-file`, and
  `public/workers/lean.worker.js` (its ring size is checked at startup). Of the
  paths a caller names, only `bin/lean.js` and `--probe-file` are checked before
  the run (the exits, below).
- **Outputs:** stdout and stderr only. Its other log lines, such as
  `resident: reached elaboration`, are tier 3.

| Marker | Stream | Regex |
|---|---|---|
| message | stdout | `^\{"caption":"","severity":"[^"]+","pos":\{"line":\d+,"column":\d+\},"endPos":\{"line":\d+,"column":\d+\},"data":".*"\}$` |
| compile | stdout | `^compile: tag=0 elapsed=(\d+)ms errors=(\d+)$` |
| verdict | stdout | `^RESIDENT PROBE (PASS\|FAIL) (\{.*\})$` |
| deprecated-default | stderr | `^(\S+): WARNING — the default --(\S+) (.+) \((.+)\) is deprecated; use --\S+ \S+ or set (\w+) \(docs\/CLI-CONTRACT\.md\)$` |
| no-path | stderr | `^(\S+): no --(\S+) given and (\w+) is unset(; the deprecated default (.+) (has no \S+\|is absent))? — pass --\S+ \S+ or set \w+$` |

| Exit | Meaning |
|---|---|
| 0 | `RESIDENT PROBE PASS`. Require that line as well as the exit, as the gate does: a `bin/lean.js` that never starts the runtime (an empty file) also exits 0, with no verdict line. |
| 1 | `RESIDENT PROBE FAIL` (a missing `bin/lean.wasm`; a non-numeric `--budget-ms`, at once, `why` `budget exceeded`), or a crash of the probe itself: an unhandled throw with no verdict line. An absent `--lib` tree causes one, with nothing on stdout (Node's `UnhandledPromiseRejection`, naming no path); turning that crash into a clean exit 2 refusal that names the path would not be a breaking change. |
| 2 | Refused before the run, with no verdict line: no `--artifact` or `--snap-dir` resolved, a missing `bin/lean.js` or `--probe-file`, a refused flag combination, a bad `--settle-ms`, or a `--lean-option` that is malformed or names an option twice. |

**A missing `.snap` is not refused.** A `<name>.snap` absent from `--snap-dir`,
or a named `--snap-dir` that does not exist, gets one tier-3 log line
(`WARNING: … missing`) and the run goes on. With `--probe-file`, a header that
file would have covered comes back as an error diagnostic under exit 0 and a
PASS verdict (`modules #[…] are not loaded in this session`), so a caller that
needs the files checks for them first, as the gate does.

**Side effects:** boots wasm. It writes no files.

**Consumers:** the lean4-wasm64 gate; the compiler battery's `--transport
fileworker`; planned, not adopted yet, the proof sheets' `website/build.sh`,
whose `browser-check.mjs` call would become `--artifact`, `--lib`, `--snap-dir`,
`--snapshots init,<entry>`, `--probe-file` (its `--sheet`), `--dump-messages`
and one `--lean-option` per `--opt`. Two of their settings need more than that
call: the argv keeps the page's `-DElab.async=false` unless they pass
`--lean-option Elab.async=true` (their site removes the flag, which leaves
Lean's default, on), and their 900 s budget needs `--budget-ms` (the default
is 180 s). The probe refuses neither an absent tree nor a missing `.snap`, so
those checks stay theirs.

### pack

**Tier 2.** `node pipeline/artifacts/pack.mjs …` or `npm run pack -- …`

```
usage: pack.mjs --lib <dir> --id <name> --out <dir> [...]
```

| Flag | Default | Meaning |
|---|---|---|
| `--lib <dir>` | — | **Required.** The olean tree to pack. |
| `--id <name>` | — | **Required.** The pack id: it names `<id>.pack`, `<id>.manifest.json` and the parts. |
| `--out <dir>` | `work/packs`, relative to the cwd | The output dir. |
| `--mount <path>` | `/lib/lean/library` | The WORKERFS mount point. |
| `--lean-version <x.y.z>` | `4.33.0-pre` | `content.lean.version`. |
| `--revision <string>` | `unpinned` | `content.lean.gitRevision`. |
| `--roots <A,B,…>` | none | `content.roots`. |
| `--url-prefix <prefix>` | empty (bare part names) | Where the parts will be served from, e.g. `/profiles/`. |
| `--release <string>` | `<id>-<lean-version>-local` | `content.release`. |
| `--no-imports` | off | Does not read imports from the `.olean` files. For fixtures that are not real regions. |

- **Environment:** none.
- **Stays a real QED64 script for now** (QED64's stage-profiles tests build
  real packs with it); leaving for the fork later. `lean4-wasm64 pack` is
  **not** flag-identical: it requires `--lib --id --out --lean-version` (no
  `work/packs` or `4.33.0-pre` defaults). Pass all four now.
- **Inputs:** every `*.olean`, `.olean.server`, `.olean.private`, `.ir` and
  `.ir.sig` file under `--lib`.
- **Outputs:** `<out>/<id>.pack`, the parts `<id>.pack.gzip.<sha20>.part-NNN`,
  and `<id>.manifest.json`. Same-named files are overwritten.

| Marker | Stream | Regex |
|---|---|---|
| summary | stdout | `^(\S+): (\d+) artifacts, (\d+) modules, pack (\d+) bytes \(sha256:([0-9a-f]{16})…\), transport (\d+) bytes in (\d+) part\(s\) → (.+)$` |
| unreadable | stderr | `^(\S+): (\d+) \.olean file\(s\) had no readable import table` |

| Exit | Meaning |
|---|---|
| 0 | Packed. |
| 1 | Packed, but some `.olean` files had no readable import table. |
| 2 | Usage, or no artifacts under `--lib`. |

**Side effects:** creates `--out` (`mkdir -p`) and writes the files above.

**Consumers:**

- None of QED64's lanes since plan B2a: the release packs, and
  `import-packs.sh` is deleted.
- `tests/unit/{import-lane,pack-format,artifact-discipline}.test.ts`.

### lean4-wasm64: the forwards

Removed in contract 4 (2026-11, architecture review R9a), after their
contract-3 deprecation window.

Decision 10 stands: `lean4-wasm64` is a devDependency pinned by its release
tgz URL (`toolchain/lean4-wasm64-release.json`), and nothing in QED64 imports
it.

| Deleted script | Run instead |
|---|---|
| `unpack.mjs` | `node <pkg>/cli.mjs unpack --manifest <file> --out <dir> [--slim]` (no `--exclude`) |
| `chunk-runtime.mjs` | `node <pkg>/cli.mjs chunk --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string>` (all four required; stage outside `public/` and promote with `npm run promote:staging`) |
| `inspect.mjs` | `node <pkg>/cli.mjs inspect <manifest.json> [--pack <file>] [--deep]` (`npm run inspect:pack -- …`, which needs the devDependency installed: `node_modules/.bin/lean4-wasm64`) |
| `gate.mjs` | `node <pkg>/cli.mjs gate --artifact <dir>` (`adopt-release.sh --gate` runs it) |
| `gen-exports.py` | the fork's `wasm64-build/gen-exports.py` at `release.json` `kernel.commit` |

`<pkg>` is the installed `node_modules/lean4-wasm64`, or `--tools` /
`$LEAN4_WASM64_DIR` for adopt-release.sh. `pack`, `node-runner`,
`persistent-probe`, `olean-imports` and `artifact-paths.mjs` stay QED64's.

## Frozen: the flags and lines consumers parse

Everything below changes only under the stability policy. Each tool line is a
marker in SPECS (its regex is in the tool's section and checked against the
script by `tests/unit/cli-contract.test.ts`); each flag is in its SPEC.

| Frozen | Tool | Who parses or passes it |
|---|---|---|
| `--name --artifact --lib --reserve --work --out --probe`, and `--roots --label --initial-bytes --allow-legacy-imports` | bake-snapshot | the showcase's `scripts/bake.sh` (the first seven, absolute paths); lean4game's `build-from-source.sh` bake lane (`--name --probe --roots --artifact --lib --reserve --work --out`); the proof sheets' `website/build.sh` (`--name --probe --artifact --lib --work --out`, and `--roots --label --allow-legacy-imports` for each overlay entry) |
| `QED64_ALLOW_LEGACY_IMPORTS=1`, the equivalent of `--allow-legacy-imports` | bake-snapshot (forwarded to its runner as 1), node-runner | the showcase's `scripts/bake.sh` sets it (the proof sheets pass the flag, row above); lean4game stopped on 2026-10-08 (its adoption of the lean4-wasm64 release lean-v4.34.0-41ec565), because patch 0030 admits legacy oleans |
| the `baked` line, and exit 0 meaning "baked" (not yet a Lean verdict: the `notice` and `verdict` lines announce D6's exit 1 after one re-pin cycle) | bake-snapshot | the showcase's `scripts/judge-bake.mjs` J3; QED64's `adopt-release.sh` (`^baked`); the proof sheets' `website/build.sh` (`grep -E '^baked '` under pipefail, and `\|\| die` on the exit) |
| `--snap --fresh-import --probe-file --probe --lib --artifact --budget-ms --via-mem --init-flags --workspace --dump-messages`, and `--watchdog-ms` | snapshot-probe | the showcase's `scripts/headless/exact-header.mjs`; lean4game `--verify-snapshots`; the compiler battery (the first eleven; none passes `--watchdog-ms` yet) |
| `SNAPSHOT PROBE PASS` (exit 0), `SNAPSHOT PROBE FAIL: …`, `load:`, `compile:`, `[lean:stdout] …`, `ABORT: …` | snapshot-probe | `exact-header.mjs` (verdict, fail reason, load and compile times, the JSON messages, the abort); the compiler battery; lean4game |
| `--artifact --lib --snap-dir --budget-ms --mathlib --probe-file --dump-messages --settle-ms`, `--lean-option` (repeatable), and `--snapshots` with any list | resident-probe | the lean4-wasm64 gate (block 7; of these it passes no `--lib`, `--lean-option` or `--settle-ms`, and `--snapshots init` only); the compiler battery's FileWorker lane (`--snapshots init,<name>`, no `--lean-option`); planned, not adopted yet, the proof sheets' `website/build.sh` (`--artifact --lib --snap-dir --probe-file --dump-messages`, `--snapshots init,<entry>`, its options as `--lean-option`, and `--budget-ms` to keep its budget) |
| the `{"caption":"",…}` and `compile: tag=0 …` lines, `RESIDENT PROBE PASS\|FAIL <json>` and its keys ("Tiers"), exits 0 / 1 / 2 as [its section](#resident-probe) words them (no refusal for a missing `.snap`) | resident-probe | the same |
| `--target --quiet-ms --stable-ms --give-up-ms --`, and the runner arguments after `--` verbatim | supervised-run | the showcase's `scripts/headless/run-e2.sh`; `adopt-release.sh --rebuild-umbrella`; `runtime-smoke.test.ts` |
| the last line `supervised-run: <why> (<n> s)` (`^supervised-run: `) and exits 0 / 1 / 2 | supervised-run | `run-e2.sh` (`grep -E '^supervised-run: ' … \| tail -1`); `runtime-smoke.test.ts` |
| `--url --no-boot --boot-budget-ms --run-dir` | preflight | the showcase's `scripts/preflight-overlays.sh` and `tests/experiments/x1-preflight.mjs`; `resident-gate.sh` |
| `PREFLIGHT OK buildId=… mode=… snapshots=…` (exit 0), `PREFLIGHT REFUSED: …` (exit 3), the `ok`/`warn`/`FAIL` check lines | preflight | the same, and `run.mjs` through `runPreflight` |
| `import-all audit of …` and `  outside Init/Std/Lean/Lake: N` | olean-imports `--audit` | the showcase's `scripts/stage-trees.mjs` G5; `adopt-release.sh --rebuild-umbrella` (the package's audit) |

### Toolchain lines consumers parse

These lines are printed by the Lean runtime itself (the fork's patches), not
by a tool here; node-runner, bake-snapshot and snapshot-probe pass them
through unchanged (snapshot-probe captures them; `--dump-messages` echoes only
stdout). No SPEC can pin them, because their format string is not in this
repository: they are frozen by this list, and a toolchain release (the fork's,
plan step B1) that changes one is a breaking change for the consumer named.

| Line, as printed | Origin | Stream | Who parses it |
|---|---|---|---|
| `[WASM DEBUG] wasmLoadSnapshotMem: cached env for #[<imports>]` (and `wasmLoadSnapshot: cached env for …`) | patches 0013 / 0014 / 0016 | stderr | the showcase's `scripts/headless/exact-header.mjs` (`/cached env for #\[([^\]]*)\]/`: the key the snapshot seeded must be `Init` plus the bake key) and `scripts/headless/wasm-lsp.mjs` |
| `[DEBUG:PROGRESS] Loading N modules...` | patch 0031 (moved to stderr) | stderr | the showcase's `scripts/judge-bake.mjs` J2 (`/Loading (\d+) modules/`: exactly one, N equal to the staged tree's EXPECTED-N) |
| `[DEBUG:PROGRESS] <i>/<N>: <module>` | patch 0031 | stderr | `judge-bake.mjs` J2 (`\bN/N: (\S+)`: the import reached its last module) |
| `object compactor: out of memory growing the region buffer to …` (a thrown exception's text) | patch 0011 | stderr | the showcase's `scripts/bake.sh` (on this prefix it rebakes once with `--reserve` + 512 MiB); `judge-bake.mjs` J1 (any `object compactor:` line fails the bake, which is why it is a reserved substring) |

The gate is the package's (`lean4-wasm64 gate --artifact <dir>`); it strips
the `[DEBUG:PROGRESS]` and `[WASM DEBUG]` lines before it judges Lean's
output, as QED64's own gate did.

## Stability policy

- **Additive (allowed at any time):**
  - a new flag, or a new value accepted by an existing flag;
  - a new tool;
  - a new stdout or stderr line that matches no existing marker regex and
    contains no reserved substring;
  - a new WARNING;
  - extra fields in a JSON output.
- **Breaking (needs the deprecation window):**
  - removing or renaming a flag;
  - changing a default, an exit code or its meaning, or a stable marker's
    text or its regex;
  - moving a script, or changing an npm alias;
  - making a WARNING fatal.
- **The deprecation window is one downstream re-pin cycle.** Ship the new
  behaviour alongside the old. Make the old form print a
  `<tool>: WARNING — … is deprecated; use … (docs/CLI-CONTRACT.md)` line,
  without reserved substrings. Add a changelog row. Remove the old form only
  after every consumer has re-pinned to a QED64 commit that carries the
  warning:
  - lean4game: the `qed64` SHA in `client/package.json`, `wasm64-port`;
  - the proof sheets: the `qed64` SHA in `website/site/package.json`;
  - the showcase: `pins/<id>/QED64.lock.json` and its submodule.
- A breaking change bumps `CONTRACT_VERSION` in `cli.mjs`.
- Bug fixes that turn a crash or an undefined behaviour into the documented
  one are not breaking. They do get a changelog row.

## Changelog

| Contract | Date | Change | Kind |
|---|---|---|---|
| 1 | 2026-10-04 | The contract is introduced: SPECS in `pipeline/snapshot/cli.mjs`, this document, `tests/unit/cli-contract.test.ts`. Every Tier 1/2 tool answers `--help`/`-h` before any side effect. Every tool accepts `--flag=value` and warns about unknown flags without failing. | additive |
| 1 | 2026-10-04 | `bake-snapshot --help` no longer bakes. Before, it unlinked `<work>/<name>.snap` (by default the paired `work/snapshot/init.snap`) and started a ~20 min, 11 GB bake. `node-runner --help` no longer boots wasm and hangs; Lean's own help is now `node-runner -- --help`. | fix |
| 1 | 2026-10-04 | A missing required flag now exits 2 with the usage line. Before, the check tested `path.resolve("")`, which is the cwd and never empty, so the documented usage refusal was dead code: chunk-runtime without `--bin` spawned git and crashed with exit 1; pack without `--lib` walked and packed the cwd; unpack without `--out` wrote the tree into the cwd, and without `--manifest` crashed with exit 1; snapshot-probe without `--snap` crashed with exit 1 and leaked a tmp dir. | fix |
| 1 | 2026-10-04 | node-runner creates `--work` only after the artifact checks pass, so a class-2 refusal leaves the filesystem as it was. | fix |
| 1 | 2026-10-04 | `bake-snapshot --roots/--label/--initial-bytes` write the overlay fields of docs/EMBEDDING.md §8 into the entry (only when given); a malformed value exits 2 before anything is written. | additive |
| 1 | 2026-10-05 | Tier 3: `pipeline/snapshot/header-switch-probe.mjs` is deleted; its Mathlib probe, two-snapshot seeding and ACT4 headerless switch live in `resident-probe.mjs` behind `--mathlib`, `--snapshots <a,b>` and `--act4 [--act4-ms <ms>]`. No consumer named it (lean4game's sync list and the showcase's pin script checked). | tier 3, no promise |
| 1 | 2026-10-06 | preflight moved from `tests/adversarial/preflight.mjs` to `pipeline/release/preflight.mjs` (same flags, output and exit codes), shim at the old path: it runs the moved script after a stderr deprecation WARNING. Its two harness helpers (`resolveTarget`, `fetchJson`) moved to `pipeline/release/page-target.mjs` (the harness re-exports them). It ships in the package with `cli.mjs`, `cli.d.mts` and `supervised-run.mjs`, so every Tier 1/2 tool is in `files` and closure.json `pipeline`. | moved, shim at the old path |
| 1 | 2026-10-06 | olean-imports gains `--entries <olean file>` (one `entries of <file>: <JSON>` line, a new marker) and the module export `oleanExtEntryCounts`; the usage line becomes `olean-imports.mjs (--audit <olean tree> \| --entries <olean file>)`. `--audit` output and exits are unchanged. | additive |
| 1 | 2026-10-06 | Fix: the main guards of preflight, olean-imports and `cli.mjs` (and the old-path preflight shim) compare realpaths, as release-manifest already did. Through a symlinked install (`file:` dependency, `npm link`, a workspace, pnpm) Node loads the main module by its realpath while `argv[1]` keeps the symlink path, so these tools printed nothing and exited 0 there; they now run. G2 (`npm run test:consumer`) runs each one's `--help` through the consumer's `node_modules/qed64` symlink. olean-imports' readers (`oleanImportEntries`, `oleanImports`, `oleanExtEntryCounts`) accept any `Uint8Array` as their .d.mts says; a plain one returned null before. | fix, no flag or output change |
| 1 | 2026-10-06 | Docs (plan step A2c): this document's consumer statements follow the consumers' repositories: lean4game's `qed64-dep` lane runs the packaged tools and its `wasm64-port` branch still vendors them; the showcase runs them from its submodule `deps/qed64` (it no longer vendors `pipeline/snapshot/`, olean-imports or unpack). The re-pin rule names both lean4game pins and the showcase's `pins/<id>/QED64.lock.json`. The library side of the same step (`qed64/embed`'s pruned barrel, `embedApiRevision` in `dist/qed64-build.json`) touches no tool: release-manifest's `--dist` check reads `schema`, `shell` and `buildId` and ignores the new key. | docs, no flag or output change |
| 2 | 2026-10-06 | Plan step A3a, **the path rule** ("Path resolution"): every path flag of bake-snapshot (`--artifact`, `--work`, `--out`), node-runner (`--artifact`, `--work`), snapshot-probe (`--artifact`, `--lib`), persistent-probe (`--artifact`) and chunk-runtime (`--out`) resolves flag → variable → the old repo-relative default → exit 2, implemented once in `pipeline/toolchain/artifact-paths.mjs` (`toolPath`, `resolveToolPath`; that file was already in `files`, closure.json and both consumers' vendored sets). New variables: `QED64_WORK`, `QED64_STAGING`, `QED64_LIB_TREE`. New markers `deprecated-default` and `no-path` on those five tools. The same rule drives `gate.mjs` (`QED64_LEAN_ARTIFACT`; its old default, the cwd, is deprecated), resident-probe (`QED64_SNAP_DIR`), the compiler battery (`QED64_MATHLIB_SNAP`; `run.mjs` forwards `--snap/--artifact/--lib` and counts the battery's exit 2 as a refusal) and the integration tests (they skip, naming the variable). | additive (variables, markers) |
| 2 | 2026-10-06 | **Deprecated, one cycle:** each repo-relative default above (`pipeline/toolchain/work/build/stage1`, `work/snapshot`, `work/runner`, `work/lib-tree`, `work/staging/<buildId>/…`). Used, it prints exactly one `<tool>: WARNING — the default --<flag> … is deprecated; use --<flag> … or set <VARIABLE> (docs/CLI-CONTRACT.md)` per default and still works. It goes after both consumers re-pin past this commit; lean4game's bake lane omits `--work` and so sees one WARNING per bake until then. | deprecation (WARNING) |
| 2 | 2026-10-06 | **Breaking, so contract 2:** the sibling-checkout fallback of node-runner and persistent-probe (another project's stage1, two directories above the repo) is deleted with no shim: it pointed at someone else's checkout. With no flag, no variable and no default stage1, the five tools now exit 2 with `no-path` and the usage line; before, node-runner exited 2 naming the sibling path, persistent-probe and snapshot-probe crashed with exit 1, and bake-snapshot exited 2 with `no-artifact`. `QED64_LEAN_ARTIFACT=""` now counts as unset in bake-snapshot too (it meant the cwd). Neither consumer relied on either: both pass `--artifact`. | breaking (a default removed) |
| 2 | 2026-10-06 | `bake-snapshot --allow-legacy-imports`, the documented form of `QED64_ALLOW_LEGACY_IMPORTS=1` for the runner; the inherited variable stays accepted as its equivalent. node-runner, snapshot-probe and persistent-probe started without `--stack-size` re-exec themselves with `--stack-size=8192` through `process.execve` (same PID, stdio and exit code; "Runtime"); before, `npm run runner` and `gate.mjs`'s runs used V8's default stack. chunk-runtime runs git for the default `--revision` only when `--revision` is absent. snapshot-probe removes its scratch dir when the `--snap` link fails. | additive; fixes |
| 2 | 2026-10-06 | A3 review fixes. The compiler battery's path-rule refusal (exit 2) leaves a record: compiler.log in `--run-dir` and a fresh all-infra `compiler-report.json` in `work/adversarial/` and the run dir, with a `refused` field naming the `no-path` line, written before the exit (its pairing is a harness input, not a pipeline output; the five tools' "exit 2 before any side effect" is unchanged). Before, it exited 2 with nothing written, so `run.mjs`'s report.md dropped the lane and `resident-gate.sh` printed the previous run's tally. `run.mjs` shows a lane that ran and wrote no report as a `REFUSED`/`NO REPORT` line; `resident-gate.sh` removes the old report before the battery. The harness's `teeLog` appends synchronously, so lines printed just before an exit reach the log. README "Baking snapshots" and docs/REBUILD.md §2/§3 pass `--artifact`/`--work`/`--out`/`--lib` explicitly instead of relying on the deprecated defaults. | fix, no flag or tool-output change |
| 2 | 2026-10-06 | Plan step A3b: **fetch-artifacts**, a new Tier 1 tool (`pipeline/release/fetch-artifacts.mjs`, `npm run fetch:artifacts`, Node built-ins only, in `files` and closure.json `pipeline` with its `.d.mts`): fills a `public/`-shaped tree with every runtime chunk, profile pack part and snapshot `.snapz` the tracked manifests name, from a fork release (`--release`, checked against its `files[]` too) and a QED64 origin (`--origin`), each verified by sha256 and size and written by temp file + rename; one stdout line `FETCH OK …` / `FETCH FAILED …`. It replaces the retired `sync:artifacts`. The import-bound check in `tests/unit/cli-contract.test.ts` accepts `parseCli("<tool>", …)` with arguments (fetch-artifacts' `main(argv, io)` passes its own). | additive (a new tool) |
| 2 | 2026-10-06 | A3b review fixes, **fetch-artifacts**. An interrupted run no longer leaves temp files: SIGINT/SIGTERM delete the run's open `.<name>.<pid>-<random>.tmp` files and exit 130/143 with `FETCH FAILED interrupted (<signal>)` (new exit codes); before, Node exited at once and each in-flight temp file (up to four, a `.snapz` one up to 321 MB) stayed, gitignored and never reused. Every run first deletes the temp files a dead process left beside its targets, one new `removed` stderr marker each. The `failed` line is always one line: a newline in a reason (the snippet a JSON parse error quotes, for a release.json that is an HTML page) is folded into a space; before, it split the summary over two stdout lines. The module gains `oneLine`, `sweepStaleTemps`, `fetchArtifacts({ signal })` and `main(argv, io, { repoRoot, handleSignals })`; unit tests cover the default `--out` inside `node_modules` refusal (exit 2), the one-line summary, the stale sweep and SIGINT/SIGTERM as a process. | fix; additive (exit codes, a marker) |
| 2 | 2026-10-06 | Plan step A3c, **preflight**: a boot smoke that cannot start is the documented refusal. `import("playwright")` and `chromium.launch` moved inside the smoke's `try`, so a playwright that does not resolve from the script (a package installed without the caller's playwright beside it) prints `PREFLIGHT REFUSED: boot smoke: playwright not resolvable from the caller (<code>)` and exits 3, and a Chromium that does not launch refuses with its error; before, both escaped `runPreflight` (documented as never throwing) and the CLI crashed with exit 1 and a stack trace. `bootSmoke(url, budgetMs, { importPlaywright })` and `runPreflight(target, { importPlaywright })` take an injectable importer; `pipeline/release/preflight.d.mts` types `runPreflight`, `bootSmoke` and `main` and ships (in `files` and closure.json `pipeline`). Flags, markers and the other exits are unchanged. | fix (exit 1 → the documented 3); additive (an option, types) |
| 2 | 2026-10-06 | A3c review fixes, **preflight**. The `PREFLIGHT REFUSED: <reason>` line (and its `FAIL` line) is one line whatever the cause: newlines and box-drawing characters fold to single spaces before the 160-character cut, also in the console-tail entries, so a Chromium without its browser (`browserType.launch: Executable doesn't exist at …` plus Playwright's ASCII box) no longer prints stray stdout lines after the marker. `playwright not resolvable from the caller (<code>)` is now only for playwright itself (`Cannot find package\|module 'playwright'`); a missing dependency of it, such as `playwright-core` in a partial install (a CJS `MODULE_NOT_FOUND` through its index.js), is `playwright could not be imported (<code>): <first message line>`, which names the module. Exit 3 either way. | fix, no flag change |
| 2 | 2026-10-06 | Plan step A4a, recorded here for consumers: **no tool changed**. QED64's `scripts/deploy-app.sh` is not a contract tool (it is not in the package's `files` or closure.json); it became the only deploy path (`deploy.yml` calls it) and gained `--dry-run` and a one-line refusal (exit 1) when `dist/` keeps an artifact directory or a file over 25 MiB (docs/DEPLOY.md, "The deploy script"). lean4game's `scripts/deploy-app.sh` is its own file and is unaffected. | ops, no tool change |
| 2 | 2026-10-06 | A4a review fixes, recorded for consumers: **no tool changed**. QED64's `scripts/deploy-app.sh` documents that exit 1 is not only the size refusal: a failing step can exit 1 too (vite build does), and a refusal is the run whose stderr ends with a `deploy-app: REFUSED:` line. `tests/unit/deploy-script.test.ts` now also fails on a named or block `run:` step in `deploy.yml` and on any line there but the script's step that runs `build:site` or `typecheck:site`. | docs, no tool change |
| 2 | 2026-10-06 | Plan step A4b, recorded for consumers: **no tool changed**. QED64's `scripts/serve-dist.mjs` (`npm run preview:prod`) is not a contract tool (not in the package's `files` or closure.json). It became a Node adapter over the live Worker: requests go to `infra/worker.js`'s `fetch` with Node stand-ins for the `ASSETS` and `ARTIFACTS` bindings over `dist/` and `public/`, so local serving and the deployed Worker share one code path (docs/DEPLOY.md, "Local preview: the Worker's own code"). New variable `QED64_EDGE` (`legacy`, the default, or `hardened`; any other value exits 2 with the usage line before listening); the startup line gains ` edge=<mode>`. `PORT`, `DIST` and the local-only `/embed-host.html` are unchanged. Served headers move to the live site's: `text/html` without a charset, `/index.html` answers 307 to `/`, an empty asset 404, no `Content-Length` on a legacy HEAD. | ops, no tool change |
| 2 | 2026-10-06 | A4b review fixes, recorded for consumers: **no tool changed**. QED64's `scripts/serve-dist.mjs` `ASSETS` stand-in moves closer to the live Workers assets: a path with a run of slashes (`//assets/x.html`, `//assets/codicon.ttf`) collapses in one 307 to the rule's target (`/assets/x`) or to the collapsed path, where it used to send a protocol-relative `Location: //assets/x` (an open redirect) or serve a 200; no `Location` starts with `//`. `/index` and `<dir>/index` answer 307 to `/` and `<dir>/` instead of serving `index.html`. A file that stats but cannot be opened (`EACCES`, replaced mid-request) answers 500 `internal error` with the isolation headers and a log line instead of a 200 head on a reset connection; a body read error after the head is logged. | ops, no tool change |
| 3 | 2026-10-06 | Plan step B1a, **the forwards** (breaking, so contract 3): `pipeline/artifacts/unpack.mjs` (tier 2) keeps its prelude, then prints one `unpack: WARNING — pipeline/artifacts/unpack.mjs is deprecated; use lean4-wasm64 unpack …` and runs the package's `unpack.mjs` with the same arguments; without the package it exits 2 (`no-package`) where it used to unpack. New flag `--slim` (the package's), new variable `LEAN4_WASM64_DIR`, new markers `deprecated` and `no-package`. `pipeline/artifacts/inspect.mjs` and `pipeline/toolchain/gate.mjs` (tier 3) forward the same way, gate after its `--artifact` path rule (["lean4-wasm64: the forwards"](#lean4-wasm64-the-forwards)). | breaking (exit 2 without the package); deprecation (WARNING) |
| 3 | 2026-10-06 | `bake-snapshot --runner <script>` (and `QED64_RUNNER`): the runner script, default QED64's own `node-runner.mjs` (not deprecated); a missing one refuses (`no-runner`, exit 2) before `<work>` is created. The runner is spawned with the bake's own Node (`process.execPath`) instead of PATH's `node`. | additive |
| 3 | 2026-10-06 | `pipeline/toolchain/gen-exports.py` moved to the fork (`wasm64-build/gen-exports.py` at `release.json` `kernel.commit`): the path stays one cycle (package.json `files`, closure.json `pipeline`) as a stub that prints `gen-exports: WARNING — moved to the fork: …` and exits 2. `pipeline/release/bump-chain.sh stage` (the in-repo build) refuses with one `BUMP-FAIL stage: …` line and exit 2; `stage-artifact` and `promote` are unchanged. The in-repo `setup-source.sh`, `build.sh`, `finish.sh`, `README.md` and the patch copies under `pipeline/toolchain/` are retired (provenance only; their removal is a separate step). | moved (stub); shell lane refusal |
| 3 | 2026-10-06 | The runtime floor (closure.json `runtime.minKernelPatch`, plain `NNNN`) is checked against the pinned release record `toolchain/lean4-wasm64-release.json` (its `kernel.patch`, lean4-wasm64's `comparePatchIds` ordering; its self-digest; the devDependency URL and lockfile naming that release) instead of a tracked `pipeline/toolchain/patches/` file. | test, no tool change |
| 3 | 2026-10-06 | B1a review fixes, **the forwards.** unpack forwards only the arguments its prelude accepted: an unknown flag or a stray argument is warned about once (before, the package's identical prelude printed the same WARNING again after the `deprecated` line). `LEAN4_WASM64_DIR` must name the package (its `package.json` name is `lean4-wasm64`): a dir that is not refuses with one new `not-package` line, exit 2 (before, a dir holding QED64's own forwards made the forward re-exec itself forever on one PID); a `<pkg>/<script>` that is the running script refuses the same way. Without `process.execve` the forward spawns the package's script asynchronously, passes SIGINT/SIGTERM/SIGHUP on and exits with 128 + the signal for a signalled child (before: a blocking `spawnSync`, exit 1 for a signal death, and an orphaned child when the forward was killed). The walk's skip of a wrong-name or unreadable `node_modules/lean4-wasm64` is tested to continue to the real package above. | fix; additive (a marker) |
| 3 | 2026-10-06 | unpack's `done` regex gains an optional `--slim` group: `… → (.+?)(?: \(--slim: (\d+) \*\.olean\.private left out\))?$`. Group 4 is the out dir with or without `--slim` (before, it captured the suffix too), group 5 the count. Every line the old regex matched still matches with the same groups 1-4 when there is no suffix. Markers may carry more `examples`, each checked like `example`. | additive (a regex group) |
| 3 | 2026-10-06 | Deleted: `pipeline/toolchain/setup-source.sh`, `build.sh`, `finish.sh`, `README.md` and the 35 patch copies under `pipeline/toolchain/patches/` (provenance only; never in package.json `files` or closure.json, called by no consumer: the build and its series are the fork's `wasm64-build/`, docs/REBUILD.md §1). `pipeline/toolchain/PATCHES.md` keeps its path (persistent-probe's PARSE-ERROR-SWALLOWED line names it) as a pointer to the fork's series and the pinned record. README's layout row and provenance paragraph point at docs/REBUILD.md §1. | removed (unused); docs |
| 3 | 2026-10-06 | Plan step B2b, recorded for consumers: **no tool changed**. QED64's `infra/worker.js` reads `/runtime/*` and `/profiles/<not index.json>` from the toolchain release's R2 prefix `lean4-wasm64/<id>/` (decision 3; the id from `toolchain/lean4-wasm64-release.json`), with a one-cycle fallback to the bucket root; the library `qed64/edge` gains the additive `release`/`releaseFallback` options (docs/history/EMBEDDING-PRE-V1.md, the B2b row). `scripts/serve-dist.mjs` (not a contract tool) maps the release keys to `QED64_RELEASE_DIR` or `public/` and names `release=<id>` in its startup line; `scripts/upload-artifacts.sh` (not a contract tool) uploads only the site-owned snapshots and `profiles/index.json`, refuses (exit 3) when the release is not in R2 or the shell is of another runtime, keeps the old root upload behind `--legacy-root`, and gains `DRY_RUN=1` (docs/DEPLOY.md, "The toolchain release prefix"). | ops/library, no tool change |
| 3 | 2026-10-06 | Plan step B2a, **chunk-runtime forwards** to `lean4-wasm64 chunk` (breaking: without the package it now exits 2 with `no-package` where it used to chunk; contract 3 from B1a). It keeps its flags, defaults, path rule, `public/` refusal and WARNINGs, then prints one `chunk-runtime: WARNING — pipeline/toolchain/chunk-runtime.mjs is deprecated; use lean4-wasm64 chunk --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string> …` and hands the package all four flags (`--upstream-base` only feeds the default `--revision`, never forwarded). New markers `deprecated` and `no-package`; `file` and `done` are the package's lines (same format). The default revision's git call no longer prints git's stderr. QED64's own callers, `pipeline/release/import-packs.sh` and `bump-chain.sh`, are deleted: `pipeline/release/adopt-release.sh` adopts a release (no chunker, no restamp; docs/REBUILD.md §3). | breaking (exit 2 without the package); deprecation (WARNING); removed (two shell lanes) |
| 3 | 2026-10-06 | Plan step B2c, **release-manifest ships** (tier 3, `pipeline/release/release-manifest.mjs` and `.d.mts` in `files` and closure.json `pipeline`; relative and `node:` imports only). Its output `qed64.release/v1` gains `toolchain`, `hosting` and `baseTree` after `kernel`, and `shell.apiRevision`/`shell.embedApiRevision` (additive keys; `kernel` keeps its shape, its commit now the record's `kernel.commit`); its inputs are `toolchain/lean4-wasm64-release.json` and `embedding/base-tree.json` instead of `pipeline/toolchain/KERNEL-PIN`, with new refusals (docs/RELEASE-BUNDLE.md). Flags: `--toolchain-record` and `--base-tree` (with `--worktree`) and `--repo <checkout>` (the shipped copy reads a QED64 clone) are new; `--kernel-pin` is removed (now an unknown argument, exit 2). G2 runs the shipped copy through the consumer's symlink. | additive (output keys, a shipped tool); a flag removed (tier 3) |
| 3 | 2026-10-06 | **`pipeline/toolchain/KERNEL-PIN` is deleted** (plan B2c) in the commit that first ships `toolchain.kernel.commit`, as the widgets showcase asked: its pin tool reads the release manifest's `toolchain.kernel.commit` and `toolchain.releaseId` from such a commit, and `git show <commit>:pipeline/toolchain/KERNEL-PIN` only for older pins. `adopt-helper.mjs kernel-pin` and adopt-release's kernel-pin step go with it; the landing copies `$W/base-tree.json` to `embedding/base-tree.json` instead. No contract tool read the file. | removed (a tracked file; no tool change) |
| 3 | 2026-10-06 | Plan step B2c, **write-bundle**, a new tier 3 tool, not shipped (`pipeline/release/write-bundle.mjs --commit <rev> --dist <dir> --umbrella <dir> --out <dir> [--repo <dir>]`, Node built-ins and `./release-manifest.mjs`): writes `release.json`, `qed64-shell.tar.gz`, `qed64-manifests.tar.gz`, `umbrella/QED64/…` and `SHA256SUMS`, byte-reproducible (Node-written ustar, pinned gzip header). Exit 1 on a refusal (one `write-bundle: REFUSED:` line), 2 on usage or an occupied `--out`. | additive (a new tool) |
| 3 | 2026-10-06 | Plan step A5, **docs/config only: no tool changed**. A consistency pass over this document: chunk-runtime's tier row and the tier-3 list mark every forward (`chunk-runtime`, `unpack`, `inspect`, `gate.mjs`) and the `gen-exports.py` stub; no Consumers list names a deleted script or the old README any more (node-runner's no longer lists QED64's `gate.mjs`, which forwards to the package's gate; unpack's no longer lists the README); the Runtime notes say which gates spawn node-runner. The repository's `.claude/launch.json` dev entry matches Vite's port 5184 (`strictPort`). | docs/config only |
| 3 | 2026-10-06 | **snapshot-probe's watchdog** (the QED64 side of the kernel's patch 0037, HARDENING #61): from 0037 on a task that never finishes hangs `lean_wasm_compile`, which blocks the probe's main thread. A worker thread in the probe process now keeps a wall-clock deadline, new flag `--watchdog-ms <ms>` (default `--budget-ms` + 120000; `0` = no watchdog, as before): past it, one new `watchdog` line (also a `fail` line), then the process SIGKILLs itself (the status is killed by SIGKILL, not an exit code). A malformed `--watchdog-ms` is exit 2. No child process: the PID, the stdio, every line of a run that reaches a verdict, its exit code and per-PID measures (`/usr/bin/time -l`) are unchanged, and a verdict reached before the deadline is never followed by the `watchdog` line. | additive (a flag, a marker, a kill status) |
| 3 | 2026-10-08 | HARDENING #64, **fetch-artifacts** also writes the per-build copies of the two site-owned indexes a pinned shell reads when the mutable one names another runtime: `snapshots/index.<buildId>.json` (group `snapshots`, named by the one runtime the index's entries name) and `snapshots/profiles-index.<buildId>.json` (group `profiles`, named by the index's `runtime.buildId`), from the tracked indexes' own bytes like `runtime/runtime-manifest.<buildId>.json`; each is one more `wrote` (or `present`) line and counts in `FETCH OK`'s totals. An index whose entries name no runtime, or several, gets no copy. Flags, markers and exits are unchanged. Also: release-manifest (tier 3) refuses a present copy that is not byte-identical to its index (no new field: the manifest's format and `artifactSetId` are unchanged); `promote-staging.mjs`, not a contract tool, writes the same two copies. | additive (two written files); a refusal |
| 3 | 2026-10-08 | HARDENING #64 follow-up, **bake-snapshot** writes the per-build copy `<out>/index.<buildId>.json` (exactly the new `index.json`'s bytes, buildId = this bake's runtime; another runtime's copy untouched) and prints one new line after `baked`, marker `index-copy`. The upsert runs under `<out>/index.json.lock` (never taken over: a held lock is waited for at most 120 s, then exit 1 naming its holder and printing the unindexed entry) and switches both files by temp file + rename, the copy first and `index.json` last (side effect 8); before, `index.json` was rewritten in place with no lock. Flags, the other markers and the exits are unchanged; `promote-staging.mjs` (not a contract tool) ignores the staged copy and switches `public/`'s from the staged index, which for a bake's index is the same bytes. | additive (a written file, a marker) |
| 3 | 2026-10-09 | HARDENING #66, **snapshot-probe** sets the runtime's environment at preRun. It passed `ENV` in the Module literal, which the Emscripten glue replaces (`var ENV={}`, then `Module["ENV"]=ENV`), so `QED64_PROFILE_INIT` was never forwarded (this table's row said it was) and `LEAN_PATH` was unset (the sysroot gave the same `/lib/lean` root). Now `LEAN_PATH=/lib/lean` reaches getenv as in node-runner and the browser worker, and `QED64_PROFILE_INIT` does when set. Flags, markers and exits are unchanged; found by the kernel while porting the probe (its 0249065cc0). | fix (a documented variable now works) |
| 3 | 2026-11-01 | Docs and one test, recorded for consumers (architecture review R9a): **no tool changed**. (1) The consumer statements follow the consumers' repositories (checked 2026-11-01): lean4game's `wasm64-port` runs the installed package (its `sync-qed64.sh` copy was retired 2026-10-05), and of these tools only bake-snapshot and snapshot-probe; it passes `--probe --roots --work` and no longer sets `QED64_ALLOW_LEGACY_IMPORTS`. (2) The proof sheets run bake-snapshot, require its `baked` line (`grep -E '^baked '` under pipefail) and die on a non-zero exit; they are named as a consumer, in the Frozen `baked` row and in the re-pin rule. (3) "Adding a relative import to a file a downstream vendors one by one" is no longer breaking, and `tests/unit/cli-contract.test.ts` drops its vendoring check. (4) The inline preludes stay until the next runtime adoption. (5) The `--runner` row records that a bake through the package's runner was byte-identical on Lean 4.34 (2026-10-08), not yet on 4.35. | docs, no tool change |
| 3 | 2026-11-01 | Tier 3, **write-bundle is deleted** (architecture review D11; the bundle half of decision 7 is retired): `pipeline/release/write-bundle.mjs`, its `.d.mts` and `tests/unit/write-bundle.test.ts`, and adopt-release's landing step 7. It was never shipped (not in `files` or closure.json) and never published; no consumer ran it. Its umbrella byte check moved into `adopt-release.sh` (`adopt-helper.mjs umbrella`, R6a), and the umbrella's off-host copy is the committed `embedding/umbrella/QED64/` (D9). release-manifest, fetch-artifacts and verify-release are unchanged; docs/RELEASE-BUNDLE.md keeps the manifest's guide and "Stable field paths" and drops "The bundle" and the CI proposal. No shim. | tier 3, removed |
| 3 | 2026-11-01 | Architecture review R3, tier 3: `resident-probe.mjs` and `thread-storm-probe.mjs` import `public/workers/worker-constants.js` and run the page's resident command line and thread setup (`_lean_init_task_manager_using(leanWorkers(os.availableParallelism()))`, `LEAN_WASM_PARKED_DEDICATED` at preRun, `-DElab.async=false`); before, they ran `--worker -Dserver.reportDelayMs=0` under the hardware-default task manager with no parking. resident-probe gains `--lean-option <name=value>` (repeatable; merged as the page merges `leanOptions`; a malformed one, or a name given twice, exits 2) and `--option-check` (the document `def idA (x : α) : α := x` passes only when Lean reports α unknown; refused with `--mathlib`, `--act2` or `--act4`), and its verdict JSON gains `argv` and `optionError`; its usage line gains both flags. thread-storm-probe gains `--max-churn` (the setup before: hardware-default task manager, no parking, Lean's own `Elab.async`), which HARDENING #52's lost-wakeup recipe names, and its result records `threads` (`page` or `max-churn`), `argv` and `taskManagerWorkers`. | tier 3, no promise |
| 3 | 2026-11-01 | Architecture review R4, tier 3: `resident-probe.mjs --probe-file <file>` runs one document as the page does (act 1 only, no EXPERIMENT requests; `--snapshots` defaults to `init,mathlib`; the page's argv, so `--lean-option` applies), prints `resident: reached elaboration` at the first non-empty fileProgress and, once progress has stayed drained for `--settle-ms` (default 5000; a kind-2 `fatalError` entry, which a refused header leaves standing, counts as drained, as in the page's front door), the final diagnostics (with `--dump-messages`, one `{"caption":"",…}` JSON line each: severity by name, 1-based lines, LSP's UTF-16 columns) and `compile: tag=0 elapsed=<ms> errors=<n>`, then exits 0 whatever the document's errors; the budget, an abort or an exit before the settle is `RESIDENT PROBE FAIL {…}`, exit 1. Refused with `--mathlib`, `--act2`, `--act4` or `--option-check`, a missing file or a bad `--settle-ms` (exit 2); the usage line gains the three flags. The compiler battery gains `--transport compile\|fileworker` (default `compile`, unchanged): `fileworker` spawns resident-probe with `--snap-dir` = `--snap`'s directory and `--snapshots init,<--snap's name>`, writes each item without the alias rewrite, skips `COMPILE_ONLY` (`mathlib-name-shadow-faithful-compile`, logged `skip <name> (compile path only)`), refuses `--probe` (exit 2) and treats a missing `init.snap` beside `--snap` as the all-infra refusal (exit 3); its report gains `transport` and its pass line reads `compiler battery (fileworker): N/M passed` (the compile lane's line is unchanged). | tier 3, no promise |
| 3 | 2026-11-01 | Architecture review D2, **fetch-artifacts** no longer writes the per-build index copies `snapshots/index.<buildId>.json` (group `snapshots`) and `snapshots/profiles-index.<buildId>.json` (group `profiles`) that the 2026-10-08 row (HARDENING #64) added. QED64's site serves its two indexes from each deploy (docs/DEPLOY.md "Atomic deploys"), and nothing reads a local copy: a dev server or a served build answers the tracked, paired indexes, so a shell never asks for one. That is one `wrote`/`present` line fewer for each of the two groups, and `FETCH OK`'s totals no longer count those files (a full run is two files smaller). The digest-named `runtime/runtime-manifest.<buildId>.json` is still written. Copies an earlier run left under `--out` are left alone (never touched or deleted, like any file no manifest names). Flags, markers, defaults and exits are unchanged; neither downstream runs the tool. Also recorded, no tool change: `scripts/deploy-app.sh` (not a contract tool) keeps `dist/{profiles,snapshots}/index.json` and runs `scripts/deploy-guard.mjs` before `wrangler deploy`; `scripts/upload-artifacts.sh` uploads only the `.snapz` the index names and overlay directories. | removed output (no consumer); ops |
| 3 | 2026-11-01 | Architecture review D2, tier 3: **release-manifest** no longer refuses a present per-build index copy (`public/snapshots/index.<buildId>.json`, `public/snapshots/profiles-index.<buildId>.json`) that is not byte-identical to the index it copies, the refusal the 2026-10-08 row (HARDENING #64) added. No shell reads a copy of QED64's indexes any more (they ship in each deploy, docs/DEPLOY.md "Atomic deploys"), so a stale local copy is ignored like any untracked file. Flags, output fields, the manifest's format and `artifactSetId` are unchanged. Also recorded, not a contract tool: `promote-staging.mjs` writes neither copy (copies an earlier promote left are left alone) and still ignores the bake's staged copy; bake-snapshot's `index-copy` (tier 1) is unchanged. | a refusal removed (tier 3); ops |
| 3 | 2026-11-01 | Architecture review R11a (QED64 half), **deprecated, one cycle:** snapshot-probe's path loader `lean_wasm_load_snapshot`. Without `--via-mem` (the default) or with `--via-memfs`: one stderr WARNING (new marker `deprecated-loader`) after the path rule, before any side effect; the run is otherwise unchanged. Flags, the other markers and exits are unchanged; every executed caller already passes `--via-mem` (the compiler battery, the showcase's `exact-header.mjs`, lean4game's `--verify-snapshots`). Removal (the two branches deleted, `--via-mem` the only loader, a contract bump) after both lean4game and the showcase re-pin past this row. Also: TESTING.md's probe row and adopt-release's printed slim-bake recipe pass `--via-mem`, and the help and the script's comments name `lean_wasm_load_snapshot_mem` as the browser's path (they called the path loader, and `--via-memfs`, the worker's). | deprecation (WARNING) |
| 3 | 2026-11-01 | Review fixes, **bake-snapshot** (the kernel copy's rules, architecture review D4 a): an unreadable or corrupt `index.json` is refused (exit 2 before the runner; exit 1 under the lock, the entry printed) instead of being read as empty and rewritten without its siblings; the pairing is re-checked under the lock; the runner is spawned with no output buffer (execFile's 64 MiB `maxBuffer` killed it) and an environment of exactly `PATH`, `HOME`, `TMPDIR` and the bake's variables (a host `LEAN_PATH` replaced `--lib`); a runner killed by a signal the bake did not send, or exiting non-zero, is exit 1 with one line (before: success for a signal, an unhandled rejection otherwise); SIGINT/SIGTERM/SIGHUP are forwarded and the bake exits 130/143/129 without an index write (before: the runner was orphaned); the `.snapz` temp is `<name>.snapz.<pid>.tmp`; a failed compression or index write is one line and exit 1. New markers `refuse-index-unreadable`, `refuse-index-corrupt`, `runner-signal`, `runner-exit`; the `baked`, `index-copy`, `reaped` and refusal lines are unchanged. | fix; additive (exit codes, markers) |
| 3 | 2026-11-01 | Architecture review D4, option (a): **QED64 owns the bake** (the kernel copy's extras, ported as behaviour). **bake-snapshot** takes `<work>/.bake.lock` (one bake per `--work`: two bakes sharing it baked each other's `probe.lean` and the runtime's `<name>.snap.tmp.<pid>` and could exit 0 with a wrong snapshot), holding the bake's pid and then its runner's; a held lock is exit 2 (`work-locked`, naming both pids), never taken over; it is released at exit and kept when the runner is still running. It removes stale `<name>.snap.tmp.*` files under the lock (one `removed the stale …` line each), refuses a `--name` outside `[A-Za-z0-9][A-Za-z0-9._-]*` (`refuse-name`) and an explicit `--lib` that is not a directory (`no-lib`; before, the runner failed on it after the paired `.snap` was unlinked), both exit 2 before any side effect, gains `--entry-fields <json object>` (more entry keys after the page fields; a core key, a page field or a reserved `raw`/`lib`/`bakedBy` refuses, exit 2), and prints a `build environment: node …, zlib …, shared zlib …` line (`build-env`) after `baking`. The index's writer rules move from the fork's `formats/snapshot-index.md` to [SNAPSHOT-INDEX.md](SNAPSHOT-INDEX.md); the Ownership paragraph under Tiers names the owners. The `baked`, `index-copy`, `reaped` and refusal lines are unchanged. | fix; additive (a flag, markers, exit-2 refusals) |
| 4 | 2026-11-01 | Architecture review R5a, **bake-snapshot finishes when its `.snap` is complete**: it polls every `--stable-ms` (new, default 5000) and stops the runner once `<work>/<name>.snap` has the same size at two polls (before: 300 s without output and 120 s of a stable size, about 4.5 min of every bake). **Breaking, so contract 4:** the stdout marker `reaped` (`bake output stable … — reaping the wedged exit`) becomes `completed` (`bake output complete … — stopping the runner`). The rename follows the report's approved R5a without a deprecation window (stability policy): no consumer parses it (lean4game `wasm64-port`, the proof sheets `website-v4.35` and the showcase `port-lean-4.35` grepped). New guards: a failure line (the new classifier, SPEC `classifier`) with no `.snap` and no save in progress for `--quiet-ms` (new, default 120000) ends the bake with `failed-quiet` and `no-snap`, exit 1 (before: a header Lean rejects waited forever); `--give-up-ms` (new, default 21600000) ends any bake with `gave-up`, exit 1; a malformed value of the three is exit 2 before any side effect. The `baked`, `index-copy` and refusal lines, exit 0's meaning (not a Lean verdict) and the runner's argv are unchanged. | breaking (a marker renamed); additive (flags, markers); fix |
| 4 | 2026-11-01 | Architecture review D6, the notice (decided 2026-11-01), **bake-snapshot**: a failure line in a run whose `.snap` is complete prints the `notice` WARNING and one `verdict <json>` line on stderr before `compressing` (new markers `notice` and `verdict`; the verdict is `{"verdict":"failed","kind":…,"stream":…,"line":…,"name":…,"bytes":…}`); the bake still compresses, indexes and exits 0. After every consumer (lean4game, the proof sheets, the showcase) re-pins past this row, at the next runtime release, such a bake exits **1** without compressing or indexing and keeps the raw `.snap` (contract 5). Exit 1 by the user's decision, not the report's new code 3: 3 stays the infrastructure refusal, and the `verdict` line tells a Lean failure from a runner crash. Open decision 3 is decided. QED64's `adopt-release.sh` fails on a `verdict` line now (its slim audit's manual "zero errors" check goes). No other line, flag or exit changes; a bake without a failure line prints nothing new. | deprecation (notice) |
| 4 | 2026-11-01 | **The forwards and the gen-exports stub are removed** (architecture review R9a; deprecated since contract 3, 2026-10-06). (1) Removed: `pipeline/artifacts/unpack.mjs` and `pipeline/toolchain/chunk-runtime.mjs` (tier 2), `pipeline/artifacts/inspect.mjs` and `pipeline/toolchain/gate.mjs` (tier 3) and `pipeline/toolchain/gen-exports.py`. They leave the repository, package.json `files` and closure.json `pipeline`, together with their SPECS, the `LEAN4_WASM64_DIR` entry of `ENV` (no tool of this contract reads it; adopt-release.sh still takes it as its `--tools` default) and `forwardToLean4Wasm64`/`lean4Wasm64Dir`/`LEAN4_WASM64_TGZ_HINT` in `artifact-paths.mjs`, and `forwarded` leaves `CliMarker` in `cli.d.mts`; `QED64_STAGING` is read by bake-snapshot only. (2) Instead, run `node <lean4-wasm64>/cli.mjs unpack\|chunk\|inspect\|gate` (["lean4-wasm64: the forwards"](#lean4-wasm64-the-forwards)). `npm run inspect:pack` runs `lean4-wasm64 inspect`. bake-snapshot's `refuse-public` regex keeps its `chunk-runtime` alternative (frozen). (3) Consumers: none runs any of the five (lean4game `wasm64-port`, the proof sheets `website-v4.35` and the showcase grepped 2026-11-01). lean4game (73d7f3b), the proof sheets (c512c21) and the showcase's candidate pin O (521cf3f) carry the deprecation WARNINGs. The showcase's live pin H (bf9d947) predates them, but it runs none of the five. Shares contract 4 with the R5a row above (one bump). | breaking (tools removed after their window) |
| 4 | 2026-11-01 | Architecture review M3 (Phase B1; the kernel accepted `org.lean-browser64.runtime/v2` 2026-11-01): **fetch-artifacts** reads a v2 runtime manifest as well as v1 (an absent `schema` is v1). A v2 file names its `encoding` (`gzip` or `identity`, a closed set) and every chunk its `decodedBytes`: each part is verified as served, then a gzip part is inflated to its `decodedBytes` and the whole-file pin is checked over the inflated bytes. New refusals (2, before any request or write): a runtime manifest schema it does not read, a v2 file without a known `encoding` or a v1 file with one other than `identity`, a v2 part without a positive `decodedBytes`, a part but the last that does not decode to exactly 16,777,216 bytes (the last to more), `decodedBytes` that do not sum to the file's `bytes`, an `identity` part whose `decodedBytes` is not its `bytes`. New failures (1): a gzip part that does not inflate, or inflates to another size; with `--release`, a release whose `runtime.schema` (additive in `lean4-wasm64.release/v1`, absent = v1) is not the tracked manifest's. Flags, markers and the `verified` line are unchanged; a v1 run is unchanged. verify-release (not a contract tool; Node built-ins only) reads v2 the same way and prints one new `runtime manifest: schema` line and one encoding line per file. | additive (an accepted format); refusals |
| 4 | 2026-11-01 | Architecture review M3 (Phase B2, beside the worker's v2 reader), tier 3: **release-manifest** describes an `org.lean-browser64.runtime/v2` runtime manifest as well as v1 (`RUNTIME_MANIFEST_SCHEMAS` adds v2, still equal to closure.json `runtime.manifestSchemas`). For v2 only, `runtime.files[]` gains `encoding` (after `sha256`) and each chunk `decodedBytes` (after `sha256`); a v1 runtime's section, and so `artifactSetId`, are byte-identical. New refusals (exit 1): a v2 file whose `encoding` is not `gzip` or `identity`, a v1 file that names an `encoding`, a v2 chunk whose `decodedBytes` is not a positive integer, not exactly 16,777,216 for a chunk but the last (more than that for the last), or not its `bytes` for `identity`, v2 chunks that do not decode to the file's `bytes` ("chunks decode to …"), and a record whose `runtime.schema` (additive in `lean4-wasm64.release/v1`, absent = v1) is not the served manifest's `schema`. The v9 refusal now names both schemas ("expected …/v1 or …/v2"); every v1 message is unchanged. Flags and the other output keys are unchanged. | additive (an accepted format, v2-only output keys); refusals |
| 4 | 2026-11-01 | Architecture review R4 follow-up (the stage-2 review of the FileWorker lane), tier 3: the **compiler battery** gains `--settle-ms <ms>`, passed to resident-probe as `--settle-ms <ms>` (after `--dump-messages`) under `--transport fileworker`. Without it the battery passes none and resident-probe keeps its 5000 default, so the lane's argv is unchanged. The settle (and the probe's 500 ms exit) is part of every item's wall time: at the fixed 5 s the wait dominated a wall-time comparison of the two lanes. `--settle-ms` under `--transport compile` (the default; that lane has no settle), and a value that is not a number of milliseconds >= 0 or is missing, exit 2 with the usage line and a fresh all-infra `compiler-report.json` whose `refused` names it (its `transport` recorded), like the battery's other flag refusals; the usage line gains `[--settle-ms 5000]` inside `--transport`'s brackets. resident-probe's flags, output lines and exits are unchanged (the kernel's R10 gate parses them). | tier 3, no promise |
| 4 | 2026-11-01 | Kernel review R10 follow-up (accepted by the kernel 2026-11-01): **resident-probe's gate surface is tier 2** ("Tiers"); the rest of the tool stays tier 3. The lean4-wasm64 gate (block 7, in the fork's tools from the v4.36 cut on) runs it from QED64's checkout: `--artifact`, `--snap-dir`, `--budget-ms`, `--mathlib`, `--snapshots init` and the `init` / `init,mathlib` defaults, `--probe-file` with `--dump-messages` (found by the text `--probe-file` in the script), the `{"caption":"",…}` lines, the `compile: tag=0 …` line, the `RESIDENT PROBE PASS\|FAIL <json>` line with its keys `why`, `diagnostics`, `frames`, `nonFrameStdoutBytes`, `wallMs` and `argv`, exits 0 / 1 / 2, and `nonFrameStdoutBytes` 0 for the Init run. A change to any of them is told to the kernel session before it lands. `[WASM LSP] header <mode>: key=#[…]` is the runtime's line, information only. No flag, line or exit changes (`resident-probe.mjs` and its `DIAGNOSTIC` entry in `pipeline/snapshot/cli.mjs` gain only comments saying so); `tests/unit/tool-paths.test.ts` pins the surface with a fake glue. | additive (a stronger promise) |
| 4 | 2026-11-02 | Review fix (R5a), **bake-snapshot**: `--stable-ms`, `--quiet-ms` and `--give-up-ms` (new in this contract) take at most 2147483647 ms, Node's timer limit (a larger `--stable-ms` was clamped to a 1 ms poll with a TimeoutOverflowWarning and a false `completed` line); a larger value is the same exit-2 refusal, and every such refusal line now ends `, at most 2147483647`. | a refusal (contract-4 flags) |
| 4 | 2026-11-02 | Recorded late (architecture review D1, 8e0f9a7), tier 3: **fileworker-exit-probe** drops `--scenario batch-eval-exit` (the page's only batch compile, the warm header, left the library); `exit`, `eval-exit` and `shutdown-exit` are unchanged. | tier 3, no promise |
| 4 | 2026-11-02 | Recorded late (architecture review D2, 14562fa), tier 3: **release-manifest** `--dist` accepts `profiles/index.json` and `snapshots/index.json`, the two indexes the deploy carries, when each is byte-identical to the tracked `public/` file, and refuses one that is not ("the deploy would serve another pairing's index"); any other `runtime/`, `profiles/` or `snapshots/` path is still refused. | tier 3; a refusal added |
| 4 | 2026-11-02 | Review fix (R16, lane L2), tier 3: the **compiler battery**'s `--messages-dir` files no longer carry snapshot-probe's failure tail (its last Lean lines again, indented and cut short), so two runs of one transport diff with no dedupe. | tier 3, no promise |
| 4 | 2026-11-02 | Architecture review R4 item 4: **resident-probe's surface is tier 1 and the tool ships in the package** (SPECS, `files`, closure.json `pipeline`). The surface is the gate's (kernel R10, tier 2 until now), `--settle-ms`, what the proof sheets' planned call adds (`--lib`, `--lean-option`, any `--snapshots` list: a relabel) and, as for every tool under the path rule, `QED64_LEAN_ARTIFACT` and the rule's two stderr lines; `--act2`, `--act4`, `--act4-ms`, `--option-check`, `QED64_SNAP_DIR` and the log lines stay tier 3, and `--help` labels the flags. No flag, line, verdict key or exit changed: `--help`/`-h` is the one addition, and the tool keeps its own parser ("How the tools bind"). The tool's section words exit 2 as what is really refused; "a missing file" overclaimed, because a missing `.snap` never was, and it names an absent `--lib` tree as what it is, an exit-1 crash with no verdict line. The proof sheets have not adopted the tool yet. The battery's R4 lane stays opt-in and tier 3; thread-storm-probe stays tier 3. | additive |
| 4 | 2026-11-03 | **The old-path preflight shim is removed** (the user's decision of 2026-11-03; deprecated since contract 1, 2026-10-06, b4ff462). `tests/adversarial/preflight.mjs` leaves the repository; it was never in `files`, closure.json or `exports`, so no installed package held it. Instead, run `node pipeline/release/preflight.mjs`, with the same flags, output and exit codes; that script and its `main()` export stay. Consumers (read 2026-11-03): lean4game `wasm64-port` and the proof sheets do not run this tool, and they pin 73d7f3b and 37ff491 (`website-v4.34`) or c512c21 (`website-v4.35`), which carry the WARNING. The showcase differs by branch. On `port-lean-4.35` and `release-routing` (not pushed; active locally, pin O 521cf3f, which has this path), `scripts/preflight-overlays.sh` and `tests/experiments/x1-preflight.mjs` take this path from each pin's own tree, and fall back to the old path only for pins before 385a1ac, each of which holds the real script there. Its pushed `main` (d60b15e, live pin H bf9d947) hard-codes the old path, and that pin's tree holds the real script. So this removal cannot reach either. The showcase carries the WARNING only on those unpushed branches (pin H does not), and a re-pin on `main` past this commit needs their lookup, because the old path will hold nothing. | breaking (a shim removed after its window; no new bump: fd95a2a is contract 4 with the shim, this commit contract 4 without) |

## Open decisions

These are recorded here, not decided:

1. **Make unknown flags fatal** (exit 2) after one re-pin cycle of WARNINGs.
   A typo such as `--wrok` currently falls back to the default, and for
   bake-snapshot the default `--work` is the paired set.
2. **Give a wasm ABORT its own exit code** in node-runner, snapshot-probe and
   persistent-probe, so that 3 means only "infrastructure refusal". The
   compiler battery and the showcase's exact-header read the text, not the
   code, but it is still a breaking change.
3. **Decided 2026-11-01 (D6): bake-snapshot exits 1 when the runner printed
   a Lean failure line**, using its own classifier (supervised-run's rule
   scoped to probe.lean). A notice now (the `notice` and `verdict` lines),
   exit 1 after one re-pin cycle, at the next runtime release; see
   bake-snapshot, "Lean failure lines". The showcase's `judge-bake.mjs`
   exists because it does not yet (its J1 regex and J3's exit half can go at
   the flip).
4. **Moot since 2026-10-05.** lean4game runs the installed package instead
   of vendoring the tools, so the inline preludes can become imports of
   `cli.mjs`; that is batched with the next runtime adoption ("How the tools
   bind").
5. **Turn crashes on unreadable inputs into class-2 refusals.**
   persistent-probe crashes on an explicit artifact that is missing, and
   snapshot-probe on a missing or cross-device `--snap` (it no longer leaks
   its scratch dir there). The path rule's own refusal (`no-path`) is class 2
   already.
6. **Unify path resolution.** bake-snapshot's `--work`/`--out` resolve a
   relative flag value against the repo root, and everything else (variables
   included) against the cwd. Unifying
   them is breaking. Once the deprecated defaults are gone (next cycle), the
   repo root matters only for these relative values.
7. **Switch to last-wins for repeated flags,** the common convention.
   First-wins is the legacy behaviour.
