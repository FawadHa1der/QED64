// The runtimes a document replaced (docs/HARDENING.md #68, the page half):
// LeanSession.dispose() records its runtime id in lib/client.ts's module-level
// list (the last 4, for 10 s), and every later boot in the same document names
// them in `instance.predecessors`, never itself; the worker then waits for all
// of their Workers (tests/unit/runtime-locks.test.ts). The real LeanSession over
// a fake Worker (the session-serialization.test.ts pattern), re-imported after
// vi.resetModules() in every test: each test is a fresh document, whose list
// starts empty.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootConfig, LeanSession as Session } from "../../lib/client";

interface Posted {
  protocol: number;
  requestId: string;
  type: string;
  [key: string]: unknown;
}
interface Instance { id: string; waitMs: number; predecessors: string[] }

class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: Posted[] = [];
  terminated = false;
  constructor(_url: string) { FakeWorker.instances.push(this); }
  addEventListener(_type: string, _fn: (e: unknown) => void) {}
  postMessage(msg: Posted) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
}

const CONFIG: BootConfig = {
  runtime: {} as BootConfig["runtime"],
  memory: { initialBytes: 256 * 1024 * 1024, maximumCandidates: [4 * 1024 * 1024 * 1024] },
  leanPath: "/lib/lean",
  packs: [],
};

let LeanSession: typeof Session;

/** A session and the Worker it spawned at construction. */
function make(): { session: Session; worker: FakeWorker } {
  const session = new LeanSession("/fake.worker.js");
  return { session, worker: FakeWorker.instances[FakeWorker.instances.length - 1]! };
}

/** Boot (posted synchronously, never answered: a dispose rejects it DISPOSED)
 * and return the `instance` that boot carried. */
function bootInstance(s: { session: Session; worker: FakeWorker }): Instance {
  s.session.boot(CONFIG).catch(() => {});
  const boots = s.worker.posted.filter((m) => m.type === "boot");
  return boots[boots.length - 1]!.instance as Instance;
}

beforeEach(async () => {
  vi.resetModules();
  FakeWorker.instances.length = 0;
  vi.stubGlobal("Worker", FakeWorker);
  ({ LeanSession } = await import("../../lib/client"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LeanSession names the runtimes this document replaced (HARDENING #68)", () => {
  it("a document's first runtime names none", () => {
    expect(bootInstance(make())).toEqual({ id: expect.any(String), waitMs: 6000, predecessors: [] });
  });

  it("a replacement names the runtime this document disposed, never itself", () => {
    const a = make();
    const aId = bootInstance(a).id;
    a.session.dispose();
    const b = make();
    const first = bootInstance(b);
    expect(first.id).not.toBe(aId);
    expect(first.predecessors).toEqual([aId]);
    expect(first.predecessors).not.toContain(first.id);
    // Even a session that boots again after its own dispose (nothing does) never names itself.
    b.session.dispose();
    const again = bootInstance(b);
    expect(again.id).toBe(first.id);
    expect(again.predecessors).toEqual([aId]);
  });

  it("dispose then terminate records once; at most 4 kept; older than 10 s not named", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const a = make();
    const ids = [bootInstance(a).id];
    a.session.dispose();
    a.session.dispose(); // a second dispose (a halted relay's unload disposes its dead session again) records nothing more
    a.session.terminate();
    expect(bootInstance(make()).predecessors).toEqual(ids);
    // terminate() alone disposes first, and records like dispose().
    for (let i = 0; i < 4; i += 1) {
      const s = make();
      ids.push(bootInstance(s).id);
      if (i === 0) s.session.terminate(); else s.session.dispose();
    }
    expect(ids).toHaveLength(5);
    expect(bootInstance(make()).predecessors).toEqual(ids.slice(-4)); // the oldest fell out
    vi.advanceTimersByTime(9_999);
    expect(bootInstance(make()).predecessors).toEqual(ids.slice(-4));
    vi.advanceTimersByTime(1);
    expect(bootInstance(make()).predecessors).toEqual([]);
  });
});
