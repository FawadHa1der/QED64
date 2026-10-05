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
// A client's own coalescing does not prevent it: lean4monaco's language
// client sends its per-keystroke requests (semantic tokens, inlay hints,
// code actions, the InfoView's goals) right after each change, and flushes
// its pending change before each of them. So the session coalesces for every
// caller, and holds those requests behind the change instead of letting them
// flush it (lean4game's measured throttle, client/src/wasm/change-throttle.ts):
//
//   * a full-text didChange is forwarded at once when no window is open, and
//     opens a window of `ms`; one arriving inside the window is held, the
//     newest replacing any held one (each carries the whole text, so nothing
//     is lost: Lean sees the newest version);
//   * while a change is held, every other frame (requests, their
//     cancellations, other notifications) is queued behind it in arrival
//     order; when the window ends the held change goes, then the queue, then
//     the next window opens. A stream of changes reaches Lean at most once per
//     `ms`, the newest last, and nothing is reordered relative to the text: a
//     request queued behind a change that a newer one replaced is answered
//     against the newer text, which is the client's view by then. The cost: a
//     frame sent during a burst waits up to `ms`;
//   * didOpen, didClose, a ranged (or multi-part) didChange, a replay, and a
//     full-text change of another document first forward the held change and
//     the queue, then go (or are held) themselves: a held change never
//     crosses a document or a non-full-text edit;
//   * with nothing held, every frame goes at once;
//   * dispose drops the held change and the queue: the relay replays its last
//     full text into the replacement session and answers every request it
//     forwarded that the dead session did not (failInFlight).
//
// Pure (injected timers): unit-tested under node.

/** The shape of a JSON-RPC frame this module reads (the session's own type is wider). */
export interface CoalescibleMessage {
  method?: string;
  params?: unknown;
}

export interface EditCoalescer<M extends CoalescibleMessage> {
  /** Forward `msg` now, hold it (a full-text didChange inside a window), or queue it behind a held change. */
  send(msg: M, replay?: boolean): void;
  /** Drop the held change and the queue, and stop the window's timer. Later sends are ignored. */
  dispose(): void;
}

/** True for a didChange whose single content change is the whole text. */
export function isFullTextChange(msg: CoalescibleMessage): boolean {
  if (msg.method !== "textDocument/didChange") return false;
  const changes = (msg.params as { contentChanges?: Array<{ text?: unknown; range?: unknown }> } | undefined)?.contentChanges;
  return Array.isArray(changes) && changes.length === 1 && typeof changes[0]?.text === "string" && changes[0]?.range === undefined;
}

const uriOf = (msg: CoalescibleMessage): unknown => (msg.params as { textDocument?: { uri?: unknown } } | undefined)?.textDocument?.uri;
/** Frames that must not wait behind a held full-text change: they change the document set or edit it partially. */
const isBarrier = (msg: CoalescibleMessage): boolean =>
  msg.method === "textDocument/didOpen" || msg.method === "textDocument/didClose" || (msg.method === "textDocument/didChange" && !isFullTextChange(msg));

export function createEditCoalescer<M extends CoalescibleMessage>(
  forward: (msg: M, replay?: boolean) => void,
  ms: number,
  timers: { setTimeout(f: () => void, ms: number): unknown; clearTimeout(t: unknown): void } = {
    setTimeout: (f, t) => setTimeout(f, t),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): EditCoalescer<M> {
  let held: M | null = null;
  const queue: Array<{ msg: M; replay?: boolean }> = []; // non-empty only while a change is held
  let timer: unknown;
  let disposed = false;
  const flush = () => {
    if (held) { const m = held; held = null; forward(m); }
    for (const q of queue.splice(0)) forward(q.msg, q.replay);
  };
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
        else held = msg; // newest wins; the queue stays behind it
        return;
      }
      if (held && !replay && !isBarrier(msg)) { queue.push({ msg, replay }); return; }
      flush();
      forward(msg, replay);
    },
    dispose() {
      disposed = true;
      held = null;
      queue.length = 0;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** The default window: lean4game's measured mitigation (at most one full-text change per 300 ms). */
export const DEFAULT_EDIT_COALESCE_MS = 300;
