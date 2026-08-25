// The JS "watchdog": everything Lean's watchdog process does for a
// single-document session, reimplemented over the QED64 pump RPC
// (`lsp-init` / `lsp-send` + `lsp` events on the worker).
//
// The real watchdog answers `initialize` itself (the file worker consumes the
// request without responding), forwards traffic, and restarts workers on
// header edits. This shim does the same on a MessagePort that
// monaco-languageclient treats as its language-server transport
// (`{ $type: 'WorkerDirect', messagePort }` — BrowserMessageReader/Writer
// exchange plain JSON-RPC objects, no Content-Length framing).
import type { LeanSession } from "../../src/runtime/client";

// `request` is private on LeanSession; the shim is a trusted internal peer.
type RpcSession = { request(type: string, payload: Record<string, unknown>): Promise<unknown> };

// Transcribed from Lean.Server.Watchdog.mkLeanServerCapabilities (Lean
// 4.33.0-pre); the semantic token legends must match the server's tables, so
// they are echoed from the worker's own value tables when first requested —
// static names below cover vscode-lean4's current registrations.
const SEMANTIC_TOKEN_TYPES = [
  "keyword", "variable", "property", "function", "namespace", "type", "enumMember", "comment",
];
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
    legend: { tokenTypes: SEMANTIC_TOKEN_TYPES, tokenModifiers: [] },
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

type JsonRpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };

export class WatchdogShim {
  readonly clientPort: MessagePort;
  private readonly serverSide: MessagePort;
  private initParams: unknown = null;
  private workerStarted = false;
  private starting = false;
  private queue: JsonRpc[] = [];

  constructor(
    private readonly session: LeanSession,
    private readonly log: (line: string) => void,
  ) {
    const channel = new MessageChannel();
    this.clientPort = channel.port2;
    this.serverSide = channel.port1;
    this.serverSide.onmessage = (e) => void this.fromClient(e.data as JsonRpc);
    // Server→client: the worker posts parsed LSP frames as `lsp` events.
    this.session.worker.addEventListener("message", (e: MessageEvent) => {
      const d = e.data as { type?: string; kind?: string; msg?: JsonRpc };
      if (d && d.type === "event" && d.kind === "lsp" && d.msg) {
        this.serverSide.postMessage(d.msg);
      }
    });
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
    if (msg.method === "textDocument/didOpen" && !this.workerStarted && !this.starting) {
      this.starting = true;
      this.log("starting Lean file worker (header env prebuild may take ~30 s on first use)…");
      try {
        const r = (await (this.session as unknown as RpcSession).request("lsp-init", {
          input: {
            initParams: JSON.stringify(this.initParams ?? {}),
            didOpen: JSON.stringify(msg.params),
          },
        })) as { tag: number };
        if (r.tag !== 0) throw new Error(`lsp-init IO tag ${r.tag}`);
        this.workerStarted = true;
        this.log("file worker running");
        const queued = this.queue;
        this.queue = [];
        for (const q of queued) await this.forward(q);
      } catch (err) {
        this.log(`file worker failed to start: ${(err as Error).message}`);
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
      await (this.session as unknown as RpcSession).request("lsp-send", { input: { message: JSON.stringify(msg) } });
    } catch (err) {
      this.log(`lsp-send failed (${msg.method ?? msg.id}): ${(err as Error).message}`);
    }
  }
}
