// Relay taps (frontend/src/relay-taps.ts) and the getWidgetSource cache
// (frontend/src/widget-source-cache.ts) on the REAL LspRelay: the taps must see
// what the relay's own port handler and its own replies route through
// `this.fromClient` / `this.toClient`, and the cache must forward one request
// per hash per session, answer the rest itself, and release waiters on errors.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspRelay, type RelaySession, type RestartOptions } from "../../lib/lsp-relay";
import { tapRelay, type LspMessage } from "../../frontend/src/relay-taps";
import { installWidgetSourceCache } from "../../frontend/src/widget-source-cache";
import type { JsonRpcMessage, WorkerStatus } from "../../lib/client";

let seq = 0;
class Session implements RelaySession {
  readonly id = `s${(seq += 1)}`;
  readonly sent: JsonRpcMessage[] = [];
  onLsp: (m: JsonRpcMessage) => void = () => {};
  onStatus: (s: WorkerStatus) => void = () => {};
  onDied: (code: number | null, reason: string, message: string) => void = () => {};
  constructor(readonly opts?: RestartOptions) {}
  start() { return Promise.resolve(); }
  arm() { return Promise.resolve(); }
  lsp(m: JsonRpcMessage) { this.sent.push(m); }
  dispose() {}
  terminate() {}
  /** The worker answers. */
  answer(m: JsonRpcMessage) { this.onLsp(m); }
}

let relay: LspRelay;
let sessions: Session[];
let toClient: LspMessage[];
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const rpc = (id: number, hash: string, method = "Lean.Widget.getWidgetSource"): LspMessage =>
  ({ jsonrpc: "2.0", id, method: "$/lean/rpc/call", params: { textDocument: { uri: "file:///p.lean" }, position: { line: 0, character: 0 }, sessionId: "1", method, params: { hash } } });
const current = () => sessions.at(-1)!;
const forwarded = () => current().sent.filter((m) => m.method === "$/lean/rpc/call").map((m) => m.id);
const replies = (id: number | string) => toClient.filter((m) => m.id === id && m.method === undefined);

beforeEach(async () => {
  sessions = [];
  toClient = [];
  relay = new LspRelay((opts) => { const s = new Session(opts); sessions.push(s); return s; }, { status() {} }, () => Promise.resolve());
  relay.clientPort.onmessage = (e) => toClient.push(e.data as LspMessage);
  await flush(); // booted and armed: serving
});
afterEach(() => { relay.clientPort.close(); relay.unload(); });

describe("relay taps", () => {
  it("see what the relay's port handler forwards and what its own replies send, after the relay recorded it", async () => {
    const taps = tapRelay(relay);
    expect(tapRelay(relay)).toBe(taps); // one wrapper per relay
    const ins: Array<[string | undefined, number | null]> = [];
    const outs: string[] = [];
    taps.onIn((m) => ins.push([m.method, relay.doc?.version ?? null]));
    taps.onOut((m) => outs.push(m.method ?? `reply ${m.id}`));
    relay.clientPort.postMessage({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: "file:///p.lean", languageId: "lean4", version: 1, text: "A" } } });
    await flush();
    expect(ins).toEqual([["textDocument/didOpen", 1]]);
    current().answer({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///p.lean", diagnostics: [] } });
    await flush();
    expect(outs).toEqual(["textDocument/publishDiagnostics"]);
    expect(toClient.map((m) => m.method)).toEqual(["textDocument/publishDiagnostics"]);
  });
  it("interceptOut consumes; toRelay injects as the client would; a throwing hook is contained", async () => {
    const taps = tapRelay(relay);
    taps.onOut(() => { throw new Error("bug"); });
    const orig = console.error; console.error = () => {};
    taps.interceptOut((m) => m.id === "probe-1");
    taps.toRelay({ jsonrpc: "2.0", id: "probe-1", method: "textDocument/hover", params: {} });
    expect(current().sent.at(-1)).toMatchObject({ id: "probe-1" });
    current().answer({ jsonrpc: "2.0", id: "probe-1", result: null });
    current().answer({ jsonrpc: "2.0", id: 7, result: null });
    await flush();
    console.error = orig;
    expect(toClient.map((m) => m.id)).toEqual([7]);
  });
});

