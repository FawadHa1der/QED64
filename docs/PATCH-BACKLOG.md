# Toolchain patch backlog (next Docker rebuild + snapshot rebake)

Each of these is coded or fully designed but needs the Docker pipeline
(down at time of writing). One rebuild + one rebake of BOTH snapshots
(binary-paired) covers all of them.

## 1. Alias coverage in the covering-env check — OBSOLETE (2026-09-04)
Was: `Shell.lean` `wasmLspInit`'s `aliasOk`, with the shim's client-side
header rewrite covering meanwhile. Patch 0032's `setupImports` resolver
carries the alias rule itself (the four aliases resolve as `covered` by
`QED64.Essential`); the pump entry point and the page-side rewrite
(`src/runtime/umbrella.ts`) are gone. Nothing left to build.

## 2. Bake the library-search index into the snapshot (designed)
See docs/LIBRARY-SEARCH-BAKE.md. First `exact?` drops from ~2 min to ~2 s.

## 3. Cancel the old session in wasmLspInit before replacing it — OBSOLETE (2026-09-04)
Was: the replaced pump session's elaboration/reporter tasks were abandoned,
not cancelled, and the replacement wedged (reproduced 2026-08-26 switching
the examples dropdown); patch 0024(a) `teardownForReplacement` was the
interim fix. The resident FileWorker never replaces a session for a header
change — `setupImports` re-runs in process and Lean's `cancelRec` discards
the previous header task — so a header switch is 322 ms edit → ready on the
served 0032 pairing with no session lifecycle at all. `wasmLspInit` and
`teardownForReplacement` retire from the kernel at the next pairing bump
(docs/PUMP-REMOVAL-ASSESSMENT-2026-09-04.md, step 3).

## 4. PROXY_TO_PTHREAD resident FileWorker — DONE (patches 0031/0032; the default and only page transport since 2026-09-04)
The REAL, unmodified `lean --worker` main loop runs on an application
pthread (`-sPROXY_TO_PTHREAD=1`), fed by a futex stdin ring (browser64's
transport port, patch 0031), with header resolution in `setupImports` and
`$/qed64/headerStatus` (patch 0032). See docs/RESIDENT-WORKER-PLAN.md for
the measurements and docs/ARCHITECTURE.md "Transport" for the living
description. What is still owed to it: the kernel-side deletion of the pump
entry points and the regrouping of 0018/0023/0027/0024(a) and the Shell
hunks of 0021/0025 at the next pairing bump, and a measurement of 0020
(keepalive guard) before dropping it — resident still runs library-style
calls (snapshot loads, the warm compile) before `main`
(docs/PUMP-REMOVAL-ASSESSMENT-2026-09-04.md, step 3).

## 5. Single-read no-mmap region loader (~40 lines, upstream-worthy)
Pinned `src/library/module.cpp` no-mmap path reads the 88-byte header, seeks
to 0, and re-reads the whole file — every olean is read twice (browser64
measured 38,568 = 2x19,284 reads on their Essential trace). Replace with one
whole-file read validated from the buffer; crib
`lean4-resident-transport.patch` lines 124-221. Our 0013 refactor makes it
slot in cleanly.

## 6. Exception boundary around lean_compacted_region_save (~30 lines)
The save path catches only `lean::exception` around the WRITE; compactor
CONSTRUCTION throws ("closures cannot be compacted", bad_alloc, cyclic
graphs) escape the extern-C boundary = opaque wasm abort — exactly where
heavy in-browser sessions die. Wrap construction+write, surface as IO.Error.
Crib `lean4-resident-transport.patch` lines 50-123. Upstream-worthy.

## 7. Server-slim REBAKE — DONE on branch experiment/server-slim-rebake (see docs/SERVER-SLIM-REBAKE.md; snapshot −60%, download −62%, heap −39%, zero diagnostic drift)

### (original notes)
Audited: `.olean.private` is 246/370 MiB of the core pack and 2006/3328 MiB
of essential (~60%), and the umbrella bake imported through those packs, so
the 2.6 GiB snapshot almost certainly retains the same dead weight (Lean's
importer opportunistically opens every facet present and finalizeImport
retains every opened region). The worker now hides `.olean.private` from
mounts (HIDE_PRIVATE_FACETS in lean.worker.js); a rebake through the
filtered mounts should shrink the snapshot toward ~1.0-1.2 GiB raw
(~350-450 MB download) and cut resident memory proportionally — the single
biggest lever on BOTH the cold-start and the OOM pains. Requires: rebake
both snapshots with the filter active, differential-test (import-all,
extension state, tactic runs, InfoView hover/go-to-def), repack the packs
without private facets for the same download win (370→124 MiB core).

## Negative results adopted from browser64 (do NOT pursue)
- **SharedWorker session persistence across reloads**: Chrome 151 exposes no
  Worker constructor inside SharedWorkerGlobalScope → it cannot own a
  pthread runtime; DedicatedWorkers are not transferable across reload.
  (their `sharedworker-editor-supervisor.md`; fails safe behind a flag.)
- **Fixed-address arena loading**: their own planner stamps
  `runtimeAdoptionEligible: false`; an 8 GiB arena base forces an 11.5 GB
  contiguous high-water — strictly worse for our OOM pain, and our
  relocation walk is only ~0.5 s anyway.
- **LEAN_MMAP fast path**: Emscripten's `__syscall_mmap2` rejects every
  nonzero address hint (EINVAL) and MEMFS/WORKERFS mmap copies anyway.
- **Initializer-only AOT island**: post-0017 our [init] replay is ~1 s;
  their data shows initializer-only leaves warm aesop at 24 s regardless.

## Measure-then-decide queue
- Warm aesop/norm_num latency in our pane: browser64's profile-native AOT
  body island (135 Aesop modules linked as generated C) took warm aesop
  22.3 s → 110 ms. If our warm aesop is seconds-class, the island is worth
  the 1-2 week toolchain investment. NOTE their standard-runtime baseline
  may be inflated by the Emscripten dlsym-shim overhead we already fixed
  (patch 0017) — re-measure, don't trust their ranking.
- Pthread pool 24 → fewer (browser64 runs 5): saves ~150-200 MB of stacks,
  but topology is fixed at link time (LEAN_NUM_THREADS is not honored late
  on Emscripten) and our elaboration showed 14 concurrent workers under
  load — needs an elaboration-throughput A/B at the next rebuild.
