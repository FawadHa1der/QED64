// Lean.Widget.getWidgetSource, coalesced by hash per session
// (docs/EMBEDDING.md §2.1 `capabilities.widgetSourceCache`; the widgets
// showcase's "D3").
//
// Every rendered user widget asks the server for its module source by hash
// (`$/lean/rpc/call` with method `Lean.Widget.getWidgetSource`). A page with
// many instances of one widget — a gallery of examples, a goal list that
// re-renders on every keystroke — sends the same request dozens of times, and
// each answer is the whole JS module crossing the worker, the relay and the
// InfoView iframe. The showcase coalesced them in its own bridge; since the
// InfoView RPC fix (HARDENING #56) the request travels as
// startClientRequest/awaitClientRequest and that bridge no longer sees it, so
// the page does it here, on the relay's taps:
//   * the first request for a hash goes to the worker (the leader); later ones
//     for the same hash wait for its reply instead of being forwarded;
//   * a result is cached for the session that produced it, and answers every
//     later request at once; a new session (crash reboot, restart) starts empty;
//   * an error reply releases every waiter with that error, except a
//     cancellation of the leader alone (-32800), which promotes the next waiter
//     to leader; a waiter's own `$/cancelRequest` is answered RequestCancelled
//     and never reaches the worker.
import type { LspMessage, RelayTaps } from "./relay-taps";

const METHOD = "Lean.Widget.getWidgetSource";
const REQUEST_CANCELLED = -32800;

type Id = number | string;
interface Flight { hash: string; session: string; leader: Id; waiters: LspMessage[] }

export interface WidgetSourceCache {
  stats(): { hits: number; coalesced: number; forwarded: number; cached: number };
}

const hashOf = (msg: LspMessage): string | null => {
  if (msg.method !== "$/lean/rpc/call" || msg.id === undefined) return null;
  const p = msg.params as { method?: string; params?: { hash?: unknown } } | undefined;
  if (p?.method !== METHOD) return null;
  const h = p.params?.hash;
  return typeof h === "string" || typeof h === "number" ? String(h) : null;
};

export function installWidgetSourceCache(taps: RelayTaps, currentSession: () => string): WidgetSourceCache {
  let cacheSession = "";
  let cache = new Map<string, unknown>();
  const flights = new Map<string, Flight>(); // by hash
  const byLeader = new Map<Id, Flight>();
  const stats = { hits: 0, coalesced: 0, forwarded: 0 };

  const sessionCache = () => {
    const s = currentSession();
    if (s !== cacheSession) { cacheSession = s; cache = new Map(); }
    return cache;
  };
  const land = (f: Flight) => { if (flights.get(f.hash) === f) flights.delete(f.hash); }; // a newer session's flight for the hash stays
  const reply = (id: Id, body: { result: unknown } | { error: unknown }) => taps.toClient({ jsonrpc: "2.0", id, ...body });

  taps.interceptIn((msg) => {
    if (msg.method === "$/cancelRequest") {
      const id = (msg.params as { id?: Id } | undefined)?.id;
      for (const f of flights.values()) {
        const i = f.waiters.findIndex((w) => w.id === id);
        if (i >= 0) {
          f.waiters.splice(i, 1);
          reply(id!, { error: { code: REQUEST_CANCELLED, message: "request cancelled" } });
          return true;
        }
      }
      return false; // the leader's (or anything else's) cancel goes to the worker
    }
    const hash = hashOf(msg);
    if (hash === null) return false;
    const c = sessionCache();
    if (c.has(hash)) { stats.hits += 1; reply(msg.id!, { result: c.get(hash) }); return true; }
    const f = flights.get(hash);
    if (f && f.session === cacheSession) { stats.coalesced += 1; f.waiters.push(msg); return true; }
    const flight: Flight = { hash, session: cacheSession, leader: msg.id!, waiters: [] };
    flights.set(hash, flight);
    byLeader.set(msg.id!, flight);
    stats.forwarded += 1;
    return false; // the leader goes to the worker
  });

  taps.onOut((msg) => {
    if (msg.id === undefined || msg.method !== undefined) return;
    const f = byLeader.get(msg.id);
    if (!f) return;
    byLeader.delete(msg.id);
    if (msg.error === undefined) {
      if (f.session === currentSession()) sessionCache().set(f.hash, msg.result);
      land(f);
      for (const w of f.waiters) reply(w.id!, { result: msg.result });
      return;
    }
    const code = (msg.error as { code?: number } | null)?.code;
    const next = f.waiters.shift();
    if (code === REQUEST_CANCELLED && next && f.session === currentSession()) {
      // Only the leader was cancelled: the next waiter becomes the leader.
      f.leader = next.id!;
      byLeader.set(next.id!, f);
      stats.forwarded += 1;
      taps.toRelay(next);
      return;
    }
    land(f);
    for (const w of next ? [next, ...f.waiters] : f.waiters) reply(w.id!, { error: msg.error });
  });

  return { stats: () => ({ ...stats, cached: sessionCache().size }) };
}
