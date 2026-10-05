// The page API: `globalThis.qed64.api` (docs/EMBEDDING.md §2–§3), the stable
// surface for a same-origin embedder of the QED64 page.
//
// `createPageApi()` runs at module start and returns the frozen `api` at once —
// its methods work before the relay or the editor exist (they wait or say so).
// main() then feeds it: `bind()` when the relay exists, `editorReady()` once
// the editor is mounted, `relayStatus()` from the relay's status sink,
// `bootStep()` / `bootFinished()` / `bootFailed()` from its StatusSink, and
// `memory()` / `setOffer()` from its meter and its exact-imports offer;
// `pageStatusSink()` orders the relay's sink so a self-widen comes first.
// Everything the API reports is a projection of what the page already has —
// the relay's status and the LSP traffic on the relay's taps
// (frontend/src/relay-taps.ts) — so the relay itself is unchanged (it is
// budget-capped, tests/unit/relay.test.ts).
//
// Pure of the DOM: unit-tested under node over a fake relay and editor.
import type { BootStage, FailureCause } from "./embed/failure";
import type { ProgressInfo } from "./qed64-boot";
import type { RelayStatus, RestartOptions } from "./lsp-relay";
import type { LspMessage, RelayTaps } from "./relay-taps";

export const API_REVISION = "1.0.0";

export type Cursor = { lineNumber: number; column: number };
export type SetDocumentResult = { version: number | null; unchanged: boolean };
export interface Capabilities {
  editorRpc: boolean; documents: boolean; events: boolean; restart: boolean; embedMode: boolean;
  snapshotRoots: boolean; postMessage: boolean; liveness: boolean; memory: boolean; widgetSourceCache: boolean; offers: boolean;
}
export interface BuildInfo { buildId: string; leanVersion: string; sourceRevision: string | null; shell: string | null }
export type DeathKind = "crash" | "exit" | "abort" | "wedged" | "heartbeat" | "bootFailed" | "other";
/** `seq` + `session` identify a death (the relay's death count; stable across copies); `cause` null = no evidence (docs/EMBEDDING.md §7.2). */
export interface DeathInfo { kind: DeathKind; reason: string; message: string; cause: FailureCause | null; seq: number; session: string; exitCode: number | null }
export interface BootInfo { stage: BootStage; label: string; done: boolean; failed: boolean; message: string | null; overlay: boolean }
/** The worker's liveness machine (lean.worker.js LIVENESS; HARDENING #52) as an
 * embedder needs it: is the Lean side stalled right now, and how long since
 * it last proved itself alive. The timings are the worker's constants. */
export interface LivenessInfo {
  stalled: boolean;
  lastAnswerAgoMs: number | null;
  lastFrameAgoMs: number | null;
  probeAfterMs: number;
  wedgeAfterMs: number;
  graceMs: number;
}
export interface MemoryInfo { initialBytes: number | null; currentBytes: number | null; maximumBytes: number | null }
export interface OfferInfo { kind: "exactImports"; label: string }
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
  liveness: LivenessInfo | null;
  memory: MemoryInfo | null;
  offer: OfferInfo | null;
}
type LspDiagnostic = { range: unknown; severity?: number; message: string; source?: string };
export interface Events {
  status: ApiStatus;
  boot: { stage: BootStage; phase: string | null; subject: string | null; label: string; loaded: number | null; total: number | null; unit: string | null; done: boolean; failed: boolean; message: string | null; error: FailureCause | null };
  ready: { session: string; version: number | null; refused: boolean; header: ApiStatus["header"] };
  document: { uri: string; version: number; length: number; text: string };
  diagnostics: { uri: string; version: number | null; diagnostics: LspDiagnostic[]; origin: "lean" | "qed64" };
  fileProgress: { uri: string; version: number | null; processing: Array<{ range: unknown; kind?: number }> };
  death: { session: string; kind: DeathKind; reason: string; message: string; cause: FailureCause | null; seq: number; exitCode: number | null; willReboot: boolean; halted: boolean };
  reboot: { reason: string | null; fromSession: string; toSession: string };
  liveness: { session: string; kind: "answered" | "stall" | "resumed" | "rescue" };
  offer: OfferInfo | null;
}
export type EventName = keyof Events;
export interface RestartResult { accepted: boolean; fromSession: string | null }

