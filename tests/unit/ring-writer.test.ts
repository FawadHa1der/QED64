// The resident stdin ring writer (public/workers/lean.worker.js) is on the
// resident FileWorker path. Two frames once interleaved because a full ring
// returned mid-frame with no serialization (bug 7 / architecture review C11),
// and the send was acked before the frame was in the ring. Exercise the REAL
// worker source inside a vm sandbox (the worker-internals.test.ts pattern)
// with a fake shared heap standing in for wasm memory: FIFO order under a
// full ring, completion-ack ordering, and the cap/2 refusal (spec W4).
import { describe, expect, test, beforeAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

interface FakeModule {
  _lean_browser64_configure_input_ring(ptr: bigint, cap: number): bigint;
  _lean_wasm_shell_mark_preinitialized(): void;
  _malloc(n: bigint): bigint;
  callMain(argv: string[]): void;
}
interface ResidentHooks {
  RESIDENT_RING_CAP: number;
  attachRing(memory: { buffer: SharedArrayBuffer }, ctrlPtr: number): void;
  attachRuntime(fake: FakeModule, memory: { buffer: SharedArrayBuffer }): void;
  residentRingWrite(payload: Uint8Array, done?: () => void, abort?: (e: Error) => void): void;
  residentSend(msg: { requestId: string; input: { message: string } }): void;
  residentInit(msg: { requestId: string; input: { initParams?: string; didOpen: string } }): void;
  residentFrame(json: string): Uint8Array;
  die(code: number | null, reason: string, message: string): void;
  snapshot(): { died: boolean; residentMode: boolean; lspMode: boolean; queued: number; pumping: boolean };
}

let R: ResidentHooks;
let posted: Array<{ type: string; kind?: string; requestId?: string; result?: unknown; mode?: string; reason?: string; error?: { code: string; bytes?: number; recoverable: boolean; message: string } }>;
let ctrl: Int32Array;
let bytes: Uint8Array;
let CAP: number;
const IDX = { READ: 0, WRITE: 1, CLOSED: 2, WAKE: 3 };

beforeAll(() => {
  posted = []; // the worker posts {type:"boot"} at load
  const workers = path.resolve(__dirname, "../../public/workers");
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt,
    console, setTimeout, clearTimeout,
    fetch: () => Promise.reject(new Error("no network in unit tests")),
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: unknown) => posted.push(m as (typeof posted)[number]);
  sandbox.addEventListener = () => {};
  sandbox.crossOriginIsolated = true;
  vm.createContext(sandbox);
  // The worker imports the decoder with importScripts (absent here) — load it
  // into the sandbox first, exactly as the browser would.
  vm.runInContext(readFileSync(path.join(workers, "lsp-frames.js"), "utf8"), sandbox, { filename: "lsp-frames.js" });
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  R = (sandbox as { __qed64TestExports?: { resident: ResidentHooks } }).__qed64TestExports!.resident;
  expect(R).toBeDefined();
  CAP = R.RESIDENT_RING_CAP;
  expect(CAP).toBe(4 << 20);
});

/** Fresh ring: control words at 0, byte ring at 16 (patch 0031 layout). */
function freshRing() {
  posted = [];
  const memory = { buffer: new SharedArrayBuffer(16 + CAP) };
  ctrl = new Int32Array(memory.buffer, 0, 4);
  bytes = new Uint8Array(memory.buffer, 16, CAP);
  R.attachRing(memory, 0);
}

/** Consumer: take up to `perTick` bytes per tick, in order, like Lean's
 * ring reader; resolves with the drained stream once `total` bytes arrived. */
function drain(total: number, perTick: number): Promise<Uint8Array> {
  const out = new Uint8Array(total);
  let got = 0;
  return new Promise((resolve) => {
    const tick = () => {
      const read = Atomics.load(ctrl, IDX.READ);
      const write = Atomics.load(ctrl, IDX.WRITE);
      const avail = (write - read + CAP) % CAP;
      const n = Math.min(avail, perTick, total - got);
      for (let i = 0; i < n; i += 1) out[got + i] = bytes[(read + i) % CAP]!;
      got += n;
      Atomics.store(ctrl, IDX.READ, (read + n) % CAP);
      if (got >= total) resolve(out);
      else setTimeout(tick, 1);
    };
    tick();
  });
}

/** Drain until the writer has nothing parked: a failed assertion must not
 * leave the worker's pump re-arming its 2 ms timer forever (which keeps the
 * vitest worker alive and turns one failure into a hung suite). */
