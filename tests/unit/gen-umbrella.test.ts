// The QED64.Essential umbrella generator: the snapshot the page calls
// "mathlib" is `import QED64.Essential`, and that module is this file's
// output compiled — so its form is pinned (the header and one import per
// module reproduce the hand-made original byte for byte), its order is
// deterministic, and the inputs that would bake a wrong environment are
// refused rather than emitted.
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UMBRELLA_HEADER, importName, manifestModules, umbrellaSource } from "../../pipeline/artifacts/gen-umbrella.mjs";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "pipeline/artifacts/gen-umbrella.mjs");

/** A manifest shaped like pack.mjs output, modules deliberately out of order. */
const fixtureManifest = (names: string[]) => ({
  format: "browser64.artifact-manifest",
  version: 1,
  digest: "sha256:fixture",
  content: {
    release: "mathlib-essential-fixture",
    modules: Object.fromEntries(names.map((n) => [n, { imports: [], artifacts: {} }])),
    roots: ["Mathlib.Topology.Basic"],
  },
});
const FIXTURE = ["Std.Data.HashMap", "Mathlib.Topology.Basic", "Aesop", "Mathlib.Data.Real.Basic", "Lean.Elab.Command", "Batteries.Data.List.Basic", "Aesop.BaseM", "Mathlib"];

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-umbrella-")); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("umbrellaSource", () => {
  test("the exact form: fixed header, blank line, one sorted import per module, trailing newline", () => {
    expect(umbrellaSource(FIXTURE)).toBe(
      "-- QED64 umbrella module: imports the entire mathlib-essential profile.\n" +
      "-- Compiling `import QED64.Essential` seeds one environment that serves every\n" +
      "-- Mathlib import combination the profile can satisfy.\n" +
      "\n" +
      "import Aesop\n" +
      "import Aesop.BaseM\n" +
      "import Batteries.Data.List.Basic\n" +
      "import Lean.Elab.Command\n" +
      "import Mathlib\n" +
      "import Mathlib.Data.Real.Basic\n" +
      "import Mathlib.Topology.Basic\n" +
      "import Std.Data.HashMap\n",
    );
    expect(umbrellaSource(FIXTURE).startsWith(`${UMBRELLA_HEADER}\n`)).toBe(true);
  });

  test("deterministic: input order and duplicates do not matter", () => {
    const shuffled = [...FIXTURE].reverse().concat(FIXTURE.slice(0, 3));
    expect(umbrellaSource(shuffled)).toBe(umbrellaSource(FIXTURE));
  });

  test("sorts by code unit, the order the served manifest lists modules in (uppercase before lowercase, '.' before letters)", () => {
    const lines = umbrellaSource(["Mathlib.Order.Basic", "Mathlib.Order", "Mathlib.OrderOfOperations", "Mathlib.a", "Mathlib.Z"]).trimEnd().split("\n").slice(4);
    expect(lines).toEqual(["import Mathlib.Order", "import Mathlib.Order.Basic", "import Mathlib.OrderOfOperations", "import Mathlib.Z", "import Mathlib.a"]);
  });

  test("the profile's own Std/Lean modules are imported like any other; nothing is added or dropped", () => {
    const source = umbrellaSource(FIXTURE);
    expect(source.split("\n").filter((l) => l.startsWith("import ")).length).toBe(FIXTURE.length);
    expect(source).toContain("import Lean.Elab.Command\n");
    expect(source).not.toMatch(/^import Init/m);
  });

  test("refuses an empty list and a list that contains the umbrella itself", () => {
    expect(() => umbrellaSource([])).toThrow(/no modules/);
    expect(() => umbrellaSource(["Mathlib", "QED64.Essential"])).toThrow(/umbrella itself/);
  });

  test("a component that is not a plain identifier is «quoted»; an unimportable name is refused", () => {
    expect(importName("Mathlib.Tactic.Ring")).toBe("Mathlib.Tactic.Ring");
    expect(importName("Mathlib.Data.Nat'.Basic")).toBe("Mathlib.Data.Nat'.Basic");
    expect(importName("Archive.2024.Q1")).toBe("Archive.«2024».Q1");
    expect(() => importName("Mathlib..Basic")).toThrow(/cannot be imported/);
    expect(() => importName("Mathlib.A\nimport Evil")).toThrow(/cannot be imported/);
  });
});

describe("manifestModules", () => {
  test("reads content.modules of a browser64.artifact-manifest, refuses anything else", () => {
    expect(manifestModules(fixtureManifest(FIXTURE)).sort()).toEqual([...FIXTURE].sort());
    expect(() => manifestModules({ format: "something-else", content: { modules: {} } })).toThrow(/artifact-manifest/);
    expect(() => manifestModules({ format: "browser64.artifact-manifest", content: {} })).toThrow(/artifact-manifest/);
  });

  test("the served essential manifest round-trips: exactly one import per module, sorted", () => {
    const served = JSON.parse(fs.readFileSync(path.join(root, "public/profiles/mathlib-essential.manifest.json"), "utf8"));
    const names = manifestModules(served);
    const imports = umbrellaSource(names).split("\n").filter((l) => l.startsWith("import ")).map((l) => l.slice("import ".length));
    expect(imports).toEqual([...names].sort());
    expect(imports.length).toBeGreaterThan(1000);
  });
});

describe("gen-umbrella.mjs CLI", () => {
  test("writes the umbrella for a manifest and creates the output directory", () => {
    const manifestPath = path.join(tmp, "m.manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(fixtureManifest(FIXTURE)));
    const out = path.join(tmp, "nested/umbrella/Essential.lean");
    const r = spawnSync("node", [script, "--manifest", manifestPath, "--out", out], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/8 imports/);
    expect(fs.readFileSync(out, "utf8")).toBe(umbrellaSource(FIXTURE));
  });

  test("exits 1 and writes nothing for a manifest with no modules; exits 2 without arguments", () => {
    const manifestPath = path.join(tmp, "empty.manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(fixtureManifest([])));
    const out = path.join(tmp, "empty/Essential.lean");
    const r = spawnSync("node", [script, "--manifest", manifestPath, "--out", out], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no modules/);
    expect(fs.existsSync(out)).toBe(false);
    expect(spawnSync("node", [script], { encoding: "utf8" }).status).toBe(2);
  });
});
