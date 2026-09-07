// The editor's boot policy (frontend/src/resident-session.ts; second review
// §6 amendment 15): the initial document decides the boot-only snapshot list
// and the initial memory commit — an Init-only document boots light (init
// snapshot, 256 MiB), anything naming a module the umbrella serves boots the
// umbrella at 2 GiB. The policy functions are pure functions of the text;
// the adapter itself is exercised over a fake Worker (no DOM): how it
// resolves boot inputs from policy + restart options, and that its
// `terminate()` is the synchronous kill the relay's `unload()` reaches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAXIMUM_BYTES,
  EDITOR_POLICY,
  ResidentSession,
  importLinesOf,
  importedModulesOf,
  initialBytesForHeader,
  initialBytesForSnapshots,
  isUmbrellaModule,
  needsMathlib,
  snapshotsForHeader,
  type ResidentHost,
} from "../../frontend/src/resident-session";
import { LeanSession } from "../../src/runtime/client";

const MiB = 1048576;
const GiB = 1073741824;

describe("import-line extraction", () => {
  it("keeps only import lines, with the modifiers Lean accepts on them", () => {
    const text = "-- a comment\nimport Mathlib.Data.Real.Basic\npublic import Foo.Bar\nmeta import Baz\n\nexample : True := trivial\n";
    expect(importLinesOf(text)).toEqual(["import Mathlib.Data.Real.Basic", "public import Foo.Bar", "meta import Baz"]);
    expect(importedModulesOf(text)).toEqual(["Mathlib.Data.Real.Basic", "Foo.Bar", "Baz"]);
  });
  it("a commented-out import is not an import; a half-typed one names nothing", () => {
    expect(importedModulesOf("-- import Mathlib\n")).toEqual([]);
    expect(importedModulesOf("import \n")).toEqual([]);
    expect(importedModulesOf("import")).toEqual([]);
  });
  it("reads the whole document (only import lines matter, wherever they sit)", () => {
    expect(importedModulesOf("inductive Tree (α : Type) where\n  | leaf : Tree α\n")).toEqual([]);
  });
});

describe("umbrella roots", () => {
  it("are the roots patch 0032's resolver covers with QED64.Essential", () => {
    for (const m of ["Mathlib", "Mathlib.Tactic", "Mathlib.Data.Real.Basic", "Batteries", "Batteries.Data.List.Basic", "MIL.Common", "QED64.Essential"]) {
      expect(isUmbrellaModule(m), m).toBe(true);
    }
  });
  it("never fuzzy-match a near-miss root (the kernel refuses those and no snapshot changes that)", () => {
    for (const m of ["Mathlib2.Foo", "Batteries2", "MILx.Common", "Init", "Lean", "Std.Data.HashMap", ""]) {
      expect(isUmbrellaModule(m), m).toBe(false);
    }
  });
});

describe("snapshotsForHeader / initialBytesForHeader (the editor's policy)", () => {
  const init = "inductive Tree (α : Type) where\n  | leaf : Tree α\n\ntheorem t : True := trivial\n";
  const mathlib = "import Mathlib.Data.Real.Basic\n\nexample (a b : ℝ) : a + b = b + a := by ring\n";
  const mil = "import MIL.Common\nimport Mathlib.Data.Real.Basic\n";
  it("an Init-only document boots light: the init snapshot and a 256 MiB commit", () => {
    expect(needsMathlib(init)).toBe(false);
    expect(snapshotsForHeader(init)).toEqual(["init"]);
    expect(initialBytesForHeader(init)).toBe(256 * MiB);
    expect(snapshotsForHeader("")).toEqual(["init"]);
    expect(initialBytesForHeader("")).toBe(256 * MiB);
  });
  it("a Mathlib document boots the umbrella at 2 GiB", () => {
    for (const text of [mathlib, mil, "import Mathlib\n", "import Mathlib.Tactic\n", "import Batteries\n", "import QED64.Essential\n"]) {
      expect(needsMathlib(text), text).toBe(true);
      expect(snapshotsForHeader(text), text).toEqual(["init", "mathlib"]);
      expect(initialBytesForHeader(text), text).toBe(2048 * MiB);
    }
  });
  it("a header the umbrella cannot serve boots light (the kernel refuses it either way)", () => {
    for (const text of ["import Mathlib2.Foo\n", "import Lean\n", "import Mathl\n", "-- import Mathlib\n"]) {
      expect(snapshotsForHeader(text), text).toEqual(["init"]);
      expect(initialBytesForHeader(text), text).toBe(256 * MiB);
    }
  });
  it("a mixed header still boots the umbrella (the kernel reports the module it cannot cover)", () => {
    expect(snapshotsForHeader("import Mathlib.Data.Real.Basic\nimport Mathlib.Foo.Bogus\n")).toEqual(["init", "mathlib"]);
  });
  it("the editor's reservation cap is 6 GiB", () => {
    expect(DEFAULT_MAXIMUM_BYTES).toBe(6 * GiB);
  });
  it("the commit follows the snapshot list, not the header: the umbrella among the loads means 2 GiB", () => {
    expect(initialBytesForSnapshots(["init"])).toBe(256 * MiB);
    expect(initialBytesForSnapshots([])).toBe(256 * MiB);
    expect(initialBytesForSnapshots(["init", "mathlib"])).toBe(2048 * MiB);
    expect(initialBytesForSnapshots(["mathlib"])).toBe(2048 * MiB);
  });
});

/** The Worker the adapter's LeanSession spawns: enough surface for construct,
 * dispose and terminate (the same shape session-serialization.test.ts uses). */
