# Testing

## Layers

| Layer | Command | What it proves |
|---|---|---|
| Unit (~190 tests) | `npm test` | abbreviation engine; manifest validation incl. hostile inputs; segmentation plan/build byte-exactness; installer stream failure classes (rejecting sink, hanging sink, corrupted part, zip-bomb); diagnostic parsing incl. multi-line goals (real worker source in a VM); Lean IO-result decoding; Memory64 probing; CM position mapping; pack round-trip on real oleans; parser-coverage lints; snapshot index matching; the LSP front door reducer (real worker source in a VM) and the byte-exact framer; the relay against a fake session (document hash after every scenario, orphaned requests answered, no timers, stale deaths ignored); the ring writer; artifact discipline; the adversarial harness's pure helpers |
| Integration | `npm run test:integration` | the real wasm64 runtime under Node: prelude parse, Init import + `numBits=64` + kernel-checked `rfl`, positioned errors + run verdicts (judged by output through `supervised-run`: the CLI never exits since patch 0020), `sorry` semantics, and the full persistent-path probe (init sequence, 26 ms resident recheck, error-count return, survival after failure) |
| Slow tier | `QED64_SLOW=1 npm run test:integration` | 2,308-module `import Lean` closure; snapshot bake produces a valid compacted region |
| Snapshot | `node --stack-size=8192 pipeline/snapshot/snapshot-probe.mjs --snap <file> --probe-file <lean>` | a baked snapshot loads via `lean_wasm_load_snapshot` (the worker's exact path) and the follow-up compile is an env-cache hit within a time budget — a wrong cache key would silently re-import for minutes |
| Release | `npm run verify:release` | every digest the browser will trust, re-derived from bytes, including the multi-GB raw packs WebCrypto can't stream |
| Live browser | manual / e2e spec | the full product loop (see docs/ARCHITECTURE.md for the current live-verified numbers) |

## Adversarial suite (`npm run test:adversarial`, tests/adversarial/)

Harness trust rules (docs/ARCHITECTURE-REEVALUATION-2026-09-02.md C7,
HARDENING #32-#35): the harness must be able to tell infrastructure from
product, and a run that cannot boot must refuse rather than fail scenarios.

- **Pretest.** `npm test` and `run.mjs` first run `npm run typecheck:site`
  (the root `tsc` does not cover `frontend/`) and refuse on failure; `npm
  test` skips it with a printed notice when `frontend/node_modules` is absent
  (a fresh clone — run `npm --prefix frontend ci`), `run.mjs` never skips. tests/unit/lean4monaco-fixes.test.ts likewise skips its installed-file suites with a printed notice when frontend/node_modules is absent, except under CI (`CI` set); .github/workflows/ci.yml installs the frontend before `vitest run tests/unit`.
- **Preflight** (`preflight.mjs --url <page url> [--no-boot]`): for the
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
  re-runs. Every probe closes its browser in `finally`.
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
  the only iframe of the dev server's `public/embed-host.html` (same origin,
  same COOP/COEP) and reloads the host, as an embedding site does.
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

## Artifact discipline (pipeline/, tests/unit/artifact-discipline.test.ts)

- `chunk-runtime.mjs` and `bake-snapshot.mjs` default `--out` to
  `work/staging/<buildId>/{runtime,snapshots}` and hard-error (exit 2) on any
  `--out` inside `public/`; neither deletes anything it produced before.
- Every snapshot index entry carries `runtime: <buildId>` (the sha256 of the
  baking artifact's lean.wasm, the same identity chunk-runtime writes);
  `src/runtime/snapshots.ts` accepts it, preflight checks it, and
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

## Conventions

- Unit tests execute the REAL worker source (vm sandbox) and the REAL
  published manifests — refactors cannot silently diverge from shipped code.
- Integration tests skip cleanly when the runtime artifact volume is absent
  (runtime-smoke and persistent-path print why). Those two also skip, with a
  printed reason, when the artifact is too old for what they assert (the old
  codex stage1 fallback, which a checkout without its own stage1 build picks
  up): runtime-smoke when it predates patch 0020 (that CLI exits on its own and is not the runtime the
  browser runs), and persistent-path's parse-error test when it predates
  patch 0010 (its `wasmCompile` drops parser diagnostics). 0010 changes only
  compiled Lean code, so the check reads the build's
  `lib/lean/Lean/Shell.ilean`: a patched `wasmCompile` references
  `Lean.Parser.parseCommand`. When that file is missing the test runs. To run
  both against the paired runtime from a worktree, set `QED64_LEAN_ARTIFACT`
  to the main checkout's `pipeline/toolchain/work/build/stage1`.
- Every live-debugging failure class gained a pinned regression test the same
  day (see installer-stream.test.ts).
