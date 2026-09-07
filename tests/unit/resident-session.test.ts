// The editor's boot policy (frontend/src/resident-session.ts; second review
// §6 amendment 15): the initial document decides the boot-only snapshot list
// and the initial memory commit — an Init-only document boots light (init
// snapshot, 256 MiB), anything naming a module the umbrella serves boots the
// umbrella at 2 GiB. Pure functions of the text; nothing here touches a
// worker or the DOM.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAXIMUM_BYTES,
  importLinesOf,
  importedModulesOf,
  initialBytesForHeader,
  isUmbrellaModule,
  needsMathlib,
  snapshotsForHeader,
} from "../../frontend/src/resident-session";

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
});
