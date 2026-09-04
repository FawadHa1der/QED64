# Resident FileWorker — the plan (PATCH-BACKLOG #4, promoted)

Status: THE SECOND-REVIEW DESIGN IS IMPLEMENTED behind `?resident=1`
(2026-09-03; docs/ARCHITECTURE-REEVALUATION-2-2026-09-02.md, phases 0–5 of
its plan). Kernel patch 0032 (single header resolver in `setupImports`, one
environment registry, one normalized header key, `$/qed64/headerStatus`,
exports generated at build) is validated on runtime `wasm64-5dcdda005a7c5ae0`;
the worker is a byte-exact channel with a pure LSP front door; the page side
is a 159-line relay with three states and no timers. Measured on the same
harness, same machine (median of 3):

| | pump (shipped) | resident (implemented) |
|---|---|---|
| header switch, edit → ready | 2,575 ms | **332 ms** |
| first progress after the edit | 2,055 ms | 280 ms |
| import completion widget | 301 ms | 346 ms |
| error clear | 11 ms | 12 ms |
| boot (warm) | 12.4 s | 12.2 s |
| crash gauntlet, mixed 4 min | — | 226 steps, no crash |
| crash gauntlet, imports 4 min | crashed at step 2 (pre-existing) | 74 steps, no crash |
| compiler battery (0032 pairing) | 49/49 | 49/49 |
| e2e | 17/22 on the production pairing (3 known wedge-cohort items + 2 oracle artifacts since fixed) | 21/22 (the miss is the exact-imports action, not yet built) |

The three resident misses: `mathlib-name-shadow-faithful-switch` expects the
automatic exact-imports reboot that the design replaces with an explicit
"Load exact imports" action (phase 6, not built); `worker-kill-recovery` and
`final-memory` were a harness accessor (fixed; both pass on rerun — a
terminated worker is detected, replayed and back to `ready` with the edits
present). What remains for the default flip (phase 5/6 of the second review):
the exact-imports action, the lean4game port to the relay (it vendors qed64 at
a pin), and one kernel follow-up — `$/qed64/headerStatus.version` is stamped
with the initial document version on later setups (the FileWorker binds the
first `DocumentMeta` into `setupImports`; the UI keys on progress versions
and the mode, so nothing user-visible depends on it). Phase 7 (retire the
pump transport) is deliberately not scheduled until the game passes on
resident. The served pairing is promoted only when the pump transport passes
its e2e on the 0032 pairing (see the promote rule in HARDENING/PATCHES).

## Phase-1 spike results (2026-09-02) — transport PROVEN; all blockers resolved by the afternoon

Patch 0031 (`pipeline/toolchain/patches/`, committed to work/lean4 and the
kernel repo; EXPERIMENTAL, NOT promoted — served public/runtime still
predates it) ports browser64's resident transport: PROXY_TO_PTHREAD=1, a
futex stdin ring (`lean_browser64_configure_input_ring`), a once-guard on
`lean_main` init for re-entry (`lean_wasm_shell_mark_preinitialized`),
`MAIN_THREAD_EM_ASM` for FS/getenv under a proxied main, and a covering-env
match in `Lean.Language.Lean`'s prebuilt-header lookup (so a resident session
serves any Mathlib-subset header from a snapshot, not just exact-key matches).

The Node spike `pipeline/snapshot/resident-probe.mjs` boots the patch-0031
artifact, seeds the init snapshot, configures the ring, and `callMain
--worker` — the REAL Lean FileWorker loop on the application pthread.

PROVEN:
- **Bidirectional transport works.** Input ring drains fully (read==write);
  the worker emits framed LSP back over stdout: `$/lean/fileProgress`,
  `$/lean/ileanHeaderSetupInfo`, and `textDocument/publishDiagnostics` all
  observed arriving and parsing. So the proxied-pthread stdout path flushes
  (at least while writes keep coming) — the reporter runs.
- The build links cleanly (no export-specialization breakage), and every
  pipeline tool that runs `main` (bakes, gate, probes) works under
  PROXY_TO_PTHREAD after a host-path mirror mount in node-runner.

