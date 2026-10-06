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
  own process: node-runner, snapshot-probe and persistent-probe. bake-snapshot
  and supervised-run start their runner with that flag themselves, so a plain
  `node` is enough for them.
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

The prelude runs right after the imports. For olean-imports it runs inside the
main-module check, so importing the module stays side-effect-free. The
prelude rewrites `--flag=value` into `process.argv` as the two-token form, and
drops the later occurrences of a repeated value flag, so the script's own
legacy parser reads it unchanged and sees only the first value.

Only supervised-run and preflight import `parseCli` at run time. No downstream
copies either of them without `cli.mjs`: the showcase runs them from its
submodule beside `cli.mjs`, and preflight runs in place from the QED64 checkout or the
installed package (`cli.mjs`, `supervised-run.mjs` and `preflight.mjs` are in
`files` and in closure.json's `pipeline` list, with every Tier 1/2 tool;
`tests/unit/package-contract.test.ts` checks it).

After you edit SPECS, run `node pipeline/snapshot/cli.mjs --write-preludes`.
The unit test fails on drift. It also fails when a file downstream vendors one
at a time imports a file that downstream does not vendor.

### Path resolution

Relative paths resolve against the **current working directory**, with these
exceptions, which resolve against the **repo root** (the directory two levels
above the script): bake-snapshot's `--work` and `--out`, and chunk-runtime's
`--out`. Several defaults also live under the repo root (each tool's table
says so). In a vendored copy, "the repo root" means the vendoring root, for
example `vendor/qed64/`.

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
| `QED64_LEAN_ARTIFACT` | bake-snapshot, node-runner, snapshot-probe, persistent-probe | The stage1 artifact dir when `--artifact` is absent. bake-snapshot tests it with `??`, so an *empty* value counts as set and resolves to the cwd. The others test it with `\|\|`, so empty counts as unset. |
| `LEAN_COMPACTOR_RESERVE` | node-runner (forwarded into the wasm env) | Bytes the compactor reserves up front for a whole-environment save (patch 0011). bake-snapshot **sets** it for its runner from `--reserve` and overrides any inherited value. |
| `QED64_ALLOW_LEGACY_IMPORTS` | node-runner (forwarded as `1`) | Lets the exported-level env cache load legacy non-module packages (patch 0030). lean4game's bakes set it, and bake-snapshot's runner inherits it. |
| `QED64_PROFILE_INIT` | node-runner, snapshot-probe (forwarded) | Profiles the `[init]` replay. |

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
usage: bake-snapshot.mjs [--name <name>] [--probe <lean source>] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--work <dir>] [--out <dir>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--name <name>` | `init` | Snapshot name: `<work>/<name>.snap`, `<name>.<digest16>.snapz` and the index entry. |
| `--probe <lean source>` | `#check (2 + 2 : Nat)` | The baked file. Its import lines become the entry's `imports`, which is the env-cache key. |
| `--artifact <dir>` | `$QED64_LEAN_ARTIFACT`, else `pipeline/toolchain/work/build/stage1` | The stage1 dir whose `bin/lean.wasm` bakes and is stamped as `runtime`. It is always passed to the runner. Resolves against the cwd. |
| `--lib <olean tree>` | the runner's `<artifact>/lib/lean` | The tree mounted at `/lib/lean`. Passed to the runner as given, so it resolves against the cwd. |
| `--reserve <bytes>` | `3758096384` (3.5 GiB) | `LEAN_COMPACTOR_RESERVE` for the runner. |
| `--work <dir>` | `work/snapshot` under the repo root | Holds the raw `.snap` and `probe.lean`. **The default is the PAIRED set** the probes and the compiler battery load: a bake for any other runtime must pass `--work`. Resolves against the repo root. |
| `--out <dir>` | `work/staging/<buildId>/snapshots` under the repo root | Holds the staged `.snapz` and `index.json`. Refused inside `public/`. Resolves against the repo root. |
| `--roots <A,B,…>` | none | Module roots the entry serves (docs/EMBEDDING.md §8): the page boots and widens to it for a header naming one. Absent: the legacy rule (an entry named `mathlib` serves the umbrella roots). |
| `--label <text>` | none | The entry's human name for the page's pill and boot card. |
| `--initial-bytes <bytes>` | none | The initial Memory64 commit when the entry is loaded (else 2 GiB with any non-base entry). |

- **Environment:** `QED64_LEAN_ARTIFACT`. `LEAN_COMPACTOR_RESERVE` is set for
  the runner. `QED64_ALLOW_LEGACY_IMPORTS` and `QED64_PROFILE_INIT` are
  inherited by the runner.
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

The runner's output (node-runner and Lean) is interleaved on both streams.

| Exit | Meaning |
|---|---|
| 0 | Baked and the index upserted. This includes the case where the wedged runner was reaped. **It is not a verdict on the probe's Lean messages:** the header snapshot is saved before Lean returns on errors. Judge the log, as the showcase's `judge-bake.mjs` does. |
| 1 | The runner exited non-zero (an unhandled `runner exited N`), or no `.snap` was produced. |
| 2 | Refused before the runner started: no `lean.wasm` under the artifact, `--out` inside `public/`, an index paired with another runtime or with none, or a malformed `--roots` / `--initial-bytes`. |

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
  `--name --artifact --lib --reserve --work --out --probe`.
- The showcase's `judge-bake.mjs` scans the whole log for reserved substrings
  (J1) and parses the `baked` line (J3).
- lean4game's `wasm/build-from-source.sh` bake lane runs its vendored copy.
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
| `--lib <tree>` | `work/lib-tree` under the repo root | The tree mounted at `/lib/lean`. |
| `--artifact <dir>` | `$QED64_LEAN_ARTIFACT`, else `pipeline/toolchain/work/build/stage1` | The dir holding `bin/lean.js` and `bin/lean.wasm`. |
| `--budget-ms <ms>` | `90000` | The compile budget. A slower compile means the load seeded the wrong env-cache key. |
| `--via-mem` | off | Streams the snapshot into a wasm-malloc'd buffer and loads it with `lean_wasm_load_snapshot_mem`: the browser's path. |
| `--via-memfs` | off | Copies the snapshot into MEMFS in 64 MiB chunks first. |
| `--init-flags <n>` | `1` | Replay-control flags for `--via-mem` (patch 0016). |
| `--workspace <dir>` | — | Mounted at `/workspace`, the compile's cwd. Game probes need `.lake/gamedata`. |
| `--dump-messages` | off | Echoes every line Lean prints on stdout as `[lean:stdout] <line>`. |

- **Environment:** `QED64_LEAN_ARTIFACT`, `QED64_PROFILE_INIT`.
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

| Exit | Meaning |
|---|---|
| 0 | `SNAPSHOT PROBE PASS`. |
| 1 | `SNAPSHOT PROBE FAIL`: the load failed, the probe has errors, or it blew the budget. Also a crash before the runtime started, such as an unreadable `--probe-file` or a missing `lean.js`. |
| 2 | Usage: no snapshot source, or no probe. |
| 3 | The wasm runtime aborted (the legacy overload). |

**Side effects:**

1. `mkdtemp <os.tmpdir()>/qed64-snap-probe-*`.
2. **Hard-links** `--snap` into that dir. `--snap` must therefore be on the
   same filesystem as the OS tmpdir, or the link fails with exit 1.
3. Writes `probe.snap.deps` next to the link.
4. Boots wasm. With `--via-mem` it also allocates the snapshot's full size in
   the wasm heap.
5. Removes the scratch dir on exit.

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
dynamic import, not taken with `--no-boot`). As a module it exports
`runPreflight(target, opts)`, `bootSmoke(url, budgetMs)` and `main()`; the
target comes from `resolveTarget(url)` in `pipeline/release/page-target.mjs`.

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
| 3 | `PREFLIGHT REFUSED`: the lane must not run. |

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
| `--artifact <dir>` | `$QED64_LEAN_ARTIFACT`, else `pipeline/toolchain/work/build/stage1` if it has `bin/lean.js`, else `../../wasm64-lean-codex/experiments/lean4-wasm64-build/stage1` (both relative to the repo root) | The dir holding `bin/lean.js`, `bin/lean.wasm` and `lib/lean`. |
| `--work <dir>` | `work/runner` under the repo root | Mounted read-write at `/work`, which is Lean's cwd. Created if absent. |
| `--lib <dir>` | `<artifact>/lib/lean` | Mounted at `/lib/lean`. |
| `[--] <lean args…>` | — | Lean's own arguments (see "Passthrough"). |

