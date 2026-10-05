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
//   * while a change is held, every other frame (requests, other
//     notifications) is queued behind it in arrival order; when the window
//     ends the held change goes, then the queue, then the next window opens.
//     Every forwarded change opens a window, so under a stream of changes
//     Lean sees at most one per `ms` and the newest last, and nothing is
//     reordered relative to the text. A request queued behind a change that
//     a newer change replaces is answered against the newer text, which is
//     the client's view by then: editors cancel or re-issue their
//     position-bound requests on every content change, and the InfoView
//     re-asks at the cursor. The cost: a frame sent during a burst waits up
//     to `ms`;
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
//     cursor). A queued one of these that a newer change passes (replacing
//     the held change it waited behind, or going ahead of it while it waits
//     for a request slot, below) is answered `ContentModified` (-32801) the
//     moment that happens: the code clients treat as "ask again"; the client
//     refetches the tokens and the next keystroke re-triggers the completion;
//   * didOpen, didClose, a ranged (or multi-part) didChange, a replay, and a
//     full-text change of another document first forward the held change and
//     the queue, then go (or are held) themselves: a held change never
//     crosses a document or a non-full-text edit. Such a flush can forward a
//     held change inside the window its predecessor opened (barriers never
//     wait); the window it opens makes the change after it wait in full;
//   * with nothing held and a request slot free, every frame goes at once;
//   * dispose drops the held change and the queue: the relay replays its last
//     full text into the replacement session and answers every request it
//     forwarded that the dead session did not (failInFlight).
//
// Back-pressure (the window caps bursts, not a sustained pace: two keystrokes
// 150 ms apart rarely share a window, so at that pace nearly every change is
// forwarded, each a new elaboration, and the pool still grows; the stock
// page typing at 150 ms/char above an `IO.sleep 3000` with the InfoView open
// crashed on every build, HARDENING #59). Two controls, both keyed on what
// the worker and the session already see:
//
//   * THE POOL. The host feeds the coalescer the worker's pool sample
//     (`WorkerStatus.pool`, `observe`). The pool is PRESSURED while its last
//     sample shows fewer than `minFreeWorkers` preallocated Workers free
//     (`unused < K`; default 6 of the runtime's 24, so while more than 18
//     pthreads are alive), and for `pressureMemoryMs` (default 1000) after
//     the last such sample: request threads live for milliseconds, so the
//     count flaps between 2 and 12 free inside one 100 ms interval, and a
//     window's end that happened to see a drained sample forwarded another
//     elaboration (the lane's second run: the hold engaged twice in 6 s
//     while eight versions went through). A hold that only the memory keeps
//     is re-checked when the memory expires, without waiting for a sample
//     (an idle worker emits none: on a cheap document such a hold ran to its
//     cap with the pool drained the whole time). A sample that did not
//     measure the pool (`unused` -1) never pressures. A change that is held when its window ends stays
//     held while the pool is pressured, with the frames behind it; a later
//     sample showing the pool drained (`unused >= K`) releases it at once:
//     the newest change, then the queue, and a new window opens. A change
//     arriving with no window open while the pool is pressured is held the
//     same way instead of going at once. Newest wins during the hold exactly
//     as inside the window. The hold is capped: `maxHoldMs` (default 5000)
//     after it began, the newest change goes regardless, and the cap is not
//     restarted by a newer change replacing the held one (a sustained pace
//     under sustained pressure sees one change per `ms + maxHoldMs`, never
//     none). Samples arrive only with the worker's status events (every
//     server frame), so a silent worker is what the cap is for;
//   * REQUESTS IN FLIGHT. Each request Lean is handling is a task on its own
//     dedicated thread while it waits for its snapshot, and a thread is a
//     Worker: ~90 requests released at once above a 3 s `IO.sleep` grew the
//     pool 24 → 64 within 400 ms (the lane's first run of the pool hold
//     alone). So at most `maxInFlightRequests` (default 6) requests are at
//     the worker unanswered; the next waits at the head of the queue, and
//     every frame behind it waits in order. The host reports replies
//     (`settle`), each of which admits the next. A full-text change never
//     waits for a slot: it goes ahead of the waiting requests (answered
//     against the newer text, the rule above). A `$/cancelRequest` whose
//     request is still queued answers it `RequestCancelled` (-32800) here,
//     what Lean would answer, and spares the worker the task; one for a
//     request already forwarded goes at once (it waits for nothing: the
//     request it names is already there). Barriers and replays flush the
//     whole queue past the cap (they never wait);
//   * `minFreeWorkers` 0 disables the hold, `maxInFlightRequests` 0 the cap,
//     and with no sample ever observed the hold never engages.
//
// Re-entrancy: `reject` reaches the page synchronously (the relay's taps run
// before the reply is posted), and a page observer may send frames back in;
// `forward` posts to a Worker and never calls back. So every path finishes
// its state changes (the new held change, the pruned queue) before it
// answers a single request. `observe` and `settle` run inside the worker's
// own events; from there the coalescer only forwards.
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

