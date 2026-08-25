# Emscripten bug report + fix (ready to file)

*Discovered 2026-08-25 while porting Lean 4's language server to run in-browser
(QED64, branch `feature/lean4web-frontend`). Repro and validation artifacts:
`pipeline/lsp/` probes and the pure-C repro below.*

## Suggested issue title

> A pthread's first sync-proxied operation tears down the runtime when
> exported functions are used without running `main()` (EXIT_RUNTIME=1):
> `checkMailbox` → `callUserCallback` → `maybeExit` → `_exit()` terminates the
> thread blocked in `emscripten_proxy_sync`

## Versions

- emsdk / emscripten **6.0.5** (`emcc 6.0.5 (1db5137)`, docker image
  `emscripten/emsdk:6.0.5`); the relevant code is unchanged on current `main`
  (`src/lib/libpthread.js`, `$checkMailbox`, ~line 1295).
- Reproduces on **stock wasm32** — not specific to MEMORY64 — under Node 26
  and Chromium alike, with plain `-pthread -sEXIT_RUNTIME=1`.

## Summary

A library-style embedding (`noInitialRun: true`, exported functions called
from JS, `main()` never runs) keeps `runtimeKeepaliveCounter == 0`. The first
time a pthread performs a synchronously-proxied operation (any proxied JS
syscall — a `printf`/`fprintf` to a TTY, a filesystem call, …) while the main
runtime thread is idle in its event loop:

1. the pthread enqueues the task and blocks in `emscripten_proxy_sync`
   (`system/lib/pthread/proxying.c:407`, `pthread_cond_wait` on the ctx);
2. the main thread receives the mailbox notification and services it via
   `$checkMailbox` (`src/lib/libpthread.js:1295`), which wraps the work in
   `callUserCallback`;
3. `callUserCallback`'s `finally { maybeExit() }` sees
   `keepRuntimeAlive() === false` and calls `_exit(EXITSTATUS)` — **runtime
   teardown and `PThread.terminateAllThreads()` — immediately after executing
   the proxied task and before the calling thread has consumed the result.**

The observable behavior is deeply confusing: the proxied operation *visibly
completes* (the text is printed), `Module.onExit` fires with
`code=undefined` (EXITSTATUS was never set), the calling pthread vanishes
mid-function, and the runtime is unusable afterward. Nothing is logged unless
the embedder installed `onExit`.

We hit this porting Lean 4's LSP server (every server task runs on a
dedicated pthread); it presented as "background threads execute until their
first I/O and then silently die".

## Minimal repro (30 lines of C + a small JS harness)

```c
// repro.c — emcc repro.c -o repro.js -pthread -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=1 -O1
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>
#include <emscripten.h>

static void* thread_fn(void* arg) {
  fprintf(stderr, "A: proxied write from pthread\n");
  usleep(300000);
  fprintf(stderr, "B: thread survived its first proxied call\n");
  return NULL;
}
EMSCRIPTEN_KEEPALIVE void start_thread(void) {
  pthread_t t;
  pthread_create(&t, NULL, thread_fn, NULL);
}
int main(void) { return 0; }   // never called by the harness
```

```js
// run.mjs — node run.mjs        (bug: A prints, "RUNTIME EXITED", no B)
//           node run.mjs --fix  (workaround: A and B print, runtime stays up)
globalThis.Module = {
  noInitialRun: true,
  onRuntimeInitialized() {
    if (process.argv.includes("--fix")) runtimeKeepalivePush();  // workaround
    Module._start_thread();
  },
  onExit: (code) => console.log(`RUNTIME EXITED code=${code}`),
};
// ... load repro.js (classic, non-modularized) ...
```

Observed without `--fix`:

```
A: proxied write from pthread
RUNTIME EXITED code=undefined
(B never prints; the pthread was terminated inside fprintf)
```

With `--fix` (one keepalive ref): `A`, then `B`, runtime stays alive.

## Why this is a bug and not just EXIT_RUNTIME semantics

Even granting that EXIT_RUNTIME=1 may exit when "nothing keeps the runtime
alive", the teardown here fires **between executing a synchronously-proxied
task and its requester consuming the result** — the mailbox service itself is
what trips the exit. A thread blocked inside `emscripten_proxy_sync` is
platform-internal evidence that the runtime is very much in use. The same
race can bite ordinary EXIT_RUNTIME=1 programs after `main` returns with
lingering pthreads. At minimum, mailbox servicing (runtime-internal
bookkeeping on behalf of other threads) should not run through the
user-callback exit check.

## Proposed fix (validated)

Hold a runtime keepalive across the mailbox check, in
`src/lib/libpthread.js`:

```diff
   $checkMailbox__deps: ['$callUserCallback',
+                        '$runtimeKeepalivePush',
+                        '$runtimeKeepalivePop',
                         'pthread_self',
                         '_emscripten_check_mailbox',
                         '_emscripten_thread_mailbox_await'],
   $checkMailbox: () => {
     ...
     var pthread_ptr = _pthread_self();
     if (!pthread_ptr) return;
+    // Servicing the mailbox executes proxied work on behalf of other threads
+    // (e.g. a pthread blocked in emscripten_proxy_sync); it must not trigger
+    // EXIT_RUNTIME teardown via callUserCallback's maybeExit, which would
+    // terminate the waiting thread before it can consume the result.
+    runtimeKeepalivePush();
     callUserCallback(() => {
       // If we are using Atomics.waitAsync as our notification mechanism, ...
       __emscripten_thread_mailbox_await(pthread_ptr);
       __emscripten_check_mailbox();
     });
+    runtimeKeepalivePop();
   },
```

Validated three ways against the repro (and against the full Lean LSP
workload):

1. Unpatched: bug reproduces (A, RUNTIME EXITED, no B).
2. Embedder workaround (`runtimeKeepalivePush()` at boot): fixed.
3. This glue patch, with the embedder workaround **removed**: fixed —
   `maybeExit` observes `keepalive=1` during mailbox servicing and the
   runtime lives on; a later legitimate exit is unaffected because the ref is
   dropped after each service pass.

Note for reviewers: the Node repro also shows the same teardown firing via
the worker-message path (`cmd 6` → `callUserCallback(() => cleanupThread(...))`)
in some interleavings; if a broader guarantee is preferred, an alternative is
to treat "any live pthread" or "any pending sync-proxy ctx" as keeping the
runtime alive, but the `checkMailbox` guard is the minimal targeted repair
for the reported failure.

## Related

- The `TODO` in `$checkMailbox` already references
  emscripten-core/emscripten#25076 (checkMailbox after shutdown) — this
  report is the inverse ordering: checkMailbox *causing* the shutdown.