RESOLVED (2026-09-02, second pass) — the "open blocker" was two things
and neither was the reporter:
- **A harness parser bug, not a runtime stall.** The fork's import progress
  (`[DEBUG:PROGRESS] …`, `IO.println` in Environment.lean) goes to STDOUT
  and interleaves with LSP frames; a parser that only scans the first 256
  bytes for `Content-Length` wedges on the first such line while the worker
  keeps answering everything. Raw-tap evidence: every tickler answered, the
  `waitForDiagnostics` burst on elaboration completion, `rpc/connect` and
  `hover` answered mid-run. Fixed in the spike AND in lean.worker.js (header
  found anywhere in the buffer; leading bytes surfaced as log events); the
  fork now prints that progress to stderr.
- **Task-thread timed sleeps DO wake** (the inlay-hint refresh timer fires
  every 500 ms); the earlier "never wakes" reading was the same parser
  artifact. reportDelayMs=0 via `-D` reaches the reporter (verified by the
  1500 ms variant delaying the initial burst).
- **Act 1 PASSES**: `RESIDENT PROBE PASS` — full elaboration, drained
  progress, the deliberate `rfl` type-mismatch diagnostic and `#eval` info
  delivered through the ring transport.
- **Header change = in-process re-elaboration, no exit.** The modern worker
  does not exit on a header change; it re-runs `setupImports`, whose
  once-per-process guard (`importsLoadedRef` → `IO.sleep 200`; forceExit 2)
  then blocked the header task (zero CPU). Patch 0031 now bypasses that
  guard on Emscripten (the pump path's `teardownForReplacement` rationale:
  environments stay resident, the cache serves switches).
- **Prebuilt lookup missed for `#[Init]`** against the init snapshot's
  `#[Init, Init]` key (headerless files have EMPTY imports and matched
  nothing at all), so the header imported all 629 Init modules on the
  elaboration thread (~17 s, completed — so on-thread imports are slow, not
  fatal). The lookup now treats empty imports as `Init`; a stderr trace
  reports HIT/MISS with the published keys.

RESOLVED (afternoon rebuild, patch 0031 final):
1. **Act 2 in process** — a header change re-elaborates without exit (the
   guard bypass holds); the browser switches headers with no reboot.
2. **Prebuilt lookup HIT** — `[WASM LSP] prebuilt lookup HIT` for `#[Init]`
   and umbrella-covered headers; IMPORT629 = 0.
3. **The 629-module import's true trigger** was the publish landing in
   `wasmLoadSnapshot` while the browser and the spike load through
   `wasmLoadSnapshotMem`; publishing from both loaders cut the spike from
   ~23 s to 6.0 s.

Phase-3 findings (browser, 2026-09-02 afternoon):
- Resident boot to `ready` in-browser; normal editing and diagnostics correct.
- Two shim defects found by the e2e suite and a replay harness
  (`work/repro-unresolvable.mjs`): per-keystroke header re-elaboration
  crashed the tab (fixed: 2 s debounce, as the pump path); body edits
  forwarded incrementally while header edits were held corrupted the
  worker's document copy (fixed: `residentUnsynced` holds EVERY edit until
  one full-text didChange goes out).
- An unresolvable header (`Mathlib.Tactic.Bogus`) fails fast in the Node
  spike (`isSetupFailure`) but STALLS the elaboration pthread in the browser
  (WORKERFS lookup with the Mathlib pack mounted). Fixed client-side for now:
  `unknownImports` refuses headers whose modules are not installed (umbrella
  counts as installed once its snapshot is resident) and shows the pump
  path's calm hold; the durable fix is kernel-side — a covering-lookup MISS
  must raise a header error, never import on the elaboration thread.
- Latency on COVERED headers is identical in both modes (~2.07 s, debounce-
  dominated; ~70 ms of real work). The architectural win is confined to
  uncovered/unresolvable headers and to the removal of the reboot machinery.