class FakeWorker {
  static instances: FakeWorker[] = [];
  posted: unknown[] = [];
  terminated = false;
  constructor(_url: string) { FakeWorker.instances.push(this); }
  addEventListener(_type: string, _fn: (e: unknown) => void) {}
  postMessage(msg: unknown) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
}

const silentUi = { busy() {}, progress() {}, idle() {} };
/** A host with exactly the policy given — none when omitted (no default: an explicit `undefined` must mean "no policy"). */
const host = (headerText: string, policy?: ResidentHost["policy"]): ResidentHost =>
  ({ artifacts: {} as ResidentHost["artifacts"], ui: silentUi, headerText, ...(policy ? { policy } : {}) });
/** The page's host: the editor's policy. */
const editorHost = (headerText: string): ResidentHost => host(headerText, EDITOR_POLICY);
const INIT_ONLY = "inductive Tree (α : Type) where\n  | leaf : Tree α\n";
const MATHLIB = "import Mathlib.Data.Real.Basic\n\nexample : True := trivial\n";

describe("ResidentSession: boot inputs (policy + restart options)", () => {
  beforeEach(() => { FakeWorker.instances.length = 0; vi.stubGlobal("Worker", FakeWorker); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("with no options the policy decides both the snapshots and the commit from the header", () => {
    const light = new ResidentSession(editorHost(INIT_ONLY));
    expect(light.snapshots).toEqual(["init"]);
    expect(light.initialBytes).toBe(256 * MiB);
    const heavy = new ResidentSession(editorHost(MATHLIB));
    expect(heavy.snapshots).toEqual(["init", "mathlib"]);
    expect(heavy.initialBytes).toBe(2048 * MiB);
    expect(heavy.maximumBytes).toBe(DEFAULT_MAXIMUM_BYTES);
  });
  it("explicit restart snapshots win over the header AND size the commit: an umbrella boot over an Init-only header commits 2 GiB", () => {
    // A remembered "Load exact imports" (the relay's restartOpts) or the page's widen restart: what is
    // streamed is the ~1.5 GB umbrella region, and a 256 MiB commit would grow through the repeated-grow
    // path the large initial commit exists to avoid.
    const s = new ResidentSession(editorHost(INIT_ONLY), { snapshots: ["init", "mathlib"] });
    expect(s.snapshots).toEqual(["init", "mathlib"]);
    expect(s.initialBytes).toBe(2048 * MiB);
    const back = new ResidentSession(editorHost(MATHLIB), { snapshots: ["init"] });
    expect(back.snapshots).toEqual(["init"]);
    expect(back.initialBytes).toBe(256 * MiB);
  });
  it("the policy hook sees the resolved list; a one-argument policy (the seam contract's shape) still compiles and is called", () => {
    const seen: Array<[string, readonly string[]]> = [];
    const s = new ResidentSession(host(INIT_ONLY, { initialBytesFor: (h, snaps) => { seen.push([h, snaps]); return 7 * MiB; } }), { snapshots: ["init", "mathlib"] });
    expect(seen).toEqual([[INIT_ONLY, ["init", "mathlib"]]]);
    expect(s.initialBytes).toBe(7 * MiB);
    const oneArg = new ResidentSession(host(MATHLIB, { initialBytesFor: (h: string) => h.length }));
    expect(oneArg.initialBytes).toBe(MATHLIB.length);
  });
  it("without a policy the defaults are the umbrella at 2 GiB under the 6 GiB cap", () => {
    const s = new ResidentSession(host(INIT_ONLY)); // no policy at all
    expect(s.snapshots).toEqual(["init", "mathlib"]);
    expect(s.initialBytes).toBe(2048 * MiB);
    expect(s.maximumBytes).toBe(DEFAULT_MAXIMUM_BYTES);
    const capped = new ResidentSession(host(INIT_ONLY, { maximumBytes: 3 * GiB }));
    expect(capped.maximumBytes).toBe(3 * GiB);
  });
  it("`id` is the LeanSession's and `lean` is that LeanSession (the telemetry hook `relay.session.lean`)", () => {
    const s = new ResidentSession(editorHost(INIT_ONLY));
    expect(s.lean).toBeInstanceOf(LeanSession);
    expect(s.id).toBe(s.lean.id);
    expect(FakeWorker.instances).toHaveLength(1); // one Worker per session, spawned at construction
  });
});

describe("ResidentSession: terminate() is the synchronous kill (the relay's unload seam)", () => {
  beforeEach(() => { FakeWorker.instances.length = 0; vi.stubGlobal("Worker", FakeWorker); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("terminate() kills the Worker inside the caller's turn — no timer, no await", () => {
    const s = new ResidentSession(editorHost(MATHLIB));
    const w = FakeWorker.instances[0]!;
    s.terminate();
    expect(w.terminated).toBe(true); // before any timer could run
  });
  it("dispose() alone defers the kill 250 ms behind a timer a closing document never runs — why unload() must also terminate()", () => {
    const s = new ResidentSession(editorHost(MATHLIB));
    const w = FakeWorker.instances[0]!;
    s.dispose();
    expect(w.terminated).toBe(false);
    vi.advanceTimersByTime(249);
    expect(w.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(w.terminated).toBe(true);
  });
  it("dispose() then terminate() — the relay's unload order — kills at once, never emits a death, and the late timer is inert", () => {
    const s = new ResidentSession(editorHost(MATHLIB));
    const w = FakeWorker.instances[0]!;
    let deaths = 0;
    s.onDied = () => { deaths += 1; };
    s.dispose();
    s.terminate();
    expect(w.terminated).toBe(true);
    expect(() => s.terminate()).not.toThrow(); // idempotent
    vi.advanceTimersByTime(1000);
    expect(deaths).toBe(0);
  });
});
