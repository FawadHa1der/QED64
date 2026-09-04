// Runtime-RPC serialization in LeanSession, pinning a live-observed race
// (2026-08-25): the worker rejects any compile that arrives while it still
// owns the runtime ("Worker is 'compiling', not ready", BAD_STATE), and
// snapshot loads are async on the worker — so a check racing the boot
// snapshot load right after boot surfaced that rejection as a user-visible
// "Compile failed". The client therefore runs compile/loadSnapshot strictly
// one at a time; these tests exercise the real LeanSession over a scripted
// fake Worker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeanSession, PROTOCOL, type CompileResult } from "../../src/runtime/client";

interface Posted {
  protocol: number;
  requestId: string;
  type: string;
  [key: string]: unknown;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: Posted[] = [];
  terminated = false;
  private listeners = new Map<string, ((e: { data?: unknown; message?: string }) => void)[]>();

  constructor(_url: string) {
    FakeWorker.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data?: unknown; message?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  postMessage(msg: Posted) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  /** Deliver a worker→page message. */
  reply(requestId: string, payload: Record<string, unknown>) {
    for (const fn of this.listeners.get("message") ?? []) {
      fn({ data: { protocol: PROTOCOL, requestId, ...payload } });
    }
  }
  ofType(type: string): Posted[] {
    return this.posted.filter((m) => m.type === type);
  }
}

const COMPILE_RESULT: CompileResult = {
  operation: "compile",
  success: true,
  exitCode: 0,
  elapsedMs: 5,
  diagnostics: [],
  raw: [],
};

/** Drain microtasks AND the macrotask queue (the turn chain hops through
 * `.then`, so a plain `await Promise.resolve()` is not always enough). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let worker: FakeWorker;
let session: LeanSession;

beforeEach(() => {
  FakeWorker.instances.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
  session = new LeanSession("/fake.worker.js");
  worker = FakeWorker.instances[0]!;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LeanSession runtime-RPC serialization", () => {
  it("holds a compile until an in-flight snapshot load settles (the boot race)", async () => {
    const snapPromise = session.loadSnapshot("https://cdn/x.snapz", "x.snap", 10, "k1");
    await settle();
    expect(worker.ofType("loadSnapshot")).toHaveLength(1);

    // The racing check's compile must NOT reach the busy worker…
    const compilePromise = session.compile("example : True := trivial\n", "/workspace/input.lean");
    await settle();
    expect(worker.ofType("compile")).toHaveLength(0);

    // …but must run (and succeed) as soon as the snapshot load settles.
    worker.reply(worker.ofType("loadSnapshot")[0]!.requestId, {
      type: "result",
      result: { success: true, elapsedMs: 3 },
    });
    await expect(snapPromise).resolves.toEqual({ success: true, elapsedMs: 3 });
    await settle();
    const compileMsg = worker.ofType("compile");
    expect(compileMsg).toHaveLength(1);
    worker.reply(compileMsg[0]!.requestId, { type: "result", result: COMPILE_RESULT });
    await expect(compilePromise).resolves.toEqual(COMPILE_RESULT);
    expect(session.state).toBe("ready");
  });

  it("runs concurrent compiles one at a time, in order", async () => {
    const first = session.compile("A");
    const second = session.compile("B");
    await settle();
    expect(worker.ofType("compile")).toHaveLength(1);
    expect((worker.ofType("compile")[0]!.input as { source: string }).source).toBe("A");

    worker.reply(worker.ofType("compile")[0]!.requestId, { type: "result", result: COMPILE_RESULT });
    await expect(first).resolves.toEqual(COMPILE_RESULT);
    await settle();
    expect(worker.ofType("compile")).toHaveLength(2);
    expect((worker.ofType("compile")[1]!.input as { source: string }).source).toBe("B");
    worker.reply(worker.ofType("compile")[1]!.requestId, { type: "result", result: COMPILE_RESULT });
    await expect(second).resolves.toEqual(COMPILE_RESULT);
  });

  it("a rejected turn frees the chain for the next one", async () => {
    const first = session.compile("A");
    const second = session.compile("B");
    await settle();
    worker.reply(worker.ofType("compile")[0]!.requestId, {
      type: "error",
      error: { code: "BAD_STATE", message: "Worker is 'compiling', not ready.", recoverable: true },
    });
    await expect(first).rejects.toMatchObject({ code: "BAD_STATE" });
    await settle();
    expect(worker.ofType("compile")).toHaveLength(2);
    worker.reply(worker.ofType("compile")[1]!.requestId, { type: "result", result: COMPILE_RESULT });
    await expect(second).resolves.toEqual(COMPILE_RESULT);
  });

  it("rejects queued turns once the session is dead instead of hanging", async () => {
    const first = session.compile("A");
    const second = session.compile("B");
    await settle();
    expect(worker.ofType("compile")).toHaveLength(1);

    session.dispose(); // rejects the in-flight compile; B is still queued
    await expect(first).rejects.toMatchObject({ code: "DISPOSED" });
    await expect(second).rejects.toMatchObject({ code: "DEAD" });
    // The queued compile must never have been posted to the (dead) worker.
    expect(worker.ofType("compile")).toHaveLength(1);
  });
});

// The `status` event is rebuilt from declared fields on purpose (the event
// envelope must not leak into a datum the harness JSON-diffs, §2.2(e)) —
// which is exactly how the front door's `collision` fact was dropped once
// and the resident "Load exact imports" offer became dead code (§3 row 8).
// Pin the whole shape so a new WorkerStatus field cannot be forgotten again.
describe("LeanSession status events", () => {
  const RING = { bytesQueued: 0, refused: 0 };
  const POOL = { unused: 3, running: 2 };
  it("carries the front door's collision fact through, and null when the worker reports none", () => {
    const seen: unknown[] = [];
    session.onStatus = (s) => seen.push(s);
    const collision = { names: ["Nat.add_comm"], version: 4 };
    worker.reply("", { type: "event", kind: "status", phase: "ready", version: 4, header: null, ring: RING, pool: POOL, dropped: 0, collision });
    worker.reply("", { type: "event", kind: "status", phase: "ready", version: 5, header: null, ring: RING, pool: POOL, dropped: 0, collision: null });
    worker.reply("", { type: "event", kind: "status", phase: "ready", version: 6, header: null, ring: RING, pool: POOL, dropped: 0 });
    expect(seen).toEqual([
      { phase: "ready", version: 4, header: null, ring: RING, pool: POOL, dropped: 0, collision },
      { phase: "ready", version: 5, header: null, ring: RING, pool: POOL, dropped: 0, collision: null },
      { phase: "ready", version: 6, header: null, ring: RING, pool: POOL, dropped: 0, collision: null },
    ]);
  });
});
