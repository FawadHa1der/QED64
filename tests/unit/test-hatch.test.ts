// The test hatch's lsp.request (frontend/src/test-hatch.ts, docs/EMBEDDING.md
// §9) on a real LspRelay + tapRelay over a fake Lean session. Its reply is
// swallowed (the editor never sees it) and returned, and that holds for a reply
// that arrives AFTER the request timed out: the editor's LSP client must never
// receive an id it did not issue (lean4monaco's messageStrategy shows an error
// reply to the user as a notification). A timeout also sends `$/cancelRequest`,
// as the editor's own client does, so Lean frees the task.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LspRelay, type RelaySession } from "../../frontend/src/lsp-relay";
import { tapRelay, type LspMessage } from "../../frontend/src/relay-taps";
import { createTestHatch, type TestHatch } from "../../frontend/src/test-hatch";
import type { JsonRpcMessage as Msg, WorkerStatus } from "../../src/runtime/client";

type Id = number | string;

/** A RelaySession over a fake Lean that answers as 4.34's FileWorker does (Lean/Server/FileWorker.lean,
 * handleCancelRequest and the request task's emitResponse): every request is answered exactly once, when the test
 * says; a `$/cancelRequest` for one still open cancels its task, which answers RequestCancelled (-32800) when it
 * ends (endCancelled) — unless its result was already on the way. Like LeanSession, a disposed session drops what
 * it is sent and reports nothing more. */
class FakeLean implements RelaySession {
  static all: FakeLean[] = [];
  readonly id = `lean${FakeLean.all.length + 1}`;
  readonly sent: Msg[] = [];
  /** Requests Lean has not answered yet, and those of them a `$/cancelRequest` reached. */
  readonly open = new Set<Id>();
  readonly cancelled = new Set<Id>();
  disposed = false;
  bootOk!: () => void;
  private readonly booted = new Promise<void>((resolve) => { this.bootOk = resolve; });
  onLsp: (msg: Msg) => void = () => {};
  onStatus: (s: WorkerStatus) => void = () => {};
  onDied: (code: number | null, reason: string, message: string, cause?: unknown) => void = () => {};
  constructor() { FakeLean.all.push(this); }
  start() { return this.booted; }
  arm() { return Promise.resolve(); }
  lsp(msg: Msg) {
    if (this.disposed) return;
    this.sent.push(msg);
    if (msg.id !== undefined && msg.method !== undefined) this.open.add(msg.id);
    const target = msg.method === "$/cancelRequest" ? (msg.params as { id: Id }).id : undefined;
    if (target !== undefined && this.open.has(target)) this.cancelled.add(target);
  }
  /** The cancelled tasks end: each answers RequestCancelled. */
  endCancelled() {
    for (const id of this.cancelled) this.answer(id, { error: { code: -32800, message: "" } });
    this.cancelled.clear();
  }
  /** Lean answers request `id` (once: a second answer for it is never sent). */
  answer(id: Id, body: { result: unknown } | { error: unknown }) {
    if (this.disposed || !this.open.delete(id)) return;
    this.onLsp({ jsonrpc: "2.0", id, ...body } as Msg);
  }
  dispose() {
    this.disposed = true;
    this.onLsp = () => {};
    this.onStatus = () => {};
    this.onDied = () => {};
  }
  terminate() {}
}

const URI = "file:///project/Probe.lean";
const ID = "qed64-test:1";
const hover = { textDocument: { uri: URI }, position: { line: 0, character: 0 } };
/** Let MessagePort deliveries land (a macrotask hop; setImmediate is never faked here). */
const turn = () => new Promise<void>((r) => setImmediate(r));
const lean = () => FakeLean.all[FakeLean.all.length - 1]!;

let relay: LspRelay;
let hatch: TestHatch;
/** What the editor's LSP client receives: the relay's client port. */
let editorSaw: LspMessage[];
/** The hatch's interceptOut hooks currently installed (one per unanswered request). */
let swallows: number;
const editorSawId = (id: Id) => editorSaw.filter((m) => m.id === id);