/** The worker's pool sample (`WorkerStatus.pool`): preallocated Workers free, pthreads alive; -1 = not measured. */
export interface PoolSample {
  unused: number;
  running: number;
  parked?: number;
}

/** What the back-pressure did, for a host's log or counters. */
export interface BackPressureEvent {
  /** `hold`: a change is now held for the pool; `release`: a sample showed it drained; `cap`: the hold hit `maxHoldMs`;
   * `wait`: a request waits for a slot (nothing held). */
  kind: "hold" | "release" | "cap" | "wait";
  /** The last sample (a zero sample when none was observed yet). */
  pool: PoolSample;
  /** Frames waiting in the queue at that moment. */
  queued: number;
  /** Requests at the worker unanswered. */
  inFlight: number;
  /** For `release` and `cap`: how long the change was held for the pool. */
  heldMs?: number;
}

export interface BackPressureOptions {
  /** Hold full-text changes while the last sample shows fewer free preallocated Workers than this; 0 disables. Default 6. */
  minFreeWorkers?: number;
  /** The longest hold for the pool; then the newest change goes regardless. Default 5000. */
  maxHoldMs?: number;
  /** The pool stays pressured this long after its last pressured sample (the count flaps as short request threads come and go). Default 1000. */
  pressureMemoryMs?: number;
  /** Requests at the worker unanswered at any time; the rest wait in order. 0 = no cap. Default 6. */
  maxInFlightRequests?: number;
  onEvent?(event: BackPressureEvent): void;
}

export interface EditCoalescer<M extends CoalescibleMessage> {
  /** Forward `msg` now, hold it (a full-text didChange inside a window, or under a pressured pool), or queue it. */
  send(msg: M, replay?: boolean): void;
  /** The worker's latest pool sample (`WorkerStatus.pool`); anything else counts as no sample. */
  observe(pool: PoolSample | null | undefined): void;
  /** A reply reached the host: the request with this id is no longer in flight (unknown ids are ignored). */
  settle(id: number | string): void;
  /** Drop the held change and the queue, and stop the timers. Later sends are ignored. */
  dispose(): void;
}

export interface EditCoalescerOptions<M extends CoalescibleMessage> {
  /** The frame goes to the worker. */
  forward(msg: M, replay?: boolean): void;
  /** A queued request is answered without reaching the worker (ContentModified or RequestCancelled, see above). */
  reject(request: M, error: JsonRpcError): void;
  /** The window; 0 forwards every change at once. */
  ms: number;
  timers?: { setTimeout(f: () => void, ms: number): unknown; clearTimeout(t: unknown): void; now?(): number };
  backPressure?: BackPressureOptions;
}

/** True for a didChange whose single content change is the whole text. */
export function isFullTextChange(msg: CoalescibleMessage): boolean {
  if (msg.method !== "textDocument/didChange") return false;
  const changes = (msg.params as { contentChanges?: Array<{ text?: unknown; range?: unknown }> } | undefined)?.contentChanges;
  return Array.isArray(changes) && changes.length === 1 && typeof changes[0]?.text === "string" && changes[0]?.range === undefined;
}

const uriOf = (msg: CoalescibleMessage): unknown => (msg.params as { textDocument?: { uri?: unknown } } | undefined)?.textDocument?.uri;
const isRequest = (msg: CoalescibleMessage): boolean => msg.id !== undefined && msg.method !== undefined;
const cancelTarget = (msg: CoalescibleMessage): number | string | undefined =>
  msg.method === "$/cancelRequest" && msg.id === undefined ? (msg.params as { id?: number | string } | undefined)?.id : undefined;
/** Frames that must not wait behind a held full-text change: they change the document set or edit it partially. */
const isBarrier = (msg: CoalescibleMessage): boolean =>
  msg.method === "textDocument/didOpen" || msg.method === "textDocument/didClose" || (msg.method === "textDocument/didChange" && !isFullTextChange(msg));

