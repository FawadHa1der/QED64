# Field notes: failure modes met during live bring-up

Every one of these was hit for real in the embedded Chromium pane, fixed, and
regression-pinned where testable. They will save the next person days.

1. **`let Module` collides with the Emscripten glue.** `importScripts(lean.js)`
   declares `var Module` at worker global scope; any lexical `Module` binding
   in the worker throws "Identifier 'Module' has already been declared" at
   import time. Name your handle anything else.
2. **Emscripten captures `print`/`printErr` once.** Reassigning
   `Module.print` after runtime init does nothing. Route output through an
   indirection sink installed before `importScripts`.
3. **`/bin` must exist in the virtual FS** or `lean_init_search_path` fails
   with `no such file or directory: /bin` — Lean stats the executable's
   directory (`IO.appPath` reports `/bin/lean`).
4. **The build exports `getValue`, not `HEAPU8`.** Reading Lean objects via
   `Module.HEAPU8` crashes; use `getValue(ptr, "i8"/"i64")`.
5. **Persistent-shell diagnostics are JSON lines.** `lean_wasm_compile` prints
   one JSON object per diagnostic (with `endPos`!). Parse JSON first, fall
   back to `file:line:col:` text.
6. **Embedders lie about storage.** This Electron pane reports a 6.16 GiB
   quota but OPFS dies at ~2.1 GiB — and *hangs* rather than rejects while
   the tab is backgrounded (the QuotaExceededError only surfaced when
   fronted). Watchdog every OPFS write; remember the observed ceiling.
7. **A rejecting sink wedges a TransformStream.** If the gunzip consumer dies
   without cancelling its reader, the transform's queue stays full and every
   pending ingress `write()`, `close()` AND `abort()` waits forever. Cancel
   the reader in the consumer's catch; never `await` the transform abort.
