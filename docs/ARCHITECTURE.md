# QED64 architecture

## Live-verified numbers (in-app Chromium, Apple Silicon)

| Event | Measured |
|---|---|
| Runtime verify + instantiate + Lean init | ~10 s |
| `init` snapshot (107 MB wire / 342 MB region) region-load at boot | **608–691 ms**; first Init-only check ~300 ms |
| First check, Init only, without the snapshot | ~25–43 s |
| `mathlib` umbrella snapshot (806 MB wire / 2.57 GiB region) streamed straight into the wasm heap | **128 s**, once per session (with Mathlib's 3.25 GiB pack *also* resident in this pane's memory) |
| First Mathlib check after the umbrella load (reals + `linarith` example) | **31.0 s** |
| Any later Mathlib check — *any* import combination, including headers never baked (e.g. `Nat.Prime.Basic` + `Topology.Basic` + `Order.Filter.Basic`) | **37–67 ms** |
| The same reals example compiled by importing its closure in-browser (strict-headers mode / no snapshot) | 313–348 s |
| Peak Memory64 heap with the umbrella resident | 3.01 GiB of 8 GiB max |
| App bundle (everything that isn't Lean) | 127 KB gzipped |

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
6. **Persistent compiles** — `lean_wasm_compile(sourceStr, nameStr)` against
   the fork's per-import-set environment cache. Output is claimed per compile
   through a swappable sink (Emscripten reads `print` handlers exactly once at
   startup). Diagnostics arrive as JSON lines with exact spans; classic
   `file:line:col:` text is parsed as a fallback. The IO result is decoded at
   the byte level: tag at +7, value at +8, tagged-scalar error count.
7. **Snapshots** — a baked `--incr-header-save` region (produced by the exact
   same binary under Node — its closure relocations are function-table-keyed)
   streams straight into the wasm heap and loads via
   `lean_wasm_load_snapshot_mem` (MEMFS + `lean_wasm_load_snapshot` as the
   fallback). The loaded
   environment seeds the fork's compile cache under the ordered header-import
   list recorded *inside* the snapshot, so a subsequent compile whose `import`
   lines match exactly reuses it instead of importing the closure.

### The snapshot tier (public/snapshots/ + src/runtime/snapshots.ts)

`public/snapshots/index.json` (schema `qed64.snapshot-index/v1`) maps each
baked snapshot to the ordered import list it was baked for. The app fetches it
at install time; `matchSnapshot` is an exact ordered-array match — no subsets,
because the runtime keys its environment cache by the precise import sequence.
Snapshots are gzip-served (`url` ends `.snapz`, `transfer` = wire size, `bytes`
= raw region size). The worker sniffs the gzip magic on the first chunk —
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

**The umbrella header rewrite** (src/runtime/umbrella.ts): a buffer whose
header names ≥1 Mathlib module, all inside the umbrella's closure, compiles
with its import lines rewritten to exactly `import QED64.Essential` (first
import line swapped, the rest commented — line and column positions are
preserved, so diagnostics need no remapping). The runtime's env cache is keyed
by the precise header, so after one umbrella load, every Mathlib buffer —
whatever its imports — is a cache hit and rechecks in milliseconds. This is
what makes arbitrary-import Mathlib editing fast: per-import-set snapshots
cannot be pre-baked for headers users haven't written yet.

Playground semantics caveat: under the rewrite, everything in the essential
profile is in scope regardless of which subset the header names (code may
elaborate here that would need more imports in a real project). Named imports
are still validated against the installed profiles, so nonexistent modules
error rather than vanish. Headers naming modules *outside* the umbrella
closure — core-only buffers included — compile as written, with exact import
semantics, via the normal import path.

A failed or missing snapshot degrades to the normal import path with the
header as written (the app just shows the first-compile explainer; it never
imports the umbrella's 4,821-module closure from oleans). Snapshots are
binary-paired: bake them with the *shipped* runtime via `npm run
bake:snapshot` (the bake script gzips and upserts `index.json`);
`pipeline/artifacts/unpack.mjs` reconstructs the olean tree the Node-side
bake mounts via `--lib`.

### What the load actually costs (profiled)

Every snapshot load prints its stage split to the worker log. For the
2.57 GiB umbrella: **region read + relocation walk ≈ 0.7 s; `[init]`
attribute replay over 152 modules ≈ 105–115 s (>99 %)** — the initializers
execute in the IR interpreter (top offenders: `ToDual` 11.0 s, `ToAdditive`
10.3 s, `Attr.Register` 7.1 s), and a measured shared-interpreter-cache
experiment showed the time is the work itself, not per-call overhead. The
replay streams `[WASM INIT] i/n module` lines through the otherwise-blocking
call, which the app renders as a live 152-step counter. Making the replay
fast needs upstream work (natively compiled initializers or interpreter
performance); a SharedWorker that outlives reloads would amortize it across
visits and is the highest-value follow-up.

### Snapshot cache and the preparation UX

The worker caches each snapshot's bytes in OPFS (`qed64-snapshots/<name>.<bytes>.<transfer>.snapz`,
written incrementally during the first download through a sync access
handle, committed by rename) and reads it back in 8 MiB slices on later
sessions — the 806 MB umbrella is downloaded once per browser, not once per
session (measured repeat-visit: 12 s to read + inflate 1.9 GiB from storage
versus a network download). Cache failures never fail a load.

Long preparation steps are rendered live (src/app.ts `prep` + the 1 s
ticker): the status pill reads "Preparing Mathlib… 1m 03s", the progress row
names the stage — *1 of 3 downloading/reading (bytes), 2 of 3 loading into
Lean (indeterminate; the worker posts a phase event before its one blocking
call), 3 of 3 first check* — with elapsed time and an honest estimate, and a
status card in the Messages panel replaces any stale diagnostics from the
previous check. The missing-Mathlib warning carries a one-click install
button. Usability-tested as a first-time user: click-to-✓ is ~2m20s on a
local server with every moment explained; repeat visits skip the download.

### Mid-session storage and runtime recovery

The storage behind a mounted pack can die while the session lives (HARDENING
lessons 16–17). A compile failure classified by `isStaleStorageError`
(src/runtime/errors.ts) triggers exactly one automatic recovery: drop every
installed profile, reinstall (a healthy OPFS cache revalidates with fresh
File handles in milliseconds; a dead one re-downloads), reboot the worker,
re-run the interrupted check. A second stale failure surfaces as an error
with reload guidance instead of looping.

Compiles that end in a runtime IO error get the same treatment through a
cheaper gate: the worker surfaces the runtime's actual stderr tail in the
message, and the app runs one trivial probe compile — a healthy runtime
keeps the session (the error was the buffer's), a poisoned one (observed
after ~10 h of idle) gets one automatic reboot and re-runs the interrupted
check (HARDENING lesson 22).

### wasm64 pointer discipline

Every i64-typed export parameter must be BigInt; returns are BigInt. The
worker normalizes at exactly two helpers (`asPtr`, `asNum` — the latter
range-checked below 2^53) and reads Lean objects only through `getValue`
(the build does not export the HEAP views).

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
