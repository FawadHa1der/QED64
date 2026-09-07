// The resident stdin ring writer (public/workers/lean.worker.js) is the only
// way bytes reach the FileWorker's stdin. Two frames once interleaved because
// a full ring returned mid-frame with no serialization (bug 7 / architecture
// review C11). Exercise the REAL worker source inside a vm sandbox (the
// worker-internals.test.ts pattern) with a fake shared heap standing in for
// wasm memory — first the writer alone (FIFO order under a full ring,
// completion callbacks after the LAST byte), then the writer the way the page
// drives it: through the front door's `lsp` / `lsp-arm` dispatch (the opening
// sequence, park → coalesce newest → drain, the cap/2 refusal counted in
// `status.ring.refused`, and a death aborting every queued frame — spec W2/W4).
import { describe, expect, test, beforeAll, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: unknown };
type Posted = {
  type: string;
  kind?: string;
  requestId?: string | null;
  msg?: Msg;
  result?: { operation: string; open?: boolean };
  error?: { code: string; recoverable: boolean; message: string };
  stream?: string;
  text?: string;
  // `died`
  code?: number | null;
  reason?: string;
  mode?: string;
  // `status`
  phase?: string;
  version?: number | null;
  dropped?: number;
  ring?: { bytesQueued: number; refused: number };
};
interface FakeModule {
  _lean_browser64_configure_input_ring(ptr: bigint, cap: number): number;
  _lean_wasm_shell_mark_preinitialized(): void;
  _malloc(n: bigint): bigint;
  callMain(argv: string[]): void;
}
interface ResidentHooks {
  RESIDENT_RING_CAP: number;
  attachRing(memory: { buffer: SharedArrayBuffer }, ctrlPtr: number): void;
  residentRingWrite(payload: Uint8Array, done?: () => void, abort?: (e: Error) => void): void;
  residentOpenLoop(): void;
  residentFrame(json: string): Uint8Array;
  die(code: number | null, reason: string, message: string): void;
  snapshot(): { died: boolean; residentMode: boolean; lspMode: boolean; queued: number; pumping: boolean };
}
interface FrontDoorHooks {
  state(): { phase: string; queue: unknown[]; backlog: { msg: Msg }[] } | null;
  status(): { phase: string; version: number | null; dropped: number };
  open(): boolean;
  host(h: { state?: string; M?: unknown; memory?: unknown }): void;
}

let R: ResidentHooks;
let FDH: FrontDoorHooks;
let posted: Posted[];
let deliver: (data: unknown) => void;
let ctrl: Int32Array;
let bytes: Uint8Array;
let CAP: number;
const IDX = { READ: 0, WRITE: 1, CLOSED: 2, WAKE: 3 };

const URI = "file:///project/Probe.lean";
const initialize = (id: number): Msg => ({ jsonrpc: "2.0", id, method: "initialize", params: { processId: null, capabilities: {} } });
const didOpen = (version: number, text: string): Msg => ({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: URI, languageId: "lean4", version, text } } });
const didChange = (version: number, text: string): Msg => ({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: URI, version }, contentChanges: [{ text }] } });
const lsp = (msg: Msg) => deliver({ protocol: 1, type: "lsp", msg });
const statuses = () => posted.filter((m) => m.type === "event" && m.kind === "status");
const logs = () => posted.filter((m) => m.type === "event" && m.kind === "log").map((m) => m.text ?? "");

