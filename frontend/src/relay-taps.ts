// Page-side taps on the relay's two directions (docs/EMBEDDING.md §2.4, §9).
//
// The relay is budget-capped and knows nothing of embedders; the page observes
// and, in two narrow cases, answers LSP traffic around it instead of inside it:
//   * client → relay (`fromClient`): observers see each message after the
//     relay recorded it (so `relay.doc` / `relay.lastText` are current), and an
//     interceptor may answer a client message itself (the widget-source cache);
//   * relay → client (`toClient`): observers see each message before it is
//     posted, and an interceptor may consume one (the test hatch swallows the
//     replies to its own injected requests).
// One wrapper per relay (idempotent), so the page API, the widget-source cache
// and the test hatch compose. A throwing hook is logged, never propagated into
// the relay.

export interface LspMessage { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown }

/** The slice of LspRelay the taps wrap (both are public methods on the relay). */
export interface TappableRelay {
  fromClient(msg: LspMessage): void;
  toClient(msg: LspMessage): void;
}

export interface RelayTaps {
  /** client → relay, after the relay recorded it (also for intercepted messages). */
  onIn(fn: (msg: LspMessage) => void): () => void;
  /** relay → client, before it is posted (not for consumed messages). */
  onOut(fn: (msg: LspMessage) => void): () => void;
  /** Answer or drop a client message instead of forwarding it: return true when handled. */
  interceptIn(fn: (msg: LspMessage) => boolean): () => void;
  /** Consume a relay → client message: return true to drop it. */
  interceptOut(fn: (msg: LspMessage) => boolean): () => void;
  /** Post to the client as the relay would (observers and interceptors run).
   * The message is marked as the page's own (`fromPage`). */
  toClient(msg: LspMessage): void;
  /** Did the page itself post this message (not the Lean side, not the relay)? */
  fromPage(msg: LspMessage): boolean;
  /** Hand the relay a message as the client would (bypasses `interceptIn`). */
  toRelay(msg: LspMessage): void;
}

const tapped = new WeakMap<object, RelayTaps>();

/** Interceptors: the first that returns true handles the message. */
function intercepts<T extends unknown[]>(set: Set<(...a: T) => boolean>, name: string) {
  return (...a: T): boolean => {
    for (const f of [...set]) {
      try { if (f(...a) === true) return true; } catch (e) { console.error(`[qed64] relay tap (${name}) threw`, e); }
    }
    return false;
  };
}
/** Observers: every one runs, whatever it returns. */
function observers<T extends unknown[]>(set: Set<(...a: T) => unknown>, name: string) {
  return (...a: T): void => {
    for (const f of [...set]) {
      try { f(...a); } catch (e) { console.error(`[qed64] relay tap (${name}) threw`, e); }
    }
  };
}

export function tapRelay(relay: TappableRelay): RelayTaps {
  const existing = tapped.get(relay);
  if (existing) return existing;
  const ins = new Set<(m: LspMessage) => void>();
  const outs = new Set<(m: LspMessage) => void>();
  const inIntercepts = new Set<(m: LspMessage) => boolean>();
  const outIntercepts = new Set<(m: LspMessage) => boolean>();
  const runIns = observers(ins, "in");
  const runOuts = observers(outs, "out");
  const interceptedIn = intercepts(inIntercepts, "intercept in");
  const interceptedOut = intercepts(outIntercepts, "intercept out");
  const pageMade = new WeakSet<object>();
  const forward = relay.fromClient.bind(relay);
  const post = relay.toClient.bind(relay);
  // Instance properties shadow the prototype methods: the relay's own port
  // handler and its internal replies call `this.fromClient` / `this.toClient`.
  relay.fromClient = (msg: LspMessage) => {
    if (!interceptedIn(msg)) forward(msg);
    runIns(msg);
  };
  relay.toClient = (msg: LspMessage) => {
    if (interceptedOut(msg)) return;
    runOuts(msg);
    post(msg);
  };
  const add = <F>(set: Set<F>) => (fn: F) => { set.add(fn); return () => { set.delete(fn); }; };
  const taps: RelayTaps = {
    onIn: add(ins),
    onOut: add(outs),
    interceptIn: add(inIntercepts),
    interceptOut: add(outIntercepts),
    toClient: (msg) => { pageMade.add(msg); relay.toClient(msg); },
    fromPage: (msg) => typeof msg === "object" && msg !== null && pageMade.has(msg),
    toRelay: (msg) => { forward(msg); runIns(msg); },
  };
  tapped.set(relay, taps);
  return taps;
}
