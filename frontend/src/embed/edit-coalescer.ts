// Full-text edit coalescing for a resident session (docs/EMBEDDING.md §7.8,
// docs/HARDENING.md #59). Every full-text didChange starts a fresh
// elaboration of the document from the edit on, and Lean abandons the
// previous one only at its next cancellation check: work that never checks
// (an `IO.sleep`, a long kernel check, a blocking `#eval`) keeps its thread
// alive. An embedder that sends a change per keystroke therefore starts
// dozens of elaborations a second, the runtime's pthread pool grows past its
// preallocated workers, and the tab dies of a V8 out-of-memory (lean4game,
// 2026-10-05: 9 changes in 230 ms, 24 → 38 workers; QED64's edit-storm lane:
// 59 changes in 600 ms above an `IO.sleep 3000`, 24 → 69, a crash every run).
// A client's own coalescing does not prevent it: vscode-languageclient holds
// a full-text change for 250 ms but flushes it before every request, and
// lean4monaco's requests (the InfoView's goals on a cursor move, inlay hints,
// code actions, semantic tokens) follow a keystroke whenever typing is slow
// enough for their debounces to fire between keys; a 10 ms/char burst stays
// one change (the edit-storm lane measures both). So the session coalesces
// for every caller, and holds those requests behind the change instead of
// letting them flush it (lean4game's measured throttle,
// client/src/wasm/change-throttle.ts):
//
//   * a full-text didChange is forwarded at once when no window is open, and
//     opens a window of `ms`; one arriving inside the window is held, the
//     newest replacing any held one (each carries the whole text, so nothing
//     is lost: Lean sees the newest version);
//   * while a change is held, every other frame (requests, their
//     cancellations, other notifications) is queued behind it in arrival
//     order; when the window ends the held change goes, then the queue, then
//     the next window opens. Every forwarded change opens a window, so under
//     a stream of changes Lean sees at most one per `ms` and the newest last,
//     and nothing is reordered relative to the text. A request queued behind
//     a change that a newer change replaces is answered against the newer
//     text, which is the client's view by then: editors cancel or re-issue
//     their position-bound requests on every content change, and the
//     InfoView re-asks at the cursor. The cost: a frame sent during a burst
//     waits up to `ms`;
//   * the exceptions are the requests whose reply Monaco rebases by the edits
//     made since the request, so that a reply computed on the newer text gets
//     the edit applied twice: document semantic tokens
//     (`textDocument/semanticTokens/full`, `/full/delta`, `/range`; the
//     highlighting lands one line off; exactly the requests
//     vscode-languageclient itself cancels on `ContentModified`) and
//     `textDocument/completion` (Monaco neither cancels nor re-issues it while
//     typing forward and shifts the reply by the typed delta; Lean's
//     option-name and error-name items carry an edit range on the server's
//     text, so accepting one would also delete the character after the
//     cursor). A queued one of these whose change a newer change replaces is
//     answered `ContentModified` (-32801) the moment that happens: what Lean
//     answers when the document changes under a request; the client refetches
//     the tokens and the next keystroke re-triggers the completion;
//   * didOpen, didClose, a ranged (or multi-part) didChange, a replay, and a
//     full-text change of another document first forward the held change and
//     the queue, then go (or are held) themselves: a held change never
//     crosses a document or a non-full-text edit. Such a flush can forward a
//     held change inside the window its predecessor opened (barriers never
//     wait); the window it opens makes the change after it wait in full;
//   * with nothing held, every frame goes at once;
//   * dispose drops the held change and the queue: the relay replays its last
//     full text into the replacement session and answers every request it
//     forwarded that the dead session did not (failInFlight).
//
// Re-entrancy: `reject` reaches the page synchronously (the relay's taps run
// before the reply is posted), and a page observer may send frames back in;
// `forward` posts to a Worker and never calls back. So the replacement path
// finishes every state change (the new held change, the pruned queue) before
// it answers a single request.
// Pure (injected timers): unit-tested under node.

/** The shape of a JSON-RPC frame this module reads (the session's own type is wider). */
export interface CoalescibleMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface EditCoalescer<M extends CoalescibleMessage> {
  /** Forward `msg` now, hold it (a full-text didChange inside a window), or queue it behind a held change. */
  send(msg: M, replay?: boolean): void;
  /** Drop the held change and the queue, and stop the window's timer. Later sends are ignored. */
  dispose(): void;
}

export interface EditCoalescerOptions<M extends CoalescibleMessage> {
  /** The frame goes to the worker. */
  forward(msg: M, replay?: boolean): void;
  /** A queued request is answered without reaching the worker (ContentModified, see above). */
  reject(request: M, error: JsonRpcError): void;
  /** The window; 0 forwards every frame at once. */
  ms: number;
  timers?: { setTimeout(f: () => void, ms: number): unknown; clearTimeout(t: unknown): void };
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

/** The requests whose reply the client rebases by its later edits: vscode-languageclient's RequestsToCancelOnContentModified, and completion. */
export const SUPERSEDED_METHODS: ReadonlySet<string> = new Set(["textDocument/semanticTokens/full", "textDocument/semanticTokens/full/delta", "textDocument/semanticTokens/range", "textDocument/completion"]);

/** The answer to such a request whose text a newer change replaced before it reached the checker (Lean's own code for it). */
export const SUPERSEDED: JsonRpcError = Object.freeze({
  code: -32801,
  message: "QED64: the document changed before this request reached the checker",
  data: { qed64: { kind: "superseded", reason: "a newer full-text change replaced the one this request was made against" } },
});

export function createEditCoalescer<M extends CoalescibleMessage>({ forward, reject, ms, timers = {
  setTimeout: (f, t) => setTimeout(f, t),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
} }: EditCoalescerOptions<M>): EditCoalescer<M> {
  let held: M | null = null;
  const queue: Array<{ msg: M; replay?: boolean }> = []; // non-empty only while a change is held
  let timer: unknown;
  let disposed = false;
  /** Every forwarded full-text change opens (or restarts) the window. */
  const sendChange = (m: M) => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(tick, ms);
    forward(m);
  };
  const flush = () => {
    if (held) { const m = held; held = null; sendChange(m); }
    for (const x of queue.splice(0)) forward(x.msg, x.replay);
  };
  function tick() {
    timer = undefined;
    if (held) flush(); // else the window closes: the next change goes at once
  }
  return {
    send(msg, replay) {
      if (disposed) return;
      if (ms > 0 && !replay && isFullTextChange(msg)) {
        if (held && uriOf(held) !== uriOf(msg)) flush(); // another document: never merge across documents
        if (timer === undefined) return sendChange(msg);
        const replaced = held;
        held = msg; // newest wins; the queue stays behind it
        if (!replaced) return;
        const uri = uriOf(replaced);
        const superseded: Array<{ msg: M }> = [];
        for (let i = 0; i < queue.length;) {
          const q = queue[i]!;
          if (q.msg.id !== undefined && q.msg.method !== undefined && SUPERSEDED_METHODS.has(q.msg.method) && uriOf(q.msg) === uri) { queue.splice(i, 1); superseded.push(q); } else i += 1;
        }
        for (const q of superseded) reject(q.msg, SUPERSEDED);
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
