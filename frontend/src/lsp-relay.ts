// L3 LSP relay (docs/ARCHITECTURE-REEVALUATION-2-2026-09-02.md §2.2 "L3", §2.3):
// three states, zero timers, zero regexes. The worker owns the document, the queue
// and every header verdict (§2.4); this relay only remembers what re-establishes
// the document on a fresh session (§2.3 data), fails requests a death orphaned
// (§3 row 11), and breaks crash loops. It reads four fields: method, id, version, text.
import type { JsonRpcMessage as JsonRpc, WorkerStatus } from "../../src/runtime/client";

/** The typed L2 surface the relay drives (LeanSession + an async boot). */
export interface RelaySession {
  readonly id: string;
  start(): Promise<void>; // boot + pre-open snapshot loads, loop still CLOSED; resolves = BootOk, rejects = BootFailed (§2.3)
  arm(): Promise<void>; // Booting → Ready (§2.4): the worker may open its loop on the queued didOpen; rejects = BootFailed
  lsp(msg: JsonRpc, replay?: boolean): void;
  onLsp: (msg: JsonRpc) => void;
  onStatus: (status: WorkerStatus) => void;
  onDied: (code: number | null, reason: string, message: string) => void;
  dispose(): void; // detaches first, never emits a death (§2.2 L2)
}
export interface RestartOptions { snapshots?: string[]; warmHeader?: string; packs?: string[] } // boot inputs for a replacement session (S4 "Load exact imports")
type Reason = "boot" | "crash" | "heartbeat" | "user" | "bootFailed";
export type RelayState = { kind: "serving" } | { kind: "rebooting"; reason: Reason } | { kind: "halted" };
export type RelayStatus = Omit<WorkerStatus, "phase"> & { phase: WorkerStatus["phase"] | "halted"; relay: RelayState["kind"]; session: string };
const EMPTY: WorkerStatus = { phase: "booting", version: null, header: null, ring: { bytesQueued: 0, refused: 0 }, pool: { unused: -1, running: -1 }, dropped: 0 };
const BREAKER_DEATHS = 3;
const BREAKER_WINDOW_MS = 120_000;

export class LspRelay {
  readonly clientPort: MessagePort;
  private readonly serverSide: MessagePort;
  state: RelayState = { kind: "rebooting", reason: "boot" };
  session: RelaySession;
  initialize: JsonRpc | null = null;
  doc: { uri: string; languageId: string; version: number } | null = null;
  /** The last full text forwarded — equal to the worker's document by construction (change = 1). */
  lastText = "";
  readonly pending = new Map<number | string, string>();
  deaths: number[] = [];
  lastStatus: WorkerStatus | null = null;
  readonly stats = { reboots: 0, userRestarts: 0, workerDeaths: 0, breakerTrips: 0, failedInFlight: 0, staleDeaths: 0, rangedChanges: 0 }; // rangedChanges: didChanges that ignored change = 1

  constructor(
    private readonly makeSession: (opts?: RestartOptions) => RelaySession,
    private readonly sink: { status(s: RelayStatus): void },
    /** The one wait in the design — the 1.5 s heap-release settle inside a reboot (§2.3, §2.5) — injected so this module owns no timer (§8 item 9). */
    private readonly settle: () => Promise<void>,
    private readonly now: () => number = () => Date.now(),
  ) {
    const channel = new MessageChannel();
    this.clientPort = channel.port2;
    this.serverSide = channel.port1;
    this.serverSide.onmessage = (e) => this.fromClient(e.data as JsonRpc);
    this.session = this.attach(makeSession());
    void this.boot(this.session, false);
  }

  /** The page-facing datum (§2.2 L4, C7): the worker's own status, the relay's state on top. */
  status(): RelayStatus {
    const s = this.lastStatus ?? EMPTY;
    return { ...s, phase: this.state.kind === "halted" ? "halted" : s.phase, relay: this.state.kind, session: this.session.id };
  }