beforeEach(async () => {
  FakeLean.all.length = 0;
  editorSaw = [];
  swallows = 0;
  relay = new LspRelay(() => new FakeLean(), { status: () => {} }, () => Promise.resolve());
  relay.clientPort.onmessage = (e) => editorSaw.push(e.data as LspMessage);
  const taps = tapRelay(relay);
  hatch = createTestHatch(relay, {
    ...taps,
    interceptOut: (fn) => {
      const off = taps.interceptOut(fn);
      let on = true;
      swallows += 1;
      return () => { if (on) { on = false; swallows -= 1; } off(); };
    },
  });
  relay.fromClient({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: URI, languageId: "lean4", version: 1, text: "example : True := trivial" } } });
  await turn();
  lean().bootOk();
  await turn();
  expect(relay.state.kind).toBe("serving");
});
afterEach(() => {
  vi.useRealTimers();
  relay.clientPort.close();
  relay.unload();
});

describe("test hatch: lsp.request", () => {
  it("resolves with the reply, which never reaches the editor, and leaves nothing installed", async () => {
    const p = hatch.lsp.request("textDocument/hover", hover);
    expect(lean().sent.at(-1)).toEqual({ jsonrpc: "2.0", id: ID, method: "textDocument/hover", params: hover });
    lean().answer(ID, { result: { contents: "ok" } });
    await expect(p).resolves.toEqual({ jsonrpc: "2.0", id: ID, result: { contents: "ok" } });
    await turn();
    expect(editorSawId(ID)).toEqual([]);
    expect(swallows).toBe(0);
    expect(relay.pending.size).toBe(0);
  });

  describe("after a timeout", () => {
    /** Time the request out (Lean has not answered): the promise rejects. */
    async function timedOut(): Promise<void> {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const p = hatch.lsp.request("textDocument/hover", hover, 5000);
      const rejected = expect(p).rejects.toThrow("lsp.request: no reply to textDocument/hover within 5000 ms");
      vi.advanceTimersByTime(5000);
      await rejected;
    }

    it("cancels the request as the editor's client would — at the timeout, not before — and keeps waiting for its reply", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const p = hatch.lsp.request("textDocument/hover", hover, 5000);
      const rejected = expect(p).rejects.toThrow("within 5000 ms");
      vi.advanceTimersByTime(4999);
      expect(lean().sent.filter((m) => m.method === "$/cancelRequest")).toEqual([]);
      vi.advanceTimersByTime(1);
      await rejected;
      expect(lean().sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: ID } });
      expect(lean().cancelled).toEqual(new Set([ID]));
      expect(swallows).toBe(1); // the one reply the relay still owes this id
      expect(relay.pending.get(ID)).toBe("textDocument/hover");
    });

    it("Lean's RequestCancelled for the cancelled request is swallowed, not shown to the editor", async () => {
      await timedOut();
      lean().endCancelled();
      await turn();
      expect(lean().open.size).toBe(0);
      expect(editorSawId(ID)).toEqual([]);
      expect(swallows).toBe(0);
      expect(relay.pending.size).toBe(0);
    });

    it("a late result (the task ended before the cancel landed) is swallowed too", async () => {
      await timedOut();
      lean().answer(ID, { result: { contents: "late" } }); // the 55 s hover of a saturated pool
      lean().endCancelled(); // its cancel found the result already sent: no second answer
      await turn();
      expect(editorSawId(ID)).toEqual([]);
      expect(swallows).toBe(0);
      expect(relay.pending.size).toBe(0);
    });

    it("the relay's own error reply, when the session dies before Lean answers, is swallowed", async () => {
      await timedOut();
      lean().onDied(null, "abort", "Lean runtime aborted"); // failInFlight answers the orphaned id within the turn
      await turn();
      expect(relay.stats.failedInFlight).toBe(1);
      expect(editorSawId(ID)).toEqual([]);
      expect(editorSaw.filter((m) => m.error !== undefined)).toEqual([]);
      expect(swallows).toBe(0);
      expect(relay.pending.size).toBe(0);
    });
  });
});