beforeAll(() => {
  posted = []; // the worker posts {type:"boot"} at load
  const workers = path.resolve(__dirname, "../../public/workers");
  const listeners: Record<string, (e: { data: unknown }) => void> = {};
  const sandbox: Record<string, unknown> = {
    crypto, performance, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt,
    console, setTimeout, clearTimeout, clearInterval,
    // The heartbeat the open loop starts must not pin the test process.
    setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref(); return t; },
    fetch: () => Promise.reject(new Error("no network in unit tests")),
  };
  sandbox.self = sandbox;
  sandbox.postMessage = (m: unknown) => posted.push(m as Posted);
  sandbox.addEventListener = (type: string, fn: (e: { data: unknown }) => void) => { listeners[type] = fn; };
  sandbox.crossOriginIsolated = true;
  vm.createContext(sandbox);
  // The worker imports the decoder (and, lazily, the front door) with
  // importScripts (absent here) — load both into the sandbox first, exactly
  // as the browser would.
  for (const name of ["lsp-frames.js", "lsp-front-door.js"]) {
    vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
  }
  vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
  const hooks = (sandbox as { __qed64TestExports?: { resident: ResidentHooks; frontDoor: FrontDoorHooks } }).__qed64TestExports!;
  expect(hooks).toBeDefined();
  R = hooks.resident;
  FDH = hooks.frontDoor;
  deliver = (data) => listeners.message!({ data });
  CAP = R.RESIDENT_RING_CAP;
  expect(CAP).toBe(64 << 20); // pump-removal assessment gap 6: 64 MiB, so a 32 MiB document still fits a frame
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
/** The frames currently in the ring from offset 0 (nothing consumed), decoded. */
const framesInRing = (): Msg[] =>
  new TextDecoder().decode(bytes.subarray(0, Atomics.load(ctrl, IDX.WRITE)))
    .split("Content-Length: ").filter(Boolean)
    .map((f) => JSON.parse(f.slice(f.indexOf("\r\n\r\n") + 4)) as Msg);
const versionOf = (m: Msg) => (m.params as { textDocument: { version: number } }).textDocument.version;
// Frames drain at 1 MiB per tick: the properties here are order and
// completeness, not the reader's chunking, and the ring is 64 MiB.
const TICK = 1 << 20;

describe("resident ring writer through the front door (the page's path)", () => {
  // These run FIRST and in order: the sandbox is one worker, and its loop
  // opens exactly once (`died` below is a per-worker latch).
  test("`lsp-arm` opens the loop on the queued initialize/didOpen and lands the opening sequence in the ring, in order, nothing between", () => {
    posted = [];
    const memory = { buffer: new SharedArrayBuffer(16 + CAP) };
    ctrl = new Int32Array(memory.buffer, 0, 4);
    bytes = new Uint8Array(memory.buffer, 16, CAP);
    const calls: string[] = [];
    const fake: FakeModule = {
      _lean_wasm_shell_mark_preinitialized: () => { calls.push("preinit"); },
      _malloc: () => { calls.push("malloc"); return 0n; }, // the ring lands at offset 0: freshRing's layout
      _lean_browser64_configure_input_ring: () => { calls.push("ring"); return 0; },
      callMain: (argv) => { calls.push(`main ${argv.join(" ")}`); },
    };
    FDH.host({ state: "ready", M: fake, memory });
    // lean4monaco speaks before the page arms: initialize is answered from the
    // table as an `lsp` event, the didOpen waits in the machine's queue.
    lsp(initialize(11));
    lsp(didOpen(1, "theorem t : 1 = 1 := rfl"));
    expect(posted.filter((m) => m.type === "event" && m.kind === "lsp").map((m) => m.msg!.id)).toEqual([11]);
    expect(FDH.open()).toBe(false);
    expect(calls).toEqual([]);
    expect(Atomics.load(ctrl, IDX.WRITE)).toBe(0);
    deliver({ protocol: 1, requestId: "arm", type: "lsp-arm" });
    expect(posted.find((m) => m.requestId === "arm")).toMatchObject({ type: "result", result: { operation: "lsp-arm", open: true } });
    expect(calls).toEqual(["preinit", "malloc", "ring", "main --worker -Dserver.reportDelayMs=0"]);
    expect(FDH.open()).toBe(true);
    expect(FDH.state()!.phase).toBe("open");
    expect(R.snapshot()).toMatchObject({ residentMode: true, lspMode: true, died: false, queued: 0 });
    const frames = framesInRing();
    expect(frames.map((f) => f.method)).toEqual(["initialize", "textDocument/didOpen"]);
    expect(frames[0]!.id).toBe(11);
    expect(sameBytes(bytes.subarray(0, Atomics.load(ctrl, IDX.WRITE)), concat([
      R.residentFrame(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "initialize", params: { processId: null, capabilities: {} } })),
      R.residentFrame(JSON.stringify(didOpen(1, "theorem t : 1 = 1 := rfl"))),
    ]))).toBe(true);
    expect(posted.filter((m) => m.type === "error")).toEqual([]);
    expect(posted.filter((m) => m.type === "event" && m.kind === "died")).toEqual([]);
    expect(statuses().at(-1)).toMatchObject({ phase: "starting", version: 1, ring: { bytesQueued: 0, refused: 0 } });
  });

  test("three cap/2 frames through a full ring drain in FIFO order, byte-exact, each `done` after its LAST byte", async () => {
    freshRing();
    // 3 × 32 MiB (the largest frame allowed) through a ring holding CAP-1
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
    // The park is reported to the machine as ring backpressure (§2.4).
    expect(statuses().at(-1)!.ring!.bytesQueued).toBeGreaterThan(0);
    const drained = await drain(total, TICK);
    expect(sameBytes(drained, concat(frames))).toBe(true);
    expect(doneOrder).toEqual([0, 1, 2]);
    // Each `done` fired after its frame's LAST byte: the ring's write index at
    // that moment equals the cumulative bytes written, mod the cap.
    let cum = 0;
    frames.forEach((f, i) => {
      cum += f.length;
      expect(writeAtDone[i]).toBe(cum % CAP);
    });
    expect(R.snapshot()).toMatchObject({ queued: 0 });
  });

  test("while the ring is parked, `lsp` didChanges are held (newest wins) and the newest lands after the parked frames once the consumer drains", async () => {
    freshRing();
    // Two cap/2 fillers exceed the CAP-1 usable bytes: the second parks, and
    // the host reports the park to the machine — no consumer runs yet.
    const fillers = [pattern(CAP >> 1, 9), pattern(CAP >> 1, 10)];
    for (const f of fillers) R.residentRingWrite(f);
    expect(R.snapshot()).toMatchObject({ queued: 1, pumping: true });
    const parked = statuses().at(-1)!;
    expect(parked.ring!.bytesQueued).toBeGreaterThan(0);
    // Two edits arrive under the park: the machine coalesces them (§2.4 —
    // one elaboration per drain, never one per keystroke behind a full ring).
    lsp(didChange(2, "AB"));
    lsp(didChange(3, "ABC"));
    expect(FDH.state()!.backlog.map((q) => versionOf(q.msg))).toEqual([3]);
    expect(FDH.status()).toMatchObject({ phase: "starting", version: 3 }); // `starting` until the FileWorker's first fileProgress; the version is the held edit's
    expect(statuses().at(-1)!.ring!.bytesQueued).toBe(parked.ring!.bytesQueued); // not one byte of either edit is in the ring
    const wire = R.residentFrame(JSON.stringify(didChange(3, "ABC")));
    const fillerBytes = fillers[0]!.length + fillers[1]!.length;
    const drained = await drain(fillerBytes + wire.length, TICK);
    // FIFO: filler 1, filler 2 (resumed where it parked), then the ONE held edit.
    expect(sameBytes(drained.subarray(0, fillerBytes), concat(fillers))).toBe(true);
    expect(sameBytes(drained.subarray(fillerBytes), wire)).toBe(true);
    expect(FDH.state()!.backlog).toEqual([]);
    expect(R.snapshot()).toMatchObject({ queued: 0, pumping: false });
    expect(statuses().at(-1)).toMatchObject({ version: 3, ring: { bytesQueued: 0, refused: 0 } });
  });

  test("a didChange over cap/2 is refused: counted in status.ring.refused, logged, nothing written; the next edit still goes through", () => {
    freshRing();
    const huge = didChange(4, "z".repeat(CAP >> 1));
    expect(R.residentFrame(JSON.stringify(huge)).length).toBeGreaterThan(CAP / 2);
    lsp(huge);
    expect(Atomics.load(ctrl, IDX.WRITE)).toBe(0);
    expect(logs().some((t) => /frame refused: frame of \d+ bytes exceeds half the \d+-byte stdin ring/.test(t))).toBe(true);
    expect(statuses().at(-1)).toMatchObject({ version: 4, ring: { bytesQueued: 0, refused: 1 } });
    expect(posted.filter((m) => m.type === "error")).toEqual([]);
    expect(posted.filter((m) => m.type === "event" && m.kind === "died")).toEqual([]);
    // The ring and the loop are intact: a normal edit is written whole.
    lsp(didChange(5, "small"));
    const frames = framesInRing();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.method).toBe("textDocument/didChange");
    expect(versionOf(frames[0]!)).toBe(5);
    expect(statuses().at(-1)).toMatchObject({ version: 5, ring: { bytesQueued: 0, refused: 1 } });
  });
});