8. **Multi-GB Blobs break `FileReaderSync` in embedders.** A 3.25 GiB
   in-memory Blob mounted via WORKERFS failed to read — and once Blob storage
   was poisoned, even the 48 MB runtime blob failed. Bounded byte segments
   transferred to the worker and written into MEMFS avoid Blob storage
   entirely (MEMFS contents live in the worker's JS heap, not wasm memory).
9. **WORKERFS mounts shadow the mount directory.** Mounting core at
   `/lib/lean/library` hid the Mathlib files MEMFS had written beneath the
   same path — "unknown module prefix 'Mathlib'". One directory per profile,
   colon-joined `LEAN_PATH`.
10. **Hidden-pane timers freeze.** The embedded pane suspends page timers
    while hidden, so time-based watchdogs only fire when visible. Don't rely
    on wall-clock watchdogs for correctness; they are a recovery accelerant.
11. **An artifact inside an ESM package breaks Emscripten pthread workers.**
    Node treats `lean.js` as ESM when the nearest package.json says
    `"type": "module"` → `require is not defined` from every pthread worker.
    Drop a `{"type":"commonjs"}` package.json next to the binary.
12. **`cache: "force-cache"` can serve a poisoned response forever.** A 404
    SPA-fallback page cached before artifacts were deployed keeps failing
    verification on every load. Content addressing makes the fix safe:
    on verification failure, retry once with `cache: "reload"`.
13. **Vite's public/ dir is indexed at server start.** Files added later
    return the SPA fallback (HTTP 200, text/html) — which then poisons the
    HTTP cache (see 12). Restart the dev server after syncing artifacts.
14. **Fresh Lean build trees stop at `libleaninitialize.a`.** The published
    reproduction recipe never builds the `leaninitialize` target (iterative
    build dirs had it); build it explicitly before the final `lean` link.
15. **Git inside a Docker bind mount needs `safe.directory`,** or `git
    rev-parse` fails silently during configure and stage0 embeds an EMPTY
    githash — exactly the provenance failure the release gates prohibit.
16. **A session's OPFS view can rot mid-session.** After a quota-exceeded
    event, this pane's origin directory listed as EMPTY from the same page
    while the bytes stayed quota-pinned — and every WORKERFS read through the
    already-obtained `File` objects threw `FileReaderSync` NotFoundError
    (a reload saw the files intact again). Deleting a mounted pack breaks
    reads the same way. Baked snapshots masked it for a whole session: the
    first *real* olean read may come minutes after mount. Recovery: classify
    the compile failure (`isStaleStorageError`), reinstall (revalidates the
    cache with fresh handles or re-downloads), reboot, re-check — once,
    automatically. `readCached` also probes one byte at each end of a cached
    pack so a dead cache misses instead of booting a doomed session.
17. **An uncaught promise rejection can hang a phase forever.** Under memory
    pressure (several reloads' worth of multi-GB sessions), an
    `Array buffer allocation failed` RangeError inside the worker's async
    boot path rejected a promise nobody awaited: the app sat at "Mounting
    verified library packs" indefinitely with the error only in the console.
    The worker now has an `unhandledrejection` handler that fails the
    in-flight boot/compile request through the normal RPC error path. Also:
    a snapshot stream that dies mid-write must unlink its partial MEMFS file,
    or the fallback import runs under the gigabytes the leak still holds.
18. **A recursion-shaped crash trace is not a stack overflow until a counter
    says so.** Saving a whole-Mathlib region died with "memory access out of
    bounds" in the compactor's self-recursive `to_offset`/`insert_*` frames,
    and three stack-size experiments (128 MB main stack, 1 GiB and 4 GiB
    heap-stacked threads — the last two silently worse, because they ate the
    same address space) all failed before depth/object counters showed the
    recursion bounded at 2,501 frames over 90 million objects. The process
    died exactly as the output crossed 2 GiB: an unchecked `malloc` for the
    doubled buffer failed and `memcpy` wrote through NULL. Instrument first;
    a wasm trap's call stack tells you where, not why.
19. **A `.gz` URL is not a promise of gzip bytes.** Vite (and nginx
    `gzip_static`, and most CDNs) answer `.gz` files with
    `Content-Encoding: gzip`, so the browser hands the worker *inflated*
    bytes and `DecompressionStream` fails with "incorrect header check" —
    silently, if the boot-snapshot catch swallows it (it no longer does).
    Sniff the gzip magic on the first chunk, and serve compressed snapshots
    under a non-gzip name (`.snapz`) so the OPFS cache stores the compressed
    bytes rather than 2.5 GiB of pre-inflated region.
20. **A 100-second synchronous wasm call looks like a hang.** The region load
    is one blocking call; the progress bar sat at 100 % and the stale warning
    from the previous check stayed on screen ("Install Mathlib from the Setup
    tab" — while Mathlib was installed and loading). Users read that as
    "compilation does not work". Fix: the worker posts a phase event *before*
    the blocking call; the app renders a live status card with stage, elapsed
    time and an honest estimate, swaps the bar to indeterminate, and replaces
    any stale diagnostics. The 1 s ticker is what keeps it alive.
21. **A Lean `@[extern]` on an IO function receives NO world parameter.** The
    C signature is exactly the explicit arguments, returning the IO-result
    object — `lean_run_init(env, opts, decl, initDecl)`, four params, no
    world. Adding a trailing `obj_arg w` (cargo-culted from `lean_apply_1`)
    makes the wasm function type differ from the caller's declaration, and
    the direct call traps `RuntimeError: unreachable` with no diagnostics —
    three build cycles went to closure-ABI and visibility theories first.
    When a fresh extern traps at the call edge, read the *generated C*
    (`build/stage1/lib/temp/**/*.c`) for the emitted prototype before
    theorizing.
22. **A long-idle session can start returning IO errors for every compile.**
    A session green at 23:47 returned `lean_wasm_compile returned an IO
    error` for *all* buffers ~10 h later, including ones that had just
    passed; a fresh worker handled the same buffers fine (`#eval` on a
    noncomputable `Real` is a proper diagnostic there, not an IO error).
    Root cause unidentified — the poisoned session's log was lost. Defenses
    now shipped: the worker appends the runtime's actual stderr tail to the
    error (no more "see log"), and an IO-error compile triggers a trivial
    probe compile — healthy runtime keeps the session; a broken one gets one
    automatic reboot (cache-revalidating reinstall) and the interrupted
    check re-runs itself. Live-drilled via injected failures: healthy branch
    keeps the session, poisoned branch self-heals to ✓ with no user action.
23. **Real networks drop connections mid-gigabyte.** The first Mathlib
    install against the deployed site died at 1.16 GiB with a bare
    "Failed to fetch" — one transient failure among ~60 sequential part
    downloads, fatal, recoverable only by page reload. Localhost testing can
    never surface this. Every part fetch now retries with backoff
    (0 s/2 s/8 s, cache-bypassing), and a failed install renders a
    "Retry install" button — verified parts are already in the HTTP cache,
    so retries resume nearly for free.
24. **"The time is real work" needs a CPU profile before you believe it.**
    The 115 s umbrella `[init]` replay survived one failed optimization
    (shared interpreter caches — measured, no change) and was written off as
    irreducible interpreted execution. A `--profiling-funcs` build + DevTools
    profile then attributed **173 s of a 180 s load to the JS `dlsym` shim**:
    the interpreter probes every symbol for a native implementation, misses
    on all of Mathlib, and each Emscripten miss crosses into JavaScript and
    allocates an error string. An EM_JS gate over a one-time `Set` of
    `wasmExports` keys (toolchain patch 0017) collapsed the replay to ~1 s
    and cut first-compile times 8× — the storm had been throttling *every*
    interpreter run, not just the replay. Two sub-lessons: wall-time
    attribution by stage (patch 0014) cannot distinguish "interpreter is
    slow" from "interpreter's host calls are slow" — only a sampling profile
    can; and EM_JS pointer params arrive as BigInt under wasm64, so
    `UTF8ToString(Number(sym))`, or the gate itself throws "Cannot mix
    BigInt" from inside the replay (the patch-0006 class again).
25. **A rebuilt runtime bakes a snapshot of the IDENTICAL raw size.** Same
    environment content, different relocation values: old and new umbrella
    regions were both exactly 2,755,235,045 bytes (init: 342,124,365). So a
    size check can never detect a stale snapshot, and the first live deploy
    of a new runtime trapped "memory access out of bounds" on every compile
    for returning visitors: `/snapshots/mathlib.snapz` was a **fixed URL
    served immutable (max-age 1y)**, the browser HTTP disk cache kept the
    old bytes, they inflated to precisely the size the fresh index declared,
    and the loader relocated old-function-table pointers against the new
    binary. Fixes: content-addressed snapshot names
    (`<name>.<sha256-16>.snapz`, digest in the index — immutable caching is
    only safe under content addressing), the OPFS cache keyed by digest
    instead of sizes, commit-time pruning of superseded same-name entries
    (multi-GB corpses otherwise accumulate into the origin's quota), and
    wasm traps ("memory access out of bounds", RuntimeError) joining IO
    errors as probe-then-reboot triggers. Sub-lesson: deleting OPFS entries
    while iterating `dir.keys()` silently invalidates the iterator — collect
    names first, then delete.
26. **"Ready" on screen does not mean the worker is free.** The app flips its
    phase to ready before the boot snapshot load, and snapshot loads are
    `async` on the worker while owning the runtime (`state = "compiling"`) —
    so a manual check in that window posts a compile the worker CAN process
    mid-load, and it bounces with BAD_STATE, rendered live as "Compile
    failed: Worker is 'compiling', not ready." (2026-08-25). The app-side
    collision queue (`compileQueued`) never engaged because it keys on the
    app phase, not the worker's. Fix at the seam: `LeanSession` serializes
    all runtime-owning RPCs (compile, loadSnapshot) through a promise chain
    — a turn only starts after every earlier one settles, and turns queued
    when the session dies reject instead of posting into a terminated worker
    (regression-pinned in `tests/unit/session-serialization.test.ts`). The
    app additionally treats any residual BAD_STATE compile rejection as
    queue-one-retry rather than a rendered error.

<!-- 2026-09-02: resident-worker campaign, second pass -->

27. **Frame parsers must locate the header, not assume it — and must resync.** The worker's stdout interleaves library progress lines with LSP frames. A parser that scans only the first 256 bytes for `Content-Length` wedges on the first such line while the worker keeps answering — misdiagnosed as a runtime stall for hours. The obvious fix (decode the whole buffer per chunk) is O(n²) under a diagnostics storm and allocates megabyte strings per call. Since the byte-channel rewrite (spec W1) the mechanism is a per-byte TTY tap (`installStdoutTap` swaps `TTY.ttys[makedev(5,0)].ops.put_char`; the glue's default sink line-buffers until `\n`, which is why the last frame of every burst used to sit unflushed) feeding ONE decoder shared by the worker and the Node probe, `public/workers/lsp-frames.js`, pinned by tests/unit/lsp-frames.test.ts (every split of the byte stream, multibyte bodies, a 4 MB linear-time case, junk accounting). Two properties are load-bearing: frames are byte-exact (no newline heuristics), and a junk run ends at the first `Content-Length:` inside it, not only at `\n` — bodies carry no LF, so a decoder without that resync turns one non-LF stdout write glued to a header into every later frame being junk for the life of the session, silently. The sibling file must be served next to lean.worker.js (`importScripts`); a consumer that copies the worker alone gets `WORKER_DEP_MISSING` instead of a hang.

28. **A resident worker's document must never be behind the editor's when an incremental change is sent.** Holding header keystrokes (to debounce a re-elaboration) while forwarding body keystrokes incrementally corrupted the worker's copy — offsets were computed against text it never received — and each corrupted version re-elaborated garbage until the tab died. Rule: one flag with one meaning (`residentUnsynced`: the worker is behind); while set, hold EVERY edit; clear it only when a full-text didChange goes out.

29. **Never hand an elaboration pthread a header it must resolve from the filesystem.** With the Mathlib pack mounted, an unresolvable import (`Mathlib.Tactic.Bogus`) makes the resident worker's elaboration pthread do a WORKERFS lookup and stall — the pill reads `elaborating` forever; in Node (no Mathlib dir) the same header fails fast with `isSetupFailure`. The client gate (`unknownImports`: the installed profiles' `moduleNames` plus the umbrella when its snapshot is resident) refuses such headers before the worker sees them and shows the pump path's calm hold. The kernel-side invariant (lookup MISS ⇒ header error, never an on-thread import) is the durable fix and is on the roadmap.

30. **Publishing to the wrong load path is silent.** `Language.Lean.setPrebuiltHeaderEnvs` was called from `wasmLoadSnapshot` but the browser and the spike load through `wasmLoadSnapshotMem`; the covering lookup was never consulted and every header imported 629 Init modules on-thread (~17 s). Nothing failed — it was merely slow. The `[WASM LSP] prebuilt lookup HIT|MISS` stderr trace makes this class visible; keep it.

31. **Pinned compiler-generated specializations are a build-time fact, not a source file.** `src/emscripten-exports.txt` pins names like `_l_IO_println___at___00Lean_finalizeImport_spec__3___boxed`; any Lean edit that changes specialization numbering breaks the link (fourth incident). Find ALL stale names at once with a whole-identifier scan of `stage1/lib/temp/**/*.c` — never a `(`-suffixed scan, which flags every non-function export as stale (8,184 valid lines were deleted that way and restored from git). `prelude` modules (Lean/Language/Lean.lean) need an explicit `import Init.System.Platform` for `System.Platform.isEmscripten`.

32. **The chunker must never write into public/runtime.** `chunk-runtime.mjs --out public/runtime` rewrites the tracked default manifest AND replaces `public/runtime/chunks`, destroying the served runtime's (gitignored) chunks. `git checkout` restores the manifest, not the chunks; every dev boot then fails with `lean.js chunk 0: 6373 bytes, expected 16777216` (vite's SPA fallback), and a whole e2e gate silently ran against an unbootable page. Chunk into `work/runtime-<tag>` and install only the per-hash manifest (recipe in docs/RESIDENT-WORKER-PLAN.md).

33. **A test run that cannot boot must refuse, not fail scenarios.** Three artifacts produced false failures today: an unbootable runtime (above), a dead page after the corpus loop throwing UNCAUGHT and skipping three scenarios, and absolute time budgets under machine load (67 s vs 136 s for the same battery item). The harness now recovers a dead page before the fixed scenarios; the pyramid must additionally preflight the paired artifacts and budget relative to a measured baseline.

34. **A probe that dies without closing its browser starves every later stage.** A Playwright probe threw an uncaught timeout right after the compiler battery (3.3 GB free), never reached `browser.close()`, and left a headless Chromium holding gigabytes; the next stage's page then needed seven minutes to not boot, threw, and left another. Twenty-one Chromium processes later the whole re-run read as "the product cannot boot". Rules: every probe closes its browser in `finally` (and prints its verdict there); a cool-down between browser stages kills stray `chrome-headless-shell` processes and waits until free+inactive memory is back above ~6 GB (`work/rerun-resident.sh: cool()`), because a dead page's committed shared memory is reclaimed slowly (lesson 26's mechanism, seen from the harness side); and `pkill -f <script>` must not match the watcher that greps for that script.

35. **`npx tsc --noEmit` at the repo root does not type-check the front end.** The root tsconfig includes `src` and `tests` only; `frontend/` has its own config and is checked by `npm run typecheck:site`. Two edits to `frontend/src/watchdog-shim.ts` passed the root check and crashed at load — an import of `"../../"` (a grep that returned empty mid-edit) and a bare `mode` in a method where only `this.mode` exists — and `vite build` (esbuild) accepted both too. Both broke boot in EVERY mode and were found only by a page that never became ready. Rules: run `typecheck:site` after any front-end edit; run a 20-second boot smoke before any long browser suite (the re-evaluation's phase-0 preflight); treat "typecheck-ok" as a statement about `src/` unless the command names the front end.

36. **The stdlib builds with warnings as errors: every public `def`, `structure` and field you add to the fork needs a doc string.** A `⚠ Building Lean.Language.Lean` block followed by `error: build failed` with no diagnostic text means exactly this (the warnings sit a few lines above it: `missing doc string for public def …`). `private def`s are exempt. Budget for it before Docker: `grep -nE "^(def|structure|  [a-zA-Z?]+ :)" <changed file>` and check each has `/-- … -/` above it.

37. **`set -e` does not stop a failed command inside an `&&` list.** A chain written `bash build.sh && bash finish.sh && echo BUILD-OK` under `set -e` continues past a failed build: the next lines chunked and baked the PREVIOUS binary and reported its (unchanged) buildId as if it were new. Guard each stage explicitly (`if ! …; then echo STAGE-FAILED; exit 1; fi`) and assert the produced buildId differs from the last one (`CHUNK-UNCHANGED` is a failure).

38. **A merge dry-run is only valid for the commit it was run against.** `git merge-tree` reported zero conflicts for the relay branch at its implementation commit; the review-fix commit that followed touched the same `lean.worker.js` region as another track's fix already on `main`, and the real merge conflicted in three hunks. Re-run the dry run after every commit on a branch you intend to merge, and resolve by combining both sides' intent (here: the loud sibling-script load AND the lazy front-door import; the size-checked opening frames AND `residentOpenLoop()`; the heartbeat/front-door teardown AND the stranded-ack drain).

39. **The bake's staging tree is `work/staging/<buildId>/snapshots/`, and a retargeted `public/` symlink needs a vite restart.** The merged bake refuses to write beside an entry baked by another runtime (or an unstamped one), so each build gets its own staging directory; the dev symlink `public/snapshots-0031` must point at the `snapshots/` subdirectory, and vite (which indexes `public/` at startup) must be restarted afterwards or the preflight sees the SPA fallback as the index — `PREFLIGHT REFUSED: … served HTML (SPA fallback), not JSON` is that exact symptom, and the harness catching it is the point.

40. **A session loss kills background work and its watchers silently.** When the Claude Code process exits, `vite`, a running pyramid and every Monitor die with it; the next session finds partial report files whose rows have no `outcome`. Treat any report without `PYRAMID…-DONE` as void and rerun; keep the state needed to resume (branch, commit, buildId, staging dir) in memory, not in the conversation.

41. **Never pipe a stage that starts a background server through `tee | grep`.** `bash resident-gate.sh | tee log | grep …` hung for five hours after the gate printed `GATE-DONE`: the gate's `nohup npx vite … &` child kept the pipe's write end open, `tee` never saw EOF, `grep` never exited, and the wrapper never reached the next lane — while every test process was gone and a watcher reported nothing wrong. Write each stage to a file (`> stage.log 2>&1 < /dev/null`) and grep the file afterwards; a wrapper's liveness check must look for the *test* processes, not for the wrapper itself.

42. **A client-side diagnostic must ride inside the server's `publishDiagnostics`, never in one of its own.** LSP diagnostics are a whole-document replacement per URI: the shim's separate publish of an explanatory note briefly hid the worker's real "already declared" errors and was overwritten by the worker's next burst, so the InfoView never showed it (`note=false` while the offer button was visible). The note is now appended to the worker's own diagnostics array as the message passes through `observeServerMessage` (which runs before the forward), re-appended on every collision burst for that header, so it lives and dies with the errors it explains. The same rule applies to the pump path's header-failure note, which only works because the worker is silent in that state.

43. **Never reboot on the user's behalf for a name collision — explain and offer.** The umbrella collision (`inductive Tree` + `import Mathlib.Algebra.Algebra.Basic`) is an artifact of preloading all of Mathlib; live.lean-lang.org imports only the header's closure and does not collide. The automatic "faithful" reboot (1 GB pack download, exact olean import on the main thread, minutes, at the renderer's memory ceiling) read to the user as "stuck at inflating essential". Now: an information diagnostic on the header line names the colliding identifiers and both ways out, and a "Load exact imports" button beside the pill runs the reboot only when clicked. Corpus: `mathlib-name-shadow-explains` (no click: offer + note, page `ready`) and `mathlib-name-shadow-faithful-switch` (click: zero errors after the exact import).

44. **Attribute memory per Chromium process and per phase before cutting code; the wasm heap is not the footprint.** Summing every `chrome-headless-shell` process reported a 15 GB "peak" that mixed the browser process's file cache (~1.9 GB of OPFS I/O) with the renderer. Sampled per process and per boot phase alongside the worker's telemetry, the picture is: wasm heap 2 GiB (initial = current, never grows; 1.24 GB of snapshot regions inside it), renderer +2.2 GB at "Starting the Emscripten runtime" (eagerly zero-filled shared memory + compiled code), **+4 GB at "Initializing the Lean runtime" — the 24 preallocated pthread workers each parsing the 48 MB glue**, +1.1 GB for the mathlib region, ≈ 9.2 GB at `ready`. The snapshot copies the second review's W5 named are already bypassed on the raw OPFS path; deleting them is hygiene. The lever is the pool: `-sPTHREAD_POOL_DELAY_LOAD=1` (patch 0033; the 24 slots stay because `pthread_create` from a pthread needs a preallocated worker) and, after that, the export table (the glue is mostly the 104k export wrappers, parsed by every loaded worker). Probes: `work/rss-by-process.cjs`, `work/heap-by-phase.cjs`.

