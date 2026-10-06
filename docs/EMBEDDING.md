# Embedding QED64 — contract v1

Status: **v1 release candidate, 2026-10-04** (branch `feature/embedding-api`).
The draft (daf9b63) was reviewed by both downstream consumers:
- the widgets showcase: `qed64-showcase/docs/QED64-EMBEDDING-V1-REVIEW.md`;
- lean4game: 24 items, adversarially verified.

Their requests are folded in below. §12 lists what changed since the draft.

QED64 is consumed in two ways, and this document is the contract for both:

| Tier | Who | What they use | Where |
|------|-----|---------------|-------|
| **Page API** | an embedder of the QED64 *page*. The widgets showcase frames QED64's own `dist/` on its origin. | `globalThis.qed64.api`, boot parameters, embed mode, the dist layout | §2 – §5 |
| **Library** | an embedder of QED64's *modules*. lean4game builds its own page on the runtime. | the npm package's `qed64/embed`, `qed64/workers/*`, `qed64/pipeline/*` | §6 – §8 |

Everything not named here is internal and may change in any commit (§9).

---

## 1. Principles and versioning

1. **Additive within a major.** v1 only ever gains optional fields, new events,
   new methods and new capability flags. A breaking change is `version: 2`,
   shipped alongside v1 for at least one release.
2. **Feature-detect with `capabilities`** (page tier) and with
   `capabilities().requests` (worker tier). Never compare versions or
   commits. `api.version === 1` has existed since 47f50e8 with only
   `capabilities.editorRpc`, so a version check would assume methods that page
   does not have.
3. **Plain data across the boundary.** Every event payload and method result
   is JSON (structured-clone-safe).
4. **The embedder never needs the DOM.** Labels are prose for humans and are
   not API. Every fact an embedder scraped before has a structured equivalent.
5. **Same-origin only in v1.** Lean source is script execution on the QED64
   origin: widget modules run in the same-origin InfoView iframe.
6. **A release** is one `main` commit that the user tagged and deployed. Its
   page and its worker scripts are served together.
   - Until tags exist, consumers pin pushed commit SHAs (full 40 hex).
   - The two-release rule in §7.7 counts releases, not commits.

---

## 2. The page API: `globalThis.qed64.api`

### 2.1 Discovery

`globalThis.qed64.api` is defined **synchronously at module start**, before
the relay, the editor or any network request.
- It is frozen: `Object.isFrozen(api) && Object.isFrozen(api.capabilities)`.
- Its methods work at any time. Those that need the editor or the relay wait
  for them (`whenReady`) or say so (`status()`).

At the same moment, **once per page document and before the boot document is
read** (§3.1), the page dispatches:
- `new CustomEvent("qed64:api", {detail: api})` on its own `window`;
- when framed by a same-origin parent,
  `new CustomEvent("qed64:frame-api", {detail: {api, frame}})` on
  `window.parent`, where `frame === iframe.contentWindow`.

"The relay exists" is `whenReady()` or `status().relay`. Neither
`!!window.qed64` nor `typeof qed64.api.status === "function"` tells you
anything, because both are true at module start. An embedder's own InfoView
message rewriting must stand down on `capabilities.editorRpc` (and on
`capabilities.widgetSourceCache` for widget-source coalescing).

```ts
interface Qed64ApiV1 {
  readonly version: 1;
  readonly revision: string;                 // "1.0.0": semver of this API
  readonly capabilities: Readonly<Capabilities>;
  build(): BuildInfo | null;                 // null until the runtime manifest loaded

  status(): ApiStatus;                       // synchronous, never throws, valid before boot
  whenReady(): Promise<ApiStatus>;           // editor mounted + relay bound (not "elaborated")
  settled(opts?: { version?: number; afterSession?: string; timeoutMs?: number }): Promise<ApiStatus>;

  on<E extends EventName>(type: E, fn: (payload: Events[E]) => void): () => void; // returns unsubscribe
  off<E extends EventName>(type: E, fn: (payload: Events[E]) => void): void;

  getDocument(): { uri: string; version: number | null; text: string } | null;
  setDocument(text: string, opts?: { cursor?: Cursor; focus?: boolean; undoable?: boolean }): Promise<{ version: number | null; unchanged: boolean }>;
  getCursor(): Cursor | null;
  setCursor(cursor: Cursor, opts?: { focus?: boolean; reveal?: boolean }): boolean;
  focus(): boolean;                          // focus the editor without moving the cursor
  restart(opts?: { snapshots?: string[]; initialBytes?: number }): { accepted: boolean; fromSession: string | null };
  acceptOffer(kind?: "exactImports"): boolean;
}

type Cursor = { lineNumber: number; column: number }; // 1-based; columns in UTF-16 code units (Monaco)

interface Capabilities {
  editorRpc: boolean;          // the InfoView's editor RPC is native (abortSignal, applyEdit, insertText, showDocument) — HARDENING #56
  widgetSourceCache: boolean;  // Lean.Widget.getWidgetSource coalesced by hash per session (§2.5)
  documents: boolean;          // getDocument / setDocument / getCursor / setCursor / focus
  events: boolean;             // on / off and §2.4
  restart: boolean;            // restart()
  embedMode: boolean;          // ?embed=1 (§3)
  snapshotRoots: boolean;      // overlay indexes may declare roots; the page boots and widens by itself (§8)
  liveness: boolean;           // status().liveness and the liveness event
  memory: boolean;             // ?memory=, restart({initialBytes}), status().memory
  offers: boolean;             // status().offer, the offer event, acceptOffer()
  postMessage: boolean;        // false in v1 (§5)
}

interface BuildInfo { buildId: string; leanVersion: string; sourceRevision: string | null; shell: string | null }
```

### 2.2 `ApiStatus`, the stable projection

```ts
interface ApiStatus {
  phase: "booting" | "starting" | "elaborating" | "ready" | "headerRefused" | "dead" | "halted";
  relay: "serving" | "rebooting" | "halted";
  rebootReason: null | "boot" | "crash" | "heartbeat" | "wedged" | "user" | "bootFailed";
  session: string | null;             // opaque id of the current Lean session
  version: number | null;             // document version the checker last received
  header: { mode: "exact" | "covered" | "refused"; missing: string[]; moduleCount: number } | null;
  collision: { names: string[]; version: number | null } | null;
  lastDeath: DeathInfo | null;
  boot: { stage: BootStage; label: string; done: boolean; failed: boolean; message: string | null;
          overlay: boolean };         // overlay: the page's own boot card is visible
  snapshots: string[] | null;         // the environments the current session loaded, e.g. ["init", "mathlib"]
  liveness: LivenessInfo | null;      // null until the session's loop is open
  memory: { initialBytes: number | null; currentBytes: number | null; maximumBytes: number | null } | null;
  offer: { kind: "exactImports"; label: string } | null;
}

interface DeathInfo {
  kind: "crash" | "exit" | "abort" | "wedged" | "heartbeat" | "bootFailed" | "other";
  reason: string;                     // the raw relay reason, verbatim
  message: string;
  cause: FailureCause | null;         // §7.2; null = no evidence
  seq: number;                        // this page's death count: identity that survives copies
  session: string;                    // the session that died
  exitCode: number | null;
}

interface LivenessInfo {              // the worker's liveness machine (HARDENING #52), projected
  stalled: boolean;                   // a probe is unanswered past wedgeAfterMs; death follows graceMs later
  lastAnswerAgoMs: number | null;     // since this session's Lean side last answered a liveness probe; null until it has
  lastFrameAgoMs: number | null;      // since this session's Lean side last sent any frame (QED64's own frames excluded); null until its first
  probeAfterMs: number; wedgeAfterMs: number; graceMs: number; // the worker's timings: 6000, 12000, 4000
}
```