- **Environment:** `QED64_LEAN_ARTIFACT`. `LEAN_COMPACTOR_RESERVE`,
  `QED64_ALLOW_LEGACY_IMPORTS` and `QED64_PROFILE_INIT` are forwarded into
  the wasm environment.
- **Inputs:** the artifact, `--lib`, and whatever Lean reads under `/work`.
- **Outputs:** whatever Lean writes under `/work`, such as `-o` oleans and
  `--incr-header-save` snapshots, plus Lean's own output.

| Marker | Stream | Regex |
|---|---|---|
| abort | stderr | `^ABORT: (.*)$` |
| no-lean-js | stderr | `^error: (.+) not found — pass --artifact or set QED64_LEAN_ARTIFACT$` |
| no-lib | stderr | `^error: (.+) not found$` |

| Exit | Meaning |
|---|---|
| 0 | Lean exited 0. This is rare: since patch 0031 the process normally stays alive after `main` returns. |
| 1 | Lean's own non-zero exit code, passed through when the process does exit. |
| 2 | `lean.js` or the library tree was not found. |
| 3 | The wasm runtime aborted (the legacy overload). |

**Side effects:**

1. Checks the artifact and the library tree first.
2. Creates `--work` (`mkdir -p`) only once both exist.
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
| `--artifact <dir>` | the same chain as node-runner | The stage1 dir. Its `lib/lean` is mounted at `/lib/lean`. |

