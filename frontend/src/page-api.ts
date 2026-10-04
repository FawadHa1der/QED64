// The page API: `globalThis.qed64.api` (docs/EMBEDDING.md §2–§3), the stable
// surface for a same-origin embedder of the QED64 page.
//
// `createPageApi()` runs at module start and returns the frozen `api` at once —
// its methods work before the relay or the editor exist (they wait or say so).
// main() then feeds it: `bind()` when the relay exists, `editorReady()` once
// the editor is mounted, `bootStep()` / `bootFinished()` / `bootFailed()` from
// its status sink. Everything the API reports is a projection of what the page
// already has — the relay's status, the LSP traffic on the relay's two ports —
// so the relay itself is unchanged (it is budget-capped, tests/unit/relay.test.ts).
//
// Pure of the DOM except `requestAnimationFrame` (optional) and the caller's
// objects: unit-tested under node over a fake relay and editor.
import type { BootStage, FailureCause } from "./embed/failure";
import type { ProgressInfo } from "./qed64-boot";
import type { RelayStatus, RestartOptions } from "./lsp-relay";

export const API_REVISION = "1.0.0";

export type Cursor = { lineNumber: number; column: number };
export type SetDocumentResult = { version: number | null; unchanged: boolean };
export interface Capabilities {
  editorRpc: boolean; documents: boolean; events: boolean; restart: boolean;
  embedMode: boolean; snapshotRoots: boolean; postMessage: boolean;
}
export interface BuildInfo { buildId: string; leanVersion: string; sourceRevision: string | null; shell: string | null }
export type DeathKind = "crash" | "exit" | "abort" | "wedged" | "heartbeat" | "bootFailed" | "other";
export interface DeathInfo { kind: DeathKind; reason: string; message: string; cause: FailureCause | null }
export interface BootInfo { stage: BootStage; label: string; done: boolean; failed: boolean; message: string | null }
export interface ApiStatus {
  phase: RelayStatus["phase"];
  relay: RelayStatus["relay"];
  rebootReason: string | null;
  session: string | null;
  version: number | null;
  header: { mode: "exact" | "covered" | "refused"; missing: string[]; moduleCount: number } | null;
  collision: { names: string[]; version: number | null } | null;
  lastDeath: DeathInfo | null;
  boot: BootInfo;
  snapshots: string[] | null;
}
type LspDiagnostic = { range: unknown; severity?: number; message: string; source?: string };
export interface Events {
  status: ApiStatus;
  boot: { stage: BootStage; phase: string | null; subject: string | null; label: string; loaded: number | null; total: number | null; unit: string | null; done: boolean; failed: boolean; message: string | null };
  ready: { session: string; version: number | null; refused: boolean; header: ApiStatus["header"] };
  document: { uri: string; version: number; length: number; text: string };
  diagnostics: { uri: string; version: number | null; diagnostics: LspDiagnostic[]; origin: "lean" | "qed64" };
  fileProgress: { uri: string; version: number | null; processing: Array<{ range: unknown; kind?: number }> };
  death: { session: string; kind: DeathKind; reason: string; message: string; cause: FailureCause | null; willReboot: boolean; halted: boolean };
  reboot: { reason: string | null; fromSession: string; toSession: string };
}
export type EventName = keyof Events;

export interface Qed64ApiV1 {
  readonly version: 1;
  readonly revision: string;
  readonly capabilities: Readonly<Capabilities>;
  build(): BuildInfo | null;
  status(): ApiStatus;
  whenReady(): Promise<ApiStatus>;
  settled(opts?: { version?: number; timeoutMs?: number }): Promise<ApiStatus>;
  on<E extends EventName>(type: E, fn: (payload: Events[E]) => void): () => void;
  off<E extends EventName>(type: E, fn: (payload: Events[E]) => void): void;
  getDocument(): { uri: string; version: number | null; text: string } | null;
  setDocument(text: string, opts?: { cursor?: Cursor; focus?: boolean; undoable?: boolean }): Promise<SetDocumentResult>;
  setCursor(cursor: Cursor, opts?: { focus?: boolean; reveal?: boolean }): boolean;
  restart(opts?: { snapshots?: string[] }): boolean;
}

