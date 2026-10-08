# Testing

## Gates and lanes

Three gates:
- **G0** (every change; no artifacts, no browser): `npx tsc --noEmit && npm
  test && npm run -s typecheck:site && npm run -s build:site && node
  pipeline/snapshot/cli.mjs --check-preludes && npm pack --dry-run --json >
  /dev/null`.
- **G1** (end to end; the fetched artifacts, a real browser): `npm run
  test:adversarial`, the page lanes, and the integration tier, from the
  table below.
- **G2** (the consumer's view): `npm run test:consumer`.

**Browser lanes run one at a time.** Each starts a Chromium that boots a
multi-GB runtime. Where several sessions share one machine, run every lane
marked "lock" through the host's browser lock (a FIFO wrapper outside this
repository that admits one browser lane at a time) and never `resident-gate.sh`,
which kills whatever listens on :5184. On a machine of your own, running them
one after another is enough. Between lanes the harness's cool-down
(`harness.mjs cooldown`, below) refuses while a headless Chromium is alive.

**What a lane is pointed at.** "Dev" means the Vite dev server, `npm run dev`
(http://localhost:5184/), or one started on another port with `PORT=<port>
npm run dev`. The lanes' default URLs are their historical ports, so pass
`--url`. "Served build" means `npm run build:site && npm run preview:prod`
(http://localhost:5185/, the live Worker's own code over `dist/` and
`public/`). Both need `npm run fetch:artifacts` first. Node lanes need the
paired build outputs of "Environment" below.

| Lane | Command | What it proves | Needs | Lock | Pass line (exit 0) |
|---|---|---|---|---|---|
| Unit (G0) | `npm test` | manifest validation with hostile inputs; pack and segmentation byte-exactness; installer stream failure classes; diagnostic parsing, the LSP front door and the framer (the real worker source in a VM); the relay against a fake session; artifact discipline; the CLI contract and the path rule; the edge worker; the package contract; the adversarial harness's pure helpers; the docs' links (`docs-links.test.ts`: every relative Markdown link in README.md and docs/, and every `docs/…` path cited in the code) | nothing (`frontend/node_modules` for its `typecheck:site` pretest) | no | vitest `Test Files … passed` |
| Integration | `npm run test:integration` | the real wasm64 runtime under Node: prelude parse, Init import + `numBits=64` + kernel-checked `rfl`, positioned errors and run verdicts (through `supervised-run`), `sorry`, the persistent path (init sequence, resident recheck, error-count return, survival after failure), the FileWorker exit hook | `QED64_LEAN_ARTIFACT`, `QED64_INIT_SNAP` (it skips, naming the variable, without them) | no (one heavy wasm Node at a time) | vitest `passed`, nothing skipped |
| Slow tier | `QED64_SLOW=1 npm run test:integration` | the 2,308-module `import Lean` closure; a snapshot bake produces a valid compacted region | as Integration | no | as Integration |
| Snapshot probe | `node pipeline/snapshot/snapshot-probe.mjs --artifact <dir> --lib <tree> --snap <file> --probe-file <lean>` | a baked snapshot loads through `lean_wasm_load_snapshot` (the worker's path) and the follow-up compile is an env-cache hit within a budget | a stage1 dir, a raw `.snap` and its tree | no | `SNAPSHOT PROBE PASS` |
| Release audit | `npm run verify:release` | every digest the browser will trust, re-derived from the bytes in `public/`, including the multi-GB raw packs | fetched artifacts | no | `RELEASE VERIFIED` |
| Mutation | `node tests/mutation/edit-coalescer-mutants.mjs [--only <substring>]` | every back-pressure rule of `lib/edit-coalescer.ts` is pinned: each deliberate wrong rule, applied to a copy under `work/embed/mutants`, fails the coalescer's and the session adapter's suites | nothing | no | `edit-coalescer-mutants: N/N killed` (1 = a survivor, 3 = the baseline fails) |
| Consumer (G2) | `npm run test:consumer -- --work <dir outside the repo>` | the packed tarball alone suffices: every `exports` key resolves from the extracted package (paths outside `exports` refused), `qed64/edge` and the olean reader load, and `tests/consumer/fixture/` (a `qed64/embed` page, docs/EMBEDDING.md §6.1's headless boot and worker staging, a `qed64/edge` Worker) type-checks and builds with the repo's tsc and Vite; the repo and its node_modules stay untouched | nothing (`--keep` keeps the run dir) | no | `CONSUMER CHECK PASS` |
| Suite | `npm run test:adversarial [-- --skip-compiler]` (`tests/adversarial/run.mjs`) | pretest (`typecheck:site`), its own Vite on :5187, preflight, the compiler battery, a cool-down, then e2e; one report directory per run | fetched artifacts; the battery's pairing (or `--skip-compiler`) | lock | `report: …/report.md`, exit 0 (3 = a lane refused, 1 = product failures) |
| Preflight | `node pipeline/release/preflight.mjs --url <page url> [--no-boot]` | the pairing the URL boots: manifest, every chunk (HEAD size, non-HTML type), the snapshot index and files, each entry's `runtime` against the manifest's `buildId`, the profile index, and one headless boot smoke | dev or served build | lock (no browser with `--no-boot`) | `PREFLIGHT OK buildId=… mode=… snapshots=…` (3 = `PREFLIGHT REFUSED: …`) |
| Compiler battery | `node tests/adversarial/compiler-battery.mjs [--snap <file> --artifact <dir> --lib <tree>] [--jobs 3]` | the corpus's must-succeed, must-error and golden-message cases against the Mathlib snapshot under Node, on the runtime the browser ships (`snapshot-probe --via-mem`, a bounded pool), with no PANIC anywhere | `QED64_MATHLIB_SNAP`, `QED64_LEAN_ARTIFACT`, `QED64_LIB_TREE` (else exit 2, a `REFUSED` record) | no browser (heavy: `--jobs` wasm Nodes) | `compiler battery: N/N passed` (3 = infra only) |
| e2e | `node tests/adversarial/e2e.mjs --url <dev url> [--only <name>]` | boot, golden message batteries, UI-glitch checks, editor action storms with recovery, the worker-kill drill, memory telemetry, speed budgets | dev | lock | `e2e: 23/23 passed` |
| Editing latency | `node tests/adversarial/editing-latency.mjs --url <dev url> [--rounds 3]` | header-switch, admit, body-edit, completion and error-clear times, read from `qed64.status()` facts only | dev | lock | `SUMMARY {…}` (3 = no header fact) |
| Crash gauntlet | `node tests/adversarial/crash-gauntlet.mjs <url> [minutes] [mixed\|imports]` | sustained example switches, garbage bursts and header flips: the page survives and the breaker does not halt | dev | lock | the step log, exit 0 (1 = page crash, 2 = halted) |
| Liveness faults | `node tests/adversarial/liveness-faults.mjs --url <dev url> [--only <scenario>]` | HARDENING #52's mailbox, kick, liveness probe and exit hook, each by fault injection into the live worker: mailbox-mode, idle-no-probes, long-silent-command, lost-wakeups-healed, wedge-recovery, exit-detected | dev | lock | `liveness-faults: 6/6 pass` |
| Page API | `node tests/adversarial/page-api.mjs --url <dev url> [--only <scenario>]` | `qed64.api` as an embedder uses it (docs/EMBEDDING.md §2–§4): code-top-level, embed-code, embed-setdoc, events, restart, bad-param | dev or served build (both answer `/embed-host.html`) | lock | `page-api: 6/6 pass` |
| InfoView actions | `node tests/adversarial/infoview-actions.mjs --url <dev url> [--only <scenario>]` | the InfoView's editor RPC on the real page (HARDENING #56): capability-flag, try-this-apply, conv-generate, foreign-show | dev | lock | `infoview-actions: 4/4 pass` |
| Reload storm | `node tests/adversarial/reload-storm.mjs --url <url> [--runs 5] [--embed] [--ballast-mb N] [--headed]` | five reloads 3 s apart per run, a fresh browser per run, `ready` again after them; a crash is classified by the V8 OOM line (HARDENING #53, #55); `--embed` reloads a same-origin host page around the frame; `--ballast-mb N` (with `--embed`) makes that host hold N MiB of live JS objects in the renderer's shared pointer cage, a heavy embedding page (#55 residual: 800 MiB crashes 8/8, 0 MiB 0/8) | dev or served build (stock and `--embed`) | lock | `RELOAD-STORM <tag>: 0/N crashed …` (1 = a crash, 3 = nothing booted) |
| Edit storm | `node tests/adversarial/edit-storm.mjs --url <served url> [--reps 2] [--scenarios …]` | an edit per keystroke over work that ignores cancellation: no crash, death or reboot, ready at the last version, the pool within tolerance (HARDENING #59; `?edithold=0` is the control arm) | served build | lock | `edit-storm: N/N pass` |
| Boot card | `node tests/adversarial/boot-card.mjs --url <served url> [--scenario slow-link\|check-fallback\|all]` | a cold first visit over a shaped link: the boot card shows progress the whole way, and the check fallback appears while an Init-only buffer elaborates (HARDENING #54) | served build | lock | `boot-card: N/N passed` |
| Unpaired snapshot | `node tests/adversarial/unpaired-snapshot.mjs --url <served url> [--scenario unpaired\|rescued]` | a snapshot of another runtime is refused before the runtime starts and before a byte of it downloads (HARDENING #62); `rescued`: a mispaired served index is replaced by the pinned runtime's per-build copy (HARDENING #64) | served build (with its per-build copies) | lock | `unpaired-snapshot: PASS (n/n checks, <scenario>)` |
| Snapshot network cut | `node tests/adversarial/snapshot-network-cut.mjs --url <served url> [--scenarios once,lasting] [--cut-mode truncate\|abort]` | a single cut `.snapz` response is absorbed (ready, 0 deaths); a lasting cut halts the relay with a `network` death after one runtime start, not three, and a reload after the network returns is ready, in both cut modes (truncate: a body that ends early is `network`; abort: "Failed to fetch") (HARDENING #63) | served build | lock | `snapshot-network-cut: 2/2 pass` |
| Deep recursion | `node tests/adversarial/deep-recursion.mjs --url <served url> [--scenarios seeded,typing]` | deep `decide` recursion ends in Lean's own error with the checker alive, not a pthread JS-stack overflow (HARDENING #60) | served build | lock | `deep-recursion: 2/2 pass`. It passed both scenarios on wasm64-57ae00dc5f6ce958 (kernel patch 0036, adopted with lean-v4.34.0-41ec565) and fails on 0035b and earlier: it is #60's regression check |
| Resident gate | `tests/adversarial/resident-gate.sh` | the post-rebuild gate: typecheck, a restarted dev server on :5184, preflight, e2e, latency, battery, with cool-downs | the staged pairing (`resident-url.sh`) | not on a shared host (it kills the :5184 listener) | each lane's line; `GATE-REFUSED: …` exit 3 |

Helpers, not lanes: `tests/adversarial/harness.mjs run-dir|cooldown` (the run
directory, the cool-down), `resident-url.sh` (the dev URL of the staged
pairing), `buffer-probe.cjs <url> <file> <line> <regex> …` (type files into
the served editor and match the InfoView), `renderer-sampler.py`,
`reload-storm-summary.py` and `reload-storm-timeline.py` (the reload storm's
process sampling and A/B statistics).

## Environment: where the lanes find the runtime and the snapshots

Every lane that needs a built artifact takes it from a flag, else from the
variable below, else (deprecated for one cycle, with one stderr WARNING) from
this checkout's old default; with none of them a tool exits 2 naming the flag
and the variable, and an integration test skips naming the variable
(docs/CLI-CONTRACT.md "Path resolution"). Nothing falls back to another
project's checkout. From a worktree without build outputs, point the
variables at the main checkout's.

| Variable | Used by | After a release adoption (`$W` = `work/adopt/<id>`) | Deprecated default (this checkout) |
|---|---|---|---|
| `QED64_LEAN_ARTIFACT` | `npm run test:integration` (all three files), node-runner, snapshot-probe, persistent-probe, bake-snapshot, `gate.mjs`, the compiler battery, resident-probe | `$W/artifact` (the release runtime, its `lean-lib` as `lib/lean`) | `pipeline/toolchain/work/build/stage1` when it has `bin/lean.js` (node-runner, snapshot-probe, persistent-probe, resident-probe) or `bin/lean.wasm` (bake-snapshot, the compiler battery); `gate.mjs`: the cwd when it has `bin/lean.js` |
| `QED64_INIT_SNAP` | `tests/integration/fileworker-exit.test.ts` | `$W/snapshot/init.snap` | `work/snapshot/init.snap` |
| `QED64_MATHLIB_SNAP` | the compiler battery (`--snap`; `run.mjs --snap` forwards) | `$W/snapshot/mathlib.snap` | `work/snapshot/mathlib.snap` |
| `QED64_LIB_TREE` | the compiler battery (`--lib`: the tree the snapshot was baked from), snapshot-probe | `$W/lib-tree-slim` (the battery's; snapshot-probe of the mathlib snapshot too) | `work/lib-tree-slim` (battery), `work/lib-tree` (snapshot-probe) |
| `QED64_SNAP_DIR` | resident-probe (`--snap-dir`) | `$W/snapshot` | `work/snapshot` |
| `QED64_WORK` | bake-snapshot and node-runner (`--work`) | a scratch dir of your own (a bake for another runtime must not use the paired set) | `work/snapshot` (bake), `work/runner` (runner) |
| `QED64_STAGING` | bake-snapshot and chunk-runtime (`--out` = `<it>/<buildId>/{snapshots,runtime}`) | `work/staging` (adopt-release.sh stages into `work/staging/<buildId>/`) | `work/staging/<buildId>/…` |
| `QED64_SLOW` | `npm run test:integration` | — | unset: the slow tier is off |

**After a release adoption** (`pipeline/release/adopt-release.sh`, docs/REBUILD.md
§3) the paired build outputs are the adoption's, under `work/adopt/<id>/`
(`$W`): `QED64_LEAN_ARTIFACT=$W/artifact` (the release runtime with its
`lean-lib` as `lib/lean`), the battery's `--snap $W/snapshot/mathlib.snap`
and `--lib $W/lib-tree-slim` (`QED64_MATHLIB_SNAP`, `QED64_LIB_TREE`),
`QED64_INIT_SNAP=$W/snapshot/init.snap`. The main checkout's
`pipeline/toolchain/work/build/stage1` and `work/snapshot` stay the OLD
runtime's after a switch: pointed at them, the battery and the Node probes
test a runtime that is no longer served.

`npm test` itself needs none of them: `tests/unit/tool-paths.test.ts` runs
the tools from a scratch copy of the checkout, with every variable cleared,
and never loads a runtime.

The browser lanes need none of them either: they read the **served tree**
under `public/` (the tracked manifests plus the bytes they pin), which `npm
run fetch:artifacts` fills (docs/CLI-CONTRACT.md "fetch-artifacts"). What the
variables name is different: build outputs (a stage1 dir, raw `.snap`
regions, the olean trees they were baked from) that no served file contains
and fetch:artifacts does not produce.

## A fresh clone

A fresh clone runs G1 after `npm run fetch:artifacts`, in two halves:

1. **The page lanes, from the clone alone.**
   ```sh
   npm ci && npm --prefix frontend ci && npx playwright install chromium
   npm run fetch:artifacts          # public/: runtime chunks, profile parts, snapshots (~1.6 GB), verified
   npm test                         # G0's unit suite
   npm run test:adversarial -- --skip-compiler   # preflight, cool-down, e2e (23/23)
   ```
   and the page lanes below against a dev server on the same tree (page-api,
   infoview-actions, liveness-faults, reload-storm stock and embedded,
   edit-storm against `npm run build:site` + `npm run preview:prod`). A
   second `fetch:artifacts` downloads nothing (every file present with its
   digest is skipped); a file that fails its digest is never renamed into
   place, so a half-finished run is resumed by running it again.
2. **The Node lanes, with the paired build outputs.** The compiler battery
   (`npm run test:adversarial` without `--skip-compiler`) and the integration
   tier (`npm run test:integration`) load the runtime under Node from a stage1
   dir and raw snapshots, which a clone does not have and fetch:artifacts does
   not produce: set `QED64_LEAN_ARTIFACT`, `QED64_MATHLIB_SNAP`,
   `QED64_LIB_TREE` and `QED64_INIT_SNAP` (the table above) to a pairing built
   per docs/REBUILD.md, or to another checkout's. Without them the battery
   refuses (exit 2, the `no-path` line, a REFUSED row in report.md) and the
   integration tests skip naming the variable; nothing falls back to an
   owner-only directory.

`fetch:artifacts --origin <url>` takes the bytes from another deployment
(a local `npm run preview:prod`, a staging Worker); `--release <dir|url>`
takes the runtime and the profile packs from a Lean fork release in the
served layout (its `release.json` is checked too), and the snapshots, which
the site owns, still from `--origin`.

`npm run preview:prod` (`scripts/serve-dist.mjs`) is the live Worker's own
code (`infra/worker.js`) behind a Node server, with `dist/` and `public/` as
its bindings (docs/DEPLOY.md, "Local preview: the Worker's own code"); the
lanes that name it run against it unchanged. Its default `QED64_EDGE=legacy`
is what is deployed; `QED64_EDGE=hardened` serves the hardened edge-worker
defaults, which the live site has not adopted.

## Adversarial suite (`npm run test:adversarial`, tests/adversarial/)

Harness trust rules (docs/history/ARCHITECTURE-REEVALUATION-2026-09-02.md C7,
HARDENING #32-#35): the harness must be able to tell infrastructure from
product, and a run that cannot boot must refuse rather than fail scenarios.

- **Pretest.** `npm test` and `run.mjs` first run `npm run typecheck:site`
  (the root `tsc` does not cover `frontend/`) and refuse on failure; `npm
  test` skips it with a printed notice when `frontend/node_modules` is absent
  (a fresh clone — run `npm --prefix frontend ci`), `run.mjs` never skips. tests/unit/lean4monaco-fixes.test.ts likewise skips its installed-file suites with a printed notice when frontend/node_modules is absent, except under CI (`CI` set); .github/workflows/ci.yml installs the frontend before `vitest run tests/unit`.
- **Preflight** (`pipeline/release/preflight.mjs --url <page url> [--no-boot]`;
  `tests/adversarial/preflight.mjs` is a deprecated shim to it): for the
  pairing the URL will boot (`?runtime=`, `?snapshots=` exactly as
  qed64-boot.ts reads them; the page has one transport, so `mode` in every
  report is the constant `resident`) it verifies the manifest is JSON with chunks,
  every chunk answers HEAD with its manifest size and a non-HTML type (vite's
  SPA fallback once served index.html as chunk 0), the snapshot index and
  each snapshot file, the `runtime` pairing of every index entry against the
  manifest's `buildId` (absent = "no pairing fact", a warning), the profile
  index, and one headless boot smoke. Any failure: `PREFLIGHT REFUSED: …`,
  exit 3, zero rows. `run.mjs` and `resident-gate.sh` call it first.
- **Outcomes.** Every report row has `outcome ∈ {pass, fail, infra, refused,
  aborted}` (`pass: boolean` is kept for old readers). In e2e a page that
  cannot boot (`freshPage`) is one `infra` row and the rest of the plan is
  `aborted` (exit 3). The battery decides `infra` from ITS OWN inputs and
  lines only — a missing `work/snapshot/mathlib.snap` or `stage1/bin/lean.wasm`
  before any probe spawns (every row infra), a spawn error, or a probe that
  died before its `compile:` line without a wasm panic — never from the
  compiler's message text: Lean's unresolvable-import wording is literally
  "No directory 'X' or file 'X.olean'", which is the verdict the four
  `mustError` header items depend on (`classify` in compiler-battery.mjs,
  pinned by tests/unit/adversarial-harness.test.ts). Infra-only → exit 3.
  When no pairing resolves at all (no flag, no variable, no deprecated
  default) the battery exits 2, but first writes compiler.log in `--run-dir`
  and a fresh all-infra `compiler-report.json` (work/adversarial/ and the run
  dir) whose `refused` field and rows carry the `no-path` line; `run.mjs`
  counts that 2 as a refusal (exit 3) and its report.md shows the lane with a
  `REFUSED` line. A lane that ran and wrote no report at all is a `REFUSED` /
  `NO REPORT` line, never silently left out (tests/unit/tool-paths.test.ts,
  tests/unit/adversarial-harness.test.ts).
  In e2e, `infra` means the page never became interactive within
  `--boot-budget-ms`; a page that is interactive but slow to settle under
  machine load is logged and judged by its scenario.
- **Corpus keys.** Editor-action items use `panicFree`, `mustSucceed`,
  `settleMs`, `zeroErrors`, `terminal ∈ {ready, headerUnresolvable, halted}`
  and `stats` (max allowed deltas of the relay's counters,
  `globalThis.qed64.relay.stats`: `reboots`, `userRestarts`, `workerDeaths`,
  `breakerTrips`, `failedInFlight`, `staleDeaths`, `rangedChanges` — e.g.
  `{"reboots": 0}` pins "no reboot happened"). Battery-only keys
  (`containsMsgs`, `budgetMs`, `mustError`) on an action item are a load error.
- **The oracle.** `terminal` is read from `qed64.status().phase` (the relay's
  status: the front door's phase with `halted` on top) — `ready`,
  `headerRefused → headerUnresolvable`, `halted`; the pill label is only the
  fallback for a page without the tap (`harness.settleClass`, which also
  reads the "halted — <reason>" pill). Three rows used to pass vacuously and
  no longer can: `import-composition` requires the refused-header FACT
  (`status().header.mode === "refused"` while the line is incomplete, a
  non-refused verdict after it is finished) AND the kernel's refusal NOTE
  (`… are not loaded in this session …`, pinned once as `REFUSED_NOTE`) to
  be shown in the InfoView and then withdrawn (the old check matched a
  string only the pump shim ever emitted); `final-memory` reads
  `qed64.relay.session.lean.telemetry()` and FAILS when
  `memory.currentBytes` is not a number (a missing tap or a dead worker is a
  failure, not an empty sample); `worker-kill-recovery` terminates
  `qed64.relay.session.lean.worker` and requires, besides the `ready` pill
  and the replayed diagnostics, that the status phase left `ready` within
  30 s (the heartbeat-loss path: 6 s + a 2 s probe, ×3 for load), that
  `relay.stats` moved by exactly `workerDeaths: 1, reboots: 1, userRestarts: 0`,
  and that `relay.session.id` changed — unreadable counters fail the row.
- **Run directories.** Each run writes to
  `work/adversarial/runs/<ts>-<buildId>-<mode>/` (preflight.json, e2e.log,
  e2e-report.json, compiler.log, gauntlet-*.log, latency-*.json, report.md);
  the legacy `work/adversarial/{e2e-report,compiler-report}.json` and
  `report.md` are still written for existing scripts. `--only <name>` runs
  exactly one scenario after `boot` (whole-name match; a corpus item or a
  fixed scenario such as `import-composition`, `worker-kill-recovery`).
  `resident-url.sh` prints the dev URL for the staged pairing
  (`?runtime=<buildId>&snapshots=snapshots-0031`); `resident-gate.sh` is the
  post-rebuild gate (typecheck, dev server restart, preflight, e2e, latency,
  battery, with cool-downs).
- **Cool-down.** Between browser lanes `harness.mjs cooldown` REFUSES while
  any `chrome-headless-shell` is alive (listing pid + command line: on this
  machine it may be a sibling worktree's or an interactive session's live
  e2e, not a leak) and waits until free+inactive memory is above
  `--cooldown-gb` (6 GB). `--kill-strays` opts into SIGKILL for unattended
  re-runs. Every probe closes its browser in `finally`. The memory reading is
  macOS `vm_stat` (free + inactive + speculative pages), else Linux
  `/proc/meminfo` (`MemAvailable`; `MemFree + Buffers + Cached` on kernels
  without it), else `os.freemem()` (free pages only, so it waits longer, never
  shorter); the first line after the stray check names the source
  (`cool-down: memory from …`). With no reading at all it prints
  `cool-down: REFUSED — no memory reading (<what each probe said>)`. Exit
  codes of `harness.mjs cooldown`: 0 fit to start a browser, 3 refused (a
  stray browser, memory not back within `--cooldown-max-s`, or no reading),
  2 usage. The parsers are unit-tested on a captured `vm_stat` and on
  `/proc/meminfo` samples (`tests/unit/adversarial-harness.test.ts`).
- **Latency.** `editing-latency.mjs` measures header gestures from
  `qed64.status()` facts only: `switchAdmitMs` = header edit → the first
  status change after it (the front door admits the didChange: the document
  version moves and the phase leaves `ready`) — the transport's admit
  latency, about one 50 ms poll, not the worker's first
  `$/lean/fileProgress`; the design's ≤ 300 ms covered-switch metric (ux
  item 4) is not measured by this lane — and
  `headerSwitchMs` = edit → the version has advanced past the edit AND the
  phase is `ready` again; each round also records `headerMode`
  (exact / covered / refused). A page whose status carries no header fact
  after boot (`status().header === null`, i.e. no `$/qed64/headerStatus`
  reached the page) is an infrastructure refusal — `latency: REFUSED — …`,
  exit 3, `outcome: "infra"` in the JSON — never a number. There is no pill
  fallback and no progress clock any more; `resident-gate.sh` runs one lane.
- **Boot card** (`boot-card.mjs --url <prod preview> [--scenario
  slow-link|check-fallback|all] [--mbps 16] [--rtt 40]`, HARDENING #54): a
  cold first visit through its own link-shaping TCP proxy (one shared
  downlink bucket; CDP network emulation does not reach the Lean worker's
  downloads), sampled every second. `slow-link` fails when the card is hidden
  or the pill reads idle before `status().phase` is `ready`, and reports
  each stage's start, the longest stretches without numbers and without
  any change on the card, the bytes carried, and RSS per process type at
  ready. `check-fallback` restores an Init-only buffer that elaborates for
  60 s and requires the card to go ~30 s after the relay serves, while the
  phase is still `elaborating`. Serve `dist/` (`npm run build:site`, then
  `PORT=… node scripts/serve-dist.mjs`), not the dev server: unbundled
  modules over a shaped link measure Vite, not the product.
- **Reload storm** (`reload-storm.mjs --url <dev url> [--runs 5] [--headed]
  [--embed] [--sample-ms 100] [--ready-each] [--console-log]`, HARDENING #53,
  #55; a release gate, the first lane of the pyramid): a fresh browser per
  run, boot to `ready`, five reloads 3 s apart (`waitUntil: "commit"`), then
  `ready` again. A crash is the page `crash` event, classified by the V8 OOM
  line in the browser's stderr (V1 semi-space copy, V2 young object promotion
  failed; kept in `reload-storm-<tag>-<n>.browser.log`). `--headed` is
  Chrome for Testing in a window — V2 is a headed-Chrome crash and
  chrome-headless-shell almost never shows it. `--embed` loads the page as
  the only iframe of `public/embed-host.html` (served by the dev server and,
  locally only, by `scripts/serve-dist.mjs`; same origin, same COOP/COEP) and reloads the host, as an embedding site does.
  `--sample-ms` runs `renderer-sampler.py` (per child process: RSS,
  footprint, threads — a Worker's thread exits only when its isolate is
  disposed — and the macOS pressure level). For an A/B, interleave arms with
  one `--runs 1 --tag <arm>-r<n>` invocation per run into one `--run-dir`,
  then `reload-storm-summary.py <run dir>` (crash counts, Fisher tests,
  per-reload process facts); `reload-storm-timeline.py <report>` lines one
  run up against its samples. V2 is rare on the stock page: gate embedded
  AND stock, headed AND headless, with a release control arm in the same
  window.
- **InfoView actions** (`infoview-actions.mjs --url <dev url> [--only <scenario>]`,
  HARDENING #56): the InfoView's editor RPC on the real page, each scenario on
  its own page (an `--only` that selects no scenario exits 3). `capability-flag`
  (`qed64.api` = `{version: 1, capabilities.editorRpc}` as an init script's
  DOMContentLoaded listener sees it, and again, frozen, at load),
  `try-this-apply` (init only: click the core "Try this" `[apply]` link of
  `simp?`, the line must read `by simp only [Nat.add_zero]` and elaborate
  without errors), `conv-generate` (Mathlib: the `conv?` ProofWidgets panel
  renders — an `mk_rpc_widget%` panel, sendClientRequest with an abortSignal —
  then shift-click `c + b` and "Generate conv" must write a `conv => … enter …`
  block), `foreign-show` (init only: showDocument sent from inside the
  InfoView iframe, as the InfoView's own RPC puts it on the wire, for a
  Mathlib file must leave the text, the selection and the focus alone; the
  same call for the editor's document must select and focus it — the
  control). The scenario selection, the in-browser probes and the verdicts
  are pinned by tests/unit/infoview-actions.test.ts.
- **Page API** (`page-api.mjs --url <dev url> [--only <scenario>]`,
  docs/EMBEDDING.md §2–§4): `qed64.api` used the way an embedder uses it,
  never the internal taps. `embed-code` (`?embed=1#code=`: that document,
  booted light, `qed64:api` before boot, examples hidden, the stored buffer
  neither read nor written), `embed-setdoc` (setDocument from the
  `qed64:api` listener becomes the boot document), `events` (boot stages
  ending in done; setDocument → settled at its version with a `document`, an
  error `diagnostics` and a `ready` event; identical text resolves
  unchanged), `restart` (a `reboot` event to a new session, settled again),
  `bad-param` (`?snapshots=/attacker.example/x` fails the boot naming the
  parameter, with no off-origin request).
