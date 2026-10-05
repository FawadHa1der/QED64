// Full-text edit coalescing for a resident session (docs/EMBEDDING.md §7.8,
// docs/HARDENING.md #59). Every full-text didChange starts a fresh
// elaboration of the document from the edit on, and Lean abandons the
// previous one only at its next cancellation check: work that never checks
// (an `IO.sleep`, a long kernel check, a blocking `#eval`) keeps its thread
// alive. An embedder that sends a change per keystroke therefore starts
// dozens of elaborations a second, the runtime's pthread pool grows past its
// preallocated workers, and the tab dies of a V8 out-of-memory (lean4game,
// 2026-10-05: 9 changes in 230 ms, 24 → 38 workers; QED64's raw-edit probe:
// 59 changes in 600 ms above an `IO.sleep 3000`, 24 → 69, a crash every run).
// vscode-languageclient coalesces on the page (250 ms); a library embedder
// with its own editor did not, so the session does it for every caller:
//
//   * a full-text didChange is forwarded at once when no window is open, and
//     opens a window of `ms`; one arriving inside the window is held, the
//     newest replacing any held one (each carries the whole text, so nothing
//     is lost: Lean sees the newest version);
//   * when the window ends, the held change (if any) is forwarded and opens
//     the next window, so a stream of changes reaches Lean at most once per
//     `ms`, the newest last;
//   * anything else (a request, any other notification, a ranged change, a
//     replay) first forwards the held change, then itself, so Lean never
//     answers a request about text it has not been sent (vscode-languageclient
//     flushes before a request the same way);
//   * dispose drops the held change: the relay replays its last full text
//     into the replacement session.
//
// Pure (injected timers): unit-tested under node.

/** The shape of a JSON-RPC frame this module reads (the session's own type is wider). */
export interface CoalescibleMessage {
  method?: string;
  params?: unknown;
}

export interface EditCoalescer<M extends CoalescibleMessage> {
  /** Forward `msg` now, or hold it (a full-text didChange inside a window). */
  send(msg: M, replay?: boolean): void;
  /** Drop any held change and stop the window's timer. Later sends are ignored. */
  dispose(): void;
}

/** True for a didChange whose single content change is the whole text. */
export function isFullTextChange(msg: CoalescibleMessage): boolean {
  if (msg.method !== "textDocument/didChange") return false;
  const changes = (msg.params as { contentChanges?: Array<{ text?: unknown; range?: unknown }> } | undefined)?.contentChanges;
  return Array.isArray(changes) && changes.length === 1 && typeof changes[0]?.text === "string" && changes[0]?.range === undefined;
}

const uriOf = (msg: CoalescibleMessage): unknown => (msg.params as { textDocument?: { uri?: unknown } } | undefined)?.textDocument?.uri;

export function createEditCoalescer<M extends CoalescibleMessage>(
  forward: (msg: M, replay?: boolean) => void,
  ms: number,
  timers: { setTimeout(f: () => void, ms: number): unknown; clearTimeout(t: unknown): void } = {
    setTimeout: (f, t) => setTimeout(f, t),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): EditCoalescer<M> {
  let held: M | null = null;
  let timer: unknown;
  let disposed = false;
  const flush = () => { if (held) { const m = held; held = null; forward(m); } };
  const tick = () => {
    timer = undefined;
    if (!held) return; // the window closes: the next change goes at once
    flush();
    timer = timers.setTimeout(tick, ms);
  };
  return {
    send(msg, replay) {
      if (disposed) return;
      if (ms > 0 && !replay && isFullTextChange(msg)) {
        if (held && uriOf(held) !== uriOf(msg)) flush(); // another document: never merge across documents
        if (timer === undefined) { forward(msg); timer = timers.setTimeout(tick, ms); }
        else held = msg;
        return;
      }
      flush();
      forward(msg, replay);
    },
    dispose() {
      disposed = true;
      held = null;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** The default window: lean4game's measured mitigation (at most one full-text change per 300 ms). */
export const DEFAULT_EDIT_COALESCE_MS = 300;
