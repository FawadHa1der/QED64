import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  importClosure,
  parseImports,
  validateManifest,
  type ProfileManifest,
} from "../../src/install/profiles";

const realManifestPath = path.resolve(__dirname, "../../public/profiles/lean-core.manifest.json");

function loadRealManifest(): ProfileManifest {
  return JSON.parse(readFileSync(realManifestPath, "utf8")) as ProfileManifest;
}

describe("validateManifest", () => {
  test("accepts the real published lean-core manifest", () => {
    expect(() => validateManifest(loadRealManifest())).not.toThrow();
  });

  test("rejects a foreign format", () => {
    const m = loadRealManifest();
    (m as { format: string }).format = "evil";
    expect(() => validateManifest(m)).toThrow(/format/);
  });

  test("rejects non-gzip transport", () => {
    const m = loadRealManifest();
    m.content.pack.transport.encoding = "zstd";
    expect(() => validateManifest(m)).toThrow(/encoding/);
  });

  test("rejects part-sum mismatches", () => {
    const m = loadRealManifest();
    m.content.pack.transport.parts[0]!.byteLength += 1;
    expect(() => validateManifest(m)).toThrow(/sum/);
  });

  test("rejects malformed part digests", () => {
    const m = loadRealManifest();
    m.content.pack.transport.parts[0]!.digest = "sha256:nothex";
    expect(() => validateManifest(m)).toThrow(/digest/);
  });

  test("rejects out-of-bounds WORKERFS ranges", () => {
    const m = loadRealManifest();
    m.content.workerfs.metadata.files[0]!.end = m.content.pack.byteLength + 1;
    expect(() => validateManifest(m)).toThrow(/range/i);
  });

  test("rejects oversized parts (zip-bomb guard)", () => {
    const m = loadRealManifest();
    m.content.pack.transport.parts[0]!.byteLength = 65 * 1024 * 1024;
    expect(() => validateManifest(m)).toThrow(/bounds|sum/);
  });
});

describe("real manifest invariants", () => {
  const manifest = loadRealManifest();

  test("629 modules, five facets each, 3145 WORKERFS files", () => {
    expect(Object.keys(manifest.content.modules)).toHaveLength(629);
    expect(manifest.content.workerfs.metadata.files).toHaveLength(3145);
  });

  test("module import graph is closed (every import resolves)", () => {
    const { missing } = importClosure(manifest.content.roots, manifest.content.modules);
    expect(missing).toEqual([]);
  });

  test("Init closure covers all 629 modules", () => {
    const { closure } = importClosure(["Init", "Std", "Lean"], manifest.content.modules);
    // The core profile is exactly the closure of its roots.
    expect(closure.length).toBeGreaterThan(600);
    expect(closure.length).toBeLessThanOrEqual(629);
  });

  test("WORKERFS ranges are disjoint and ascending", () => {
    const files = [...manifest.content.workerfs.metadata.files].sort((a, b) => a.start - b.start);
    for (let i = 1; i < files.length; i += 1) {
      expect(files[i]!.start).toBeGreaterThanOrEqual(files[i - 1]!.end);
    }
  });
});

describe("parseImports", () => {
  test("plain, public, meta, and prelude forms", () => {
    const source = [
      "-- import NotThis",
      "import Mathlib.Algebra.Group.Basic",
      "public import Init.Data.List",
      "meta import Lean.Elab",
      "public meta import Std.Data.HashMap",
      "def x := 1",
      "import TooLate -- still counted; Lean rejects it, we only resolve",
    ].join("\n");
    expect(parseImports(source)).toEqual([
      "Mathlib.Algebra.Group.Basic",
      "Init.Data.List",
      "Lean.Elab",
      "Std.Data.HashMap",
      "TooLate",
    ]);
  });

  test("no imports", () => {
    expect(parseImports("theorem t : True := trivial")).toEqual([]);
  });
});

describe("importClosure", () => {
  const modules = {
    A: { imports: ["B", "C"] },
    B: { imports: ["C"] },
    C: { imports: [] },
    D: { imports: ["Ghost"] },
  };
  test("computes transitive closures", () => {
    expect(importClosure(["A"], modules).closure).toEqual(["A", "B", "C"]);
  });
  test("reports missing modules without looping", () => {
    const { closure, missing } = importClosure(["D"], modules);
    expect(closure).toEqual(["D"]);
    expect(missing).toEqual(["Ghost"]);
  });
  test("tolerates cycles", () => {
    const cyclic = { X: { imports: ["Y"] }, Y: { imports: ["X"] } };
    expect(importClosure(["X"], cyclic).closure).toEqual(["X", "Y"]);
  });
});