- **Edit storm** (`edit-storm.mjs --url <prod preview> [--reps 2]
  [--scenarios sleep,sleepreq,pagesleep,pagecadence,fast,pageslow]
  [--grow-tolerance 4]`, HARDENING #59; docs/EMBEDDING.md §7.8): an edit per
  keystroke over work that ignores cancellation, measured by the worker's
  pool sample every 100 ms. Hatch scenarios send one full-text didChange per
  typed character through `qed64.test.lsp.notify`, the library path past
  the page's own client (`fast`, `slow`, `heavy`; `sleep` above `#eval
  IO.sleep 3000`; `sleepreq` with a goal request after every change); page
  scenarios type into the page's Monaco with the InfoView open on the line
  above the sleep (`pagesleep` at 10 ms/char, `pageslow` at 150 ms/char)
  or above a cheap `#eval` (`pagecadence`, which reports the changes and
  requests that pace sends). A run passes when the typing happened, the
  renderer did not crash, no death or reboot, the checker is ready at the
  last typed version, and the pool total grew by at most the tolerance; it
  also counts the didChanges and requests that reached the relay and the
  session's back-pressure holds, releases, caps and longest hold.
  `--url …/?edithold=0` runs the same build with the hold off (the control
  arm for `pageslow`, which crashed on every build without it). Serve a
  build (`scripts/serve-dist.mjs`), not the dev server, and run it through
  the host browser lock.