- **Environment:** `QED64_LEAN_ARTIFACT`.
- **Inputs:** the artifact.
- **Outputs:** stdout and stderr only.

| Marker | Stream | Regex |
|---|---|---|
| pass | stdout | `^PERSISTENT PROBE PASS$` |
| fail | stderr | `^PERSISTENT PROBE FAIL: (.*)$` |
| parse-swallowed | stdout | `^PARSE-ERROR-SWALLOWED ` |
| parse-fixed | stdout | `runtime defect is FIXED` |
| abort | stderr | `^ABORT: (.*)$` |

| Exit | Meaning |
|---|---|
| 0 | `PERSISTENT PROBE PASS`. |
| 1 | `PERSISTENT PROBE FAIL`, or the artifact is unreadable (an unhandled ENOENT before the runtime starts). |
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
| `--revision <string>` | `qed64-wasm64@<HEAD of pipeline/toolchain/work/lean4> (base <upstream-base>)`, else `unspecified` | The manifest's `sourceRevision`. |
| `--upstream-base <sha\|tag>` | `5732b84` | Named in the default `--revision`. |
| `--out <dir>` | `work/staging/<buildId>/runtime` under the repo root | The staging dir. Refused inside `public/`. Resolves against the repo root. |

- **Environment:** none.
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

| Exit | Meaning |
|---|---|
| 0 | Chunked. |
| 1 | A crash: `lean.js` or `lean.wasm` is unreadable under `--bin`. |
| 2 | Usage, or `--out` inside `public/`. |

**Side effects:**

1. Spawns `git -C pipeline/toolchain/work/lean4 rev-parse` for the default
   revision. It does this on every run, because the default is evaluated
   eagerly; the path is relative to the cwd, and git's complaint can appear
   on stderr.
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
   persistent-probe and chunk-runtime crash on a missing artifact or bin,
   unpack on an unreadable manifest, and snapshot-probe on a cross-device
   `--snap`.
6. **Unify path resolution.** bake-snapshot's `--work`/`--out` and
   chunk-runtime's `--out` resolve against the repo root, and everything else
   against the cwd. Unifying them is breaking.
7. **Switch to last-wins for repeated flags,** the common convention.
   First-wins is the legacy behaviour.
