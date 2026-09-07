# QED64 architecture

## Live-verified numbers (in-app Chromium, Apple Silicon)

| Event | Measured |
|---|---|
| Runtime verify + instantiate + Lean init | ~8–10 s |
| `init` snapshot (107 MB wire / 342 MB region) region-load at boot | **~0.7–0.8 s**; first Init-only check ~300 ms |
| First check, Init only, without the snapshot | ~25–43 s |
| `mathlib` umbrella snapshot (806 MiB wire / 2.57 GiB region) — download + region walk + `[init]` replay | **~5–7 s** past the download (repeat visits: **~18 s click-to-✓ total** reading the OPFS-cached bytes, zero network) |
| First Mathlib check after the umbrella load | **71 ms** (light `rw` buffer) – **1.6 s** (first use of linarith/norm_num/ring/positivity) |
| Any later Mathlib check — *any* import combination, including headers never baked (e.g. `Nat.Prime.Basic` + `Topology.Basic` + `Order.Filter.Basic`) | **21–77 ms** |
| The same reals example compiled by importing its closure in-browser (strict-headers mode / no snapshot) | minutes (dominated by the olean closure import) |
| Peak Memory64 heap with the umbrella resident | 3.01 GiB of 8 GiB max |
| App bundle (everything that isn't Lean) | 127 KB gzipped |

Before toolchain patch 0017 the umbrella load took **~128 s** and the first
Mathlib check **~31 s** — see "What the load actually costs" below for what
those seconds really were.

## The worker (public/workers/lean.worker.js)

One persistent Worker owns one Lean process for the whole session:

1. **Capability gate** — Memory64 probe (a 13-byte module validation),
   SharedArrayBuffer, Atomics, `crossOriginIsolated`. Fail-closed.
2. **Verified materialization** — lean.js/lean.wasm are fetched as ≤16 MiB
   chunks, each SHA-256-checked, then whole-file-checked, then served to
   Emscripten as private object URLs. Content-Encoding transforms are refused.
3. **Memory** — one shared `WebAssembly.Memory({address:"i64"})`, 256 MiB
   initial, maximum probed downward (8 → 6 → 4 → 3 GiB) so constrained
   machines still boot. The module was linked with a 16 GiB declared maximum,
   so any smaller imported maximum is type-compatible.
4. **Library mounts** — each installed profile gets its own directory
   (`/lib/packs/<id>`); `LEAN_PATH` is the colon-joined list. Two backends:
   - **WORKERFS** over an OPFS `File` (byte-range table straight from the
     profile manifest) — zero-copy until Lean opens a file;
   - **MEMFS byte segments** — transferred `ArrayBuffer`s written as files —
     for environments whose Blob storage or OPFS cannot hold the pack
     (observed: Electron caps both near 2 GiB).
   WORKERFS mounts shadow the mount directory, which is why profiles must
   never share one (learned the hard way; see HARDENING.md).
5. **Init sequence** — `lean_initialize_runtime_module → lean_initialize →
   lean_io_mark_end_initialization → lean_init_task_manager →
   lean_enable_initializer_execution → lean_init_search_path`, with `/bin`
   pre-created because `lean_init_search_path` stats the executable directory.
6. **Batch compiles** — `lean_wasm_compile(sourceStr, nameStr)` against
   the fork's per-import-set environment cache, allowed only *before* the
   resident loop opens (the page uses it for the exact-imports warm import;
   the bakes and the compiler battery use it under Node). Output is claimed
   per compile through a swappable sink (Emscripten reads `print` handlers
   exactly once at startup). Diagnostics arrive as JSON lines with exact
   spans; classic `file:line:col:` text is parsed as a fallback. The IO
   result is decoded at the byte level: tag at +7, value at +8,
   tagged-scalar error count.
7. **Snapshots** — a baked `--incr-header-save` region (produced by the exact
   same binary under Node — its closure relocations are function-table-keyed)
   streams straight into the wasm heap and loads via
   `lean_wasm_load_snapshot_mem` (MEMFS + `lean_wasm_load_snapshot` as the
   fallback). The loaded
   environment is registered under the normalized header key recorded
   *inside* the snapshot, so the resolver serves a header with that exact
   key — or one the environment covers — instead of importing the closure.
8. **The resident FileWorker** — after boot and the pre-open snapshot loads
   the page arms the worker, and the real `lean --worker` loop runs on an
   application pthread reading a futex stdin ring; see "Transport".

### The snapshot tier (public/snapshots/ + src/runtime/snapshots.ts)

`public/snapshots/index.json` (schema `qed64.snapshot-index/v1`) maps each
baked snapshot to the ordered import list it was baked for. The app fetches it
at install time; `matchSnapshot` is an exact ordered-array match — no subsets,
because the runtime keys its environment cache by the precise import sequence.
Snapshots are gzip-served and **content-addressed** — `url` is
`<name>.<sha256-16>.snapz` with the digest also in the index entry, `transfer`
= wire size, `bytes` = raw region size. Content addressing is load-bearing,
not hygiene: a rebuilt runtime bakes a region of the *identical raw size*
(same env content, different relocation values), so a fixed URL behind
immutable HTTP caching once served a stale snapshot that passed every size
check and trapped "memory access out of bounds" against the new binary
(HARDENING lesson 25). The OPFS cache is keyed by the same digest and prunes
superseded same-name entries when a new bake commits. The worker sniffs the gzip magic on the first chunk —
servers that recognise `.gz` add `Content-Encoding: gzip` and the browser
inflates transparently, so the URL cannot be trusted — inflates through
`DecompressionStream` when needed, and streams the region **straight into a
wasm-`malloc`'d buffer**, which the runtime adopts as the region's backing
store (`lean_wasm_load_snapshot_mem`, toolchain patch 0013). No MEMFS staging
copy: a 2.57 GiB region costs 2.57 GiB of wasm heap, not that plus a
JavaScript-heap duplicate. The MEMFS path remains as the fallback when the
raw size is unknown.

Exactly two snapshots ship:

- imports `[]` → the **init** snapshot, loaded right after boot so the first
  Init-only check is instant;
- `["QED64.Essential"]` → the **mathlib umbrella** snapshot. `QED64.Essential`
  is a pipeline-generated module that imports the entire mathlib-essential
  profile (4,192 modules; 4,821 with closure); its environment serves *every*
  Mathlib import combination.

**Covering, in the kernel.** Every loaded snapshot registers its environment
under its normalized import key in the fork's one environment registry
(patch 0032 K1b: Shell's `wasmEnvCache`, read by `Lean.Language.Lean` through
a registered source). A header the user types is resolved *once, inside the
FileWorker* (`setupImports`, see "Transport" below): an exact key hit serves
that environment; otherwise the smallest registered environment whose import
closure covers every named module serves the header **covered** — so after
one umbrella load, every Mathlib buffer, whatever its imports, is served from
the resident environment and rechecks in milliseconds. This is what makes
arbitrary-import Mathlib editing fast: per-import-set snapshots cannot be
pre-baked for headers users haven't written yet. (Before 2026-09-04 the page
did this itself by rewriting the header text to `import QED64.Essential` —
`src/runtime/umbrella.ts`, retired with the pump transport.)

