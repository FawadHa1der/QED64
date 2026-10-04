# Embedding QED64 — contract v1 (DRAFT for review)

Status: **draft, 2026-10-04**, sent to the two downstream consumers (the
widgets showcase, lean4game) before any code. Nothing below is implemented
except §2.1's capability flag (`qed64.api = {version: 1, capabilities:
{editorRpc: true}}`, shipped with HARDENING #56 at 47f50e8).

QED64 is consumed in two ways, and this document is the contract for both:

| Tier | Who | What they use | Where it is specified |
|------|-----|---------------|-----------------------|
| **Page API** | an embedder of the QED64 *page* (the widgets showcase frames QED64's own `dist/` on its origin) | `globalThis.qed64.api`, boot parameters, embed mode | §2 – §5 |
| **Library** | an embedder of QED64's *modules* (lean4game builds its own page on the runtime) | the npm package's `qed64/embed`, `qed64/workers/*`, `qed64/pipeline/*` entries | §6 – §8 |

Everything not named here is internal and may change in any commit (§9).

---

## 1. Principles

1. **Additive within a major.** v1 only ever gains optional fields, new events,
   new methods and new capability flags. A breaking change is `version: 2`,
   shipped alongside v1 for at least one release.
2. **Feature-detect with `capabilities`, never by comparing versions or
   commits.**
3. **Plain data across the boundary.** Every event payload and method result
   is JSON (structured-clone-safe); a later postMessage transport (§5) carries
   the identical objects.
4. **The embedder never needs the DOM.** Every fact an embedder scrapes today
   (`#boot`, the pill text, label strings) has a structured equivalent.
   Labels stay prose for humans and are not API.
5. **Same-origin first.** v1 is in-page (same-origin) only. Cross-origin
   embedding needs a deployment allowlist and is v1.1 (§5), because Lean
   source is script execution on the QED64 origin (widget modules run in the
   same-origin InfoView iframe).

---

## 2. The page API: `globalThis.qed64.api`

### 2.1 Discovery

`globalThis.qed64.api` is defined **synchronously at module start**, before
the relay, the editor or any network request, and is frozen
(`Object.isFrozen(api) && Object.isFrozen(api.capabilities)`). Its methods
work at any time; the ones that need the editor or the relay wait for them
(`whenReady`) or say so (`status().boot`).

At the same moment the page dispatches `new CustomEvent("qed64:api", {detail:
api})` on its own `window`, and — when framed by a same-origin parent —
`new CustomEvent("qed64:frame-api", {detail: {api, frame: window}})` on
`window.parent`, so a parent can call `setDocument` before boot (§3.2)
without polling.

```ts
interface Qed64ApiV1 {
  readonly version: 1;                       // the major
  readonly revision: string;                 // "1.0.0": semver of the API; minor = additive
  readonly capabilities: Readonly<Capabilities>;
  build(): BuildInfo | null;                 // null until the runtime manifest loaded

  status(): ApiStatus;                       // synchronous, never throws, valid before boot
  whenReady(): Promise<ApiStatus>;           // editor mounted + relay bound (not "elaborated")
  settled(opts?: { version?: number; timeoutMs?: number }): Promise<ApiStatus>;

  on<E extends EventName>(type: E, fn: (payload: Events[E]) => void): () => void; // returns unsubscribe
  off<E extends EventName>(type: E, fn: (payload: Events[E]) => void): void;

  getDocument(): { uri: string; version: number | null; text: string } | null;
  setDocument(text: string, opts?: { cursor?: Cursor; focus?: boolean; undoable?: boolean }):
    Promise<{ version: number | null; unchanged: boolean }>;
  setCursor(cursor: Cursor, opts?: { focus?: boolean; reveal?: boolean }): boolean;
  restart(opts?: { snapshots?: string[] }): boolean;
}

type Cursor = { lineNumber: number; column: number }; // 1-based; columns in UTF-16 code units (Monaco)

interface Capabilities {
  editorRpc: boolean;      // InfoView editor RPC is native (abortSignal, applyEdit, insertText, showDocument) — HARDENING #56
  documents: boolean;      // getDocument / setDocument / setCursor
  events: boolean;         // on / off and the events of §2.4
  restart: boolean;        // restart()
  embedMode: boolean;      // ?embed=1 (§3)
  snapshotRoots: boolean;  // overlay snapshot indexes may declare `roots` and the page widens by itself (modularity item 4)
  postMessage: boolean;    // false in v1.0 (§5)
}

interface BuildInfo {
  buildId: string;                // runtime build, e.g. "wasm64-3ab1c6a9da03bc29"
  leanVersion: string;            // e.g. "4.34.0"
  sourceRevision: string | null;  // kernel fork commit
  shell: string | null;           // the page bundle's identity (release manifest, modularity item 6); null until then
}
```

### 2.2 `ApiStatus` — the stable projection

`status()` is the embedder's oracle. It is a **projection** of the relay's
internal status (which the test harness keeps reading directly, §9) with the
volatile counters left out:

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
  boot: { stage: BootStage; label: string; done: boolean; failed: boolean; message: string | null };
  snapshots: string[] | null;         // the environments the current session loaded, e.g. ["init", "mathlib"]
}

interface DeathInfo {
  kind: "crash" | "exit" | "abort" | "wedged" | "heartbeat" | "bootFailed" | "other";
  reason: string;                     // the raw relay reason, kept verbatim
  message: string;
  cause: FailureCause | null;         // §7.2
}

type BootStage = "manifests" | "profile" | "runtime" | "memory" | "snapshot" | "modules" | "warm" | "files" | "done" | "failed";
```

`ready` here means "this document version is fully elaborated" (`phase ===
"ready"` or `"headerRefused"`), exactly as the relay reports it.

### 2.3 Methods

* **`setDocument(text, opts)`**
  * Before the page has read its boot document (§3.2) it **becomes** the boot
    document — the text is a boot input: an Init-only document boots the
    light environment, a Mathlib one boots the umbrella. Resolves with
    `{version: null}` once boot reads it.
  * After that it replaces the editor's text (`undoable: true`, the default,
    pushes one undo step; `false` uses `setValue`) and resolves once the relay
    has forwarded that exact text, with its document version.
  * Identical text resolves at once with `unchanged: true` and sends nothing
    (an identical-text "reset" used to wedge an embedder waiting for a
    version that never came). On a halted relay it also re-arms it.
* **`settled({version, timeoutMs})`** resolves with the status once the phase
  is `ready`/`headerRefused` at a document version `>= version` (default: the
  current document's version). It keeps waiting through reboots. It rejects
  with `Error & {code: "HALTED"}` when the crash-loop breaker trips and
  `{code: "TIMEOUT"}` after `timeoutMs` (default: none).
* **`restart({snapshots})`** replaces the session (the "Load exact imports" /
  widen machinery); default = the current session's snapshot list. Returns
  `false` while a boot is still in flight.
* **`setCursor`**, **`getDocument`**: as typed. `getDocument()` is `null`
  before the editor mounts.

### 2.4 Events

Listeners are called synchronously, each in its own `try/catch` (a throwing
listener never reaches the relay). Payloads are fresh plain objects.

| Event | Payload | When |
|-------|---------|------|
| `status` | `ApiStatus` | every relay status change |
| `boot` | `{stage, phase, subject, label, loaded, total, unit, done, failed, message}` | every boot progress step, first boot and every reboot (§7.1 defines the fields) |
| `ready` | `{session, version, refused: boolean, header}` | once per (session, version) when the phase settles at `ready`/`headerRefused` |
| `document` | `{uri, version, length, text}` | every didOpen/didChange the relay forwards — the text the checker will see. Embed mode's persistence hook. |
| `diagnostics` | `{uri, version, diagnostics: LspDiagnostic[], origin: "lean" \| "qed64"}` | every `publishDiagnostics` the editor receives; `qed64` = the page's own notes (halted note, collision note), source `"QED64"` |
| `fileProgress` | `{uri, version, processing: {range, kind?}[]}` | `$/lean/fileProgress`, coalesced to one per animation frame |
| `death` | `{session, kind, reason, message, cause, willReboot, halted}` | a session died (once per session) |
| `reboot` | `{reason, fromSession, toSession}` | the relay replaced the session |

---

## 3. Embed mode: `?embed=1`

For a page that is someone else's surface. In embed mode the page:

1. **does not read or write `localStorage["qed64.buffer"]`** — the embedder
   owns persistence (`document` event + `setDocument`);
2. hides the examples menu (layout knobs beyond that are v1.1, §5);
3. resolves its **boot document** (§3.2) without the stored buffer or the
   default example.

### 3.1 Initial document

In priority order:

1. `#code=<encodeURIComponent(text)>` in the URL fragment (lean4web's
   spelling; fragments never reach a server). `#codez=` (lz-string) is v1.1;
2. a `setDocument` call made before the boot document is read;
3. after the page's manifests are in (`installArtifacts`), it waits — at most
   **5 s from module start** — for (2); then boots with the empty document.

A late `setDocument` (after 3's deadline) still works; it just costs a widen
restart when the late text needs Mathlib.

### 3.2 Persistence, outside embed mode

Unchanged: the plain page restores and saves `qed64.buffer`. The key and its
format are internal.

---

## 4. Boot parameters (supported, validated)

| Parameter | Meaning | Validation |
|-----------|---------|-----------|
| `embed=1` | §3 | exactly `1`; anything else is ignored |
| `#code=` | §3.1 | URI-decoded; > 2 MiB refused |
| `snapshots=<dir>` | boot from an overlay snapshot set served at `/<dir>/index.json` on **this origin** | `^(?:snapshots/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (`snapshots/widgets8`, `snapshots-0031`); resolved with `new URL()` and refused unless `url.origin === location.origin` |
| `profiles=<dir>` | dev: an unpromoted profile set | same rule as `snapshots` |
| `runtime=<buildId>` | dev: an unpromoted runtime | `^wasm64-[0-9a-f]{16}$` |

A refused value is a **boot failure that names the parameter** (`boot`
event `{stage: "failed", message: "refused ?snapshots=…: …"}`), never a
silent fallback to the served set.

**Security (fix ships first, independent of the rest of v1).** Today these
three parameters are spliced into fetch URLs unchecked, so
`?snapshots=/attacker.example/x` is protocol-relative and loads an
environment from another origin, whose Lean widget modules then run in the
same-origin InfoView iframe — with the page's storage. The validation above
closes it. The same parse is exported for library embedders (§7.6).

---

## 5. Deferred to v1.1 (named so nobody builds on a guess)

* **postMessage transport** for iframe embedders: envelope `{qed64: 1, type,
  id?}`, page→parent `hello`/`event`/`response`, parent→page
  `init`/`subscribe`/method calls, `event.source === window.parent`, replies
  to the exact origin never `"*"`. Same-origin parents can already script
  the frame, so the transport only matters cross-origin, which needs:
* **cross-origin allowlist** from deployment config (a worker env var served
  as `/embed-config.json`), never from URL parameters (the framer controls
  the URL); `Content-Security-Policy: frame-ancestors` and
  `Cross-Origin-Resource-Policy: cross-origin` on the HTML shell only, when
  configured. Cross-site frames get partitioned OPFS/cache/locks: a separate
  ~600 MB first visit per embedding site. The recommended pattern stays the
  showcase's: serve QED64's `dist/` on the embedder's own origin.
* `layout=split|stack`, `#codez=`, an `offer` event for "Load exact imports",
  a `memory` boot knob.

Hosting facts that hold already: QED64 needs `crossOriginIsolated`, so the top
document must send COOP `same-origin` + COEP `require-corp`, and the frame
needs `allow="cross-origin-isolated; clipboard-read; clipboard-write"`. One
QED64 per top-level page (HARDENING #55: two runtimes in one renderer each
reserve a cage).

---

## 6. The library: the `qed64` npm package

lean4game depends on QED64 as an npm **git dependency**, lockfile-pinned:

```json
"dependencies": { "qed64": "github:FawadHa1der/QED64#<sha>" }
```

QED64's `package.json` gains (the site build and the showcase's
submodule/dist use are unaffected — neither resolves `qed64` as a package):

```json
{
  "license": "MIT",
  "exports": {
    "./embed": { "types": "./frontend/src/embed/index.ts", "default": "./frontend/src/embed/index.ts" },
    "./workers/*": "./public/workers/*",
    "./pipeline/*": "./pipeline/*",
    "./embedding/closure.json": "./embedding/closure.json",
    "./package.json": "./package.json"
  },
  "files": [
    "LICENSE", "README.md", "docs/EMBEDDING.md", "embedding/",
    "frontend/src/embed/", "frontend/src/qed64-boot.ts", "frontend/src/resident-session.ts", "frontend/src/lsp-relay.ts",
    "src/runtime/", "src/install/",
    "public/workers/",
    "pipeline/toolchain/", "pipeline/snapshot/", "pipeline/artifacts/", "pipeline/release/verify-release.mjs",
    "tests/adversarial/kernel-probes/"
  ]
}
```

Rules QED64 keeps for the package (each pinned by a unit test):

* **No install-time scripts** (`prepare`, `preinstall`, `install`,
  `postinstall`): npm would install QED64's devDependencies and build.
* **Zero runtime `dependencies`.**
* **The embed closure imports nothing but relative paths** (no bare
  specifiers, no `node:`), and resolves entirely inside `files`. TypeScript
  source is shipped as is; the consumer's bundler transpiles it (Vite does;
  `tsc` needs `moduleResolution: "bundler"`). No Vite-only globals unguarded
  (`__QED64_BUILD_ID__` is read behind `typeof`).
* **The pipeline closure** imports only relative paths and `node:` built-ins.
* **Worker scripts are plain files** an embedder serves at `/workers/<name>`
  (`lean.worker.js` `importScripts` `lsp-frames.js` and `lsp-front-door.js`
  from its own directory, so the four always ship together).
* `embedding/closure.json` lists exactly what an embedder needs, so a
  consumer's staging script reads it instead of hard-coding paths:

```json
{
  "schema": "qed64.closure/v1",
  "embed":   ["frontend/src/embed/index.ts", "frontend/src/qed64-boot.ts", "…"],
  "workers": [{ "path": "public/workers/lean.worker.js", "serveAs": "/workers/lean.worker.js" }, "…"],
  "pipeline": ["pipeline/toolchain/chunk-runtime.mjs", "…"],
  "pipelineData": ["tests/adversarial/kernel-probes/is-module.lean", "…"]
}
```

Version identity: until the user tags releases, consumers pin pushed commit
SHAs; `qed64/embed` exports `EMBED_API_REVISION` (semver of §7, same rules
as `api.revision`). Tags (`v0.x`) are a push-time decision of the user.

---

## 7. The library API: `qed64/embed`

### 7.0 What is exported

Everything lean4game imports today, re-exported from one module so the
internal file layout can move without breaking anyone:

* runtime: `LeanSession`, `PROTOCOL`, `probeMemory64`, `memoryCandidates`
  and the types (`RuntimeManifest`, `WorkerStatus`, `JsonRpcMessage`,
  `LibraryPack`, `BootConfig`, `WorkerError`, `HeaderStatus`, …);
* snapshots: `fetchSnapshotIndex`, `snapshotCacheKey`, `SnapshotEntry`,
  `SnapshotIndex`;
* profiles: `fetchProfileIndex`, `installProfile`, `storageEstimate`, and
  their types;
* boot: `installArtifacts`, `ensureProfile`, `loadSnapshotByName`,
  `PREFETCH_SILENCE_MS`, `Qed64Artifacts`, `Qed64Session`, `StatusSink`,
  `ProgressInfo`;
* session: `ResidentSession`, `ResidentPolicy`, `ResidentHost`,
  `EDITOR_POLICY`, `DEFAULT_MAXIMUM_BYTES`, the header helpers
  (`importedModulesOf`, `snapshotsForHeader`, …);
* relay: `LspRelay`, `RelaySession`, `RelayStatus`, `RestartOptions`,
  `Death`;
* new in v1: §7.1 – §7.6.

### 7.1 Structured progress (wishlist 1)

`ProgressInfo` gains fields; `StatusSink.busy` gains the optional second
argument `progress` already has. Existing sinks keep compiling and keep
receiving the same labels.

```ts
interface ProgressInfo {
  phase?: string;            // unchanged (legacy, e.g. "core-download", "snapshot-init")
  loaded?: number; total?: number; unit?: string;   // unchanged
  stage?: BootStage;         // NEW: the step, from a closed set (§2.2)
  subject?: string;          // NEW: profile id, snapshot name or runtime file ("core", "mathlib", "lean.wasm")
  step?: "check" | "download" | "inflate" | "commit" | "verify" | "read" | "load" | "init" | "write"; // NEW
  error?: FailureCause;      // NEW: set on the progress call that reports a failure
}
interface StatusSink {
  busy(label: string, info?: ProgressInfo): void;   // `info` NEW, optional
  progress(label: string, info?: ProgressInfo): void;
  idle(label: string): void;
  action?(label: string, run: () => void): void;
  clearAction?(): void;
}
```

Every `busy`/`progress` call QED64 makes carries `stage` (and `subject`
where there is one) — a unit test drives a session boot against fakes and
asserts no call lacks it. The worker's own progress phases map as `runtime
/ initialize / filesystem → runtime`, `memory → memory`, `snapshot-cache /
snapshot → snapshot (read / download)`, `snapshot-load → snapshot (load)`,
`snapshot-init / import → modules`.

### 7.2 Failure causes (wishlist 2)

```ts
type FailureKind = "network" | "corrupt" | "unpaired" | "oom" | "storage" | "other";
interface FailureCause { kind: FailureKind; stage: BootStage; subject?: string; code?: string; message: string }
```

* The worker adds `details.cause` (one of the kinds) to the errors it can
  classify — `SNAPSHOT_UNPAIRED → unpaired`, `MEMORY_FAILED` and a failed
  region `malloc → oom`, a failed fetch / HTTP status / stream cut →
  `network`, a short region / bad magic / a gunzip error / loader result ≠ 0
  → `corrupt`, OPFS failures → `storage`. Additive: older pages ignore it.
* `loadSnapshotByName` keeps returning `boolean` and additionally reports
  the cause through `ui.progress(label, {stage: "snapshot", subject, error})`;
  `ResidentSession.start()` throws `Error & {cause: FailureCause}` (the
  message text is unchanged: `snapshot '<name>' failed to load`).
* `Death` (relay) gains `cause?: FailureCause` — from the boot error's
  `cause`, or for a worker death from its error code. A page running against
  an **older worker** classifies by error code and message text instead
  (the fallback is the same table, tested).

### 7.3 Session files and a pre-arm hook (wishlist 3)

```ts
interface ResidentHost {
  artifacts: Qed64Artifacts; ui: StatusSink; policy?: ResidentPolicy; headerText: string; // unchanged
  /** Written into the worker's filesystem on EVERY boot (first and reboots), after the
   * snapshots and the exact-import warm, immediately before the relay arms the loop. */
  files?: SessionFile[] | (() => SessionFile[] | Promise<SessionFile[]>);
  /** Last step of every boot, after `files`; a throw is a bootFailed death. */
  beforeArm?(session: LeanSession): Promise<void>;
}
type SessionFile = { path: string; text: string } | { path: string; bytes: Uint8Array }; // absolute paths
```

`LeanSession.writeFiles(files)` becomes public (the worker's `write-files`
request, which exists today). This replaces subclassing `ResidentSession`
and the cast to the private `request`.

### 7.4 Raw snapshot prefetch (wishlist 4)

```ts
function prefetchRaw(entry: SnapshotEntry, opts?: {
  onProgress?(p: { loaded: number; total: number; step: "download" | "inflate" }): void;
  signal?: AbortSignal;
  silenceMs?: number;          // default PREFETCH_SILENCE_MS
  workerUrl?: string;          // default "/workers/snapshot-prefetch.worker.js"
}): Promise<{ status: "cached" | "done" | "unavailable" | "busy" | "silent" | "aborted" | "error"; bytes?: number; error?: FailureCause }>;
```

The page's own `loadSnapshotByName` uses it, so the worker protocol,
silence watchdog, termination and partial-file cleanup exist once.
`"cached"` = the raw region was already complete in OPFS (no worker spawned).

### 7.5 Offline URL list (wishlist 6)

```ts
function runtimeUrls(manifest: RuntimeManifest): { manifests: string[]; chunks: string[]; workers: string[] };
```

`manifests` = the immutable `/runtime/runtime-manifest.<buildId>.json` plus
the mutable `/runtime/runtime-manifest.json`; `chunks` = every chunk URL of
`lean.js` and `lean.wasm` in order; `workers` = the four worker scripts.
Snapshot and profile URLs stay with their indexes (`entry.url`,
manifest parts).

### 7.6 Boot parameters for library embedders

`installArtifacts(ui, opts?: { overrides?: "url" | "none" | BootOverrides })`:
default `"url"` reads and **validates** `?snapshots/profiles/runtime` exactly
as §4; `"none"` ignores the URL (a game page usually wants this); an object
supplies them programmatically (validated the same way). `parseBootParams`
is exported.

### 7.7 Workers: cross-version compatibility

lean4game runs old pages against new workers and new pages against old
workers during a deploy. Rules:

* `/workers/*.js` names are stable; a new worker is a new name.
* Worker messages change additively only: new optional fields, new request
  types. A page detects a new request type with the worker's existing
  `capabilities` request before using it, and keeps the old path.
* Removing a request type or field takes two releases: first unused by the
  page, then removed from the worker.

---

## 8. Overlay environments (modularity item 4; summary)

An overlay snapshot index (`?snapshots=snapshots/<dir>`) may declare, per
entry, the module **roots** it serves (`"roots": ["ProofWidgets", "Showcase"]`),
a `label`, and an `initialBytes` hint. The page then boots and widens by
itself for documents that import those roots, instead of the hard-coded
umbrella roots (no more forced restart in the showcase). Absent fields keep
today's behaviour: roots are derived from the entry's `imports`.
`capabilities.snapshotRoots` signals it. Its own design note lands with the
code.

---

## 9. Internal — not API

May change in any commit; tests may read them, embedders must not:

* every other member of `globalThis.qed64` (`relay`, `ui`, `artifacts`,
  `editor`, `status()`) — the harness's oracle (docs/TESTING.md);
* `RelayStatus`'s `ring`, `pool`, `dropped`, `liveness` (diagnostic counters);
* the `qed64.buffer` storage key and format;
* every DOM id/class (`#boot`, `#bootcard`, `#bar`, `#examples`, `#pill`,
  `#action`, …) and every label string;
* `globalThis.__qed64InfoviewEditorApi` (the HARDENING #56 hook);
* every file path not listed in `exports` / `closure.json`.

---

## 10. Migration notes

**Widgets showcase** (page tier):

| Today | v1 |
|-------|----|
| seed `localStorage["qed64.buffer"]` before load | `?embed=1#code=…`, or `setDocument` on `qed64:frame-api` |
| poll `qed64.status().phase === "ready"` | `api.settled()` |
| wrap `qed64.ui` / scrape `#boot` | `boot` event, `status().boot` |
| tap `relay.toClient` for diagnostics / fileProgress | `diagnostics`, `fileProgress` events |
| `qed64.relay.restart(…)` | `api.restart({snapshots})` |
| inject CSS to hide `#examples` | `embed=1` |
| InfoView edit bridge | stand down when `api.capabilities.editorRpc` |
| forced restart after loading an overlay | `roots` in the overlay index (§8) |

Note for the late-install heuristic: `!!window.qed64` now means "the module
started", not "the relay exists"; check `typeof qed64.api?.status ===
"function"` (or wait for `qed64:api`) instead.

**lean4game** (library tier): delete the vendored copies and
`sync-qed64.sh`; import from `qed64/embed`; stage workers from
`embedding/closure.json`'s `workers`; replace `GameSession extends
ResidentSession` with `files`; the label regexes with `stage`/`subject`/
`error`; the D4 network-vs-crash inference with `Death.cause`;
`prefetchRawSnapshot` with `prefetchRaw`; the offline-URL builder with
`runtimeUrls`.

---

## 11. Review asks

1. **Widgets**: is anything in your migration table missing a v1 equivalent?
   Is `#code=` + `qed64:frame-api` enough for your seed path, or do you need
   the v1.1 `init` message?
2. **lean4game**: do the `BootStage` set and `FailureKind` set cover every
   label your `game-boot.ts` regexes distinguish today? Is "after warm,
   before arm" the right moment for `files`?
3. **Both**: anything you read from `globalThis.qed64` or the DOM that §9
   calls internal and §2 does not replace?
