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

29. **Never hand an elaboration pthread a header it must resolve from the filesystem.** With the Mathlib pack mounted, an unresolvable import (`Mathlib.Tactic.Bogus`) makes the resident worker's elaboration pthread do a WORKERFS lookup and stall — the pill reads `elaborating` forever; in Node (no Mathlib dir) the same header fails fast with `isSetupFailure`. *Pump-era history (the client gate):* the shim's `unknownImports` gate (the installed profiles' `moduleNames` plus the umbrella when its snapshot was resident) refused such headers before the worker saw them and showed the pump path's calm hold; it left with the shim on 2026-09-04. The durable fix is in the kernel since patch 0032: `setupImports` is the only resolver, a lookup MISS is a refused header with one diagnostic and zero allocation, and no elaboration pthread ever imports on-thread (`$/qed64/headerStatus{refused, missing}`).

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

42. **A client-side diagnostic must ride inside the server's `publishDiagnostics`, never in one of its own.** LSP diagnostics are a whole-document replacement per URI: the shim's separate publish of an explanatory note briefly hid the worker's real "already declared" errors and was overwritten by the worker's next burst, so the InfoView never showed it (`note=false` while the offer button was visible). The note is now appended to the worker's own diagnostics array as the message passes through the front door (`lsp-front-door.js`, the `publishDiagnostics` branch of `step`), re-appended on every collision burst for that header, so it lives and dies with the errors it explains. *Pump-era history:* the shim's separate header-failure publish only worked because the worker was silent in that state; the same rule is why the relay's breaker note (2026-09-04) is one whole-document publish, never a second stream.

43. **Never reboot on the user's behalf for a name collision — explain and offer.** The umbrella collision (`inductive Tree` + `import Mathlib.Algebra.Algebra.Basic`) is an artifact of preloading all of Mathlib; live.lean-lang.org imports only the header's closure and does not collide. The automatic "faithful" reboot (1 GB pack download, exact olean import on the main thread, minutes, at the renderer's memory ceiling) read to the user as "stuck at inflating essential". Now: an information diagnostic on the header line names the colliding identifiers and both ways out, and a "Load exact imports" button beside the pill runs the reboot only when clicked. Corpus: `mathlib-name-shadow-explains` (no click: offer + note, page `ready`) and `mathlib-name-shadow-faithful-switch` (click: zero errors after the exact import).

44. **Attribute memory per Chromium process and per phase before cutting code; the wasm heap is not the footprint.** Summing every `chrome-headless-shell` process reported a 15 GB "peak" that mixed the browser process's file cache (~1.9 GB of OPFS I/O) with the renderer. Sampled per process and per boot phase alongside the worker's telemetry, the picture is: wasm heap 2 GiB (initial = current, never grows; 1.24 GB of snapshot regions inside it), renderer +2.2 GB at "Starting the Emscripten runtime" (eagerly zero-filled shared memory + compiled code), **+4 GB at "Initializing the Lean runtime" — the 24 preallocated pthread workers each parsing the 48 MB glue**, +1.1 GB for the mathlib region, ≈ 9.2 GB at `ready`. The snapshot copies the second review's W5 named are already bypassed on the raw OPFS path; deleting them is hygiene. The lever is the pool: `-sPTHREAD_POOL_DELAY_LOAD=1` (patch 0033; the 24 slots stay because `pthread_create` from a pthread needs a preallocated worker) and, after that, the export table (the glue is mostly the 104k export wrappers, parsed by every loaded worker). Probes: `work/rss-by-process.cjs`, `work/heap-by-phase.cjs`. **Follow-up measurement (same day):** the pool flag changed nothing; Node reaches ~7.5 GB before any snapshot with or without the task manager's threads and with tier-up disabled, and `WebAssembly.compile` alone costs 0.28 GB — V8 compiles lazily, so the +4 GB is machine code generated for every function the stdlib initializers execute. The renderer's ~9 GB at `ready` is therefore a floor of the full Lean compiler as a lazily-compiled 106 MB module; the levers are a leaner module or fewer initializers (kernel work), not host-side copies or thread pools. The W5 copy deletion stands as hygiene (`lean.worker.js` 1862 → 1611 lines).

### 45. Decide "the worker cannot answer this" by position, not by a status that is still in flight

The resident front door failed completion requests fast (-32801) while the header was *refused* — a status the FileWorker reports only after it has processed the keystroke that caused it. The completion request Monaco fires on that same keystroke arrives first, gets forwarded, and the worker holds it (it has no module inventory to answer an import path from); Monaco's suggest widget awaits every provider, so the client-side import-path items never showed (import-completion e2e, resident: `widget=false`). The fix reads the document text the door already tracks: a completion whose position is on an import line is the client's, whatever the header state. Rule of thumb: when a routing decision can be made from the request itself, don't make it from a status that the same edit is still producing.

### 46. A fatal-error progress entry is a verdict, not work in flight *(pump-era history; the rule stands)*

`$/lean/fileProgress` reports `kind: 2` (fatalError) for a refused or unresolvable header. The pump shim counted it as a processing range, and it never drains — so after the correct "imports incomplete" verdict, one late progress notification pinned the pill at "elaborating" and queued requests behind a count that could not reach zero (unresolvable-import-composition: pass at 2 s or fail at 120 s depending on ordering). The front door already read kind-2 as terminal (`headerRefused`); the shim was taught to filter it the same day, and left the page with the pump transport on 2026-09-04 — the front door's reading (`progress.fatal` in `phaseOf`) is now the only one. The lesson outlives the code: timing-dependent e2e outcomes usually mean two readers of one signal disagree about what it means.

### 47. A gate that nobody re-ran is a gate that tests the past

The toolchain gate's first check ran the one-shot CLI (`lean input.lean` with an `#eval`) and required exit 0. It failed on the 0033 build, which looked like the pump deletion had broken evaluation. It had not: the reassembled, served 0032 runtime behaves identically — `64` is printed, `rfl` elaborates, and the process never exits, because the keepalive guard (patch 0020) and the resident transport (0031) keep the Emscripten runtime alive after `main` for library-style use, which is exactly what the product relies on. Nobody had run the gate on a resident-era binary; the ship chain that ran it predates 0020. Two rules: when a gate fails on a change, first run the same check on the artifact you are replacing (here: reassemble it from its content-addressed chunks, hashes verified); and judge CLI checks by what they print, with a bounded timeout, when the exit path is not a product path. The gate now does the latter and says so in its output.

### 48. Bake arguments live in the pin, not in the last script you can find

The first 0033 bake reused an older ship-chain's arguments (`--lib work/lib-tree`, default core lib) and produced an init snapshot of 342 MB raw and a Mathlib snapshot of 2.76 GB raw — 2.5x the served pairing — because the 0032 pairing had been baked from the SLIM trees (`work/core-lib-slim`, `work/lib-tree-slim`: the same oleans without `*.olean.private`, docs/SERVER-SLIM-REBAKE.md), a fact KERNEL-PIN records next to the sizes. The sizes in the pin are the check: a bake whose raw size is not within a few percent of the pin's is the wrong bake. `pipeline/release/bump-chain.sh` now encodes the sequence (build, finish, gate, chunk, slim trees regenerated from the new stage1, both bakes, then promote after the pyramid) so the next bump does not rediscover it.

### 49. A list that "can only shrink" is a list that silently rots

The export list (which compiled symbols the IR interpreter can reach natively) was built as seed + (a committed historical list ∩ what this build defines), on the belief that it was a performance list. The kernel session re-derived what the historical list actually IS from the compiled C: exactly every `___boxed` wrapper, every module initializer and every `LEAN_EXPORT` constant cell of the tree it was made from, and no plain function — a correctness contract (a missing initializer re-runs init attributes interpreted; a missing cell gives the interpreter its own copy of native state, e.g. a second `IO.Ref`; missing boxed wrappers turn into deep interpreted recursion on a 1 MB worker stack). A shrink-only filter cannot add, so it omitted everything newer than the list: 70 names from our own patches on the served 0033 binary (including the 0032 registry cell), and it would have omitted about 6,200 on the v4.34.0 import — with a green build both times. `gen-exports.py` now knows both rules, reports what the historical one omits on every run, and the generated rule becomes the default at the next pairing bump (changing it changes `lean.wasm`). When a filter exists to stop a build from failing, check what it does to the things it is NOT failing on.

### 50. An import-closure selection never contains a deprecated shim

Mathlib v4.34.0 moved its most-imported modules (`Data.Real.Basic`, `Data.Complex.Basic`, `Logic.Basic` → `Basic.*`) and left `deprecated_module` shims under the old names — 148 of them. Nothing imports a shim, so a pack selected as "the import closure of these roots" contained exactly one, and the first browser boot of the staged pairing refused the default example's header: the resolver was right, the module was not there. live.lean-lang.org serves the old name with a deprecation warning because it ships all of Mathlib. Rule: after any library bump, add every shim whose own imports are already inside the selection (a fixed point, so shim chains work — shims only, never "any covered module"), and expect that some old names are simply gone (`Mathlib.Logic.Basic` had no shim; upstream would reject it too). The umbrella must import the shims as well: the resolver's covered mode is membership in the umbrella's import list, and "Load exact imports" is offered on a collision, never on a refusal. Corollary for the e2e corpus: keep at least one scenario on an old name, so the shims stay pinned.

### 51. The environment said every user file was a module, and no test asked

Found 2026-09-30 while testing the first user widget: on the served 4.34 pairing a LEGACY buffer is elaborated with module semantics — `(← getEnv).header.isModule` is `true`, plain `def`s are private by default, and `@[server_rpc_method]`, `attribute [tactic …]`, `@[app_unexpander]`, simprocs and code-action attributes are rejected ("must be marked as `meta`", then "must be public"). Cause: the fork imports at `OLeanLevel.exported` on Emscripten (the only data the wasm build ships) and calls `importModules` without `isModule`, whose default is `level != .private` — true; the flag is baked into every snapshot's header and the prebuilt-environment branch reuses it. It was latent through 4.33, which hung almost nothing off the flag; 4.34 enforces the module system through it. e2e 23/23, battery 51/51, two gauntlets and a byte-identical slim/fat audit all passed, because `macro`, `elab`, `syntax`, `@[simp]`, `#eval` and every tactic still work: the corpus never declares an attributed definition or inspects a name. Lessons: (1) a pyramid of behaviours users exercise says nothing about semantics they have not exercised — a version import needs a few probes of the ENVIRONMENT's own facts (isModule, privacy of a plain def, one hand-attributed elaborator), not only of messages; (2) a default argument that encodes a convention (`isModule := level != .private`) is a trap the moment a fork changes the level for another reason — pass it explicitly. Fix is kernel-side (pass the header's real flag; rebake), owned by the kernel line; the corpus gains the four probes with that bump.

**#51 fixed (2026-09-30, kernel 0034 = commit 9fbb45afcb, runtime wasm64-4b025db7729c5f89):** `processHeaderCore` passes the header's `isModule`, `importModules` takes it explicitly, the wasm env cache imports as legacy, and the prebuilt-environment branch sets the served environment's flag from the user's header (`Environment.setIsModule`). Gated three ways from now on: the toolchain gate (four module-semantics checks), the compiler battery (three cases), and `tests/adversarial/kernel-probes/browser-check.sh` through the resident FileWorker.


### 52. A heartbeat from the JS thread says nothing about the Lean threads behind it

Reported 2026-10-01 by the widgets showcase (`qed64-showcase/out/hang/ROOT-CAUSE.md`): about once in 4,400 edits (one of 19 C20 runs, ~2,220 InfoView link clicks) the page stayed `elaborating` forever. Every Lean pthread stopped at the same moment, no frame left stdout, the pool sample froze (`8/17`), and the worker's own JS thread kept running — so its 2 s heartbeat kept the page from noticing anything. Mechanism: under Emscripten a Lean pthread's `pthread_create`, `fd_write` and FS syscalls are SYNCHRONOUS round trips to the runtime's main JS thread (this worker), served from that thread's mailbox. A sender notifies the mailbox only on the NONE→PENDING edge of its notification flag, and only serving the mailbox clears the flag: one lost wakeup leaves it PENDING, every later sender stays silent, and every Lean thread stops at its next proxied call. The task manager also held its one global mutex across the `pthread_create` round trip (and the server creates a thread for every output message, request and continuation, ~150 per edit), so the frozen pool could not even drain. In the glue's default mode the wakeup is ONE `Atomics.waitAsync` waiter that only its own resolution re-arms: a lost resolution also leaves no waiter armed, so even after the queue is served the next wakeup is lost again. Reproduced browser-free (`pipeline/snapshot/thread-storm-probe.mjs --drop-notify`): one dropped wakeup gave exactly the field signature (pool frozen, zero frames for 180 s, a stdin-ring kick useless); a raw `_emscripten_check_mailbox()` served the queue and the session froze again at once; only the glue's re-arming `checkMailbox()` revived it.

Fix, defence in depth (no layer assumes the others):
1. **Kernel 0035** — the task manager never creates a thread while holding `m_mutex` (wasm only), and a dedicated task is handed to a parked dedicated thread when one exists (at most 8 parked), so steady-state churn creates almost no threads. This narrows the exposure (and lets the pool drain); it does not cure a lost wakeup — every output frame is still a proxied `fd_write`.
2. **Message mailbox** (`lean.worker.js` `instrumentRuntimeMailbox`, in `preRun`, before the main thread's mailbox init arms anything) — pthreads notify the runtime thread by `postMessage`, the glue's own mode where `waitAsync` is missing. A lost notification still leaves the flag PENDING, but once the mailbox has been served, the next send posts a fresh message: there is no waiter to lose.
3. **Mailbox kick** — while the loop is open, the liveness tick serves the runtime thread's mailbox directly every second (`_emscripten_check_mailbox`). This is what heals a lost notification, in either mode. A kick that served a proxied call when no notification had arrived since the previous kick is a candidate rescue; it is confirmed (`status().liveness.rescues`, logged) unless the late message for that work shows up empty before the next tick — the field signal for a lost wakeup.
4. **Lean-side liveness** — while work is owed (`elaborating`, `starting` with the document open, or a forwarded request unanswered) and the FileWorker has been silent for 6 s, the worker writes a private `$/qed64/liveness` request into the ring (with `params`: the FileWorker's main loop answers an unknown method at once, whatever it is elaborating; a request without params is a fatal "invalid JSON-RPC message"). Unanswered 12 s later: a logged stall; still silent 4 s after that: `died` reason `wedged`, and the relay reboots and replays as for any crash. The pill says "the checker stopped responding — restarting" while it does. A FileWorker EXIT is reported at once as `died` reason `exit`, with its code: with the runtime keepalive held, the glue never calls `onExit` and swallows the ExitStatus, so the proxied-function table's `_proc_exit` (the main loop's own exit) / `exitOnMainThread` (a C `exit()` on any thread) entries report it. This hook is the ONLY detector of the user-reachable exit: `#eval (IO.Process.exit n : IO Unit)` unwinds only the elaboration task's thread, the main loop survives and answers the liveness probe, and without the hook the page sat in `elaborating` forever (a second route to the same symptom).

Rules: a liveness signal must come from the component whose liveness you need — the JS heartbeat proves the JS thread; only an answer from the Lean main loop proves the Lean side. A wakeup protocol with sticky state turns one lost event into a permanent stall: serve the queue periodically anyway, and prefer the mechanism that is whole again after one service. And a "pool unchanged ⇒ frozen" detector is wrong after 0035: a healthy busy session hands work to parked threads without moving the pool (`status().pool.parked` reports them).

**#52 fixed (2026-10-01, kernel 0035 = commit 3ae65d36f9, runtime wasm64-2c18773ecfba45bb; worker main 6833342):** the four layers above. Evidence, all on the staged pairing unless noted:
- `tests/adversarial/liveness-faults.mjs` in Chromium, 6/6. Mailbox in message mode with its notification word located. An idle session is never probed. A 57 s `#eval` answered 7 of 7 real probes with no stall. With 10% of runtime-mailbox notifications dropped, 20 drops gave 20 confirmed rescues, and every edit settled with the right messages. A total mailbox kill gave `wedged` at 25 s, and the replayed text settled at 29.6 s with the pill naming the stall. A raw LSP `exit` gave `died exit` in 4 ms. On the previous runtime 4b025db7 the same drills passed: 27 drops, 27 rescues.
- The FileWorker-exit probe under Node with the real glue and the real worker (`pipeline/snapshot/fileworker-exit-probe.mjs`, `tests/integration/fileworker-exit.test.ts`): a raw exit gives exit 0 in 26 ms, a param-less `shutdown` gives exit 1 in 2 ms, and `#eval (IO.Process.exit 3 : IO Unit)` gives exit 3 in 38 ms. Without the hook that last case was never caught.
- Storm reproduction (`thread-storm-probe.mjs`). Natural freezes: none in 771k thread creations under Node, so the trigger is browser-side and unproven. One injected lost wakeup gives the field signature in waitAsync mode, and the kick plus message mode heal it.
- Kernel gate 11/11. In its task-manager storm, 161 pthreads were created against 2,956 on the previous runtime.
- Pyramid on the staged pairing: e2e 23/23; editing latency unchanged (header switch 333 ms, completion 279 ms, error clear 9 ms); crash gauntlets mixed (226 steps) and imports (73), both alive and `ready`; the four #51 kernel probes; the compiler battery 54/54; `verify:release` after the promote.
- Open follow-up: a batch compile, which runs on the runtime thread, that calls `exit` ends as a recoverable `COMPILE_CRASHED` after unwinding the C++ stack. It is unreachable today, since the only batch compile is the import-only warm header.


### 53. A thread parked inside wasm is a Worker that outlives its page by two seconds

Found 2026-10-02 by the widgets showcase (`qed64-showcase/docs/UPSTREAM-REPORT-QED64.md`, L9) a day after #52's 0035 runtime went live. When a ready page is reloaded, or the relay restarts and boots a second runtime in the same renderer, the renderer dies with `V8 javascript OOM (Scavenger: semi-space copy)` in a DedicatedWorker thread, about 2.2 s after the reload. `tests/adversarial/reload-storm.mjs` measured it: the stock page with the Mathlib default, a fresh browser per run, reloads every 3 s, the same worker in both arms. The 0035 runtime `wasm64-2c18773ecfba45bb` crashed in 3 of 5 runs, every crash at 19–20 running pthreads (the survivors had 17). The 0034 runtime crashed in 0 of 5, at 10–11 running.

Mechanism: every pthread is a Worker isolate, and all isolates in a renderer share one pointer-compression cage. Blink terminates a worker gracefully only through its event loop. A worker blocked inside wasm (a futex wait) is force-terminated only after a ~2 s grace, and its heap stays allocated until then. 0035 parked up to 8 finished dedicated threads in a condition-variable wait, which is 8 more Workers blocked in wasm. On reload, 18–20 old isolates overlapped the new page's 25 Workers, each parsing the 48 MB glue, and the cage ran out. The worker-side #52 changes were cleared by the same A/B.

Fix: the parked-thread cap defaults to 0 (kernel 0035 rebuilt; env `LEAN_WASM_PARKED_DEDICATED` re-enables it, read once at task-manager creation). A finished dedicated thread exits and returns its Worker to the pool idle, as in 0034. The lock-free thread creation that was 0035's point stays. Until the rebuilt runtime is re-gated, the served pairing is 0034 again with the #52 worker fixes. The reload storm is now a release gate.

Rule: count what a runtime keeps BLOCKED, not just what it keeps alive. Idle pool Workers die with their page at once; a thread waiting inside wasm holds its isolate through the browser's grace period. Any change that keeps more threads parked in wasm must pass the reload storm before it ships.

**#53 fixed (2026-10-02, kernel 0035b = commit a8817d01f9, runtime wasm64-3ab1c6a9da03bc29):** parking off by default. Gated on the staged pairing:
- reload storm 0/5 crashed, pool at ready {unused 12–14, running 10–12, parked 0}, ready again ~6.2 s after each storm;
- e2e 23/23;
- editing latency unchanged (header switch 334 ms, completion 344 ms);
- liveness drills 6/6 (24 dropped notifications = 24 confirmed rescues; wedge recovered at 27.7 s; exit in 206 ms);
- #51 kernel probes 4/4;
- crash gauntlets mixed 225 and imports 73 steps, alive and `ready`;
- compiler battery 54/54; `verify:release`.

Kernel gate 13/13: thread churn with parking off equals 0034's (2,961 pthreads in the task-manager storm); the opt-in path (`LEAN_WASM_PARKED_DEDICATED=8`, 163 pthreads) stays gated for a host that has measured its reload behaviour.


### 54. A progress card is dismissed by the fact it describes, not by a timer something else started

Found 2026-10-03 by the widgets showcase (`qed64-showcase/docs/UPSTREAM-REPORT-QED64.md`, S1). On a 10 Mbit/s first visit the boot card disappeared at 230 s while the Mathlib environment was still downloading, and from then until `ready` at 577 s the visitor saw only the pill and its elapsed timer. The card also claimed the full Mathlib environment needs "~3 GB of memory".

`tests/adversarial/boot-card.mjs` reproduced it on the production build. The page sat behind a link-shaping TCP proxy: 16 Mbit/s, 40 ms RTT, cold profile. CDP network emulation does not reach the Lean worker's downloads. Results on the old shell:
- the editor mounted at 71 s, and `main.ts` then called `ui.idle("ready — put the cursor inside a proof")`;
- that label turned the pill idle and green mid-download, restarted its elapsed timer, and armed a 120 s fallback that removed the card;
- the card went at 191 s, 144 s before `ready` (334 s), with 278 MB of the 650 MB first-visit download still to come.

The fallback dates from the pump shim, when the editor mounted after the checker. Under the relay, the editor mounts while the session is still downloading.

Two more slow-link defects showed up in the same run or in the code:
- **Checklist stuck past the download.** The stage list only moved forward. Loading the 32 MB init snapshot advanced it to "Load the environment into Lean", so during the Mathlib download, the longest step, the card showed "Download the Mathlib environment" as done.
- **Prefetch abandoned on slow links.** The page terminated the raw-snapshot prefetch worker 15 minutes after starting it, however steadily bytes were arriving. On links under about 3 Mbit/s (321 MB of transfer), the Mathlib download was abandoned and the Lean worker fetched it again from zero, on its heavier in-worker inflate path. The prefetch also reported progress once per 64 MiB of output, which is minutes apart at 100 KB/s.

Fix (`frontend/src/main.ts`, `qed64-boot.ts`, `public/workers/snapshot-prefetch.worker.js`):
- The editor's start reports nothing to the pill or the card; only the relay's status turns the pill idle.
- The card goes on `ready` / `headerRefused`, or turns into the failure card. The one fallback is armed by the first status in which the relay **serves** (environment loaded, document open) and fires 30 s later. It exists for restored buffers that keep Lean busy (`#eval` loops, a heavy first search), where the editor must not stay hidden.
- An example switch during the boot no longer jumps the checklist to "Check".
- The checklist returns from "load" to "env" when the next snapshot starts downloading.
- The prefetch reports every 500 ms while bytes arrive. The page gives up on it only after 3 minutes of silence (`PREFETCH_SILENCE_MS`; `tests/unit/prefetch-bail.test.ts` fails on the old deadline).
- The memory figure is measured, not guessed: "about 8–9 GB" for the tab (README Requirements says the same). At `ready` (+8 s) in the two boot-card runs, the renderer was 7.3 and 7.6 GiB (7.8–8.2 GB) and the browser process 1.8 GiB (OPFS file cache), 9.2–9.5 GiB in all. The widgets lane measured 8.2–9.0 GiB of renderer RSS, and #44 explains why the 2 GiB heap is the smaller part.

Verified on the same link and build pairing (`work/adversarial/runs/bootcard-fix/`):
- **slow-link:** PASS. The card was shown in all 328 samples until `ready` at 334 s, gone at 334 s, with 0 MB downloaded after it went. The pill stayed busy throughout, its elapsed timer unbroken. "Download the Mathlib environment" was the active step for the whole Mathlib download. The longest stretch without numbers on the card was 11 s (runtime initialisation). The old shell had no card at all for the last 144 s.
- **check-fallback:** PASS. The card went 30.1 s after the relay served, in `elaborating`, and the page reached `ready` at 66 s.
- **e2e:** 23/23 on the same build (`boot`: settled at 13.6 s, `overlayGone=true`).
- **unit:** 276/276, including the two in `prefetch-bail.test.ts`.

**Follow-up, same day: runtime chunks.** The lean4game session measured this on live, at a shared 300 kB/s. The runtime count ("Verifying lean.wasm · 110 / 147 MB") moved only in 16 MiB steps and stood still 48–56 s per chunk while bytes arrived, and nothing counted for ~44 s before the first chunk. `lean.worker.js` read each chunk with `arrayBuffer()` and reported once per chunk. `fetchChunkOnce` now reads the body as it arrives into a buffer of the chunk's exact size. `fetchChunk` reports every 500 ms inside a chunk, and the verified count still comes at the chunk's end. The length and SHA-256 checks and the cache-bypassing retry are unchanged; the label stays "Verifying …" because pages match on it. Pinned by `tests/unit/runtime-chunk-progress.test.ts` (the real worker in a vm sandbox with a fake clock; on the old worker the chunk yields exactly one report). Browser, same 16 Mbit/s run (`runs/bootcard-fix2`): the longest still stretch in the runtime step went from 8.0 s to 1.0 s, its count starts at 69 s instead of 79 s, and e2e is 23/23.

**And the core pack.** `inflateTransport` (`src/install/profiles.ts`) read each 16 MiB transport part the same way, so "unpacking the Lean core library" moved once per part. That was 8 s at 16 Mbit/s and would be ~56 s at 300 kB/s, and there was no count at all for the first 9 s. `readPart` now streams each part into its exact length, with the same over-long and short-body refusals. A "download" report goes out every 500 ms inside a part, and the per-part verified report stays. Pinned in `installer-stream.test.ts` (no in-part report on the old installer). Browser (`runs/bootcard-fix3`): the core step's longest still stretch went from 8.0 s to 1.0 s, and so did the longest stretch without numbers on the whole card (from 9–11 s); the card reads "downloading the Lean core library 28 MB / 114 MB · 1.9 MB/s · ~45 s left"; e2e 23/23. Both streams restart their in-chunk count when the cache-bypassing retry starts after a failed first attempt, so the bar can step back once on that path (noted by lean4game; harmless).

Rule: a progress surface stays until the fact it describes is true (here: the checker is serving), and a fallback timer starts at the stage it covers. A timer armed by a neighbouring event (the editor mounting) is correct only while that event happens to come last, and on a slow link it does not.

### 55. A reload during a long boot step puts two runtimes in one 4 GiB cage

Reported 2026-10-02/03 by the widgets showcase (L9 "V2", `qed64-showcase/out/ux/{final-storm,v2mit-storm,v2-embed}/RESULTS.md`). A headed Chrome for Testing 151 reload storm killed the renderer 2.0–2.2 s after reload 1–4 with `V8 javascript OOM (MarkCompactCollector: young object promotion failed)`, thrown by 1–5 brand-new isolates with 15.8 MB heaps at the same instant. It was equally frequent on every release since 1859b83, so it is not #53's V1. It concentrated in embedded use (widgets' final table, `out/ux/v2-embed/RESULTS.md`, 24 headed runs per arm on 5ac5d00): the gallery `/showcase/` crashed 15/24, a script-free page that only iframes the stock page 6/24 (10/24 with a seeded document), the stock page 2/24 (2/24 seeded). Embedded vs top-level: 16/48 vs 4/48, p = 0.005. Every one of the 35 V2 crashes came 2.0–2.4 s after reload 1–4. Tearing QED64 down from the outer page's `pagehide` changed nothing.

Mechanism, measured with `tests/adversarial/reload-storm.mjs --headed [--embed] --sample-ms 100` (per-renderer thread count and footprint every 100 ms; a dedicated Worker's OS thread exits only when Blink disposes its isolate):
- **One runtime fills most of the cage.** Every pthread Worker evaluates the 48 MB glue (~63 MiB of JS heap) and then instantiates the module and runs the dynamic-linking glue's per-export bookkeeping over ~106k exports (~66 MiB). That bookkeeping is the exports-object copy in `applySignatureConversions`, `assignWasmExports`, `updateGOT` (one `WebAssembly.Global` and one table slot per function, ~10 MiB) and `mergeLibSymbols` (~3 MiB). `performance.measureUserAgentSpecificMemory()` gives ~129 MiB per pthread isolate and ~133 MiB for the lean.worker, after subtracting the shared wasm memory every context reports. That is ~3.2 GiB for one runtime's 25 glue isolates, against one 4 GiB pointer-compression cage shared by every isolate of the renderer. (The heap-lab split is measured on 3 Workers per variant, headed CfT 151.)
- **The old runtime's Workers outlive the reload.** Playwright's worker `close` (a CDP detach, at +0 ms) does not show this; the thread count does. Two rules in Blink's `worker_thread.cc` explain it. A Worker that cannot run its shutdown task is force-terminated only `kForcibleTerminationDelay` = 2 s after `Terminate()`. A nested Worker is terminated only from its parent's own shutdown task. So while the lean.worker is inside one long synchronous task, none of its 24 pool Workers can go. After reloads 1–4 the previous runtime is ~3 s into its boot, inside exactly such a task: the warm Mathlib snapshot path in `loadSnapshot`, a tight `SyncAccessHandle.read` loop over ~1.07 GB followed by the synchronous `_lean_wasm_load_snapshot_mem`. Its 25 threads lived to a median +1.62 s (stock) or +1.83 s (embedded) while the new runtime's 25 were up from +0.8 s, an overlap worth +3.3 GB of footprint. Every crash was a reload whose old runtime was still alive at ~+2.0 s, as the new pool's heaps peaked. After reload 0 (old runtime `ready`) only its ~10 busy pthreads overlap (their own 2 s grace), and no V2 has ever followed reload 0.
- **Why embedding shows it more.** The renderer is reused on every reload in both modes, and macOS memory pressure stays at level 1 (normal). bfcache is off in every run (Playwright passes `--disable-back-forward-cache`). What differs is timing: the framed runtime boots ~0.2–0.3 s later (first `ready` 13.3 s vs 13.0 s), so the 3 s cadence catches it earlier in the snapshot step. Shifting the cadence moves the old runtime's death as predicted: embedded reloaded every 3.2 s instead of 3.0 s died at +1.51 s and crashed **0/12** vs 6/12 (p = 0.014); stock every 2.8 s died at +1.90 s and crashed 2/12 vs 1/12. Anything that starts a runtime in a renderer while another is inside a long boot step overlaps it the same way: a reload, a same-site navigation, or a relay restart.

Fix (`lean.worker.js` "Runtime lifetime locks", `src/runtime/client.ts`): two Web Locks per runtime id.
- `LeanSession` holds `qed64-wanted:<id>` from construction until `dispose()`/`terminate()`, or the document's end.
- Every Worker of the runtime holds `qed64-alive:<id>` (shared) until Blink destroys its context: the lean.worker directly, each pthread through a one-line prelude blob that takes the lock and then `importScripts` the glue.
- Before a runtime creates its shared memory, its glue and its pool, it polls `navigator.locks.query()`. While runtimes that are alive but no longer wanted keep more than `STOPPING_WORKERS_TOLERATED` = 12 Workers alive (one lock entry per live Worker), it waits, within a 6 s budget, overlapping the chunk download.
- 12 tolerates exactly what every release has always overlapped after an ordinary reload: a ready runtime's ~10 busy pthreads in their grace. Waiting for those too measured +1.9 s on every reload of a ready page (reload→ready 7.9 s vs 6.0 s); with the tolerance it is 6.0–6.3 s vs 5.9–6.2 s.
- A host whose ready runtime keeps more threads busy waits for them.
- Live runtimes in other tabs or frames are still wanted, so they are never waited for.

Rule: a runtime is not gone when its Worker objects are. Count Blink's teardown rules (the 2 s forced-termination grace; nested Workers die only after their parent's shutdown task). When one runtime fills most of the cage, the next must not allocate until the previous one's isolates are disposed. Wait on the browser's own lifetime signal (a lock held by each Worker's context), not on a timer or a page-side teardown.

**#55 evidence (2026-10-03, 3b42714 + the locks; release = pristine 3b42714 on a second dev server; headed CfT 151 unless noted; every arm interleaved, quiet host ≥ 18 GB reclaimable):**
- Phase A (wait for all, 16 runs per arm): release embedded 6/16 V2, release stock 0/16, fix embedded **0/16** (p = 0.018 vs release embedded), fix stock 0/16. Phase A2 (release only, the cadence test above): 6/12, 0/12, 1/12, 2/12.
- Phase D (the shipped tolerance): release embedded control 5/20 V2, fix embedded **0/20** (p = 0.047), fix stock 0/20, 20 runs per arm. chrome-headless-shell, fix: stock 0/10, embedded 0/10 (plus 0/10 + 0/10 for the wait-for-all variant). The fix logged its waits: ~1 ms after reload 0 (9–11 Workers alive, within the tolerance), ~1.0–1.2 s after a reload that caught a booting predecessor (25 → 0–5 Workers), less for the rest.
- Across the windows, headed and embedded at the 3 s cadence: release 17/48 crashed, fix 0/36 (p = 1.8e-5; the shipped variant alone 0/20, p = 0.0015). Release stock 1/28. Every fix arm, headed or headless, stock or embedded, both variants: 0 crashes in 112 storms (A 32, B 20, D 60).
- Pyramid on the fix (the shipped tolerance, chrome-headless-shell): preflight OK; liveness drills 6/6 (25 dropped notifications = 25 rescues, `wedged` at 24.3 s and settled on a new session at 28.9 s, `exit` seen in 213 ms and `ready` again at 4.6 s); e2e 23/23; editing latency unchanged (header switch 327 ms, completion 337 ms, error clear 10 ms); the four #51 kernel probes; crash gauntlet mixed 225 steps, alive and `ready`; unit 281/281 after the rebase onto the #54 commit; `tests/integration/fileworker-exit.test.ts` 4/4.
- Crash gauntlet imports: **not green on either build.** The fix died at step 9 once in 3 runs and the release once in 4. Both deaths were `V8 javascript OOM (CALL_AND_RETRY_LAST)` from an isolate ~1.2 s old while ONE runtime was running, with no reboot logged. That is a separate failure with the same budget, below.
- Unit: `tests/unit/runtime-locks.test.ts` (the wait against a fake lock table: own and wanted runtimes ignored, pending requests counted, the tolerance, the budget; the pthread prelude).

Open, found by the gate above (not caused or fixed by the locks): **a single runtime can outgrow the cage.** Emscripten's pool hands out its 24 preallocated Workers, then `getNewWorker()` creates more on demand, each another ~129 MiB of cage. In the imports gauntlet, ~23 s into the storm (step ~9), the renderer's threads rose from 53–56 to 59–64, i.e. ~5–9 Workers past the pool (`work/v2/lanesF`, sampler at 200 ms, release). Around 30 glue isolates is the ceiling, so a big enough burst kills the renderer in a brand-new pool Worker. A finished pthread's Worker returns to the pool, so the growth means more than 24 Lean threads were alive at once. Candidate remedies (untested): cap concurrently live dedicated threads in the task manager without parking them in wasm (#53), or make the isolates smaller (below).

Follow-ups, not part of this fix:
- **Kernel.** The ~129 MiB per isolate scales with the ~106k exports and the `MAIN_MODULE` glue. Exporting only what JS calls, or resolving Lean's native symbols from a table inside the module, would shrink all 25 isolates. That would also give room in the cage to cases this fix does not serialize: two QED64 frames on one page, both wanted.
- **Worker.** Yield to the event loop between the 64 MiB slices of the warm snapshot read, so that a runtime reloaded mid-read can shut down within one slice (the synchronous `_lean_wasm_load_snapshot_mem`, ~0.8 s for Mathlib, stays).
- **Relay.** The relay's fixed 1.5 s settle before a reboot is a timer standing in for this signal.

### 56. Two halves of one RPC must be swapped together, and a stub that throws is not an implementation

Reported by the widgets showcase (`qed64-showcase/docs/UPSTREAM-REPORT-QED64.md`, D1 and D2), which repaired both from outside with a postMessage bridge. Neither was QED64-specific; every lean4monaco 1.1.16 page had them:
- **D1, RPC widget panels.** Every ProofWidgets `mk_rpc_widget%` panel (Mathlib's `conv?`, the SelectionPanel family, user widgets) failed with `r.abortSignal.addEventListener is not a function`. vscode-lean4 wraps the remote `EditorRpcApi` (start/await/cancelClientRequest) into the InfoView's `EditorApi` INSIDE the webview, so an AbortSignal stays local and only request ids cross. lean4monaco does the opposite: the webview hands the raw RPC proxy to `renderInfoview` and the page wraps its local API with `editorApiOfRpc`. The messages are JSON-stringified, so the signal arrives on the page as `{}`, the request has already gone out, and its answer is lost to the TypeError.
- **D2, edits from the InfoView.** Clicking core "Try this" [apply], a ProofWidgets MakeEditLink or `conv?`'s "Generate conv" changed nothing. `applyEdit`, `insertText` and `showDocument` go through `window.showTextDocument`, and lean4monaco registers no editor-service override, so monaco-vscode-api's default `openEditor` stub throws "unsupported".

Fix (`frontend/build/lean4monaco-fixes.mjs`, `frontend/src/editor/infoview-edits.ts`), applied at build time with no fork:
- The iframe script, copied to `/infoview/webview.js` by a static-copy transform, wraps the proxy with `editorApiOfRpc`. The function is extracted from the installed lean4monaco's own `rpc.js`, so it always matches the host half.
- The page module registers the raw API instead of wrapping it. It goes through a Vite transform for builds and through an esbuild loader for dev pre-bundling. That loader is composed with `@codingame/esbuild-import-meta-url-plugin`'s catch-all `.js` loader; in esbuild the first loader that returns contents wins, so a separate plugin listed after it silently never ran.
- On the way, the page replaces the three editor actions with implementations on the one Monaco model, keeping vscode-lean4's semantics: one document only, edits applied as one undoable step, "above" insertion indented like its line, and showDocument for another file ignored.
- Every patch asserts its anchor occurs exactly once, so a lean4monaco upgrade fails the build rather than shipping unpatched.
- `globalThis.qed64.api = {version: 1, capabilities: {editorRpc: true}}` is published at module start, so an embedder's own bridge stands down.

Gates: `tests/unit/lean4monaco-fixes.test.ts` runs against the installed files, including the composed dev loader with the real import.meta.url plugin. `tests/unit/infoview-edits.test.ts` covers the three actions. `tests/adversarial/infoview-actions.mjs` checks, in Chromium, the core Try this click, the `conv?` panel, Generate conv, and that showDocument for a foreign file sent over the iframe's RPC moves neither the selection nor the focus (with an own-document control); `tests/unit/infoview-actions.test.ts` pins that lane's verdicts against lean4monaco's real Rpc and wrapEditorRpcApi. The installed-file suites of `tests/unit/lean4monaco-fixes.test.ts` need frontend/node_modules: CI installs the frontend before the unit step (a test pins that order) and under CI they never skip; a fresh clone's `npm test` skips them with a notice, as pretest skips typecheck:site.

Rules: when a library splits one protocol across two contexts, fix both halves in one change and test the round trip, not either half alone. And a dev-only loader chain needs a test that runs the real chain: unit tests of the patch function passed while the dev server served the unpatched module.

From the branch review: the lane's own checks could not fail. `--only foreign-show` ran nothing and exited 0 (the scenario was nested inside conv-generate), foreign-show called the page hook directly and compared only the text (which showDocument never edits), and capability-flag captured the DOMContentLoaded value but never judged it. Each scenario now runs alone, an empty selection exits 3, foreign-show goes through the iframe's RPC wire and checks selection and focus against an own-document control, and the DOMContentLoaded value is part of the verdict.

### 57. A URL parameter spliced into a fetch path chooses the origin

Found while drafting the embedding contract (docs/EMBEDDING.md §4). The dev overrides `?snapshots=<dir>`, `?profiles=<dir>` and `?runtime=<buildId>` were read from `location.search` and spliced into artifact URLs as `/${dir}/…`. A value starting with `/` makes that `//host/…`, which is protocol-relative. So `?snapshots=/attacker.example/x` booted an environment baked by someone else, and Lean widget modules in it run their JS in the InfoView iframe, which is same-origin with the page and its storage (the editor buffer, OPFS). Every QED64 link was a script-injection link.

Fix (`frontend/src/embed/params.ts`): one parser validates all three before any fetch.
- A directory is one plain segment, optionally under its own promoted name (`snapshots/widgets8`, `snapshots-0031`, `profiles-staged`), and must resolve on this origin.
- A runtime is `wasm64-<16 hex>`.
- A refused value fails the boot with a message naming the parameter, never a silent fallback to the served set.
- `installArtifacts(ui, {overrides})` lets a library embedder pass `"none"` (ignore the URL) or its own values, validated by the same rules.

Gate: `tests/unit/boot-params.test.ts` covers the accepted spellings, protocol-relative, absolute, percent-encoded, backslash and traversal values, and asserts a refusal sends no request.

Follow-ups from the branch reviews:
- **Packs and redirects.** The library-pack loaders (index, manifests, parts) are checked too, and so is a redirect off the origin (`response.url`), not only the request URL.
- **The prefetch worker's other fetch path.** Its legacy compressed-only mode, taken when a message carried no positive `rawBytes`, fetched with neither the redirect nor the HTML refusal. It committed `<cacheKey>`, which raw mode then inflated from with no network check. W5 had removed its last reader, so it is deleted, and a message without a raw size is refused. Gate: `tests/unit/worker-internals.test.ts` (the real script, an off-origin redirect).
- **Node harnesses need the browser globals a guard reads.** The Lean worker's guard reads `self.location`. The #52 exit probe ran the worker under Node with no location and a custom-scheme snapshot URL, so every scenario of `tests/integration/fileworker-exit.test.ts` would exit 2 ("snapshot load failed"). The probe now sets `globalThis.location` and serves its snapshot at `/snapshots/init.snap`, and `tests/unit/worker-internals.test.ts` runs the real guard against the probe's own values.
- **A document in the URL is code.** `#code=` was added for embedders and briefly honoured on the plain page. That reopened the same class: Lean source can define a widget module whose JS runs in the InfoView with no click. A boot document in the URL is now honoured only when the page is framed by a same-origin parent.

Rule: any URL parameter that reaches a `fetch`, `importScripts` or `Worker` URL is an origin decision. Validate it as a path segment against an allowlist pattern before use, and fail loudly rather than fall back.

### 58. A fake of an async browser API must keep its timing, and a loop guard keyed on text is a cache with no invalidation

From a 119-agent review of the embedding branch (36 confirmed findings, all fixed before merge):
- **Fakes that hid bugs.** The LSP client coalesces full-text didChange (vscode-languageclient's 250 ms Delayer) and a LockManager grants a free lock from a later task. The unit fakes forwarded every edit synchronously and granted locks inside request(), so `setDocument` resolving on exact text (it can hang when two edits coalesce) and a "busy" decided from elapsed microtasks (it fired on every prefetch) both passed. The fakes now coalesce and grant asynchronously, and contention is decided from the API's own answer (`ifAvailable` → null). Gates: `tests/unit/page-api.test.ts`, `tests/unit/raw-cache.test.ts`.
- **Guards that outlive their session.** The self-widen remembered, per header text, which environments it had tried, with no expiry: after a reboot dropped the umbrella, that header could never widen again, and on an overlay index each keystroke of a Mathlib prefix could swap environments. The rule is now stateless (`frontend/src/self-widen.ts`): never act on a root claim the kernel has just refuted. Gate: `tests/unit/overlay-environments.test.ts` over the real relay.
- **A fix that over-reaches.** The first fix for the boot card's check fallback (armed by a light session, it finished the boot while a self-widen's replacement was still downloading) disarmed the fallback on every reboot and on a halt. Two independent verifiers showed that this locked a restored buffer that crashes the checker after each serve behind the card for good (or turned it into a "could not start" card a reload repeats): the fallback exists for exactly that buffer (#54). Only the self-widen disarms it now (`frontend/src/check-fallback.ts`); crash reboots and halts leave it armed. Gate: `tests/unit/page-api.test.ts` "the check fallback over the real relay's crash loop".
- **Build hooks.** Rollup runs closeBundle for a failed build, and Vite runs it after a failed write with no error; `qed64-build.json` is written in writeBundle (post, sequential), so a failed build reports its own error and never stamps a stale `dist/`.

Rules: model an async API's timing in its fake, or the test certifies the bug. Make a loop-prevention rule loop-free by construction instead of remembering past actions. Write build outputs only from hooks that run after a successful write.