/** The requests whose reply the client rebases by its later edits: vscode-languageclient's RequestsToCancelOnContentModified, and completion. */
export const SUPERSEDED_METHODS: ReadonlySet<string> = new Set(["textDocument/semanticTokens/full", "textDocument/semanticTokens/full/delta", "textDocument/semanticTokens/range", "textDocument/completion"]);

/** The answer to such a request that a newer full-text change passed before it reached the checker. */
export const SUPERSEDED: JsonRpcError = Object.freeze({
  code: -32801,
  message: "QED64: the document changed before this request reached the checker",
  data: { qed64: { kind: "superseded", reason: "a newer full-text change replaced the one this request was made against" } },
});

/** The answer to a queued request whose `$/cancelRequest` arrived before it reached the checker (LSP RequestCancelled, Lean's own answer to a cancelled request). */
export const CANCELLED: JsonRpcError = Object.freeze({
  code: -32800,
  message: "QED64: the client cancelled this request before it reached the checker",
  data: { qed64: { kind: "cancelled", reason: "its $/cancelRequest arrived while it was queued" } },
});

/** The default window: lean4game's measured mitigation (at most one full-text change per 300 ms). */
export const DEFAULT_EDIT_COALESCE_MS = 300;
/** Hold while fewer than this many preallocated Workers are free: 6 of the runtime's 24 keeps the live pthreads at or under 18. */
export const DEFAULT_MIN_FREE_WORKERS = 6;
/** The longest a change is held for the pool. */
export const DEFAULT_MAX_HOLD_MS = 5000;
/** The pool counts as pressured this long after its last pressured sample: longer than the flap of a short request thread, shorter than a window plus a hold. */
export const DEFAULT_PRESSURE_MEMORY_MS = 1000;
/** Requests at the worker unanswered at any time: each is a dedicated thread while it waits; one keystroke's four or five fit, and the rest wait here. */
export const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 6;

const NO_SAMPLE: PoolSample = Object.freeze({ unused: -1, running: -1 });

