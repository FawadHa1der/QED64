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
import { LEAN4_WASM64_TGZ_HINT, forwardToLean4Wasm64, lean4Wasm64Dir } from "../../pipeline/toolchain/artifact-paths.mjs";
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
  test("a node_modules/lean4-wasm64 whose package.json names another package (or none) is skipped: the walk goes on to the real one above", () => {
    // Two impostors between the cwd and <tmp>/consumer/node_modules/lean4-wasm64: a locator that
    // stopped (or gave up) at the first node_modules/lean4-wasm64 it met would not reach `walked`.
    const d = path.join(tmp, "consumer/impostor");
    fakePackage(path.join(d, "node_modules/lean4-wasm64"), "not-lean4-wasm64");
    fs.mkdirSync(path.join(d, "inner/node_modules/lean4-wasm64"), { recursive: true });
    fs.writeFileSync(path.join(d, "inner/node_modules/lean4-wasm64/package.json"), "{ not json");
    expect(lean4Wasm64Dir({ env: {}, cwd: path.join(d, "inner") })).toBe(walked);
    expect(lean4Wasm64Dir({ env: {}, cwd: d })).toBe(walked);
  });
  test("LEAN4_WASM64_DIR passes the same name check: a dir that is not the package gives null, never the walk's find", () => {
    const scripts = fs.mkdtempSync(path.join(tmp, "scripts-only-"));
    for (const f of ["unpack.mjs", "inspect.mjs", "gate.mjs"]) fs.writeFileSync(path.join(scripts, f), STUB);
    const wrong = fakePackage(path.join(tmp, "wrong-name"), "qed64");
    for (const dir of [scripts, wrong, path.join(tmp, "missing")]) {
      expect(lean4Wasm64Dir({ env: { LEAN4_WASM64_DIR: dir }, cwd: path.join(tmp, "consumer/deep/er") }), dir).toBeNull();
    }
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
  test("unpack: an unknown flag or a stray argument is warned about once (by the prelude) and not forwarded, so the package does not repeat it", () => {
    const r = run("pipeline/artifacts/unpack.mjs", ["--manifest", "/m/x.json", "--bogus", "--out=/o", "stray", "--slim=yes", "--slim"], bare, { LEAN4_WASM64_DIR: named });
    expect(r.status).toBe(7);
    // The stub echoes what reached it: only the tokens the prelude accepted (the package's own prelude would warn about any other).
    expect(JSON.parse(r.stdout)).toEqual(["--manifest", "/m/x.json", "--out", "/o", "--slim"]);
    expect(r.lines).toEqual([
      "unpack: WARNING — unknown flag --bogus ignored",
      "unpack: WARNING — unexpected argument stray ignored",
      "unpack: WARNING — unknown flag --slim=yes ignored",
      warning("unpack", "pipeline/artifacts/unpack.mjs"),
    ]);
    // A flag's value that looks like a flag stays that flag's value, as in the package's parser.
    const v = run("pipeline/artifacts/unpack.mjs", ["--manifest", "--slim", "--out", "/o"], bare, { LEAN4_WASM64_DIR: named });
    expect([v.status, JSON.parse(v.stdout), v.lines]).toEqual([7, ["--manifest", "--slim", "--out", "/o"], [warning("unpack", "pipeline/artifacts/unpack.mjs")]]);
  });
  test("unpack: the forward's FLAGS are SPECS.unpack's flag arities", () => {
    const body = fs.readFileSync(path.join(root, "pipeline/artifacts/unpack.mjs"), "utf8");
    const literal = /^const FLAGS = (\{[^}]*\});$/m.exec(body)?.[1];
    expect(literal).toBeDefined();
    const flags = Function(`return (${literal});`)() as Record<string, number>;
    expect(flags).toEqual(Object.fromEntries(SPECS.unpack!.flags.map((f) => [f.name, f.value ? 1 : 0])));
  });
  test("unpack's done marker: group 4 is the out dir with or without the --slim suffix, group 5 the --slim count", () => {
    const done = SPECS.unpack!.markers.find((m) => m.id === "done")!;
    const plain = done.regex.exec("lean-core-x: unpacked 3245 files, 0.39 GB → /x/lean-core (tree)")!;
    expect([plain[1], plain[2], plain[3], plain[4], plain[5]]).toEqual(["lean-core-x", "3245", "0.39", "/x/lean-core (tree)", undefined]);
    const slim = done.regex.exec("lean-core-x: unpacked 2596 files, 0.13 GB → /x/lean-core-slim (--slim: 649 *.olean.private left out)")!;
    expect([slim[4], slim[5]]).toEqual(["/x/lean-core-slim", "649"]);
    expect(done.examples!.some((e) => e.includes("(--slim: "))).toBe(true);
  });
  test("a LEAN4_WASM64_DIR that is not the package (QED64's own forwards, a vendor dir): one line, exit 2, no re-exec loop", () => {
    // The case that looped: the variable names a dir holding this repo's own forward scripts.
    const vendored = fs.mkdtempSync(path.join(tmp, "vendored-"));
    fs.copyFileSync(path.join(root, "pipeline/artifacts/inspect.mjs"), path.join(vendored, "inspect.mjs"));
    const notPackage = (tool: string, dir: string) =>
      `${tool}: LEAN4_WASM64_DIR=${dir} is not the lean4-wasm64 package (no package.json named lean4-wasm64) — set LEAN4_WASM64_DIR=<package dir> or install it: ${LEAN4_WASM64_TGZ_HINT} (docs/CLI-CONTRACT.md)`;
    for (const dir of [path.join(root, "pipeline/artifacts"), vendored, fakePackage(path.join(tmp, "wrong-name-2"), "qed64")]) {
      const r = run("pipeline/artifacts/inspect.mjs", ["/m.json"], bare, { LEAN4_WASM64_DIR: dir });
      expect([r.status, r.signal, r.stdout, r.lines], dir).toEqual([2, null, "", [warning("inspect", "pipeline/artifacts/inspect.mjs"), notPackage("inspect", dir)]]);
    }
    const u = run("pipeline/artifacts/unpack.mjs", ["--manifest", "m", "--out", "o"], bare, { LEAN4_WASM64_DIR: path.join(root, "pipeline/artifacts") });
    expect([u.status, u.lines[1]]).toEqual([2, notPackage("unpack", path.join(root, "pipeline/artifacts"))]);
    expect(u.lines[1]).toMatch(SPECS.unpack!.markers.find((m) => m.id === "not-package")!.regex);
    expect(reservedHit(u.stderr)).toBeNull();
  });
  test("a package whose script is the running script itself (a symlink back): one line, exit 2, no re-exec loop", () => {
    const loop = fakePackage(path.join(tmp, "loop"), "lean4-wasm64", []);
    fs.symlinkSync(path.join(root, "pipeline/artifacts/inspect.mjs"), path.join(loop, "inspect.mjs"));
    const r = run("pipeline/artifacts/inspect.mjs", ["/m.json"], bare, { LEAN4_WASM64_DIR: loop });
    expect([r.status, r.signal, r.stdout]).toEqual([2, null, ""]);
    expect(r.lines).toEqual([
      warning("inspect", "pipeline/artifacts/inspect.mjs"),
      `inspect: lean4-wasm64 at ${loop} would run this script again (${path.join(loop, "inspect.mjs")}) — set LEAN4_WASM64_DIR=<package dir> or install it: ${LEAN4_WASM64_TGZ_HINT} (docs/CLI-CONTRACT.md)`,
    ]);
  });
});

