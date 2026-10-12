// HARDENING #72: a pthread that overflows the browser's engine stack throws "RangeError: Maximum call stack size
// exceeded"; Emscripten's per-pthread worker.onerror rethrows that ErrorEvent into lean.worker.js's global scope,
// where it reached the page as "Uncaught [object ErrorEvent]", an ordinary crash (reboot, re-crash, breaker).
// The worker's global "error" listener keeps it from the page and dies once, in words lib/failure.ts classifies as
// ENGINE_STACK_OVERFLOW; the relay then pauses (tests/unit/relay.test.ts). The real listener, the worker in a vm.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { deathCause, ENGINE_STACK_OVERFLOW } from "../../lib/failure";

const file = path.resolve(__dirname, "../../public/workers/lean.worker.js");
const src = readFileSync(file, "utf8");

type Listener = (e: unknown) => void;
function worker() {
  const workers = path.dirname(file);
  const listeners: Array<[string, Listener]> = [];
  const posted: Array<Record<string, unknown>> = [];
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console,
    setTimeout, clearTimeout, setInterval, clearInterval, navigator: {},
    fetch: () => Promise.reject(new Error("no network in unit tests")),
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: Record<string, unknown>) => posted.push(m);
  sandbox.addEventListener = (type: string, fn: Listener) => listeners.push([type, fn]);
  sandbox.crossOriginIsolated = true;
  sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "lean.worker.js" });
  const errors = listeners.filter(([t]) => t === "error").map(([, fn]) => fn);
  expect(errors).toHaveLength(1);
  const fire = (e: { message?: string; error?: unknown }) => { const ev = { ...e, preventDefault: vi.fn() }; errors[0]!(ev); return ev.preventDefault; };
  return { fire, died: () => posted.filter((m) => m.type === "event" && m.kind === "died") };
}

describe("lean.worker.js: an engine-stack overflow is one classified death (HARDENING #72)", () => {
  it("Chrome: the rethrown pthread ErrorEvent is kept from the page and dies once, in words the page classifies", () => {
    const w = worker();
    // What reaches the global scope: the outer event's message is the inner ErrorEvent stringified; its `error` is that ErrorEvent.
    const prevent = w.fire({ message: "Uncaught [object ErrorEvent]", error: { message: "Uncaught RangeError: Maximum call stack size exceeded" } });
    expect(prevent).toHaveBeenCalledTimes(1);
    const message = "a Lean thread ran out of the browser's stack (RangeError: Maximum call stack size exceeded)";
    expect(w.died()).toEqual([expect.objectContaining({ kind: "died", code: null, reason: "crash", message })]);
    expect(deathCause("crash", message)).toMatchObject({ kind: "other", code: ENGINE_STACK_OVERFLOW });
    // A second overflow (another pthread) is kept from the page too, and is not a second death.
    expect(w.fire({ message: "Uncaught [object ErrorEvent]", error: { message: "Uncaught RangeError: Maximum call stack size exceeded" } })).toHaveBeenCalledTimes(1);
    expect(w.died()).toHaveLength(1);
  });

  it("Firefox's words, on the event's own message, count too", () => {
    const w = worker();
    expect(w.fire({ message: "InternalError: too much recursion" })).toHaveBeenCalledTimes(1);
    expect(w.died()).toEqual([expect.objectContaining({ reason: "crash", message: "a Lean thread ran out of the browser's stack (InternalError: too much recursion)" })]);
  });

  it("any other error event is left alone: not prevented, no death posted (it reaches the page as before)", () => {
    const w = worker();
    expect(w.fire({ message: "Uncaught [object ErrorEvent]", error: { message: "Uncaught RuntimeError: unreachable" } })).not.toHaveBeenCalled();
    expect(w.fire({ message: "Uncaught Error: boom", error: new Error("boom") })).not.toHaveBeenCalled();
    expect(w.fire({})).not.toHaveBeenCalled();
    expect(w.died()).toEqual([]);
  });
});