export interface Qed64ApiV1 {
  readonly version: 1;
  readonly revision: string;
  readonly capabilities: Readonly<Capabilities>;
  build(): BuildInfo | null;
  status(): ApiStatus;
  whenReady(): Promise<ApiStatus>;
  settled(opts?: { version?: number; afterSession?: string; timeoutMs?: number }): Promise<ApiStatus>;
  on<E extends EventName>(type: E, fn: (payload: Events[E]) => void): () => void;
  off<E extends EventName>(type: E, fn: (payload: Events[E]) => void): void;
  getDocument(): { uri: string; version: number | null; text: string } | null;
  setDocument(text: string, opts?: { cursor?: Cursor; focus?: boolean; undoable?: boolean }): Promise<SetDocumentResult>;
  getCursor(): Cursor | null;
  setCursor(cursor: Cursor, opts?: { focus?: boolean; reveal?: boolean }): boolean;
  focus(): boolean;
  restart(opts?: { snapshots?: string[]; initialBytes?: number }): RestartResult;
  acceptOffer(kind?: OfferInfo["kind"]): boolean;
}

/** The slice of LspRelay the API reads (the real relay satisfies it). */
export interface RelayLike {
  status(): RelayStatus;
  readonly state: { kind: string };
  readonly doc: { uri: string; version: number } | null;
  readonly lastText: string;
  readonly session: { id: string; snapshots?: readonly string[]; initialBytes?: number };
  restart(opts: RestartOptions): void;
  reusableOpts(): RestartOptions | undefined;
  /** Re-arm a halted relay without an edit (false unless halted). */
  rearm?(): boolean;
}
/** The slice of Monaco's editor the API drives. */
export interface EditorLike {
  getModel(): {
    uri: { toString(): string }; getValue(): string; getFullModelRange(): unknown; setValue(text: string): void;
    getLineCount(): number; getLineMaxColumn(lineNumber: number): number; getEOL?(): string;
    /** Monaco's version id: the LSP client sends it as the document version. */
    getVersionId(): number;
  } | null;
  executeEdits(source: string, edits: Array<{ range: unknown; text: string; forceMoveMarkers?: boolean }>): boolean;
  pushUndoStop(): boolean;
  getPosition(): Cursor | null;
  setPosition(p: Cursor): void;
  revealPositionInCenterIfOutsideViewport(p: Cursor): void;
  focus(): void;
}
export interface PageApiBinding {
  relay: RelayLike;
  taps: RelayTaps;
  editor: () => EditorLike | undefined;
  build: BuildInfo;
  /** Snapshot names the served index has (restart() refuses others). */
  snapshotNames: readonly string[];
  /** Normalizes a requested initial commit (restart({initialBytes})); throws on a refused value. */
  memoryBytes?: (bytes: number) => number;
  /** The page's sticky commit for every later session (null: back to its default). */
  setSessionMemory?: (bytes: number | null) => void;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });
const DEATH_KINDS: ReadonlySet<string> = new Set(["crash", "exit", "abort", "wedged", "heartbeat", "bootFailed"]);
/** lean.worker.js LIVENESS (probeAfterMs, wedgeAfterMs, graceMs). */
export const LIVENESS_TIMING = Object.freeze({ probeAfterMs: 6000, wedgeAfterMs: 12000, graceMs: 4000 });
/** Coalescing window for fileProgress: a timer, not requestAnimationFrame
 * (which a hidden or background frame never runs). */
export const FILE_PROGRESS_MS = 100;

export function deathInfo(d: RelayStatus["lastDeath"]): DeathInfo | null {
  if (!d) return null;
  return { kind: (DEATH_KINDS.has(d.reason) ? d.reason : "other") as DeathKind, reason: d.reason, message: d.message, cause: d.cause ? { ...d.cause } : null, seq: d.seq, session: d.session, exitCode: d.exitCode ?? null };
}

/** The relay's own frames (the halted note, orphaned-request errors) say so;
 * everything else came from the Lean side. */
export function isSyntheticFrame(m: LspMessage): boolean {
  const e = m.error as { message?: unknown } | undefined;
  if (typeof e?.message === "string" && e.message.startsWith("QED64:")) return true;
  const d = (m.params as { diagnostics?: LspDiagnostic[] } | undefined)?.diagnostics;
  return m.method === "textDocument/publishDiagnostics" && Array.isArray(d) && d.length > 0 && d.every((x) => x.source === "QED64");
}

