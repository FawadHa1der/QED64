# Upstream bugs and platform limitations

Consolidated from our own campaign plus a deep read of the sibling
wasm64-lean-codex/browser64 implementation (2026-08-26; both projects pin
Lean commit 5732b84 and Mathlib de3a9cf, so their evidence transfers).
Evidence paths reference `/Users/fawadhaider/code/wasm64-lean-codex` (read-only).

## Lean

1. **No-mmap region loader double-reads every olean** — 88-byte header
   probe, `lseek(0)`, whole-file re-read (`src/library/module.cpp`).
   38,568 = 2×19,284 reads measured on an Essential import trace.
   *Evidence:* `browser64/toolchain/lean4-resident-transport.patch` 124-221.
2. **Eager facet retention on import** — `Elab/Import.lean` forces the
   exported olean level, but `readModuleDataPartsOfMod` still
   opportunistically reads every `.olean.server`/`.olean.private` (and both
   IR levels) present, and `finalizeImport` retains all opened regions.
   60-70% of retained-region bytes can be dead weight.
   *Evidence:* `docs/mathlib-measurements.md` 299-323; our own pack audit
   (private = 246/370 MiB core, 2006/3328 MiB essential).
3. **`ir_interpreter` caches native-symbol MISSES globally** and assumes no
   code is loaded later (`src/runtime/ir_interpreter.cpp:368-377`) — any
   AOT island or dlopen'd module linked after first interpreter use is
   silently ignored forever.
4. **IncrSnapshot initializer replay is self-labeled "incr HACK"**
   (`Frontend.lean:330-350`) — env changes may already be captured while
   process-global `IO.Ref` effects still need replay; neither project has
   an initializer-effect allowlist or cold-vs-snapshot equivalence fixtures.
   Applies to our umbrella `[init]` replay too.
5. **`--incr-load` leaks producer options** — `setMainModule` carries the
   producer's baked scope `Options` and `maxRecDepth` into the consumer
   session; header mismatch is discovered only after dep regions are
   materialized and initializers replayed.
   *Evidence:* `browser64/toolchain/lean4-browser64.patch` 103-247.
6. **`CompactedRegion.free` is never sound for a live snapshot region** —
   initializer globals, async snapshot tasks, info trees, RPC sessions and
   extension state hold region-interior pointers invisible to RC/GC. The
   Worker is the only sound teardown unit. QED64 must never add env-cache
   eviction that frees a region.
   *Evidence:* `browser64/experiments/mathlib-boot-capsule-v2/LIFETIME.md`.
7. **`lean_compacted_region_save` catches only `lean::exception` around the
   write** — compactor-construction throws ("closures cannot be compacted",
   `bad_alloc`) escape the extern-C boundary → opaque wasm abort.
   *Evidence:* `lean4-resident-transport.patch` 50-123.
8. **Recursive `object_compactor::to_offset` has unbounded stack depth** and
   hangs/overflows on cyclic object graphs instead of rejecting them.
   Their explicit-stack + cycle-rejection rewrite is upstream-worthy
   (our 0011/0012 harden growth, not stack/cycles).
9. **`.ir.sig` is a pure existence sentinel** on the Emscripten interpreter
   path — the loader requires it before opening `.ir` though it could open
   `.ir` directly. One overhead file per module.
10. **Two C ABI declaration mismatches masked by wasm32** — `llvm_is_declaration`
    (pointer vs `uint8_t` return) and `lean_kernel_diag_is_enabled`
    (`uint8_t*` vs `uint8_t`). Both forks fixed independently (our patches
    0004/0005); still unreported upstream.
11. **`LEAN_NUM_THREADS` is not honored as a late override on Emscripten** —
    thread topology is fixed at link/process-init; tuning needs a rebuild.
12. **Residual LSP output flush miss** (ours): a response frame occasionally
    stays in the TTY buffer past our patch-0022 flush; root cause open
    (client-side tickler + response watchdog compensate).
13. **Emscripten teardown at `checkMailbox`** (ours, patch 0020): a pthread's
    first sync-proxied op with keepalive==0 exits the runtime mid-proxy.
    Report ready in docs/EMSDK-BUG-REPORT.md (user files it; do not file).

## Emscripten

14. **JS dlsym shim allocates an error string per native-symbol miss** — we
    attributed a 173 s init tail to it (fixed by patch 0017's one-time
    wasmExports-key Set). browser64's MAIN_MODULE=2 build has no attribution
    for its 436-516 s cold tail — their AOT A/B baseline may be partly this.
15. **`__syscall_mmap2` rejects every nonzero address hint (EINVAL)** and
    MEMFS/WORKERFS mmap emulation copies anyway — `LEAN_MMAP`'s fixed-address
    fast path is unreachable in browsers.
16. **`Memory.grow` replaces the SAB object while stale views alias the old
    prefix** — Emscripten hands pthread-proxied FS reads exactly such stale
    views across a concurrent grow. Any cached heap view must be reacquired
    (our snapshot loops re-derive views per chunk for this reason).

## Chrome / platform

17. **SharedWorker cannot own a pthread runtime** — Chrome 151:
    `typeof Worker === "undefined"` inside `SharedWorkerGlobalScope`;
    `extendedLifetime` (Chrome 148) only extends the shell. Kills
    cross-reload runtime reuse for both projects.
18. **16 GiB is the practical JS-API memory ceiling** — 20/24 GiB
    declarations are engine-rejected everywhere tested.
19. **OPFS quota (Firefox)**: eviction threshold is the smaller of 10% of
    the profile volume and a 10-GiB site-group limit; a copy-fallback pack
    install can transiently need ~2× the pack size (Chromium's atomic move
    avoids it).

## Mathlib

- No Mathlib-specific upstream bugs found by either project at this pin.
  (browser64 carries build patches for de3a9cf-on-5732 — sigma/namespace
  fixes needed for their FULL-Mathlib bake; relevant only if we extend our
  umbrella beyond the essential profile.)
