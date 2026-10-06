# The pipeline CLI contract

The pipeline's command-line tools are an interface: two downstream projects
run them and parse what they print. How each one gets them (checked
2026-10-06 in their repositories):

- **lean4game** runs them in its from-source lane (`wasm/build-from-source.sh`).
  On its `qed64-dep` branch they come from the installed package
  (`"qed64": "github:FawadHa1der/QED64#<sha>"`; every Tier 1/2 tool is in the
  package's `files`, docs/EMBEDDING.md §6), run from a copy of
  `node_modules/qed64`. Its deployed `wasm64-port` branch still vendors eight
  of them file by file (`scripts/sync-qed64.sh`; olean-imports is in its
  optional list), which is why the inline preludes below exist.
- **The widgets showcase** runs them in place from the QED64 sources it pins:
  the git submodule `deps/qed64` at the active pin's commit, or that pin's
  worktree (`scripts/lib/qed64-src.mjs`; nothing is copied). It judges bakes
  and probes by their log lines.

This document states what those consumers may rely on. In the "Consumers"
lists below, "vendored" means lean4game's `wasm64-port` copy; the same lane on
`qed64-dep` runs the packaged file.

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
| **2: internal-stable** | Same rules, but the consumers are QED64's own scripts and lean4game's from-source lane. A breaking change still needs a changelog row, and a lean4game re-pin (of its vendored copy or of its package pin). |
| **3: diagnostic** | No promise. They may change or disappear without notice. |

| Tool | Script | npm alias | Tier | `--help` wiring |
|---|---|---|---|---|
| [bake-snapshot](#bake-snapshot) | `pipeline/snapshot/bake-snapshot.mjs` | `bake:snapshot` | 1 | inline prelude |
| [snapshot-probe](#snapshot-probe) | `pipeline/snapshot/snapshot-probe.mjs` | — | 1 | inline prelude |
| [supervised-run](#supervised-run) | `pipeline/snapshot/supervised-run.mjs` | — | 1 | imports `cli.mjs` |
| [preflight](#preflight) | `pipeline/release/preflight.mjs` (shim at `tests/adversarial/preflight.mjs`) | — | 1 | imports `cli.mjs` |
| [fetch-artifacts](#fetch-artifacts) | `pipeline/release/fetch-artifacts.mjs` | `fetch:artifacts` | 1 | imports `cli.mjs` |
| [olean-imports](#olean-imports---audit----entries) | `pipeline/artifacts/olean-imports.mjs` | — | 1 | inline prelude (inside the main-module check) |
| [node-runner](#node-runner) | `pipeline/snapshot/node-runner.mjs` | `runner` | 2 | inline prelude |
| [persistent-probe](#persistent-probe) | `pipeline/snapshot/persistent-probe.mjs` | — | 2 | inline prelude |
| [chunk-runtime](#chunk-runtime) | `pipeline/toolchain/chunk-runtime.mjs` | — | 2 | inline prelude |
| [pack](#pack) | `pipeline/artifacts/pack.mjs` | `pack` | 2 | inline prelude |
| [unpack](#unpack) | `pipeline/artifacts/unpack.mjs` | — | 2 | inline prelude |

Tier 3 tools: `pipeline/snapshot/{thread-storm-probe,fileworker-exit-probe,resident-probe}.mjs`,
`pipeline/artifacts/inspect.mjs`. (`header-switch-probe.mjs`, an edited copy of
resident-probe, was folded into it on 2026-10-05 as `--snapshots <a,b>`,
`--mathlib` and `--act4 [--act4-ms <ms>]`.)

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
  SIGKILLs its PID (supervised-run, bake-snapshot, `gate.mjs`'s timeout) still
  sees and reaps one process; nothing is orphaned (`tests/unit/tool-paths.test.ts`
  pins the PID, the stdio, the exit code and the SIGKILL). An explicit
  `--stack-size` of any size is respected. Where `process.execve` is missing
  (Windows) or the tool was forked with an IPC channel, one stderr WARNING says
  to run it as `node --stack-size=8192 …` and the tool continues as before.
  bake-snapshot and supervised-run start their runner with the flag
  themselves, so a plain `node` is enough for them; the re-exec is for direct
  runs, `npm run runner`, and `gate.mjs`, which spawns node-runner and
  persistent-probe without it.
- Since toolchain patches 0020 and 0031, the one-shot Lean CLI does its work
  and then **never exits** (HARDENING #47). Whatever runs node-runner judges
  the job by its output and reaps the process. bake-snapshot and
  supervised-run do this; `gate.mjs` uses a timeout.

### Argument grammar

There is one implementation of the grammar, `cliContract` in
`pipeline/snapshot/cli.mjs`.

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
  decisions"). The format follows the house style of the existing
  `chunk-runtime: WARNING — …` lines.
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

`cli.mjs` lives in `pipeline/snapshot/` because the showcase used to vendor
that directory whole (it now runs the tools from its submodule). lean4game's
`wasm64-port` branch is different: it vendors `bake-snapshot`,
`node-runner`, `snapshot-probe`, `persistent-probe`, `chunk-runtime`, `pack`,
`unpack` and `olean-imports` **one file at a time**, and its sanity check
refuses any relative import it did not copy. Those scripts therefore carry a
**generated inline prelude** between `// <cli-contract>` and
`// </cli-contract>`. The prelude holds the verbatim source of `cliContract`,
the tool's compact spec and its help text. (The showcase vendored
olean-imports and unpack one file at a time before it moved to the
submodule; the preludes keep any one-file copy self-contained.)

The prelude runs right after the imports (in node-runner, snapshot-probe and
persistent-probe right after `ensureStackSize`, which prints nothing; see
"Runtime"). For olean-imports it runs inside the main-module check, so
importing the module stays side-effect-free.

The path rule and the stack-size re-exec live in
`pipeline/toolchain/artifact-paths.mjs`, which bake-snapshot and
chunk-runtime imported already and which node-runner, snapshot-probe,
persistent-probe, `gate.mjs` and resident-probe now import too. Both
consumers vendor that file (lean4game's `PIPELINE` list, the showcase's
submodule), so the one-by-one copies stay self-contained; the unit test's
vendoring check covers it. The
prelude rewrites `--flag=value` into `process.argv` as the two-token form, and
drops the later occurrences of a repeated value flag, so the script's own
legacy parser reads it unchanged and sees only the first value.

Only supervised-run, preflight and fetch-artifacts import `parseCli` at run
time. No downstream copies any of them without `cli.mjs`: the showcase runs
them from its submodule beside `cli.mjs`, and preflight and fetch-artifacts
run in place from the QED64 checkout or the installed package (`cli.mjs`,
`supervised-run.mjs`, `preflight.mjs` and `fetch-artifacts.mjs` are in `files`
and in closure.json's `pipeline` list, with every Tier 1/2 tool;
`tests/unit/package-contract.test.ts` checks it).

After you edit SPECS, run `node pipeline/snapshot/cli.mjs --write-preludes`.
The unit test fails on drift. It also fails when a file downstream vendors one
at a time imports a file that downstream does not vendor.

### Path resolution

Since contract 2 (2026-10-06) every path a tool reads or writes comes from
**one rule**, implemented once (`toolPath` / `resolveToolPath` in
`pipeline/toolchain/artifact-paths.mjs`: Node built-ins only, no relative
imports, in `files` and closure.json `pipeline`, and vendored one by one by
both consumers already, so importing it adds no file to their copies):

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
levels above the script): bake-snapshot's `--work` and `--out`, and
chunk-runtime's `--out`. The deprecated defaults live under the repo root too.
In a vendored copy, "the repo root" means the vendoring root, for example
`vendor/qed64/`; in an installed package it is the package root inside
`node_modules`, which is why the defaults go.

The next cycle removes step 3: a tool with neither the flag nor the variable
then always takes step 4. lean4game's bake lane omits `--work` today (its
`$QED64_DIR/work/snapshot` is the deprecated default, and its snapshot probe
reads `<that>/<name>.snap`), so it sees one WARNING per bake until it passes
`--work` or sets `QED64_WORK`.

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
| `QED64_LEAN_ARTIFACT` | bake-snapshot, node-runner, snapshot-probe, persistent-probe (and `gate.mjs`, the compiler battery, resident-probe, the integration tests) | The stage1 artifact dir when `--artifact` is absent. An empty value counts as unset everywhere (before contract 2 bake-snapshot counted it as set, meaning the cwd). |
| `QED64_WORK` | bake-snapshot, node-runner | The dir mounted at `/work` when `--work` is absent: bake-snapshot's raw `<name>.snap` and `probe.lean`, node-runner's Lean cwd. |
| `QED64_STAGING` | bake-snapshot, chunk-runtime | A staging root when `--out` is absent: `--out` is `<QED64_STAGING>/<buildId>/snapshots` (bake-snapshot) or `<QED64_STAGING>/<buildId>/runtime` (chunk-runtime). `public/` is still refused. |
| `QED64_LIB_TREE` | snapshot-probe (and the compiler battery) | The olean tree mounted at `/lib/lean` when `--lib` is absent: the tree the probed snapshot was baked from. `pipeline/release/bump-chain.sh` reads the same name for the fat tree it bakes from. |
| `LEAN_COMPACTOR_RESERVE` | node-runner (forwarded into the wasm env) | Bytes the compactor reserves up front for a whole-environment save (patch 0011). bake-snapshot **sets** it for its runner from `--reserve` and overrides any inherited value. |
| `QED64_ALLOW_LEGACY_IMPORTS` | node-runner (forwarded as `1` when non-empty) | Lets the exported-level env cache load legacy non-module packages (patch 0030). The documented form is `bake-snapshot --allow-legacy-imports`, which sets it to `1` for the runner; an inherited value is its equivalent and stays accepted (both consumers' bake lanes set the variable). |
| `QED64_PROFILE_INIT` | node-runner, snapshot-probe (forwarded) | Profiles the `[init]` replay. |

The QED64 lanes outside SPECS use the same rule with their own variables:

| Variable | Read by | Meaning |
|---|---|---|
| `QED64_MATHLIB_SNAP` | `tests/adversarial/compiler-battery.mjs` (`--snap`) | The raw Mathlib `.snap` under test (deprecated default `work/snapshot/mathlib.snap`). With `QED64_LEAN_ARTIFACT` and `QED64_LIB_TREE` (deprecated defaults `pipeline/toolchain/work/build/stage1`, `work/lib-tree-slim`) it is the battery's pairing; `run.mjs` forwards `--snap/--artifact/--lib`. |
| `QED64_SNAP_DIR` | `pipeline/snapshot/resident-probe.mjs` (`--snap-dir`, tier 3) | The dir holding `<name>.snap` (deprecated default `work/snapshot`). |
| `QED64_INIT_SNAP` | `tests/integration/fileworker-exit.test.ts` | The init `.snap` (deprecated default `work/snapshot/init.snap`). The integration tests skip, naming the variable, when it or the artifact is absent. |

Other `QED64_*` variables belong to shell lanes, not to these tools:
`QED64_LEAN_VERSION`, `QED64_ARTIFACT`, `QED64_SNAP_WORK` and the rest are
documented in `pipeline/release/bump-chain.sh`, and `QED64_SLOW` in
docs/TESTING.md.

### Output streams and reserved substrings

Stable markers are matched **per line**. A marker's regex applies to one line
of the stated stream. Lean's own output passes through node-runner, and
through bake-snapshot and supervised-run (which pipe their runner), unchanged
and interleaved.

Downstream log judges grep whole logs for failure text: supervised-run's own
`FAILURE` classifier, the showcase's `judge-bake.mjs` (J1) and `run-e2.sh`.
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
usage: bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--allow-legacy-imports]
```

| Flag | Default | Meaning |
|---|---|---|
| `--name <name>` | `init` | Snapshot name: `<work>/<name>.snap`, `<name>.<digest16>.snapz` and the index entry. |
| `--probe <lean source>` | `#check (2 + 2 : Nat)` | The baked file. Its import lines become the entry's `imports`, which is the env-cache key. |
| `--artifact <dir>` | `$QED64_LEAN_ARTIFACT`, else (deprecated) `pipeline/toolchain/work/build/stage1` under the repo root when it has `bin/lean.wasm`, else exit 2 | The stage1 dir whose `bin/lean.wasm` bakes and is stamped as `runtime`. It is always passed to the runner. Resolves against the cwd. |
| `--lib <olean tree>` | the runner's `<artifact>/lib/lean` | The tree mounted at `/lib/lean`. Passed to the runner as given, so it resolves against the cwd. |
| `--reserve <bytes>` | `3758096384` (3.5 GiB) | `LEAN_COMPACTOR_RESERVE` for the runner. |
| `--work <dir>` | `$QED64_WORK`, else (deprecated) `work/snapshot` under the repo root | Holds the raw `.snap` and `probe.lean`. **The deprecated default is the PAIRED set** the probes and the compiler battery load: a bake for any other runtime must pass `--work`. Resolves against the repo root. |
| `--out <dir>` | `<$QED64_STAGING>/<buildId>/snapshots`, else (deprecated) `work/staging/<buildId>/snapshots` under the repo root | Holds the staged `.snapz` and `index.json`. Refused inside `public/`. Resolves against the repo root. |
| `--roots <A,B,…>` | none | Module roots the entry serves (docs/EMBEDDING.md §8): the page boots and widens to it for a header naming one. Absent: the legacy rule (an entry named `mathlib` serves the umbrella roots). |
| `--label <text>` | none | The entry's human name for the page's pill and boot card. |
| `--initial-bytes <bytes>` | none | The initial Memory64 commit when the entry is loaded (else 2 GiB with any non-base entry). |
| `--allow-legacy-imports` | off | Sets `QED64_ALLOW_LEGACY_IMPORTS=1` for the runner (patch 0030: the env cache loads legacy non-module packages, the lean4game games). An inherited `QED64_ALLOW_LEGACY_IMPORTS` does the same and stays accepted. |

- **Environment:** `QED64_LEAN_ARTIFACT`, `QED64_WORK`, `QED64_STAGING` (the
  path rule). `LEAN_COMPACTOR_RESERVE` is set for the runner.
  `QED64_ALLOW_LEGACY_IMPORTS` (or `--allow-legacy-imports`) and
  `QED64_PROFILE_INIT` are inherited by the runner.
- **Inputs:** `<artifact>/bin/lean.wasm` (whose sha256 gives the buildId),
  `<out>/index.json` if present, and the `--lib` tree.
- **Outputs:**
  - `<work>/<name>.snap`, the raw region. It is kept, because the probes load
    it.
  - `<work>/probe.lean`.
  - `<out>/<name>.<digest16>.snapz`, gzip and content-addressed.
  - `<out>/index.json` with the entry `{name, url, digest, bytes, transfer,
    imports, runtime}` upserted, plus `roots`, `label` and `initialBytes`
    when given.

| Marker | Stream | Regex |
|---|---|---|
| baking | stdout | `^baking (\S+)\.snap for runtime (\S+) \(probe: (.*); compactor reserve (\d+\.\d) GiB\) → (.+)$` |
| reaped | stdout | `^bake output stable \((\d+) bytes\) with runner quiet — reaping the wedged exit$` |
| compressing | stdout | `^compressing (\S+)\.snapz …$` |
| baked | stdout | `^baked (\S+\/([^/\s]+)\.([0-9a-f]{16})\.snapz) \((\d+) bytes transfer, (\d+) raw\); index updated \(imports: \[([^\]]*)\], runtime (\S+)\)$` |
| no-snap | stderr | `^FAIL: snapshot file was not produced$` |
| no-artifact | stderr | `^bake-snapshot: no lean\.wasm under (.+) — pass --artifact <stage1 dir>$` |
| refuse-public | stderr | `^(bake-snapshot\|chunk-runtime): refusing --out (.+): it resolves inside public\/\. ` |
| refuse-foreign | stderr | `^bake-snapshot: (.+) already holds entries for runtime (\S+) \((.*)\) — refusing to mix pairings$` |
| refuse-unpaired | stderr | `^bake-snapshot: (.+) holds entries with no runtime pairing \((.*)\) — rebake ` |
| deprecated-default | stderr | `^(\S+): WARNING — the default --(\S+) (.+) \((.+)\) is deprecated; use --\S+ \S+ or set (\w+) \(docs\/CLI-CONTRACT\.md\)$` (once per deprecated default used: `--artifact`, `--out`, `--work`) |
| no-path | stderr | `^(\S+): no --(\S+) given and (\w+) is unset(; the deprecated default (.+) (has no \S+\|is absent))? — pass --\S+ \S+ or set \w+$` (then `usage: …`, exit 2) |

The runner's output (node-runner and Lean) is interleaved on both streams.

| Exit | Meaning |
|---|---|
| 0 | Baked and the index upserted. This includes the case where the wedged runner was reaped. **It is not a verdict on the probe's Lean messages:** the header snapshot is saved before Lean returns on errors. Judge the log, as the showcase's `judge-bake.mjs` does. |
| 1 | The runner exited non-zero (an unhandled `runner exited N`), or no `.snap` was produced. |
| 2 | Refused before the runner started: no `--artifact`, `QED64_LEAN_ARTIFACT` or deprecated default (`no-path`), no `lean.wasm` under the artifact, `--out` inside `public/`, an index paired with another runtime or with none, or a malformed `--roots` / `--initial-bytes`. |

**Side effects, in order:**

1. Reads and hashes `<artifact>/bin/lean.wasm`.
2. Reads `<out>/index.json`. All refusals happen here, before anything is
   written.
3. Creates `<work>` (`mkdir -p`) and writes `<work>/probe.lean`.
4. **Unlinks `<work>/<name>.snap`.**
5. Spawns `node --stack-size=8192 node-runner.mjs --work <work> --artifact <artifact> [--lib <lib>] -- --incr-header-save=/work/<name>.snap /work/probe.lean`.
   For the Mathlib umbrella this runs about 20 minutes and needs about 11 GB.
6. Polls the `.snap` every 5 s. Once the output has been quiet for more than
   300 s and the `.snap` stable for more than 120 s, SIGKILLs the runner.
7. Creates `<out>` (`mkdir -p`), unlinks `<work>/<name>.snap.deps`, writes
   `<name>.snapz.tmp` and renames it to the final name.
8. Re-reads and rewrites `index.json`.

Older `.snapz` files are never deleted.

**Consumers:**

- The showcase's `scripts/bake.sh` runs it from the submodule with
  `--name --artifact --lib --reserve --work --out --probe` (all absolute) and
  `QED64_ALLOW_LEGACY_IMPORTS=1`.
- The showcase's `judge-bake.mjs` scans the whole log for reserved substrings
  (J1) and parses the `baked` line (J3).
- lean4game's `wasm/build-from-source.sh` bake lane runs its vendored copy
  (`wasm64-port`) or the packaged one (`qed64-dep`) with `--name --artifact
  --lib --reserve --out` and `QED64_ALLOW_LEGACY_IMPORTS=1`; it omits `--work`
  (the deprecated default, one WARNING).
- In QED64: `pipeline/release/bump-chain.sh` and `import-packs.sh` (they grep
  `^baked`), and `tests/unit/artifact-discipline.test.ts`.

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
| `--via-mem` | off | Streams the snapshot into a wasm-malloc'd buffer and loads it with `lean_wasm_load_snapshot_mem`: the browser's path. |
| `--via-memfs` | off | Copies the snapshot into MEMFS in 64 MiB chunks first. |
| `--init-flags <n>` | `1` | Replay-control flags for `--via-mem` (patch 0016). |
| `--workspace <dir>` | — | Mounted at `/workspace`, the compile's cwd. Game probes need `.lake/gamedata`. |
| `--dump-messages` | off | Echoes every line Lean prints on stdout as `[lean:stdout] <line>`. |

- **Environment:** `QED64_LEAN_ARTIFACT`, `QED64_LIB_TREE` (the path rule),
  `QED64_PROFILE_INIT`.
- **Inputs:** the `.snap`, the probe, the `--lib` tree and the artifact.
- **Outputs:** stdout and stderr only.

| Marker | Stream | Regex |
|---|---|---|
| load-header | stdout | `^== load snapshot: (\S+) \((\d+) bytes\) ==$` |
| load | stdout | `^load: tag=(\d+) scalar=(\S+) elapsed=(\d+)ms$` |
| compile | stdout | `^compile: tag=(\d+) elapsed=(\d+)ms errors=(\d+)$` |
| pass | stdout | `^SNAPSHOT PROBE PASS$` |
| fail | stderr | `^SNAPSHOT PROBE FAIL: (.*)$` |
| lean-stdout | stdout | `^\[lean:stdout\] (.*)$` (with `--dump-messages`; Lean's JSON messages) |
| abort | stderr | `^ABORT: (.*)$` |
| deprecated-default | stderr | `^(\S+): WARNING — the default --(\S+) (.+) \((.+)\) is deprecated; use --\S+ \S+ or set (\w+) \(docs\/CLI-CONTRACT\.md\)$` (`--artifact`, `--lib`) |
| no-path | stderr | `^(\S+): no --(\S+) given and (\w+) is unset(; the deprecated default (.+) (has no \S+\|is absent))? — pass --\S+ \S+ or set \w+$` |

| Exit | Meaning |
|---|---|
| 0 | `SNAPSHOT PROBE PASS`. |
| 1 | `SNAPSHOT PROBE FAIL`: the load failed, the probe has errors, or it blew the budget. Also a crash before the runtime started, such as an unreadable `--probe-file` or a missing `lean.js`. |
| 2 | Usage: no snapshot source, or no probe; or no `--artifact` / `--lib`, its variable unset and no deprecated default (`no-path`). |
| 3 | The wasm runtime aborted (the legacy overload). |

**Side effects:**

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
  and fail, `^ABORT:`, `load:`, `compile:` and `[lean:stdout]`.
- lean4game's `build-from-source.sh --verify-snapshots` (vendored).

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

- QED64's `pipeline/release/import-packs.sh` (the umbrella compile; it greps
  `: error|supervised-run`).
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

**Moved on 2026-10-06** from `tests/adversarial/preflight.mjs`. The old path is
a shim with the same flags, output and exit codes that also prints
`preflight: WARNING — tests/adversarial/preflight.mjs is deprecated; use
pipeline/release/preflight.mjs (docs/CLI-CONTRACT.md)` on stderr before
anything else. It goes after both consumers re-pin past it.

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
- The showcase's `scripts/preflight-overlays.sh` passes `--url [--no-boot]`
  (old path, through the shim, until it re-pins).
- The showcase's `tests/experiments/x1-preflight.mjs` (old path, likewise).

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
| `--release <dir\|url>` | none | A fork release in the served layout (`release.json`, schema `lean4-wasm64.release/v1`). `/runtime/*` and `/profiles/*` come from it through its `hosting.mount`; each file must also be listed in its `files[]` with the sha256 and size the tracked manifest pins. The release's `runtime.buildId` must be the tracked manifest's (when runtime is fetched). |
| `--origin <url\|dir>` | `https://qed64.fawadworkaddress.workers.dev/` | A QED64 site, or a served tree on disk: everything `--release` does not provide. Manifest URLs (`/runtime/chunks/…`) resolve against it, so an origin with a path prefix works. |
| `--only <groups>` | `runtime,profiles,snapshots` | A comma list of `runtime`, `profiles`, `snapshots`. |
| `--with-manifests` | off | Also writes the tracked manifests themselves into `--out`, for a tree that is not this checkout's `public/` (an upload, another server's root). |

What each group fetches, and against what it is verified:

| Group | Files | Verified against |
|---|---|---|
| `runtime` | every chunk of `runtime/runtime-manifest.json`, and `runtime/runtime-manifest.<buildId>.json` | each chunk's `sha256` and `bytes`, then each whole file (`lean.js`, `lean.wasm`) over its chunks in order. The digest-named copy is written from the tracked manifest's own bytes, never fetched. |
| `profiles` | the transport parts of every manifest `profiles/index.json` lists | each part's `digest` and `byteLength` as the profile manifest records them, then the whole transport's `digest` and `byteLength` |
| `snapshots` | every `.snapz` of `snapshots/index.json` | the entry's `digest` (the sha256 of the `.snapz` itself) and `transfer` (its size; `bytes` when an entry has no `transfer`) |

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
| wrote | stderr | `^fetch-artifacts: wrote (\S+) \((\d+) bytes, the tracked (\S+)\)$` (the digest-named runtime manifest; `--with-manifests`) |
| ok | stdout | `^FETCH OK (\d+) files, (\d+) bytes \((\d+) fetched, (\d+) already present\)$` (the only stdout line; the totals are the whole verified set) |
| failed | stdout | `^FETCH FAILED (.*)$` (the only stdout line, always one line: a newline in the reason, such as the snippet a JSON parse error quotes, is folded with the space around it into one space; the reason starts with the file it is about, when it is about one) |

| Exit | Meaning |
|---|---|
| 0 | `FETCH OK`: every file the manifests name is under `--out` with its pinned digest. |
| 1 | `FETCH FAILED`: a fetch failed (an HTTP status such as `404`, the network, 120 s without bytes), a size or digest mismatch, parts that do not assemble to their whole-file pin, or a release whose schema, `runtime.buildId` or `files[]` does not match. The run stops at the first failure; files verified before it stay. |
| 2 | `FETCH FAILED`, refused before any write: a malformed `--only`, a tracked manifest missing or malformed, a manifest URL outside its directory, a target outside `--out`, or the default `--out` inside `node_modules`. |
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
5. Re-reads each whole file's parts and checks the whole-file pin.
6. Writes the digest-named runtime manifest (and, with `--with-manifests`,
   the tracked manifests) the same way.

On SIGINT or SIGTERM the run deletes every temp file it has open at once,
stops its downloads and exits 130 or 143 with `FETCH FAILED interrupted
(<signal>)`. A second signal, or 5 s without the run ending, exits the same
way immediately. Rerunning resumes: files already verified are `present`.

Existing files that no manifest names are never touched or deleted, except
the dead process's temp files of step 2.

**Consumers:** the README's quick start and docs/TESTING.md ("a fresh clone
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

- QED64's `import-packs.sh` (it greps `^import-all audit|outside Init`).
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

**Consumers:** bake-snapshot, supervised-run, `pipeline/toolchain/gate.mjs`,
`tests/integration/runtime-smoke.test.ts` (through supervised-run, with
node-runner's own flags after `--`), and lean4game (vendored, through its gate
and bakes).

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

- `pipeline/toolchain/gate.mjs` checks for `PERSISTENT PROBE PASS` and
  `runtime defect is FIXED`.
- `tests/integration/persistent-path.test.ts`.
- lean4game (vendored).

### chunk-runtime

**Tier 2.** `node pipeline/toolchain/chunk-runtime.mjs …`

```
usage: chunk-runtime.mjs --bin <dir> [--lean-version v] [--revision sha] [--upstream-base sha] [--out dir]
```

| Flag | Default | Meaning |
|---|---|---|
| `--bin <dir>` | — | **Required.** The dir holding `lean.js` and `lean.wasm`. |
| `--lean-version <x.y.z>` | `4.33.0-pre`, with a WARNING on stderr | The manifest's `leanVersion`. Promote pairs packs against it. |
| `--revision <string>` | `qed64-wasm64@<HEAD of pipeline/toolchain/work/lean4, relative to the cwd> (base <upstream-base>)`, else `unspecified` | The manifest's `sourceRevision`. git runs only when the flag is absent. |
| `--upstream-base <sha\|tag>` | `5732b84` | Named in the default `--revision`. |
| `--out <dir>` | `<$QED64_STAGING>/<buildId>/runtime`, else (deprecated) `work/staging/<buildId>/runtime` under the repo root | The staging dir. Refused inside `public/`. Resolves against the repo root. |

- **Environment:** `QED64_STAGING` (the path rule).
- **Inputs:** `<bin>/lean.js` and `<bin>/lean.wasm`.
- **Outputs:**
  - `<out>/chunks/<file>.<sha20>.part-NNN`. Additive: existing files are kept.
  - `<out>/runtime-manifest.json` and `<out>/runtime-manifest.<buildId>.json`.

| Marker | Stream | Regex |
|---|---|---|
| file | stdout | `^(lean\.js\|lean\.wasm): (\d+) bytes, (\d+) chunks, sha256:([0-9a-f]{16})…$` |
| done | stdout | `^runtime (wasm64-[0-9a-f]{16}) → (.+)$` |
| no-version | stderr | `^chunk-runtime: WARNING — no --lean-version given` |
| refuse-public | stderr | `^(bake-snapshot\|chunk-runtime): refusing --out (.+): it resolves inside public\/\. ` |
| deprecated-default | stderr | `^(\S+): WARNING — the default --(\S+) (.+) \((.+)\) is deprecated; use --\S+ \S+ or set (\w+) \(docs\/CLI-CONTRACT\.md\)$` (`--out`) |

| Exit | Meaning |
|---|---|
| 0 | Chunked. |
| 1 | A crash: `lean.js` or `lean.wasm` is unreadable under `--bin`. |
| 2 | Usage, or `--out` inside `public/`. |

**Side effects:**

1. Without `--revision`, spawns `git -C pipeline/toolchain/work/lean4
   rev-parse` for the default revision; the path is relative to the cwd, and
   git's complaint can appear on stderr. (Before 2026-10-06 it ran on every
   run, the default being evaluated eagerly.) The default leaves with the
   toolchain lane (plan step B1).
2. Creates `<out>/chunks` (`mkdir -p`).
3. Writes the chunks and both manifests.

**Consumers:**

- QED64's `bump-chain.sh` and `import-packs.sh` (the restamp).
- lean4game's `build-from-source.sh` runtime lane (vendored).
- `tests/unit/artifact-discipline.test.ts`.

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

- QED64's `import-packs.sh`.
- lean4game's `build-from-source.sh` core lane (vendored).
- `tests/unit/{import-lane,pack-format,artifact-discipline}.test.ts`.

### unpack

**Tier 2.** `node pipeline/artifacts/unpack.mjs --manifest <file> --out <dir>`

```
usage: unpack.mjs --manifest <file> --out <dir>
```

| Flag | Default | Meaning |
|---|---|---|
| `--manifest <file>` | — | **Required.** A profile manifest. Its parts are read by basename from the same dir. |
| `--out <dir>` | — | **Required.** The tree to write. Files are added or overwritten, never deleted. |

- **Environment:** none.
- **Inputs:** the manifest and its transport parts.
- **Outputs:** the olean tree. The raw pack is inflated **in memory**: the
  essential pack is 3.5 GB.

| Marker | Stream | Regex |
|---|---|---|
| done | stdout | `^(\S+): unpacked (\d+) files, (\d+\.\d\d) GB → (.+)$` |
| fail | stderr | `^FAIL: (.*)$` |

| Exit | Meaning |
|---|---|
| 0 | Unpacked. |
| 1 | A part, the raw pack or a path failed verification. Also an unreadable manifest. |
| 2 | Usage. |

**Side effects:** creates dirs (`mkdir -p`) and writes files under `--out`.

**Consumers:**

- The README and QED64's `import-packs.sh`.
- lean4game's `build-from-source.sh` trees lane (vendored).
- The showcase (from the submodule; no script of it calls unpack today,
  checked 2026-10-06).

## Frozen: the flags and lines consumers parse

Everything below changes only under the stability policy. Each tool line is a
marker in SPECS (its regex is in the tool's section and checked against the
script by `tests/unit/cli-contract.test.ts`); each flag is in its SPEC.

| Frozen | Tool | Who parses or passes it |
|---|---|---|
| `--name --artifact --lib --reserve --work --out --probe`, and `--roots --label --initial-bytes --allow-legacy-imports` | bake-snapshot | the showcase's `scripts/bake.sh` (the first seven, absolute paths); lean4game's `build-from-source.sh` bake lane (`--name --artifact --lib --reserve --out`) |
| `QED64_ALLOW_LEGACY_IMPORTS=1`, the equivalent of `--allow-legacy-imports` | bake-snapshot (inherited by its runner), node-runner | both consumers' bake lanes set it |
| the `baked` line, and exit 0 meaning "baked" (not a Lean verdict) | bake-snapshot | the showcase's `scripts/judge-bake.mjs` J3; QED64's `bump-chain.sh` and `import-packs.sh` (`^baked`) |
| `--snap --fresh-import --probe-file --probe --lib --artifact --budget-ms --via-mem --init-flags --workspace --dump-messages` | snapshot-probe | the showcase's `scripts/headless/exact-header.mjs`; lean4game `--verify-snapshots`; the compiler battery |
| `SNAPSHOT PROBE PASS` (exit 0), `SNAPSHOT PROBE FAIL: …`, `load:`, `compile:`, `[lean:stdout] …`, `ABORT: …` | snapshot-probe | `exact-header.mjs` (verdict, fail reason, load and compile times, the JSON messages, the abort); the compiler battery; lean4game |
| `--target --quiet-ms --stable-ms --give-up-ms --`, and the runner arguments after `--` verbatim | supervised-run | the showcase's `scripts/headless/run-e2.sh`; `import-packs.sh`; `runtime-smoke.test.ts` |
| the last line `supervised-run: <why> (<n> s)` (`^supervised-run: `) and exits 0 / 1 / 2 | supervised-run | `run-e2.sh` (`grep -E '^supervised-run: ' … \| tail -1`); `import-packs.sh`; `runtime-smoke.test.ts` |
| `--url --no-boot --boot-budget-ms --run-dir` | preflight | the showcase's `scripts/preflight-overlays.sh` and `tests/experiments/x1-preflight.mjs`; `resident-gate.sh` |
| `PREFLIGHT OK buildId=… mode=… snapshots=…` (exit 0), `PREFLIGHT REFUSED: …` (exit 3), the `ok`/`warn`/`FAIL` check lines | preflight | the same, and `run.mjs` through `runPreflight` |
| `import-all audit of …` and `  outside Init/Std/Lean/Lake: N` | olean-imports `--audit` | the showcase's `scripts/stage-trees.mjs` G5; `import-packs.sh` |

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

QED64's own `gate.mjs` strips the `[DEBUG:PROGRESS]` and `[WASM DEBUG]` lines
before it judges Lean's output.

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
  - making a WARNING fatal;
  - adding a relative import to a file a downstream vendors one by one (it
    breaks lean4game's sync).
- **The deprecation window is one downstream re-pin cycle.** Ship the new
  behaviour alongside the old. Make the old form print a
  `<tool>: WARNING — … is deprecated; use … (docs/CLI-CONTRACT.md)` line,
  without reserved substrings. Add a changelog row. Remove the old form only
  after **both** lean4game (`client/src/wasm/vendor/QED64-PIN` on
  `wasm64-port`, the `qed64` SHA in `client/package.json` on `qed64-dep`) and
  the showcase (`pins/<id>/QED64.lock.json` and its submodule) have re-pinned
  to a QED64 commit that carries
  the warning.
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

## Open decisions

These are recorded here, not decided:

1. **Make unknown flags fatal** (exit 2) after one re-pin cycle of WARNINGs.
   A typo such as `--wrok` currently falls back to the default, and for
   bake-snapshot the default `--work` is the paired set.
2. **Give a wasm ABORT its own exit code** in node-runner, snapshot-probe and
   persistent-probe, so that 3 means only "infrastructure refusal". The
   compiler battery and the showcase's exact-header read the text, not the
   code, but it is still a breaking change.
3. **Make bake-snapshot exit 1 when the runner printed a Lean failure line**,
   using supervised-run's classifier. The showcase's `judge-bake.mjs` exists
   because it does not.
4. **lean4game could vendor `pipeline/snapshot/cli.mjs`** (in
   `PIPELINE_OPTIONAL`). The inline preludes would then become imports,
   saving about 60 generated lines per script.
5. **Turn crashes on unreadable inputs into class-2 refusals.**
   persistent-probe and chunk-runtime crash on an explicit artifact or bin
   that is missing, unpack on an unreadable manifest, and snapshot-probe on a
   missing or cross-device `--snap` (it no longer leaks its scratch dir
   there). The path rule's own refusal (`no-path`) is class 2 already.
6. **Unify path resolution.** bake-snapshot's `--work`/`--out` and
   chunk-runtime's `--out` resolve a relative flag value against the repo
   root, and everything else (variables included) against the cwd. Unifying
   them is breaking. Once the deprecated defaults are gone (next cycle), the
   repo root matters only for these relative values.
7. **Switch to last-wins for repeated flags,** the common convention.
   First-wins is the legacy behaviour.
