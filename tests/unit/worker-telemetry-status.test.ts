// A `telemetry` request makes the worker re-sample its status first and emit
// it when it changed (docs/EMBEDDING.md §7.7, §7.8; HARDENING #59 addendum):
// the pool sample rides only on status events, which the worker emits per
// server frame, and an idle worker emits none, so the session polls
// telemetry while it holds an edit for the pool. `emitStatus` dedupes on the
// status JSON, so an unchanged pool emits nothing and the reply is the only
// message. The REAL worker source runs in a Node vm sandbox, driven by its
// message listener, with a fake Emscripten module standing in for the pool.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const workers = path.resolve(__dirname, "../../public/workers");
type Posted = { type: string; kind?: string; requestId?: string; pool?: { unused: number; running: number; parked: number }; result?: { operation: string } };

function leanWorker() {
  const posted: Posted[] = [];
  const listeners: Record<string, (e: { data: unknown }) => void> = {};
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console, setTimeout, clearTimeout,
    fetch: () => Promise.reject(new Error("no network in unit tests")),
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: Posted) => posted.push(m);
  sandbox.addEventListener = (type: string, fn: (e: { data: unknown }) => void) => { listeners[type] = fn; };
  sandbox.crossOriginIsolated = true;
  sandbox.importScripts = (url: string) => vm.runInContext(readFileSync(path.join(workers, url), "utf8"), sandbox, { filename: url });
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  const hooks = (sandbox as { __qed64TestExports?: { frontDoor: { host(h: { M?: unknown }): void } } }).__qed64TestExports!;
  return { posted, hooks, deliver: (data: unknown) => listeners.message!({ data }) };
}

describe("lean.worker.js: a telemetry request is preceded by a status event when the status changed", () => {
  it("the first telemetry after a pool change carries a status event with the new pool before its reply; an unchanged pool emits nothing", () => {
    const { posted, hooks, deliver } = leanWorker();
    const PThread = { unusedWorkers: [1, 2, 3], pthreads: { a: 1, b: 2 } as Record<string, number> };
    hooks.frontDoor.host({ M: { PThread } });
    const statuses = () => posted.filter((m) => m.type === "event" && m.kind === "status");
    const replyIndex = (id: string) => posted.findIndex((m) => m.type === "result" && m.requestId === id);

    deliver({ protocol: 1, requestId: "t1", type: "telemetry" });
    expect(replyIndex("t1")).toBeGreaterThan(-1);
    expect(statuses()).toHaveLength(1);
    expect(posted.indexOf(statuses()[0]!)).toBeLessThan(replyIndex("t1")); // the event first, then the reply
    expect(statuses()[0]!.pool).toEqual({ unused: 3, running: 2, parked: -1 });

    deliver({ protocol: 1, requestId: "t2", type: "telemetry" }); // nothing changed: the reply alone
    expect(replyIndex("t2")).toBeGreaterThan(-1);
    expect(statuses()).toHaveLength(1);

    PThread.unusedWorkers.push(4); // a thread finished: its Worker went back to the pool
    delete PThread.pthreads.b;
    deliver({ protocol: 1, requestId: "t3", type: "telemetry" });
    expect(statuses()).toHaveLength(2);
    expect(statuses()[1]!.pool).toEqual({ unused: 4, running: 1, parked: -1 });
    expect(posted.indexOf(statuses()[1]!)).toBeLessThan(replyIndex("t3"));
    expect(posted.filter((m) => m.type === "result" && m.result?.operation === "telemetry")).toHaveLength(3);
  });
});
