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
  /** Post to the client as the relay would (observers and interceptors run). */
  toClient(msg: LspMessage): void;
  /** Hand the relay a message as the client would (bypasses `interceptIn`). */
  toRelay(msg: LspMessage): void;
}

const tapped = new WeakMap<object, RelayTaps>();

function hook<T extends unknown[]>(set: Set<(...a: T) => unknown>, name: string) {
  return (...a: T): boolean => {
    let handled = false;
    for (const f of [...set]) {
      try { if (f(...a) === true) handled = true; } catch (e) { console.error(`[qed64] relay tap (${name}) threw`, e); }
      if (handled) break;
    }
    return handled;
  };
}

export function tapRelay(relay: TappableRelay): RelayTaps {
  const existing = tapped.get(relay);
  if (existing) return existing;
  const ins = new Set<(m: LspMessage) => void>();
  const outs = new Set<(m: LspMessage) => void>();
  const inIntercepts = new Set<(m: LspMessage) => boolean>();
  const outIntercepts = new Set<(m: LspMessage) => boolean>();
  const runIns = hook(ins, "in");
  const runOuts = hook(outs, "out");
  const interceptedIn = hook(inIntercepts, "intercept in");
  const interceptedOut = hook(outIntercepts, "intercept out");
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
    toClient: (msg) => relay.toClient(msg),
    toRelay: (msg) => { forward(msg); runIns(msg); },
  };
  tapped.set(relay, taps);
  return taps;
}
