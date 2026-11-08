// The stock page's stack-limit note (frontend/src/stack-limit-notes.ts, HARDENING #92) on the REAL LspRelay and
// tapRelay: the note is on Lean's guard error in the publish (the editor) and in an array reply (the InfoView's
// getInteractiveDiagnostics) before any observer sees the frame and before the client receives it; the frame stays
// Lean's (not page-made); goals replies and the relay's own halted note pass as they are.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LspRelay, type RelaySession, type RestartOptions } from "../../lib/lsp-relay";
import { GUARD_CODE, STACK_LIMIT_NOTE, isStackLimitDiagnostic } from "../../lib/stack-limit";
import { tapRelay, type LspMessage, type RelayTaps } from "../../frontend/src/relay-taps";
import { installStackLimitNotes, stackLimitLabel } from "../../frontend/src/stack-limit-notes";
import type { JsonRpcMessage, WorkerStatus } from "../../lib/client";

const root = path.resolve(__dirname, "../..");
const fx = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/stack-limit-messages.json"), "utf8")) as {
  published: { id: string; text: string }[]; wire: { name: string; rpc: unknown }[];
};
const P1 = fx.published.find((p) => p.id === "P1")!.text;
const N1 = fx.published.find((p) => p.id === "N1")!.text;
const E_RPC = fx.wire.find((w) => w.name === "E")!.rpc;
const SUFFIX = `\n\n${STACK_LIMIT_NOTE}`;
const URI = "file:///p.lean";

let seq = 0;
class Session implements RelaySession {
  readonly id = `s${(seq += 1)}`;
  readonly sent: JsonRpcMessage[] = [];
  onLsp: (m: JsonRpcMessage) => void = () => {};
  onStatus: (s: WorkerStatus) => void = () => {};
  onDied: (code: number | null, reason: string, message: string, cause?: unknown) => void = () => {};
  constructor(readonly opts?: RestartOptions) {}
  start() { return Promise.resolve(); }
  arm() { return Promise.resolve(); }
  lsp(m: JsonRpcMessage) { this.sent.push(m); }
  dispose() {}
  terminate() {}
  answer(m: JsonRpcMessage) { this.onLsp(m); }
}

let relay: LspRelay;
let sessions: Session[];
let toClient: LspMessage[];
let taps: RelayTaps;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const current = () => sessions.at(-1)!;
const diag = (line: number, message: unknown, severity = 1) => ({ range: { start: { line, character: 0 }, end: { line, character: 6 } }, severity, message });
const publish = (diagnostics: unknown[]): JsonRpcMessage => ({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics } });

beforeEach(async () => {
  sessions = [];
  toClient = [];
  relay = new LspRelay((opts) => { const s = new Session(opts); sessions.push(s); return s; }, { status() {} }, () => Promise.resolve());
  relay.clientPort.onmessage = (e) => toClient.push(e.data as LspMessage);
  taps = tapRelay(relay);
  await flush(); // booted and armed: serving
  relay.clientPort.postMessage({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: URI, languageId: "lean4", version: 1, text: "a\nb\nc\nd\n" } } });
  await flush();
});
afterEach(() => { relay.clientPort.close(); relay.unload(); });

