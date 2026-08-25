# The wasm64 patch series

**The authoritative, upstream-ready series lives in [`patches/`](patches/):**
nineteen `git am`-able commits over `cauli/lean4@5732b84` (branch `qed64-wasm64`
in `work/lean4`), each with full rationale and an explicit upstreaming
verdict in its commit message. Summary:

| # | Patch | Upstream? |
|---|---|---|
| 0001 | Emscripten 6.0.5 wasm64 Docker recipe | recipe replaces the i386-stage0 shim |
| 0002 | CMake wasm64 configuration (-m64 end-to-end, memory cache vars, platform target) | plumbing yes; memory values are policy |
| 0003 | `LEAN_SCALAR_PTR_LITERAL` gated on pointer width, not `LEAN_EMSCRIPTEN` | **as-is** |
| 0004 | `llvm_is_declaration` C ABI + `LLVMBindings.lean` `Context` declaration order | **as-is** (live correctness bugs) |
| 0005 | `lean_kernel_diag_is_enabled`: `uint8`, not `uint8*` | **as-is** |
| 0006 | `EM_ASM_PTR` for pointer-returning EM_ASM in `runtime/io.cpp` | **as-is** |
| 0007 | Five missing non-libuv fallback stubs (Std.Net externs) | **as-is** (family of lean4#6817) |
| 0008 | Remove wasm32-era debug instrumentation; `lean_shell_main` 2-arg ABI | arity fix relevant; rest fork hygiene |
| 0009 | Regenerated explicit Emscripten export list (LP64 symbol universe) | regenerate, don't merge |
| 0010 | **`lean_wasm_compile` reports parser diagnostics** (the parse-error fix) | pattern applies to any `processCommand`-loop embedder |
| 0011 | **Compacted-region buffer growth survives multi-GB saves**: `realloc` + null check (a failed growth threw a null-pointer `memcpy` = "memory access out of bounds") + `LEAN_COMPACTOR_RESERVE` to reserve the output buffer up front | null check + realloc **as-is**; the reserve knob matters to any no-mmap embedder saving whole environments |
| 0012 | **Flat open-addressing object table for the compactor** (node-based map cost ~5 GB for the ~10^8 objects of a whole-Mathlib save; flat table ~2 GB, faster walk) | **as-is** (pure memory/perf win on every platform) |
| 0013 | **In-memory snapshot load** (`CompactedRegion.readMem`, `lean_wasm_load_snapshot_mem`): the host streams a region straight into a `malloc` buffer, skipping the MEMFS staging copy (a second multi-GB JS-heap allocation) | applies to any no-mmap host; the shared `finish_region_read` refactor is upstream-neutral |
| 0014 | **Snapshot-load stage timings + streamed init progress**: every load reports region-read vs `[init]`-replay split (plus top-10 module timings when replay >5 s), and streams `[WASM INIT] i/n module` per module so hosts can render live progress through the blocking call | diagnostic; the numbers justify upstream work on initializer execution |
| 0015 | Multi-arch emsdk base image (drops the -arm64 pin so amd64 hosts build natively) | build hygiene |
| 0016 | **Replay-control flags on `lean_wasm_load_snapshot_mem`** (bit 0 = run the `[init]` replay; extension states come from the region, the replay rebuilds process-side registrations) | fork-shaped control surface; useful to any embedder |
| 0017 | **Interpreter dlsym probes gated on the wasm export table**: `lookup_symbol_in_cur_exe` consults a one-time `Set` of export names before calling dlsym | **as-is** for the Emscripten target — turns a 173 s pathology into ~1 s (below) |
| 0018 | **Host-pumped LSP file worker** (`lean_wasm_lsp_init` / `lean_wasm_lsp_send`): drive a single-file server session one message at a time when a blocking stdin is impossible (WASM event-loop hosts); forces `server.reportDelayMs := 0` (timed sleeps on dedicated pthreads do not wake under this build) | experimental (branch `feature/lean4web-frontend`); the embedding shape mirrors the watchdog contract |
| 0019 | **24 preallocated pthread workers, 8 MiB thread stacks**: every `ServerTask` is `prio := .dedicated`, and synchronous `pthread_create` under Emscripten can only claim preallocated workers | needed by any wasm host running the language server |

Profile verdict (2026-08-23, superseded 2026-08-24): a whole-Mathlib snapshot
load spent **~0.7 s relocating 2.6 GB and ~114 s in 152 modules' interpreted
`[init]` replay**. A shared-interpreter-context patch (reusing symbol/constant
caches across the replay) was built, measured — no improvement — and reverted;
that experiment concluded "the time is real interpreted work". **It was not.**
A `--profiling-funcs` CPU profile attributed 173 s of a 180 s load to the
JavaScript `dlsym` shim: the interpreter probes for a *native* implementation
of every symbol it touches, no Mathlib symbol exists in the binary, and under
Emscripten every miss crosses into JS and allocates an error string. Patch
0017's export-table gate collapses the replay to **~1.1 s** (total 2.57 GiB
load: 117.5 s → **1.95 s**) and the first full-stress compile from 32–36 s to
**4.3 s** — the same storm was throttling compiles. The wasm64 footgun inside
the fix: EM_JS pointer parameters arrive in JS as BigInt, and `UTF8ToString`
does Number arithmetic — convert first or every probe throws "Cannot mix
BigInt" (the same class of bug as patch 0006).

A note on 0011's diagnosis, kept because the wrong turn is instructive: the
crash trace shows the compactor ~2,500 frames deep in its object recursion,
which reads like a stack overflow. It is not — instrumentation showed the
recursion bounded at 2,501 while 90 million objects streamed out; the process
died precisely as the output crossed 2 GiB, where the buffer tried to double.
A 128 MB main stack and a heap-stacked thread were both tried and discarded
before the counters settled it.