Playground semantics caveat: under a covered header everything in the
essential profile is in scope regardless of which subset the header names
(code may elaborate here that would need more imports in a real project), and
a user's `inductive Tree` collides with Mathlib's — the collision note and the
"Load exact imports" offer below are the answer. Four whole-library aliases
the curation drops — `Mathlib`, `Mathlib.Tactic`, `Batteries` — and
Mathematics in Lean's pure re-export prelude `MIL.Common` count as covered by
the umbrella, so pasted tutorial code compiles unchanged. A header naming a
module in no registered closure (a typo, a module outside the essential
profile) is **refused** by the resolver with one diagnostic on the import line
and no allocation; there is no on-thread olean import in a resident session.

Snapshots are binary-paired: bake them with the *shipped* runtime via `npm run
bake:snapshot` (the bake script gzips and upserts `index.json`);
`pipeline/artifacts/unpack.mjs` reconstructs the olean tree the Node-side
bake mounts via `--lib`. A missing or failed snapshot is a boot failure of
that session (the relay reports it; the page never silently imports the
umbrella's 4,821-module closure from oleans).

### What the load actually costs (profiled)

Every snapshot load prints its stage split to the worker log. For the
2.57 GiB umbrella: **region read + relocation walk ≈ 1–2 s; `[init]`
attribute replay over 152 modules ≈ 1–2 s.** The replay streams
`[WASM INIT] i/n module` lines through the otherwise-blocking call, which
the app renders as a live 152-step counter.

The replay used to cost **105–115 s** and read as irreducible interpreted
work (a shared-interpreter-cache experiment measured no change). A
`--profiling-funcs` CPU profile then attributed 173 s of a 180 s load to
Emscripten's JavaScript `dlsym` shim: the IR interpreter probes for a
*native* implementation of every symbol it touches, no Mathlib symbol
exists in the binary, and each miss crossed into JS and allocated an error
string. Toolchain patch 0017 gates the probe on a one-time `Set` of the
module's export names, which collapsed the replay ~100× and cut first
compiles ~8× — the same storm had been throttling every interpreter run
(see HARDENING lesson 24).

### Snapshot cache and the preparation UX

The worker caches each snapshot's bytes in OPFS (`qed64-snapshots/<name>.<bytes>.<transfer>.snapz`,
written incrementally during the first download through a sync access
handle, committed by rename) and reads it back in 8 MiB slices on later
sessions — the 806 MB umbrella is downloaded once per browser, not once per
session (measured repeat-visit: 12 s to read + inflate 1.9 GiB from storage
versus a network download). Cache failures never fail a load.

