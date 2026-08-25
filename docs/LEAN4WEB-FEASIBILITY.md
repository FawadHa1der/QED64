# Feasibility: lean4web front end on the QED64 wasm64 backend

*2026-08-25 · branch `feature/lean4web-frontend` · research: 4-agent deep-dive
over lean4web/lean4monaco/lean4 server sources + local source analysis of our
fork + two working probes.*

## The question

[live.lean-lang.org](https://live.lean-lang.org) ([leanprover-community/lean4web](https://github.com/leanprover-community/lean4web))
is the community's Lean playground: Monaco editor + the real vscode-lean4
InfoView (interactive goals at the cursor, hovers, completions, widgets). Can
we fork that front end and replace its server-side Lean with our in-browser
wasm64 toolchain?

## Verdict: FEASIBLE — high confidence, staged, genuinely novel

Nobody has run Lean 4's language server under WebAssembly: Lean FRO said in
2021 there were "no immediate plans", a 2023 community attempt crashed on
threading (single-threaded wasm32), and lean4web's own
[issue #73](https://github.com/leanprover-community/lean4web/issues/73)
concluded a wasm backend was not feasible *for them* — citing exactly the
problems QED64 has since solved: a working pthreads + Memory64 build, verified
multi-GB artifact delivery to the browser, and (as of patch 0017) a snapshot
load fast enough to make a Mathlib-scale server session practical.

The decisive technical facts, verified against source and by experiment:

1. **A bare `lean --worker` is a self-contained single-file LSP server.**
   `FileWorker.initAndRunWorker` reads `initialize` + `textDocument/didOpen`
   from stdin and then serves the full worker protocol from its `mainLoop` —
   diagnostics, hover, completion, `$/lean/plainGoal`, and the whole
   `$/lean/rpc/*` surface the InfoView is built on. The watchdog adds only
   multi-file features (references, symbols, module hierarchy) a single-buffer
   playground doesn't need, plus a 2-message spawn handshake and crash/restart
   supervision — replicable in ~200 lines of JS.
2. **No process spawns on our path.** The worker's `lake setup-file` call
   short-circuits to `noLakefile` when no lake binary exists (our wasm FS),
   after which header imports load from `LEAN_PATH` — the WORKERFS pack
   mounts QED64 already ships.
3. **Worker mode already runs under our wasm64 binary.** Probe
   `pipeline/lsp/lsp-probe.mjs` drove `callMain(["--worker"])` with a scripted
   conversation: the worker parsed `initialize` + `didOpen` and emitted a
   correctly framed `publishDiagnostics` through byte-level stdio callbacks.
   It only died at scripted-EOF — Emscripten stdin cannot express "no data
   yet", and a blocked main thread would starve the pthread task system's
   proxied I/O.
4. **The host-pumped dispatch dissolves that.** Toolchain patch 0018
   (`lean_wasm_lsp_init` / `lean_wasm_lsp_send`, this branch) replicates the
   watchdog's exact 2-message startup and then dispatches one already-read
   message per call through the public `handleRequest`/`handleNotification` —
   the main thread returns to the event loop between messages, so elaboration
   tasks' proxied FS reads and stdout writes drain. Same integration shape as
   our proven `lean_wasm_compile`. Evidence: `pipeline/lsp/lsp-pump-probe.mjs`
   (results below).
5. **The front end has a transport seam.** lean4web's entire Lean surface is
   the npm package `lean4monaco`; its `LeanMonacoOptions.websocket` object is
   spread **last** into monaco-editor-wrapper's connection config, so
   `websocket: { $type: 'WorkerDirect', worker }` routes the LSP client at a
   Web Worker over `postMessage` instead of a WebSocket — monaco-editor-wrapper
   5.3.1 supports `WorkerConfigDirect` natively (clangd-in-browser and the
   monaco-languageclient examples ship exactly this pattern). Our shim
   converts the worker's Content-Length frames to the structured-clone JSON-RPC
   objects `BrowserMessageReader/Writer` expect.

## How the pieces map

| lean4web today | This plan |
|---|---|
| WebSocket `wss://host/websocket/<project>` | Web Worker + `{ $type: 'WorkerDirect' }` |
| Node server spawns `lake serve` per connection | JS "watchdog shim" (~200 lines) in the worker |
| Lean watchdog process | shim: answers `initialize`, forwards the rest, restarts on exit-code-2 (header edits) |
| `lean --worker <uri>` process per file | the QED64 wasm64 runtime + patch 0018 pump exports |
| bubblewrap sandbox, 1 h CPU limit | the browser tab *is* the sandbox |
| project olean trees on the server disk | QED64's verified packs in OPFS via WORKERFS (unchanged) |
| server RAM per visitor | visitor's own machine (8 GiB heap cap, probed down) |
| `/api/projects`, examples, settings, themes (React/jotai) | kept nearly as-is; project list becomes our install profiles |

## Pros

- **The real InfoView.** Interactive tactic-state-at-cursor, expected type,
  hovers, completions, semantic highlighting, `sorry`-hole navigation —
  a categorical UX upgrade over QED64's batch compile + goals panel.
- **Incremental elaboration.** The worker's snapshot tree re-elaborates only
  from the edit point on `didChange` — typing inside a proof no longer pays
  the whole buffer.
- **Zero servers, still.** lean4web needs a sandboxed process per visitor;
  we keep $0 static hosting with the compute on the visitor's machine.
- **Small fork surface.** lean4web's app shell is ~50 small files (Apache-2.0);
  the hard parts live in lean4monaco, which we likely don't fork at all.
- **Upstream story.** Patch 0018 is a clean "embeddable file worker" surface;
  the JS shim mirrors the watchdog contract rather than forking it —
  lean4game's deleted custom watchdog is the cautionary tale we avoid.
- **First-of-its-kind.** Lean's LSP in a browser tab has never shipped;
  the research trail says we're uniquely positioned to do it.

## Cons / risks

- **Effort.** Stage 2 (transport shim + fork integration + our installer/COI
  machinery wired into their React app) is days of work, not hours; Stage 3
  (umbrella env inside the worker) touches header-processing internals.
- **Mathlib header cost until Stage 3.** The worker imports headers from
  oleans (~minutes for big Mathlib closures) until `setupImports` learns to
  consult our snapshot-seeded env cache; the umbrella rewrite trick must be
  re-plumbed at didOpen level (rewrite before forwarding + reverse-map any
  header diagnostics, or land the env-cache hook directly).
- **Restart-on-header-edit.** The worker exits (code 2) when the header
  changes after imports load; the shim must reboot the wasm instance (~8 s +
  env reload). The watchdog has identical semantics, but our reboot is
  heavier than a process spawn — snapshot loading (Stage 3) pulls it back to
  seconds.
- **State-drift risk in the pump.** Handler tasks capture the state ref of
  the pump call that created them; our pump round-trips state through a
  host ref per message. If some async path mutates worker state outside a
  pump call, bookkeeping could drift — the probes and Stage-2 soak testing
  gate this.
- **Undocumented transport override.** The `$type` spread-last behavior in
  lean4monaco is real but unpinned; a future release could break it. Pin the
  version; upstream a tiny PR making worker transports first-class if it
  sticks.
- **Bundle weight.** lean4monaco unpacks to ~29 MB (monaco-vscode-api,
  InfoView iframe assets, oniguruma wasm); the app-shell JS lands ~10–20 MB —
  an order of magnitude over QED64's 127 KB shell, though trivial next to the
  Lean artifacts themselves.
- **Version coupling.** lean4monaco pins a vscode-lean4 fork per release;
  InfoView RPC must match the toolchain (we're 4.33-pre — current lean4monaco
  tracks the same era; verify at Stage 2 and pin).
- **Memory ceiling.** InfoView RPC sessions hold object stores on top of the
  resident env; the 8 GiB heap probe-down machinery already handles pressure,
  but Mathlib + LSP sessions need soak measurement.
- **Mobile stays out.** Monaco has no mobile support (lean4web falls back to
  a plain CodeMirror with no Lean features); QED64's CodeMirror front end
  remains the answer there — keep both, shared backend.

## Staged plan (each stage independently shippable)

1. **Stage 1 — pump probe (this branch, done):** patch 0018 + Node probe
   proving initialize→didOpen→diagnostics→`$/lean/rpc` goals against the
   wasm64 worker. *Exit: probe passes for an Init-only document.*
2. **Stage 2 — browser transport + forked front end:** fork lean4web client,
   replace the WebSocket with the WorkerDirect bridge into a QED64-style
   worker (verified chunks, WORKERFS mounts, capability gate), shim the
   watchdog contract (initialize response, exit-2 restart, keepAlive
   forwarding, URI mapping). *Exit: live InfoView goals while typing an
   Init-only proof in the browser.*
3. **Stage 3 — Mathlib at speed:** hook the env cache/umbrella snapshot into
   the worker's header setup (fork patch in `setupImports`, mirroring
   `getOrCreateWasmEnvFor`), OPFS snapshot cache reuse, restart-fast path.
   *Exit: Mathlib buffer gets InfoView goals with the umbrella's seconds-class
   startup.*
4. **Stage 4 — productize:** examples/settings/themes rewire, install flow,
   usability matrix, deploy beside (not replacing) the current QED64 UI.

## Stage-1 results (2026-08-25, this branch)

What is PROVEN, each by direct experiment:

1. **The server code runs under wasm64** — `--worker` mode parses
   `initialize` + `didOpen` and emits correctly framed LSP output
   (`lsp-probe.mjs`).
2. **The pump exports work** — patches 0018/0019 build; `lean_wasm_lsp_init`
   returns success in Node and in the browser worker; the watchdog startup
   contract is reproduced exactly (research-confirmed: the watchdog sends
   workers precisely those two messages).
3. **Dedicated-thread spawning works in the browser** with the 24-worker
   preallocated pool (patch 0019) — with the old pool of 4, a single
   dedicated spawn IO-errored, because synchronous `pthread_create` can only
   claim preallocated workers.
4. **Cross-thread output works in the browser** — a dedicated task's
   `IO.eprintln` reaches the host through the proxied stdout path.
5. **Full protocol machinery verified under CLI boot** — dedicated spawn +
   `IO.sleep` + join all complete when the main thread blocks in wasm
   (`IO.wait`), confirming every primitive is present in the binary.

The ONE open blocker, precisely characterized:

- **Timed sleeps on dedicated pthreads never wake in the persistent-boot
  browser context** ("before" arrives, "after `IO.sleep`" never does; fresh
  session, first action — not a wedge from prior state), and the worker's
  main thread later stalls. Lean's server sleeps in exactly four places; the
  reporter's first statement is one (neutralized via
  `server.reportDelayMs := 0` in patch 0018), yet the processing chain still
  stalls — so a further wait-primitive in the snapshot-task chain is
  affected, not just `IO.sleep`.
