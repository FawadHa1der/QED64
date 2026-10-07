// The raw snapshot prefetch on a slow first visit (HARDENING #54): the page
// used to terminate the prefetch worker 15 minutes after starting it, however
// steadily bytes were arriving — on links under ~3 Mbit/s the Mathlib
// download was abandoned and the Lean worker fetched it again from the start.
// The page now gives up only after PREFETCH_SILENCE_MS without a message.
// Exercised through the real `loadSnapshotByName` over a scripted fake
// prefetch Worker and an OPFS stub that has nothing cached.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREFETCH_SILENCE_MS, loadSnapshotByName, type Qed64Artifacts, type Qed64Session, type StatusSink } from "../../lib/qed64-boot";

class FakePrefetch {
  static instances: FakePrefetch[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  posted: unknown[] = [];
  terminatedAt: number | null = null;
  constructor(readonly url: string) { FakePrefetch.instances.push(this); }
  postMessage(m: unknown) { this.posted.push(m); }
  terminate() { this.terminatedAt ??= Date.now(); }
  emit(data: unknown) { this.onmessage?.({ data }); }
}

const MINUTE = 60 * 1000;
const entry = { name: "mathlib", url: "/snapshots/mathlib.x.snapz", bytes: 1127272685, transfer: 321484937, digest: `sha256:${"ab".repeat(32)}`, imports: [] };
const artifacts = { snapshots: { snapshots: [entry] } } as unknown as Qed64Artifacts;
const ui: StatusSink = { busy: vi.fn(), progress: vi.fn(), idle: vi.fn() } as unknown as StatusSink;

function session() {
  const loadSnapshot = vi.fn(async () => ({ success: true }));
  const qs = { session: { loadSnapshot }, loadedSnapshots: new Set<string>() } as unknown as Qed64Session;
  return { qs, loadSnapshot };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePrefetch.instances = [];
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("Worker", FakePrefetch);
  // OPFS with nothing cached: the raw entry is missing, so the prefetch runs.
  const dir = { getFileHandle: async () => { throw new Error("NotFoundError"); } };
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Let the awaited OPFS probes settle so the prefetch Worker exists. */
async function started(): Promise<FakePrefetch> {
  for (let i = 0; i < 20 && FakePrefetch.instances.length === 0; i++) await vi.advanceTimersByTimeAsync(0);
  expect(FakePrefetch.instances).toHaveLength(1);
  return FakePrefetch.instances[0]!;
}

describe("raw snapshot prefetch on a slow link", () => {
  it("keeps a prefetch that reports progress, however long the download takes", async () => {
    const { qs, loadSnapshot } = session();
    const done = loadSnapshotByName(artifacts, qs, "mathlib", ui);
    const w = await started();
    expect(w.posted[0]).toMatchObject({ url: entry.url, rawBytes: entry.bytes });
    // 40 minutes at ~100 KB/s of wire bytes: one report a minute is far
    // slower than the worker's real cadence, and still never a silence.
    for (let m = 1; m <= 40; m++) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      w.emit({ status: "progress", bytes: m * 28e6, total: entry.bytes, phase: "download" });
    }
    expect(w.terminatedAt).toBeNull();
    expect(loadSnapshot).not.toHaveBeenCalled();
    w.emit({ status: "done", bytes: entry.bytes });
    await expect(done).resolves.toBe(true);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(ui.progress).toHaveBeenCalledWith(expect.stringMatching(/^preparing the mathlib environment/), expect.objectContaining({ phase: "snapshot", unit: "bytes", total: entry.bytes }));
  });

  it("gives up on a silent prefetch after PREFETCH_SILENCE_MS and lets the checker stream", async () => {
    const { qs, loadSnapshot } = session();
    const done = loadSnapshotByName(artifacts, qs, "mathlib", ui);
    const w = await started();
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(MINUTE);
    w.emit({ status: "progress", bytes: 64e6, total: entry.bytes, phase: "download" });
    const lastMessage = Date.now();
    await vi.advanceTimersByTimeAsync(PREFETCH_SILENCE_MS - 1000);
    expect(w.terminatedAt).toBeNull(); // the silence is counted from the last message, not from the start
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.terminatedAt).toBe(lastMessage + PREFETCH_SILENCE_MS);
    expect(w.terminatedAt! - t0).toBe(MINUTE + PREFETCH_SILENCE_MS);
    await expect(done).resolves.toBe(true);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });
});