Long preparation steps are rendered live by the page (frontend/src/main.ts
`ui.progress` from the worker's `progress` events): the boot overlay and the
status pill name the stage — downloading/reading the snapshot (bytes), loading
it into Lean (indeterminate; the worker posts a phase event before its one
blocking call), then the first check — with elapsed time. The overlay goes at
the first phase in which the workspace is actionable (`ready`, or
`headerRefused` for a restored buffer whose import line needs editing).
Usability-tested as a first-time user: click-to-✓ is ~2m20s on a local server
with every moment explained; repeat visits skip the download.

### Mid-session storage and runtime recovery

The storage behind a mounted pack can die while the session lives (HARDENING
lessons 16–17), and a runtime can be poisoned after hours of idle (lesson 22).
On the resident page both surface as a worker death and take the relay's one
recovery path (see "Transport"): in-flight requests are answered, the session
is disposed, and a replacement boots from scratch. `ResidentSession.start()`
re-prepares what a dead worker consumed — memory-backed pack segments were
*transferred* to the worker that booted them, so they are reinstalled (a
healthy OPFS cache revalidates in milliseconds; a dead one re-downloads) and a
pack no longer in the index is dropped from `LEAN_PATH` rather than mounted
empty. Three deaths inside 120 s trip the breaker instead of looping. (The
batch app's `isStaleStorageError` classifier and probe-compile gate,
`src/runtime/errors.ts` / `src/app.ts`, were retired on 2026-09-04.)

### wasm64 pointer discipline

Every i64-typed export parameter must be BigInt; returns are BigInt. The
worker normalizes at exactly two helpers (`asPtr`, `asNum` — the latter
range-checked below 2^53) and reads Lean objects only through `getValue`
(the build does not export the HEAP views).

## Transport (resident; the page's only transport since 2026-09-04)

One real `lean --worker` runs for the life of the tab. The page never
resolves a header, never mirrors the worker's document, and never decides
liveness from silence except through the worker's own heartbeat. The layers,
top to bottom, and the exact surface between each pair:

```
Monaco / lean4monaco (unchanged)
  │  LSP JSON-RPC over a MessagePort (relay.clientPort); server capability
  │  textDocumentSync.change = 1 (full text) — the wire has no ranged edit
  ▼
L3  frontend/src/lsp-relay.ts — LspRelay: 3 states, 0 timers, 0 regexes
  │  RelaySession: start() · arm() · lsp(msg, replay?) · onLsp · onStatus · onDied(code, reason, message) · dispose()
  ▼
L4' frontend/src/resident-session.ts — ResidentSession (the adapter; ResidentPolicy hooks)
  │  LeanSession: boot(config) · loadSnapshot · compile (pre-open only) · lsp · arm → 'lsp-arm' · request('telemetry') · dispose
  ▼
L2  src/runtime/client.ts — LeanSession: the only owner of the Worker and the wire protocol
  │  postMessage: boot, loadSnapshot, compile, lsp {msg, replay?} (fire-and-forget), lsp-arm, telemetry, dispose
  │  events: progress, log, lsp {msg}, status {…}, heartbeat, died / error
  ▼
L1  public/workers/lean.worker.js + lsp-front-door.js + lsp-frames.js
  │  stdin  = futex ring in shared memory; stdout = per-byte tap → Content-Length framer; stderr = log lines
  ▼
L0  the Lean fork (KERNEL-PIN; patches 0031/0032) — FileWorker.setupImports is the ONLY header resolver
```

**The front door** (`public/workers/lsp-front-door.js`; design
docs/ARCHITECTURE-REEVALUATION-2-2026-09-02.md §2.4) is one pure reducer,
`step(state, frame) → {state, ringWrites, replies, startLoop, statusDelta}`,
run under vitest exactly as it runs in the worker, which only performs the
effects it returns. Frames are `{kind:"client", msg, replay?}`,
`{kind:"server", msg}`, `{kind:"booted"}`, `{kind:"ring", busy}` and
`{kind:"died"}`. Its machine is `booting → ready (loop closed, frames
queued) → open → dead`:

- `initialize` is answered at once from the transcribed watchdog capability
  table (with `change: 1`) and cached; a *replay* (the relay re-sending after a
  reboot) is cached only. `shutdown` is answered `null`. The FileWorker itself
  never answers `initialize` — in a native setup that is the watchdog's job.
- The first `didOpen` while `ready` starts the loop: `startLoop` (the host
  opens the ring and calls `main --worker`), then `initialize` and the
  `didOpen` go into the ring back to back — the FileWorker reads exactly
  those two, in that order, with nothing between. Queued frames drain
  afterwards through the same rules. A `didOpen` on an *open* loop (the
  relay's replay onto a loop a queued open already started; lean4game's next
  level) becomes a full-text `didChange` with **version rebasing**
  (`base = lastVersion + 1 − newVersion`, added outbound and subtracted from
  every inbound `version` / `textDocument.version`), because the FileWorker
  drops notifications for versions below its own.
- Only the five notifications the FileWorker dispatches are forwarded
  (`textDocument/didChange`, `$/cancelRequest`, `$/lean/staleDependency`,
  `$/lean/rpc/release`, `$/lean/rpc/keepAlive`); any other notification
  (`exit`, `initialized`, `$/setTrace`, `workspace/*`, `didClose`, …) is
  dropped and counted in `status.dropped` — an unknown notification is
  `throwServerError → forceExit 1` in the worker, so a new lean4monaco
  notification must never be able to kill it. Requests all go through. A
  `didChange` at or below the version the worker already holds is dropped
  (it would regress the document). While the host reports the ring parked,
  outbound frames are held with newest-`didChange`-wins coalescing and
  released on drain.
- Two completions are failed fast with `-32801` (ContentModified, which the
  client swallows): one whose position is on an import line — import-path
  completion is the client's (`frontend/src/import-completion.ts`, from the
  pack manifests; the wasm worker has no module inventory) — and any
  completion while the header is refused. Decided by *position*, so it cannot
  race the header status the same keystroke is still producing (HARDENING #45).
- Server frames are version-shifted back and passed through with two reads:
  `$/lean/fileProgress` updates `progress = {version, processing, fatal}`
  where a kind-2 (fatalError) entry counts as terminal, not as work in flight
  (HARDENING #46); `$/qed64/headerStatus` becomes `header`. A
  `publishDiagnostics` under a **covered** header whose messages say
  "already declared" sets the **collision fact** `{names, version}` and
  appends one severity-3 QED64 note to *that same publish* (LSP diagnostics
  are a whole-document replacement, HARDENING #42); the next burst without a
  collision clears the fact.
- `statusOf(state) → {phase, version, header, collision, dropped}` with
  `phase ∈ booting | starting | elaborating | ready | headerRefused | dead`:
  `ready` iff the last progress drained at the last version *written* (worker
  space on both sides) and the header verdict for this setup is not a
  refusal; `headerRefused` when it is, or when progress carries a fatal
  entry; `starting` before the first document/progress; `elaborating`
  otherwise. A body keystroke takes Lean's `unchanged` path and emits no
  `headerStatus`, so `header` is per header setup, not per version.

**The host** (`lean.worker.js`) adds what the machine cannot know and
merges it into one `status` event per change: `ring {bytesQueued, refused}`
and `pool {unused, running}` (pthread pool; −1 = not measured). Booting →
Ready is the page's **`lsp-arm`** request, sent as the *last* step of a
session start — after `boot`, after every pre-open snapshot load and after
an optional warm compile — never the wasm boot's own success: fed at boot
success, a queued `didOpen` opened the loop under a snapshot load (refused
`BAD_STATE` → boot failed → reboot → the same race → breaker). Opening the
loop is `_lean_wasm_shell_mark_preinitialized()` (boot already ran the full
init sequence; `main` must not run it again), `_lean_browser64_configure_input_ring(ptr, cap)`,
then `callMain(["--worker", "-Dserver.reportDelayMs=0"])` on the application
pthread (`PROXY_TO_PTHREAD`, patch 0031). Once open the worker beats every
2 s (`heartbeat` events; the only lifecycle-by-time signal in the system).
After the loop opens, `loadSnapshot` and `compile` are refused `BAD_STATE`
(invariant K-i: no environment is published after open, so Lean's
`unchanged` reuse is sound).

*The stdin ring.* `RESIDENT_RING_CAP` = 4 MiB at the time of writing (one
constant in `lean.worker.js`; the pump-removal assessment's gap 6 proposes
64 MiB so that documents over 2 MiB are not refused): a 16-byte control
block (`READ`, `WRITE`, `CLOSED`, `WAKE` as `Int32`, `Atomics.notify` on
`WAKE`) followed by the byte ring, `malloc`'d in the shared Memory64 heap.
The outer worker is Emscripten's main thread (it services Lean's proxied
stdout and filesystem calls) so it must never `Atomics.wait`: writes are
non-blocking, whole frames in FIFO order; a frame that meets a full ring
parks the pump (`setTimeout(…, 2)`) and reports `{kind:"ring", busy:true}`
to the front door; a frame larger than half the ring (2 MiB) is refused
before it is queued and counted in `ring.refused`. Frames are
`Content-Length: N\r\n\r\n` + UTF-8 body.

*stdout.* fd 1 is a per-byte TTY tap (`lsp-frames.js`, shared with the Node
probe): a strict `Content-Length` framer over a growable buffer that copies
out of the heap view, byte-exact bodies, resync at the next `Content-Length:`
inside junk (HARDENING #27). Library progress and `[WASM LSP] prebuilt
lookup HIT|MISS` lines go to stderr as `log` events.

**LeanSession** (`src/runtime/client.ts`) owns the Worker. `lsp(msg, replay?)`
posts without a promise or ack (a booting worker queues it, a dead one drops
it); `arm()` is the `lsp-arm` request; `request("telemetry")` answers
`{state, memory:{currentBytes, initialBytes, maximumBytes, regionBytes, …},
status}`. `onDied(code, reason, message)` fires **once** per session from a
worker `error`, an unrecoverable error reply, the worker's `died` event, or
**heartbeat loss**: 6 s without a beat, then a telemetry probe unanswered for
2 s (a frozen page timer fires late, never falsely). `dispose()` detaches
every listener *first*, then terminates — a deliberate teardown is never a
death.

**The relay** (`frontend/src/lsp-relay.ts`; §2.3) reads four fields of a
message — `method`, `id`, `params.textDocument.version`, and the full text
of a `didOpen` / full-text `didChange` into `lastText` (equal to the
worker's document by construction) — and keeps `initialize`, `doc {uri,
languageId, version}`, `pending: Map<id, method>`, `deaths: number[]` and
counters `stats {reboots, userRestarts, workerDeaths, breakerTrips,
failedInFlight, staleDeaths, rangedChanges}`. States:

| state | what it does |
|---|---|
| `rebooting {reason: boot \| crash \| heartbeat \| user \| bootFailed}` | a fresh session is booting; client messages are recorded and forwarded (the worker queues them) |
| `serving` | steady state; every request id is remembered until its response passes back |
| `halted` | the breaker tripped: ≥ 3 deaths in 120 s. Requests are answered `-32603 "QED64: checker halted after repeated crashes; edit the file to restart it"`, notifications are dropped, and the next `didChange` clears the death window and reboots (`user`) |

Events: **BootOk** — after `start()` resolves the relay replays `initialize`
(`replay: true`, cached only) and a `didOpen` carrying `doc` + `lastText`
(re-established from what *this relay* forwarded, never from the editor —
lean4game's editor text is untranslated), then `arm()`; only then `serving`.
**SessionDied** (from `onDied`, current session only — a stale session's
death is counted in `staleDeaths` and ignored): every pending request is
answered in the same turn (`-32900` RpcNeedsReconnect for `$/lean/rpc/*`
so the InfoView reconnects, `-32603` otherwise), the session is disposed,
and a replacement is made after the one wait in the design — a 1.5 s heap
release settle, *injected* by the page so the module owns no timer.
**BootFailed** (`start()` or `arm()` rejects) is a death with reason
`bootFailed`. **restart(opts)** — only while `serving` — is the deliberate
replacement for "Load exact imports": counted in `userRestarts`, never as a
death; `opts = {snapshots, warmHeader, packs}` reach the next
`makeSession(opts)`. **unload()** (`pagehide`) disposes the session.
`status()` is the worker's last status with `phase` overridden to `halted`
in that state, plus `relay` (the state kind) and `session` (id); a
replacement session's first status carries no collision fact, so the offer
withdraws by itself. Since 2026-09-04 it also carries `lastDeath {reason,
message}` (from `onDied` or the boot rejection; cleared when a session
reaches `ready`), the relay remembers `restartOpts` and reuses them on a
crash reboot while the header (the leading import lines of `lastText`) is
unchanged — so an exact-imports session survives a crash — and the breaker
branch posts one whole-document `publishDiagnostics` with a single
severity-1 QED64 diagnostic on the first import line explaining that the
checker crashed repeatedly on this content, replacing the dead session's
stale markers.

**ResidentSession** (`frontend/src/resident-session.ts`, extracted from
main.ts on 2026-09-04 so lean4game can vendor it) implements `RelaySession`
over one `LeanSession` and takes a `ResidentPolicy {snapshotsFor?(headerText),
initialBytesFor?(headerText), maximumBytes?}`. `start()`: reinstall packs the
previous worker consumed, build the pack mount list, `boot` with a 2 GiB
initial commit under a 6 GiB cap (probed downward on constrained machines;
the policy can lower both), load `opts.snapshots ?? ["init", "mathlib"]` in
order, and — when `opts.warmHeader` is set — compile the header's *import
lines only* through `lean.compile` while the loop is still closed, so the
real olean import pushes the exact environment into the registry. It
deliberately does **not** arm: the relay arms after its replay. A failed warm
import is reported, not thrown (a throw would be a `bootFailed` death and a
breaker candidate); the header is then served covered again and the offer
comes back.

**The kernel resolver** (patch 0032 K1, `FileWorker.setupImports`) runs once
per header setup, before any filesystem access: the header's modules are
normalized to one key (`Init` first, de-duplicated, empty ≡ `#[Init]` —
`qed64HeaderKey`, the same function at every cache push and in the batch
compile path); an **exact** key hit serves that environment; else the
smallest registered environment whose closure **covers** every module
(umbrella aliases count) serves it; else the header is **refused** with one
diagnostic on the import line, zero allocation and no on-thread import.
Each setup emits `$/qed64/headerStatus {version, mode: exact | covered |
refused, key, moduleCount, missing, ms}` on the document's own channel
(serialized with its diagnostics and progress). Known kernel follow-up: on
later setups `version` is stamped with the initial document version (a
closure binding in the FileWorker); nothing user-visible keys on it.

**Collision, explain and offer** (HARDENING #43): a covered header plus an
"already declared" error sets the collision fact; the page
(`offerExactImports` in main.ts) shows *one* action, "Load exact imports",
while the fact is set and withdraws it when the fact clears (a clean burst,
a header edit, a replacement session). The click is
`relay.restart({snapshots: ["init", "mathlib"], warmHeader: relay.lastText,
packs: ["essential"]})`: the essential olean pack is installed *before* boot
(mounts are boot inputs), the header is warm-imported, and — the lookup being
exact-first — the FileWorker then serves this header `exact` (no umbrella
names, no collision) while every other header stays covered. For a header
that is only one of the four aliases the exact environment *is* the
umbrella, so no offer is useful there (the assessment's gap 1; the front door
gates the fact on the normalized key).

**The page** (`frontend/src/main.ts`): the pill is `render(status)` —
`PHASE_LABEL[phase]`, busy for `booting | starting | elaborating | dead`,
idle otherwise; the boot overlay is dismissed at the first `ready` or
`headerRefused`. A `halted` status renders in two ways: if no session ever
reached `ready`, the boot-failure card ("QED64 could not start: <message>",
Reload); otherwise the pill reads `halted — <reason>` and the relay's
in-document diagnostic explains. The harness oracle is
`globalThis.qed64 = { artifacts, relay, ui, status: () => relay.status(),
editor }`; `relay.session.lean` is the `LeanSession`
(`relay.session.lean.request("telemetry")` feeds the heap meter and the
e2e memory rows), `relay.stats` the counters the e2e lane diffs.

Numbers that are load-bearing: ring 4 MiB (frames > 2 MiB refused);
heartbeat 2 s, loss 6 s + 2 s probe; breaker 3 deaths / 120 s; reboot
settle 1.5 s; boot 2 GiB initial / 6 GiB cap; measured on the served 0032
pairing: covered header switch 322 ms edit → ready, boot 12.5 s warm, kill
→ ready with all edits present in ~15 s (docs/RESIDENT-WORKER-PLAN.md).

## The installer (src/install/profiles.ts)

`fetch parts → SHA-256 each → gunzip stream → sink`, where the sink is an
OPFS staging file (committed by atomic `move()` + meta marker) or, after any
storage failure (quota, stall, missing `move`), an in-memory byte-segment
build. Failure handling is the hard-won part:

- every ingress await races the sink task, so a dead sink can never leave
  `write()`/`close()` waiting on a queue nobody drains;
- a failing sink cancels the gunzip reader — otherwise the transform wedges
  and even `abort()` never settles;
- OPFS writes run under a 20 s stall watchdog (some embedders hang rather
  than reject at their real ceiling), and the observed ceiling is remembered
  in localStorage so later visits skip the doomed attempt.

## Trust model

Nothing executes or mounts that was not named by digest in a same-origin
manifest: runtime chunks (SHA-256 each + whole), transport parts (SHA-256
each), pack byte-ranges (validated against blob/buffer size, control-character
and traversal checks on virtual paths). The raw-pack digest is re-derived
out-of-band by `npm run verify:release` because WebCrypto cannot stream.
Diagnostics and share-link content are rendered exclusively through
`textContent`-based escaping.