- Sleep is pure-wasm (`memory.atomic.wait` timed futex; no sleep syscalls
  exist in the JS glue), so an environment factor that differs between
  "main blocked in wasm" (works) and "main in the event loop" (stalls) is
  implicated. The **strongest suspect is hidden-tab throttling**: every
  in-pane experiment necessarily ran with `document.visibilityState ===
  "hidden"`, Chrome throttles hidden pages' workers aggressively, and the
  automation harness cannot make the tab visible while driving it. **Next
  experiment (needs a human): run the dedicated+sleep probe in a visible
  tab.** If visibility fixes it, Stage 1 is complete and the remaining work
  is UX-shaped; production would need the standard mitigations (audio
  context / title-blink prompts are not needed — a playground is visible
  while used).
- Fallback paths if visibility is NOT the answer, in order of preference:
  (a) trace the exact futex address/clock behavior with a `--profiling-funcs`
  build paused in DevTools; (b) patch the four server sleep sites (three are
  option- or feature-gated) and audit `ServerTask` waits for timed variants;
  (c) relocate Lean's main loop off the runtime thread
  (`PROXY_TO_PTHREAD`-style), making "main blocked in wasm" the steady
  state — the configuration proven to work end to end in CLI mode.

## Evidence log

- `pipeline/lsp/lsp-probe.mjs` — callMain `--worker` conversation (framed
  output verified; EOF limitation analyzed).
- `pipeline/lsp/lsp-pump-probe.mjs` — Node pump driver (init succeeds; Node
  additionally fails to service pthread→main proxying from an idle event
  loop — Node-harness-specific, browser does service it).
- Browser probes via the branch worker's `lsp-init`/`lsp-send` debug RPC
  (`public/workers/lean.worker.js`) and dedicated-task compiles — the
  findings table above.
- Toolchain: patches 0018 (pump entry points, zero report delay) and 0019
  (24-worker pool, 8 MiB thread stacks); runtime `wasm64-26c2598ac29f3b7b`
  (dev-only, chunked locally, never promoted).
