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
  loadSnapshotByName,
  type Qed64Artifacts,
  type Qed64Session,
  type StatusSink,
} from "./qed64-boot";

// `request`/`compile` access; the shim is a trusted internal peer.
type RpcSession = {
  request(type: string, payload: Record<string, unknown>): Promise<unknown>;
  compile(source: string, fileName: string): Promise<unknown>;
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
  /** How many source ranges the server reports as still elaborating. */
  private processingCount = 0;

  constructor(
    private readonly artifacts: Qed64Artifacts,
    private qs: Qed64Session,
    private readonly ui: StatusSink,
    /** Boot a replacement session after the current one dies. */
    private readonly makeSession: () => Promise<Qed64Session>,
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
        this.observeServerMessage(d.msg);
        this.serverSide.postMessage(d.msg);
      }
    };
    qs.session.worker.addEventListener("message", onMessage);
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
    }, 1500);
    this.detachSession = () => {
      qs.session.worker.removeEventListener("message", onMessage);
      window.clearInterval(tickler);
    };
  }

  /** Track elaboration progress for the "working…" indicator. */
  private observeServerMessage(msg: JsonRpc) {
    if (msg.method === "$/lean/fileProgress") {
      const processing = (msg.params as { processing?: unknown[] })?.processing ?? [];
      const was = this.processingCount;
      this.processingCount = processing.length;
      if (processing.length > 0 && was === 0) this.ui.busy("elaborating");
      else if (processing.length === 0 && was > 0) this.ui.idle("ready");
    }
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
    this.ui.busy("restarting Lean (imports changed)");
    try {
      const qs = await this.makeSession();
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
      this.ui.idle(`Lean restart failed: ${(err as Error).message} — reload the page`);
    } finally {
      this.restarting = false;
    }
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
        this.ui.busy("no Mathlib snapshot — importing the header from oleans (this can take minutes)");
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
      if (this.workerStarted && headerOf(this.doc.text) !== headerBefore) {
        void this.restartForHeaderChange();
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
        this.ui.idle(`Lean failed to start: ${(err as Error).message}`);
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
    try {
      await (this.qs.session as unknown as RpcSession).request("lsp-send", {
        input: { message: JSON.stringify(msg) },
      });
    } catch (err) {
      console.warn(`[shim] lsp-send failed (${msg.method ?? msg.id}): ${(err as Error).message}`);
    }
  }
}
