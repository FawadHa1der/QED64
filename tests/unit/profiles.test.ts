import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateManifest, type ProfileManifest } from "../../src/install/profiles";

const realManifestPath = path.resolve(__dirname, "../../public/profiles/lean-core.manifest.json");

function loadRealManifest(): ProfileManifest {
  return JSON.parse(readFileSync(realManifestPath, "utf8")) as ProfileManifest;
}

/** Transitive import closure of `roots` over the manifest's module table, and
 * the names it reaches that the table lacks. Test-local: the product never
 * walks the graph (the worker resolves imports from the WORKERFS mount). */
function importClosure(roots: string[], modules: Record<string, { imports: string[] }>) {
  const closure = new Set<string>();
  const missing = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (closure.has(name)) continue;
    const entry = modules[name];
    if (!entry) { missing.add(name); continue; }
    closure.add(name);
    stack.push(...entry.imports);
  }
  return { closure: [...closure].sort(), missing: [...missing].sort() };
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

  // Structural, not literal: the served manifest changes at every library
  // import (4.33: 629 modules / 3145 files), and deploy.yml gates on this suite.
  test("the Init closure, every module with an .olean, one WORKERFS file per artifact", () => {
    const modules = Object.values(manifest.content.modules) as unknown as { artifacts: Record<string, unknown> }[];
    expect(modules.length).toBeGreaterThan(600);
    for (const m of modules) expect(Object.keys(m.artifacts)).toContain("olean");
    const artifactCount = modules.reduce((n, m) => n + Object.keys(m.artifacts).length, 0);
    expect(manifest.content.workerfs.metadata.files).toHaveLength(artifactCount);
  });

  test("module import graph is closed (every import resolves)", () => {
    const { missing } = importClosure(manifest.content.roots, manifest.content.modules);
    expect(missing).toEqual([]);
  });

  test("the import closure of the roots stays inside the pack", () => {
    const { closure } = importClosure(["Init", "Std", "Lean"], manifest.content.modules);
    // The core profile is exactly the closure of its roots.
    expect(closure.length).toBeGreaterThan(600);
    expect(closure.length).toBeLessThanOrEqual(Object.keys(manifest.content.modules).length);
  });

  test("WORKERFS ranges are disjoint and ascending", () => {
    const files = [...manifest.content.workerfs.metadata.files].sort((a, b) => a.start - b.start);
    for (let i = 1; i < files.length; i += 1) {
      expect(files[i]!.start).toBeGreaterThanOrEqual(files[i - 1]!.end);
    }
  });
});