async function settle() {
  let idle = 0;
  while (idle < 3) {
    const read = Atomics.load(ctrl, IDX.READ);
    const write = Atomics.load(ctrl, IDX.WRITE);
    if (read === write) idle += 1;
    else {
      idle = 0;
      Atomics.store(ctrl, IDX.READ, write);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
afterEach(settle);

const pattern = (len: number, seed: number) => {
  const p = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) p[i] = (seed * 31 + i) & 0xff;
  return p;
};
// Byte equality across realms: the worker's arrays come from the vm context,
// and a deep-equal over megabytes is both slow and constructor-sensitive.
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe("resident ring writer", () => {
  test("three cap/2 frames through a full ring drain in FIFO order, byte-exact", async () => {
    freshRing();
    // 3 × 2 MiB (the largest frame allowed) through a ring holding CAP-1
    // bytes: the first fits, the second parks one byte short, the third waits.
    const frames = [1, 2, 3].map((seed) => pattern(CAP >> 1, seed));
    const total = frames.reduce((n, f) => n + f.length, 0);
    const doneOrder: number[] = [];
    const writeAtDone: number[] = [];
    frames.forEach((f, i) =>
      R.residentRingWrite(f, () => {
        doneOrder.push(i);
        writeAtDone.push(Atomics.load(ctrl, IDX.WRITE));
      }),
    );
    // Nothing else may write meanwhile — the second frame must park behind the first.
    expect(doneOrder).toEqual([0]);
    const drained = await drain(total, 64 * 1024);
    expect(sameBytes(drained, concat(frames))).toBe(true);
    expect(doneOrder).toEqual([0, 1, 2]);
    // Each `done` fired after its frame's LAST byte: the ring's write index at
    // that moment equals the cumulative bytes written, mod the cap.
    let cum = 0;
    frames.forEach((f, i) => {
      cum += f.length;
      expect(writeAtDone[i]).toBe(cum % CAP);
    });
  });

  test("residentSend acks only after the frame is fully in the ring (completion ack)", async () => {
    freshRing();
    // Two cap/2 fillers exceed the CAP-1 usable bytes: the second parks, and
    // everything behind it (our send) must wait — no consumer runs yet.
    const fillers = [pattern(CAP >> 1, 9), pattern(CAP >> 1, 10)];
    for (const f of fillers) R.residentRingWrite(f);
    const message = JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didChange", params: { text: "y".repeat((CAP >> 1) - 65536) } });
    const frameLen = R.residentFrame(message).length;
    expect(frameLen).toBeLessThanOrEqual(CAP / 2);
    R.residentSend({ requestId: "s1", input: { message } });
    // Parked: not one byte of the frame is in the ring, so no ack may exist yet.
    expect(posted).toEqual([]);
    const fillerBytes = fillers[0]!.length + fillers[1]!.length;
    const drained = await drain(fillerBytes + frameLen, 64 * 1024);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "result", requestId: "s1", result: { operation: "lsp-resident-send", tag: 0 } });
    expect(sameBytes(drained.subarray(fillerBytes), R.residentFrame(message))).toBe(true);
  });

  test("a frame over cap/2 is refused with LSP_RESIDENT_SEND_FAILED and {bytes}; nothing is written", () => {
    freshRing();
    const message = JSON.stringify({ text: "z".repeat(CAP >> 1) });
    R.residentSend({ requestId: "big", input: { message } });
    expect(posted).toHaveLength(1);
    const err = posted[0]!;
    expect(err.type).toBe("error");
    expect(err.requestId).toBe("big");
    expect(err.error!.code).toBe("LSP_RESIDENT_SEND_FAILED");
    expect(err.error!.bytes).toBe(R.residentFrame(message).length);
    expect(err.error!.bytes).toBeGreaterThan(CAP / 2);
    expect(err.error!.recoverable).toBe(true);
    expect(Atomics.load(ctrl, IDX.WRITE)).toBe(0);
    // The ring is still usable afterwards.
    R.residentSend({ requestId: "ok", input: { message: "{}" } });
    expect(posted[1]).toMatchObject({ type: "result", requestId: "ok" });
  });
});

/** A fake runtime recording the transport calls residentInit makes; the ring
 * it "allocates" is the sandbox's shared buffer at offset 0 (freshRing's layout). */
