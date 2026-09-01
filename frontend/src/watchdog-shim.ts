// The JS "watchdog": everything Lean's watchdog process does for a
// single-document session, reimplemented over the QED64 pump RPC
// (`lsp-init` / `lsp-send` + `lsp` events on the worker).
//
// Like the real watchdog it answers `initialize` itself (the file worker
// consumes the request without responding), forwards traffic, and RESTARTS
// the worker when it dies — under wasm a header edit tears down the whole
// instance (the exit-code-2 contract), so restart means "new session, reload
// snapshots, replay didOpen with the current text". The Monaco client stays
// attached to the same MessagePort and never notices.
import type { LeanSession } from "../../src/runtime/client";
import {
  ensureProfile,
  loadSnapshotByName,
  type Qed64Artifacts,
  type Qed64Session,
  type StatusSink,
} from "./qed64-boot";

// `request`/`compile`/`worker` access; the shim is a trusted internal peer.
type RpcSession = {
  request(type: string, payload: Record<string, unknown>): Promise<unknown>;
  compile(source: string, fileName: string): Promise<unknown>;
  worker: Worker;
};

// Transcribed from Lean.Server.Watchdog.mkLeanServerCapabilities (4.33.0-pre).
const SERVER_CAPABILITIES = {
  textDocumentSync: {
    openClose: true,
    change: 2, // incremental
    willSave: false,
    willSaveWaitUntil: false,
    save: { includeText: true },
  },
  completionProvider: { triggerCharacters: ["."], resolveProvider: true },
  hoverProvider: true,
  declarationProvider: true,
  definitionProvider: true,
  typeDefinitionProvider: true,
  referencesProvider: true,
  callHierarchyProvider: true,
  renameProvider: { prepareProvider: true },
  workspaceSymbolProvider: true,
  documentHighlightProvider: true,
  documentSymbolProvider: true,
  foldingRangeProvider: true,
  semanticTokensProvider: {
    legend: {
      tokenTypes: ["keyword", "variable", "property", "function", "namespace", "type", "enumMember", "comment"],
      tokenModifiers: [],
    },
    full: true,
    range: true,
  },
  codeActionProvider: {
    resolveProvider: true,
    codeActionKinds: ["quickfix", "refactor", "source.organizeImports"],
  },
  inlayHintProvider: { resolveProvider: false },
};

// Client chatter the file worker has no handler for.
const SWALLOWED_NOTIFICATIONS = new Set([
  "initialized",
  "$/setTrace",
  "workspace/didChangeConfiguration",
  "workspace/didChangeWatchedFiles",
  // Multi-level clients (lean4game) close one document and open the next;
  // this shim's worker sessions are replaced wholesale by lsp-init, so a
  // didClose forwarded raw would only disturb the live FileWorker.
  "textDocument/didClose",
]);

type JsonRpc = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

interface TrackedDoc {
  uri: string;
  version: number;
  text: string;
  languageId: string;
}

interface ContentChange {
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  text: string;
}

/** Apply LSP incremental content changes to a text (UTF-16 positions). */
export function applyContentChanges(text: string, changes: ContentChange[]): string {
  let current = text;
  for (const ch of changes) {
    if (!ch.range) {
      current = ch.text;
      continue;
    }
    const toOffset = (pos: { line: number; character: number }): number => {
      let offset = 0;
      let line = 0;
      while (line < pos.line) {
        const nl = current.indexOf("\n", offset);
        if (nl < 0) return current.length;
        offset = nl + 1;
        line += 1;
      }
      return Math.min(offset + pos.character, current.length);
    };
    const start = toOffset(ch.range.start);
    const end = toOffset(ch.range.end);
    current = current.slice(0, start) + ch.text + current.slice(end);
  }
  return current;
}

/** Aggregators and tutorial preludes absent from the curated profile but
 * served by the umbrella environment (mirrors the batch app's alias table).
 * Their import lines are commented out of the text the WORKER sees — line
 * count preserved, so body diagnostics keep their positions — and the
 * remaining imports are then covered by the Mathlib snapshot. */
const UMBRELLA_ALIAS_IMPORT = /^(\s*)import\s+(Mathlib|Mathlib\.Tactic|Batteries|MIL\.Common)\s*$/;

export function rewriteAliasImports(text: string): { text: string; rewrote: boolean } {
  let rewrote = false;
  let first = true;
  const lines = text.split("\n").map((l) => {
    if (UMBRELLA_ALIAS_IMPORT.test(l)) {
      rewrote = true;
      if (first) {
        first = false;
        // The umbrella import keeps the header Mathlib-shaped so the
        // covering-env check picks the umbrella even for alias-only headers.
        return "import QED64.Essential";
      }
      return `-- ${l.trim()} (served by the full Mathlib environment)`;
    }
    return l;
  });
  return { text: lines.join("\n"), rewrote };
}

