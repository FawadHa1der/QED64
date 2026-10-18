// HARDENING #78: LeanSession's heartbeat-loss watchdog (6 s without a beat, then a telemetry probe unanswered for
// 2 s) used to be armed only by a received heartbeat. The worker beats every 2 s once its loop opens (at the arm when
// a didOpen is already queued, as with the relay's replay; otherwise on the first didOpen after it), so a Worker that
// died between the arm and its first beat was never declared dead: the page kept showing "ready" with nothing checking
// (measured on the live site, 2026-10-18). The watchdog now runs from the arm. Not earlier: a booting worker does not
// beat and can be busy for minutes. The real LeanSession over a scripted fake Worker, with fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeanSession, PROTOCOL } from "../../lib/client";

interface Posted { protocol: number; requestId: string; type: string; [key: string]: unknown }

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: Posted[] = [];
  /** Answer telemetry probes (a live worker's JS thread does; a dead or wedged one does not). */
  answersTelemetry = false;
  private listeners = new Map<string, ((e: { data?: unknown }) => void)[]>();
  constructor(_url: string) { FakeWorker.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: unknown }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  postMessage(msg: Posted) {
    this.posted.push(msg);
    if (msg.type === "telemetry" && this.answersTelemetry) queueMicrotask(() => this.reply(msg.requestId, { type: "ready", ready: { operation: "telemetry", state: "ready" } }));
  }
  terminate() {}
  reply(requestId: string, payload: Record<string, unknown>) {
    for (const fn of this.listeners.get("message") ?? []) fn({ data: { protocol: PROTOCOL, requestId, ...payload } });
  }
  beat() { this.reply("", { type: "event", kind: "heartbeat", t: 0 }); }
  ofType(type: string) { return this.posted.filter((m) => m.type === type); }
}

let worker: FakeWorker;
let session: LeanSession;
let deaths: Array<{ reason: string; message: string }>;

/** The page's arm, answered by the worker (the front door's Booting → Ready). */
async function armSession() {
  const armed = session.arm();
  await vi.advanceTimersByTimeAsync(0);
  const req = worker.ofType("lsp-arm")[0];
  expect(req).toBeDefined();
  worker.reply(req!.requestId, { type: "ready", ready: { operation: "lsp-arm" } });
  await armed;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.instances.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
  session = new LeanSession("/fake.worker.js");
  worker = FakeWorker.instances[0]!;
  deaths = [];
  session.onDied = (_code, reason, message) => { deaths.push({ reason, message }); };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LeanSession heartbeat watchdog (HARDENING #78)", () => {
  it("an armed session that never beats and does not answer the probe dies by heartbeat after 6 s + 2 s", async () => {
    await armSession();
    await vi.advanceTimersByTimeAsync(6000);
    expect(worker.ofType("telemetry")).toHaveLength(1); // the probe after the loss window
    expect(deaths).toEqual([]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(deaths).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(deaths).toEqual([{ reason: "heartbeat", message: "no heartbeat for 6000 ms and the telemetry probe went unanswered" }]);
  });

  it("an armed session that beats every 2 s is never probed or killed", async () => {
    await armSession();
    for (let i = 0; i < 15; i += 1) { await vi.advanceTimersByTimeAsync(2000); worker.beat(); }
    expect(worker.ofType("telemetry")).toHaveLength(0);
    expect(deaths).toEqual([]);
  });

  it("an armed session whose loop has not opened yet stays alive while its JS thread answers the probe", async () => {
    worker.answersTelemetry = true;
    await armSession();
    await vi.advanceTimersByTimeAsync(30000); // no beat at all, every probe answered
    expect(worker.ofType("telemetry").length).toBeGreaterThanOrEqual(3);
    expect(deaths).toEqual([]);
    worker.answersTelemetry = false; // then the worker goes silent: at most the current 8 s cycle, then one more
    await vi.advanceTimersByTimeAsync(16000);
    expect(deaths.map((d) => d.reason)).toEqual(["heartbeat"]);
  });

  it("a booting session (never armed) is never probed or killed, however long it is silent", async () => {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(worker.ofType("telemetry")).toHaveLength(0);
    expect(deaths).toEqual([]);
  });

  it("a session disposed after the arm is never reported dead", async () => {
    await armSession();
    session.dispose();
    await vi.advanceTimersByTimeAsync(20000);
    expect(worker.ofType("telemetry")).toHaveLength(0); // the watchdog stopped: no probe from a disposed session
    expect(deaths).toEqual([]);
  });

  it("a refused arm starts no watchdog (the boot failure is its own report)", async () => {
    const armed = session.arm();
    await vi.advanceTimersByTimeAsync(0);
    const req = worker.ofType("lsp-arm")[0]!;
    worker.reply(req.requestId, { type: "error", error: { code: "BAD_STATE", message: "refused", recoverable: true } });
    await expect(armed).rejects.toThrow(/refused/);
    await vi.advanceTimersByTimeAsync(20000);
    expect(worker.ofType("telemetry")).toHaveLength(0);
    expect(deaths).toEqual([]);
  });
});