function fakeRuntime() {
  const calls: string[] = [];
  const fake: FakeModule = {
    _lean_wasm_shell_mark_preinitialized: () => { calls.push("preinit"); },
    _malloc: () => { calls.push("malloc"); return 0n; },
    _lean_browser64_configure_input_ring: () => { calls.push("ring"); return 0n; },
    callMain: (argv) => { calls.push(`main ${argv.join(" ")}`); },
  };
  posted = [];
  const memory = { buffer: new SharedArrayBuffer(16 + CAP) };
  ctrl = new Int32Array(memory.buffer, 0, 4);
  bytes = new Uint8Array(memory.buffer, 16, CAP);
  R.attachRuntime(fake, memory);
  return calls;
}

describe("residentInit preflight", () => {
  test("an oversized didOpen is refused BEFORE the runtime is touched, recoverably, and a retry works", async () => {
    const calls = fakeRuntime();
    const didOpen = JSON.stringify({ textDocument: { uri: "file:///x.lean", text: "z".repeat(CAP >> 1) } });
    R.residentInit({ requestId: "i1", input: { didOpen } });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "error", requestId: "i1", error: { code: "LSP_RESIDENT_INIT_FAILED", recoverable: true } });
    expect(posted[0]!.error!.bytes).toBeGreaterThan(CAP / 2);
    // Nothing ran and no mode latched: the worker is exactly as it was.
    expect(calls).toEqual([]);
    expect(R.snapshot()).toMatchObject({ residentMode: false, lspMode: false, queued: 0 });
    // The same worker then starts normally with a small document.
    const small = JSON.stringify({ textDocument: { uri: "file:///x.lean", text: "theorem t : 1 = 1 := rfl" } });
    R.residentInit({ requestId: "i2", input: { initParams: "{}", didOpen: small } });
    expect(calls).toEqual(["preinit", "malloc", "ring", "main --worker -Dserver.reportDelayMs=0"]);
    const opening = concat([
      R.residentFrame(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })),
      R.residentFrame(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didOpen", params: JSON.parse(small) })),
    ]);
    const drained = await drain(opening.length, 64 * 1024);
    expect(sameBytes(drained, opening)).toBe(true);
    expect(posted.filter((m) => m.type === "result")).toEqual([
      expect.objectContaining({ requestId: "i2", result: { operation: "lsp-resident-init", tag: 0 } }),
    ]);
    expect(R.snapshot()).toMatchObject({ residentMode: true, lspMode: true });
  });
});

describe("death (W2)", () => {
  // These run LAST: `died` is a per-worker latch and the sandbox is one worker.
  test("die() fails every queued ack, stops the parked pump, emits one tagged `died`, and refuses re-init", async () => {
    freshRing();
    // Two cap/2 fillers park the pump; a send and an init-shaped write queue behind them.
    for (const f of [pattern(CAP >> 1, 1), pattern(CAP >> 1, 2)]) R.residentRingWrite(f);
    R.residentSend({ requestId: "s-hung", input: { message: "{}" } });
    expect(posted).toEqual([]);
    expect(R.snapshot()).toMatchObject({ queued: 2, pumping: true });

    R.die(1, "exit", "lean --worker exited with code 1");
    R.die(null, "abort", "second death must be swallowed by the latch");
    const died = posted.filter((m) => m.type === "event" && m.kind === "died");
    expect(died).toHaveLength(1);
    expect(died[0]).toMatchObject({ code: 1, reason: "exit", mode: "resident" });
    // The pending ack failed, non-recoverably, instead of hanging.
    const failed = posted.find((m) => m.type === "error" && m.requestId === "s-hung")!;
    expect(failed.error).toMatchObject({ code: "LSP_RESIDENT_SEND_FAILED", recoverable: false });
    expect(failed.error!.message).toContain("died (exit 1)");
    // Queue cleared; the parked timer finds nothing and stops re-arming.
    expect(R.snapshot()).toMatchObject({ died: true, residentMode: false, queued: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(R.snapshot().pumping).toBe(false);

    // After death: sends and inits are refused (one worker, one session).
    posted = [];
    R.residentSend({ requestId: "after", input: { message: "{}" } });
    expect(posted[0]).toMatchObject({ type: "error", requestId: "after", error: { code: "LSP_RESIDENT_SEND_FAILED", recoverable: false } });
    fakeRuntime();
    R.residentInit({ requestId: "re", input: { didOpen: JSON.stringify({ textDocument: { text: "" } }) } });
    expect(posted[0]).toMatchObject({ type: "error", requestId: "re", error: { code: "LSP_RESIDENT_INIT_FAILED", recoverable: false } });
    expect(posted[0]!.error!.message).toContain("already died");
  });
});