- **Unpaired snapshot** (`unpaired-snapshot.mjs --url <served build>
  [--scenario unpaired|rescued] [--runtime wasm64-0000000000000000]
  [--buffer <text>] [--wait-ms 90000 (rescued: 180000)] [--headed]`,
  HARDENING #62 and #64; docs/EMBEDDING.md §7.2): the page refuses a
  snapshot of another runtime before the runtime starts and before a byte of
  the snapshot downloads. It serves nothing and writes nothing under
  `public/`: Playwright's route answers the snapshot index request (served
  or `?snapshots=` overlay) with a copy whose every entry's `runtime` is
  `--runtime`, and, since HARDENING #64, does the same to the served
  index's per-build copy `/snapshots/index.<buildId>.json` that a shell reads
  when `index.json` names another runtime (a server without the copy gets
  the rewritten `index.json`'s bytes for it, so no 404 line). PASS: the copy
  was read and named the other runtime too, no `.snapz` request, no
  `lean.wasm` chunk request and
  no `runtime-initialized` log, the relay halted (three `bootFailed`
  deaths), `api.status().boot` `{failed: true}` with a message,
  `lastDeath.reason` `bootFailed` and `cause.kind` `unpaired`, the boot
  card failed, no renderer crash, and no console error or warning outside
  the three shapes the showcase's C9 allowlists ("QED64: the Lean checker
  died (bootFailed)", "QED64: checker halted after repeated crashes",
  "Error: ?snapshots=<dir>: …"). The halt comes about 3 s after the relay
  is constructed, often before the client's `initialize`, which is then
  answered with the halted line, so the died line may appear fewer than
  three times or not at all. Every console line is printed, with the time
  to halt, the relay's states, when `initialize` reached the relay and each
  shape's count. `--scenario rescued` replays the #64 incident (an old shell
  meeting a new mutable index): only `index.json` is rewritten, the copy is
  served as the server has it, and the page boots from the copy. PASS: the
  copy was read (200), ready, 0 deaths and no `lastDeath`, a `.snapz`
  request, exactly 1 runtime start, no renderer crash and the same console
  rule, plus the empty `console.error` of a boot that reaches elaborating,
  known only when paired one-to-one with its own -32800 reply
  (`tests/adversarial/empty-console.mjs`, shared with the network-cut lane);
  the served build must carry the copy (`fetch-artifacts`, `promote`
  or the upload write it). Exit 0 PASS, 1 FAIL. Run it through the host
  browser lock.