describe("forwardToLean4Wasm64 without process.execve: a child with signals passed on, exiting with its code or 128 + its signal", () => {
  /** A proc with no execve: exit() resolves `exited` instead of exiting, on() records the handlers. */
  function noExecve() {
    const handlers: Record<string, () => void> = {};
    let resolve!: (code: number) => void;
    const exited = new Promise<number>((r) => { resolve = r; });
    const proc = {
      argv: [process.execPath, path.join(tmp, "the-forward.mjs")], execPath: process.execPath, execve: undefined, channel: undefined,
      exit: (code: number) => { resolve(code); }, on: (sig: string, f: () => void) => { handlers[sig] = f; },
      getBuiltinModule: (id: string) => process.getBuiltinModule(id),
    };
    return { proc: proc as unknown as NodeJS.Process, handlers, exited };
  }
  function pkgWith(name: string, source: string) {
    const dir = fakePackage(path.join(tmp, name), "lean4-wasm64", []);
    fs.writeFileSync(path.join(dir, "tool.mjs"), source);
    return dir;
  }
  const env = (dir: string) => ({ ...process.env, LEAN4_WASM64_DIR: dir });

  test("the package's exit code is the forward's (7)", async () => {
    const dir = pkgWith("fallback-exit", "process.exit(7);\n");
    const p = noExecve();
    forwardToLean4Wasm64("t", "tool.mjs", [], { env: env(dir), cwd: bare, proc: p.proc });
    expect(await p.exited).toBe(7);
    expect(Object.keys(p.handlers).sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
  });
  test("a child killed by a signal: 128 + the signal (SIGTERM: 143), not 1", async () => {
    const dir = pkgWith("fallback-signal", "process.kill(process.pid, 'SIGTERM');\nsetInterval(() => {}, 1000);\n");
    const p = noExecve();
    forwardToLean4Wasm64("t", "tool.mjs", [], { env: env(dir), cwd: bare, proc: p.proc });
    expect(await p.exited).toBe(143);
  });
  test("a SIGTERM to the forward reaches the child (no orphan), and the forward exits 143 when it dies", async () => {
    const pidFile = path.join(tmp, "fallback-hang.pid");
    const dir = pkgWith("fallback-hang", `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
    const p = noExecve();
    forwardToLean4Wasm64("t", "tool.mjs", [], { env: env(dir), cwd: bare, proc: p.proc });
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 25));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    p.handlers.SIGTERM!();
    expect(await p.exited).toBe(143);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);
});
