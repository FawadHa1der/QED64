# Resident FileWorker — the plan (PATCH-BACKLOG #4, promoted)

Status: PHASE 1 IN PROGRESS (2026-09-02). This is the campaign that retires
the reboot-per-header-change architecture. Written after the 2026-09-01/02
crash investigation, whose measurements set the targets below.

## Phase-1 spike results (2026-09-02) — transport PROVEN, one blocker open

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

OPEN (phase-1 completion, both are known/predicted, neither fundamental):
1. **Final-flush + concurrent-read under long elaboration.** After the
   initial (empty) diagnostics, a longer elaboration's completion
   diagnostics do not flush, and a tickler `waitForDiagnostics` sent during
   elaboration gets no response — i.e. the resident `mainLoop` is not
   interleaving new stdin reads with in-flight elaboration the way the
   pump path's host loop does. This is risk #1 from the list below
   (reporter/output timing under proxied pthreads) landing exactly where
   predicted. Next: study `mainLoop`'s read/elaborate/report interleaving
   and the reporter's task scheduling under a task pthread; the pump path's
   reportDelayMs=0 + tickler is a partial analogue.
2. **Headerless probe imports on the elaboration thread.** A file with no
   explicit import resolved `[Init]` which did not hit the init snapshot's
   `#[Init, Init]` covering env, triggering an olean import on the
   elaboration pthread (the documented can't-import-there hang; ~44 s CPU
   then idle). The covering matcher needs to also satisfy the implicit-Init
   case, or the spike must use a probe whose header matches a seeded env.

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