export function createEditCoalescer<M extends CoalescibleMessage>({ forward, reject, ms, timers = {
  setTimeout: (f, t) => setTimeout(f, t),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}, backPressure = {} }: EditCoalescerOptions<M>): EditCoalescer<M> {
  const minFree = backPressure.minFreeWorkers ?? DEFAULT_MIN_FREE_WORKERS;
  const maxHold = backPressure.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const memory = backPressure.pressureMemoryMs ?? DEFAULT_PRESSURE_MEMORY_MS;
  const maxInFlight = backPressure.maxInFlightRequests ?? DEFAULT_MAX_IN_FLIGHT_REQUESTS;
  const now = () => (timers.now ? timers.now() : Date.now());
  let held: M | null = null;
  /** Frames waiting (never a replay): behind a held change, or for a request slot. `seq` is the change count when they arrived (a later change passes them). */
  const queue: Array<{ msg: M; seq: number }> = [];
  let changeSeq = 0;
  const pending = new Set<number | string>(); // requests forwarded and not yet settled
  let timer: unknown; // the window
  let cap: unknown; // set exactly while a change is held for the pool (never together with the window's timer)
  let recheck: unknown; // while a hold is on: the memory's expiry, when the last sample may already be drained
  let heldSince = 0;
  let pool: PoolSample | null = null;
  let lastPressuredAt = -Infinity; // when the last pressured sample was observed
  let disposed = false;
  // No `minFree > 0` or `ms > 0` guard: a threshold of 0 is unsatisfiable by a measured count, and a window of 0 never holds (send).
  const sampled = (p: PoolSample | null) => p !== null && p.unused >= 0 && p.unused < minFree;
  const pressured = () => sampled(pool) || now() - lastPressuredAt < memory;
  const slotFree = () => maxInFlight <= 0 || pending.size < maxInFlight;
  const event = (kind: BackPressureEvent["kind"], heldMs?: number) => {
    if (backPressure.onEvent) backPressure.onEvent({ kind, pool: pool ?? NO_SAMPLE, queued: queue.length, inFlight: pending.size, ...(heldMs === undefined ? {} : { heldMs }) });
  };
  const endHold = () => {
    if (cap !== undefined) timers.clearTimeout(cap);
    cap = undefined;
    if (recheck !== undefined) timers.clearTimeout(recheck);
    recheck = undefined;
  };
  /** The memory's expiry: a hold the last sample does not justify ends then, with no new sample needed. */
  const scheduleRecheck = () => {
    if (recheck !== undefined) timers.clearTimeout(recheck);
    recheck = timers.setTimeout(() => { recheck = undefined; if (cap !== undefined && !pressured()) { event("release", now() - heldSince); release(); } }, Math.max(0, lastPressuredAt + memory - now()));
  };
  /** To the worker, counted when it is a request (a replay never comes through here: it is the relay's, answered or failed by it). */
  const admit = (m: M) => {
    if (maxInFlight > 0 && isRequest(m)) pending.add(m.id as number | string);
    forward(m);
  };
  /** Every forwarded full-text change opens (or restarts) the window. */
  const sendChange = (m: M) => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(tick, ms);
    forward(m);
  };
  /** The queue, in order, as far as the request slots allow (a request at the head with no slot stops it; nothing passes it). */
  const drain = () => {
    while (queue.length > 0 && !held) {
      const x = queue[0]!;
      if (isRequest(x.msg) && !slotFree()) return;
      queue.shift();
      admit(x.msg);
    }
  };
  /** The held change, then the queue within the slots: a window's end, a pool release, the cap. */
  const release = () => {
    endHold();
    if (held) { const m = held; held = null; sendChange(m); }
    drain();
  };
  /** The held change, then the WHOLE queue: a barrier never waits, and nothing may stay behind one. */
  const flushAll = () => {
    endHold();
    if (held) { const m = held; held = null; sendChange(m); }
    for (const x of queue.splice(0)) admit(x.msg);
  };
  /** The held change stays: the pool is pressured and no window is open. */
  const hold = () => {
    heldSince = now();
    cap = timers.setTimeout(capped, maxHold);
    if (!sampled(pool)) scheduleRecheck(); // held by the memory alone
    event("hold");
  };
  function capped() {
    cap = undefined;
    event("cap", now() - heldSince);
    release();
  }
  function tick() {
    timer = undefined;
    if (!held) return; // the window closes: the next change goes at once
    if (pressured()) hold(); else release();
  }
  /** A change is going ahead of everything queued before it: the queued requests Monaco would rebase are answered now (after every state change). */
  const supersede = (uri: unknown) => {
    const superseded: M[] = [];
    for (let i = 0; i < queue.length;) {
      const q = queue[i]!;
      if (q.seq < changeSeq && isRequest(q.msg) && SUPERSEDED_METHODS.has(q.msg.method as string) && uriOf(q.msg) === uri) { queue.splice(i, 1); superseded.push(q.msg); } else i += 1;
    }
    for (const m of superseded) reject(m, SUPERSEDED);
  };
  return {
    send(msg, replay) {
      if (disposed) return;
      if (ms > 0 && !replay && isFullTextChange(msg)) {
        if (held && uriOf(held) !== uriOf(msg)) flushAll(); // another document: never merge across documents
        changeSeq += 1;
        if (!held) {
          if (timer === undefined && !pressured()) { sendChange(msg); supersede(uriOf(msg)); return; } // ahead of requests waiting for a slot
          held = msg;
          if (timer === undefined) hold(); // quiet, but the pool is pressured: held until a sample frees it or the cap ends
        } else {
          held = msg; // newest wins; the queue stays behind it, and a hold for the pool keeps its cap
        }
        supersede(uriOf(msg));
        return;
      }
      const target = replay ? undefined : cancelTarget(msg);
      if (target !== undefined) {
        const i = queue.findIndex((q) => isRequest(q.msg) && q.msg.id === target);
        if (i < 0) { forward(msg); return; } // in flight (or unknown): it names a request already at the worker, so it waits for nothing
        const [q] = queue.splice(i, 1);
        reject(q!.msg, CANCELLED);
        return;
      }
      if (!replay && !isBarrier(msg)) {
        if (held) { queue.push({ msg, seq: changeSeq }); return; } // in order behind the held change
        if (queue.length > 0 || (isRequest(msg) && !slotFree())) { // in order behind a request waiting for a slot, or waiting itself
          queue.push({ msg, seq: changeSeq });
          if (isRequest(msg)) event("wait");
          return;
        }
        admit(msg);
        return;
      }
      flushAll();
      forward(msg, replay);
    },
    observe(sample) {
      pool = sample && typeof sample.unused === "number" && typeof sample.running === "number" ? sample : null;
      if (sampled(pool)) { lastPressuredAt = now(); if (cap !== undefined) scheduleRecheck(); }
      if (cap !== undefined && !pressured()) { event("release", now() - heldSince); release(); }
    },
    settle(id) {
      if (pending.delete(id)) drain();
    },
    dispose() {
      disposed = true;
      held = null;
      queue.length = 0; // the requests in flight need no clearing: nothing is admitted after this
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      endHold();
    },
  };
}
