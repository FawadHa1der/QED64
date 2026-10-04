// Overlay environments (docs/EMBEDDING.md §8; src/runtime/snapshots.ts): an
// index entry may declare the module roots it serves, a label and an initial
// commit, and the page boots and widens to it by itself. Pinned here: on an
// index WITHOUT roots every decision is exactly the legacy one (the stock
// index, and an overlay that renamed its region to "mathlib"), and with roots
// the choice is the base plus one covering entry, on component boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseSnapshots, coversModule, entryLabel, entryRoots, initialBytesForEntries, loadSnapshotIndex, widenTarget,
  type SnapshotEntry, type SnapshotIndex,
} from "../../src/runtime/snapshots";
import {
  EDITOR_POLICY, importedModulesOf, initialBytesForSnapshots, isUmbrellaModule, makeEditorPolicy, snapshotsForHeader,
} from "../../frontend/src/resident-session";

const GiB = 1073741824;
const MiB = 1048576;
const entry = (name: string, bytes: number, extra: Partial<SnapshotEntry> = {}): SnapshotEntry => ({ name, url: `/snapshots/${name}.x.snapz`, bytes, imports: [], ...extra });
const STOCK: SnapshotIndex = { schema: "qed64.snapshot-index/v1", snapshots: [entry("init", 122 * MiB), entry("mathlib", 1127 * MiB, { imports: ["QED64.Essential"] })] };
const WIDGET_ROOTS = ["Mathlib", "Batteries", "MIL", "QED64", "ProofWidgets", "HasseView", "SimpLens"];
const OVERLAY: SnapshotIndex = {
  schema: "qed64.snapshot-index/v1",
  snapshots: [entry("init", 122 * MiB), entry("mathlib", 1127 * MiB, { imports: ["QED64.Essential"] }), entry("widgets8", 1400 * MiB, { roots: WIDGET_ROOTS, label: "Mathlib + widgets", initialBytes: 3 * GiB })],
};
const HEADERS = [
  "", "theorem t : True := trivial\n", "import Mathlib\n", "import Mathlib.Data.Real.Basic\nimport Foo\n", "import Init.Data.List\n",
  "import Batteries.Data.List\n", "import MIL.Common\n", "import Mathlib2\n", "import Lean\n", "import Aesop\n", "import HasseView\n",
  "public import Mathlib.Tactic\n", "import QED64.Essential\n",
];

describe("an index without roots behaves exactly as before", () => {
  it.each(HEADERS)("header %j: same snapshots and the same commit as the legacy editor policy", (header) => {
    const modules = importedModulesOf(header);
    expect(chooseSnapshots(STOCK, modules)).toEqual(snapshotsForHeader(header));
    expect(initialBytesForEntries(STOCK, snapshotsForHeader(header))).toBe(initialBytesForSnapshots(snapshotsForHeader(header)));
    const policy = makeEditorPolicy(STOCK);
    expect(policy.snapshotsFor!(header)).toEqual(EDITOR_POLICY.snapshotsFor!(header));
    expect(policy.initialBytesFor!(header, ["init", "mathlib"])).toBe(EDITOR_POLICY.initialBytesFor!(header, ["init", "mathlib"]));
  });
  it("widens exactly when the legacy rule did: a light session, every missing module under an umbrella root", () => {
    const legacy = (missing: string[], loaded: string[]) => !loaded.includes("mathlib") && missing.length > 0 && missing.every(isUmbrellaModule);
    for (const [missing, loaded] of [
      [["Mathlib.Data.Real.Basic"], ["init"]], [["Mathlib.Data.Real.Basic", "Foo"], ["init"]], [["Mathlib2"], ["init"]],
      [["Mathlib.Bogus"], ["init", "mathlib"]], [[], ["init"]], [["MIL.Common", "Batteries.X"], ["init"]],
    ] as Array<[string[], string[]]>) {
      expect(widenTarget(STOCK, missing, loaded)?.name === "mathlib", JSON.stringify([missing, loaded])).toBe(legacy(missing, loaded));
    }
  });
  it("without an index, the policy IS the legacy one", () => {
    expect(makeEditorPolicy(null)).toBe(EDITOR_POLICY);
  });
});

