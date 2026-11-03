# EMBEDDING before v1: §10 and the §12 rows before `1.0.0`

This is §10 (the migration notes) of `docs/EMBEDDING.md`, and the rows of its §12
from before `qed64/embed` was declared final at `1.0.0` (2026-11-01, architecture
review D13). They moved here verbatim on 2026-11-03 (architecture review R9a), in
§12's own order, which is not strictly by date. They describe no current system
and are not updated: commits, line numbers, file paths, revisions and a row's
"below" are as they were on the day each was written. A §n other than §10 and §12
is a section of [EMBEDDING.md](../EMBEDDING.md) as it stood then. What is true now
is in that document, whose §12 goes on from the `1.0.0` row.

`docs/history/` is not in the package's `files`: this file is in the repository,
and a consumer reads it there at the commit it pins, not in `node_modules/qed64`.

---

## 10. Migration notes

**Widgets showcase (page tier):**

| Today | v1 |
|-------|----|
| seed `localStorage["qed64.buffer"]` | `?embed=1#code=…`, or `setDocument` on `qed64:frame-api` (keep the about:blank step between documents) |
| poll `status().phase` / a `notSession` predicate | `api.settled({version, afterSession})` |
| wrap `qed64.ui` / scrape `#boot` | `boot` events, `status().boot` (`overlay` for the card) |
| tap `relay.toClient` | `diagnostics`, `fileProgress` events |
| `relay.restart(relay.restartOpts)` | `api.restart()` (the relay's header rule included) |
| liveness probe through `relay.fromClient` | `status().liveness`, the `liveness` event |
| the `?mem` session wrap | `?memory=<GiB>`, `restart({initialBytes})`, `status().memory` |
| button-text matching for "Load exact imports" | `status().offer`, `acceptOffer()` (retired: `capabilities.offers` is false since 2026-11, review D1) |
| D1/D2 bridge | stand down completely on `capabilities.editorRpc` |
| D3 bridge (getWidgetSource) | stand down on `capabilities.widgetSourceCache` |
| scraping `wasm64-<hex>` from bundles | `dist/qed64-build.json` |
| renaming the overlay region to `mathlib` | any name with `roots` (§8); update C6, which asserts the refusal of `import HasseView` |
| `__qed64Bridge` expando | rename (`__qed64*` is reserved) |
| regex-parse `RESIDENT_ARGV` out of `lean.worker.js` (`scripts/headless/wasm-lsp.mjs`) | `import "<pin>/public/workers/worker-constants.js"`: `Qed64WorkerConstants.residentArgv(opts)`, `_lean_init_task_manager_using(leanWorkers(n))`, `LEAN_WASM_PARKED_DEDICATED = PARKED_DEDICATED` at preRun (R3) |

- From a pin at or after plan step A3c, `lean.worker.js` no longer carries a
  `const MEMORY64_PROBE = new Uint8Array([…])` literal: the bytes live in
  `public/workers/memory64-probe.js` (§7.0). `scripts/check-gallery.mjs`
  (the block that compares `gallery/lib.js` `MEMORY64_PROBE` with the active
  pin's probe, a G1 gate through `deploy-manifest.mjs`) must read them from
  `<pin store>/public/workers/memory64-probe.js` instead, or it prints a FAIL
  and exits 1 at the bump. Either run the file in a fresh context and read
  the global it publishes:

  ```js
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(store, "public/workers/memory64-probe.js"), "utf8"), ctx);
  const wbytes = Array.from(ctx.Qed64Memory64.MEMORY64_PROBE);
  ```

  or `await import(pathToFileURL(<that path>))` and read
  `globalThis.Qed64Memory64.MEMORY64_PROBE`. Serving needs no change: the
  showcase serves QED64's `dist/workers`, which has the file.

**lean4game (library tier):**
- Done in lean4game 00bf77e (2026-10-05, `wasm64-port`): the vendored copies
  and `sync-qed64.sh` are deleted; it imports from `qed64/embed` and stages
  the workers from `closure.json`.
- Until then (history: that lane is retired), a `sync-qed64.sh` pin at or
  after plan step A3c had to name `public/workers/memory64-probe.js` at
  every by-name site of the vendored lane (branch `wasm64-port`), or the
  game broke in one of two ways:
  - `scripts/sync-qed64.sh` `PATHS` had to vendor it. The vendored
    `src/runtime/client.ts` had a bare `import
    "../../public/workers/memory64-probe.js"`, so without the file the
    client build failed (the script's own sanity regex, which matched only
    `from "…"` and `import("…")`, did not see a bare `import "…"`).
  - `scripts/stage-workers.sh` had to copy it into `client/public/workers`
    beside `lean.worker.js` (for example guarded like `lsp-frames.js`: when
    `lean.worker.js` contains `importScripts("memory64-probe.js")`, require
    the file and copy it). `lean.worker.js` loads it eagerly, so a vendored
    but unstaged file was a 404 and every session died `WORKER_DEP_MISSING`
    at script load.
  - `scripts/deploy-app.sh`'s required-files list and
    `client/src/wasm/game-boot.ts` `WORKER_SCRIPTS` (the reboot preflight)
    had to name `/workers/memory64-probe.js` for the deploy check and the
    preflight to catch a missing copy. Replacing those fixed lists with
    closure.json `workers` / `WORKER_URLS` removes the by-name sites.

  Staging from `closure.json` (the package lane: branch `qed64-dep` then,
  `wasm64-port` since 00bf77e) picks the file up with no change.
- From a pin at or after plan step A7 the library lives in `lib/` and
  closure.json `entry` is `lib/index.ts` (§6, §12). The package lane
  (`qed64-dep`, `lean-v4.34`) changes two places at that bump:
  - `client/tsconfig.json`'s `paths` entry for `qed64/embed` becomes
    `../node_modules/qed64/lib/index.ts`. The old
    `frontend/src/embed/index.ts` was a one-cycle shim and is deleted (§12),
    and `scripts/stage-workers.sh` compares the entry with closure.json
    `entry` by real path and refuses the old one.
  - `client/src/wasm/game-translation-guard.test.ts` imports
    `frontend/src/embed/edit-coalescer.ts` by file path: point it at
    `lib/edit-coalescer.ts` (lean4game's `wasm64-port` does).
- Route URL overrides through `validateBootOverrides` (lean4game keeps its
  own parser; `parseBootParams` is internal since `1.0.0-pre.5`) and boot
  with `installArtifacts(ui, {overrides, profiles: "none"})` or the exported
  resolvers.
- Replace `GameSession` with `files`.
- Replace the label regexes with `stage`/`subject`/`error`.
- Replace the D4 inference with `Death.cause` (null = no evidence;
  `WORKER_SCRIPT_LOAD_FAILED` = probe), keyed on `Death.seq`.
- Replace `prefetchRawSnapshot` and the claim/wait machinery with
  `prefetchRaw({onBusy: "wait"})`.
- Replace the raw-cache helpers and the offline-URL builder with the exports.
- Use `rearm()` instead of a synthetic didChange, and `error.data.qed64`
  instead of message matching.

---

## 12. Changes since the draft (daf9b63)

- **Widgets review:**
  - liveness projection and event;
  - restart inputs and result; `settled({afterSession})`; superseded
    statuses dropped;
  - cursor, focus, offer, memory (`?memory=`, `restart({initialBytes})`),
    `boot.overlay`;
  - fileProgress on a 100 ms timer;
  - `#code=` read-once and on the plain page, with `setDocument` outranking
    it;
  - named overlay-index failures, the widget-source cache, the test hatch,
    `dist/qed64-build.json`, page-tier facts, hosting facts, and the
    late-install note fixed.
- **lean4game review:**
  - packaging: `build` → `build:all`, the pacote list, `sideEffects`, Node
    and pipeline notes, `runtime.minKernelPatch`;
  - causes:
    - the `missing` kind and `httpStatus`;
    - null meaning no evidence, and `WORKER_SCRIPT_LOAD_FAILED`;
    - loader≠0 and not-in-index causes;
    - causes on boot-time worker deaths;
    - `exitCode`, `seq`/`session`, `error.data.qed64`, `rearm()`;
  - the raw cache: single-flight, cross-tab lock, cleanup, units, helpers,
    same-origin;
  - installs: the `profiles` option, pre-resolved inputs, the exported
    resolvers;
  - workers: the revision stamp, the `requests` flags, recoverable unknown
    requests, the protocol ledger, the definition of a release.
- **Item 4:** overlay environments (§8).
- **Branch review (after 90aef68; 36 confirmed findings, all fixed):**
  - page API: `setDocument` resolves on the coalesced forward; a boot
    failure is kept for later callers (a mount failure included); `settled`
    resolves with its own status; `restart()` without `initialBytes` resets
    the commit; liveness clocks are per session; payloads are copies; a
    verdict the self-widen supersedes finishes no boot;
  - the self-widen is stateless, never widens for a refuted root claim or
    an Init typo, and ignores header modules no root names (§8);
  - raw cache: `busy` is the lock's own answer (`ifAvailable`), per caller;
    no worker after the last caller leaves;
  - causes on every boot failure (pack, `files()`, `beforeArm`, arm);
    subclass-safe private members; `status().memory` reports the commit
    made; a lazy front door that fails to load is `WORKER_DEP_MISSING`; the
    prefetch worker's compressed-only mode is removed;
  - relay: each orphaned request is answered once and a restart issued
    while they go out is refused; the test hatch (revision 0.1.1) cancels a
    timed-out request and keeps swallowing its reply;
  - build and CI: `qed64-build.json` only from a successful build; CI
    installs the frontend before the unit step; release-manifest's
    `--worktree --dist` dirty flag counts the workers; node-runner keeps the
    first value of a repeated flag, as documented.
- **After the branch review (fd6c2ae and later):**
  - the boot card's checklist follows every deliberate replacement
    (`frontend/src/boot-checklist.ts`), and only a serving status arms the
    check fallback (a pre-serve failure keeps its card);
  - `ResidentSession` coalesces full-text didChanges (§7.8,
    `editCoalesceMs`), after lean4game's editor crash: an edit per keystroke
    over work that ignores cancellation grew the pthread pool until V8 ran
    out of memory (HARDENING #59);
  - the coalescer holds changes for the worker's pool (§7.8
    `editBackPressure`, the page's `?edithold=`, §4), after the stock page
    crashed typing at a normal pace above an uncancellable command with the
    InfoView open (HARDENING #59 addendum).
- **Packaging surface (plan step A2, 2026-10-06):**
  - `exports["./edge"]` → `infra/edge-worker.js` with its types, shipped in
    `files` and listed as closure.json `infra`; `createWorker` gains
    `assetHeadLength` (a HEAD on a static asset carries the GET's
    `Content-Length`; hardened default on, `QED64_LEGACY` off).
  - every Tier 1/2 CLI of docs/CLI-CONTRACT.md ships (`cli.mjs` and its
    types, `supervised-run.mjs` added to `files` and closure.json
    `pipeline`); preflight moved to `pipeline/release/preflight.mjs` (shim at
    `tests/adversarial/preflight.mjs`) and ships with
    `pipeline/release/page-target.mjs`.
  - `MEMORY64_PROBE` exported (from `src/runtime/client.ts`, re-exported by
    `qed64/embed`; `probeMemory64` validates it; a unit test pins the
    worker's copy to it); `EMBED_API_REVISION` → `1.0.0-pre.3`.
  - `npm run test:consumer` (G2): every export resolved from the packed
    tarball by Node, and a fixture page (`qed64/embed`) and Worker
    (`qed64/edge`) type-checked and built with Vite against it; the
    shipped CLIs (preflight, olean-imports, `cli.mjs`) run `--help` through
    the consumer's `node_modules/qed64` symlink.
- **lean4game's contract additions (plan step A2b, 2026-10-06):**
  - `ResidentHost.busyWaitMs` (§7.3): the bound on each boot's wait for
    another tab writing the same raw region, passed to the prefetch as its
    `busyWaitMs` (default unchanged, `PREFETCH_SILENCE_MS`);
    `loadSnapshotByName` gains the same option (`LoadSnapshotOptions`, a
    fifth argument).
  - `LspRelay.clientPort` and `LspRelay.unload()` named as contract members
    (§7.9, with `status()`, `rearm()` and `restart()`); no behaviour change.
  - **A new `FailureKind`, `stale`** (§7.2): a `WORKER_DEP_MISMATCH` death
    (the site was deployed under the page) was `other` with that code and
    is now `stale` with the same code, from `failureKindOf`,
    `failureCauseOf` and `deathCause` alike; the refusal's uncaught error
    event, which carries its words but no code, is `stale` too (it was
    `WORKER_SCRIPT_LOAD_FAILED` before the hello, `other` after). A `stale`
    cause's `code` is always `"WORKER_DEP_MISMATCH"`: `failureCauseOf` sets
    it, as `deathCause` does, also for a value that carries the words under
    another code (a `WORKER_CRASHED` rejection when that event reaches
    `LeanSession` first) or none. Migration:
    a `switch` over `FailureKind` gains a case; code keyed on
    `cause.code === "WORKER_DEP_MISMATCH"` keeps working, while code that
    asserted `kind: "other"` for it must expect `stale`.
    `WORKER_DEP_MISSING` is unchanged (`WORKER_SCRIPT_LOAD_FAILED`).
    `WORKER_DEP_MISMATCH` is exported. The stock page shows a standing
    Reload button for it; the page API's `death` event and a halted boot's
    `boot.error` carry it. `EMBED_API_REVISION` → `1.0.0-pre.4`.
- **The barrel's surface (plan step A2c, 2026-10-06):**
  - removed from `qed64/embed`: `storageEstimate` (the function is deleted:
    nothing called it) and `UMBRELLA_ROOTS` (now module-private; the
    exported `isUmbrellaModule` reads it). Neither consumer, the stock page
    nor any test imported them (checked with grep over this repo, lean4game's
    qed64-dep branch and its bump worktree, and the showcase).
  - marked `/** @internal */`, still exported: `installProfile`,
    `ensureProfile`, `fetchProfileIndex`, `parseBootParams`, `overridesOf`,
    `NO_OVERRIDES`, `memoryCandidates`, `rawRegionName`, `httpStatusOf`,
    `failureKindOf` and `isImport` (§7.0 listed the contract member to use
    instead; since `1.0.0-pre.11` the R9a row below does). Every name
    lean4game imports through the barrel stays in the contract;
    `tests/unit/embed-barrel.test.ts` pins both lists.
  - the stock page (`frontend/src/main.ts`) imports the library surface
    from the barrel instead of deep paths: it is the barrel's first
    consumer. No behaviour change.
  - `dist/qed64-build.json` gains `embedApiRevision` (the barrel's
    `EMBED_API_REVISION`; an additive key: `qed64.build/v1` readers ignore
    it). `EMBED_API_REVISION` → `1.0.0-pre.5`.
  - docs only: §5 and §6 describe the two consumers as they hold QED64
    (lean4game: the git dependency and `qed64/embed`; the showcase: the
    submodule, the framed shell, the CLIs and the edge code), and §6.1 is a
    minimal Vite consumer with and without the editor, whose headless boot
    is `tests/consumer/fixture/headless.ts`, type-checked and built against
    the packed tarball by `npm run test:consumer` (G2).
  - review fixes, docs and G2 only: §4's `qed64-build.json` key list names
    `embedApiRevision`; §6.1 step 2's Vite config sets `build: { target:
    "es2022" }` (the (a) block uses top-level `await`, which Vite's default
    target refuses at `vite build`), and G2 now extracts the (a) block
    verbatim from the packed document and type-checks and builds it beside
    the fixture; §6.1 step 1 gives the `paths` alternative to
    `moduleResolution: "bundler"`; §7.0 names `installArtifacts` as the
    wrapper of the profile index and boot packs.
- **Explicit pipeline paths (plan step A3a, 2026-10-06):** no library change:
  `qed64/embed`, the workers and `EMBED_API_REVISION` are untouched. §6's note
  on the pipeline scripts names the path rule of docs/CLI-CONTRACT.md
  (contract 2): flag, variable, a deprecated default with one WARNING, else
  exit 2; the sibling-checkout fallback is gone, and
  `pipeline/toolchain/artifact-paths.mjs`, already in `files` and closure.json
  `pipeline`, now also carries the rule and the `--stack-size` re-exec.
- **Fetching the artifacts (plan step A3b, 2026-10-06):** no library change:
  `qed64/embed`, the workers and `EMBED_API_REVISION` are untouched. The
  package gains one tier-1 CLI, `pipeline/release/fetch-artifacts.mjs` with
  its `.d.mts` (in `files` and closure.json `pipeline`; 52 files), which
  fills a `public/`-shaped tree with the bytes the tracked manifests pin
  (§6's note: the manifests themselves are not in the package, so a consumer
  passes `--manifests`). G2 runs its `--help` through the package symlink and
  checks that refusal.
- **The A2 follow-ups both consumers asked for (plan step A3c, 2026-10-06):**
  - `pipeline/release/preflight.mjs` refuses instead of crashing when its
    boot smoke cannot start: a `playwright` that does not resolve from the
    package (the caller's install) is `PREFLIGHT REFUSED: boot smoke:
    playwright not resolvable from the caller (ERR_MODULE_NOT_FOUND)`, exit 3
    (it was an uncaught rejection, exit 1); `pipeline/release/preflight.d.mts`
    (shipped) types `runPreflight`, `bootSmoke` and `main`
    (docs/CLI-CONTRACT.md changelog). No library change.
  - **One source for the Memory64 probe** (§7.0): `public/workers/memory64-probe.js`,
    a classic script carrying the workers' `REVISION`, publishes
    `globalThis.Qed64Memory64`. `lean.worker.js` `importScripts` it eagerly
    (beside `lsp-frames.js`; a copy of another revision is
    `WORKER_DEP_MISMATCH`, a missing one `WORKER_DEP_MISSING`) and drops its
    own literal; `src/runtime/client.ts` imports it for its side effect and
    re-exports `MEMORY64_PROBE` and `probeMemory64` from it (same bytes,
    same check, no API change). The file is in `files`, closure.json
    `workers` (`/workers/memory64-probe.js`) and `WORKER_URLS`, so
    `runtimeUrls().workers` has five entries. `package.json` `sideEffects`
    becomes `["./public/workers/memory64-probe.js"]` (it was `false`, under
    which a bundler drops the import). The worker protocol revision stays
    `"1"` (§7.7 "What changes the revision"). A consumer that copies
    closure.json `workers` needs no change; one that lists the scripts by
    name adds the file at every such site (§10: lean4game's vendored lane
    names it in `sync-qed64.sh`, `stage-workers.sh`, `deploy-app.sh` and
    `game-boot.ts`). `lean.worker.js` no longer has a `MEMORY64_PROBE`
    literal, so a consumer that parses it out of that file reads
    `memory64-probe.js` instead: from a pin at or after A3c the showcase's
    `scripts/check-gallery.mjs` probe comparison must take the bytes from
    `public/workers/memory64-probe.js` (§10 has the recipe), or its G1 gate
    fails. `EMBED_API_REVISION` → `1.0.0-pre.6`.
  - G2 (`npm run test:consumer`) also checks, from the extracted tarball:
    importing `qed64/workers/lsp-frames.js` publishes
    `globalThis.Qed64LspFrames` and `qed64/workers/memory64-probe.js`
    publishes a frozen `globalThis.Qed64Memory64` (the 13 bytes, a probe
    that validates on Node, the ledger's revision);
    `qed64/pipeline/toolchain/artifact-paths.mjs` exports
    `buildIdOfArtifact` (run on a stand-in `lean.wasm`); every path
    closure.json lists is in the tarball; and the fixture's built page still
    sets `globalThis.Qed64Memory64` (it fails under `"sideEffects": false`).
  - docs only, after lean4game's bump found a plain build serving the
    previous pin's `lean.worker.js`: §6 and §6.1 step 3 say that copied
    workers are re-staged before every build and dev start (a `prebuild` /
    `predev` example), and what the run-time check does and does not catch
    (`WORKER_DEP_MISMATCH`, kind `stale`, for scripts of two revisions; not
    for a whole set from the previous pin). G2 runs step 3's script from the
    packed document over a stale set.
  - review fixes, no library change: §10 lists every consumer site the
    probe's move touches (the showcase's `check-gallery.mjs` comparison, and
    lean4game's vendored lane: `sync-qed64.sh`, `stage-workers.sh`,
    `deploy-app.sh`, `game-boot.ts`); preflight's refusal is always one
    stdout line and names a missing dependency of playwright instead of
    calling playwright unresolvable (docs/CLI-CONTRACT.md changelog).
- **An unpaired snapshot refused early (HARDENING #62, 2026-10-06):** the
  page compares an index entry's `runtime` with the runtime manifest's
  `buildId` before it spends anything on the snapshot (§7.2).
  `ResidentSession.start()` rejects `snapshot '<name>' failed to load` with
  the `unpaired` cause (`code: "SNAPSHOT_UNPAIRED"`, `stage: "snapshot"`)
  when a snapshot it loads before opening is unpaired, before a pack
  install, the runtime boot and any snapshot fetch; `loadSnapshotByName`
  refuses such an entry before the raw prefetch, with the same `lastFailure`
  and progress call the worker path makes. The relay's `Death`, the page
  API's `boot` and `lastDeath` and the boot card are as before; no console
  line is added, and the relay and its breaker are unchanged (each of the
  three retries now costs no runtime and no download). The halt comes about
  3 s after the relay is constructed, often before the language client sends
  `initialize`: the client's `initialize` may then be answered with the
  breaker's "QED64: checker halted after repeated crashes" error instead of
  "QED64: the Lean checker died (bootFailed)", and the died line may appear
  fewer than three times or not at all (both shapes were already the
  relay's, and the showcase's C9 allowlists both). An entry without
  `runtime` is not refused by the page. The cause's message says "this page
  runs runtime <id>" where the worker's says "this worker booted <id>"
  (classify by `kind`/`code`, never by the words). No export changes:
  `EMBED_API_REVISION` stays `1.0.0-pre.6`.
- **A network failure costs no runtime per retry (HARDENING #63,
  2026-10-07):** the pre-open snapshot download came strictly after the
  runtime boot (`LeanSession.boot`, then per snapshot the raw prefetch and,
  when it failed, the checker's own stream), so each relay retry of a
  lasting cut booted a runtime that died at its first snapshot. Now
  `ResidentSession.start()` remembers a `network`-kind boot failure for
  every snapshot it loads before opening (raw-cache.ts module state, per
  cache key, 60 s), and a later session of the page downloads each
  remembered snapshot with the raw prefetch before a pack install and the
  runtime boot (`downloadBeforeBoot`, lib/qed64-boot.ts): a download that
  fails with a `network` cause rejects `start()` with `snapshot '<name>'
  failed to load` and that cause before any runtime exists; a completed
  download or load clears the memory; a cached region is probed first and
  shows no label, and a pre-boot prefetch that cannot decide (silence,
  another tab, a non-network error) is not run again by the boot's load
  (the checker streams it at once). The step's progress label carries
  `loaded: 0`, `total` and `unit: "bytes"`, so it never has the shape of the
  "waiting for another tab" call (`step: "download"` without `loaded`). A
  first attempt, a cached snapshot
  and a memory older than 60 s boot as before, and a single cut is still
  absorbed with 0 deaths. The relay, its breaker, the `Death` projection
  and the console lines are unchanged; a lasting cut now shows the same
  three `bootFailed` deaths and the halt after one runtime start. The
  pre-boot download makes one request per session (no retry layer of its
  own: the relay's reboots are the retries). No export changes (the new
  raw-cache and qed64-boot functions are not in the barrel):
  `EMBED_API_REVISION` stays `1.0.0-pre.6`.
  Follow-up (2026-10-08, the browser lane): a `.snapz` body that ends
  cleanly short of its announced size (Content-Length, or without one the
  index's `transfer` for a gzip body, in both streams) is now `network`
  with the message "the
  transfer of <file> ended early: received <n> of <expected> bytes", not
  `corrupt` from the decoder's "Compressed input was truncated."; so the
  rule above fires for that shape of a cut too. A body that arrived in full
  and fails the decoder stays `corrupt` (§7.2). The prefetch worker's
  request and `loadSnapshot`'s input each gain an optional `transferBytes`
  (`LeanSession.loadSnapshot`'s optional 6th argument; `loadSnapshotByName`
  passes the entry's `transfer`), additively as §7.7 allows: an older
  worker ignores the field, and without it a worker checks the
  Content-Length only. The worker revision, `PROTOCOL` and the closure's
  `requests` are unchanged. A clean short end changes
  the prefetch warning's text after "raw prefetch error: " to that message
  (a transport error keeps "network error").
- **The indexes are pinned like the runtime manifest (HARDENING #64,
  2026-10-08):** the upload of a new pairing replaced the mutable
  `/snapshots/index.json` and `/profiles/index.json` while the deployed shell
  still booted the previous runtime, so every new visit in that window read
  snapshot entries baked for the next runtime and failed `SNAPSHOT_UNPAIRED`
  until the deploy. A shell with a pinned buildId (`__QED64_BUILD_ID__`)
  still reads the mutable paths first; when one names another runtime, it
  reads that buildId's copy, `/snapshots/index.<buildId>.json`
  (`fetchSnapshotIndexFor` without an overlay) or
  `/snapshots/profiles-index.<buildId>.json` (`installArtifacts` without
  `?profiles=`), and uses it unless it answers a 404, HTML, a network error
  or a body that is not an index (§4, §7.6). A paired index costs no extra
  request, so a site that does not publish the copies (the showcase's,
  lean4game's) sees none and no 404; without a pinned buildId nothing
  changes. `qed64/edge`'s `isImmutable` now calls
  `…/index.<x>.json` and `…/profiles-index.<x>.json` revalidating (they
  carry a 16-hex buildId, which the digest rule alone made immutable, also
  for a 404); every other path keeps its rule. No export or type changes:
  `EMBED_API_REVISION` stays `1.0.0-pre.6`. A site that takes its cache
  rule from the fork's `formats/HOSTING.md` rule 8 (its `isImmutable`
  snippet, or its Python reference server's `MUTABLE`) still has the old
  `/\/index\.json$/` and serves both copies `immutable` for a year: that
  text is the fork owner's to update (relay in HARDENING #64); import
  `qed64/edge`'s `isImmutable` instead of copying it.
- **The pinned snapshot index for direct callers (HARDENING #64
  follow-up, 2026-10-08):** lean4game's game boot reads the snapshot index
  with `loadSnapshotIndex()` itself (its `?snapshots=` overlay goes through
  `fetchSnapshotIndexFor`, which needs nothing), so the shell-side rule
  above did not protect its site; it adopts the option as
  `loadSnapshotIndex(undefined, { pairedBuildId })`, which keeps the throw
  its SEC1 off-site refusal catches (`fetchSnapshotIndex` would turn that
  into null). `loadSnapshotIndex` and `fetchSnapshotIndex` gain the
  optional `IndexOptions.pairedBuildId` (§7.0): a mispaired index is
  replaced by `index.<pairedBuildId>.json` from the same directory when that
  copy is an index whose entries are all paired with `pairedBuildId`;
  anything else keeps the index as read, and the `SNAPSHOT_UNPAIRED`
  refusal applies as before. Without the option the requests and results
  are exactly as before. `fetchSnapshotIndexFor` and `installArtifacts` now
  go through it (one implementation, `pairedCopyOr` in `lib/snapshots.ts`,
  internal, also used for the profile index's copy), which tightens the
  shell's rule by one case: a copy that is itself mispaired, mixed or empty
  is no longer used (it keeps the mutable index). The option is half of
  the adoption: a site must also publish `snapshots/index.<buildId>.json`
  derived from the index it SERVES (§4), or the copy request is a 404 and
  the mutable index is kept. `bake-snapshot` writes the copy beside every
  index it upserts (docs/CLI-CONTRACT.md changelog), but that is the
  staging index: it suits only a consumer that serves its staging dir
  unmerged, not one that merges staged entries into its served index
  (lean4game's `stage-snapshots.py`), which derives its copy from the
  merged index.
  Additive (a new optional field), so `EMBED_API_REVISION` → `1.0.0-pre.7`.
- **A rejected pinned runtime-manifest fetch is a miss (HARDENING #65,
  2026-10-08, reported by lean4game):** `resolveRuntimeManifest` fell back
  to the mutable `/runtime/runtime-manifest.json` when the pinned copy
  answered a 404 or HTML, but a pinned fetch that REJECTED (a site without
  the copy behind a refusing proxy, a dead link while `navigator.onLine` is
  still true) failed the boot, though the mutable manifest (or a service
  worker's cached one) would have served. A rejected fetch or body read of
  the pinned copy is now a miss like a 404; when the mutable fetch fails
  too, the boot fails with its error, a `network` cause, as before. A
  pinned copy that answers a manifest breaking the runtime/v1 invariant is
  still refused, not replaced. No export or type changes:
  `EMBED_API_REVISION` stays `1.0.0-pre.7`.
- **The engine-stack probe size, interim (HARDENING #67, 2026-10-09,
  reported by the widgets showcase):** kernel patch 0036's stack guard
  reserved 128 KiB of a Chrome Worker's stack, so proofs needing about
  370-500 KiB that checked on earlier runtimes got "stack is exhausted".
  `lean.worker.js` now sets the runtime's `LEAN_WASM_STACK_PROBE_SLOTS` to
  8192 (64 KiB) at preRun: in Chrome, `decide` over `Fin 20` and `Fin 22`
  check again, `Fin 24` still does not (the depth-based stack probing
  planned for the kernel's patch 0038 was to fix it; not pursued since
  2026-10-12, #71 below), and over-deep proofs still end in Lean's error
  with the checker alive.
  No export, type or worker-revision change: `EMBED_API_REVISION` stays
  `1.0.0-pre.7`, the four worker scripts keep `REVISION` "1". A page that
  stages QED64's workers gets it with the pin.
- **A replacement waits for its own predecessor's Workers (HARDENING #68,
  2026-10-09, reported by the widgets showcase):** `LeanSession.dispose()`
  records its runtime id (lib/client.ts module state: the last 4, for 10 s),
  and every later `boot` in the same document names them in the boot
  message's `instance.predecessors`, never itself. The worker then waits,
  within the same 6 s budget, until no Worker of a named runtime is alive;
  other stopping runtimes keep #55's tolerance of 12. A document's first
  runtime names none, so a reload is unchanged; a relay restart or reboot
  allocates about 0.25-0.5 s later, a heartbeat-loss reboot about 2 s later
  (estimates until the restart-overlap lane measures them). The field is
  additive and advisory: an older worker ignores it and keeps the
  tolerance, and the worker reads a missing or malformed field as none and
  never fails a boot over it. The `[boot] waited` console line gains a LAST
  suffix, "; a → b of them replaced by this page", only when a named
  runtime was alive; its start and the " — budget spent" group are
  unchanged. An embedder that drives `LeanSession` directly gets it too,
  and one that boots a replacement right after `dispose()`, without the
  relay's 1.5 s settle, waits up to about 2 s for the predecessor's busy
  threads (within the 6 s budget); a
  second module copy of lib/client.ts in one document keeps its own list,
  so its replacements keep the tolerance, as before. No API change:
  `EMBED_API_REVISION` stays `1.0.0-pre.7`, `PROTOCOL` and the four worker
  scripts' `REVISION` "1" are unchanged.
- **A thread budget (HARDENING #69, 2026-10-10, found by the kernel):**
  the worker builds Lean's task manager with min(hardwareConcurrency, 8)
  workers (4 when the host does not say) instead of the core count, and
  keeps up to 4 finished dedicated threads parked for reuse; a
  `[boot] task manager: n worker(s)` console line records it. On hosts
  with more than 8 cores, standard-thread parallelism is capped at 8.
  No API change.
- **Synchronous elaboration (HARDENING #70, 2026-10-10):** the resident
  loop starts Lean with `-DElab.async=false`. Under Lean's default,
  every blocked theorem task started a thread that never exits, and a
  document of ~20 Mathlib theorems crashed the tab. Theorems now
  elaborate and check in order on the command's own task. A document's
  messages and diagnostics are the same; measured settle times are equal
  or shorter. Proofs deep enough to be near the browser's stack limit fail
  about one step earlier, with Lean's "stack is exhausted". A document can
  opt back in with `set_option Elab.async true`, at its own risk. No API
  change. An embedder whose own Lean code elaborates tactic blocks and runs
  linters on them should test under this setting: lean4game's `Runner`
  (its levels' tactic checker) had its linters flag every tactic, so that
  no correct proof completed on 8 of 10 games, until it set
  `set_option Elab.async true` on the `Runner` line of its worker document
  (reported by the lean4game session, 2026-10-23, on QED64 73d7f3b).
- **The engine-stack probe size is the runtime's own again (HARDENING
  #71, 2026-10-12):** `lean.worker.js` no longer sets
  `LEAN_WASM_STACK_PROBE_SLOTS` (#67's interim 8192 let heavy tactic
  recursion kill the FileWorker on two proof sheets). Kernel patch 0036's
  default 16384 applies: deep but legal proofs get Lean's "stack is
  exhausted" a little earlier (`decide` over `Fin 18` and up), and the
  widgets showcase's deepest DistLens examples fail. QED64 does not tune
  the guard; deaths are handled by #72. No API change.
- **A stack-overflow death pauses checking (HARDENING #72, 2026-10-12):**
  a Lean thread that ran out of the browser's engine stack reached the page
  as "Uncaught [object ErrorEvent]", classified as an ordinary `crash`, and
  the relay rebooted into the same death until its breaker halted. The
  worker now dies once in words `deathCause` classifies as `code:
  "ENGINE_STACK_OVERFLOW"`, and the relay pauses at once (no reboot, not
  counted toward the breaker, `stats.stackPauses`) with its own note (that
  code, on the new optional `FailureCause.line`) and reply (`reason: "stack
  limit"`, a new text still prefixed `QED64:`: console allowlists keyed on
  the breaker's text need it); any edit resumes. The contract is in §7.2.
  No new relay state or status field: a page that ignores the code sees a
  halt it words as the breaker's. The stock page's pill says "paused — Lean
  ran out of the browser's stack; edit the file to check again", never the
  boot-failure card. Additive (a new export, one optional field on the
  shared `FailureCause`), so `EMBED_API_REVISION` → `1.0.0-pre.8`; the
  page API's `API_REVISION` and `capabilities` are unchanged (no new method
  or event; `death.cause` and `status().lastDeath.cause` may carry `line`),
  and so are the worker's `PROTOCOL` and `REVISION` (an older page reads
  the `died` event as an ordinary crash).
- **A lost shell chunk during a deploy is `stale` (HARDENING #74,
  2026-10-16):** a page booting while a deploy replaced `/assets/` lost its
  lazily imported chunk; the browser's "Failed to fetch dynamically imported
  module: …/assets/…" (Firefox: "error loading dynamically imported module")
  was classified `network`. `failureKindOf` and `deathCause` now return
  `stale` for those words when the URL is under `/assets/`, with code
  `WORKER_DEP_MISMATCH` as every stale cause (§7.2); the stock page's boot
  card says "this page's own files could not be loaded, probably because
  QED64 was updated while it was open — reload to continue", the browser's
  words as its title. The words do not say why the fetch failed: a
  connection cut during that import reads `stale` too (accepted: the module
  map keeps a failed fetch for the document, so a reload is right for both).
  A module whose URL has no `/assets/` segment stays `network`; `/assets/`
  is Vite's default `assetsDir`, so a Vite-default embedder that classifies
  such an error through `failureCauseOf` is covered as well. A
  classification change only:
  no export, type or revision change (`EMBED_API_REVISION` stays
  `1.0.0-pre.8`).
- **`installProfile` no longer waits for `navigator.storage.persist()`
  (HARDENING #75, 2026-10-16):** in Playwright Firefox 153 the awaited
  `persist()` never settled, so the stock page's install sat at the first
  pack (Firefox prompts for persistent storage; the wait on the prompt is
  inferred; an embedder calling `installProfile` in Firefox was exposed the
  same way, by the code path, not measured). The ask is still made,
  fire-and-forget; a denied request is best-effort storage as before. No API
  or revision change.
- **`status().memory` is requested when the relay enters `ready` (HARDENING
  #76, 2026-10-16):** the stock page fed the projection only from its 12 s
  heap-meter interval, so on a runtime that is ready in a few seconds
  `currentBytes`/`maximumBytes` read null until that tick (an embedder
  reading `status()` within ~12 s of ready saw nulls; the showcase's C3,
  about 9 s in, did). The page now also requests the worker's telemetry when
  the relay enters `ready`, so the numbers arrive one worker round-trip
  (milliseconds) later; a `ready` listener or a `settled()` continuation that
  reads `status()` synchronously still sees the previous value (null for a
  new session, as §status's contract says): read it on a later turn. No API
  or revision change.
- **A session that dies before its first heartbeat is a death (HARDENING
  #78, 2026-10-18):** `LeanSession`'s heartbeat-loss watchdog now runs from
  the moment the worker accepts `arm()`, not from the first beat (about 2 s
  after the loop opens), so a Worker that dies or whose JS thread stops in
  that window is reported dead (`reason: "heartbeat"`) and the relay
  reboots, where before the page kept showing `ready` with nothing checking
  (a Lean-side wedge is still reported `wedged`). The rule is the documented
  one (6 s without a beat, then a telemetry probe unanswered for 2 s); a
  booting worker is still never probed. A direct `LeanSession` user must keep
  `arm()` the last runtime step: a `compile` or `loadSnapshot` after it
  blocks the worker and now reads as heartbeat loss. `EMBED_API_REVISION`
  stays `1.0.0-pre.8`: no export, type or event changes, and `heartbeat` was
  already a documented `rebootReason` and `DeathInfo.kind` (§2.2); this makes
  the implementation keep that contract in the window.
- **Share links on the plain page (HARDENING #77, 2026-10-16):**
  `codeFromHash` accepts lean4web's `#codez=` beside `#code=` through a
  vendored LZ-string port (`frontend/src/lz-string.ts`, MIT, no npm
  dependency; padding tolerated, the URI-safe alphabet recognised, `code`
  outranks `codez`, the 2 MiB cap enforced before the text is built), and a
  top-level `#code=`/`#codez=` page opens the fragment behind the consent
  gate of §3.1 (`#sharedlink`: Open calls `setDocument` and switches that
  load's persistence off; Dismiss drops the fragment) instead of logging that
  it ignored it. A framed same-origin page and embed mode behave as before,
  except that `#codez=` now decodes there too; a page without a fragment
  builds nothing new. §4 gains the `#codez=` row, §5's backlog loses it,
  §11's note names the gate. Page tier only: no new query parameter, event
  or method, so `API_REVISION` stays `1.0.0` and `EMBED_API_REVISION` stays
  `1.0.0-pre.8`; `qed64/embed` and the workers are untouched. Tests:
  tests/unit/lz-string.test.ts, tests/unit/page-api.test.ts, and the e2e
  corpus's `shared-link-gate` and `boot` (docs/TESTING.md). Follow-up
  2026-10-18: Open no longer stores the default example on a first visit
  (it flushed the save debounce even with nothing pending); the scenario
  now runs a first visit and a saved-buffer visit. Second follow-up the same
  day (the owner's report): a link pasted into an already open plain page
  shows the panel (`hashchange`; it reloaded nothing before), the panel is
  centered with the page dimmed, and a browser without a working shared
  Memory64 (`CAPABILITY_MISSING`) gets a boot card naming desktop Chrome and
  Firefox (iOS browsers are all WebKit).
- **A pack manifest of another release is refused as `stale` (HARDENING
  #81, 2026-10-25):** `installProfile` compares the fetched manifest's
  `content.release` with the profile index entry's `release` and, when they
  differ, throws before a part is fetched or the pack cache is read
  (`code: "WORKER_DEP_MISMATCH"`, cause kind `stale`, the message naming
  both releases). A manifest's URL is the same in every release
  (`/profiles/<pack>.manifest.json`), so a page loaded before a deploy would
  otherwise install the next release's oleans under its own runtime, which
  misreads them. An entry that names no `release` is not checked. A stock
  page that hits it (an on-demand pack install, or a session restart that
  re-prepares a memory pack, after a deploy) shows the stale reload prompt;
  the relay's retries fail the same way and its breaker halts after three,
  so a reload is the fix. `reinstallProfile` (lib/qed64-boot.ts) re-prepares
  a memory pack from the set the boot installed from (`?profiles=<dir>`
  included); the session used the served set before.
  `EMBED_API_REVISION` stays `1.0.0-pre.8`: no export, type or event change;
  an embedder that serves its own packs must keep the index entry's
  `release` equal to its manifest's (`stage-profiles.mjs` writes it so).
- **The front door advertises only what the resident FileWorker answers
  (architecture review R8, 2026-11):**
  - `initialize` no longer offers references, call hierarchy, rename or
    workspace symbols. Stock Lean answers them only in its watchdog, and the
    FileWorker replied `-32603` to each, so Peek References (Shift+F12) and
    Rename (F2) could only fail.
  - The semantic-token legend is upstream's whole legend (24 types, 10
    modifiers). Indices 6-7 decoded as `enumMember`/`comment` before (core
    never emitted them); `leanSorryLike`, and Verso docstrings'
    `parameter`/`string`, now decode.
  - `codeActionProvider` and `inlayHintProvider` also carry upstream's
    `workDoneProgress: false` (the LSP default, so nothing changes for a
    client). `tests/unit/server-capabilities.test.ts` compares the table with
    a transcription of the pinned tag's `mkLeanServerCapabilities` and names
    each difference.
  - The worker scripts keep `REVISION` "1", and `EMBED_API_REVISION` is
    unchanged.
- **The worker no longer counts rescues (architecture review R7a,
  2026-11):** the runtime mailbox is served on every liveness tick, which
  heals a lost wakeup, and no longer counted. `WorkerStatus.liveness.rescues`
  stays and is always 0, and the page API's `liveness` event no longer fires
  with kind `rescue`. No export, type, message or revision change:
  `EMBED_API_REVISION`, `API_REVISION` and the worker `REVISION` are
  unchanged.
- **A busy raw-cache handle is retried (architecture review R2,
  2026-11):** see §7.4. Nothing else changed: no export, type or message
  change, and `EMBED_API_REVISION` and the worker `REVISION` are unchanged.
- **Runtime manifest schema guard (architecture review M3, 2026-11):**
  `embedding/closure.json` gains `runtime.manifestSchemas`
  (`["org.lean-browser64.runtime/v1"]`, §6), and `lean.worker.js` refuses a
  runtime manifest whose `schema`, or a file whose `encoding`, it does not
  read, before it fetches a byte (`RUNTIME_MANIFEST_MISMATCH`, `corrupt`,
  §7.2 and §7.7). A served manifest is v1 and an embedder's own object
  without `schema` is read as v1, so every boot that worked still does.
  `pipeline/release/release-manifest.mjs` exports the same list
  (`RUNTIME_MANIFEST_SCHEMAS`) and `tests/unit/package-contract.test.ts`
  pins the three copies equal. A consumer that pairs these workers with its
  own runtime should compare its runtime's schema with the list at
  staging. No library change: `EMBED_API_REVISION` is unchanged, the four
  workers keep `REVISION` "1", and `PROTOCOL` is unchanged.
- **`qed64/edge` routes a toolchain release (plan step B2b, 2026-10-06):**
  additive options, every default unchanged (`QED64_LEGACY` and the hardened
  defaults keep `release: null`). `release` takes a `lean4-wasm64.release/v1`
  record, checked once by `createWorker` (a bad record throws one
  `TypeError`): `hosting.mount` paths (`/runtime/*`, `/profiles/*`) read
  `lean4-wasm64/<id>/…`, `hosting.siteOwned` paths (`/profiles/index.json`,
  `/snapshots/*`) and anything else read `r2Prefix` (`""`, the bucket root, is
  allowed); unsafe release paths are refused whatever `rejectUnsafeKeys` says,
  and every error on a release path is no-store. `releaseFallback` retries a
  release miss once under `r2Prefix`. New exports `releaseRoutes` and
  `RELEASE_R2_ROOT`, new types `ReleaseRecord` and `ReleaseRoutes`. One
  behaviour change for every configuration: an exception while answering
  (a missing or throwing binding, an extra route, `decorate`) is a 500
  `internal error` with the isolation headers and no-store, logged, where
  `fetch` used to reject. QED64's `infra/worker.js` adopts it with its
  pinned record (docs/DEPLOY.md, "The toolchain release prefix") and keeps
  re-exporting the same `isImmutable`; importing that file now also loads
  `toolchain/lean4-wasm64-release.json` with an import attribute (a full
  checkout has it; Node ≥ 22 and wrangler ≥ 4 handle the syntax). The
  workers, `qed64/embed` and `EMBED_API_REVISION` are untouched.
- **One library root (plan step A7, 2026-10):** the 12 files of the embed
  closure move, unchanged but for their imports, from
  `frontend/src/embed/*`, `frontend/src/{qed64-boot,resident-session,lsp-relay}.ts`,
  `src/install/profiles.ts` and `src/runtime/{client,snapshots}.ts` into
  `lib/` (flat names: `lib/index.ts` is the barrel; `profiles.ts`,
  `client.ts` and `snapshots.ts` keep their basenames). `exports["./embed"]`
  and closure.json `entry` are `lib/index.ts`; closure.json `embed` lists
  the `lib/` files; `files` ships `lib/`. Every import inside `lib/` is a
  sibling (no `../../../src` hop), and the page (`frontend/`) imports the
  library from `../../lib`. The old paths are **shims for one pin cycle**:
  each is a one-line `export *` of its `lib/` file, shipped in `files` but
  not listed in the closure, so a consumer that names a file path instead of
  `qed64/embed` keeps compiling; the next cycle deletes them, with their
  `files` entries (`tests/unit/lib-root.test.ts` pins each to its target,
  and fails on any import of one from inside this repository). An import of `qed64/embed` needs no change; a `paths`
  entry that names closure.json `entry` changes to `lib/index.ts` (§10:
  lean4game's `client/tsconfig.json`, which its `stage-workers.sh` checks).
  No export, type or behaviour changes (the built `dist/` is byte-identical,
  shell id included; only `qed64-build.json`'s `commit` differs), so
  `EMBED_API_REVISION` stays `1.0.0-pre.6` (§7: the revision is the semver
  of the library API) and the page API's revision is unchanged; the workers
  and their protocol revision are untouched.
- **The A7 path shims are deleted (architecture review R9a, 2026-11):**
  - What went: the 12 one-line re-exports at the library's old paths
    (`frontend/src/embed/*`,
    `frontend/src/{qed64-boot,resident-session,lsp-relay}.ts`,
    `src/install/profiles.ts`, `src/runtime/{client,snapshots}.ts`) and
    their `files` entries. This is the one pin cycle after A7 that its row
    promised.
  - Who is affected: none of the consumers imports an old path. lean4game
    imports `qed64/embed` and `lib/edit-coalescer.ts`. The proof sheets
    import `qed64/embed`, `qed64/edge` and `lib/lsp-relay.ts`. The showcase
    imports none.
  - What to do: import `qed64/embed`, or a `lib/` file by its path.
  - No export, type or behaviour change. `EMBED_API_REVISION` is
    unchanged.
- **One umbrella-root list; a header naming only `Lean`, `Std`, `Aesop`,
  `Qq`, `Plausible` or `LeanSearchClient` boots the umbrella (HARDENING #82,
  2026-11):** `LEGACY_UMBRELLA_ROOTS` gains those six roots and
  `isUmbrellaModule` reads it (so `needsMathlib`, `snapshotsForHeader` and
  `EDITOR_POLICY` follow), as do `entryRoots`, `chooseSnapshots` and
  `widenTarget` for an entry named `mathlib` without `roots`. Such a header
  used to boot init alone and stay refused on a fresh page or after a crash
  reboot, while a session that had loaded the umbrella served it covered. An
  overlay with `roots` beside the stock entry must claim a superset of the
  ten (§8). No export or type change, so `EMBED_API_REVISION` is unchanged.
- **One Lean-options channel and one set of worker constants (architecture
  review R3, 2026-11):**
  - `ResidentHost.leanOptions` (§7.3) passes Lean options to the resident
    FileWorker on every boot, merged by name over the worker's defaults.
  - The worker refuses a malformed or repeated one (`INVALID_MESSAGE`) and
    echoes the command line in `ReadyInfo.argv`. A session refuses a worker
    that did not take a requested option (`stale`).
  - `BootConfig.leanOptions` and `ReadyInfo.argv` are additive.
  - The defaults and the thread budget moved, unchanged, from
    `lean.worker.js` into the new worker script `worker-constants.js`
    (§7.7), loaded eagerly. closure.json `workers`, `WORKER_URLS` and
    `files` gain it, so `runtimeUrls().workers` has six entries. `REVISION`
    stays "1".
  - A driver that read `RESIDENT_ARGV` from `lean.worker.js`'s text must
    import the script instead: the line it matched is gone.
  - `EMBED_API_REVISION` → `1.0.0-pre.9`.
- **`prefetchRaw` asks for durable storage before a fresh write (D1/R15,
  2026-11):** see §7.4. The unawaited `navigator.storage.persist()` that
  `installProfile` makes before a pack write is made here too, so the raw
  snapshot region (1.1 GB for the umbrella) keeps the ask once the library
  packs leave the browser. Firefox may show its persistent-storage prompt on
  a site's first region download; the boot never waits for the answer. No
  export, type or message change: `EMBED_API_REVISION` and the worker
  `REVISION` are unchanged.
- **The stock page offers no action (D1, 2026-11):** `capabilities.offers`
  is false; `status().offer` is null, no `offer` event fires and
  `acceptOffer()` returns false. `status().collision` and the front door's
  note stay; the note is reworded neutrally ("Already declared in the
  preloaded environment: …", then why and "Rename yours"), because lean4game
  and the proof sheets run the same front door. `qed64/embed`'s API is
  untouched; the front-door worker script, which the package ships
  (closure.json workers), changes only its collision note text and keeps
  `REVISION` "1", so a consumer that stages the workers re-stages it to get
  the new note. The page API's `api.version` (1) and `API_REVISION` (`1.0.0`)
  are unchanged: a false capability is v1's way to say absent (§1, item 2);
  `EMBED_API_REVISION` is unchanged.
- **Library packs leave the browser; "Load exact imports" retired (D1 with
  R15, 2026-11):**
  - What went (allowed under "-pre", §7): `LeanSession.compile`,
    `CompileResult` and `Diagnostic` (only `CompileResult` used it);
    `RestartOptions.warmHeader` and `packs` (`RestartOptions` is
    `{snapshots?, initialBytes?}`); `Qed64Artifacts.index` and `installed`
    (`Qed64Artifacts` is `{runtime, snapshots}`); the five profile types
    (`InstallProgress`, `InstalledProfile`, `ProfileIndex`,
    `ProfileIndexEntry`, `ProfileManifest`); the @internal
    `installProfile`, `ensureProfile` and `fetchProfileIndex`; and
    `lib/profiles.ts` (the closure's `embed` has 11 files).
  - What is ignored: `InstallOptions.profiles` (every value, `"none"`
    included, is accepted) and `?profiles=` (still validated: a refused
    value is still a `BootParamError`). `installArtifacts` fetches the
    runtime manifest, then the snapshot index, and no profile index; a
    `ResidentSession` boots with no pack and an empty `LEAN_PATH` and runs
    no warm compile. `BootStage` keeps `profile` and `warm`, which are no
    longer emitted.
  - The clean-up: `installArtifacts` removes, best effort and unawaited,
    the OPFS pack store `qed64-packs/` and
    `localStorage["qed64.opfs.byteCeiling"]` that earlier releases wrote
    (§7.6).
  - The worker still answers `compile` and still mounts a `boot`'s `packs`
    for one more release (closure.json `workerProtocol.deprecated`, §7.7);
    `BootConfig.packs` and `LibraryPack` are unchanged until then.
  - Who is affected: a consumer booting with `profiles: "none"` changes
    nothing; a fixture building `Qed64Artifacts` drops `index`/`installed`.
  - `EMBED_API_REVISION` → `1.0.0-pre.10`.
- **A restart's in-flight replies say "restarting the checker" (D1,
  2026-11):** `LspRelay.restart` answered each request still in flight with
  `reason: "restarting with exact imports"` (and the message
  "QED64: restarting with exact imports"), false for every restart once the
  offer was retired. The reason and message now read "restarting the
  checker" (§7.2); `error.data.qed64.kind` (`"restart"`), the error codes
  and the `QED64:` prefix are unchanged. What to do: a consumer that
  matched the old words matches `kind === "restart"` (or the prefix)
  instead. No export, type or message-shape change: `EMBED_API_REVISION` is
  unchanged.
- **Atomic deploys (architecture review D2, 2026-11):** a page-tier change
  (additive, principle 1).
  - The stock page's `dist/` gains `profiles/index.json` and
    `snapshots/index.json`, byte copies of the tracked indexes (§4 "`dist/`
    layout"); QED64's Worker serves them from the deploy, so the shell, the
    release record and the indexes switch in one deploy (docs/DEPLOY.md
    "Atomic deploys").
  - QED64 publishes no new per-build index copies; the ones it published
    before stay frozen while a Worker version from before is a rollback
    target. The reader rule (`pairedBuildId`, `pinnedBuildId`, §4 and
    §7.6) stays: lean4game passes the options, and other sites still
    publish copies.
  - QED64's `infra/worker.js` takes the hardened `qed64/edge` defaults
    (ranges, metadata HEAD, 405 for other methods, unsafe-key refusal,
    explicit lengths, asset HEAD length, `errorCacheControl: "no-store"`)
    with its release and one extra route; `QED64_LEGACY` is unchanged and
    frozen.
  - No export, type or behaviour change in `qed64/embed`, `qed64/edge` or
    the workers: `EMBED_API_REVISION`, the page API's `API_REVISION` and
    the workers' `WORKER_REVISION` are unchanged.
- **Served umbrella roots (architecture review D10, 2026-11):** docs only.
  QED64's adoption (`adopt-release.sh`) bakes its `mathlib` entry with
  `--roots` = the ten shared roots (§8), so the served index declares them
  from QED64's next adoption on; until then the entry has none and the name
  fallback gives the same answer. The served index is not rebaked or edited
  for this. `LEGACY_UMBRELLA_ROOTS` and the fallback stay (the list is also
  the editor's policy without an index). No library change:
  `EMBED_API_REVISION` is unchanged.
- **The barrel loses what no consumer imports (architecture review R9a,
  2026-11):**
  - Removed from `qed64/embed`, the last eight `@internal` re-exports:
    `memoryCandidates`, `overridesOf`, `rawRegionName`, `failureKindOf`,
    `httpStatusOf`, `NO_OVERRIDES`, `parseBootParams` and `isImport` (the
    other three that `1.0.0-pre.5` marked, `installProfile`,
    `ensureProfile` and `fetchProfileIndex`, left with D1 in
    `1.0.0-pre.10`). The barrel has no `@internal` re-export left (until the
    `1.0.0` row below marks `LEGACY_UMBRELLA_ROOTS`).
  - Removed, eleven values no consumer imports through the barrel:
    `PROTOCOL`, `fetchSnapshotIndex`, `entryRoots`, `WORKER_DEP_MISMATCH`,
    `EDITOR_POLICY`, `importLinesOf`, `initialBytesForHeader`,
    `initialBytesForSnapshots`, `isUmbrellaModule`, `needsMathlib` and
    `snapshotsForHeader`.
  - Checked with grep over lean4game `wasm64-port` 1771ed3, the proof
    sheets `website-v4.35` 5468694 and the showcase `port-lean-4.35`
    079ef23: none imports any of them through the barrel (lean4game defines
    its own `WORKER_DEP_MISMATCH` and `parseBootParams`).
  - Each stays exported from its `lib/` file for the stock page and the
    tests; no behaviour changes. `LEGACY_UMBRELLA_ROOTS` stays in the
    barrel (it is also the editor's policy without an index, §8).
  - Migration: catch `loadSnapshotIndex`'s throw where you used
    `fetchSnapshotIndex`; compare a stale cause's code with the literal
    `"WORKER_DEP_MISMATCH"`; use the contract member that wraps each
    internal one: `ResidentSession` (memory rungs), `failureCauseOf` (kind
    and HTTP status), `validateBootOverrides` (URL overrides, or
    `installArtifacts`' `overrides: "url"`),
    `prefetchRaw`/`isRawCached`/`removeRawRegion` (the region name),
    `LspRelay` (the header rule), `makeEditorPolicy(index)` for the policy
    (`makeEditorPolicy(null)` is what `EDITOR_POLICY` was) and
    `importedModulesOf` with `chooseSnapshots` / `initialBytesForEntries`
    for the header helpers.
  - A removal under "-pre", like A2c's:
    `EMBED_API_REVISION` → `1.0.0-pre.11`.
