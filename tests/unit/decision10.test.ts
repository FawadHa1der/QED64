// Decision 10 (docs/ARCHITECTURE-PROPOSAL-2026-10-05.md, plan step B1a): the
// lean4-wasm64 package is a devDependency that QED64 never imports.
// adopt-release.sh runs its CLI by path (`node <tools>/cli.mjs …`). The four
// forwards (unpack, chunk-runtime, inspect, gate) were removed in CLI contract
// 4 (architecture review R9a).
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

describe("no file under pipeline/ imports lean4-wasm64 (decision 10: it receives paths)", () => {
  // Static and dynamic imports, re-exports, require, and resolve() (createRequire(...).resolve,
  // import.meta.resolve, require.resolve) of a specifier starting "lean4-wasm64".
  const IMPORTS = [
    /(?:^|[;\s])(?:import|export)\s[^;]*?\sfrom\s*["'`]lean4-wasm64/m,
    /(?:^|[;\s])import\s*["'`]lean4-wasm64/m,
    /\bimport\s*\(\s*["'`]lean4-wasm64/,
    /\brequire\s*\(\s*["'`]lean4-wasm64/,
    /\.resolve\s*\(\s*["'`]lean4-wasm64/,
  ];
  const importsIt = (source: string) => IMPORTS.some((re) => re.test(source));
  test("the patterns catch every import form (and not plain mentions of the name)", () => {
    for (const s of [
      'import { comparePatchIds } from "lean4-wasm64";', 'export * from "lean4-wasm64/index.mjs";', 'import "lean4-wasm64/cli.mjs";',
      'const m = await import("lean4-wasm64");', "const m = require('lean4-wasm64');", 'createRequire(import.meta.url).resolve("lean4-wasm64/package.json")',
      'import.meta.resolve("lean4-wasm64")', 'node -e "import(\'lean4-wasm64\')"',
    ]) expect(importsIt(s), s).toBe(true);
    for (const s of ['console.error("unpack: lean4-wasm64 not found");', 'path.join(d, "node_modules", "lean4-wasm64")', "// use lean4-wasm64 unpack"]) expect(importsIt(s), s).toBe(false);
  });
  test("every tracked .mjs/.js/.sh/.py under pipeline/", () => {
    const files = execFileSync("git", ["ls-files", "pipeline"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => /\.(m?js|sh|py)$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(importsIt(fs.readFileSync(path.join(root, f), "utf8")), `${f} imports lean4-wasm64`).toBe(false);
  });
});