describe("getWidgetSource cache", () => {
  it("forwards one request per hash; waiters get the leader's result; later requests are answered from the cache", async () => {
    const taps = tapRelay(relay);
    const cache = installWidgetSourceCache(taps, () => relay.session.id);
    for (const [id, h] of [[1, "h1"], [2, "h1"], [3, "h2"], [4, "h1"]] as const) relay.clientPort.postMessage(rpc(id, h));
    relay.clientPort.postMessage(rpc(5, "h1", "Lean.Widget.getInteractiveGoals")); // another method passes through
    await flush();
    expect(forwarded()).toEqual([1, 3, 5]);
    current().answer({ jsonrpc: "2.0", id: 1, result: { sourcetext: "export default 1" } });
    await flush();
    for (const id of [1, 2, 4]) expect(replies(id), `id ${id}`).toEqual([{ jsonrpc: "2.0", id, result: { sourcetext: "export default 1" } }]);
    relay.clientPort.postMessage(rpc(6, "h1"));
    await flush();
    expect(replies(6)).toEqual([{ jsonrpc: "2.0", id: 6, result: { sourcetext: "export default 1" } }]);
    expect(forwarded()).toEqual([1, 3, 5]);
    expect(cache.stats()).toEqual({ hits: 1, coalesced: 2, forwarded: 2, cached: 1 });
  });

  it("a new session starts empty", async () => {
    const taps = tapRelay(relay);
    installWidgetSourceCache(taps, () => relay.session.id);
    relay.clientPort.postMessage(rpc(1, "h1"));
    await flush();
    current().answer({ jsonrpc: "2.0", id: 1, result: { sourcetext: "a" } });
    relay.restart({ snapshots: ["init"] });
    await flush();
    relay.clientPort.postMessage(rpc(2, "h1"));
    await flush();
    expect(forwarded()).toEqual([2]); // the new session's own request
  });

  it("an error releases every waiter with it; a death's RpcNeedsReconnect too", async () => {
    const taps = tapRelay(relay);
    installWidgetSourceCache(taps, () => relay.session.id);
    for (const id of [1, 2, 3]) relay.clientPort.postMessage(rpc(id, "h1"));
    await flush();
    current().answer({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } });
    await flush();
    for (const id of [1, 2, 3]) expect(replies(id)[0]?.error, `id ${id}`).toEqual({ code: -32603, message: "boom" });
    for (const id of [4, 5]) relay.clientPort.postMessage(rpc(id, "h9"));
    await flush();
    expect(forwarded().at(-1)).toBe(4);
    current().onDied(null, "crash", "worker crashed"); // failInFlight answers the leader -32900
    await flush();
    expect(replies(4)[0]?.error).toMatchObject({ code: -32900 });
    expect(replies(5)[0]?.error).toMatchObject({ code: -32900 });
  });

  it("a waiter's cancel never reaches the worker; a cancelled leader promotes the next waiter", async () => {
    const taps = tapRelay(relay);
    installWidgetSourceCache(taps, () => relay.session.id);
    for (const id of [1, 2, 3]) relay.clientPort.postMessage(rpc(id, "h1"));
    relay.clientPort.postMessage({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 2 } });
    await flush();
    expect(replies(2)[0]?.error).toMatchObject({ code: -32800 });
    expect(current().sent.some((m) => m.method === "$/cancelRequest")).toBe(false);
    relay.clientPort.postMessage({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } });
    await flush();
    expect(current().sent.at(-1)).toMatchObject({ method: "$/cancelRequest", params: { id: 1 } });
    current().answer({ jsonrpc: "2.0", id: 1, error: { code: -32800, message: "cancelled" } });
    await flush();
    expect(forwarded()).toEqual([1, 3]); // 3 promoted
    current().answer({ jsonrpc: "2.0", id: 3, result: { sourcetext: "x" } });
    await flush();
    expect(replies(3)).toEqual([{ jsonrpc: "2.0", id: 3, result: { sourcetext: "x" } }]);
    expect(replies(1)[0]?.error).toMatchObject({ code: -32800 });
  });
});
