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
  /** How many source ranges the server reports as still elaborating. */
  private processingCount = 0;
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
              this.ui.progress("first library search — indexing Mathlib (about 2 min, once per session)");
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
    try { this.qs.session.dispose(); } catch { /* already down */ }
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
    if (this.restarting) return;
    this.restarting = true;
    this.workerStarted = false;
    try {
      this.qs.session.dispose();
    } catch { /* already dying */ }
    this.restarting = false;
    await this.handleWorkerDeath();
  }

  /** The wasm instance died (header edit or crash). Boot a new one and
   * replay the current document; the Monaco client never notices. */
  async handleWorkerDeath(): Promise<void> {
    if (this.restarting || !this.doc) return;
    this.restarting = true;
    this.workerStarted = false;
    this.searchIndexWarm = false;
    this.failInFlight("the Lean worker restarted");
    // In-place re-init (wasmLspInit's "replacing it" path) wedges the new
    // session's elaboration — until the toolchain patch that cancels the
    // old session's tasks lands (see docs/PATCH-BACKLOG.md), imports
    // changes pay a full worker reboot. Snapshots reload from OPFS, so
    // this is tens of seconds, not the first-visit minutes — say so.
    this.ui.busy("imports changed — restarting the checker (about half a minute; environments reload from cache)");
    try {
      const wantsMathlib = /^\s*import\s+(Mathlib|Batteries|MIL\b)/m.test(this.doc.text);
      const qs = await this.makeSession({ mathlib: wantsMathlib });
      this.attachSession(qs);
      await this.prepareHeader(this.doc.text);
      const r = (await (qs.session as unknown as RpcSession).request("lsp-init", {
        input: {
          initParams: JSON.stringify(this.initParams ?? {}),
          didOpen: JSON.stringify({
            textDocument: {
              uri: this.doc.uri,
              languageId: this.doc.languageId,
              version: this.doc.version,
              text: rewriteAliasImports(this.doc.text).text,
            },
          }),
        },
      })) as { tag: number };
      if (r.tag !== 0) throw new Error(`lsp-init IO tag ${r.tag}`);
      this.workerStarted = true;
      this.ui.idle("ready");
      const queued = this.queue;
      this.queue = [];
      for (const q of queued) await this.forward(q);
    } catch (err) {
      if ((err as Error).message !== "__qed64_remount__") {
        // A bad import line must not brick the page: surface the failure as
        // a diagnostic ON the header, keep tracking edits, and let the next
        // header edit retry the whole restart. Release the half-booted
        // session's heap NOW — the retry boots a fresh one, and two live
        // 3.5 GiB heaps is exactly the OOM recipe.
        try { this.qs.session.dispose(); } catch { /* already down */ }
        this.ui.idle("imports failed — edit the import line to retry");
        this.publishHeaderFailure((err as Error).message);
      }
    } finally {
      this.restarting = false;
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
    if (wantsMathlib) {
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
      this.doc = {
        uri: p.textDocument.uri,
        version: p.textDocument.version,
        text: p.textDocument.text,
        languageId: p.textDocument.languageId ?? "lean4",
      };
    } else if (msg.method === "textDocument/didChange" && this.doc) {
      const p = msg.params as { textDocument: { version: number }; contentChanges: ContentChange[] };
      const headerBefore = headerOf(this.doc.text);
      this.doc.version = p.textDocument.version;
      this.doc.text = applyContentChanges(this.doc.text, p.contentChanges);
      // The worker cannot change its imports (its exit-2 restart request is
      // neutralized by the runtime keepalive) — the shim detects header
      // edits itself and restarts proactively, replaying the new text. The
      // superseding didOpen makes forwarding this didChange unnecessary.
      if (headerOf(this.doc.text) !== headerBefore && !this.restarting) {
        if (this.workerStarted) {
          void this.restartForHeaderChange();
        } else if (!this.starting) {
          // The last header failed to load (or the worker died); a changed
          // header is the user's fix — retry the boot with the new text.
          void this.handleWorkerDeath();
        }
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
        if (r.tag !== 0) throw new Error(`lsp-init IO tag ${r.tag}`);
        this.workerStarted = true;
        this.ui.idle("ready");
        const queued = this.queue;
        this.queue = [];
        for (const q of queued) await this.forward(q);
      } catch (err) {
        if ((err as Error).message !== "__qed64_remount__") {
          this.ui.idle(`Lean failed to start: ${(err as Error).message}`);
        }
      } finally {
        this.starting = false;
      }
      return;
    }
    if (!this.workerStarted) {
      this.queue.push(msg);
      return;
    }
    await this.forward(msg);
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
    }
  }
}
