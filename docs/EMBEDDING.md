# Embedding QED64 — contract v1

Status: **v1, final.** The page API is `1.0.0` (`frontend/src/page-api.ts`
`API_REVISION`), and `qed64/embed` is `EMBED_API_REVISION` `1.1.0` (final
at `1.0.0`, declared 2026-11-01, architecture review D13; `1.1.0` adds the
v2 runtime manifest's fields, §12).
The v1 draft (daf9b63) was reviewed by the two consumers of the time:
- the widgets showcase: `qed64-showcase/docs/QED64-EMBEDDING-V1-REVIEW.md`;
- lean4game: 24 items, adversarially verified.

Their requests are folded in below. §12 lists what changed from `1.0.0` on; what
changed from the draft to it is in the repository's
`docs/history/EMBEDDING-PRE-V1.md`, which the package does not ship.

QED64 is consumed in two ways, and this document is the contract for both:

| Tier | Who | What they use | Where |
|------|-----|---------------|-------|
| **Page API** | an embedder of the QED64 *page*. The widgets showcase frames QED64's own `dist/` on its origin. | `globalThis.qed64.api`, boot parameters, embed mode, the dist layout | §2 – §5 |
| **Library** | an embedder of QED64's *modules*. lean4game and the proof sheets build their own pages on the runtime. | the npm package's `qed64/embed`, `qed64/edge`, `qed64/workers/*`, `qed64/pipeline/*` | §6 – §8 |

§6 says how each of the three consumers holds QED64 today, and §6.1 is the
recipe for a new one (a Vite page with or without the editor).

Everything not named here is internal and may change in any commit (§9).
For `qed64/embed` the barrel agrees: §7.0 names every value export of
`lib/index.ts` except those marked `@internal`, and the contract includes
every type those exports' signatures use.

---

## 1. Principles and versioning

1. **Additive within a major.** v1 only ever gains optional fields, new events,
   new methods and new capability flags. A break is handled per tier:
   - **page API** (§2 – §5): a breaking change is `version: 2`, shipped
     alongside v1 until the page-tier consumer has re-pinned past it: one
     re-pin cycle, since QED64 has no release tags yet (principle 6).
   - **library** (`qed64/embed`, §6 – §8, final at `1.0.0`): a break is the
     next major (`2.0.0`) with a migration note in §12, and no 1.x ships
     beside it. Both library consumers pin full commit SHAs and compile the
     barrel, so a break reaches them only at their own re-pin (a removed or
     retyped name fails their build there), never in a deployed page. QED64
     tells them before such a commit lands.
   - **workers** (§7.7): tabs cross deploys, so the worker protocol keeps its
     own rules: additive messages, the revision check, and a removal
     deprecated one release ahead. A changed policy value (§7.7) keeps
     `REVISION` and `EMBED_API_REVISION`: it is a semantics change with a
     §12 row, not a break.
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
  offers: boolean;             // status().offer, the offer event, acceptOffer(); false on the stock page since D1 (it offers nothing)
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
    trips or the relay pauses for a stack overflow (§7.2; tell them apart by
    `status().lastDeath.cause.code`), and with `{code: "TIMEOUT"}` after
    `timeoutMs`.
* **`restart({snapshots, initialBytes})`**
  * With no `snapshots`, it reuses **the current session's boot inputs** under
    the relay's own rule: the remembered restart options (a self-widen's
    snapshots, a commit) while the import lines still match, otherwise the
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
    The page requests one when the relay enters `ready`, so it arrives one
    worker round-trip later: a `ready` listener or a `settled()` continuation
    that reads `status()` synchronously still sees the previous value (read it
    on a later turn).
  * On a halted relay, `restart()` with no arguments re-arms it on the
    default session, as an edit would.
  * It returns `{accepted: false}` while a boot is in flight.
  * It throws `TypeError` for a snapshot name the served index lacks.
* **`setCursor`** clamps the line to `[1, lineCount]` and the column to
  `[1, lineLength + 1]`. It returns false only before the editor mounts.
* **`acceptOffer()`** runs the page's current offer as its button would. It
  returns false when nothing is offered, always on a page whose
  `capabilities.offers` is false (the stock page since D1).

### 2.4 Events

Listeners are called synchronously, each in its own `try/catch`. Payloads are
fresh plain objects: copies of the page's state and of the LSP message, so
editing one in place changes neither what the editor receives nor
`status()`. All listeners of one event share its payload.

| Event | Payload | When |
|-------|---------|------|
| `status` | `ApiStatus` | every relay status change (superseded ones excepted) |
| `boot` | `{stage, phase, subject, label, loaded, total, unit, done, failed, message, error}` | every boot step: the first boot, every reboot, widen and restart, the snapshot prefetch included (§7.1) |
| `ready` | `{session, version, refused, header}` | once per (session, version), at a final verdict |
| `document` | `{uri, version, length, text}` | every didOpen/didChange the relay forwards. This is the persistence hook in embed mode. The checker sees the newest of these; a text replaced inside the session's coalescing window (§7.8) never reaches it, so wait per version with `settled({version})` (which accepts a later one), never for a verdict at that exact version. |
| `diagnostics` | `{uri, version, diagnostics, origin: "lean" \| "qed64"}` | every `publishDiagnostics` the editor receives. `qed64` = the page's own notes. |
| `fileProgress` | `{uri, version, processing}` | `$/lean/fileProgress`, coalesced to at most one per 100 ms on a timer (rAF does not run in hidden frames), and flushed before the next `status` |
| `death` | `{session, kind, reason, message, cause, seq, exitCode, willReboot, halted}` | a session died (once per session); `cause.kind` `"stale"`: the site was updated under the page, offer a reload (§7.2) |
| `reboot` | `{reason, fromSession, toSession}` | the relay replaced the session |
| `liveness` | `{session, kind: "answered" \| "stall" \| "resumed" \| "rescue"}` | each step of the worker's liveness counters (`rescue` is no longer emitted since 2026-11: the worker stopped counting rescues, R7a; the kind stays in the type) |
| `offer` | `{kind, label} \| null` | the page's offer appears or is withdrawn (never on the stock page since D1) |

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
2. `#code=<encodeURIComponent(text)>` or `#codez=<LZ-string>` in the fragment
   (lean4web's two spellings; `codez` is its default writer,
   `compressToBase64(text)` with the `=` padding stripped, padding tolerated,
   the URI-safe alphabet recognised by a `-` or `$`; `code` outranks `codez`;
   at most 2 MiB of text), **only when the page is framed by a same-origin
   parent**.
   - A boot document is code. Lean source can define a widget module whose
     JS runs in the same-origin InfoView iframe with no click.
   - So a top-level link (anyone can send one) never supplies it. On the
     plain page the fragment is a **share link** instead (HARDENING #77):
     the page boots exactly as it would without it and shows a panel
     (`#sharedlink`, from module start, centered over the page and the boot
     card, the rest dimmed, and still there after the boot) with
     the decoded text (first 12 lines; "show all" expands), its size, the
     note that opening it runs Lean on it as any typed text would, a stronger
     notice when the text contains `widget_module`, `#html`, `#widget`,
     `#eval`, `IO.`, `run_cmd`, `run_elab`, `initialize` or `javascript`
     (`sharedLinkFlags` in page-api.ts: a label, not a blocker), and two
     buttons. **Open in editor** calls `setDocument(text)` (it queues until
     the editor is ready), drops the fragment, and switches persistence off
     for that page load: an edit of the visitor's still waiting in the 400 ms
     save debounce is written first, then no edit is written to
     `localStorage["qed64.buffer"]`, so the visitor's own buffer survives (a
     first visit, with nothing saved, stores nothing), and the pill says so once.
     **Dismiss** drops the fragment and nothing else. A boot that fails
     removes the panel; the fragment stays, so Reload offers it again (a
     browser that cannot run QED64, Safari or any iOS browser, gets a card
     naming desktop Chrome and Firefox). The same link pasted into a plain
     page that is already open changes only the fragment, which reloads
     nothing: the page shows the panel for it then (`hashchange`; not after
     a failed boot), one panel at a time, focused. A
     top-level `?embed=1` page still ignores the fragment and logs that it
     did.
   - A cross-origin frame cannot boot at all (no isolation).
   - In a frame it is **read once**: the page drops the fragment with
     `history.replaceState`, keeping the query, so a reload does not
     resurrect stale text. On the plain page the fragment is dropped when a
     button is clicked, so a reload before that shows the gate again (the
     link stays shareable until acted on);
3. in embed mode, a `setDocument` that arrives at most 5 s after module start
   (the wait runs in parallel with the manifest fetches), else the empty
   document; on the plain page, the stored buffer, else the default example.

Changing only `#code=` / `#codez=` on a live frame is a same-document navigation and does
**not** reboot it (on the top-level plain page it shows the share panel, §3.1 above). To switch documents use `setDocument`. To replace the
runtime (one QED64 per page), navigate the frame away first, e.g. to
`about:blank`, which also releases the old heap.

---

## 4. Boot parameters and page-tier facts