- **`ready`** means "this document version is fully elaborated": phase
  `ready` or `headerRefused` while the relay is `serving`.
- **Superseded statuses are never reported.** A status of a session the page
  has already replaced inside the same turn is dropped. The page's self-widen
  of §8 restarts the session from inside the status sink, so a
  `headerRefused` that is about to be widened never reaches `status`,
  `ready` or `settled`.

### 2.3 Methods

* **`setDocument(text, opts)`**
  * Before the page has read its boot document (§3.1), the text **becomes**
    the boot document. It outranks `#code=`. It is a boot input: it decides
    which environment boots. The promise resolves once the page is up.
  * After that, it replaces the editor's text. `undoable: true` (the default)
    pushes one undo step; `false` uses `setValue`. It resolves with
    `{version, unchanged: false}` once the relay has forwarded the editor's
    text as of this edit or a later one: the first didOpen/didChange whose
    version reaches the editor's version id after the edit.
  * The LSP client syncs full text and coalesces: an edit only queues the
    document, and one didChange carries the text current at flush time (250
    ms after the last edit, or before the next request). A text replaced
    inside that window (a second `setDocument`, a keystroke, an InfoView
    edit) is never forwarded on its own; its promise still resolves, with
    the version of the forward that carried the later text, and
    `getDocument()` and the `document` event show that text. Nothing
    rejects for being superseded.
  * Identical text (compared with the editor's buffer) sends nothing and
    resolves with `unchanged: true`: at once when the relay has already
    forwarded that text, otherwise when the earlier edit's pending forward
    goes out, with that forward's version.
  * Line endings are compared in the model's terms: Monaco stores one EOL,
    so CRLF or a lone CR in `text` is normalized.
* **Before the page is up** (the relay bound and the editor mounted, which
  is what `whenReady` waits for), `whenReady`, `settled` and a pre-boot
  `setDocument` reject with `{code: "BOOT_FAILED"}` when the boot fails (a
  refused parameter, a missing index, the editor failing to start), whether
  they were called before the failure or after it.
* **`settled({version, afterSession, timeoutMs})`**
  * Resolves with the status once the phase is `ready` or `headerRefused` at a
    document version `>= version`. The default `version` is the current
    document's version; before the first didOpen, it is the boot document's
    first verdict.
  * With `afterSession`, it resolves only on a different (replacement)
    session.
  * It keeps waiting through reboots.
  * It resolves with its own `ApiStatus` (what `status()` returns at that
    moment), never the `status` event's payload; a status a `status`
    listener superseded by restarting the session does not settle it.
  * The version it resolves with may never reach the checker: the session
    coalesces full-text changes (§7.8) and forwards the newest. Wait for a
    verdict with `settled({version})`, which accepts any later version.
  * Called while the relay is halted, it rejects `HALTED` at once.
  * Each check runs a microtask after the status that triggered it (and
    after the call), so a restart made by any listener of that status, or
    later in the same turn, supersedes it.
  * It rejects with `Error & {code: "HALTED"}` when the crash-loop breaker
    trips, and with `{code: "TIMEOUT"}` after `timeoutMs`.
* **`restart({snapshots, initialBytes})`**
  * With no `snapshots`, it reuses **the current session's boot inputs** under
    the relay's own rule: the remembered "Load exact imports" options
    (warmHeader, packs) while the import lines still match, otherwise the
    snapshot list the session loaded.
  * `initialBytes` is normalized: rounded to 256 MiB and clamped to
    [1, 6] GiB. It sticks for every later session (crash reboots, widens,
    header changes) until the next explicit `restart()`, which resets it to
    the page default (`?memory=`, else the index policy).
  * A commit is never larger than the largest reservation the device will
    try: the page and the worker both clamp it to the reservation ladder.
    `status().memory.initialBytes` is the commit the worker actually made
    once the session has booted (so it never exceeds `maximumBytes`); before
    boot it is the request, clamped to the ladder. `currentBytes` and `maximumBytes`
    are the current session's meter readings: null after a session change
    until its first reading.
  * On a halted relay, `restart()` with no arguments re-arms it on the
    default session, as an edit would.
  * It returns `{accepted: false}` while a boot is in flight.
  * It throws `TypeError` for a snapshot name the served index lacks.
* **`setCursor`** clamps the line to `[1, lineCount]` and the column to
  `[1, lineLength + 1]`. It returns false only before the editor mounts.
* **`acceptOffer()`** runs the page's current offer (today: "Load exact
  imports") as its button would. It returns false when nothing is offered.

### 2.4 Events

Listeners are called synchronously, each in its own `try/catch`. Payloads are
fresh plain objects: copies of the page's state and of the LSP message, so
editing one in place changes neither what the editor receives nor
`status()`. All listeners of one event share its payload.

| Event | Payload | When |
|-------|---------|------|
| `status` | `ApiStatus` | every relay status change (superseded ones excepted) |
| `boot` | `{stage, phase, subject, label, loaded, total, unit, done, failed, message, error}` | every boot step: the first boot, every reboot, widen and restart, the snapshot prefetch and the exact-import pack download included (§7.1) |
| `ready` | `{session, version, refused, header}` | once per (session, version), at a final verdict |
| `document` | `{uri, version, length, text}` | every didOpen/didChange the relay forwards. This is the persistence hook in embed mode. The checker sees the newest of these; a text replaced inside the session's coalescing window (§7.8) never reaches it, so wait per version with `settled({version})` (which accepts a later one), never for a verdict at that exact version. |
| `diagnostics` | `{uri, version, diagnostics, origin: "lean" \| "qed64"}` | every `publishDiagnostics` the editor receives. `qed64` = the page's own notes. |
| `fileProgress` | `{uri, version, processing}` | `$/lean/fileProgress`, coalesced to at most one per 100 ms on a timer (rAF does not run in hidden frames), and flushed before the next `status` |
| `death` | `{session, kind, reason, message, cause, seq, exitCode, willReboot, halted}` | a session died (once per session); `cause.kind` `"stale"`: the site was updated under the page, offer a reload (§7.2) |
| `reboot` | `{reason, fromSession, toSession}` | the relay replaced the session |
| `liveness` | `{session, kind: "answered" \| "stall" \| "resumed" \| "rescue"}` | each step of the worker's liveness counters |
| `offer` | `{kind, label} \| null` | the page's offer appears or is withdrawn |

### 2.5 Widget sources

Every rendered user widget fetches its JS module by hash
(`Lean.Widget.getWidgetSource`). The page coalesces these requests:
- The first request for a hash goes to the worker; later ones wait for its
  reply.
- A result is cached for the session that produced it. A new session starts
  empty.
- An error reply releases every waiter with it. The one exception is a
  cancellation of the leader alone, which promotes the next waiter.
- A waiter's own `$/cancelRequest` is answered `RequestCancelled` locally.

Since HARDENING #56 the InfoView's RPC crosses the iframe as
`startClientRequest`/`awaitClientRequest`/`cancelClientRequest`, not
`sendClientRequest`. An embedder bridge that matched the old names silently
stops matching.

---

## 3. Embed mode: `?embed=1`

In embed mode the page:
1. **does not read or write `localStorage["qed64.buffer"]`** (the embedder
   owns persistence through the `document` event and `setDocument`);
2. hides the examples menu.

### 3.1 The boot document (both modes)

The first match in this list wins:
1. a `setDocument` call made before the boot document is read;
2. `#code=<encodeURIComponent(text)>` in the fragment (lean4web's spelling,
   at most 2 MiB), **only when the page is framed by a same-origin parent**.
   - A boot document is code. Lean source can define a widget module whose
     JS runs in the same-origin InfoView iframe with no click.
   - So a top-level link (anyone can send one) never supplies it; the page
     logs that it ignored it.
   - A cross-origin frame cannot boot at all (no isolation).
   - It is **read once**: the page drops the fragment with
     `history.replaceState`, keeping the query, so a reload does not
     resurrect stale text;
3. in embed mode, a `setDocument` that arrives at most 5 s after module start
   (the wait runs in parallel with the manifest fetches), else the empty
   document; on the plain page, the stored buffer, else the default example.

Changing only `#code=` on a live frame is a same-document navigation and does
**not** reboot it. To switch documents use `setDocument`. To replace the
runtime (one QED64 per page), navigate the frame away first, e.g. to
`about:blank`, which also releases the old heap.

---

## 4. Boot parameters and page-tier facts

| Parameter | Meaning | Validation |
|-----------|---------|-----------|
| `embed=1` | §3 | exactly `1` |
| `#code=` | §3.1 | URI-decoded, ≤ 2 MiB |
| `snapshots=<dir>` | boot from a snapshot set served at `/<dir>/index.json` on **this origin** | `^(?:snapshots/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, resolving on this origin |
| `profiles=<dir>` | an unpromoted profile set | `^(?:profiles/)?…` (same rule) |
| `runtime=<buildId>` | an unpromoted runtime | `^wasm64-[0-9a-f]{16}$` |
| `memory=<GiB>` | the initial Memory64 commit of **every** session | `^(?:[1-9]\d*\|0)(?:\.\d{1,3})?$`, rounded to 256 MiB and clamped to [1, 6] GiB |
| `edithold=<n>` | the edit back-pressure's threshold for **every** session (§7.8): full-text changes are held while fewer than `n` preallocated Workers are free; `0` disables the hold | `^(?:0\|[1-9]\d?)$`, at most 24; maps to `ResidentHost.editBackPressure.minFreeWorkers` |

Refusals:
- A refused value is a **boot failure that names the parameter**: a `boot`
  event `{stage: "failed", message: "refused ?snapshots=…", error}`.
- An overlay index that is missing, malformed or off-origin is also a named
  failure, with cause `{kind: "missing" | "network" | "corrupt" | "other",
  stage: "manifests", subject: "<dir>"}`. It is never a silent "no snapshots".

Page-tier facts (stable, for preflights and deploy tools):
- **The snapshot index.** Schema `qed64.snapshot-index/v1`. Each entry
  carries `name`, `url`, `digest` (`sha256:` of the served bytes), `bytes`
  (raw), `transfer`, `imports`, `runtime` (the buildId that baked it), and
  optionally `roots`, `label` and `initialBytes` (§8). Entry URLs must
  resolve on the page's origin.
- **Re-rooting.** Under `?snapshots=<dir>`, an entry URL starting with
  `/snapshots/` is re-rooted to `/<dir>/`. The same applies to `?profiles=` and
  `/profiles/`.
- **The runtime manifest.** `/runtime/runtime-manifest.<buildId>.json`
  (immutable, fetched first by a shell built for that buildId) and
  `/runtime/runtime-manifest.json` (mutable).
- **`dist/` layout.**
  - `index.html`, `assets/*`, `workers/*`, `infoview/*`, and
    `qed64-build.json`;
  - `runtime/`, `profiles/` and `snapshots/` are served beside it, not built
    into it.
- **`dist/qed64-build.json`** `{schema: "qed64.build/v1", buildId,
  leanVersion, sourceRevision, commit, dirty, shell, apiRevision}`.
  - `shell` is `"shell-" + 16 hex` of the sha256 of the dist listing. The
    listing is one `<sha256>  <path>` line per file, byte-sorted, covering
    every file except `qed64-build.json` itself.
  - That is exactly the release manifest's `shell.shellId`
    (docs/RELEASE-BUNDLE.md), which refuses a dist whose build file
    disagrees.
  - Deploy and pin tools read it instead of scraping bundles.
  - It is written last, after every other file of the build, and only by a
    build that succeeded: a failed build writes none, and a previous build's
    `dist/` keeps its own. `commit`/`dirty` are null only outside a git
    checkout.

**Security (HARDENING #57).**
- *Before.* These parameters were spliced into fetch URLs unchecked.
  `?snapshots=/attacker.example/x` is protocol-relative, so it loaded an
  environment from another origin, whose widget modules then ran in the
  same-origin InfoView iframe.
- *Now.* The parameters are validated before any fetch. The index loader,
  `prefetchRaw`, the prefetch worker and the Lean worker's `loadSnapshot` all
  refuse an off-origin URL (`SNAPSHOT_URL_REFUSED`). §11 covers what this
  means for caches written before the fix.

---

## 5. Hosting facts, and what v1.1 adds

These hold already:
- **Cross-origin isolation.** QED64 needs `crossOriginIsolated`. The top
  document must send COOP `same-origin` and COEP `require-corp`.
  - A same-origin frame inherits `cross-origin-isolated`.
  - A cross-origin frame (v1.1) needs `allow="cross-origin-isolated"`.
  - Clipboard access needs `allow="clipboard-read; clipboard-write"`.
- **One QED64 per top-level page** (HARDENING #55).
- **Encoding and ranges.**
  - No `Content-Encoding` on runtime chunks or `.snapz`. They are hashed and
    sized as served, and `.snapz` is already gzip.
  - `Range` support on `.snapz` is recommended, so an interrupted first visit
    can resume.
- **Missing artifacts 404.** A missing `index.json` or manifest must 404,
  never fall back to HTML (an HTML answer is classified `missing`, §7.2).

v1.1 adds:
- a postMessage transport for cross-origin iframes. It needs a deployment
  allowlist served as `/embed-config.json`, never URL parameters;
  `frame-ancestors` and `Cross-Origin-Resource-Policy: cross-origin` on the
  HTML shell only; and a statement that cross-site frames get partitioned
  storage (a separate ~600 MB first visit);
- `layout=split|stack|auto`, `#codez=`, and an embed `escape` key event.

---

## 6. The library: the `qed64` npm package

lean4game depends on QED64 as an npm **git dependency** pinned by a full SHA:
`"qed64": "github:FawadHa1der/QED64#<40-hex>"`. npm then fetches the codeload
tarball, with no git or SSH needed, and honours `files`.

`package.json` (pinned by `tests/unit/package-contract.test.ts`):
- `"license": "MIT"`, `"sideEffects": false`, zero runtime dependencies.
- **No script npm treats as "prepare me".** pacote runs `npm install
  --include=dev` in a temporary clone of a git dependency whose root
  `package.json` has `workspaces`, or any of `build`, `prepare`, `prepack`,
  `preinstall`, `install` or `postinstall`. QED64's build script is therefore
  `build:all`, and CI uses `build:site`.
- `exports`:
  - `"./embed"` → `frontend/src/embed/index.ts`;
  - `"./edge"` → `infra/edge-worker.js` (types `infra/edge-worker.d.ts`):
    the edge-worker library of docs/DEPLOY.md, dependency-free;
  - `"./workers/*"`;
  - `"./pipeline/*"`;
  - `"./embedding/closure.json"`;
  - `"./package.json"`.
- `files`: exactly the closure below, plus the license, README and this
  document. 50 files, about 194 kB packed. `npm run test:consumer`
  (tests/consumer/check-consumer.mjs) proves the packed files alone resolve
  and build.

Notes for consumers:
- The embed closure is TypeScript source with **relative imports only** (no
  bare specifiers, no `node:`). A bundler transpiles it (Vite does; `tsc`
  needs `moduleResolution: "bundler"`).
- Node's own type stripping refuses `.ts` under `node_modules`, and the closure
  uses parameter properties. A Node test runner needs a transpile hook.
- The pipeline scripts imported through the package resolve a relative
  `--work` or `--out` against the **package root**, which is inside
  `node_modules`. Run them from a copy, or pass absolute paths.
- The page-API setup (`globalThis.qed64.api`, the `qed64:*` events, `#code=`,
  the buffer) lives only in site modules that are not in the package.

`embedding/closure.json` (schema `qed64.closure/v1`) lists:
- `embed`: the TS closure of `qed64/embed`;
- `workers`: `{path, serveAs}`. `lean.worker.js` `importScripts`
  `lsp-frames.js` and `lsp-front-door.js` from its own directory, so all
  four ship together;
- `infra`: the edge-worker library behind `qed64/edge`;
- `pipeline` and `pipelineData`;
- `runtime.minKernelPatch`: `"0032"`, the oldest kernel patch level these
  workers drive correctly. Compare it against your own KERNEL-PIN;
- `workerProtocol`: §7.7.

---

## 7. The library API: `qed64/embed`

`EMBED_API_REVISION` is the semver of this section (minor = additive).

### 7.0 Exports

- **runtime:** `LeanSession`, `PROTOCOL`, `probeMemory64`, `MEMORY64_PROBE`
  (the 13 probe bytes `probeMemory64` and the worker validate; a fixed-shape
  `Uint8Array`, read-only by convention: refuse an incapable browser before
  loading anything with `WebAssembly.validate(MEMORY64_PROBE)`),
  `memoryCandidates`, and the types.
- **snapshots:**
  - the index: `loadSnapshotIndex` (throws, naming the fault),
    `fetchSnapshotIndex` (null on any fault) and `snapshotCacheKey`;
  - the overlay helpers of §8.
- **raw cache (§7.4):** `prefetchRaw`, `isRawCached`, `rawRegionName`,
  `removeRawRegion`, `isCacheKeyOf`, `SNAPSHOT_CACHE_DIR` and
  `PREFETCH_SILENCE_MS`.
- **boot:** `installArtifacts`, `overridesOf`, `resolveRuntimeManifest`,
  `fetchSnapshotIndexFor`, `ensureProfile` and `loadSnapshotByName`.
- **parameters:** `parseBootParams(search, origin)`,
  `validateBootOverrides`, `BootParamError` (`code:
  "BOOT_PARAM_REFUSED"`, `param`) and `NO_OVERRIDES`.
- **session:** `ResidentSession`, `ResidentPolicy`, `ResidentHost`,
  `SessionFile`, `EDITOR_POLICY`, `makeEditorPolicy(index)` and the header
  helpers.
- **relay:** `LspRelay` (its contract members in §7.9: `clientPort`,
  `unload()`, `status()`, `rearm()`, `restart()`), `RelaySession`,
  `RelayStatus`, `RestartOptions` and `Death`.
- **causes (§7.2):** `failureKindOf`, `failureCauseOf`, `deathCause`,
  `httpStatusOf`, `WORKER_SCRIPT_LOAD_FAILED` and `WORKER_DEP_MISMATCH`.
- **offline:** `runtimeUrls(manifest)` and `WORKER_URLS`.

### 7.1 Structured progress

`ProgressInfo` has these fields:
- `stage`: a `BootStage`, one of `manifests | profile | runtime | memory |
  snapshot | modules | warm | files | done | failed`;
- `subject`: a profile id, snapshot name or runtime file;
- `step`: `check | download | inflate | commit | verify | read | load | init
  | write`;
- `error`: a `FailureCause`;
- the legacy `phase`, `loaded`, `total` and `unit`.

`StatusSink.busy(label, info?)`. Every call QED64 makes carries `stage`.

Units:
- `loaded`/`total` cover **the whole stage**. The runtime reports one combined
  total across `lean.js` and `lean.wasm`; `subject` names the current file.
- For a snapshot, `loaded` is the bytes of the **inflated** region written so
  far and `total` is the entry's raw size.
- `step: "inflate"` means the source is a local compressed copy (no network).

### 7.2 Failure causes and deaths

```ts
type FailureKind = "network" | "missing" | "corrupt" | "unpaired" | "oom" | "storage" | "stale" | "other";
interface FailureCause { kind: FailureKind; httpStatus?: number; stage?: BootStage; subject?: string; code?: string; message: string }
```

| kind | meaning | e.g. |
|------|---------|------|
| `network` | the fetch was rejected, the stream was cut, or 5xx/429 (retrying can help) | `Failed to fetch`, `HTTP 503` |
| `missing` | the server does not have it: a deploy problem, so retrying cannot help | every 4xx except 408/425/429; an HTML answer where JSON or binary belongs (the workers and the index loader sniff it); `SNAPSHOT_NOT_IN_INDEX` |
| `corrupt` | it arrived but is wrong | chunk length or SHA-256 mismatch; a gzip/DecompressionStream error; "not a compacted-region file"; a size the index does not declare; "raw size mismatch"; `SNAPSHOT_LOAD_RESULT` (the Lean loader refused the region); `RUNTIME_MANIFEST_MISMATCH` (a runtime manifest whose `buildId` is not `wasm64-` + the first 16 hex digits of its own `files["lean.wasm"].sha256`: the runtime/v1 invariant every reader may check; the page refuses it before fetching, the worker before booting) |
| `unpaired` | a snapshot baked by another runtime build | `SNAPSHOT_UNPAIRED` |
| `oom` | an allocation or reservation failed | `MEMORY_FAILED`, `could not allocate`, `Cannot enlarge memory` |
| `storage` | OPFS or quota | `QuotaExceededError` |
| `stale` | the site was deployed under this page: the worker scripts it loaded are of different revisions (§7.7). **Reload the page.** Retrying in place does not help: the relay heals by itself (its replacement worker loads the new scripts, and the relay replays `initialize` and the document, so the language client never re-initializes), but it then serves under this page's older bundle, which holds only while the worker protocol changes additively | `WORKER_DEP_MISMATCH` (`code` is always `"WORKER_DEP_MISMATCH"`, exported as `WORKER_DEP_MISMATCH`) |
| `other` | the checker's own failure, with **one exception**: `code: "WORKER_SCRIPT_LOAD_FAILED"` means a worker script never ran, which looks the same offline as on a 404, so probe the link | `abort`, `wedged`, `SNAPSHOT_URL_REFUSED` |

Classification is per throw, from the error code **and** message:
`RUNTIME_FETCH_FAILED` covers a 404, a cut and a SHA mismatch alike. The page
classifies, so the same table holds against every worker version.

**Deaths.**
- `cause` **null or absent = no evidence**. This happens only for a bare
  worker error event (no message, after the worker said hello).
- A sibling script of another revision is `stale` with `code:
  "WORKER_DEP_MISMATCH"`: by the worker's error code, or by the refusal's
  own words ("a deploy mixed versions") on the same throw's uncaught error
  event, which can arrive first and before the hello. What to do: offer a
  reload (the stock page shows a standing "Updated — reload" button beside
  its pill; a halt before the first `ready` gets the failure card's Reload).
  The relay reboots meanwhile and usually serves again; `lastDeath` clears
  at that `ready`, so keep the fact yourself (the page API's `death` event
  carries the cause, §2.4, and a boot that halts carries it as
  `boot.error`).
- A worker that never said hello, or a `WORKER_DEP_MISSING`, is
  `WORKER_SCRIPT_LOAD_FAILED`. A sibling that does not load at all is not
  `stale`: offline it looks the same as a deploy that dropped the file, and
  a reload offline would lose the page, so it means "probe the link".
- An unrecoverable error code (`RUNTIME_FETCH_FAILED`, `MEMORY_FAILED`,
  `INIT_FAILED`, `CAPABILITY_MISSING`, `WRITE_FILES_FAILED`, …) is
  classified by the table.
- Every other death is `other`, or `oom` when its message says so.
- A death while booting carries the boot `stage`. Booting lasts until the
  relay's `arm()` resolves, so a death during the replay and the arm carries
  `files`, the last stage.
- Every `bootFailed` death carries a cause: the step's own (runtime,
  snapshot), or one classified at the step that threw. A library-pack
  install is `stage: "profile"` with the pack id as `subject`; the host's
  `files()`, `beforeArm` and an arm the worker refuses are `stage: "files"`.

The cause travels through `LeanSession.onDied(code, reason, message, facts)`,
then `ResidentSession` (which classifies), then
`RelaySession.onDied(…, cause)`.

`Death` (the relay's) is `{reason, message, seq, session, exitCode?,
cause?}`:
- `seq` is the relay's death count;
- `exitCode` is set when the worker reported one;
- the object is the **same object until the next death**, and is cleared
  when a session reports phase `ready`. It outlives its own reboot: a
  serving relay with no document never reaches `ready`, so use `seq` to
  compare across copies.

Errors the relay invents carry
`error.data.qed64 = {kind: "orphaned" | "halted" | "restart", reason}`.
The message prefix `QED64:` stays as a fallback. `LspRelay.rearm()` re-arms a
halted relay without an edit; it returns false unless the relay is halted.

### 7.3 Session files and the pre-arm hook

```ts
interface ResidentHost {
  artifacts; ui; policy?; headerText;                     // unchanged
  files?: SessionFile[] | (() => SessionFile[] | Promise<SessionFile[]>);
  beforeArm?(session: LeanSession): Promise<void>;
  busyWaitMs?: number;                                    // §7.4; default PREFETCH_SILENCE_MS
  editCoalesceMs?; editBackPressure?;                     // §7.8
}
type SessionFile = { path: string; text: string } | { path: string; bytes: Uint8Array };
```

Both run on **every** boot (first and reboots), after the snapshots and the
exact-import warm, immediately before the relay arms the loop. The front door
queues every frame until `lsp-arm`, so Lean never sees the document before the
files. `LeanSession.writeFiles(files)` is public. Bytes are copied, not
transferred. A throw from either is a `bootFailed` death whose cause is
classified at `stage: "files"` (a `files()` fetch that fails is `network`; an
`HTTP 404` message is `missing`). The members `ResidentSession` gained in v1
are ECMAScript-private (`#`), so a subclass can keep its own `files` or
`beforeArm` (lean4game's `GameSession`) with no TS2415 collision and no
second write.

**`busyWaitMs`.** Each boot loads its snapshots through `loadSnapshotByName`,
which first prefetches the raw region with `onBusy: "wait"` (§7.4). While
ANOTHER tab holds that region's writer lock, the boot waits for it at most
`busyWaitMs` (default `PREFETCH_SILENCE_MS`, 3 min; 0 does not wait), then
re-probes the cache, and if the region is still missing the session's Lean
worker streams it itself (the heavier path the prefetch exists to avoid, so a
short bound trades memory for latency). The bound is counted from the lock
request; the other tab's progress does not extend it. `loadSnapshotByName`
takes the same option as its fifth argument (`LoadSnapshotOptions`). The
member is ECMAScript-private in `ResidentSession`, like `files`.

### 7.4 The raw snapshot cache

```ts
function prefetchRaw(entry, opts?: { onProgress?; signal?; silenceMs?; workerUrl?; onBusy?: "wait" | "return"; busyWaitMs?; onBusyWait? }):
  Promise<{ status: "cached" | "done" | "unavailable" | "busy" | "silent" | "aborted" | "error"; bytes?; error?: FailureCause }>;
```

- **Single-flight in the page.** Callers of one cache key share one worker.
  Each keeps its own `onProgress`, `signal`, `onBusy`, `busyWaitMs` and
  `onBusyWait`; `silenceMs` and `workerUrl` are the first caller's. An abort
  detaches only that caller; the worker is terminated when every caller has
  aborted. An already-aborted signal spawns nothing, and an abort that
  leaves no caller before the worker starts (including during the re-probe
  under the lock) spawns nothing.
- **Across tabs.** The writer holds the Web Lock `qed64-raw:<cacheKey>` for
  its whole life. A flight first asks for it with `ifAvailable`, so `busy`
  and `onBusyWait` mean another tab really holds it (a free lock is granted
  a task later, never at once). Then, per caller: `onBusy: "return"` (the
  default) answers `busy` at once, including when it joins a flight of this
  page that is already waiting; `"wait"` calls `onBusyWait` once as it
  starts waiting, waits up to its own `busyWaitMs` (default
  `PREFETCH_SILENCE_MS`), then re-probes `.raw`. The lock request is
  withdrawn when the last waiting caller leaves. `loadSnapshotByName` uses
  `"wait"`, with `ResidentHost.busyWaitMs` (§7.3) as its `busyWaitMs`.
- **It needs the raw size.** The prefetch worker refuses a message without a
  positive `rawBytes` (the entry's `bytes`) with `error` (`corrupt`). Its
  compressed-only mode, which fetched without the redirect and HTML
  refusals, is gone.
- **Silence or abort.**
  1. The worker is terminated.
  2. `<key>.raw.partial` is removed (never `.raw`).
  3. `.raw` is re-probed, so a commit that beat the bail reports `done`.
- **After settling,** no message or timer has any effect.
- **Load failure.** A worker that fails to load resolves `error` with
  `WORKER_LOAD_FAILED` at once.
- **Same origin only.** An off-origin `entry.url` is refused
  (`SNAPSHOT_URL_REFUSED`) before any worker starts.
- **It only ever produces `.raw`.** It never throws.

Helpers: `isRawCached(entry)` (null when there is no OPFS),
`rawRegionName(entry)`, `removeRawRegion(entry)`, `isCacheKeyOf(fileName,
index)` (for sweeping stale bakes) and `SNAPSHOT_CACHE_DIR`.

**Integrity.**
- A region is trusted by its cache key, and the key comes from the index.
- `digest` (SHA-256 of the served compressed bytes) is **not** verified while
  streaming today; the workers check the magic and the size.
- The same-origin rule is what keeps a foreign region out. Streaming digest
  verification is planned for v1.1.

### 7.5 Offline URL list

`runtimeUrls(manifest)` returns `{manifests, chunks, workers}`:
- `manifests`: the immutable manifest, then the mutable one;
- `chunks`: every chunk URL of `lean.js` and `lean.wasm`, deduplicated, in
  order;
- `workers`: the four worker scripts.

### 7.6 Installing artifacts

```ts
installArtifacts(ui, opts?: {
  overrides?: "url" | "none" | Partial<BootOverrides>;   // default "url": ?snapshots/profiles/runtime, validated (§4)
  profiles?: "core" | "none" | string[];                 // default "core"; "none": no pack, a missing profile index is empty
  runtime?: RuntimeManifest;                              // already resolved: used as is
  snapshots?: SnapshotIndex | null;                       // already resolved: used as is
});
resolveRuntimeManifest(overrides, { pinnedBuildId? }): Promise<RuntimeManifest>;
fetchSnapshotIndexFor(overrides): Promise<SnapshotIndex | null>;   // a requested overlay that fails is a named error
```

A game page wants `{overrides: "none", profiles: "none"}`, or its own
overrides routed through `parseBootParams` / `validateBootOverrides`.

### 7.7 Workers: compatibility across deploys

- `/workers/*.js` names are stable. A new worker is a new name.
- **One revision for the three scripts.** `lean.worker.js`, `lsp-frames.js`
  and `lsp-front-door.js` carry the same `REVISION`. `lean.worker.js`
  refuses a sibling of another revision (`WORKER_DEP_MISMATCH`, a death
  whose cause is `stale`, §7.2: offer a reload) instead of running mixed
  versions.
  The front door loads lazily, so this check catches a deploy that lands
  between the two loads. A front door that cannot be loaded at that point
  (not served, or the link dropped) is `WORKER_DEP_MISSING`, unrecoverable
  like the eager import (so `WORKER_SCRIPT_LOAD_FAILED`); after either
  refusal the worker drops every later frame and never throws an uncaught
  error the page would read as the checker's crash.
- **Feature flags.** `capabilities()` reports `protocolRevision` and
  `requests`, the request types the worker answers. A page detects a request
  with `requests?.includes(type)` and keeps its old path otherwise.
- **An unknown request is recoverable** (`UNSUPPORTED_REQUEST`). The request
  fails and the session lives. It used to be a death on every reboot, so an
  old tab against a new worker halted.
- **Messages change additively.** A removal is listed in
  `closure.json` → `workerProtocol.deprecated` with the release it went
  unused in, and leaves the worker one release later. Long-lived tabs are
  covered by the recoverable refusal above and by the revision check.
- **A `telemetry` request may be answered after a `status` event.** The
  worker re-samples its status before replying and emits the event when
  the status changed (the pool sample included); an unchanged status emits
  nothing. The session relies on it while it holds an edit for the pool
  (§7.8); a page that only reads the reply sees no difference, and the
  status event stays the one channel for pool samples. Not a protocol
  change: no new message, field or request type.

### 7.8 Edit coalescing

`ResidentSession` forwards a full-text `didChange` to the worker at most once
per window (`ResidentHost.editCoalesceMs`, default 300 ms; 0 forwards every
frame at once). Embedders do not need their own throttle.
- The first change of a burst goes at once and opens the window. Later
  changes inside it are held, the newest replacing the held one. When the
  window ends, the held change goes and opens the next window. Each change
  carries the whole text, so Lean always sees the newest version.
- While a change is held, every other frame (requests, other notifications)
  waits behind it in arrival order and goes right after it. Nothing is
  reordered relative to the text. The cost: a frame sent during a burst
  waits up to the window. A `$/cancelRequest` never waits: one naming a
  request still queued answers that request `RequestCancelled` (-32800,
  `error.data.qed64.kind: "cancelled"`) at once, what Lean would answer,
  and the request never reaches the worker; one naming a request already
  forwarded goes at once (the request it names is already there).
- A request queued behind a change that a newer change then replaces is
  answered against the newer text, which is the client's view by then:
  editors cancel or re-issue their position-bound requests on every content
  change (hover, inlay hints, code actions, highlights, folding, symbols),
  and the InfoView keeps only its latest answer. The exceptions are the
  requests whose reply Monaco rebases by the edits made since the request,
  so a reply computed on the newer text would get the edit applied twice:
  document semantic tokens (`textDocument/semanticTokens/full`, `/full/delta`,
  `/range`) and `textDocument/completion` (Lean's option-name and error-name
  items also carry an edit range on the server's text). A queued one of
  those whose change a newer change replaces is answered `ContentModified`
  (-32801, `error.data.qed64.kind: "superseded"`) the moment that happens:
  the LSP code clients treat as "ask again" (vscode-languageclient returns
  the feature's default and logs nothing; Lean 4.34 itself does not emit it
  for an edit under a request, and the front door already answers completion
  with it). The client refetches the tokens, and the next keystroke
  re-triggers the completion.
  lean4monaco logs every error reply it receives to the console (its own
  TODO; the relay's death and restart errors already go there), so typing
  with the suggest widget open can print one such line per superseding
  change.
- Every forwarded change opens the window again. A barrier (didOpen,
  didClose, a ranged change) or another document's change forwards a held
  change at once, inside the window its predecessor opened: barriers never
  wait. The change after that waits a full window. So the rate limit holds
  for a stream of changes to one document, not for a client that alternates
  documents or interleaves ranged edits.
- `didOpen`, `didClose`, a ranged or multi-part `didChange`, a replay, and a
  full-text change of another document first send the held change and its
  queue, then go (or are held) themselves.
- With nothing held, every frame goes at once.
- `dispose()` drops a held change and its queue. The relay replays its last
  full text into the replacement session and answers every request it
  forwarded that the dead session did not.
- Why: each full-text change starts a new elaboration, and Lean abandons the
  previous one only at its next cancellation check. Work that never checks
  (`IO.sleep`, a long kernel check, a blocking `#eval`) keeps its pthread, so
  a change per keystroke grows the runtime's pool past its preallocated
  Workers until V8 runs out of memory (docs/HARDENING.md #59). A client's own
  coalescing does not prevent it: vscode-languageclient holds a full-text
  change for 250 ms but flushes it before every request, and lean4monaco's
  requests (the InfoView's goals on a cursor move, inlay hints, code actions,
  semantic tokens) follow a keystroke whenever typing is slow enough for
  their debounces to fire between keys. Measured on the stock page (the
  edit-storm lane counts the frames reaching the relay): a burst at 10
  ms/char reaches it as one change and 17 requests (the delayer); at 150
  ms/char, 57 keystrokes arrive as 54 changes and about 250 requests, four
  to five per key. lean4game's client sent one change per keystroke at 25
  ms/char. Queuing those requests behind the held change, instead of
  letting them flush it, is what keeps the coalescing effective.
- The window caps bursts, not a sustained pace, and it limits the rate,
  not the number of threads. Keystrokes 150 ms apart rarely share a window,
  so at that pace nearly every change is forwarded (delayed more than
  merged), each one a new elaboration, and each keystroke's requests that
  wait on a snapshot hold threads too. Measured on the stock page before
  the back-pressure below: typing at 150 ms/char above an `#eval IO.sleep
  3000` with the InfoView open crashed the tab on every build
  (docs/HARDENING.md #59).
- **Back-pressure on the worker's pool** (`ResidentHost.editBackPressure`;
  the page maps `?edithold=<n>` onto it, §4). The session feeds the
  coalescer the pool sample of every worker status (`status.pool`:
  preallocated Workers free, pthreads alive). The pool is *pressured* while
  the last sample shows fewer than `minFreeWorkers` free (default 6 of the
  runtime's 24, so while more than 18 pthreads are alive), and for
  `pressureMemoryMs` (default 1000) after the last such sample: request
  threads live for milliseconds, so the free count flaps between 2 and 12
  inside one 100 ms interval, and a window's end that happened to see a
  drained sample would forward another elaboration. A sample that did not
  measure the pool never pressures. Samples arrive only with the worker's
  status events, and an idle worker emits none, so while a change is held
  the session asks the worker for telemetry every 250 ms (the worker then
  re-emits its status when the pool changed), and a hold that only the
  memory keeps is re-checked when the memory expires.
  - A change held when its window ends stays held while the pool is
    pressured, and the frames behind it with it. The next status showing
    the pool drained releases it at once: the newest change, then the
    queue, and a new window opens. A change arriving with no window open
    while the pool is pressured is held the same way instead of going at
    once. Newest wins during the hold as inside the window, with the same
    `ContentModified` answers for the superseded requests.
  - The hold is capped: `maxHoldMs` (default 5000) after it began the
    newest change goes regardless, and a newer change replacing the held
    one does not restart the cap. A sustained pace under sustained pressure
    therefore reaches Lean once per window plus cap, never not at all.
    Samples arrive only with the worker's status events (every server
    frame; there is no timer), so a silent worker is what the cap is for.
  - Barriers, replays and another document's change flush a hold as they
    flush a window; `dispose()` drops it. `{ minFreeWorkers: 0 }` disables
    it, and with no status observed the coalescer behaves as without it.
- **Requests in flight** (`editBackPressure.maxInFlightRequests`, default
  6). Each request Lean is handling is a task on its own dedicated thread
  while it waits for its snapshot, and a thread is a Worker: ~90 requests
  released at once above a 3 s `IO.sleep` grew the pool 24 → 64 within
  400 ms (the hold alone, HARDENING #59 addendum). So at most that many
  requests are at the worker unanswered; the next waits at the head of the
  queue and every frame behind it waits in order, and each reply admits the
  next. A full-text change never waits for a slot: it goes ahead of the
  waiting requests, which are answered against the newer text (the rule
  above, `ContentModified` for the ones Monaco rebases). Barriers and
  replays flush the whole queue past the cap. `0` is no cap. Under a
  responsive checker the cap is never reached (the stock page sends four to
  five requests per keystroke, answered in milliseconds); under one that
  is not, the requests wait here instead of each on its own thread there.
- The session logs each hold, release and cap to the console
  (`[qed64] edit back-pressure: …`) and keeps a record
  (`ResidentSession.backPressure`: `holds`, `releases`, `caps`, `waits`
  (requests that waited for a slot), `cancelled`, `superseded`).
- The cost: under pressure an edit waits for the pool, up to the cap, and
  the InfoView follows when the change goes; past the cap a request waits
  for a reply to an earlier one. That trades latency on a runtime already
  near the cage ceiling (#55) for the tab staying alive. Measured with the
  edit-storm lane's `pageslow` scenario, the typing above: see
  docs/HARDENING.md #59 (addendum).
- What it does not do: it keys on the pool and on the requests, not on the
  work. Threads taken before the pool was pressured run to their end, and a
  single command that spawns more threads than the pool has free is out of
  its reach. The root fix is a cap on concurrently live dedicated threads
  in the runtime's task manager (#55), the kernel's.

### 7.9 The relay: the members an embedder uses

```ts
new LspRelay(makeSession: (opts?: RestartOptions) => RelaySession, sink: { status(s: RelayStatus): void }, settle: () => Promise<void>);
relay.clientPort: MessagePort;   // the language client's end of the LSP channel
relay.unload(): void;            // the synchronous teardown, from `pagehide`
relay.status(): RelayStatus;     // the projection (§7.2: lastDeath, its cause)
relay.rearm(): boolean;          // re-arm a halted relay without an edit (§7.2)
relay.restart(opts: RestartOptions): void;  // a deliberate replacement, not a death
```

- **`clientPort`** is the `MessagePort` a language client connects to: the
  editor's LSP client (lean4monaco's `WorkerDirect` `messagePort`, the stock
  page's wiring) or a translation layer in front of it (lean4game's
  `GameTranslation.attachServer(relay.clientPort)`). Every JSON-RPC message
  posted on it is a client message (the relay records `initialize`,
  `didOpen` and full-text `didChange` for its replay, then forwards it to
  the session, whose booting worker queues it; a halted relay answers a
  request itself, §7.2); every message the relay sends back (the
  worker's replies and notifications, the relay's own error replies and
  halted note) arrives on it. It is the same port for the relay's whole
  life: a reboot replaces the session behind it, never the port, so a
  client connects once. The relay creates its first session in the
  constructor, so connect right after constructing it.
- **`unload()`** disposes the live session and terminates its worker
  **inside the caller's turn**: nothing is awaited or deferred, because a
  closing document runs no later timer (`dispose()` alone terminates 250 ms
  later, and reload storms stacked dead multi-GiB heaps until the OS killed
  the renderer). Call it once, from `pagehide` (`addEventListener("pagehide",
  () => relay.unload(), { once: true })`), or when the embedder discards the
  relay for good. Nothing reboots the killed session (a disposed session
  reports no death), so discard the relay afterwards and build a new one to
  check again.
- The relay's other fields (`state`, `session`, `lastDeath`, `doc`,
  `pending`, `stats`, `fromClient`, `toClient`, …) are internal and may
  change in any commit; read `status()` instead.

---

## 8. Overlay environments

A snapshot index entry may declare, additively under
`qed64.snapshot-index/v1`:
- `roots: string[]`: module-name roots on a component boundary. `HasseView`
  covers `HasseView.Foo` but never `HasseView2`;
- `label`: e.g. "Mathlib + widgets";
- `initialBytes`: the initial commit when the entry is loaded.

An entry may have **any name**. The page then:
- **Boots** the base (`init`) plus at most **one** other entry for a header:
  1. the smallest entry whose roots cover every module the base does not;
  2. failing that, the one covering the most (a mixed header still boots the
     umbrella, and the kernel names the module it cannot cover);
  3. if none covers any, the base alone.

  The kernel serves a header from one environment, and every region is a
  full-size heap allocation, so a second heavy region never helps.
- **Sizes** the commit: the largest declared `initialBytes`; else 2 GiB with
  any non-base entry; else 256 MiB. `?memory=` overrides it.
- **Widens** a running session once, when the kernel refuses its header and
  an entry not yet loaded covers **every** missing module, plus every header
  module that some entry's roots claim and the base does not serve (the
  replacement serves the whole header from one environment). For example, a
  Mathlib session gaining `import HasseView` widens to an overlay whose
  roots include both, whatever else the header imports from the umbrella's
  closure (`Aesop`, `Qq`, `Lean.*`: a module no root names is the kernel's
  to judge). It never widens when every missing module is Init or claimed by
  a loaded entry's roots: the kernel has just refuted that claim (a prefix
  being typed, a typo), and no snapshot would change the verdict. The
  decision is stateless, so a session a reboot booted without the entry (the
  header changed, then a crash) widens again.

It is **opt-in.** Without `roots`, the entry named `mathlib` serves the
umbrella roots (`Mathlib`, `Batteries`, `MIL`, `QED64`) and no other entry
serves any. A legacy index therefore behaves exactly as before; the unit tests
pin this parity on the stock index and drive the page's self-widen
(`frontend/src/self-widen.ts`) over the real relay. The exact-imports restart keeps the
session's own snapshot list. The roots are claims, not membership: the
kernel's header verdict stays authoritative.

---

## 9. Internal, and the test hatch

These are internal and may change in any commit:
- every other member of `globalThis.qed64` (`relay`, `ui`, `artifacts`,
  `editor`, `status()`);
- the `qed64.buffer` key;
- every DOM id/class and every label string;
- `globalThis.__qed64InfoviewEditorApi`;
- every path not in `exports` / `closure.json`.

Embedders may add their own listeners to the framed window (e.g. a capture
`keydown` for an F6 escape). The `__qed64*` namespace is reserved for QED64.

**`globalThis.qed64.test`** is the harnesses' hatch. It is **explicitly
unstable**, versioned only by `test.revision`, and must not be used by
product code:
- `stats()`, `rawStatus()` (with the ring/pool/liveness counters),
  `telemetry()` and `session()`;
- `lsp.on("in" | "out", fn)`;
- `lsp.request(method, params, timeoutMs = 30000)`, whose reply is swallowed
  and returned. On timeout the promise rejects and the hatch sends
  `$/cancelRequest` for its id; the late reply is still swallowed;
- `lsp.notify(method, params)`.

The worker's `self.__qed64TestExports` is its test hook, under the same
terms. Fault injection (`inject`/`freeze`) and mailbox/pool hooks are v1.1.

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
| button-text matching for "Load exact imports" | `status().offer`, `acceptOffer()` |
| D1/D2 bridge | stand down completely on `capabilities.editorRpc` |
| D3 bridge (getWidgetSource) | stand down on `capabilities.widgetSourceCache` |
| scraping `wasm64-<hex>` from bundles | `dist/qed64-build.json` |
| renaming the overlay region to `mathlib` | any name with `roots` (§8); update C6, which asserts the refusal of `import HasseView` |
| `__qed64Bridge` expando | rename (`__qed64*` is reserved) |

**lean4game (library tier):**
- Delete the vendored copies and `sync-qed64.sh`. Import from `qed64/embed`,
  and stage the workers from `closure.json`.
- Route URL overrides through `parseBootParams` and boot with
  `installArtifacts(ui, {overrides, profiles: "none"})` or the exported
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

## 11. Security notes

- **HARDENING #57 (fixed in this branch).** Off-origin snapshot and profile
  sources could be loaded through a crafted link. These are now refused,
  including when the off-origin source is reached through a redirect:
  - every boot parameter;
  - the snapshot index loader;
  - the profile loaders (index, manifests, parts);
  - `prefetchRaw` and both workers.

  A boot document in the URL (`#code=`) is honoured only inside a
  same-origin frame (§3.1).
- **Caches written before the fix.** A region fetched from another origin
  before #57 was committed under the key the hostile index named. A copied
  `name` and `digest` would persist under a genuine key, and later visits
  would load it.
  - The fix stops new poisoning but does not purge.
  - Purging (re-keying the cache namespace) costs every visitor a one-time
    re-download of about 430 MB.
  - Whether to do it is **the user's decision** and is open.
  - Streaming digest verification (v1.1) would make the key self-checking.

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
    `WORKER_SCRIPT_LOAD_FAILED` before the hello, `other` after). Migration:
    a `switch` over `FailureKind` gains a case; code keyed on
    `cause.code === "WORKER_DEP_MISMATCH"` keeps working, while code that
    asserted `kind: "other"` for it must expect `stale`.
    `WORKER_DEP_MISSING` is unchanged (`WORKER_SCRIPT_LOAD_FAILED`).
    `WORKER_DEP_MISMATCH` is exported. The stock page shows a standing
    Reload button for it; the page API's `death` event and a halted boot's
    `boot.error` carry it. `EMBED_API_REVISION` → `1.0.0-pre.4`.