Build deviations from the evidence recipe (documented in
`work/lean4/docker-wasm64/configure-qed64.sh`): declared memory maximum
raised to 16 GiB (embedder-import compatibility), and
`CHECK_OLEAN_VERSION=OFF` (this clone embeds its real githash while the
certified profile packs carry the producer's; compatibility is enforced at
the SHA-256 manifest layer, and no patch touches serialization).

The sections below are the original working notes the series was distilled
from, kept for the reasoning trail.

---

# The wasm64 patch contract (15 files, +78/−307 over reinstate-wasm)

Verified against the successful spike; each item says WHY so the patch can be
re-derived on any future base revision.

## ABI corrections (upstreamable — wrong on every platform)

1. `src/library/llvm.cpp` — `llvm_is_declaration` must return raw `uint8_t`,
   not `lean_object*`: generated C declares `uint8_t (size_t, size_t)`, and
   `lean_box(0)` = 1 reads as `true`. wasm32 masked it (both lower to i32);
   wasm64 fails validation in `l_Lean_LLVM_isDeclaration___boxed`.
2. `src/kernel/environment.cpp:28` — declare
   `extern "C" uint8 lean_kernel_diag_is_enabled(object*)` (not `uint8*`).
   Symptom under wasm64: all modules load, then "Cannot convert 0 to a BigInt"
   from the exception trampoline inside `scoped_diagnostics`.

## Pointer-width gates

3. `src/include/lean/lean.h` — `LEAN_SCALAR_PTR_LITERAL` must select its
   layout from `UINTPTR_MAX == UINT32_MAX`, never `LEAN_EMSCRIPTEN`:
   Emscripten no longer implies 32-bit; the wrong arm silently corrupts
   statically-emitted scalars (e.g. Name hashes).
4. `src/runtime/io.cpp` — pointer-returning `EM_ASM_INT` → `EM_ASM_PTR`
   (`lean_io_getenv`, `lean_io_app_path`): EM_ASM_INT truncates wasm64
   addresses above 4 GiB.
5. `src/util/shell.cpp` — delete the debug argv walker that indexed `HEAPU32`
   with a 4-byte stride, and the stale 3-argument `lean_shell_main`
   declaration (generated ABI has 2 arguments).

## Build system

6. `src/CMakeLists.txt` — `-m64` in C/CXX flags (outer + stage1 + generated-C
   `leanc` + patched libuv), INITIAL/MAXIMUM memory as cache variables
   (128 MiB / 16 GiB), `STAGE1_LEAN_PLATFORM_TARGET=wasm64-unknown-emscripten`
   (without it the binary *works* but reports a wasm32 target string).
7. stage0 = plain native 64-bit; drop `-m32 -msse2 -mfpmath=sse` and the i386
   OpenSSL install. LP64 stage0 artifacts are directly compatible with the
   wasm64 runtime.

## Link completeness

8. `src/runtime/uv/tcp.cpp`, `udp.cpp` — five non-libuv fallback stubs
   (`tcp_wait_readable`, `tcp_cancel_recv`, `tcp_try_accept`,
   `udp_wait_readable`, `udp_cancel_recv`) that `lean_always_assert(false)`;
   they close the link, they are NOT network support.
9. `src/emscripten-exports.txt` — regenerate for the 64-bit symbol universe.

## Explicitly unchanged

- JS-exception mode stays (`-sDISABLE_EXCEPTION_CATCHING=0`);
  `-fwasm-exceptions` is a known miscompile on this tree under emsdk 6.
- `MAIN_MODULE=2` + explicit exports stays (the interpreter's dlsym contract).
- `USE_GMP=OFF` stays: the olean header's GMP flag must match between the
  artifact producer and this runtime.

## Known defect in runtime `wasm64-02e0ac24cced25d8` (fix on next rebuild)

**Parse errors are silently dropped by `lean_wasm_compile`.** Empirically
characterized (see the persistent probe): garbage text, bare identifiers, and
unterminated declarations produce `scalar=0`, zero diagnostics; elaboration
errors (type mismatches, failed tactics, false proofs) report correctly.

Cause: `Shell.lean`'s `wasmCompile` collects `commandState.messages` AFTER
`Frontend.processCommand`, but `elabCommandTopLevel` (Lean ≥ 4.33 incremental
frontend) resets the log at the start of each command — parser messages are
attached BEFORE elaboration and are lost to that reset.

Fix for the next runtime build: inline the parse step in the collect loop so
parser messages are captured between parse and elaboration —

```lean
-- replace `done := (← Elab.Frontend.processCommand)` with:
Elab.Frontend.updateCmdPos
let cmdState ← Elab.Frontend.getCommandState
let ictx := inputCtx
let pstate ← Elab.Frontend.getParserState
let scope := cmdState.scopes.head!
let pmctx := { env := cmdState.env, options := scope.opts,
               currNamespace := scope.currNamespace, openDecls := scope.openDecls }
let (cmd, ps, parseMessages) :=
  Parser.parseCommand ictx pmctx pstate cmdState.messages
acc := acc ++ parseMessages            -- ← the messages the reset would eat
Elab.Frontend.setParserState ps
Elab.Frontend.setMessages parseMessages
Elab.Frontend.elabCommandAtFrontend cmd
done := Parser.isTerminalCommand cmd
```

Gate the rebuild on: garbage input → ≥1 error diagnostic; the defect test in
`tests/integration/persistent-path.test.ts` flips red when this lands.
