# Testing

## Layers

| Layer | Command | What it proves |
|---|---|---|
| Unit (133 tests) | `npm test` | abbreviation engine; manifest validation incl. hostile inputs; segmentation plan/build byte-exactness; installer stream failure classes (rejecting sink, hanging sink, corrupted part, zip-bomb); diagnostic parsing incl. multi-line goals (real worker source in a VM); Lean IO-result decoding; Memory64 probing; CM position mapping; pack round-trip on real oleans; parser-coverage lints; snapshot index matching; umbrella header rewrite; stale-storage classification + cache probes |
| Integration | `npm run test:integration` | the real wasm64 runtime under Node: prelude parse, Init import + `numBits=64` + kernel-checked `rfl`, positioned errors + exit codes, `sorry` semantics, and the full persistent-path probe (init sequence, 26 ms resident recheck, error-count return, survival after failure) |
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
  (a fresh clone — run `npm --prefix frontend ci`), `run.mjs` never skips.
- **Preflight** (`preflight.mjs --url <page url> [--no-boot]`): for the
  pairing the URL will boot (`?runtime=`, `?snapshots=`, `?resident=` exactly
  as qed64-boot.ts reads them) it verifies the manifest is JSON with chunks,
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
  and `stats` (max allowed shim-counter deltas, evaluated once
  `globalThis.qed64.shim.stats` exists). Battery-only keys (`containsMsgs`,
  `budgetMs`, `mustError`) on an action item are a load error.
- **Run directories.** Each run writes to
  `work/adversarial/runs/<ts>-<buildId>-<mode>/` (preflight.json, e2e.log,
  e2e-report.json, compiler.log, gauntlet-*.log, latency-*.json, report.md);
  the legacy `work/adversarial/{e2e-report,compiler-report}.json` and
  `report.md` are still written for existing scripts. `--only <name>` runs
  exactly one scenario after `boot` (whole-name match; a corpus item or a
  fixed scenario such as `import-composition`, `worker-kill-recovery`).
- **Cool-down.** Between browser lanes `harness.mjs cooldown` REFUSES while
  any `chrome-headless-shell` is alive (listing pid + command line: on this
  machine it may be a sibling worktree's or an interactive session's live
  e2e, not a leak) and waits until free+inactive memory is above
  `--cooldown-gb` (6 GB). `--kill-strays` opts into SIGKILL for unattended
  re-runs. Every probe closes its browser in `finally`.
- **Latency.** `editing-latency.mjs` records `switchBusySeenMs` = header edit
  → first `$/lean/fileProgress` (read from the shim's progress clock
  `qed64.shim.lastProgressAt`) — the covered-switch metric the design budgets
  at ≤ 300 ms. Each round records `progressClockSource`; `busy-label` means
  the shim stopped exposing the clock and the number is the 15 s-ceiling
  fallback, not a measurement.

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

## Conventions

- Unit tests execute the REAL worker source (vm sandbox) and the REAL
  published manifests — refactors cannot silently diverge from shipped code.
- Integration tests skip cleanly when the runtime artifact volume is absent.
- Every live-debugging failure class gained a pinned regression test the same
  day (see installer-stream.test.ts).