describe("installStackLimitNotes", () => {
  it("annotates Lean's guard error in a publish, before every observer and the client, and leaves the frame Lean's", async () => {
    const seen: { text: string; page: boolean; count: number }[] = [];
    // Registered BEFORE the install, as the page API's observer is not (it binds after): interceptors run first anyway.
    taps.onOut((m) => {
      const ds = (m.params as { diagnostics?: { message: string }[] } | undefined)?.diagnostics;
      if (ds) seen.push({ text: ds.map((d) => d.message).join(" | "), page: taps.fromPage(m), count: ds.filter(isStackLimitDiagnostic).length });
    });
    installStackLimitNotes(taps);
    const lean = publish([diag(0, N1), diag(2, P1), diag(3, P1, 3)]);
    current().answer(lean);
    await flush();
    expect(seen).toEqual([{ text: `${N1} | ${P1}${SUFFIX} | ${P1}`, page: false, count: 1 }]);
    const got = toClient.find((m) => m.method === "textDocument/publishDiagnostics")!.params as { diagnostics: { message: string; severity: number }[] };
    expect(got.diagnostics.map((d) => [d.severity, d.message])).toEqual([[1, N1], [1, P1 + SUFFIX], [3, P1]]);
  });

  it("annotates an array reply (the InfoView's getInteractiveDiagnostics) and leaves an object reply (goals) alone", async () => {
    installStackLimitNotes(taps);
    const goals = { goals: [{ hyps: [{ names: ["h"], type: { text: P1 } }], type: { text: "True" } }] };
    current().answer({ jsonrpc: "2.0", id: 11, result: [diag(2, E_RPC), diag(0, { text: N1 })] });
    current().answer({ jsonrpc: "2.0", id: 12, result: goals });
    current().answer({ jsonrpc: "2.0", id: 13, result: [{ title: "Try this", kind: "quickfix" }] }); // a code action list
    await flush();
    const reply = (id: number) => toClient.find((m) => m.id === id)!.result;
    expect(reply(11)).toEqual([diag(2, { append: [E_RPC, { text: SUFFIX }] }), diag(0, { text: N1 })]);
    expect(reply(12)).toEqual(goals);
    expect(reply(13)).toEqual([{ title: "Try this", kind: "quickfix" }]);
  });

  it("annotates by the guard's LSP code alone, in a publish and in an array reply, and the relay keeps the code", async () => {
    installStackLimitNotes(taps);
    const coded = (message: unknown) => ({ ...diag(2, message), code: GUARD_CODE });
    const tag = { tag: [{ expr: { text: "reworded" } }, { text: "" }] };
    current().answer(publish([coded("reworded")]));
    current().answer({ jsonrpc: "2.0", id: 14, result: [coded(tag)] });
    await flush();
    const got = toClient.find((m) => m.method === "textDocument/publishDiagnostics")!.params as { diagnostics: unknown[] };
    expect(got.diagnostics).toEqual([coded(`reworded${SUFFIX}`)]);
    expect(toClient.find((m) => m.id === 14)!.result).toEqual([coded({ append: [tag, { text: SUFFIX }] })]);
  });

  it("replaces the message's params by a copy: a caller of taps.toClient keeps its own params and array unchanged", async () => {
    installStackLimitNotes(taps);
    const diagnostics = [diag(2, P1)];
    const params = { uri: URI, version: 1, diagnostics };
    const frame: LspMessage = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params };
    const frozen = structuredClone(params);
    taps.toClient(frame);
    await flush();
    expect(frame.params).not.toBe(params);
    expect(params).toEqual(frozen);
    expect(params.diagnostics).toBe(diagnostics);
    expect(taps.fromPage(frame)).toBe(true); // still the page's own frame
    const got = toClient.find((m) => m.method === "textDocument/publishDiagnostics")!.params as { uri: string; diagnostics: { message: string }[] };
    expect(got.uri).toBe(URI);
    expect(got.diagnostics.map((d) => d.message)).toEqual([P1 + SUFFIX]);
    // Nothing to add: the frame's params stay the caller's own object.
    const plain = { uri: URI, version: 2, diagnostics: [diag(0, N1)] };
    const frame2: LspMessage = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: plain };
    taps.toClient(frame2);
    expect(frame2.params).toBe(plain);
  });

  it("passes the relay's stack-pause note unchanged: it is QED64's own, and counts 0", async () => {
    installStackLimitNotes(taps);
    current().answer(publish([diag(2, P1)]));
    current().onDied(null, "crash", "a Lean thread ran out of the browser's stack", { kind: "other", code: "ENGINE_STACK_OVERFLOW", message: "x", line: 2 });
    await flush();
    const publishes = toClient.filter((m) => m.method === "textDocument/publishDiagnostics").map((m) => (m.params as { diagnostics: { message: string; source?: string; severity: number }[] }).diagnostics);
    expect(publishes).toHaveLength(2);
    expect(publishes[0]!.map((d) => d.message)).toEqual([P1 + SUFFIX]);
    expect(publishes[1]).toHaveLength(1);
    expect(publishes[1]![0]).toMatchObject({ source: "QED64", severity: 1, code: "ENGINE_STACK_OVERFLOW" });
    expect(publishes[1]![0]!.message).not.toContain(STACK_LIMIT_NOTE);
    expect(publishes[1]!.filter(isStackLimitDiagnostic)).toHaveLength(0);
  });
});

describe("stackLimitLabel", () => {
  it("says how many places were not checked, and why, after ready", () => {
    expect(stackLimitLabel(1)).toBe("ready — 1 place not checked (browser stack limit)");
    expect(stackLimitLabel(3)).toBe("ready — 3 places not checked (browser stack limit)");
  });
});