describe("an overlay that declares roots", () => {
  it("boots the smallest entry covering the header — the stock umbrella for Mathlib, the overlay for its own roots", () => {
    expect(chooseSnapshots(OVERLAY, ["Mathlib.Data.Real.Basic"])).toEqual(["init", "mathlib"]);
    expect(chooseSnapshots(OVERLAY, ["HasseView"])).toEqual(["init", "widgets8"]);
    expect(chooseSnapshots(OVERLAY, ["Mathlib.Tactic", "SimpLens.Core"])).toEqual(["init", "widgets8"]);
    expect(chooseSnapshots(OVERLAY, ["HasseView2"])).toEqual(["init"]); // component boundary
    expect(chooseSnapshots(OVERLAY, ["HasseView", "Unknown.Thing"])).toEqual(["init", "widgets8"]); // covers the most
  });
  it("sizes the commit by the entry's initialBytes", () => {
    expect(initialBytesForEntries(OVERLAY, ["init", "widgets8"])).toBe(3 * GiB);
    expect(initialBytesForEntries(OVERLAY, ["init", "mathlib"])).toBe(2048 * MiB);
    expect(initialBytesForEntries(OVERLAY, ["init"])).toBe(256 * MiB);
    expect(makeEditorPolicy(OVERLAY).initialBytesFor!("import HasseView\n", ["init", "widgets8"])).toBe(3 * GiB);
  });
  it("widens a running session to the entry covering EVERY missing module, never to one already loaded", () => {
    expect(widenTarget(OVERLAY, ["HasseView"], ["init"])?.name).toBe("widgets8");
    expect(widenTarget(OVERLAY, ["HasseView"], ["init", "mathlib"])?.name).toBe("widgets8"); // a Mathlib session gaining a widget import
    expect(widenTarget(OVERLAY, ["Mathlib.Data.Real.Basic"], ["init"])?.name).toBe("mathlib"); // the smaller one
    expect(widenTarget(OVERLAY, ["HasseView"], ["init", "widgets8"])).toBeNull();
    expect(widenTarget(OVERLAY, ["HasseView", "Unknown"], ["init"])).toBeNull();
  });
  it("never widens to an entry that would be refused for what the old session covered (the review's ping-pong)", () => {
    // `hasse` serves HasseView only; `mathlib` the umbrella. A header naming both is covered by neither.
    const PAIR: SnapshotIndex = { schema: "qed64.snapshot-index/v1", snapshots: [entry("init", 1), entry("mathlib", 1000, { imports: ["QED64.Essential"] }), entry("hasse", 900, { roots: ["HasseView"] })] };
    const header = ["Mathlib", "HasseView"];
    expect(chooseSnapshots(PAIR, header)).toEqual(["init", "hasse"]); // covers the most, ties → smaller
    expect(widenTarget(PAIR, ["Mathlib"], ["init", "hasse"], header)).toBeNull(); // mathlib would be refused for HasseView
    expect(widenTarget(PAIR, ["HasseView"], ["init", "mathlib"], header)).toBeNull();
    // Without the header (the old call shape) the bounce is possible — the page always passes it.
    expect(widenTarget(PAIR, ["Mathlib"], ["init", "hasse"])?.name).toBe("mathlib");
    // An overlay covering both is still found.
    const BOTH: SnapshotIndex = { ...PAIR, snapshots: [...PAIR.snapshots, entry("widgets", 1400, { roots: ["Mathlib", "HasseView"] })] };
    expect(widenTarget(BOTH, ["Mathlib"], ["init", "hasse"], header)?.name).toBe("widgets");
  });

  it("labels and roots", () => {
    expect(entryLabel(OVERLAY.snapshots[2]!)).toBe("Mathlib + widgets");
    expect(entryLabel(STOCK.snapshots[1]!)).toBe("Mathlib");
    expect(entryLabel(entry("game", 1))).toBe("game");
    expect(entryRoots(STOCK.snapshots[0]!)).toEqual([]);
    expect(coversModule(["Mathlib"], "Mathlib")).toBe(true);
    expect(coversModule(["Mathlib"], "MathlibX.Y")).toBe(false);
  });
});

describe("index validation of the new fields", () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (index: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(index), { status: 200 })));
  it.each([
    [{ roots: "Mathlib" }], [{ roots: [""] }], [{ roots: ["Mathlib.*"] }], [{ roots: ["a b"] }], [{ roots: [3] }],
    [{ label: 3 }], [{ initialBytes: -1 }], [{ initialBytes: "3GiB" }],
  ])("refuses %j", async (bad) => {
    serve({ schema: "qed64.snapshot-index/v1", snapshots: [entry("o", 1, bad as Partial<SnapshotEntry>)] });
    await expect(loadSnapshotIndex()).rejects.toThrow(/malformed entry "o"/);
  });
  it("accepts the documented shape", async () => {
    serve(OVERLAY);
    await expect(loadSnapshotIndex()).resolves.toEqual(OVERLAY);
  });
});
