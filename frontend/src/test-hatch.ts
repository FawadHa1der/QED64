// `globalThis.qed64.test` — the test harnesses' escape hatch (docs/EMBEDDING.md
// §9). EXPLICITLY UNSTABLE: it may change in any commit, versioned only by its
// own `revision`; an embedder's product code must not use it. It exists so the
// harnesses (QED64's own and the widgets showcase's) stop wrapping relay
// methods and reading private fields: what they read is named here once.
import type { LspRelay } from "../../lib/lsp-relay";
import type { LspMessage, RelayTaps } from "./relay-taps";
import type { ResidentSession } from "../../lib/resident-session";

export const TEST_HATCH_REVISION = "0.1.1"; // 0.1.1: a timed-out lsp.request sends $/cancelRequest and keeps swallowing its reply

export interface TestHatch {
  readonly revision: string;
  /** A copy of the relay's counters (reboots, deaths, breaker trips, …). */
  stats(): Record<string, number>;
  /** The relay's full status, including the worker's ring/pool/dropped/liveness counters. */
  rawStatus(): ReturnType<LspRelay["status"]>;
  /** The worker's telemetry (memory). */
  telemetry(): Promise<unknown>;
  session(): { id: string; snapshots: string[]; initialBytes: number; maximumBytes: number };
  readonly lsp: {
    /** Observe client → relay ("in") or relay → client ("out") frames; returns unsubscribe. */
    on(direction: "in" | "out", fn: (msg: LspMessage) => void): () => void;
    /** Send a request as the client would, under a private id; its reply is
     * swallowed (the editor never sees it) and returned. On timeout the
     * promise rejects and a `$/cancelRequest` frees Lean's task; the late
     * reply (Lean's RequestCancelled, or the relay's own when the session
     * dies or restarts first) is still swallowed. */
    request(method: string, params?: unknown, timeoutMs?: number): Promise<LspMessage>;
    /** Send a notification as the client would. */
    notify(method: string, params?: unknown): void;
  };
}

export function createTestHatch(relay: LspRelay, taps: RelayTaps): TestHatch {
  let seq = 0;
  const session = () => relay.session as ResidentSession;
  return Object.freeze({
    revision: TEST_HATCH_REVISION,
    stats: () => ({ ...relay.stats }),
    rawStatus: () => relay.status(),
    telemetry: () => session().lean.telemetry(),
    session: () => ({ id: session().id, snapshots: [...session().snapshots], initialBytes: session().initialBytes, maximumBytes: session().maximumBytes }),
    lsp: Object.freeze({
      on: (direction: "in" | "out", fn: (msg: LspMessage) => void) => (direction === "in" ? taps.onIn(fn) : taps.onOut(fn)),
      request(method: string, params?: unknown, timeoutMs = 30000): Promise<LspMessage> {
        const id = `qed64-test:${(seq += 1)}`;
        return new Promise((resolve, reject) => {
          // Removed by the reply alone, never by the timeout: the relay answers
          // every request it forwarded exactly once (Lean, or failInFlight on a
          // death/restart), and the editor's client must not see an id it never issued.
          const stop = taps.interceptOut((m) => {
            if (m.id !== id || m.method !== undefined) return false;
            stop(); clearTimeout(timer); resolve(m); // after a timeout resolve() is a no-op: the reply is only swallowed
            return true;
          });
          const timer = setTimeout(() => {
            taps.toRelay({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
            reject(new Error(`lsp.request: no reply to ${method} within ${timeoutMs} ms`));
          }, timeoutMs);
          taps.toRelay({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
        });
      },
      notify(method: string, params?: unknown): void {
        taps.toRelay({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
      },
    }),
  });
}