- **Snapshot network cut** (`snapshot-network-cut.mjs --url <served build>
  [--scenarios once,lasting] [--cut-bytes 1000000] [--cut-mode
  truncate|abort] [--buffer <text>] [--wait-ms 300000] [--headed]`,
  HARDENING #63; docs/EMBEDDING.md §7.2): a lasting network failure in a
  `.snapz` response costs the relay's retries no runtime. It serves nothing
  and writes nothing under `public/`: Playwright's context route answers a
  cut `.snapz` request with the first `--cut-bytes` of the real response
  under its full content-length (the body ends mid-stream: in Chromium a
  clean short end, which both snapshot streams name "the transfer of …
  ended early", a `network` cause), or aborts it with `connectionreset`
  (`--cut-mode abort`); the requests it does not cut continue. Run both
  modes: they expect the same verdicts. `once` cuts the first response: PASS is ready, 0 deaths,
  exactly one cut, the "raw prefetch error" warning (the checker streamed
  the snapshot itself) and one runtime start. `lasting` cuts every
  response until the relay halts: PASS is halted, `lastDeath` `bootFailed`
  with cause kind `network`, more than one cut, exactly one runtime start
  (the `[mem] runtime-initialized` lines; three before the fix) and the boot
  card failed; then it stops cutting and reloads the page: ready, 0 deaths.
  Both: no renderer crash, and no console error or warning outside the
  shapes the showcase's C11 allowlists (the relay's died and halted lines,
  `Failed to load resource: net::ERR_…`, the prefetch warning; the reload
  lines "Session disposed." and "Outdated RPC session" are known, and so
  is the EMPTY `console.error` of a boot that reaches elaborating, which
  is monaco-vscode-api's NotificationService printing Lean's own
  empty-message -32800 reply, but only when it comes from the page's main
  bundle and takes its own unused -32800 reply, seen by the lane's LSP tap
  in the 3 s before it or the 0.5 s after: one reply per line, in time
  order, as the showcase pairs). Every console line (with
  its arguments and source location when its text is empty), the LSP error
  replies, the `.snapz` requests, the runtime starts and the relay's
  states are printed. Exit 0 when every scenario passes, 1 FAIL. Run it
  through the host browser lock.

## Pipeline CLI contract (docs/CLI-CONTRACT.md, tests/unit/cli-contract.test.ts)

- Every Tier 1/2 tool runs as a child process with a SIGKILL timeout, with
  `QED64_LEAN_ARTIFACT` and `--artifact` naming a missing path (no runtime
  can boot) and every path flag inside a temp tree. `--help`/`-h` must exit
  0 and print the help generated from SPECS, with its synopsis first, and
  leave the tree byte-for-byte unchanged. That tree includes the raw `.snap`
  a bake would unlink first.
- A missing required flag must exit 2 with `usage: <synopsis>` after the
  unknown-flag WARNINGs, again without touching the tree.
- Every stable marker's template is grepped verbatim from the script source,
  and its regex must match a line that template prints. The doc must name
  every flag, exit code and marker regex.
- `node pipeline/snapshot/cli.mjs --check-preludes` must pass: the inline
  preludes are the current rendering of SPECS.
- The files lean4game and the showcase vendor one by one must import only
  files they vendor.
- The path rule (tests/unit/tool-paths.test.ts): each tool, run from a scratch
  copy of the checkout with the rule's variables cleared, exits 2 with the
  `no-path` line and its usage line when nothing resolves, honours its
  variable, and prints exactly one WARNING per deprecated default it uses
  while still resolving it. Each case stops at a cheap check (a missing lib
  tree, a foreign index, a missing `--snap`, a `bin/lean.js` that is a
  directory); the one bake that completes runs a fake node-runner. The
  `--stack-size` re-exec keeps the PID, the stdio and the exit code, a SIGKILL
  of that PID leaves nothing behind, and supervised-run's runner is not
  re-exec'd. No tracked file but the two provenance notes names the sibling
  codex checkout.

## Artifact discipline (pipeline/, tests/unit/artifact-discipline.test.ts)

- `chunk-runtime.mjs` and `bake-snapshot.mjs` default `--out` to
  `work/staging/<buildId>/{runtime,snapshots}` and hard-error (exit 2) on any
  `--out` inside `public/`; neither deletes anything it produced before.
- Every snapshot index entry carries `runtime: <buildId>` (the sha256 of the
  baking artifact's lean.wasm, the same identity chunk-runtime writes);
  `lib/snapshots.ts` accepts it, preflight checks it, and
  `promote-staging.mjs --staging work/staging/<buildId> [--dry-run]` refuses
  a mismatch, re-derives every staged chunk's and snapshot's sha256 against
  the manifest/index (a truncated staging file is refused at plan time, not
  in the browser), copies chunks and snapshots additively, and switches the
  default manifest and index by atomic rename. Nothing referenced by a
  manifest under `public/runtime` is ever deleted by a promote.
- `bake-snapshot.mjs` checks the target index BEFORE launching the runner:
  siblings paired with another runtime, or with none (pre-field bakes), are
  refused with the `--name`s to rebake. It always passes its resolved
  `--artifact` to the runner so the stamped `runtime` is the binary that baked.
- `infra/worker.js` serves `runtime-manifest*.json` and every `index.json`
  with `must-revalidate`; only digest-named chunks/`.snapz`/`.part-*` files
  are `immutable` (the per-build manifest's NAME is sha256(lean.wasm) but
  its chunk digests change on a lean.js-only relink).
- `public/snapshots/index.json` is tracked (`.gitignore`: `public/snapshots/*`
  + `!public/snapshots/index.json`); the snapshot files beside it are not.

## Edge worker (infra/, tests/unit/edge-worker.test.ts)

- Equivalence: a request matrix (GET/HEAD/POST/…, shell, assets, every
  artifact prefix, missing keys, odd paths, Range headers) runs through the
  ORIGINAL worker (`tests/fixtures/edge-worker/worker-47f50e8.js`,
  sha256-pinned), `createWorker(QED64_LEGACY)` and the shipped
  `infra/worker.js` against fake ASSETS/R2 bindings; status, statusText,
  headers, body and every binding call must be identical. Flipping any
  legacy switch fails it.
- The hardened defaults (ranges/If-Range/416, metadata HEAD, 405 + Allow,
  unsafe keys, r2Prefix validation, rootRedirect, extraRoutes + kit,
  decorate, isolation overrides, no-store errors) are pinned against the
  same fakes, whose ranged `get()` throws where R2 would be leaned on.
- The local preview (`tests/unit/serve-dist.test.ts`): `scripts/serve-dist.mjs`
  answers through the worker itself, in-process on port 0 over a scratch
  `dist/` and `public/` in the OS temp dir. Pinned per `QED64_EDGE` mode: the
  isolation headers and the cache rule on the shell, an asset and artifacts
  (through a symlinked `chunks/`), 404s, HEAD lengths as on the live site,
  doubled slashes and `/index` answering one 307 as live (no `Location`
  starting with `//`), a mode-000 file answering 500 with the isolation
  headers,
  traversal refusal (encoded `..`, symlinks out of `dist/`), the local-only
  `/embed-host.html`, Range (hardened 206/416, legacy a full 200), and
  `QED64_EDGE=bogus` exiting 2 before listening. A parity matrix answered by
  serve-dist and by the worker's own `fetch` with in-memory bindings over the
  same bytes must agree on status, headers (apart from content-length, etag,
  date and Node's connection headers) and body.

## Conventions

- Unit tests execute the REAL worker source (vm sandbox) and the REAL
  published manifests — refactors cannot silently diverge from shipped code.
- Integration tests skip cleanly when the runtime artifact is absent, and
  say which variable to set (`QED64_LEAN_ARTIFACT`, `QED64_INIT_SNAP`; the
  table above). Those two also skip, with a printed reason, when the
  artifact is too old for what they assert: runtime-smoke when it predates patch 0020 (that CLI exits on its own and is not the runtime the
  browser runs), and persistent-path's parse-error test when it predates
  patch 0010 (its `wasmCompile` drops parser diagnostics). 0010 changes only
  compiled Lean code, so the check reads the build's
  `lib/lean/Lean/Shell.ilean`: a patched `wasmCompile` references
  `Lean.Parser.parseCommand`. When that file is missing the test runs: an
  adopted release's `$W/artifact` has none (its `lib/lean` is the `lean-lib`
  pack, which ships no `.ilean`), so there the 0010 check is skipped, not
  failed. To run both against the paired runtime from a worktree, set
  `QED64_LEAN_ARTIFACT` to the adoption's `work/adopt/<id>/artifact` (before
  the first adoption: the main checkout's
  `pipeline/toolchain/work/build/stage1`, the served runtime until a switch).
- Every live-debugging failure class gained a pinned regression test the same
  day (see installer-stream.test.ts).