| Parameter | Meaning | Validation |
|-----------|---------|-----------|
| `embed=1` | §3 | exactly `1` |
| `#code=` | §3.1 | URI-decoded, ≤ 2 MiB |
| `#codez=` | §3.1 | LZ-string base64 (lean4web's writer; `=` padding optional; the URI-safe alphabet by its `-`/`$`), ≤ 2 MiB decoded; `#code=` outranks it |
| `snapshots=<dir>` | boot from a snapshot set served at `/<dir>/index.json` on **this origin** | `^(?:snapshots/)?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, resolving on this origin |
| `profiles=<dir>` | accepted and validated, then ignored (D1: no library pack is read) | `^(?:profiles/)?…` (same rule) |
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
  resolve on the page's origin. Any other entry key (`bake-snapshot
  --entry-fields`) is ignored by the page. The writer's rules:
  docs/SNAPSHOT-INDEX.md.
- **Re-rooting.** Under `?snapshots=<dir>`, an entry URL starting with
  `/snapshots/` is re-rooted to `/<dir>/`.
- **The runtime manifest.** `/runtime/runtime-manifest.<buildId>.json`
  (immutable, fetched first by a shell built for that buildId) and
  `/runtime/runtime-manifest.json` (mutable).
- **The per-build index copies** (HARDENING #64).
  `/snapshots/index.<buildId>.json` is the snapshot index of that runtime's
  pairing. A shell built for that buildId reads the mutable
  `/snapshots/index.json` first; only when it names another runtime (an
  upload of the next pairing ran ahead of its deploy) does it read its
  runtime's copy, used when it is an index paired with that runtime (a 404,
  HTML, a network error, a malformed body or a copy naming any other runtime
  keeps the mutable one). A paired site (the showcase's origin, lean4game's,
  a local tree) is never asked for a copy. `?snapshots=<dir>` reads only its
  own `index.json`. (No page reads the profile index's copy,
  `/snapshots/profiles-index.<buildId>.json`, since D1.) A page that reads the
  snapshot index itself gets the same rule from `loadSnapshotIndex` with
  `pairedBuildId` (§7.0): the copy is `index.<buildId>.json` in the
  directory of the index it was given.
  The option is only half of the protection: it reads a copy, and the site
  must publish one. Without it the copy request answers 404, the mutable
  index is kept and the page refuses its entries `SNAPSHOT_UNPAIRED`, as
  before. Writers: QED64's own site publishes none since 2026-11. Its two
  indexes are static assets of each deploy (docs/DEPLOY.md "Atomic
  deploys"), always paired with the shell deployed with them, so the stock
  page never asks for a copy. The copies it published before stay at its
  bucket root, frozen, while a Worker version from before is a rollback
  target. A site that uploads its indexes ahead of its deploy still needs
  copies. `bake-snapshot` writes
  `index.<buildId>.json` beside the `index.json` it upserts (same bytes;
  docs/CLI-CONTRACT.md), but that is the STAGING index, holding only the
  entries baked into that `<out>`: it suits only a site that serves its
  staging dir unmerged (uploads the baked dir as it is). A site that merges
  staged entries into its served index, keeping other names (lean4game's
  `scripts/stage-snapshots.py`), publishes a copy derived from its MERGED
  index instead: written with the merged
  index's bytes when every entry names one runtime (a mixed merge has no
  pairing to pin, so it gets none), uploaded before the mutable
  `index.json`, never overwriting another runtime's copy already
  published (stale local copies of other runtimes removed before the
  upload), and gitignored locally. A pinned page reading the bake's
  staging copy there would miss every entry not rebaked in that run.
- **`dist/` layout.**
  - `index.html`, `assets/*`, `workers/*`, `infoview/*`, and
    `qed64-build.json`;
  - `profiles/index.json` and `snapshots/index.json`, byte copies of the
    tracked indexes, are built into it (since 2026-11), so one deploy
    carries the shell and the indexes it pairs with. Every other file under
    `runtime/`, `profiles/` and `snapshots/` is served beside it, never
    built in. An embedder that serves this dist behind its own Worker and
    routes `/profiles/` and `/snapshots/` to its own store first (the
    showcase) never serves the two, and may drop them when it stages its
    assets.
- **`dist/qed64-build.json`** `{schema: "qed64.build/v1", buildId,
  leanVersion, sourceRevision, commit, dirty, shell, apiRevision,
  embedApiRevision}`.
  - `embedApiRevision`: the `qed64/embed` barrel's `EMBED_API_REVISION`
    (§7); additive, so `qed64.build/v1` readers ignore it.
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

The page tier's consumer today is the widgets showcase (§6 has the whole
picture). It builds QED64's shell from the QED64 sources it pins (`npm run
build:site` in its submodule), serves that `dist/` at its origin root, and
frames it as `/?embed=1&snapshots=snapshots/<overlay>#code=…`, driving it only
through the page API (§2) and reading `dist/qed64-build.json` (§4). A new
page-tier embedder does the same: §6.1 (b).

These hold already:
- **Cross-origin isolation.** QED64 needs `crossOriginIsolated`. The top
  document must send COOP `same-origin` and COEP `require-corp`.
  - A same-origin frame inherits `cross-origin-isolated`.
  - A cross-origin frame (v1.1) needs `allow="cross-origin-isolated"`.
  - Clipboard access needs `allow="clipboard-read; clipboard-write"`.
- **One QED64 per top-level page** (HARDENING #55).
- **Encoding and ranges.**
  - No `Content-Encoding` on runtime chunks or `.snapz`. They are hashed and
    sized as served. `.snapz` and a v2 runtime's parts
    (`org.lean-browser64.runtime/v2`) are already gzip, and the worker
    inflates them after the check. Serve them as `application/octet-stream`
    under their own names (`.part-NNN`, `.snapz`), never renamed `.gz`
    (HARDENING #19).
  - `Range` support on `.snapz` is recommended, so an interrupted first visit
    can resume.
- **Missing artifacts 404.** A missing `index.json` or manifest must 404,
  never fall back to HTML (an HTML answer is classified `missing`, §7.2).

v1.1 adds:
- a postMessage transport for cross-origin iframes. It needs a deployment
  allowlist served as `/embed-config.json`, never URL parameters;
  `frame-ancestors` and `Cross-Origin-Resource-Policy: cross-origin` on the
  HTML shell only; and a statement that cross-site frames get partitioned
  storage (a separate ~460 MB first visit);
- `layout=split|stack|auto` and an embed `escape` key event (`#codez=`
  landed with HARDENING #77).

---

## 6. The library: the `qed64` npm package

The three consumers hold QED64 in these ways (checked 2026-10-06 in their
repositories, lean4game's cells again on 2026-11-01, and the proof sheets'
cells on 2026-11-01 at `website-v4.35` 5468694):

| | lean4game (library tier) | the proof sheets (library tier) | the widgets showcase (page tier, and the tools) |
|---|---|---|---|
| holds QED64 as | an npm **git dependency** pinned by a full SHA: `"qed64": "github:FawadHa1der/QED64#<40-hex>"` in `client/package.json` (branch `wasm64-port`). npm fetches the codeload tarball, with no git or SSH needed, and honours `files`. | the same kind of **git dependency**, in `website/site/package.json`; `website/build.sh` refuses a `sources.json` QED64 commit that the lockfile does not resolve | a **git submodule**, `deps/qed64`, checked out at the pinned commit (`pins/<id>/QED64.lock.json`); a pin under test is a worktree of that submodule |
| imports | `qed64/embed` only: every runtime name it uses is in §7.0 (`tests/unit/embed-barrel.test.ts` pins the list). Its tsconfig maps `qed64/embed` to closure.json `entry`, and `scripts/stage-workers.sh` checks that mapping against the installed package. Its tests also load `lib/edit-coalescer.ts` by path (`client/src/wasm/game-translation-guard.test.ts`), an internal path (§9). | `qed64/embed`: twelve runtime names, among them `chooseSnapshots`, `importedModulesOf`, `initialBytesForEntries` and `DEFAULT_MAXIMUM_BYTES` (§7.0; `tests/unit/embed-barrel.test.ts` pins the list), under `moduleResolution: "bundler"`; and `qed64/edge`: its Cloudflare Worker is `createWorker` with its release record; its relay tests bundle `lib/lsp-relay.ts` by path (`website/site/test/stubs/qed64-embed-real.mjs`), an internal path (§9) | nothing from `qed64/embed`. Its Cloudflare Worker reuses QED64's edge code: `qed64/edge` (§6 exports, docs/DEPLOY.md "Using qed64/edge in your own Worker") was cut for it; today the Worker imports `isImmutable` from the submodule's `infra/worker.js`. |
| workers | `scripts/stage-workers.sh` copies closure.json `workers` into `client/public/workers/` (exactly that set) and compares `runtime.minKernelPatch` with its own kernel pin | `website/site/scripts/stage.mjs` copies closure.json `workers` into `public/workers/` before every dev start and build, and adds the course's Lean options to the staged `lean.worker.js` | the shell's `dist/workers/` |
| editor | its own page: lean4monaco's client, behind its translation layer, on `LspRelay.clientPort` (§7.9) | its own page: the Waterproof editor (CodeMirror) and `@leanprover/infoview`, on `LspRelay.clientPort` | QED64's own page in an iframe, `?embed=1` (§3) |
| pipeline CLIs (docs/CLI-CONTRACT.md) | `wasm/build-from-source.sh` runs bake-snapshot and snapshot-probe from `node_modules/qed64` (or `$QED64_DIR`); its trees and runtime come from the lean4-wasm64 package | `website/build.sh` runs bake-snapshot from `node_modules/qed64` (or `$QED64_DIR`); its bake fingerprint hashes that package's `pipeline/snapshot/node-runner.mjs`, so a change there means a rebake | bake-snapshot, snapshot-probe, supervised-run, preflight and olean-imports, from the submodule |
| Vite | a COOP/COEP middleware, `optimizeDeps.exclude: ["qed64"]`, `__QED64_BUILD_ID__` defined from its runtime manifest | a COOP/COEP middleware and `optimizeDeps.exclude: ["qed64"]`; its dev and preview servers serve `/runtime/` and `/snapshots/` from its build output | — (it builds QED64's own `frontend/`) |

The package:

`package.json` (pinned by `tests/unit/package-contract.test.ts`):
- `"license": "MIT"`, zero runtime dependencies, and `"sideEffects":
  ["./public/workers/memory64-probe.js"]`: every module is side-effect free
  except the probe script, which `lib/client.ts` imports for its side
  effect (§7.0). Under `"sideEffects": false` Vite drops that import, and the
  built page throws reading the probe at load.
- **No script npm treats as "prepare me".** pacote runs `npm install
  --include=dev` in a temporary clone of a git dependency whose root
  `package.json` has `workspaces`, or any of `build`, `prepare`, `prepack`,
  `preinstall`, `install` or `postinstall`. QED64's build script is therefore
  `build:all`, and CI uses `build:site`.
- `exports`:
  - `"./embed"` → `lib/index.ts` (closure.json `entry`);
  - `"./edge"` → `infra/edge-worker.js` (types `infra/edge-worker.d.ts`):
    the edge-worker library of docs/DEPLOY.md, dependency-free;
  - `"./workers/*"`;
  - `"./pipeline/*"`;
  - `"./embedding/closure.json"`;
  - `"./package.json"`.
- `files`: exactly the closure below, plus the license, README and this
  document (`npm pack --dry-run` lists them). `npm run test:consumer`
  (tests/consumer/check-consumer.mjs) proves the packed files alone resolve
  and build.

Notes for consumers:
- **Copied workers go stale on a pin bump.** A consumer that copies
  closure.json `workers` into its own public directory (lean4game's
  `scripts/stage-workers.sh`, §6.1 step 3) must re-stage them after every
  pin bump. Run the copy before every build and dev start, not once after an
  install: installing the new pin leaves the old copies in place, and a plain
  build serves them (§6.1 step 3 has a `prebuild` example). Scripts from two
  pins of different `REVISION`s are refused at run time as
  `WORKER_DEP_MISMATCH`, kind `stale`. A whole set from the previous pin is
  not refused.
- The embed closure is TypeScript source with **relative imports only** (no
  bare specifiers, no `node:`). A bundler transpiles it (Vite does; `tsc`
  needs `moduleResolution: "bundler"`).
- Node's own type stripping refuses `.ts` under `node_modules`, and the closure
  uses parameter properties. A Node test runner needs a transpile hook.
- The pipeline scripts imported through the package resolve a relative
  `--work` or `--out` against the **package root**, which is inside
  `node_modules`. Run them from a copy, or pass absolute paths. Every path a
  tool needs comes from its flag, else its variable (`QED64_LEAN_ARTIFACT`,
  `QED64_WORK`, `QED64_STAGING`, `QED64_LIB_TREE`), else a deprecated default
  under that root with one WARNING, else exit 2 (docs/CLI-CONTRACT.md "Path
  resolution"); pass them all and nothing lands in the package.
- `pipeline/release/fetch-artifacts.mjs` (tier 1) ships, but the tracked
  manifests it reads do not (the profile manifests are 12 MB): run it with
  `--manifests <a QED64 checkout's public/ at your pin> --out <your
  publicDir> --with-manifests` to get QED64's own served set, verified, for
  §6.1 step 4. Without `--manifests` it refuses (exit 2) before writing
  anything (docs/CLI-CONTRACT.md "fetch-artifacts").
- The page-API setup (`globalThis.qed64.api`, the `qed64:*` events, `#code=`,
  the buffer) lives only in site modules that are not in the package.

`embedding/closure.json` (schema `qed64.closure/v1`) lists:
- `embed`: the TS closure of `qed64/embed`, the 11 files of `lib/`:
  `index.ts` (the barrel, `entry`), `params.ts`, `failure.ts`,
  `qed64-boot.ts`, `raw-cache.ts`, `urls.ts`, `resident-session.ts`,
  `edit-coalescer.ts`, `lsp-relay.ts`, `client.ts` and `snapshots.ts`. They import only each other, plus `client.ts`'s
  side-effect import of `../public/workers/memory64-probe.js`;
- `workers`: `{path, serveAs}`. `lean.worker.js` `importScripts`
  `lsp-frames.js`, `memory64-probe.js`, `worker-constants.js` and
  `lsp-front-door.js` from its own directory, so all six ship together.
  `memory64-probe.js` is also in the embed closure's reach: `lib/client.ts`
  imports it for its side effect (it publishes `globalThis.Qed64Memory64`,
  the probe of §7.0);
- `infra`: the edge-worker library behind `qed64/edge`;
- `pipeline` and `pipelineData`;
- `runtime.minKernelPatch`: `"0032"`, the oldest kernel patch level these
  workers drive correctly. Compare it against your release.json
  `kernel.patch` (lean4-wasm64's `comparePatchIds` ordering: `NNNN`, then an
  optional lowercase suffix; QED64 pins its own in
  `toolchain/lean4-wasm64-release.json`);
- `runtime.manifestSchemas`: the runtime manifest schemas the worker reads,
  today `["org.lean-browser64.runtime/v1", "org.lean-browser64.runtime/v2"]`
  (v2: gzip runtime parts, §7.7). It refuses any other schema, or a file
  `encoding` it does not read, before it fetches a byte
  (`RUNTIME_MANIFEST_MISMATCH`, §7.2). A consumer pairing these workers with
  its own runtime compares that runtime's schema with this list at staging,
  as it compares `kernel.patch` with `runtime.minKernelPatch`: release.json
  `runtime.schema` when the record carries it, else `runtime-manifest.json`
  `schema` (absent = v1). A closure without the key reads v1 only;
- `workerProtocol`: §7.7.

### 6.1 Minimal Vite consumer

`tests/consumer/fixture/` is the runnable form of this section: `npm run
test:consumer` packs QED64, installs the tarball into a scratch consumer and
type-checks and builds the fixture with Vite against it (`main.ts`: the
capability check; `headless.ts`: the boot below; `worker.ts`: a Worker on
`qed64/edge`; `vite.config.mjs`: step 2's settings), together with the (a)
code block below, extracted verbatim from the packed `docs/EMBEDDING.md`.

**Both shapes need the same four things.**

1. **The dependency.** In `package.json`:
   `"qed64": "github:FawadHa1der/QED64#<40-hex>"` (a pushed commit: §1,
   principle 6).
   TypeScript reads the `exports` map under `"moduleResolution": "bundler"`,
   which gives `qed64/embed` its types (the closure is `.ts` source). Under
   `"node"`, add a `paths` entry from `qed64/embed` to closure.json `entry`
   (`node_modules/qed64/lib/index.ts`), as lean4game does,
   and re-check it on each bump (its `scripts/stage-workers.sh` does).
2. **Cross-origin isolation and Vite's pre-bundler.** The top document must
   be `crossOriginIsolated` (§5), in development too:

   ```js
   // vite.config.js
   const isolate = (_req, res, next) => {
     res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
     res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
     next();
   };
   export default {
     plugins: [{
       name: "cross-origin-isolation",
       configureServer: (server) => { server.middlewares.use(isolate); },
       configurePreviewServer: (server) => { server.middlewares.use(isolate); },
     }],
     optimizeDeps: { exclude: ["qed64"] },   // serve the closure as source modules, as lean4game does
     build: { target: "es2022" },   // top-level await, as in (a); every Memory64 browser has it (Vite's default target does not)
     // optional: define: { __QED64_BUILD_ID__: JSON.stringify("<runtime buildId>") } makes the boot ask for
     // /runtime/runtime-manifest.<buildId>.json first (docs/DEPLOY.md "Atomic deploys"); without it the
     // boot reads the mutable /runtime/runtime-manifest.json.
   };
   ```

   In production your host sends the same two headers on the HTML (with
   `qed64/edge`: `createWorker` does, docs/DEPLOY.md).
3. **The workers at `/workers/`, re-staged before every build.** Copy
   closure.json's `workers` (all six: `lean.worker.js` loads its siblings
   from its own directory, §6) to the `serveAs` paths. The copies in your
   public directory are generated files (gitignore them): installing a new
   pin does not refresh them, and a build serves whatever they hold.
   lean4game found exactly that: after a pin bump a plain build shipped the
   previous `lean.worker.js` beside the new library. So stage them as a step
   of every build and every dev start, not once after an install:

   ```js
   // scripts/stage-qed64-workers.mjs: the prebuild/predev step below
   import fs from "node:fs";
   import path from "node:path";
   import { createRequire } from "node:module";
   const pkg = path.dirname(createRequire(import.meta.url).resolve("qed64/package.json"));
   const closure = JSON.parse(fs.readFileSync(path.join(pkg, "embedding/closure.json"), "utf8"));
   if (closure.schema !== "qed64.closure/v1") throw new Error(`closure schema ${closure.schema}`);
   fs.rmSync("public/workers", { recursive: true, force: true });   // exactly the closure's set
   for (const { path: from, serveAs } of closure.workers) {
     if (!serveAs.startsWith("/workers/")) throw new Error(`unexpected serveAs ${serveAs}`);
     fs.mkdirSync(path.dirname(`public${serveAs}`), { recursive: true });
     fs.copyFileSync(path.join(pkg, from), `public${serveAs}`);
   }
   ```

   ```json
   {
     "scripts": {
       "stage:qed64": "node scripts/stage-qed64-workers.mjs",
       "predev": "npm run stage:qed64",
       "prebuild": "npm run stage:qed64",
       "dev": "vite",
       "build": "vite build"
     }
   }
   ```

   npm runs `prebuild` before `npm run build` and `predev` before `npm run
   dev`. A pipeline that calls `vite build` directly runs the staging script
   first itself. (These hooks belong in your package. QED64's own
   `package.json` has no `build` or `prepare` script, §6, because npm would
   then build QED64 as a git dependency.)

   The worker revision is checked at run time, so a mixed set (scripts from
   two pins, of different `REVISION`s) is refused: the session dies with
   `WORKER_DEP_MISMATCH`, cause kind `stale` (§7.2, §7.7), and the page
   should offer a reload. A whole set left from the previous pin carries one
   revision, so it is not refused. It runs, and you are serving the previous
   pin's workers under the new library, which only re-staging prevents.
   `npm run test:consumer` runs this script, from the packed copy of this
   document, over a stale set in a scratch consumer.
4. **The artifacts at `/runtime/` and `/snapshots/`,** on the page's origin
   (§4 "Page-tier facts"; an off-origin source is refused, §11): the runtime
   manifest and its chunks, the snapshot index and its `.snapz` regions,
   served without `Content-Encoding` and with `404` for anything missing
   (§5). No library pack is read since D1; the stock page alone also reads
   the two pack manifests under `/profiles/` for import completion (a
   missing one only narrows it). The snapshots are binary-paired to the
   runtime: serve them as one set (docs/DEPLOY.md "Consistency rule"). In
   development, put them in Vite's `publicDir` (and add them to
   `server.watch.ignored`; they are gigabytes); in production,
   docs/DEPLOY.md is the layout QED64 itself serves (the shell and its two
   indexes as Workers static assets, everything else in R2, behind
   `qed64/edge` on one origin).

**(a) Without the editor: drive a session headlessly.** Your code is the
language client. It boots a `ResidentSession` behind an `LspRelay` and
speaks JSON-RPC on `relay.clientPort` (§7.9). A module with top-level
`await`, so it needs step 2's `build.target`. `npm run test:consumer`
type-checks and builds this block as written (it reads it from the packed
copy of this document); `tests/consumer/fixture/headless.ts` is the same
boot inside an async function, with an `edit()`:

```ts
import { LspRelay, MEMORY64_PROBE, ResidentSession, installArtifacts, makeEditorPolicy, type StatusSink } from "qed64/embed";

if (!crossOriginIsolated || !WebAssembly.validate(MEMORY64_PROBE)) throw new Error("needs COOP/COEP and Memory64");
const ui: StatusSink = {   // progress as data (§7.1)
  busy: (label, info) => console.log("busy", label, info?.stage),
  progress: (label, info) => console.log(label, info?.loaded, info?.total),
  idle: (label) => console.log("idle", label),
};
const artifacts = await installArtifacts(ui, { overrides: "none" });   // manifest, snapshot index
const policy = makeEditorPolicy(artifacts.snapshots);                    // snapshots and memory per header
let current = "import Mathlib\n\nexample : 2 + 2 = 4 := by norm_num\n";   // what a (re)boot serves
const relay = new LspRelay(
  (opts) => new ResidentSession({ artifacts, ui, policy, headerText: current }, opts ?? {}),
  { status: (s) => console.log(s.relay, s.phase, s.lastDeath?.cause?.kind ?? "") },   // deaths, §7.2
  () => new Promise((r) => setTimeout(r, 1500)),
);
addEventListener("pagehide", () => relay.unload(), { once: true });

const port = relay.clientPort, uri = "file:///project/Probe.lean";
port.onmessage = (e) => { if (e.data.method === "textDocument/publishDiagnostics") console.log(e.data.params.diagnostics); };
port.postMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
port.postMessage({ jsonrpc: "2.0", method: "initialized", params: {} });
port.postMessage({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "lean4", version: 1, text: current } } });
// an edit: update `current`, then a full-text didChange (coalesced, §7.8)
```

The relay keeps the document across reboots and replays it, so the port is
the only connection you make (§7.9). A page that wants files beside the
document, or one step before the loop opens, passes `files` /
`beforeArm` in the `ResidentSession` host (§7.3).

**(b) With the editor.** Two ways:
- **QED64's own page in an iframe** (page tier). Build QED64's shell
  (`npm run build:site` in a QED64 checkout at the pinned commit; it writes
  `dist/` and `dist/qed64-build.json`), serve it at your origin root beside
  the artifacts above, and frame `/?embed=1` (§3). Drive it through
  `globalThis.qed64.api` (§2): `setDocument`, `settled`, the `boot`,
  `diagnostics` and `death` events. Same origin only in v1 (§1.5). This is
  the widgets showcase's shape.
- **Your own page with lean4monaco** (library tier). Boot exactly as in (a),
  then hand `relay.clientPort` to the language client instead of posting
  on it yourself. With lean4monaco, the `WorkerDirect` connection the stock
  page uses (`frontend/src/main.ts`):

  ```ts
  await leanMonaco.start({
    websocket: { $type: "WorkerDirect", worker: { postMessage() {} }, messagePort: relay.clientPort } as unknown as { url: string },
    // ...your vscode settings
  });
  ```

  lean4game does this behind a translation layer of its own
  (`GameTranslation.attachServer(relay.clientPort)`). The InfoView's static
  files (`@leanprover/infoview/dist`, lean4monaco's `webview.js`) are
  lean4monaco's to serve: copy them as QED64's `frontend/vite.config.ts`
  and lean4game's `client/vite.config.ts` do.

---

## 7. The library API: `qed64/embed`

`EMBED_API_REVISION` is the semver of this section (minor = additive; a
break is the next major, with a migration note in §12; §1). A built shell
records it as `embedApiRevision` in `dist/qed64-build.json` (beside the page
API's `apiRevision`), so a deploy or pin tool reads which library contract a
dist was built from without opening the bundle.

### 7.0 Exports

Every value export of `qed64/embed` is named below (and
`EMBED_API_REVISION` above), and the contract holds every type their
signatures use (lean4game imports `SnapshotEntry`, `Qed64Artifacts`,
`PrefetchRawResult`, `StatusSink`, `ProgressInfo`, `BootOverrides` and
`FailureCause`; the proof sheets `SnapshotEntry`, `Qed64Artifacts`,
`StatusSink` and `ProgressInfo`); one marked `@internal` is outside the
contract (§9). `tests/unit/embed-barrel.test.ts` checks the value exports and
pins the names lean4game, the proof sheets and the stock page import.

- **runtime:** `LeanSession`, `probeMemory64`, `MEMORY64_PROBE`
  (the 13 probe bytes `probeMemory64` and the worker validate; a fixed-shape
  `Uint8Array`, read-only by convention: refuse an incapable browser before
  loading anything with `WebAssembly.validate(MEMORY64_PROBE)`), and the
  types. Both come from one file, `public/workers/memory64-probe.js`: a
  classic script that publishes `globalThis.Qed64Memory64 = { MEMORY64_PROBE,
  probeMemory64, REVISION }` (frozen). `lean.worker.js` `importScripts` it
  for its capabilities report, and `lib/client.ts` imports it for its
  side effect and re-exports the two members, so a page's check is the
  worker's, byte for byte.
- **snapshots:**
  - the index: `loadSnapshotIndex` (throws, naming the fault) and
    `snapshotCacheKey`;
    ```ts
    loadSnapshotIndex(url = "/snapshots/index.json", opts?: IndexOptions): Promise<SnapshotIndex>;
    interface IndexOptions {
      allowCrossOrigin?: boolean; // default false: the index and its entry URLs must be on `origin`
      origin?: string;            // default location.origin
      pairedBuildId?: string;     // the runtime the page boots ("wasm64-" + 16 hex; anything else is ignored)
    }
    ```
    With `pairedBuildId` (HARDENING #64): the index at `url` is read as
    without it; when an entry's `runtime` names another runtime,
    `<directory of url>/index.<pairedBuildId>.json` is read with the same
    checks and returned when every one of its entries is paired with
    `pairedBuildId`. A 404, HTML, a network error, a malformed body or a
    copy that is empty, mixed or of another runtime keeps the index at
    `url`, and the boot then refuses its unpaired entries as it always did
    (`SNAPSHOT_UNPAIRED`, §7.2). A paired index, an index without `runtime`
    fields and a missing one (which still throws) cost no extra
    request; without the option nothing changes. `installArtifacts` and
    `fetchSnapshotIndexFor` pass the shell's own `__QED64_BUILD_ID__`; a
    page that reads the index itself (lean4game's game boot) passes the
    buildId of the runtime it boots (the one it pins, or its runtime
    manifest's `buildId` once resolved). lean4game's boot catches the
    off-site refusal (`SNAPSHOT_URL_REFUSED`) to raise its own coded SEC1
    refusal. The option reads a copy only where the site publishes one
    (§4);
  - the overlay helpers of §8, pure functions of an index (`base` defaults
    to `BASE_SNAPSHOTS`, `["init"]`, the entries every session loads first;
    an entry's roots are read as §8 says, so a rootless `mathlib` has the
    umbrella's):
    - `chooseSnapshots(index, modules, base?)`: the boot list for a header's
      modules, by §8's "Boots" rule: the base plus the smallest entry whose
      roots cover every module the base does not (`Init` needs none), else
      the one covering the most (ties: the smaller), else the base alone. It
      matches roots, not the order of the imports;
    - `widenTarget(index, missing, loaded, headerModules?, base?)`: the entry
      §8's "Widens" rule restarts a session onto after the kernel refused
      `missing` with `loaded` loaded (the smallest entry not loaded that
      covers every missing module and every header module some entry claims
      and the base does not), or null;
    - `initialBytesForEntries(index, names, base?)`: §8's "Sizes" rule: the
      largest `initialBytes` an entry among `names` declares (capped at
      6 GiB), else 2 GiB with any non-base entry, else 256 MiB; `index` may
      be null;
    - `coversModule(roots, module)`: whether `module` is a root or lies
      under one on a component boundary;
    - `entryLabel(entry)`: the pill and card name: `label`, else `Mathlib`
      for `mathlib`, else the name.
- **raw cache (§7.4):** `prefetchRaw`, `isRawCached`, `removeRawRegion`,
  `isCacheKeyOf`, `SNAPSHOT_CACHE_DIR` and `PREFETCH_SILENCE_MS`.
- **boot:** `installArtifacts`, `resolveRuntimeManifest`,
  `fetchSnapshotIndexFor` and `loadSnapshotByName`.
- **parameters:** `validateBootOverrides` and `BootParamError` (`code:
  "BOOT_PARAM_REFUSED"`, `param`).
- **session:** `ResidentSession`, `ResidentPolicy`, `ResidentHost`,
  `SessionFile`, `makeEditorPolicy(index)` (the stock page's policy over a
  served index, §8; `null` gives the policy without one),
  `DEFAULT_MAXIMUM_BYTES` (6 GiB: the reservation ceiling, `maximumBytes`,
  that policy sets and a `ResidentSession` uses when its policy sets none)
  and `importedModulesOf(headerText)` (the module each import line names,
  the first if a line names several, in order; an `import` with nothing
  after it yields nothing).
- **relay:** `LspRelay` (its contract members in §7.9: `clientPort`,
  `unload()`, `status()`, `rearm()`, `restart()`), `RelaySession`,
  `RelayStatus`, `RestartOptions` and `Death`.
- **causes (§7.2):** `failureCauseOf`, `deathCause`,
  `WORKER_SCRIPT_LOAD_FAILED` and `ENGINE_STACK_OVERFLOW` (a stale cause's
  code is the string `"WORKER_DEP_MISMATCH"`, §7.2: compare with the
  literal).
- **offline:** `runtimeUrls(manifest)` and `WORKER_URLS`.
- **internal re-exports** (`/** @internal */` in the barrel):
  `LEGACY_UMBRELLA_ROOTS`, the roots the stock page gives a rootless index
  entry named `mathlib` (§8). It stays in the barrel but outside the
  contract: its contents follow the served umbrella (R1). It is also the
  editor's policy without an index, so it does not leave with D10. The
  eleven that `1.0.0-pre.5` marked left the barrel: three with D1 in
  `1.0.0-pre.10`, the other eight in `1.0.0-pre.11` (the rows are in
  `docs/history/EMBEDDING-PRE-V1.md`).

### 7.1 Structured progress

`ProgressInfo` has these fields:
- `stage`: a `BootStage`, one of `manifests | profile | runtime | memory |
  snapshot | modules | warm | files | done | failed` (`profile` and `warm`
  are not emitted since D1);
- `subject`: a snapshot name or runtime file;
- `step`: `check | download | inflate | commit | verify | read | load | init
  | write`;
- `error`: a `FailureCause`;
- the legacy `phase`, `loaded`, `total` and `unit`.

`StatusSink.busy(label, info?)`. Every call QED64 makes carries `stage`.

Units:
- `loaded`/`total` cover **the whole stage**. The runtime reports one combined
  total across `lean.js` and `lean.wasm`, in bytes as served (a v2 runtime's
  gzip parts count their wire bytes, not the decoded size); `subject` names
  the current file.
- For a snapshot, `loaded` is the bytes of the **inflated** region written so
  far and `total` is the entry's raw size.
- `step: "inflate"` means the source is a local compressed copy (no network).
- A `snapshot`/`download` call without `loaded` is `onBusyWait`'s wait for
  another tab's writer (§7.4). A call that downloads carries `loaded`, `0`
  before the first byte.

### 7.2 Failure causes and deaths

```ts
type FailureKind = "network" | "missing" | "corrupt" | "unpaired" | "oom" | "storage" | "stale" | "other";
interface FailureCause { kind: FailureKind; httpStatus?: number; stage?: BootStage; subject?: string; code?: string; message: string; line?: number }
```

| kind | meaning | e.g. |
|------|---------|------|
| `network` | the fetch was rejected, the stream was cut, the body ended before the bytes it announced, or 5xx/429 (retrying can help) | `Failed to fetch`, `HTTP 503`, `the transfer of <file> ended early: received <n> of <expected> bytes` |
| `missing` | the server does not have it: a deploy problem, so retrying cannot help | every 4xx except 408/425/429; an HTML answer where JSON or binary belongs (the workers and the index loader sniff it); `SNAPSHOT_NOT_IN_INDEX` |
| `corrupt` | it arrived in full but is wrong | chunk length or SHA-256 mismatch; a runtime chunk served with a `Content-Encoding`, refused on its response headers, before the body is read (`<label> chunk <n> was transformed by Content-Encoding: <enc>.`; `RUNTIME_FETCH_FAILED`); a gzip/DecompressionStream error of a body that arrived in full; "not a compacted-region file"; a size the index does not declare; "raw size mismatch"; `SNAPSHOT_LOAD_RESULT` (the Lean loader refused the region); `RUNTIME_MANIFEST_MISMATCH` (a runtime manifest whose `buildId` is not `wasm64-` + the first 16 hex digits of its own `files["lean.wasm"].sha256`: the runtime/v1 and v2 invariant (over the decoded `lean.wasm`) every reader may check; the page refuses it before fetching, the worker before booting; also a manifest whose `schema`, or a file's `encoding`, this worker does not read (`closure.json` `runtime.manifestSchemas`, §7.7), or a v2 manifest whose parts' `decodedBytes` break the format, refused before anything is fetched); a v2 runtime part that passed its SHA-256 but does not inflate, or inflates to another size than its `decodedBytes` (`RUNTIME_FETCH_FAILED`; not refetched: it was served as pinned) |
| `unpaired` | a snapshot baked by another runtime build | `SNAPSHOT_UNPAIRED` |
| `oom` | an allocation or reservation failed | `MEMORY_FAILED`, `could not allocate`, `Cannot enlarge memory` |
| `storage` | OPFS or quota | `QuotaExceededError` |
| `stale` | the site was deployed under this page: the worker scripts it loaded are of different revisions (§7.7), or a lazily imported chunk of the page's own bundle (`/assets/<name>-<hash>.js`) could not be fetched (the browser's `Failed to fetch dynamically imported module: …/assets/…`; a deploy that replaced the assets under the open page explains it, and a connection cut during that import reads the same; HARDENING #74). **Reload the page.** A lost chunk is a boot failure (`stage: "failed"`, `boot.failed`, every `settled()` waiter rejects): nothing serves until the reload. For the worker scripts, retrying in place does not help: the relay heals by itself (its replacement worker loads the new scripts, and the relay replays `initialize` and the document, so the language client never re-initializes), but it then serves under this page's older bundle, which holds only while the worker protocol changes additively | `WORKER_DEP_MISMATCH` (`code` is always the string `"WORKER_DEP_MISMATCH"`: compare with the literal) |
| `other` | the checker's own failure, with **one exception**: `code: "WORKER_SCRIPT_LOAD_FAILED"` means a worker script never ran, which looks the same offline as on a 404, so probe the link | `abort`, `wedged`, `SNAPSHOT_URL_REFUSED`, `ENGINE_STACK_OVERFLOW` |

An `unpaired` failure is decided by the page wherever it holds both facts,
the index entry's `runtime` and the runtime manifest's `buildId`: the same
cause and projection as the worker's refusal, now without the runtime
starting or a byte of the snapshot downloading (the session's Worker object
is created and disposed, but no `boot` request, `lean.wasm` fetch or
Memory64 reservation happens; `ResidentSession.start()` rejects first;
`loadSnapshotByName` returns false before fetching; an entry without
`runtime` is still the worker's to decide; HARDENING #62).

A boot that fails with a `network` cause is remembered by the page for 60 s
(per snapshot, in module state every session shares): the next session, the
relay's reboot, downloads each pre-open snapshot the cache lacks before it
boots its runtime, and rejects with the download's `network` cause before
any runtime exists, so a lasting cut costs the relay's three retries one
runtime, not three. A first attempt and a cached snapshot boot as before
(HARDENING #63).

A body that ends early is `network`, whatever a decoder then says about
the short input: both snapshot streams (the raw prefetch and the Lean
worker's own) count the compressed bytes against the response's
Content-Length (both also against the index entry's `transfer` when there
is none and the body is gzip) and fail a short one with "the transfer of
<file> ended early: received <n> of <expected> bytes". `corrupt` means the bytes
arrived in full and failed a check (HARDENING #63, follow-up 1).

Classification is per throw, from the error code **and** message:
`RUNTIME_FETCH_FAILED` covers a 404, a cut and a SHA mismatch alike. The page
classifies, so the same table holds against every worker version.

A lost chunk is `stale` only when its URL has an `/assets/` segment (Vite's
default `assetsDir`). A module under another path is `network`, in Chrome's
words and in Firefox's (`error loading dynamically imported module: <url>`),
unless its URL holds a word an earlier rule matches: the classifier reads the
whole message, so `/lib/gzip.js` reads `corrupt`. A 404 reads `network` too,
because its words are the same as a cut's. This `network` is the exception to
"retrying can help": the module map keeps the failure for the document, so only
a reload recovers it.

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
- An uncoded death whose words name an engine-stack overflow ("Maximum
  call stack size exceeded", "too much recursion") is `other` with `code:
  "ENGINE_STACK_OVERFLOW"` (exported as `ENGINE_STACK_OVERFLOW`): the
  worker turns a Lean thread's overflow into one death named so (HARDENING
  #72). Its `line`, when known, is the 0-based line Lean was checking (the
  first processing range, not a fatal error, of the last
  `$/lean/fileProgress`), in the coordinates of the document the relay
  forwarded: a consumer that translates its text (lean4game's offset) maps
  it back. No other cause sets `line`. The relay does not reboot it: it
  **pauses** at once (`relay: "halted"`, not counted toward the breaker,
  restart options kept). The contract:
  - **Recognize** the pause as `relay === "halted" &&
    lastDeath.cause.code === "ENGINE_STACK_OVERFLOW"`.
  - **The note**: one severity-1 diagnostic, source `QED64`, `code:
    "ENGINE_STACK_OVERFLOW"`, on `line` (else the first import line, else
    line 0): "Lean ran out of the browser's stack while checking here, so
    checking is paused. A browser gives Lean far less stack than desktop
    Lean has, so the proof may still be correct. Edit the file to check it
    again."
  - **The reply** to a request while paused: `reason: "stack limit"`
    (below). The page API's `settled()` rejects `HALTED` in the pause's
    words.
  - **Resume**: any `didChange`, `rearm()`, or the page API's `restart()`
    with no arguments (with `snapshots` or `initialBytes` it answers
    `accepted: false` while halted, as for the breaker). A `didOpen` of
    another document does not resume: a consumer that switches documents
    calls `rearm()`.
- Every other death is `other`, or `oom` when its message says so.
- A death while booting carries the boot `stage`. Booting lasts until the
  relay's `arm()` resolves, so a death during the replay and the arm carries
  `files`, the last stage.
- Every `bootFailed` death carries a cause: the step's own (runtime,
  snapshot), or one classified at the step that threw. The host's
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
`error.data.qed64 = {kind: "orphaned" | "halted" | "restart", reason}`. A
halted relay answers every request -32603 with `reason: "repeated crashes"`
(the breaker) or `reason: "stack limit"` (the stack pause: "QED64: checking
paused: Lean ran out of the browser's stack; edit the file to check it
again"). A deliberate restart (`LspRelay.restart`, whoever calls it: a
self-widen, the page API's `restart()`, an embedder) answers each in-flight
request with `kind: "restart"` and `reason: "restarting the checker"`
("restarting with exact imports" before D1, for every restart): match on
`kind`, not on the words. The message prefix `QED64:` stays as a fallback.
`LspRelay.rearm()` re-arms a halted relay without an edit; it returns false
unless the relay is halted.

### 7.3 Session files and the pre-arm hook

```ts
interface ResidentHost {
  artifacts; ui; policy?; headerText;                     // unchanged
  files?: SessionFile[] | (() => SessionFile[] | Promise<SessionFile[]>);
  beforeArm?(session: LeanSession): Promise<void>;
  busyWaitMs?: number;                                    // §7.4; default PREFETCH_SILENCE_MS
  leanOptions?: readonly string[];                        // each boot's Lean options (R3)
  editCoalesceMs?; editBackPressure?;                     // §7.8
}
type SessionFile = { path: string; text: string } | { path: string; bytes: Uint8Array };
```

Both run on **every** boot (first and reboots), after the snapshots,
immediately before the relay arms the loop. The front door
queues every frame until `lsp-arm`, so Lean never sees the document before the
files. `LeanSession.writeFiles(files)` is public. Bytes are copied, not
transferred. A throw from either is a `bootFailed` death whose cause is
classified at `stage: "files"` (a `files()` fetch that fails is `network`; an
`HTTP 404` message is `missing`). The members `ResidentSession` gained in v1
are ECMAScript-private (`#`), so a subclass can keep its own `files` or
`beforeArm` (lean4game's `GameSession`) with no TS2415 collision and no
second write.

A direct `LeanSession` user keeps `arm()` the last runtime step. Until the
loop opens, a `loadSnapshot` after it blocks the worker, and that reads as
heartbeat loss (HARDENING #78); once the loop is open, the worker refuses it
with `BAD_STATE`.

**`busyWaitMs`.** Each boot loads its snapshots through `loadSnapshotByName`,
which first prefetches the raw region with `onBusy: "wait"` (§7.4). While
ANOTHER tab holds that region's writer lock, the boot waits for it at most
`busyWaitMs` (default `PREFETCH_SILENCE_MS`, 3 min; 0 does not wait for that
writer), then re-probes the cache, and if the region is still missing the
session's Lean worker streams it itself (the heavier path the prefetch exists
to avoid, so a short bound trades memory for latency). The bound is counted
from the lock request; the other tab's progress does not extend it.
`loadSnapshotByName` takes the same option as its fifth argument
(`LoadSnapshotOptions`). The member is ECMAScript-private in
`ResidentSession`, like `files`. Separately, the Lean worker's own open of a
finished region retries a busy handle for about 3 s (§7.4).

**`leanOptions`** (architecture review R3). Lean options for the resident
FileWorker, as `name=value` strings (`"autoImplicit=false"`,
`"weak.verso.code.warnLineLength=100"`).
- They are applied on every boot like `files`, never through
  `RestartOptions`, which the relay forgets when the header changes.
- The worker merges them by name over its defaults
  (`public/workers/worker-constants.js`: `server.reportDelayMs=0` for
  latency, `Elab.async=false` for HARDENING #70); yours win, and each `-D`
  appears once.
- A malformed entry or a repeated name fails the boot (`INVALID_MESSAGE`,
  before the worker fetches the runtime; a `ResidentSession` may have
  downloaded snapshots by then: HARDENING #63's pre-boot download). An
  unknown name that is not `weak.`-prefixed is Lean's own header error.
- A worker script older than the field ignores it. The session then fails as
  `stale` (offer a reload) instead of running Lean without your options;
  `ReadyInfo.argv` is the command line the worker will run.
- Code only: there is no URL parameter (HARDENING #57's class).
- `Elab.async=true` is a gated exception: record peak pthreads and pool
  growth on your heaviest content first (HARDENING #70).

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
- **Durable storage.** A fresh write asks `navigator.storage.persist()`
  first and never waits for the answer (HARDENING #75); Firefox may show its
  persistent-storage prompt on a site's first region download. A region found
  cached before the write, a caller the Web Lock answers `busy` (at once,
  after its `busyWaitMs`, or with its wait cut short), and a waiter that
  finds another tab's write done ask nothing; a `busy` or cached answer from
  the prefetch worker itself comes after the ask.
- **It needs the raw size.** The prefetch worker refuses a message without a
  positive `rawBytes` (the entry's `bytes`) with `error` (`corrupt`). Its
  compressed-only mode, which fetched without the redirect and HTML
  refusals, is gone.
- **The Lean worker's read.** `loadSnapshot` opens `<key>.raw` with a
  read-only sync handle (`{mode: "read-only"}`: readers share one where the
  browser knows the mode, and other browsers ignore the member). While
  another context holds the file (an older worker's exclusive handle, or a
  predecessor tab's worker mid-read until Blink terminates it, within about
  2 s), it retries for about 3 s on `NoModificationAllowedError`, or on any
  open error for a file of the expected size. It then logs
  `[boot] raw cache busy: …` and streams the `.snapz` itself. A missing
  `.raw` streams at once. This wait is independent of `busyWaitMs`, which
  bounds the wait for another tab's write.
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
`removeRawRegion(entry)`, `isCacheKeyOf(fileName, index)` (for sweeping
stale bakes) and `SNAPSHOT_CACHE_DIR`.

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
- `workers`: the six worker scripts (`WORKER_URLS`).

### 7.6 Installing artifacts

```ts
installArtifacts(ui, opts?: {
  overrides?: "url" | "none" | Partial<BootOverrides>;   // default "url": ?snapshots/runtime, validated (§4); ?profiles= validated, then ignored
  profiles?: "core" | "none" | string[];                 // accepted and ignored since D1: no library pack, no profile index
  runtime?: RuntimeManifest;                              // already resolved: used as is
  snapshots?: SnapshotIndex | null;                       // already resolved: used as is
});
resolveRuntimeManifest(overrides, { pinnedBuildId? }): Promise<RuntimeManifest>;
fetchSnapshotIndexFor(overrides): Promise<SnapshotIndex | null>;   // a requested overlay that fails is a named error
```

The boot's fetches, in order: the runtime manifest, the snapshot index. The runtime manifest is
the pinned buildId's `/runtime/runtime-manifest.<buildId>.json` first; a
404, a non-JSON answer or a fetch that rejects (a dead link while
`navigator.onLine` is still true, a refusing proxy) is a miss, and the
mutable `/runtime/runtime-manifest.json` decides, its own failure being the
boot's (HARDENING #65). `?runtime=` overrides both. With a pinned buildId
(`__QED64_BUILD_ID__` defined by the bundler, §6.1), a snapshot index whose
mutable path names another runtime is followed by its per-build copy
(`/snapshots/index.<buildId>.json`, §4), used when it is an index paired
with that buildId (through `loadSnapshotIndex`'s `pairedBuildId`, §7.0); a
paired index, and every index without a pinned buildId, is read from its
mutable path only, as before. A `runtime` or `snapshots`
passed in is not fetched. A page that fetches the snapshot index itself
(not through `fetchSnapshotIndexFor` or `installArtifacts`) passes
`pairedBuildId` to get the same order, and its site publishes the copy
derived from the index it serves (§4), or serves its indexes from its own
deploy, as QED64's does, which needs none. installArtifacts also removes, once
and off the boot's path, the OPFS pack store (`qed64-packs/`) and
`localStorage["qed64.opfs.byteCeiling"]` that releases before D1 wrote
(best effort; it never fails the boot).

A game page wants `{overrides: "none"}` (`profiles: "none"` is still accepted), or its own
overrides routed through `validateBootOverrides` (lean4game parses its URL
itself).

### 7.7 Workers: compatibility across deploys

- `/workers/*.js` names are stable. A new worker is a new name.
- **One revision for the five scripts.** `lean.worker.js`, `lsp-frames.js`,
  `lsp-front-door.js`, `memory64-probe.js` and `worker-constants.js` carry
  the same `REVISION`. `lean.worker.js` refuses a sibling of another
  revision (`WORKER_DEP_MISMATCH`, a death whose cause is `stale`, §7.2:
  offer a reload) instead of running mixed versions. It loads
  `lsp-frames.js`, `memory64-probe.js` and `worker-constants.js` eagerly, so
  one that is not served is `WORKER_DEP_MISSING` at script load, before the
  hello.
- **What changes the revision.** It names the interface between the
  scripts, and it changes when a pairing of two versions would misbehave.
  `memory64-probe.js` (2026-10-06, plan step A3c) left it at `"1"`: the
  probe's bytes and check moved out of `lean.worker.js` unchanged, the three
  older scripts talk to each other exactly as before, and the page sees the
  same `capabilities()` reply, messages and `PROTOCOL`. Every mix stays
  safe. An older `lean.worker.js` beside the new set never loads the probe
  and keeps its own copy. A newer one beside an older set finds no
  `memory64-probe.js` and dies `WORKER_DEP_MISSING`: a named cause, not a
  hang or a wrong answer. The page bundles its own copy of the file, so it
  never pairs with a served one. A bump here would only have refused the
  harmless pairing of a new `lean.worker.js` with an old `lsp-frames.js` or
  front door.
  The front door loads lazily, so this check catches a deploy that lands
  between the two loads. A front door that cannot be loaded at that point
  (not served, or the link dropped) is `WORKER_DEP_MISSING`, unrecoverable
  like the eager import (so `WORKER_SCRIPT_LOAD_FAILED`); after either
  refusal the worker drops every later frame and never throws an uncaught
  error the page would read as the checker's crash.
- **The Lean policy (`worker-constants.js`, 2026-11, architecture review R3)**
  holds the resident loop's default command line (`RESIDENT_ARGV`,
  `residentArgv(leanOptions)`) and the thread budget (`LEAN_WORKERS_MAX`,
  `PARKED_DEDICATED`, `leanWorkers(hc)`).
  - `lean.worker.js` and QED64's Node twins read it. A headless driver of
    yours should import it (`import "qed64/workers/worker-constants.js"`
    publishes `globalThis.Qed64WorkerConstants`), never parse
    `lean.worker.js`.
    Your driver applies the thread budget itself, as the worker does:
    `LEAN_WASM_PARKED_DEDICATED = PARKED_DEDICATED` at preRun, then
    `_lean_init_task_manager_using(leanWorkers(n))`.
  - Its arrival left `REVISION` at "1", as `memory64-probe.js` did: an older
    `lean.worker.js` never loads it, and a newer one beside an older set dies
    `WORKER_DEP_MISSING`.
  - A new or renamed export bumps `REVISION`. A changed value does not: it is
    a semantics change (the argv or thread budget your content runs under),
    listed in §12. Re-gate your content at that pin (lean4game's sweep, the
    proof sheets' chrome-check). It is not "breaking" in §1's sense: one argv
    cannot ship as v1 and v2 side by side.
  - Test Lean code of your own that elaborates tactic blocks and runs linters
    on them under the default `Elab.async=false` (HARDENING #70): lean4game's
    `Runner` (its levels' tactic checker) had its linters flag every tactic,
    so no correct proof completed on 8 of 10 games, until it set
    `set_option Elab.async true` on the `Runner` line of its worker document.
  - Messages change additively: `boot`'s `config.leanOptions` and
    `ready.argv` are new optional fields.
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
  Listed today: `compile` (D1, 2026-11). The library no longer sends it,
  and the worker still answers it, and still mounts a `boot`'s `packs`, for
  one more release: a tab of an older release reboots onto the new worker
  and still sends both.
- **Runtime manifest formats.** The worker reads the schemas `closure.json`
  lists under `runtime.manifestSchemas` (today v1 and v2) and refuses any
  other schema, or a file `encoding` its schema does not allow, before any
  fetch (`RUNTIME_MANIFEST_MISMATCH`, `corrupt`). v2 (the fork owns the
  format; its `formats/runtime-manifest.md` gains the v2 section with the
  first v2 release, and this is the shape it accepted on 2026-11-01): each
  file names its `encoding` (`gzip` or `identity`, a closed set) and its
  `bytes`/`sha256` are the decoded file's; each part keeps `url`, `bytes`
  and `sha256` as served and adds `decodedBytes`. Every part but the last
  decodes to exactly 16,777,216 bytes, the `decodedBytes` sum to the file's
  `bytes`, and an `identity` part's `decodedBytes` is its `bytes`; the
  worker refuses a v2 manifest that breaks these before any fetch. It
  verifies each part as served, then inflates a gzip part
  (DecompressionStream) and checks the whole file over the decoded bytes,
  so the buildId rule (§7.2) is unchanged. A worker older than this check
  has no list: on another format it downloads the parts and fails every
  boot on the whole-file size, so consumers check the list at staging (§6).
  A schema joins the list in a QED64 commit before any runtime uses it, and
  leaves it the way a request does (`workerProtocol.deprecated`).
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
  above, `ContentModified` for the ones Monaco rebases). A
  `$/lean/rpc/keepAlive` never waits for a slot either: Lean handles it
  synchronously, ignores one for a session it does not know, and expires an
  RPC session 30 s after its last keep-alive, so one held behind requests
  waiting out a long silent check cost the InfoView its session ("Outdated
  RPC session", -32900, when the check ended). It still waits behind a held
  change (at most the window or the hold's cap). `$/lean/rpc/release` keeps
  its place: a queued call may still use the references it frees. Barriers
  and replays flush the whole queue past the cap. `0` is no cap. Under a
  responsive checker the cap is never reached (the stock page sends four to
  five requests per keystroke, answered in milliseconds); under one that
  is not, the requests wait here instead of each on its own thread there.
- The session logs each hold, release and cap to the console
  (`[qed64] edit back-pressure: …`) and keeps a record
  (`ResidentSession.backPressure`: `holds`, `releases`, `caps`, `waits`
  (requests that waited for a slot), `cancelled`, `superseded`).
- The cost: under pressure an edit waits for the pool, up to the cap, and
  the InfoView follows when the change goes; past the cap a request waits
  for a reply to an earlier one. That trades latency for a smaller pool:
  without the hold it grew by 12-13 Workers in the first 4-7 s of typing,
  about one per keystroke at its fastest, and never shrank (R16: 24 → 36-37
  on `pagelong`, 24 → 26 with it; docs/HARDENING.md #59). Measured with the
  edit-storm lane's `pageslow` scenario, the typing above: see
  docs/HARDENING.md #59 (addendum).
- What it does not do: it keys on the pool and on the requests, not on the
  work. Threads taken before the pool was pressured run to their end, and a
  single command that spawns more threads than the pool has free is out of
  its reach. That gap is accepted: no kernel cap on live threads is coming,
  since no safe one exists (docs/HARDENING.md #55, the note of 2026-11-01).
  The worker's thread budget (#69) and synchronous elaboration (#70) limit
  the other known sources of threads. A document or an embedder that turns
  `Elab.async` back on gives up the second, and should measure its own
  thread growth.

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
- **`settle`** is the one wait the relay makes: it awaits it after
  disposing a session and before booting the replacement, on every
  `restart()`, death reboot and `rearm()` (never on the first boot, and a
  page reload is no reboot). The stock page passes 1.5 s; lean4game passes
  its own 1.5 s; the proof sheets pass 2 s. On a `restart()` of a runtime
  that is still alive, the value also decides what compiled code the new
  runtime starts with (HARDENING #71, 2026-11-05):
  - **Under about 2 s** the new runtime compiles while the old one's Workers
    are still open (they close about 2 s after an idle or busy restart, about
    4.3 s after a frozen one), and V8 hands it the old runtime's already
    optimized module. Its first check then reads like a re-check: a deep
    proof that passed before the restart passes after it.
  - **A death reboot inherits nothing, at any settle.** The dead runtime's
    Workers are gone before the settle starts, so the replacement compiles
    fresh and reads like a fresh page load. lean4game measured it after
    out-of-memory deaths at its 1.5 s settle (4 of 4 cold). A `rearm()`
    after a stack pause (§7.2) was not measured; it comes after the death and
    an edit, so it most likely reads cold too.
  - **At 2 s or more** under `Elab.async=true`, idle and busy restarts start
    from a fresh compile and read exactly like a fresh page load: a proof
    near the stack limit that passed before can fail on the first check
    after the restart, the same way every time, until the next edit.
  - **At 2 s or more** under `Elab.async=false` (the stock page's setting),
    the first check after a restart reads warm in some restarts and cold in
    others (13 of 30 warm at 2 s), so it is neither deeper nor more
    reproducible.

  | first check after a restart reads warm | 1.5 s | 2 s |
  |---|---|---|
  | `Elab.async=false` (stock page, showcase) | 20 of 20 | 13 of 30 |
  | `Elab.async=true` (proof sheets, lean4game's `Runner`) | 18 of 18 | 0 of 18 |

  Every miss is the stack guard's own error, never a wrong pass. Choose 2 s
  or more under `Elab.async=true` when the same result on every restart
  matters more than depth; keep 1.5 s for the deepest restarts. A settle
  far below 1.5 s is not measured: the wait also gives the old runtime's
  heap time to go (HARDENING #55). The measurements and their scope (one
  host, headless Chromium 151, an Init-only `decide` ladder) are in
  HARDENING #71's note of 2026-11-05.
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
  closure, provided the overlay claims every root the umbrella entry claims
  (`Aesop`, `Qq`, `Lean.*` are umbrella roots; see below); a module no root
  names is the kernel's to judge. It never widens when every missing module
  is Init or claimed by a loaded entry's roots: the kernel has just refuted
  that claim (a prefix being typed, a typo), and no snapshot would change the
  verdict. The decision is stateless, so a session a reboot booted without
  the entry (the header changed, then a crash) widens again.

It is **opt-in.** Without `roots`, the entry named `mathlib` serves the
umbrella roots (the stock page's list, `LEGACY_UMBRELLA_ROOTS` in
`lib/snapshots.ts`, an internal re-export, §7.0): `Mathlib`, `Batteries`,
`MIL` and `QED64` (the aliases' roots and the umbrella module), and `Lean`, `Std`,
`Aesop`, `Qq`, `Plausible` and `LeanSearchClient` (packages whose root module
is in the umbrella's closure; since 2026-11, HARDENING #82). `ProofWidgets`,
`Lake` and `ImportGraph` are not claimed: the umbrella holds some of their
modules but not their roots. No other entry serves any, and the editor's
policy without an index uses the same list. An overlay built on
`QED64.Essential` that declares `roots` and is served beside the stock entry
must claim a superset of these roots: otherwise a Mathlib session whose
header also names, say, `Aesop` never widens to it (the umbrella claims
`Aesop`, the overlay does not, so no entry is known to serve the whole
header). An index without `roots` therefore decides exactly as the editor's
policy does; the unit tests pin this parity on the stock index and drive the
page's self-widen (`frontend/src/self-widen.ts`) over the real relay.
QED64's own index declares the stock entry's roots, these ten, from its next
adoption on (`pipeline/release/adopt-release.sh` passes `bake-snapshot
--roots`, read from `LEGACY_UMBRELLA_ROOTS`; review D10); until then that
entry relies on the fallback above, with the same verdicts. The roots are
claims, not membership: the kernel's header verdict stays authoritative.

---

## 9. Internal, and the test hatch

These are internal and may change in any commit:
- every other member of `globalThis.qed64` (`relay`, `ui`, `artifacts`,
  `editor`, `status()`);
- the `qed64.buffer` key;
- every DOM id/class and every label string;
- `globalThis.__qed64InfoviewEditorApi`;
- every path not in `exports` / `closure.json`;
- every `qed64/embed` re-export marked `@internal` (§7.0).

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
terms. Its `liveness` member holds the mailbox internals; no fault injection
(`inject`/`freeze`) or pool hook was built.

---

## 10. Migration notes

The notes for moving onto v1 (the widgets showcase's table, the Memory64 probe's
move, lean4game's list) moved to `docs/history/EMBEDDING-PRE-V1.md` on
2026-11-03, as written. It is in the repository, at the commit you pin:
`docs/history/` is not in the package's `files`. A break from `1.0.0` on carries
its migration note in §12 (§1).

---

## 11. Security notes

- **HARDENING #57 (fixed in this branch).** Off-origin snapshot and profile
  sources could be loaded through a crafted link. These are now refused,
  including when the off-origin source is reached through a redirect:
  - every boot parameter;
  - the snapshot index loader;
  - the profile loaders (index, manifests, parts; removed with the library
    packs by D1, 2026-11);
  - `prefetchRaw` and both workers.

  A boot document in the URL (`#code=` / `#codez=`) is honoured only inside
  a same-origin frame; on the plain page it opens behind a consent gate
  (§3.1, HARDENING #77).
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

## 12. Changes from `1.0.0` on

The rows before `1.0.0`, from the draft (daf9b63) to `1.0.0-pre.11`, are in the
repository's `docs/history/EMBEDDING-PRE-V1.md`: a re-pin from an older commit
reads them there, because `docs/history/` is not in the package's `files`.

- **`qed64/embed` v1 is final (architecture review D13, option (b),
  2026-11-01):**
  - From here a minor is additive, and a break is `2.0.0` with a migration
    note in this section and no 1.x beside it (§1). Both library consumers
    pin full SHAs and compile the barrel, so a break reaches them at their
    own re-pin.
  - §1's principle 1 states the break rule per tier: the page API's
    `version: 2` ships beside v1 for one re-pin cycle (it said "at least one
    release"; QED64 has no release tags), and the workers keep §7.7's rules.
    A worker-policy value change (a Lean option or the thread budget) keeps
    `REVISION` and `EMBED_API_REVISION` and gets a dated row here (§7.7).
  - §7.0 now names every export: the seven it did not are
    `chooseSnapshots`, `widenTarget`, `initialBytesForEntries`,
    `coversModule`, `entryLabel`, `BASE_SNAPSHOTS` and
    `DEFAULT_MAXIMUM_BYTES`, each with a prose contract, and
    `importedModulesOf` (named since `1.0.0-pre.11`) gains one.
  - `LEGACY_UMBRELLA_ROOTS` is marked `@internal`: still exported, outside
    the contract, because its contents follow the served umbrella (R1). It
    stays as the editor's policy without an index (§8); no consumer imports
    it through the barrel.
  - `tests/unit/embed-barrel.test.ts` pins the proof sheets' twelve runtime
    imports beside lean4game's and the stock page's, and checks that §7
    names every export not marked `@internal`. §6 gains the proof sheets'
    column.
  - No code behaviour changes. A built shell's `dist/qed64-build.json`
    records `embedApiRevision` `1.0.0` from its next build.
  - `EMBED_API_REVISION` → `1.0.0`.
- **Gzip runtime parts: the worker reads `org.lean-browser64.runtime/v2`
  (architecture review M3, 2026-11):**
  - The kernel, which owns the format (the fork's
    `formats/runtime-manifest.md`), accepted QED64's proposed v2 shape
    verbatim on 2026-11-01. closure.json `runtime.manifestSchemas` lists v1
    and v2 (§6), and `lean.worker.js` reads both (§7.7).
  - The worker refuses before any fetch (`RUNTIME_MANIFEST_MISMATCH`,
    `corrupt`) a v2 file that names no `encoding` or one outside
    `gzip`/`identity`, a part without a positive integer `decodedBytes`, a
    part but the last that does not decode to exactly 16,777,216 bytes (or a
    last one that decodes to more), `decodedBytes` that do not sum to the
    file's `bytes`, and an `identity` part whose `decodedBytes` is not its
    `bytes`.
  - It verifies each part as served (length, SHA-256, the cache-bypassing
    retry), then inflates a gzip part through DecompressionStream to exactly
    its `decodedBytes`. A part that does not inflate, or inflates to another
    size, fails the boot `corrupt` and is not refetched (it was served as
    pinned). The whole-file check, and so the buildId rule, is over the
    decoded file.
  - Progress counts the bytes that cross the wire: the runtime stage's
    `total` is the sum of the parts' served bytes, which for v1 is the
    files' `bytes` as before (§7.1).
  - `RuntimeManifest` gains optional `schema`, a file's `encoding` and a
    chunk's `decodedBytes` (additive).
  - `pipeline/release/release-manifest.mjs` describes a v2 runtime with each
    file's `encoding` and each chunk's `decodedBytes`, only for v2: a v1
    runtime's section, and so `artifactSetId`, are byte-identical. It
    refuses a record whose `runtime.schema` (additive in
    `lean4-wasm64.release/v1`, absent = v1) is not the served manifest's.
    fetch-artifacts and verify-release read v2 too (docs/CLI-CONTRACT.md,
    contract 4).
  - Gzip bytes depend on the zlib that wrote them, so nothing in QED64
    compares served gzip parts across builds: only the decoded identity
    (each file's `sha256`, and so the buildId) is compared.
  - Nothing served changes yet: QED64 serves a v1 runtime, and the kernel
    publishes no v2 runtime before this reader is on QED64's main. A
    consumer that pairs these workers with a v2 runtime takes a worker bump,
    no rebake.
  - The worker scripts keep `REVISION` "1", and `PROTOCOL` is unchanged.
  - `EMBED_API_REVISION` → `1.1.0`.
- **The v1 contract names its types (docs, 2026-11):** `qed64/embed`'s
  contract is every value export §7.0 names and every type those exports'
  signatures use, so a breaking change to `SnapshotEntry`, `Qed64Artifacts`,
  `StatusSink` or another such type is a break like any other (§1); an
  additive one is a minor. No code change: `EMBED_API_REVISION` is unchanged.
- **A malformed runtime manifest gets its one error reply again (2026-11,
  review of the v2 reader):** a v1 chunk entry that is null (for example
  `chunks: [null]`) no longer throws in the boot's wire-byte total, which
  left the boot with no reply; it fails as before 1.1.0, with
  `RUNTIME_FETCH_FAILED`. No served manifest can reach it
  (release-manifest validates them). `EMBED_API_REVISION` and the worker
  `REVISION` are unchanged.
- **`status().pool` loses the pool-growth diagnostic's fields (2026-11,
  R7b):** the worker no longer reports `grown`, `starts` or `lifetimes`, and
  its `[pool]` log lines are gone (docs/HARDENING.md #55). The three fields
  stay declared optional on `WorkerStatus`, so v1 readers still type-check;
  `unused`, `running` and `parked` are unchanged. No API change:
  `EMBED_API_REVISION` is unchanged.
- **A replacement no longer names or waits for its predecessors (2026-11,
  HARDENING #68, R16):** a relay restart or reboot no longer waits for every
  Worker of the runtime it replaced; the tolerance of 12 applies to restarts
  as to reloads (0/24 start-up crashes with the tolerance alone; the wait
  cost 0.53-2.38 s per restart). `LeanSession` no longer sends
  `instance.predecessors`, newer workers ignore it, and an older worker reads
  the missing field as none. The `[boot] waited` line loses its "; a → b of
  them replaced by this page" suffix; its start and the " — budget spent"
  group are unchanged. No API change: `EMBED_API_REVISION` and the worker
  `REVISION` are unchanged.
- **No boot waits for stopping runtimes (2026-11, HARDENING #55, R16):** a
  runtime allocates beside whatever a reloaded or replaced runtime still has
  alive. It used to wait, for up to 6 s, while more than 12 of their Workers
  were alive. With no wait there was no crash in 20 mid-boot storms or in 16
  frozen restarts beside all 25 Workers of the old runtime; the wait cost
  228-490 ms on a mid-boot boot that waited. `LeanSession`'s boot sends
  `instance: {id}`, newer workers ignore `instance.waitMs`, and an older
  worker reads the missing field as its 6 s budget, so mixed caches still
  boot. An embedder that boots a replacement right after `dispose()` no
  longer waits either (the 2026-10-09 row, in
  `docs/history/EMBEDDING-PRE-V1.md`). The `[boot] waited` line is gone.
  The `qed64-wanted:` and `qed64-alive:` Web Locks stay, as lifetime signals
  nothing waits on. An embedding page's own heap has at least 2400 MiB of
  headroom at a 3 s reload cadence on wasm64-36d7f415 (chrome-headless-shell;
  headed not measured); a heavy page reloaded mid-boot was not measured.
  No API change: `EMBED_API_REVISION` and the worker `REVISION` are unchanged.
- **resident-probe ships (2026-11, architecture review R4 item 4):** no library
  change. The package gains one tier-1 CLI, `pipeline/snapshot/resident-probe.mjs`
  (in `files` and closure.json `pipeline`). Only its surface is tier 1
  (docs/CLI-CONTRACT.md, "Tiers"). `EMBED_API_REVISION` and the worker `REVISION`
  are unchanged.
- **A runtime chunk served with a `Content-Encoding` is `corrupt` (2026-11-02,
  lean4game's report):** the worker refuses such a chunk, on both attempts, with
  `<label> chunk <n> was transformed by Content-Encoding: <enc>.` under
  `RUNTIME_FETCH_FAILED`. `failureKindOf` read that as `network`, unless `<enc>`
  was `gzip`, whose name already matched the corrupt rule. So lean4game showed
  "The download was interrupted — waiting for the connection" with the link up,
  and the relay's reboots first downloaded any pre-open snapshot the cache lacked
  (HARDENING #63). It is now `corrupt`, for every encoding (§7.2); there is no new
  kind, and the worker is untouched. The stock page's failure card and pill do
  not change: they show the message for both kinds. Its reboots no longer show
  "preparing the <name> environment before the checker starts (the last attempt
  lost the network)". No API change: `EMBED_API_REVISION` and the worker
  `REVISION` are unchanged.
- **§10 and the rows before `1.0.0` moved to `docs/history/` (2026-11-03,
  architecture review R9a):** docs only. `docs/history/EMBEDDING-PRE-V1.md` holds
  them verbatim, §10 is a pointer, and this section starts at the `1.0.0` row.
  Seven facts the move would have taken out of the package gain a sentence:
  `status().memory` at `ready` (§2.3), the progress call of a wait for another
  tab (§7.1), a lost chunk outside `/assets/` (§7.2), `arm()` as a
  `LeanSession`'s last runtime step (§7.3), Firefox's persistent-storage prompt
  (§7.4), a headless driver's thread setup and linters under `Elab.async=false`
  (§7.7). No code change: `EMBED_API_REVISION` and the worker `REVISION` are
  unchanged.
- **A lost module outside `/assets/` on Firefox is `network` (2026-11-03):**
  Firefox's words for it, `error loading dynamically imported module: <url>`,
  read `other`, which §7.2 defines as the checker's own failure, while Chrome's
  words for the same event read `network`. `failureKindOf`, `failureCauseOf` and
  a coded `deathCause`, which goes through the table, now read `network` for both
  (§7.2). Under `/assets/` both stay `stale`. Off `/assets/`, an uncoded
  `deathCause` still reads `other` for both: that path takes only `oom` from the
  table. No API change: `EMBED_API_REVISION` and the worker `REVISION` are
  unchanged.
- **What the relay's `settle` decides (2026-11-06):** §7.9 now documents the
  `settle` argument. Besides giving the old heap time to go, it decides whether
  a restarted runtime inherits the old one's optimized wasm code, and so how a
  proof near the stack limit reads on the first check after a restart: on a
  `restart()` of a live runtime, under about 2 s it inherits; at 2 s or more
  under `Elab.async=true` every restart reads like a fresh load. A death reboot
  never inherits, because the old Workers are already gone (lean4game measured
  this after out-of-memory deaths; HARDENING #71, 2026-11-05). The stock page keeps
  1.5 s (the user's decision, 2026-11-06); the value stays each embedder's
  choice. Docs only: `EMBED_API_REVISION` and the worker `REVISION` are
  unchanged.