function headerOf(text: string): string {
  return text
    .split("\n")
    .filter((l) => /^\s*(?:public\s+|private\s+)?(?:meta\s+)?import\s+/.test(l))
    .join("\n");
}

export class WatchdogShim {
  readonly clientPort: MessagePort;
  private readonly serverSide: MessagePort;
  private initParams: unknown = null;
  private workerStarted = false;
  private starting = false;
  private restarting = false;
  private queue: JsonRpc[] = [];
  private doc: TrackedDoc | null = null;
  private detachSession: (() => void) | null = null;
  /** Requests awaiting a response, for loss detection (see forward) and
   * for failing fast when the worker dies with requests in flight. */
  private pendingResponses = new Map<number | string, { timer: number; method: string }>();
  /** Debounce for header-change restarts: rapid example switches collapse
   * into ONE boot of the final target instead of a chain of multi-GiB
   * boots (three overlapping boots peaked a renderer at 11 GB). */
  private restartDebounce: number | undefined;
  /** How many source ranges the server reports as still elaborating. */
  private processingCount = 0;
  /** When the last $/lean/fileProgress arrived — the in-place switch's liveness signal. */
  private lastProgressAt = 0;
  /** Rapid edits coalesce: while a flush is pending, incoming didChanges
   * append their contentChanges instead of hitting the worker one by one —
   * a fast garbage-typing storm otherwise piles elaboration churn until
   * the renderer dies. Order is preserved; the flushed message carries the
   * newest version, which is exactly LSP's contract. */
  private heldChange: JsonRpc | null = null;
  private changeFlush: number | undefined;

  /** The worker's document is BEHIND the editor: a header edit was
   * withheld (the debounce arms a restart instead of forwarding it), so
   * position-fresh requests against the worker would run on stale text —
   * observed as completion requests that hang until the switch settles.
   * Cleared whenever an lsp-init hands the worker the current text. */
  private headerDiverged = false;

  /** A worker death arrived while a restart was in flight (e.g. a stack
   * overflow during the in-place switch's liveness window). The death must
   * be handled when the restart machinery unwinds — swallowing it leaves a
   * dead session behind a live-looking pill forever. */
  private deathPending = false;
  /** Recent worker-death timestamps: the recovery machinery must not reboot
   * forever into content that kills the checker on every replay. */
  private deathTimes: number[] = [];
  /** The crash-loop breaker tripped; an edit re-arms recovery. */
  private crashLoopHalted = false;
  /** When the current busy stretch began, for the slow-search hint. */
  private busySince = 0;
  private searchHintTimer: number | undefined;
  /** The library-search index is built once per worker process; after the
   * first search completes, later searches are seconds-class. */
  private searchIndexWarm = false;

  constructor(
    private readonly artifacts: Qed64Artifacts,
    private qs: Qed64Session,
    private readonly ui: StatusSink,
    /** Boot a replacement session after the current one dies. */
    private readonly makeSession: (opts?: { mathlib?: boolean }) => Promise<Qed64Session>,
    /** Host-specific policy hooks (the game build supplies these). */
    private readonly policy: {
      /** Name a snapshot whose baked environment covers this header, or null.
       * Consulted before the Mathlib rule and before any warm compile — a
       * covering snapshot makes file imports (and hence packs) unnecessary. */
      coveringSnapshotFor?: (headerText: string) => string | null;
    } = {},
  ) {
    const channel = new MessageChannel();
    this.clientPort = channel.port2;
    this.serverSide = channel.port1;
    this.serverSide.onmessage = (e) => void this.fromClient(e.data as JsonRpc);
    this.attachSession(qs);
  }

