// Decision 10 (docs/ARCHITECTURE-PROPOSAL-2026-10-05.md, plan step B1a): the
// lean4-wasm64 package is a devDependency that QED64's library, workers and
// pipeline never import; the pipeline's forwards (unpack, inspect, gate) are
// handed its directory: $LEAN4_WASM64_DIR, else the first ancestor-of-cwd
// node_modules/lean4-wasm64 whose package.json says so.
//
// Safety: no test here loads a lean.js or a lean.wasm, and none needs the real
// package (this host's shared node_modules does not carry it). The package is
// a FAKE in os.tmpdir(): a package.json and stub scripts that print their argv
// as JSON and exit 7. Every child has a SIGKILL timeout and runs with
// LEAN4_WASM64_DIR cleared unless the case sets it.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEAN4_WASM64_TGZ_HINT, lean4Wasm64Dir } from "../../pipeline/toolchain/artifact-paths.mjs";
import { SPECS, reservedHit } from "../../pipeline/snapshot/cli.mjs";

const root = path.resolve(__dirname, "../..");
const STUB = 'console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n';

let tmp: string;
/** <tmp>/consumer/node_modules/lean4-wasm64: what the ancestor walk finds. */
let walked: string;
/** <tmp>/elsewhere/pkg: a package only LEAN4_WASM64_DIR names. */
let named: string;
/** A dir with no node_modules/lean4-wasm64 above it. */
let bare: string;
function fakePackage(dir: string, name = "lean4-wasm64", scripts = ["unpack.mjs", "inspect.mjs", "gate.mjs"]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0-fake", type: "module" }));
  for (const s of scripts) fs.writeFileSync(path.join(dir, s), STUB);
  return dir;
}
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qed64-decision10-")));
  walked = fakePackage(path.join(tmp, "consumer/node_modules/lean4-wasm64"));
  fs.mkdirSync(path.join(tmp, "consumer/deep/er"), { recursive: true });
  named = fakePackage(path.join(tmp, "elsewhere/pkg"));
  bare = path.join(tmp, "bare");
  fs.mkdirSync(bare);
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Run a repo script with LEAN4_WASM64_DIR cleared, then `env`, in `cwd`. */
function run(rel: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.LEAN4_WASM64_DIR;
  delete base.QED64_LEAN_ARTIFACT;
  const r = spawnSync(process.execPath, [path.join(root, rel), ...args], { cwd, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: { ...base, ...env } });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", lines: (r.stderr ?? "").split("\n").filter(Boolean) };
}

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
  test("the patterns catch every import form (and not the strings the forwards print)", () => {
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

describe("lean4Wasm64Dir: LEAN4_WASM64_DIR, else the first ancestor-of-cwd node_modules/lean4-wasm64 named so, else null", () => {
  test("the variable wins (relative to cwd), even over a package the walk would find", () => {
    expect(lean4Wasm64Dir({ env: { LEAN4_WASM64_DIR: named }, cwd: path.join(tmp, "consumer/deep/er") })).toBe(named);
    expect(lean4Wasm64Dir({ env: { LEAN4_WASM64_DIR: "../elsewhere/pkg" }, cwd: path.join(tmp, "consumer") })).toBe(named);
  });
  test("the walk finds <ancestor>/node_modules/lean4-wasm64 from a deep cwd; an empty variable counts as unset", () => {
    expect(lean4Wasm64Dir({ env: {}, cwd: path.join(tmp, "consumer/deep/er") })).toBe(walked);
    expect(lean4Wasm64Dir({ env: { LEAN4_WASM64_DIR: "" }, cwd: path.join(tmp, "consumer") })).toBe(walked);
  });
  test("a node_modules/lean4-wasm64 whose package.json names another package (or none) is skipped", () => {
    const d = path.join(tmp, "impostor");
    fakePackage(path.join(d, "node_modules/lean4-wasm64"), "not-lean4-wasm64");
    fs.mkdirSync(path.join(d, "inner/node_modules/lean4-wasm64"), { recursive: true });
    fs.writeFileSync(path.join(d, "inner/node_modules/lean4-wasm64/package.json"), "{ not json");
    expect(lean4Wasm64Dir({ env: {}, cwd: path.join(d, "inner") })).toBeNull();
  });
  test("nothing above the cwd: null; never this repo's own (or the module's) location", () => {
    expect(lean4Wasm64Dir({ env: {}, cwd: bare })).toBeNull();
    // Whether or not this checkout has the devDependency installed, a cwd outside it does not see it.
    expect(fs.readFileSync(path.join(root, "pipeline/toolchain/artifact-paths.mjs"), "utf8")).not.toMatch(/import\.meta\.(url|resolve|dirname)/);
  });
});

describe("the forwards: one WARNING, the argv verbatim, the package's exit code; absent: one line, exit 2", () => {
  const notFound = (tool: string) => `${tool}: lean4-wasm64 not found — set LEAN4_WASM64_DIR=<package dir> or install it: ${LEAN4_WASM64_TGZ_HINT} (docs/CLI-CONTRACT.md)`;
  const warning = (tool: string, rel: string) => `${tool}: WARNING — ${rel} is deprecated; use lean4-wasm64 ${tool}${tool === "gate" ? " --artifact <dir>" : ""} (the fork's package) (docs/CLI-CONTRACT.md)`;
  const unpackArgs = ["--manifest", "/m/lean-core.manifest.json", "--out", "/o/tree", "--slim"];

  test("unpack: through LEAN4_WASM64_DIR, the arguments (--slim included) reach the package's unpack.mjs and its exit code is unpack's", () => {
    const r = run("pipeline/artifacts/unpack.mjs", unpackArgs, bare, { LEAN4_WASM64_DIR: named });
    expect(r.signal).toBeNull();
    expect(r.status).toBe(7);
    expect(JSON.parse(r.stdout)).toEqual(unpackArgs);
    expect(r.lines).toEqual([warning("unpack", "pipeline/artifacts/unpack.mjs")]);
    expect(r.lines[0]).toMatch(SPECS.unpack!.markers.find((m) => m.id === "deprecated")!.regex);
    expect(reservedHit(r.stderr)).toBeNull();
  });
  test("unpack: --flag=value is normalized by the prelude before the forward; the walk from the cwd finds the consumer's install", () => {
    const r = run("pipeline/artifacts/unpack.mjs", ["--manifest=/m/x.json", "--out", "/o"], path.join(tmp, "consumer/deep/er"));
    expect(r.status).toBe(7);
    expect(JSON.parse(r.stdout)).toEqual(["--manifest", "/m/x.json", "--out", "/o"]);
    expect(r.lines).toHaveLength(1);
  });
  test("unpack: no package → the WARNING, then exactly one not-found line, exit 2, nothing on stdout", () => {
    const r = run("pipeline/artifacts/unpack.mjs", unpackArgs, bare);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.lines).toEqual([warning("unpack", "pipeline/artifacts/unpack.mjs"), notFound("unpack")]);
    expect(r.lines[1]).toMatch(SPECS.unpack!.markers.find((m) => m.id === "no-package")!.regex);
    expect(reservedHit(r.stderr)).toBeNull();
    expect(SPECS.unpack!.exits["2"]).toMatch(/lean4-wasm64 not found/);
  });
  test("unpack: --help and the usage check are the prelude's, answered without the package", () => {
    const help = run("pipeline/artifacts/unpack.mjs", ["--help"], bare);
    expect([help.status, help.stderr]).toEqual([0, ""]);
    expect(help.stdout.split("\n")[0]).toBe(`usage: ${SPECS.unpack!.synopsis}`);
    const usage = run("pipeline/artifacts/unpack.mjs", ["--out", "/o"], bare);
    expect([usage.status, usage.lines]).toEqual([2, [`usage: ${SPECS.unpack!.synopsis}`]]);
  });
  test("a package dir without the script: one line naming the dir, exit 2", () => {
    const partial = fakePackage(path.join(tmp, "partial"), "lean4-wasm64", ["gate.mjs"]);
    const r = run("pipeline/artifacts/inspect.mjs", ["/m.json"], bare, { LEAN4_WASM64_DIR: partial });
    expect(r.status).toBe(2);
    expect(r.lines).toEqual([
      warning("inspect", "pipeline/artifacts/inspect.mjs"),
      `inspect: lean4-wasm64 at ${partial} has no inspect.mjs — set LEAN4_WASM64_DIR=<package dir> or install it: ${LEAN4_WASM64_TGZ_HINT} (docs/CLI-CONTRACT.md)`,
    ]);
  });
  test("inspect (tier 3): positional manifest and flags verbatim; absent: exit 2", () => {
    const args = ["/m/mathlib-essential.manifest.json", "--deep", "--pack", "/p/raw.pack"];
    const r = run("pipeline/artifacts/inspect.mjs", args, bare, { LEAN4_WASM64_DIR: named });
    expect([r.status, JSON.parse(r.stdout), r.lines]).toEqual([7, args, [warning("inspect", "pipeline/artifacts/inspect.mjs")]]);
    const absent = run("pipeline/artifacts/inspect.mjs", args, bare);
    expect([absent.status, absent.lines]).toEqual([2, [warning("inspect", "pipeline/artifacts/inspect.mjs"), notFound("inspect")]]);
  });
  test("gate: the path rule first (a relative --artifact becomes absolute), then the package's gate with --artifact <abs> only", () => {
    const stage = path.join(tmp, "stage1");
    fs.mkdirSync(path.join(stage, "bin"), { recursive: true });
    fs.writeFileSync(path.join(stage, "bin/lean.js"), "// not a runtime: the fake gate never loads it\n");
    const r = run("pipeline/toolchain/gate.mjs", ["--artifact", "stage1"], tmp, { LEAN4_WASM64_DIR: named });
    expect(r.status).toBe(7);
    expect(JSON.parse(r.stdout)).toEqual(["--artifact", stage]);
    expect(r.lines).toEqual([warning("gate", "pipeline/toolchain/gate.mjs")]);
    const absent = run("pipeline/toolchain/gate.mjs", ["--artifact", stage], bare);
    expect([absent.status, absent.stdout, absent.lines]).toEqual([2, "", [warning("gate", "pipeline/toolchain/gate.mjs"), notFound("gate")]]);
    // A missing artifact still refuses before the forward, with gate's own line and no WARNING.
    const missing = run("pipeline/toolchain/gate.mjs", ["--artifact", path.join(tmp, "nope")], bare, { LEAN4_WASM64_DIR: named });
    expect([missing.status, missing.lines]).toEqual([2, [`gate: ${path.join(tmp, "nope")}/bin/lean.js not found`]]);
  });
});