  /** ClientMessage (§2.3): record, then forward — a booting worker queues it. */
  fromClient(msg: JsonRpc): void {
    const p = msg.params as { textDocument?: { uri: string; languageId: string; version: number; text: string }; contentChanges?: { text?: string; range?: unknown }[] } | undefined;
    if (msg.method === "initialize") this.initialize = msg;
    else if (msg.method === "textDocument/didOpen" && p?.textDocument) {
      this.doc = { uri: p.textDocument.uri, languageId: p.textDocument.languageId, version: p.textDocument.version };
      this.lastText = p.textDocument.text;
    } else if (msg.method === "textDocument/didChange" && p?.textDocument && this.doc) {
      this.doc.version = p.textDocument.version;
      const c = p.contentChanges?.[0]; // full text only: a ranged edit would make the replay a fragment
      if (c && typeof c.text === "string" && c.range === undefined) this.lastText = c.text;
      else if (c) this.stats.rangedChanges += 1;
    }
    const isRequest = msg.id !== undefined && msg.method !== undefined;
    if (this.state.kind === "halted") {
      if (isRequest) return this.toClient({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "QED64: checker halted after repeated crashes; edit the file to restart it" } });
      if (msg.method !== "textDocument/didChange") return;
      this.deaths = []; // the user changed something: recovery gets a fresh chance
      this.reboot("user", true);
    }
    if (isRequest) this.pending.set(msg.id!, msg.method!);
    this.session.lsp(msg);
  }

  /** RestartRequested (§2.3): a deliberate replacement is not a death and is not counted as one. */
  restart(opts: RestartOptions): void {
    if (this.state.kind !== "serving") return;
    this.stats.userRestarts += 1;
    this.failInFlight("restarting with exact imports");
    this.session.dispose();
    this.reboot("user", true, opts, false);
  }

  unload(): void { this.session.dispose(); } // Unload (§2.3)

  private attach(s: RelaySession): RelaySession {
    this.lastStatus = null;
    s.onLsp = (m) => { if (s === this.session) { if (m.id !== undefined && m.method === undefined) this.pending.delete(m.id); this.toClient(m); } };
    s.onStatus = (st) => { if (s === this.session) { this.lastStatus = st; this.sink.status(this.status()); } };
    s.onDied = (_code, reason) => this.onDied(s, reason);
    return s;
  }

  private async boot(s: RelaySession, settle: boolean): Promise<void> {
    if (settle) await this.settle();
    if (s !== this.session) return; // superseded while settling
    try {
      await s.start();
      if (s !== this.session) return;
      // BootOk: re-establish the document from what THIS relay forwarded, not the editor (lean4game's text is
      // untranslated — §2.2 L3). The replay lands in the worker's queue (superseding a stale client didOpen held
      // there); THEN the arm opens the loop once (§2.4 Ready → Open) — one elaboration per boot, never two.
      if (this.initialize) s.lsp(this.initialize, true);
      if (this.doc) s.lsp({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { ...this.doc, text: this.lastText } } });
      await s.arm();
    } catch { // a session its own death already disposed rejects here too: not a second death
      if (s === this.session && this.state.kind !== "halted") this.onDied(s, "bootFailed");
      return;
    }
    if (s !== this.session) return;
    this.state = { kind: "serving" };
    this.sink.status(this.status());
  }

  /** SessionDied / BootFailed (§2.3): once per session, current only; ≥ 3 in 120 s halts. */
  private onDied(s: RelaySession, reason: string): void {
    if (s !== this.session || this.state.kind === "halted") { this.stats.staleDeaths += 1; return; }
    this.stats.workerDeaths += 1;
    this.failInFlight(`the Lean checker died (${reason})`);
    s.dispose();
    const t = this.now();
    this.deaths = [...this.deaths.filter((d) => t - d < BREAKER_WINDOW_MS), t];
    if (this.deaths.length < BREAKER_DEATHS) return this.reboot(reason === "bootFailed" || reason === "heartbeat" ? reason : "crash", true);
    // Crash-loop breaker: the content kills the checker on every replay; keep the editor alive, an edit re-arms.
    this.stats.breakerTrips += 1;
    this.state = { kind: "halted" };
    this.sink.status(this.status());
  }

  private reboot(reason: Reason, settle: boolean, opts?: RestartOptions, counted = true): void {
    if (counted) this.stats.reboots += 1;
    this.state = { kind: "rebooting", reason };
    this.session = this.attach(this.makeSession(opts));
    this.sink.status(this.status());
    void this.boot(this.session, settle);
  }

  /** §3 row 11: answer every orphaned request in the same turn — rpc calls get RpcNeedsReconnect (-32900) so the InfoView reconnects; the rest -32603. */
  private failInFlight(why: string): void {
    for (const [id, method] of this.pending) {
      this.toClient({ jsonrpc: "2.0", id, error: { code: method.startsWith("$/lean/rpc/") ? -32900 : -32603, message: `QED64: ${why}` } });
      this.stats.failedInFlight += 1;
    }
    this.pending.clear();
  }

  private toClient(msg: JsonRpc): void { this.serverSide.postMessage(msg); }
}