/** The slice of LspRelay the API reads (the real relay satisfies it). */
export interface RelayLike {
  status(): RelayStatus;
  fromClient(msg: { method?: string; params?: unknown }): void;
  readonly clientPort: MessagePort;
  readonly state: { kind: string };
  readonly doc: { uri: string; version: number } | null;
  readonly lastText: string;
  readonly session: { id: string; snapshots?: readonly string[] };
  restart(opts: RestartOptions): void;
}
/** The slice of Monaco's editor the API drives. */
export interface EditorLike {
  getModel(): { uri: { toString(): string }; getValue(): string; getFullModelRange(): unknown; setValue(text: string): void } | null;
  executeEdits(source: string, edits: Array<{ range: unknown; text: string; forceMoveMarkers?: boolean }>): boolean;
  pushUndoStop(): boolean;
  setPosition(p: Cursor): void;
  revealPositionInCenterIfOutsideViewport(p: Cursor): void;
  focus(): void;
}
export interface PageApiBinding {
  relay: RelayLike;
  editor: () => EditorLike | undefined;
  build: BuildInfo;
  /** Snapshot names the served index has (restart() refuses others). */
  snapshotNames: readonly string[];
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const DEATH_KINDS: ReadonlySet<string> = new Set(["crash", "exit", "abort", "wedged", "heartbeat", "bootFailed"]);

export function deathInfo(d: RelayStatus["lastDeath"]): DeathInfo | null {
  if (!d) return null;
  return { kind: (DEATH_KINDS.has(d.reason) ? d.reason : "other") as DeathKind, reason: d.reason, message: d.message, cause: d.cause ?? null };
}

/** The stable projection of the relay's status (the counters stay internal). */
export function toApiStatus(s: RelayStatus | null, boot: BootInfo, snapshots: readonly string[] | null): ApiStatus {
  return {
    phase: s?.phase ?? "booting",
    relay: s?.relay ?? "rebooting",
    rebootReason: s ? s.rebootReason : "boot",
    session: s?.session ?? null,
    version: s?.version ?? null,
    header: s?.header ? { mode: s.header.mode, missing: [...s.header.missing], moduleCount: s.header.moduleCount } : null,
    collision: s?.collision ? { names: [...s.collision.names], version: s.collision.version } : null,
    lastDeath: deathInfo(s?.lastDeath ?? null),
    boot: { ...boot },
    snapshots: snapshots ? [...snapshots] : null,
  };
}

export interface PageApi {
  api: Qed64ApiV1;
  bind(b: PageApiBinding): void;
  editorReady(): void;
  /** Feed every relay status here (after the page's own handling). */
  relayStatus(s: RelayStatus): void;
  /** Feed every structured boot step (a busy/progress call with `info.stage`). */
  bootStep(label: string, info: ProgressInfo): void;
  bootFinished(): void;
  bootFailed(message: string): void;
  /** The text `setDocument` set before boot read its document, if any. */
  takeBootDocument(): string | null;
  /** Resolves with that text as soon as `setDocument` is called (or null at `deadline`). */
  waitBootDocument(deadline: Promise<void>): Promise<string | null>;
}

export function createPageApi(capabilities: Capabilities, schedule: (f: () => void) => void = defaultSchedule): PageApi {
  const listeners = new Map<EventName, Set<(p: never) => void>>();
  const emit = <E extends EventName>(type: E, payload: Events[E]) => {
    for (const fn of [...(listeners.get(type) ?? [])]) {
      try { (fn as (p: Events[E]) => void)(payload); } catch (e) { console.error(`[qed64] api listener for '${type}' threw`, e); }
    }
  };
  let binding: PageApiBinding | null = null;
  let mounted = false;
  let last: RelayStatus | null = null;
  let boot: BootInfo = { stage: "manifests", label: "", done: false, failed: false, message: null };
  let bootDocument: string | null = null;
  let bootDocumentRead = false;
  const bootDocWaiters: Array<(t: string) => void> = [];
  const readyWaiters: Array<() => void> = [];
  const readySeen = new Set<string>();
  let lastDeath: RelayStatus["lastDeath"] = null;

  const snapshotsNow = () => (binding?.relay.session.snapshots ? [...binding.relay.session.snapshots] : null);
  const statusNow = (): ApiStatus => toApiStatus(binding ? binding.relay.status() : last, boot, snapshotsNow());
  const isBound = () => binding !== null && mounted;
  const settledPhase = (p: string) => p === "ready" || p === "headerRefused";

  function on<E extends EventName>(type: E, fn: (p: Events[E]) => void): () => void {
    let set = listeners.get(type);
    if (!set) listeners.set(type, (set = new Set()));
    set.add(fn as (p: never) => void);
    return () => off(type, fn);
  }
  function off<E extends EventName>(type: E, fn: (p: Events[E]) => void): void {
    listeners.get(type)?.delete(fn as (p: never) => void);
  }

  const api: Qed64ApiV1 = Object.freeze({
    version: 1 as const,
    revision: API_REVISION,
    capabilities: Object.freeze({ ...capabilities }),
    build: () => (binding ? { ...binding.build } : null),
    status: statusNow,
    whenReady: () => (isBound() ? Promise.resolve(statusNow()) : new Promise<ApiStatus>((r) => readyWaiters.push(() => r(statusNow())))),
    settled(opts: { version?: number; timeoutMs?: number } = {}) {
      return new Promise<ApiStatus>((resolve, reject) => {
        const want = opts.version ?? binding?.relay.doc?.version ?? null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = (s: ApiStatus): boolean => {
          if (s.phase === "halted") { done(); reject(err("HALTED", "the checker halted after repeated crashes; edit the document to restart it")); return true; }
          if (settledPhase(s.phase) && s.relay === "serving" && (want === null || (s.version ?? -1) >= want)) { done(); resolve(s); return true; }
          return false;
        };
        const unsubscribe = on("status", (s) => { check(s); });
        const done = () => { unsubscribe(); clearTimeout(timer); };
        if (opts.timeoutMs !== undefined) timer = setTimeout(() => { done(); reject(err("TIMEOUT", `not settled within ${opts.timeoutMs} ms`)); }, opts.timeoutMs);
        if (binding) check(statusNow());
      });
    },
    on,
    off,
    getDocument() {
      const model = binding?.editor()?.getModel();
      if (!model) return null;
      return { uri: model.uri.toString(), version: binding!.relay.doc?.version ?? null, text: model.getValue() };
    },
    setDocument(text: string, opts: { cursor?: Cursor; focus?: boolean; undoable?: boolean } = {}): Promise<SetDocumentResult> {
      if (typeof text !== "string") return Promise.reject(new TypeError("setDocument: text must be a string"));
      if (!bootDocumentRead) {
        bootDocument = text;
        for (const w of bootDocWaiters.splice(0)) w(text);
        // Resolves once boot has read it (the editor then opens with it).
        return new Promise<SetDocumentResult>((resolve) => readyWaiters.push(() => resolve({ version: binding?.relay.doc?.version ?? null, unchanged: false })));
      }
      const editor = binding?.editor();
      const model = editor?.getModel();
      if (!editor || !model) return new Promise<SetDocumentResult>((resolve, reject) => readyWaiters.push(() => { api.setDocument(text, opts).then(resolve, reject); }));
      if (model.getValue() === text) {
        // Nothing is sent: an identical-text edit produces no change event, and a
        // caller waiting for a version that never comes would wedge.
        if (opts.cursor) api.setCursor(opts.cursor, { focus: opts.focus });
        return Promise.resolve({ version: binding!.relay.doc?.version ?? null, unchanged: true });
      }
      return new Promise<SetDocumentResult>((resolve) => {
        const unsubscribe = on("document", (d) => { if (d.text === text) { unsubscribe(); resolve({ version: d.version, unchanged: false }); } });
        if (opts.undoable === false) model.setValue(text);
        else {
          editor.pushUndoStop();
          editor.executeEdits("qed64-api", [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
          editor.pushUndoStop();
        }
        if (opts.cursor) api.setCursor(opts.cursor, { focus: opts.focus });
        else if (opts.focus) editor.focus();
      });
    },
    setCursor(cursor: Cursor, opts: { focus?: boolean; reveal?: boolean } = {}) {
      const editor = binding?.editor();
      if (!editor || !Number.isInteger(cursor?.lineNumber) || !Number.isInteger(cursor?.column) || cursor.lineNumber < 1 || cursor.column < 1) return false;
      editor.setPosition({ lineNumber: cursor.lineNumber, column: cursor.column });
      if (opts.reveal !== false) editor.revealPositionInCenterIfOutsideViewport({ lineNumber: cursor.lineNumber, column: cursor.column });
      if (opts.focus !== false) editor.focus();
      return true;
    },
    restart(opts: { snapshots?: string[] } = {}) {
      if (!binding || binding.relay.state.kind !== "serving") return false;
      const snapshots = opts.snapshots ?? snapshotsNow() ?? undefined;
      const unknown = (snapshots ?? []).filter((n) => !binding!.snapshotNames.includes(n));
      if (unknown.length > 0) throw new TypeError(`restart: unknown snapshot(s) ${unknown.join(", ")} (served: ${binding.snapshotNames.join(", ")})`);
      binding.relay.restart(snapshots ? { snapshots: [...snapshots] } : {});
      return true;
    },
  });

  function emitBoot(label: string, info: ProgressInfo | null, done: boolean, failed: boolean, message: string | null) {
    boot = { stage: info?.stage ?? (failed ? "failed" : done ? "done" : boot.stage), label, done, failed, message };
    emit("boot", {
      stage: boot.stage, phase: info?.phase ?? null, subject: info?.subject ?? null, label,
      loaded: info?.loaded ?? null, total: info?.total ?? null, unit: info?.unit ?? null, done, failed, message,
    });
  }

  return {
    api,
    bind(b) {
      binding = b;
      const relay = b.relay;
      // `document`: what the relay forwards (it records didOpen/didChange first, then forwards).
      const forward = relay.fromClient.bind(relay);
      (relay as { fromClient: RelayLike["fromClient"] }).fromClient = (msg) => {
        forward(msg);
        if ((msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") && relay.doc) {
          emit("document", { uri: relay.doc.uri, version: relay.doc.version, length: relay.lastText.length, text: relay.lastText });
        }
      };
      // `diagnostics` / `fileProgress`: what the editor receives from the relay.
      let pendingProgress: Events["fileProgress"] | null = null;
      relay.clientPort.addEventListener("message", (e: MessageEvent) => {
        const m = e.data as { method?: string; params?: { uri?: string; version?: number; diagnostics?: LspDiagnostic[]; textDocument?: { uri: string; version?: number }; processing?: Array<{ range: unknown; kind?: number }> } };
        if (m?.method === "textDocument/publishDiagnostics" && m.params?.uri) {
          const diagnostics = m.params.diagnostics ?? [];
          const origin = diagnostics.length > 0 && diagnostics.every((d) => d.source === "QED64") ? "qed64" : "lean";
          emit("diagnostics", { uri: m.params.uri, version: m.params.version ?? null, diagnostics, origin });
        } else if (m?.method === "$/lean/fileProgress" && m.params?.textDocument) {
          const first = pendingProgress === null;
          pendingProgress = { uri: m.params.textDocument.uri, version: m.params.textDocument.version ?? null, processing: m.params.processing ?? [] };
          if (first) schedule(() => { const p = pendingProgress; pendingProgress = null; if (p) emit("fileProgress", p); });
        }
      });
      if (mounted) for (const w of readyWaiters.splice(0)) w();
    },
    editorReady() {
      mounted = true;
      if (binding) for (const w of readyWaiters.splice(0)) w();
    },
    relayStatus(s) {
      const prev = last;
      last = s;
      if (prev && prev.session !== s.session) emit("reboot", { reason: s.rebootReason, fromSession: prev.session, toSession: s.session });
      if (s.lastDeath && s.lastDeath !== lastDeath) {
        const d = deathInfo(s.lastDeath)!;
        emit("death", { session: prev?.session ?? s.session, kind: d.kind, reason: d.reason, message: d.message, cause: d.cause, willReboot: s.relay === "rebooting", halted: s.phase === "halted" });
      }
      lastDeath = s.lastDeath;
      const status = toApiStatus(s, boot, snapshotsNow());
      emit("status", status);
      if (settledPhase(s.phase) && s.relay === "serving") {
        if (!boot.done && !boot.failed) emitBoot(boot.label, { stage: "done" }, true, false, null); // a reboot's boot ends here too
        const key = `${s.session}@${s.version}`;
        if (!readySeen.has(key)) {
          readySeen.add(key);
          emit("ready", { session: s.session, version: s.version, refused: s.phase === "headerRefused", header: status.header });
        }
      }
    },
    bootStep(label, info) { emitBoot(label, info, false, false, null); },
    bootFinished() { if (!boot.done) emitBoot(boot.label, { stage: "done" }, true, false, null); },
    bootFailed(message) { emitBoot(message, { stage: "failed" }, false, true, message); },
    takeBootDocument() {
      bootDocumentRead = true;
      return bootDocument;
    },
    waitBootDocument(deadline) {
      if (bootDocument !== null) return Promise.resolve(bootDocument);
      return Promise.race([new Promise<string>((r) => bootDocWaiters.push(r)), deadline.then(() => null)]);
    },
  };
}

function defaultSchedule(f: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  if (typeof raf === "function") raf(f);
  else setTimeout(f, 16);
}

/** The boot document in embed mode (docs/EMBEDDING.md §3.1): `#code=` wins. */
export function codeFromHash(hash: string): string | null {
  const m = /^#(?:.*&)?code=([^&]*)/.exec(hash);
  if (!m) return null;
  if (m[1]!.length > 3 * 2 * 1048576) return null; // > 2 MiB of text even fully percent-encoded
  try {
    const text = decodeURIComponent(m[1]!);
    return text.length <= 2 * 1048576 ? text : null;
  } catch { return null; }
}