interface Extras { liveness: LivenessInfo | null; memory: MemoryInfo | null; offer: OfferInfo | null }
const headerOf = (h: RelayStatus["header"] | undefined): ApiStatus["header"] => (h ? { mode: h.mode, missing: [...h.missing], moduleCount: h.moduleCount } : null);

/** The stable projection of the relay's status (the counters stay internal). */
export function toApiStatus(s: RelayStatus | null, boot: BootInfo, snapshots: readonly string[] | null, extras: Extras = { liveness: null, memory: null, offer: null }): ApiStatus {
  return {
    phase: s?.phase ?? "booting",
    relay: s?.relay ?? "rebooting",
    rebootReason: s ? s.rebootReason : "boot",
    session: s?.session ?? null,
    version: s?.version ?? null,
    header: headerOf(s?.header),
    collision: s?.collision ? { names: [...s.collision.names], version: s.collision.version } : null,
    lastDeath: deathInfo(s?.lastDeath ?? null),
    boot: { ...boot },
    snapshots: snapshots ? [...snapshots] : null,
    liveness: extras.liveness ? { ...extras.liveness } : null,
    memory: extras.memory ? { ...extras.memory } : null,
    offer: extras.offer ? { ...extras.offer } : null,
  };
}

/** The relay's status sink (main.ts): the page's self-widen (§8) runs FIRST.
 * It may restart the session inside this call, and the status it superseded
 * then reaches none of the rest — the page's own handling would finish the
 * boot on a verdict about to be replaced (and the API emit `boot` done for
 * it), and §2.2 never reports a superseded status. */