describe("death (W2)", () => {
  // Runs LAST: `died` is a per-worker latch and the sandbox is one worker.
  test("die() aborts every queued frame, drops the machine's held edits, stops the parked pump, emits one tagged `died`, and refuses every later write and re-open", async () => {
    freshRing();
    // Two cap/2 fillers park the pump; a third frame with callbacks queues
    // behind them, and an edit under the park is held by the machine.
    for (const f of [pattern(CAP >> 1, 1), pattern(CAP >> 1, 2)]) R.residentRingWrite(f);
    const refusedBefore = statuses().at(-1)!.ring!.refused; // the worker's running count (the previous test's refusal)
    let done = 0;
    let aborted: Error | null = null;
    R.residentRingWrite(R.residentFrame("{}"), () => { done += 1; }, (e) => { aborted = e; });
    lsp(didChange(6, "held"));
    expect(FDH.state()!.backlog.map((q) => versionOf(q.msg))).toEqual([6]);
    expect(R.snapshot()).toMatchObject({ queued: 2, pumping: true, died: false });

    R.die(1, "exit", "lean --worker exited with code 1");
    R.die(null, "abort", "second death must be swallowed by the latch");
    const died = posted.filter((m) => m.type === "event" && m.kind === "died");
    expect(died).toHaveLength(1);
    expect(died[0]).toMatchObject({ code: 1, reason: "exit", mode: "resident", message: "lean --worker exited with code 1" });
    // The queued frame's abort fired (non-recoverably, with the cause) instead of its ack hanging.
    expect(done).toBe(0);
    expect(aborted).not.toBeNull();
    expect((aborted as unknown as Error).message).toContain("died (exit 1)");
    // Queue cleared, the machine is dead and its held edit is gone with it.
    expect(R.snapshot()).toMatchObject({ died: true, residentMode: false, queued: 0 });
    expect(FDH.state()!.phase).toBe("dead");
    expect(FDH.state()!.backlog).toEqual([]);
    expect(statuses().at(-1)!.phase).toBe("dead");
    // The parked timer finds nothing and stops re-arming — and the ring
    // coming free does NOT flush the dropped edit onto the dead ring.
    const writeAtDeath = Atomics.load(ctrl, IDX.WRITE);
    await new Promise((r) => setTimeout(r, 20));
    expect(R.snapshot().pumping).toBe(false);
    expect(Atomics.load(ctrl, IDX.WRITE)).toBe(writeAtDeath);
    expect(logs().filter((t) => t.includes("frame refused"))).toEqual([]);
    expect(statuses().at(-1)!.ring!.refused).toBe(refusedBefore);

    // After death: the machine drops client frames, the writer refuses, and
    // the loop cannot be re-opened in this process (one worker, one session).
    const dropped = FDH.status().dropped;
    lsp(didChange(7, "after"));
    expect(FDH.status().dropped).toBe(dropped + 1);
    expect(Atomics.load(ctrl, IDX.WRITE)).toBe(writeAtDeath);
    expect(() => R.residentRingWrite(R.residentFrame("{}"))).toThrow(/dead/);
    expect(() => R.residentOpenLoop()).toThrow(/already died/);
    expect(R.snapshot()).toMatchObject({ residentMode: false });
  });
});