  private attachSession(qs: Qed64Session) {
    this.detachSession?.();
    this.qs = qs;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; kind?: string; msg?: JsonRpc };
      if (d && d.type === "event" && d.kind === "lsp" && d.msg) {
        // Tickler responses are shim-internal (see below) — never forwarded.
        if (typeof d.msg.id === "string" && d.msg.id.startsWith("qed64-tick")) return;
        if (d.msg.id !== undefined && d.msg.method === undefined) {
          const pending = this.pendingResponses.get(d.msg.id);
          if (pending !== undefined) {
            window.clearTimeout(pending.timer);
            this.pendingResponses.delete(d.msg.id);
          }
        }
        this.observeServerMessage(d.msg);
        this.serverSide.postMessage(d.msg);
      }
    };
    (qs.session as unknown as RpcSession).worker.addEventListener("message", onMessage);
    // The worker's stdout occasionally misses a flush, leaving the final
    // response body stuck in the TTY buffer until the NEXT write arrives —
    // observed as an InfoView waiting forever on one answer. A periodic
    // cheap request keeps the stream draining: its response write flushes
    // any stuck frame (and any stuck tickler response is flushed by the
    // next tick). Shim-internal; filtered above.
    const tickler = window.setInterval(() => {
      if (!this.workerStarted || !this.doc) return;
      void this.forward({
        jsonrpc: "2.0",
        id: `qed64-tick-${Date.now() % 1000000}`,
        method: "textDocument/waitForDiagnostics",
        params: { uri: this.doc.uri, version: 0 },
      });
    }, 2500);
    this.detachSession = () => {
      (qs.session as unknown as RpcSession).worker.removeEventListener("message", onMessage);
      window.clearInterval(tickler);
    };
  }

  /** Track elaboration progress for the "working…" indicator. */
  private observeServerMessage(msg: JsonRpc) {
    if (msg.method === "$/lean/fileProgress") {
      this.lastProgressAt = performance.now();
      const processing = (msg.params as { processing?: unknown[] })?.processing ?? [];
      const was = this.processingCount;
      this.processingCount = processing.length;
      if (processing.length > 0 && was === 0) {
        this.ui.busy("elaborating");
        this.busySince = performance.now();
        // The first library search in a session builds a Mathlib-wide index
        // (native builds ship it prebuilt; the wasm worker rebuilds per
        // process). If a search tactic is in the buffer and elaboration runs
        // long, say so instead of leaving a bare two-minute "elaborating".
        window.clearTimeout(this.searchHintTimer);
        if (!this.searchIndexWarm && this.doc && /\b(exact\?|apply\?|rw\?)/.test(this.doc.text)) {
          this.searchHintTimer = window.setTimeout(() => {
            if (this.processingCount > 0 && !this.searchIndexWarm) {
              this.ui.progress("first library search — indexing Mathlib (about a minute, once per session)");
            }
          }, 8000);
        }
      } else if (processing.length === 0 && was > 0) {
        window.clearTimeout(this.searchHintTimer);
        // A long stretch with a search tactic present means the index built.
        if (this.doc && /\b(exact\?|apply\?|rw\?)/.test(this.doc.text) && performance.now() - this.busySince > 15000) {
          this.searchIndexWarm = true;
        }
        this.ui.idle("ready");
      }
    }
  }

  /** Release the wasm heap NOW. A reload does not promptly reclaim a
   * dead page's committed 3.5 GiB shared memory; quick successive reloads
   * stack sessions until the OS jetsams the renderer. Called on pagehide. */
  disposeForUnload(): void {
    this.disposeHard();
  }

  /** Answer every in-flight request with an error. A dead worker answers
   * nothing, and a promise the client never settles wedges the InfoView
   * permanently (the "All Messages" list stays empty while the badge keeps
   * the dead session's counts). RPC calls get RpcNeedsReconnect (-32900) so
   * vscode-lean4's rpc layer reconnects to the replacement session and
   * refetches on its own. */
  private failInFlight(why: string): void {
    for (const [id, pending] of this.pendingResponses) {
      window.clearTimeout(pending.timer);
      const rpc = pending.method === "$/lean/rpc/call" || pending.method === "$/lean/rpc/connect";
      this.serverSide.postMessage({
        jsonrpc: "2.0",
        id,
        error: rpc
          ? { code: -32900, message: `QED64: ${why}` }
          : { code: -32603, message: `QED64: ${why}; please retry` },
      });
    }
    this.pendingResponses.clear();
  }

  /** Header edited: dispose the session (one worker serves one import set)
   * and bring up a replacement on the new text. */
  private async restartForHeaderChange(): Promise<void> {
    if (this.restarting || !this.doc) return;
    this.restarting = true;
    this.workerStarted = false;
    this.heldChange = null;
    window.clearTimeout(this.changeFlush);
    // In-place replacement: since the toolchain gained cancellable session
    // replacement (FileWorker.teardownForReplacement re-arms the import
    // guard whose neutered forceExit silently wedged every second init),
    // a header switch is just a fresh lsp-init inside the LIVE instance —
    // every environment stays resident, no reboot, seconds not tens of
    // seconds. The full reboot remains the fallback for anything unhealthy.
    this.ui.busy("checking the new imports");
    const bootText = this.doc.text;
    const bootVersion = this.doc.version;
    try {
      const attempt = async (): Promise<{ tag: number }> =>
        (await (this.qs.session as unknown as RpcSession).request("lsp-init", {
          input: {
            initParams: JSON.stringify(this.initParams ?? {}),
            didOpen: JSON.stringify({
              textDocument: {
                uri: this.doc!.uri,
                languageId: this.doc!.languageId,
                version: bootVersion,
                text: rewriteAliasImports(bootText).text,
              },
            }),
          },
        })) as { tag: number };
      // Probe first: the worker resolves the header BEFORE replacing the
      // live session, and tag 2 means "unresolvable, session untouched" —
      // exactly what a half-typed import line produces. No teardown, no
      // in-flight churn; the user keeps typing.
      let r = await attempt();
      if (r.tag === 2 && /^\s*import\s+(Mathlib|Batteries|MIL\b)/m.test(bootText) && !this.qs.loadedSnapshots.has("mathlib")) {
        // The header wants Mathlib and the environment is not resident yet:
        // load it once (honest pill) and probe again.
        await this.prepareHeader(bootText);
        r = await attempt();
      }
      if (r.tag === 2) {
        // Still composing — keep the current checker fully intact, queue
        // edits, and show a calm note on the import line. Every further
        // header edit re-probes through the debounce.
        this.restarting = false;
        this.resolvePendingDeath();
        this.ui.idle("imports incomplete — finish the import line to continue");
        this.publishHeaderFailure("these imports do not resolve yet — check or finish the module name");
        return;
      }
      if (r.tag !== 0) {
        // The imports are bad, not the session: surface and let a header
        // edit retry — no reboot needed.
        this.restarting = false;
        this.resolvePendingDeath();
        this.ui.idle("imports failed — edit the import line to retry");
        this.publishHeaderFailure("the imports could not be resolved — check the module names (details in the browser console)");
        return;
      }
      // The replaced session never answers requests that were in flight
      // against it — without this they dangle until the 15 s loss watchdog
      // (observed as a "response lost" storm and a ~15 s InfoView freeze
      // after every in-place switch). Same contract as the reboot path:
      // rpc gets -32900 so the InfoView reconnects immediately.
      this.failInFlight("the Lean checker switched documents");
      this.workerStarted = true;
      // The worker now holds bootText; diverged only if the header moved on
      // while the switch ran (the go-around below then restarts for it).
      this.headerDiverged = headerOf(this.doc.text) !== headerOf(bootText);
      this.ui.idle("ready");
      const queued = this.queue;
      this.queue = [];
      for (const q of queued) {
        if (q.method === "textDocument/didChange") {
          const v = (q.params as { textDocument?: { version?: number } })?.textDocument?.version;
          if (typeof v === "number" && v <= bootVersion) continue;
        }
        await this.forward(q);
      }
      // Recompute from the post-replay truth: an edit-then-revert during the
      // switch can make the early assignment stale in either direction, and
      // nothing but this line would ever clear it (a wedged-true flag keeps
      // failing completions on a healthy session).
      this.headerDiverged = headerOf(this.doc.text) !== headerOf(bootText);
      if (this.headerDiverged) {
        this.restarting = false;
        this.deathPending = false; // superseded: the next round handles state
        void this.restartForHeaderChange();
        return;
      }
      // Liveness: a healthy replacement's reporter emits fileProgress within
      // moments. Silence means the replacement machinery misbehaved (old
      // binary, unforeseen state) — fall back to the proven full reboot.
      const armed = performance.now();
      let alive = false;
      for (let i = 0; i < 24; i++) {
        if (this.lastProgressAt > armed || this.processingCount > 0) { alive = true; break; }
        await new Promise((res) => window.setTimeout(res, 500));
      }
      if (alive) {
        this.restarting = false;
        this.resolvePendingDeath();
        return;
      }
      console.warn("[shim] in-place switch produced no fileProgress — falling back to a full restart");
    } catch (err) {
      console.warn(`[shim] in-place header switch failed (${(err as Error).message}) — full restart`);
    }
    this.restarting = false;
    this.workerStarted = false;
    this.disposeHard();
    await this.handleWorkerDeath();
  }

  /** Dispose AND terminate the worker immediately. The polite dispose gives
   * the worker 250 ms to acknowledge, and the multi-GiB shared heap is only
   * reclaimed after termination + GC — on rapid example switches the old
   * heap must be on its way out BEFORE the replacement commits its own
   * 3.5 GiB, or the transient overlap OOM-kills the renderer. */
  private disposeHard(): void {
    try { this.qs.session.dispose(); } catch { /* already dying */ }
    try { (this.qs.session as unknown as RpcSession).worker.terminate(); } catch { /* gone */ }
  }

  /** The wasm instance died (header edit or crash). Boot a new one and
   * replay the current document; the Monaco client never notices. */
  async handleWorkerDeath(): Promise<void> {
    if (this.restarting) {
      this.deathPending = true;
      return;
    }
    if (!this.doc) return;
    // Crash-loop breaker: three deaths inside two minutes means the current
    // content kills the checker on every replay (e.g. an elaboration stack
    // overflow) — stop the reboot cycle, keep the editor alive, and let an
    // edit or an example switch re-arm recovery.
    const now = performance.now();
    this.deathTimes = this.deathTimes.filter((t) => now - t < 120000);
    this.deathTimes.push(now);
    if (this.deathTimes.length >= 3) {
      this.crashLoopHalted = true;
      this.workerStarted = false;
      this.ui.idle("the checker keeps crashing on this content — edit the file or pick an example to retry");
      this.publishHeaderFailure("the checker crashed repeatedly while processing this content. Edit the file (or pick an example from the menu) to restart it.");
      return;
    }
    this.restarting = true;
    this.workerStarted = false;
    this.heldChange = null;
    window.clearTimeout(this.changeFlush);
    this.searchIndexWarm = false;
    this.failInFlight("the Lean worker restarted");
    // In-place re-init (wasmLspInit's "replacing it" path) wedges the new
    // session's elaboration — until the toolchain patch that cancels the
    // old session's tasks lands (see docs/PATCH-BACKLOG.md), imports
    // changes pay a full worker reboot. Snapshots reload from OPFS, so
    // this is tens of seconds, not the first-visit minutes — say so.
    this.ui.busy("imports changed — restarting the checker (about half a minute; environments reload from cache)");
    // Terminate whatever remains of the previous worker NOW and give the
    // engine a moment to release its heap before the replacement commits
    // multiple GiB — overlapping dying and booting heaps under rapid
    // example switches is the renderer-OOM recipe.
    this.disposeHard();
    await new Promise((r) => window.setTimeout(r, 1500));
    // ONE atomic snapshot of the document for the whole boot. The doc keeps
    // moving under rapid example switches; reading it live at each stage
    // built Frankenstein sessions — booted for header A, umbrella loaded
    // for header B, document opened with header C. An Init document inside
    // an umbrella-loaded session is the known elaboration-wedge combination,
    // so every stage uses this snapshot, and if the header moved on while
    // we booted, we go around again afterwards.
    const bootText = this.doc.text;
    const bootVersion = this.doc.version;
    try {
      const wantsMathlib = /^\s*import\s+(Mathlib|Batteries|MIL\b)/m.test(bootText);
      const qs = await this.makeSession({ mathlib: wantsMathlib });
      this.attachSession(qs);
      await this.prepareHeader(bootText);
      const r = (await (qs.session as unknown as RpcSession).request("lsp-init", {
        input: {
          initParams: JSON.stringify(this.initParams ?? {}),
          didOpen: JSON.stringify({
            textDocument: {
              uri: this.doc.uri,
              languageId: this.doc.languageId,
              version: bootVersion,
              text: rewriteAliasImports(bootText).text,
            },
          }),
        },
      })) as { tag: number };
      if (r.tag === 2) {
        // Half-typed imports: keep calm, no crash-loop accounting, retry on edit.
        this.restarting = false;
        this.resolvePendingDeath();
        this.deathTimes.pop();
        this.ui.idle("imports incomplete — finish the import line to continue");
        this.publishHeaderFailure("these imports do not resolve yet — check or finish the module name");
        return;
      }
      if (r.tag !== 0) throw new Error("the imports could not be resolved — check the module names (details in the browser console)");
      // The replacement is live: in-flight requests against the old session
      // are now orphans — fail them so the InfoView reconnects.
      this.failInFlight("the Lean checker switched documents");
      this.workerStarted = true;
      this.headerDiverged = headerOf(this.doc.text) !== headerOf(bootText);
      this.ui.idle("ready");
      const queued = this.queue;
      this.queue = [];
      for (const q of queued) {
        // The didOpen carries bootVersion's exact text; a queued didChange at
        // or below that version is already incorporated — replaying it would
        // regress the worker's document. Later versions apply incrementally
        // on top, exactly as LSP intends.
        if (q.method === "textDocument/didChange") {
          const v = (q.params as { textDocument?: { version?: number } })?.textDocument?.version;
          if (typeof v === "number" && v <= bootVersion) continue;
        }
        await this.forward(q);
      }
      // Another switch may have landed while we booted: this session was
      // built for bootText's imports — go around for the new header rather
      // than serving it mixed.
      this.headerDiverged = headerOf(this.doc.text) !== headerOf(bootText);
      if (this.headerDiverged) {
        this.restarting = false;
        void this.restartForHeaderChange();
        return;
      }
    } catch (err) {
      if ((err as Error).message !== "__qed64_remount__") {
        // A bad import line must not brick the page: surface the failure as
        // a diagnostic ON the header, keep tracking edits, and let the next
        // header edit retry the whole restart. Release the half-booted
        // session's heap NOW — the retry boots a fresh one, and two live
        // 3.5 GiB heaps is exactly the OOM recipe.
        this.disposeHard();
        this.ui.idle("imports failed — edit the import line to retry");
        this.publishHeaderFailure((err as Error).message);
      }
    } finally {
      this.restarting = false;
      this.resolvePendingDeath();
    }
  }

  /** A death recorded during a restart: if the session we ended up with is
   * dead, run the recovery now that the machinery has unwound. */
  private resolvePendingDeath(): void {
    if (!this.deathPending) return;
    this.deathPending = false;
    if ((this.qs.session as unknown as { state?: string }).state === "dead") {
      window.setTimeout(() => void this.handleWorkerDeath(), 100);
    }
  }

  /** Show an import/boot failure as a diagnostic on the document's first
   * import line so the user can see and fix it in place. */
  private publishHeaderFailure(message: string): void {
    if (!this.doc) return;
    const lines = this.doc.text.split("\n");
    let line = lines.findIndex((l) => /^\s*(?:public\s+|private\s+)?(?:meta\s+)?import\s+/.test(l));
    if (line < 0) line = 0;
    this.serverSide.postMessage({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: this.doc.uri,
        diagnostics: [{
          range: { start: { line, character: 0 }, end: { line, character: lines[line]?.length ?? 1 } },
          severity: 1,
          source: "QED64",
          message: `imports could not be loaded: ${message}\nEdit the import line to retry.`,
        }],
      },
    });
  }

  /** Ensure the header's environment exists in the main-thread cache BEFORE
   * lsp-init (a long wasm stint inside init silences the session, and the
   * elaboration pthread cannot import oleans itself). Preference order: a
   * covering snapshot, else a warm compile of the header. */
  private async prepareHeader(text: string): Promise<void> {
    const headerLines = rewriteAliasImports(text)
      .text.split("\n")
      .filter((l) => /^\s*(?:public\s+|private\s+)?(?:meta\s+)?import\s+/.test(l))
      .filter((l) => !/import\s+QED64\.Essential/.test(l));
    const wantsMathlib = /^\s*import\s+(Mathlib|Batteries|MIL\b)/m.test(text);
    let covered = false;
    const custom = this.policy.coveringSnapshotFor?.(text) ?? null;
    if (custom) {
      covered = await loadSnapshotByName(this.artifacts, this.qs, custom, this.ui);
    }
    if (!covered && wantsMathlib) {
      covered = await loadSnapshotByName(this.artifacts, this.qs, "mathlib", this.ui);
    }
    if (!covered && headerLines.length > 0) {
      if (wantsMathlib) {
        // Importing needs the pack mounted; it is NOT installed at boot
        // (snapshot-covered sessions never need it), so install on demand.
        // A fresh install cannot retro-mount into the running session —
        // dispose it and let the death-replay path boot one WITH the mount
        // (prepareHeader runs again there and takes the warm-compile arm).
        const hadPack = this.artifacts.installed.has("essential");
        const ok = await ensureProfile(this.artifacts, "essential", this.ui);
        if (!ok) this.ui.progress("Mathlib pack unavailable — imports may fail");
        if (ok && !hadPack) {
          this.qs.session.dispose();
          throw new Error("__qed64_remount__");
        }
        this.ui.busy("importing the header from oleans (this can take minutes)");
      } else {
        this.ui.busy("preparing the header environment");
      }
      const warmSource = `${headerLines.join("\n")}\n`;
      await (this.qs.session as unknown as RpcSession).compile(warmSource, "/workspace/__warm.lean");
    }
  }

  private respond(id: number | string, result: unknown) {
    this.serverSide.postMessage({ jsonrpc: "2.0", id, result });
  }

  private async fromClient(msg: JsonRpc): Promise<void> {
    if (msg.method === "initialize" && msg.id !== undefined) {
      this.initParams = msg.params;
      this.respond(msg.id, {
        capabilities: SERVER_CAPABILITIES,
        serverInfo: { name: "QED64 wasm64 Lean Server", version: "0.1.0" },
      });
      return;
    }
    if (msg.method && SWALLOWED_NOTIFICATIONS.has(msg.method) && msg.id === undefined) return;
    if (msg.method === "shutdown" && msg.id !== undefined) {
      this.respond(msg.id, null);
      return;
    }

    // Track the document so a dead worker can be restarted with current text.
    if (msg.method === "textDocument/didOpen") {
      const p = msg.params as { textDocument: { uri: string; version: number; text: string; languageId: string } };
      const hadDoc = this.doc !== null;
      this.doc = {
        uri: p.textDocument.uri,
        version: p.textDocument.version,
        text: p.textDocument.text,
        languageId: p.textDocument.languageId ?? "lean4",
      };
      // A RE-open on a live session is a document replacement (lean4game
      // closes one level's doc and opens the next): run the header-switch
      // machinery — probe first, in-place lsp-init with the new text — the
      // exact path a header didChange takes. Forwarding the raw didOpen
      // instead would hand a second document to a single-doc FileWorker
      // whose environment was resolved for the previous level.
      if (hadDoc && this.workerStarted && !this.restarting) {
        window.clearTimeout(this.restartDebounce);
        this.headerDiverged = true;
        this.crashLoopHalted = false;
        this.deathTimes = [];
        void this.restartForHeaderChange();
        return;
      }
      if (hadDoc && (this.restarting || this.starting)) {
        // A switch/boot is already in flight; the go-around's headerOf
        // comparison against the updated doc handles the new target.
        this.headerDiverged = true;
        return;
      }
    } else if (msg.method === "textDocument/didChange" && this.doc && this.crashLoopHalted) {
      // The user changed something — give recovery a fresh chance.
      const p = msg.params as { textDocument: { version: number }; contentChanges: ContentChange[] };
      this.doc.version = p.textDocument.version;
      this.doc.text = applyContentChanges(this.doc.text, p.contentChanges);
      this.crashLoopHalted = false;
      this.deathTimes = [];
      void this.handleWorkerDeath();
      return;
    } else if (msg.method === "textDocument/didChange" && this.doc) {
      const p = msg.params as { textDocument: { version: number }; contentChanges: ContentChange[] };
      const headerBefore = headerOf(this.doc.text);
      this.doc.version = p.textDocument.version;
      this.doc.text = applyContentChanges(this.doc.text, p.contentChanges);
      // The worker cannot change its imports (its exit-2 restart request is
      // neutralized by the runtime keepalive) — the shim detects header
      // edits itself and restarts proactively, replaying the new text. The
      // superseding didOpen makes forwarding this didChange unnecessary.
      if ((headerOf(this.doc.text) !== headerBefore || !this.workerStarted) && !this.restarting) {
        // Debounce: another switch within 2 s replaces this one, so a user
        // flicking through the examples pays for ONE restart, not a chain.
        window.clearTimeout(this.restartDebounce);
        this.headerDiverged = true;
        this.ui.busy("imports changed — updating…");
        this.restartDebounce = window.setTimeout(() => {
          if (this.restarting) return;
          if (this.workerStarted) {
            void this.restartForHeaderChange();
          } else if (!this.starting) {
            // The last header failed to load; a changed header is the user's
            // fix. Retry in place when the session survived (a bad import
            // leaves it healthy), reboot when it died.
            if ((this.qs.session as unknown as { state?: string }).state === "ready" || (this.qs.session as unknown as { state?: string }).state === "compiling") {
              void this.restartForHeaderChange();
            } else {
              void this.handleWorkerDeath();
            }
          }
        }, 2000);
        return;
      }
    }

    if (msg.method === "textDocument/didOpen" && !this.workerStarted && !this.starting) {
      this.starting = true;
      this.ui.busy("starting the Lean checker");
      try {
        await this.prepareHeader(this.doc?.text ?? "");
        const openParams = msg.params as { textDocument: { text: string } };
        const rewritten = rewriteAliasImports(openParams.textDocument.text);
        const r = (await (this.qs.session as unknown as RpcSession).request("lsp-init", {
          input: {
            initParams: JSON.stringify(this.initParams ?? {}),
            didOpen: JSON.stringify({
              ...openParams,
              textDocument: { ...openParams.textDocument, text: rewritten.text },
            }),
          },
        })) as { tag: number };
        if (r.tag === 2) {
          this.ui.idle("imports incomplete — finish the import line to continue");
          this.publishHeaderFailure("these imports do not resolve yet — check or finish the module name");
          return;
        }
        if (r.tag !== 0) throw new Error("the imports could not be resolved — check the module names (details in the browser console)");
        this.workerStarted = true;
        this.headerDiverged = false; // recomputed below once the replay lands
        this.ui.idle("ready");
        const openVersion = (openParams as unknown as { textDocument: { version?: number } }).textDocument.version ?? 0;
        const queued = this.queue;
        this.queue = [];
        for (const q of queued) {
          // The didOpen already carried this version's text — replaying an
          // older didChange would regress the worker's document.
          if (q.method === "textDocument/didChange") {
            const v = (q.params as { textDocument?: { version?: number } })?.textDocument?.version;
            if (typeof v === "number" && v <= openVersion) continue;
          }
          await this.forward(q);
        }
        // A header edit during the boot armed a debounce that the `starting`
        // guard swallowed, and nothing re-arms it — without this go-around
        // (the restart paths have the same check) the worker stays on the
        // didOpen-time imports forever and headerDiverged stays latched,
        // failing every completion on an otherwise healthy session.
        this.headerDiverged = this.doc !== null
          && headerOf(this.doc.text) !== headerOf(openParams.textDocument.text);
        if (this.headerDiverged) void this.restartForHeaderChange();
      } catch (err) {
        if ((err as Error).message !== "__qed64_remount__") {
          this.ui.idle(`Lean failed to start: ${(err as Error).message}`);
        }
      } finally {
        this.starting = false;
      }
      return;
    }
    if (!this.workerStarted || this.headerDiverged) {
      // The worker can't answer usefully here — a switch or reboot is in
      // flight, the tag-2 calm hold is waiting on the import line, the
      // crash-loop breaker tripped, or the worker's document is stale
      // behind a withheld header edit (position-fresh requests against
      // stale text hang inside the worker until the switch settles).
      // COMPLETION requests must not wait it out: Monaco's suggest widget
      // awaits every provider, so one hung LSP completion holds the instant
      // client-side import completions hostage for the whole window. Fail
      // exactly those fast with ContentModified (-32801), which LSP clients
      // swallow as "stale, ask again later" — asked at most once per user
      // gesture, so there is no retry loop. EVERYTHING else keeps its old
      // queue-or-forward behavior: `$/lean/*` rpc because the InfoView
      // retries a refused connect immediately (fast-failing it produced a
      // 20 Hz reject/retry storm), semanticTokens because the client treats
      // -32801 as a cancellation it never re-requests after (stale
      // highlighting), and the rest because a late answer beats an error.
      // The initial boot (`starting`) is exempt too: its queue-and-replay
      // is what populates the InfoView on first paint. Notifications always
      // queue — replaying them is how a replacement session learns the
      // document.
      const completionish = msg.id !== undefined
        && (msg.method === "textDocument/completion" || msg.method === "completionItem/resolve");
      if (completionish && !this.starting) {
        this.serverSide.postMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32801, message: "QED64: the checker is switching imports; ask again shortly" },
        });
        return;
      }
      if (this.workerStarted) {
        // Divergence only: the worker is alive — non-UI traffic (rpc against
        // its own still-consistent old view, notifications) flows as before.
      } else {
        this.queue.push(msg);
        return;
      }
    }
    if (msg.method === "textDocument/didChange") {
      const held = this.heldChange;
      if (held) {
        const hp = held.params as { textDocument: { version: number }; contentChanges: unknown[] };
        const mp = msg.params as { textDocument: { version: number }; contentChanges: unknown[] };
        hp.contentChanges.push(...mp.contentChanges);
        hp.textDocument.version = mp.textDocument.version;
      } else {
        this.heldChange = msg;
      }
      window.clearTimeout(this.changeFlush);
      this.changeFlush = window.setTimeout(() => void this.flushHeldChange(), 150);
      return;
    }
    await this.flushHeldChange();
    await this.forward(msg);
  }

  /** Send the coalesced didChange (edits must precede any later request). */
  private async flushHeldChange(): Promise<void> {
    const held = this.heldChange;
    if (!held) return;
    this.heldChange = null;
    window.clearTimeout(this.changeFlush);
    await this.forward(held);
  }

  private async forward(msg: JsonRpc): Promise<void> {
    // A response frame is occasionally lost in the worker's output stream
    // (a half-written frame is unrecoverable — the resync guard drops it).
    // A promise the client never settles wedges the whole InfoView, so
    // watchdog every request: on timeout, synthesize an error response —
    // the InfoView treats it like any failed call and simply retries.
    if (
      msg.id !== undefined &&
      msg.method !== undefined &&
      typeof msg.id !== "string" &&
      msg.method !== "textDocument/waitForDiagnostics" // legitimately long
    ) {
      const id = msg.id;
      const method = msg.method;
      const onTimeout = () => {
        const pending = this.pendingResponses.get(id);
        if (!pending) return;
        // Responses queue behind elaboration legitimately (an rpc call is
        // answered once its position is elaborated) — only an IDLE server
        // owing an answer for 15s means the frame is truly gone.
        if (this.processingCount > 0 || this.restarting || !this.workerStarted) {
          pending.timer = window.setTimeout(onTimeout, 15000);
          return;
        }
        this.pendingResponses.delete(id);
        console.warn(`[shim] response for ${method} (#${id}) lost — synthesizing error so the client retries`);
        this.serverSide.postMessage({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "QED64: response lost in the output stream; please retry" },
        });
      };
      this.pendingResponses.set(id, { timer: window.setTimeout(onTimeout, 15000), method });
    }
    try {
      await (this.qs.session as unknown as RpcSession).request("lsp-send", {
        input: { message: JSON.stringify(msg) },
      });
    } catch (err) {
      console.warn(`[shim] lsp-send failed (${msg.method ?? msg.id}): ${(err as Error).message}`);
      // Dead-man switch: the session died and no restart is running (the
      // death event can be swallowed when it lands mid-restart) — recover.
      if (!this.restarting && this.workerStarted
          && (this.qs.session as unknown as { state?: string }).state === "dead") {
        console.warn("[shim] session is dead with no restart in flight — rebooting");
        void this.handleWorkerDeath();
      }
    }
  }
}
