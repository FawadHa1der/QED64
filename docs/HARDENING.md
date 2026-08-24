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