export function pageStatusSink(session: () => string, widen: (s: RelayStatus) => void, ...rest: Array<(s: RelayStatus) => void>): (s: RelayStatus) => void {
  return (s) => {
    widen(s);
    if (s.session === session()) for (const f of rest) f(s);
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
  /** The page's boot card is gone (the first boot is over). */
  bootFinished(): void;
  bootFailed(message: string, cause?: FailureCause): void;
  /** The memory meter's reading (the wasm heap now and its cap). */
  memory(currentBytes: number, maximumBytes: number): void;
  /** The page's one explicit action ("Load exact imports"), or null when withdrawn. */
  setOffer(offer: OfferInfo | null, run?: () => void): void;
  /** The text `setDocument` set before boot read its document, if any. */
  takeBootDocument(): string | null;
  /** Resolves with that text as soon as `setDocument` is called (or null at `deadline`). */
  waitBootDocument(deadline: Promise<void>): Promise<string | null>;
}

export function createPageApi(
  capabilities: Capabilities,
  timers: { now(): number; setTimeout(f: () => void, ms: number): unknown; clearTimeout(t: unknown): void } = {
    now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): PageApi {
  const listeners = new Map<EventName, Set<(p: never) => void>>();
  const emit = <E extends EventName>(type: E, payload: Events[E]) => {
    for (const fn of [...(listeners.get(type) ?? [])]) {
      try { (fn as (p: Events[E]) => void)(payload); } catch (e) { console.error(`[qed64] api listener for '${type}' threw`, e); }
    }
  };
  let binding: PageApiBinding | null = null;
  let mounted = false;
  let last: RelayStatus | null = null;
  let boot: BootInfo = { stage: "manifests", label: "", done: false, failed: false, message: null, overlay: true };
  let bootDocument: string | null = null;
  let bootDocumentRead = false;
  const bootDocWaiters: Array<(t: string) => void> = [];
  /** Waiters for "bound and mounted"; a boot that fails before that rejects them (BOOT_FAILED), and
   * every later one at once: the failure is kept, so a caller that comes after it (an iframe's load
   * handler runs after a refused parameter failed the boot) is not left waiting for nothing. */
  const readyWaiters: Array<{ ok(): void; fail(e: Error): void }> = [];
  let failedBeforeUp: string | null = null;
  const bootFailure = () => err("BOOT_FAILED", failedBeforeUp ?? "the page could not start");
  const onReady = (ok: () => void, fail: (e: Error) => void = () => {}) => {
    if (failedBeforeUp !== null) fail(bootFailure());
    else readyWaiters.push({ ok, fail });
  };
  const readySeen = new Set<string>();
  let lastDeath: RelayStatus["lastDeath"] = null;
  // liveness: per-session counters as last seen, when the answered count last rose, when the Lean side last sent a frame
  let liveSession = "";
  let liveCounters: NonNullable<RelayStatus["liveness"]> | null = null;
  let lastAnswerAt: number | null = null;
  let lastFrameAt: number | null = null;
  let mem: { currentBytes: number; maximumBytes: number; session: string | null } | null = null;
  let offer: { info: OfferInfo; run: () => void } | null = null;
  // fileProgress coalescing
  let pendingProgress: Events["fileProgress"] | null = null;
  let progressTimer: unknown = null;
  const flushProgress = () => {
    if (progressTimer !== null) { timers.clearTimeout(progressTimer); progressTimer = null; }
    const p = pendingProgress;
    pendingProgress = null;
    if (p) emit("fileProgress", p);
  };

  const snapshotsNow = () => (binding?.relay.session.snapshots ? [...binding.relay.session.snapshots] : null);
  const livenessNow = (): LivenessInfo | null => {
    if (!liveCounters) return null;
    const now = timers.now();
    return {
      stalled: liveCounters.stalls > liveCounters.resumed,
      lastAnswerAgoMs: lastAnswerAt === null ? null : now - lastAnswerAt,
      lastFrameAgoMs: lastFrameAt === null ? null : now - lastFrameAt,
      ...LIVENESS_TIMING,
    };
  };
  const memoryNow = (): MemoryInfo | null => {
    const initialBytes = binding?.relay.session.initialBytes ?? null;
    const reading = mem && mem.session === (binding?.relay.session.id ?? null) ? mem : null; // this session's meter only
    if (initialBytes === null && !reading) return null;
    return { initialBytes, currentBytes: reading?.currentBytes ?? null, maximumBytes: reading?.maximumBytes ?? null };
  };
  const project = (s: RelayStatus | null) => toApiStatus(s, boot, snapshotsNow(), { liveness: livenessNow(), memory: memoryNow(), offer: offer?.info ?? null });
  const statusNow = (): ApiStatus => project(binding ? binding.relay.status() : last);
  const isBound = () => binding !== null && mounted;
  const settledPhase = (p: string) => p === "ready" || p === "headerRefused";
  /** Resolves once the relay has forwarded the model's text as of `version`
   * (its version id) or a later text. The LSP client syncs full text and
   * coalesces: an edit only queues the document, and ONE didChange carries its
   * text and version at flush time, 250 ms after the last edit or before the
   * next request (vscode-languageclient 9) — so a text superseded inside that
   * window (another setDocument, a keystroke, an InfoView edit) is never
   * forwarded on its own, and waiting for that exact text would wedge. */
  const whenForwarded = (version: number, unchanged: boolean) => new Promise<SetDocumentResult>((resolve) => {
    const doc = binding!.relay.doc;
    if (doc && doc.version >= version) return resolve({ version: doc.version, unchanged });
    const unsubscribe = on("document", (d) => { if (d.version >= version) { unsubscribe(); resolve({ version: d.version, unchanged }); } });
  });
  const clampCursor = (editor: EditorLike, c: Cursor): Cursor | null => {
    const model = editor.getModel();
    if (!model || !Number.isFinite(c?.lineNumber) || !Number.isFinite(c?.column)) return null;
    const lineNumber = Math.min(Math.max(1, Math.trunc(c.lineNumber)), model.getLineCount());
    return { lineNumber, column: Math.min(Math.max(1, Math.trunc(c.column)), model.getLineMaxColumn(lineNumber)) };
  };

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
    whenReady: () => (isBound() ? Promise.resolve(statusNow()) : new Promise<ApiStatus>((r, j) => onReady(() => r(statusNow()), j))),
    settled(opts: { version?: number; afterSession?: string; timeoutMs?: number } = {}) {
      return new Promise<ApiStatus>((resolve, reject) => {
        if (!isBound() && failedBeforeUp !== null) return reject(bootFailure());
        const want = opts.version ?? binding?.relay.doc?.version ?? null;
        let timer: unknown;
        // Decided on, and resolved with, its own status() — never the `status`
        // payload every listener shares: one may edit it in place, or restart
        // the session and so supersede it, before or after this one runs.
        const check = (): boolean => {
          const s = statusNow();
          if (s.phase === "halted") { done(); reject(err("HALTED", "the checker halted after repeated crashes; edit the document to restart it")); return true; }
          if (opts.afterSession !== undefined && (s.session === null || s.session === opts.afterSession)) return false;
          if (settledPhase(s.phase) && s.relay === "serving" && (want === null || (s.version ?? -1) >= want)) { done(); resolve(s); return true; }
          return false;
        };
        // Decided a microtask later, after the whole status sink and every
        // listener ran: a listener registered after this one may restart the
        // session, and then this status is superseded too.
        let finished = false;
        const later = () => queueMicrotask(() => { if (!finished) check(); });
        const unsubscribe = on("status", later);
        const unsubscribeBoot = on("boot", (b) => { if (b.failed && !isBound()) { done(); reject(err("BOOT_FAILED", b.message ?? "the page could not start")); } });
        const done = () => { finished = true; unsubscribe(); unsubscribeBoot(); if (timer !== undefined) timers.clearTimeout(timer); };
        if (opts.timeoutMs !== undefined) timer = timers.setTimeout(() => { done(); reject(err("TIMEOUT", `not settled within ${opts.timeoutMs} ms`)); }, opts.timeoutMs);
        if (binding) later();
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
        return new Promise<SetDocumentResult>((resolve, reject) => onReady(() => {
          if (opts.cursor) api.setCursor(opts.cursor, { focus: opts.focus });
          resolve({ version: binding?.relay.doc?.version ?? null, unchanged: false });
        }, reject));
      }
      const editor = binding?.editor();
      const model = editor?.getModel();
      if (!editor || !model) return new Promise<SetDocumentResult>((resolve, reject) => onReady(() => { api.setDocument(text, opts).then(resolve, reject); }, reject));
      // Monaco stores the buffer in ONE line ending (an inserted CRLF or lone
      // CR becomes the model's EOL), so compare in its terms. Identical text
      // sends nothing (no change event): it waits only for an earlier edit's
      // forward still pending, never for a version that never comes.
      const eol = model.getEOL?.() ?? "\n";
      const unchanged = model.getValue() === text.replace(/\r\n?|\n/g, eol);
      if (!unchanged && opts.undoable === false) model.setValue(text);
      else if (!unchanged) {
        editor.pushUndoStop();
        editor.executeEdits("qed64-api", [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]);
        editor.pushUndoStop();
      }
      const forwarded = whenForwarded(model.getVersionId(), unchanged);
      if (opts.cursor) api.setCursor(opts.cursor, { focus: opts.focus });
      else if (opts.focus) editor.focus();
      return forwarded;
    },
    getCursor() {
      const p = binding?.editor()?.getPosition();
      return p ? { lineNumber: p.lineNumber, column: p.column } : null;
    },
    setCursor(cursor: Cursor, opts: { focus?: boolean; reveal?: boolean } = {}) {
      const editor = binding?.editor();
      const c = editor ? clampCursor(editor, cursor) : null;
      if (!editor || !c) return false;
      editor.setPosition(c);
      if (opts.reveal !== false) editor.revealPositionInCenterIfOutsideViewport(c);
      if (opts.focus !== false) editor.focus();
      return true;
    },
    focus() {
      const editor = binding?.editor();
      if (!editor) return false;
      editor.focus();
      return true;
    },
    restart(opts: { snapshots?: string[]; initialBytes?: number } = {}): RestartResult {
      const fromSession = binding ? binding.relay.session.id : null;
      // Halted (the crash-loop breaker): re-arm on the default session, as an
      // edit would — and, an explicit restart, on the page's default commit (a
      // sticky one too large for the device may be what crash-looped).
      if (binding?.relay.state.kind === "halted" && opts.snapshots === undefined && opts.initialBytes === undefined) {
        if (binding.relay.rearm) binding.setSessionMemory?.(null);
        return { accepted: binding.relay.rearm?.() === true, fromSession };
      }
      if (!binding || binding.relay.state.kind !== "serving") return { accepted: false, fromSession };
      const unknown = (opts.snapshots ?? []).filter((n) => !binding!.snapshotNames.includes(n));
      if (unknown.length > 0) throw new TypeError(`restart: unknown snapshot(s) ${unknown.join(", ")} (served: ${binding.snapshotNames.join(", ")})`);
      let initialBytes: number | undefined;
      if (opts.initialBytes !== undefined) {
        if (!binding.memoryBytes) throw new TypeError("restart: initialBytes is not supported here");
        initialBytes = binding.memoryBytes(opts.initialBytes);
      }
      // Sticky until the next explicit restart: crash reboots and header changes keep it.
      binding.setSessionMemory?.(initialBytes ?? null);
      // No snapshots given: this session's boot inputs, under the relay's own
      // rule (the remembered exact-imports options while the header still
      // matches, else the snapshot list it loaded) — never their commit: the
      // relay remembers the last restart's initialBytes too, and only this
      // call's (else the page default) may size the next session.
      const { initialBytes: _remembered, ...base }: RestartOptions = opts.snapshots ? { snapshots: [...opts.snapshots] } : binding.relay.reusableOpts() ?? (snapshotsNow() ? { snapshots: snapshotsNow()! } : {});
      binding.relay.restart(initialBytes !== undefined ? { ...base, initialBytes } : base);
      return { accepted: true, fromSession };
    },
    acceptOffer(kind?: OfferInfo["kind"]) {
      if (!offer || (kind !== undefined && kind !== offer.info.kind)) return false;
      const run = offer.run;
      run();
      return true;
    },
  });

  function emitBoot(label: string, info: ProgressInfo | null, done: boolean, failed: boolean, message: string | null) {
    boot = { stage: info?.stage ?? (failed ? "failed" : done ? "done" : boot.stage), label, done, failed, message, overlay: boot.overlay };
    emit("boot", {
      stage: boot.stage, phase: info?.phase ?? null, subject: info?.subject ?? null, label,
      loaded: info?.loaded ?? null, total: info?.total ?? null, unit: info?.unit ?? null, done, failed, message, error: info?.error ? { ...info.error } : null,
    });
  }

  function trackLiveness(s: RelayStatus) {
    const c = s.liveness;
    // A new session has proved nothing yet, and its heap is not the dead one's.
    if (s.session !== liveSession) { liveSession = s.session; liveCounters = null; lastAnswerAt = null; lastFrameAt = null; mem = null; }
    if (!c) return;
    const prev = liveCounters ?? { probes: 0, answered: 0, stalls: 0, resumed: 0, rescues: 0 };
    liveCounters = { ...c };
    const kinds: Array<[keyof typeof c, Events["liveness"]["kind"]]> = [["answered", "answered"], ["stalls", "stall"], ["resumed", "resumed"], ["rescues", "rescue"]];
    for (const [k, kind] of kinds) {
      if (c[k] > prev[k]) {
        if (kind === "answered") lastAnswerAt = timers.now();
        emit("liveness", { session: s.session, kind });
      }
    }
  }

  return {
    api,
    bind(b) {
      binding = b;
      const relay = b.relay;
      // `document`: what the relay forwarded (it recorded didOpen/didChange first).
      b.taps.onIn((msg) => {
        if ((msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") && relay.doc) {
          emit("document", { uri: relay.doc.uri, version: relay.doc.version, length: relay.lastText.length, text: relay.lastText });
        }
      });
      // `diagnostics` / `fileProgress` / the liveness frame clock: what the relay sends the editor.
      // Observers run before the relay posts (and postMessage clones only then): a payload is a
      // copy, or a listener editing it in place would edit what the editor receives.
      b.taps.onOut((m) => {
        if (!isSyntheticFrame(m) && !b.taps.fromPage(m)) lastFrameAt = timers.now(); // the page's own answers (the widget-source cache) prove nothing about Lean
        const params = m.params as { uri?: string; version?: number; diagnostics?: LspDiagnostic[]; textDocument?: { uri: string; version?: number }; processing?: Array<{ range: unknown; kind?: number }> } | undefined;
        if (m.method === "textDocument/publishDiagnostics" && params?.uri) {
          const diagnostics = structuredClone(params.diagnostics ?? []);
          emit("diagnostics", { uri: params.uri, version: params.version ?? null, diagnostics, origin: isSyntheticFrame(m) ? "qed64" : "lean" });
        } else if (m.method === "$/lean/fileProgress" && params?.textDocument) {
          pendingProgress = { uri: params.textDocument.uri, version: params.textDocument.version ?? null, processing: structuredClone(params.processing ?? []) };
          if (progressTimer === null) progressTimer = timers.setTimeout(flushProgress, FILE_PROGRESS_MS);
        }
      });
      if (mounted) for (const w of readyWaiters.splice(0)) w.ok();
    },
    editorReady() {
      mounted = true;
      if (binding) for (const w of readyWaiters.splice(0)) w.ok();
    },
    relayStatus(s) {
      // A status the page's own handling superseded (a self-widen restarts the
      // session inside the sink, so the replacement's status arrives first and
      // this stale one after it) is not reported: a headerRefused the page is
      // already widening is never a verdict.
      if (binding && s.session !== binding.relay.session.id) return;
      flushProgress();
      const prev = last;
      last = s;
      if (prev && prev.session !== s.session) {
        readySeen.clear(); // one session's (session, version) keys at a time
        emit("reboot", { reason: s.rebootReason, fromSession: prev.session, toSession: s.session });
      }
      if (s.lastDeath && s.lastDeath !== lastDeath) {
        const d = deathInfo(s.lastDeath)!;
        emit("death", { session: d.session, kind: d.kind, reason: d.reason, message: d.message, cause: d.cause, seq: d.seq, exitCode: d.exitCode, willReboot: s.relay === "rebooting", halted: s.phase === "halted" });
      }
      lastDeath = s.lastDeath;
      trackLiveness(s);
      emit("status", project(s));
      // A status listener may have restarted the session (an embedder's own
      // widening): this verdict is then superseded too.
      if (binding && s.session !== binding.relay.session.id) return;
      if (settledPhase(s.phase) && s.relay === "serving") {
        if (!boot.done && !boot.failed) emitBoot(boot.label, { stage: "done" }, true, false, null); // a reboot's boot ends here too
        const key = `${s.session}@${s.version}`;
        if (!readySeen.has(key)) {
          readySeen.add(key);
          emit("ready", { session: s.session, version: s.version, refused: s.phase === "headerRefused", header: headerOf(s.header) });
        }
      }
    },
    bootStep(label, info) { emitBoot(label, info, false, false, null); },
    bootFinished() {
      const wasOverlay = boot.overlay;
      boot = { ...boot, overlay: false };
      if (!boot.done) emitBoot(boot.label, { stage: "done" }, true, false, null);
      else if (wasOverlay) emit("status", statusNow());
    },
    bootFailed(message, cause) {
      if (boot.failed && boot.overlay && !cause) return; // the first report (with its cause) stands
      // A boot that failed before the page was up never will be: keep that for
      // every later caller (a `boot` listener's own included), release the waiters.
      if (!isBound()) failedBeforeUp = message;
      emitBoot(message, { stage: "failed", ...(cause ? { error: cause } : {}) }, false, true, message);
      if (!isBound()) for (const w of readyWaiters.splice(0)) w.fail(bootFailure());
    },
    // Tagged with its session: a reading is never paired with another session's commit,
    // even inside the sink pass of the status that changes the session.
    memory(currentBytes, maximumBytes) { mem = { currentBytes, maximumBytes, session: binding?.relay.session.id ?? null }; },
    setOffer(o, run) {
      const before = offer?.info ?? null;
      offer = o && run ? { info: { ...o }, run } : null;
      if (JSON.stringify(before) !== JSON.stringify(offer?.info ?? null)) emit("offer", offer ? { ...offer.info } : null);
    },
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

/** The boot document from a URL fragment (docs/EMBEDDING.md §3.1): `#code=`
 * (lean4web's spelling), at most 2 MiB of text. */
export function codeFromHash(hash: string): string | null {
  const m = /^#(?:.*&)?code=([^&]*)/.exec(hash);
  if (!m) return null;
  if (m[1]!.length > 3 * 2 * 1048576) return null; // > 2 MiB of text even fully percent-encoded
  try {
    const text = decodeURIComponent(m[1]!);
    return text.length <= 2 * 1048576 ? text : null;
  } catch { return null; }
}