Dev-testing an unpromoted runtime (how phase 3 runs the browser suite):
`chunk-runtime.mjs --out work/runtime-<tag>`. **NEVER `--out public/runtime`**:
besides rewriting the tracked default `runtime-manifest.json`, it REPLACES
`public/runtime/chunks/`, destroying the previous runtime's chunks. Those are
gitignored, so `git checkout` restores the manifest but NOT the chunks — the
default/served build then cannot boot locally at all (`lean.js chunk 0: 6373
bytes, expected 16777216` — vite's SPA fallback for the missing file), and
recovering it means rebuilding that exact binary or re-fetching the published
artifacts. This happened mid-run and silently invalidated a whole e2e gate:
every `freshPage()` after it failed to boot, which read as scenario failures
and then as an uncaught crash. Deployed artifacts are unaffected (they are
served from the upload, not this tree). Install only the manifest as
`public/runtime/runtime-manifest.<buildId>.json` (gitignored; chunks are
content-addressed under public/runtime/chunks). Snapshots: bake with
`--out work/snapshot-staging`, expose via the `public/snapshots-0031 →
../work/snapshot-staging` symlink (in .git/info/exclude). Boot with
`?resident=1&runtime=<buildId>&snapshots=snapshots-0031` —
`tests/adversarial/resident-url.sh` prints it; `resident-gate.sh` runs the
e2e suite, the pump-vs-resident `editing-latency.mjs` benchmark, and the
compiler battery against that pairing.

Integration lessons already banked (all reused by the browser phase):
opening sequence is `initialize` then `didOpen` with NOTHING between;
PROXY_TO_PTHREAD leaks host argv paths on Node (mirror-mount fix);
loading a snapshot needs full `lean_initialize` first; re-entering `main`
needs the once-guard; the bake exit wedges under the 0020 mailbox
keepalive (supervisor reaps on stable-output + quiet).

## Why now — what the crash campaign measured

- A first-visit page idled at **9.7 GB resident** (renderer killed by macOS
  at ~11 GB under storms). Root split: ~2 GiB wasm heap (honest, at its
  pre-commit; slim regions fit inside), ~1.5–2 GB Chromium compiled-code
  space for the 106 MB module, and **~4.6 GB of download/inflate-era JS
  allocations the Lean worker retained for its whole life**.
- Shipped mitigations (see git history around this file's introduction):
  honest heap meter in `#buildinfo` + near-cap warning, and the
  **disposable-prefetch boot** — download + gunzip run in
  `snapshot-prefetch.worker.js` (raw mode) which terminates on completion,
  so the Lean worker sync-reads a clean raw region from OPFS. Measured:
  boot RSS 9.7 → **3.5–5.9 GB**, and the storm that killed the page in
  17 s now passes 120 steps.
- What mitigations CANNOT fix: every header change still probes/tears down
  a session, an uncovered switch still reboots the whole wasm instance
  (~30 s), the single pump thread still queues all LSP behind resolution,
  and each reboot recompiles/reinstantiates and re-touches gigabytes. That
  is the remaining gap to a VS Code-class import-editing experience and the
  remaining renderer-pressure transient.

## Target architecture

Run the REAL, unmodified `lean --worker` main loop on an application pthread
(`-sPROXY_TO_PTHREAD=1`), fed by a futex-based stdin ring (browser64's
`lean4-resident-transport.patch` has the ~150-line io.cpp core and a
`resident-transport.lock.json` contract). Blocking stdin becomes legal:

- The host-pumped machinery retires: patch 0018 (pump exports), patch 0020
  (keepalive guard), and most of the motivation for 0019/0021. The
  event-loop-starvation bug class disappears architecturally.
- One worker process lives for the whole page. Header changes become what
  they are natively: FileWorker restarts INSIDE the process —
  `teardownForReplacement` (patch 0024) already gives cancellable
  replacement, and the env cache + covering logic (patch 0027 probe, the
  faithful-on-collision reboot's warm-compile trick) keep working, minus
  the process-death fallback.
- The watchdog-shim slims from a lifecycle manager to a transport adapter:
  no reboot choreography, no death replay, no crash-loop breaker storms —
  those handled a failure mode that no longer exists as a routine event.

## Phases

> **Superseded on 2026-09-02 by the architecture re-evaluation**
> (`docs/ARCHITECTURE-REEVALUATION-2026-09-02.md`, phases 0–8): harness trust
> and artifact discipline first (phases 0–1), then shipped-path shim safety
> (full-text sync + session ids, phase 2), the phase enum and explicit faithful
> action (3), two kernel rebuilds (build hygiene 4; single resolver with bounded
> environments — a covering-lookup MISS refuses instead of importing — 5), the
> resident cutover (6), retiring the pump transport (7), and regrouping the
> kernel series (8). The phases below are the original plan, kept for the
> reasoning trail; phases 1–3 here are done.

1. **Transport spike (Docker, no product wiring)** — apply the transport
   patch onto the current 30-series (kernel repo `FawadHa1der/lean4`,
   branch `qed64-wasm64`; pin discipline per `pipeline/toolchain/KERNEL-PIN`:
   any stage1 rebuild rebakes `work/snapshot/*.snap`). Build with
   PROXY_TO_PTHREAD; drive `lean --worker` over the ring from a Node
   harness (`pipeline/snapshot/node-runner.mjs` grows a `--resident` mode).
   Exit criteria: initialize/didOpen/diagnostics round-trip on a snapshot-
   seeded env; clean shutdown; no pump exports used.
2. **Session replacement in-process** — header switch = didClose/didOpen
   against the resident loop (the lean4game didOpen-replacement path in the
   shim is the template — coordinate with the game workstream, which relies
   on the tag-0 go-around). Exit criteria: the adversarial e2e switch
   scenarios pass with NO worker reboot observed (assert via a reboot
   counter in telemetry).
3. **Frontend cutover behind a flag** — `?resident=1` boots the new
   transport; the shim's reboot machinery stays as the fallback path.
   Run the full adversarial suite in both modes; storm gauntlets
   (`work/crash-gauntlet.mjs` recipe, promoted into the suite) must show
   the resident mode strictly better on: switch latency (target: covered
   switch < 1 s, uncovered < 15 s), zero renderer crashes at 4-minute
   mixed+imports storms, RSS steady ≤ 4 GB after boot.
4. **Memory discipline folded in** (PATCH-BACKLOG #1's spirit): with one
   process owning all envs, add explicit release — drop the init region
   after the umbrella covers it, evict env-cache entries superseded by a
   faithful re-resolution, and free `heapPtr` regions whose envs died.
   Exit criteria: heap meter stable across 20 switch cycles (no monotonic
   growth), verified by a suite scenario.
5. **Flip the default; retire dead machinery** — resident by default,
   reboot path kept only for genuine crash recovery. Delete the pump-era
   patches at the NEXT full rebuild (never mid-series), update
   ARCHITECTURE.md/HARDENING.md, upstream candidates per UPSTREAM-NOTES
   (transport core, #5 single-read loader, #6 compactor exception boundary
   ride along).

## Risks and their handles

- **Timed sleeps never wake on dedicated pthreads under this emsdk**
  (Shell.lean note; reportDelayMs=0 workaround) — the resident loop leans
  harder on sleeps/timeouts. The spike must smoke-test `IO.sleep`,
  `Task.spawn` timing, and the reporter under PROXY_TO_PTHREAD first.
- **JS pthread stack overflows** ("Maximum call stack size exceeded" under
  storms; browsers can't raise worker stacks) — the main loop moving to a
  pthread changes which stacks matter. Storm-test early (phase 1 harness).
- **emscripten-exports.txt pinning**: the transport patch reshapes
  functions → mangled specializations rename → link errors (3 prior
  incidents). Budget a finish.sh symbol-refresh pass.
- **Snapshot pairing**: every stage1 rebuild in this campaign rebakes
  work/snapshot and, on promote, the served artifacts + full first-visit
  drill (HARDENING 25's content-addressing protects stale caches).
- **The game workstream** builds on the same shim paths — phases 2/3 need
  its cypress suite green before each merge (coordinate via the session
  protocol that worked for the 0030 rebake).

## Explicitly out of scope

Multi-file projects, native mmap emulation, SharedWorker cross-tab session
sharing (separate backlog line), and any Mathlib curation changes.
