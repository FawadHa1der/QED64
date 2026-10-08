// The one path-resolution rule of the pipeline tools (docs/CLI-CONTRACT.md
// "Path resolution", plan step A3) and the --stack-size re-exec ("Runtime"),
// pinned without booting a runtime.
//
// Safety: no test here loads a lean.js or a lean.wasm. The tools run from a
// SCRATCH CHECKOUT (the script and pipeline/toolchain/artifact-paths.mjs
// copied into a temp dir, so "the repo root" and its deprecated defaults are
// the test's), every environment variable of the rule is cleared, and each
// case is chosen to stop at a cheap existence check: a missing lib tree, a
// foreign index, a missing --snap, a bin/lean.js that is a directory. The one
// bake that runs to completion runs a FAKE node-runner (a script that writes
// the .snap and exits); gate's deprecated-default case forwards to a FAKE
// lean4-wasm64 package (LEAN4_WASM64_DIR) whose gate records its argv. Every child has a SIGKILL timeout: spawnSync's,
// or (the one async spawn) a timer and a finally that kill it, and the scratch
// tool's --hang mode exits by itself after 25 s whatever the test did.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureStackSize, resolveToolPath, runtimeBuildId, toolPath } from "../../pipeline/toolchain/artifact-paths.mjs";
import { SPECS, reservedHit } from "../../pipeline/snapshot/cli.mjs";
import { batteryInputs } from "../../tests/adversarial/compiler-battery.mjs";

const root = path.resolve(__dirname, "../..");
const pathsModule = path.join(root, "pipeline/toolchain/artifact-paths.mjs");
const RULE_ENV = ["QED64_LEAN_ARTIFACT", "QED64_WORK", "QED64_STAGING", "QED64_LIB_TREE", "QED64_MATHLIB_SNAP", "QED64_SNAP_DIR", "QED64_ALLOW_LEGACY_IMPORTS", "QED64_RUNNER", "LEAN4_WASM64_DIR"];
const marker = (tool: string, id: string) => SPECS[tool]!.markers.find((m) => m.id === id)!.regex;
const DEPRECATED = marker("bake-snapshot", "deprecated-default");
const NO_PATH = marker("bake-snapshot", "no-path");

let tmp: string;
// realpath: a script derives its repo root from import.meta.url, which Node gives as the real path.
beforeAll(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qed64-tool-paths-"))); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A temp checkout holding copies of `files` (repo-relative) at the same paths. */
function checkout(files: string[]): string {
  const s = fs.mkdtempSync(path.join(tmp, "checkout-"));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(s, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(s, f));
  }
  fs.mkdirSync(path.join(s, "tmp"));
  return s;
}
const TOOLS: Record<string, string[]> = {
  "node-runner": ["pipeline/snapshot/node-runner.mjs"],
  "snapshot-probe": ["pipeline/snapshot/snapshot-probe.mjs"],
  "persistent-probe": ["pipeline/snapshot/persistent-probe.mjs"],
  "bake-snapshot": ["pipeline/snapshot/bake-snapshot.mjs"],
  "chunk-runtime": ["pipeline/toolchain/chunk-runtime.mjs"],
  gate: ["pipeline/toolchain/gate.mjs"],
  "resident-probe": ["pipeline/snapshot/resident-probe.mjs", "public/workers/lsp-frames.js", "public/workers/lean.worker.js"],
};
const toolCheckout = (tool: string) => checkout([...TOOLS[tool]!, "pipeline/toolchain/artifact-paths.mjs"]);

/** Run `rel` inside checkout `s` (cwd `s`, TMPDIR inside it) with the rule's variables cleared, then `env`. */
function run(s: string, rel: string, args: string[], env: Record<string, string> = {}, cwd = s) {
  const base: Record<string, string | undefined> = { ...process.env, TMPDIR: path.join(s, "tmp") };
  for (const name of RULE_ENV) delete base[name];
  const r = spawnSync(process.execPath, [path.join(s, rel), ...args], {
    cwd, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: { ...base, ...env },
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", lines: (r.stderr ?? "").split("\n").filter(Boolean) };
}

/** Every path under `dir`, so a refusal that touched the filesystem shows. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(`${path.relative(dir, p)} ${fs.lstatSync(p).size}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

const legacyStage1 = (s: string) => path.join(s, "pipeline/toolchain/work/build/stage1");
const CHUNK_FORWARD = "chunk-runtime: WARNING — pipeline/toolchain/chunk-runtime.mjs is deprecated; use lean4-wasm64 chunk --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string> (the fork's package) (docs/CLI-CONTRACT.md)";
/** A FAKE lean4-wasm64 package inside checkout `s`: its chunk-runtime.mjs prints its argv and exits 7. */
function fakeChunker(s: string): string {
  const pkg = path.join(s, "fake-lean4-wasm64");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "lean4-wasm64" }));
  fs.writeFileSync(path.join(pkg, "chunk-runtime.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n");
  return pkg;
}
function fakeStage1(dir: string, { js = true, wasm = false, jsIsDir = false } = {}) {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  if (jsIsDir) fs.mkdirSync(path.join(dir, "bin/lean.js"));
  else if (js) fs.writeFileSync(path.join(dir, "bin/lean.js"), "// never loaded by these tests\n");
  if (wasm) fs.writeFileSync(path.join(dir, "bin/lean.wasm"), Buffer.from(`\0asm${path.basename(path.dirname(dir))}`));
  return dir;
}

describe("resolveToolPath: flag, then variable, then the deprecated default (one WARNING), else exit 2", () => {
  const capture = (environment: Record<string, string | undefined> = {}) => {
    const io = { err: [] as string[], code: null as number | null };
    return { io, sink: { err: (s: string) => io.err.push(s), exit: (c: number) => { io.code = c; }, environment } };
  };
  const base = { tool: "bake-snapshot", flag: "work", placeholder: "<dir>", env: "QED64_WORK", legacyLabel: "work/snapshot under the repo root", usage: "bake-snapshot.mjs [--work <dir>]" };

  test("the flag wins (relative to the tool's base), then the variable (relative to the cwd); an empty one counts as unset", () => {
    const { io, sink } = capture({ QED64_WORK: "/from/env" });
    expect(resolveToolPath({ ...base, value: "rel", base: "/repo", legacy: "/repo/work/snapshot" }, sink)).toEqual({ path: "/repo/rel", source: "flag" });
    expect(resolveToolPath({ ...base, value: null, legacy: "/repo/work/snapshot" }, sink)).toEqual({ path: "/from/env", source: "env" });
    expect(resolveToolPath({ ...base, value: "", legacy: "/repo/work/snapshot" }, sink)).toEqual({ path: "/from/env", source: "env" });
    expect(toolPath({ env: "QED64_WORK", environment: { QED64_WORK: "rel-env" } })).toEqual({ path: path.resolve("rel-env"), source: "env" });
    expect(toolPath({ env: "QED64_WORK", legacy: "/l", environment: { QED64_WORK: "" } })).toEqual({ path: "/l", source: "default" });
    expect(toolPath({ env: "QED64_STAGING", envTo: (v) => path.join(v, "wasm64-x", "runtime"), environment: { QED64_STAGING: "/stg" } })).toEqual({ path: "/stg/wasm64-x/runtime", source: "env" });
    expect([io.err, io.code]).toEqual([[], null]);
  });

  test("the deprecated default resolves with exactly one WARNING in the policy's form, free of reserved substrings", () => {
    const { io, sink } = capture();
    expect(resolveToolPath({ ...base, value: undefined, legacy: "/repo/work/snapshot" }, sink)).toEqual({ path: "/repo/work/snapshot", source: "default" });
    expect(io.err).toEqual(["bake-snapshot: WARNING — the default --work work/snapshot under the repo root (/repo/work/snapshot) is deprecated; use --work <dir> or set QED64_WORK (docs/CLI-CONTRACT.md)"]);
    expect(io.err[0]).toMatch(/^\S+: WARNING — .* is deprecated; use .* \(docs\/CLI-CONTRACT\.md\)$/);
    expect(io.err[0]).toMatch(DEPRECATED);
    expect(reservedHit(io.err.join("\n"))).toBeNull();
    expect(io.code).toBeNull();
  });

  test("nothing resolves: one line naming the flag and the variable, the usage line, exit 2", () => {
    const { io, sink } = capture();
    const holds = (p: string) => fs.existsSync(path.join(p, "bin/lean.js"));
    expect(resolveToolPath({ ...base, flag: "artifact", env: "QED64_LEAN_ARTIFACT", value: null, legacy: path.join(tmp, "absent"), holds, needs: "bin/lean.js" }, sink)).toBeNull();
    expect(io.code).toBe(2);
    expect(io.err).toEqual([
      `bake-snapshot: no --artifact given and QED64_LEAN_ARTIFACT is unset; the deprecated default ${path.join(tmp, "absent")} has no bin/lean.js — pass --artifact <dir> or set QED64_LEAN_ARTIFACT`,
      "usage: bake-snapshot.mjs [--work <dir>]",
    ]);
    expect(io.err[0]).toMatch(NO_PATH);
    expect(reservedHit(io.err.join("\n"))).toBeNull();
    const none = capture();
    expect(resolveToolPath({ ...base, value: null, legacy: null }, none.sink)).toBeNull();
    expect(none.io.err[0]).toBe("bake-snapshot: no --work given and QED64_WORK is unset — pass --work <dir> or set QED64_WORK");
    expect(none.io.err[0]).toMatch(NO_PATH);
  });

  test("an output default (no `holds`) always resolves; an input default resolves only when it holds", () => {
    expect(toolPath({ env: "X", legacy: path.join(tmp, "not-yet-created"), environment: {} })?.source).toBe("default");
    expect(toolPath({ env: "X", legacy: path.join(tmp, "absent"), holds: fs.existsSync, environment: {} })).toBeNull();
    expect(toolPath({ env: "X", legacy: tmp, holds: fs.existsSync, environment: {} })).toEqual({ path: tmp, source: "default" });
  });
});

describe("the tools in a scratch checkout: nothing resolves → exit 2 + usage, before any side effect", () => {
  const cases: [string, string, string[]][] = [
    ["node-runner", "pipeline/snapshot/node-runner.mjs", ["--", "/work/x.lean"]],
    ["snapshot-probe", "pipeline/snapshot/snapshot-probe.mjs", ["--snap", "x.snap", "--probe", "#check 1"]],
    ["persistent-probe", "pipeline/snapshot/persistent-probe.mjs", []],
    ["bake-snapshot", "pipeline/snapshot/bake-snapshot.mjs", ["--name", "init"]],
    ["gate", "pipeline/toolchain/gate.mjs", []],
    ["resident-probe", "pipeline/snapshot/resident-probe.mjs", []],
  ];
  for (const [tool, rel, args] of cases) {
    test(`${tool}: no --artifact, QED64_LEAN_ARTIFACT unset, no deprecated default`, () => {
      const s = toolCheckout(tool);
      const before = tree(s);
      const r = run(s, rel, args);
      expect(r.signal).toBeNull();
      expect(r.status, r.stderr).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.lines).toHaveLength(2);
      expect(r.lines[0]).toMatch(NO_PATH);
      // gate's old default was the cwd; every other tool's, the checkout's own stage1
      expect(r.lines[0]).toContain(`${tool}: no --artifact given and QED64_LEAN_ARTIFACT is unset; the deprecated default ${tool === "gate" ? s : legacyStage1(s)} has no bin/lean.`);
      expect(r.lines[1]).toMatch(/^usage: /);
      if (SPECS[tool]) expect(r.lines[1]).toBe(`usage: ${SPECS[tool]!.synopsis}`);
      expect(tree(s)).toEqual(before);
    });
  }

  test("snapshot-probe: --lib, else QED64_LIB_TREE, else the deprecated work/lib-tree, else exit 2 (QED64_LEAN_ARTIFACT honoured first)", () => {
    const s = toolCheckout("snapshot-probe");
    const before = tree(s);
    const r = run(s, "pipeline/snapshot/snapshot-probe.mjs", ["--snap", "x.snap", "--probe", "#check 1"], { QED64_LEAN_ARTIFACT: path.join(s, "env-artifact") });
    expect(r.status).toBe(2);
    expect(r.lines).toEqual([
      `snapshot-probe: no --lib given and QED64_LIB_TREE is unset; the deprecated default ${path.join(s, "work/lib-tree")} is absent — pass --lib <tree> or set QED64_LIB_TREE`,
      `usage: ${SPECS["snapshot-probe"]!.synopsis}`,
    ]);
    expect(tree(s)).toEqual(before);
  });
});

test("each SPEC tool's usage literal for the rule's refusal is its synopsis", () => {
  for (const [tool, spec] of Object.entries(SPECS)) {
    const source = fs.readFileSync(path.join(root, spec.script), "utf8");
    if (!source.includes("resolveToolPath(")) continue;
    const literals = [...source.matchAll(/(?:const USAGE = |usage: )"([^"]+)"/g)].map((m) => m[1]);
    expect(literals.length, tool).toBeGreaterThan(0);
    for (const l of literals) expect(l, tool).toBe(spec.synopsis);
  }
});

describe("the tools in a scratch checkout: the variable is honoured", () => {
  test("node-runner, gate, resident-probe: QED64_LEAN_ARTIFACT reaches the tool's own artifact check (exit 2, no WARNING)", () => {
    for (const [tool, rel, line] of [
      ["node-runner", "pipeline/snapshot/node-runner.mjs", (a: string) => `error: ${a}/bin/lean.js not found — pass --artifact or set QED64_LEAN_ARTIFACT`],
      ["gate", "pipeline/toolchain/gate.mjs", (a: string) => `gate: ${a}/bin/lean.js not found`],
      ["resident-probe", "pipeline/snapshot/resident-probe.mjs", (a: string) => `error: ${a}/bin/lean.js not found`],
    ] as const) {
      const s = toolCheckout(tool);
      const before = tree(s);
      const env = path.join(s, "env-artifact");
      const r = run(s, rel, tool === "node-runner" ? ["--", "x.lean"] : [], { QED64_LEAN_ARTIFACT: env });
      expect([r.status, r.lines], tool).toEqual([2, [line(env)]]);
      expect(tree(s)).toEqual(before);
    }
  });

  test("bake-snapshot: QED64_LEAN_ARTIFACT and QED64_STAGING (<root>/<buildId>/snapshots) are honoured, before the runner", () => {
    const s = toolCheckout("bake-snapshot");
    const env = path.join(s, "env-artifact");
    const a = run(s, "pipeline/snapshot/bake-snapshot.mjs", [], { QED64_LEAN_ARTIFACT: env });
    expect([a.status, a.lines]).toEqual([2, [`bake-snapshot: no lean.wasm under ${env} — pass --artifact <stage1 dir>`]]);
    const art = fakeStage1(path.join(s, "art/stage1"), { wasm: true });
    const id = runtimeBuildId(fs.readFileSync(path.join(art, "bin/lean.wasm")));
    const staged = path.join(s, "stg", id, "snapshots");
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "index.json"), JSON.stringify({ schema: "qed64.snapshot-index/v1", snapshots: [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: "wasm64-0000000000000000" }] }));
    const before = tree(s);
    const b = run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--artifact", art], { QED64_STAGING: path.join(s, "stg") });
    expect(b.status).toBe(2);
    expect(b.lines).toEqual([`bake-snapshot: ${path.join(staged, "index.json")} already holds entries for runtime wasm64-0000000000000000 (mathlib) — refusing to mix pairings`]);
    expect(tree(s)).toEqual(before);
  });

  test("snapshot-probe: QED64_LEAN_ARTIFACT and QED64_LIB_TREE resolve silently; a missing --snap then fails the link (exit 1) and the scratch dir is still removed", () => {
    const s = toolCheckout("snapshot-probe");
    const r = run(s, "pipeline/snapshot/snapshot-probe.mjs", ["--snap", path.join(s, "missing.snap"), "--probe", "#check 1"],
      { QED64_LEAN_ARTIFACT: path.join(s, "env-artifact"), QED64_LIB_TREE: path.join(s, "env-lib") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing.snap");
    expect(r.stderr).not.toMatch(/WARNING|no --\S+ given/);
    expect(fs.readdirSync(path.join(s, "tmp"))).toEqual([]);
  });

  test("persistent-probe: QED64_LEAN_ARTIFACT is the artifact it reads (an unreadable one is the documented exit 1, no WARNING)", () => {
    const s = toolCheckout("persistent-probe");
    const env = path.join(s, "env-artifact");
    const r = run(s, "pipeline/snapshot/persistent-probe.mjs", [], { QED64_LEAN_ARTIFACT: env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(path.join(env, "bin/lean.js"));
    expect(r.stderr).not.toMatch(/WARNING|no --\S+ given/);
  });

  test("chunk-runtime: QED64_STAGING puts the runtime under <root>/<buildId>/runtime (no path WARNING), handed to the package's chunker", () => {
    const s = toolCheckout("chunk-runtime");
    const bin = path.join(fakeStage1(path.join(s, "art/stage1"), { wasm: true }), "bin");
    const r = run(s, "pipeline/toolchain/chunk-runtime.mjs", ["--bin", bin, "--revision", "test", "--lean-version", "9.9.9"], { QED64_STAGING: path.join(s, "stg"), LEAN4_WASM64_DIR: fakeChunker(s) });
    expect(r.status, r.stderr).toBe(7);
    expect(r.lines).toEqual([CHUNK_FORWARD]);
    const id = runtimeBuildId(fs.readFileSync(path.join(bin, "lean.wasm")));
    expect(JSON.parse(r.stdout)).toEqual(["--bin", bin, "--out", path.join(s, "stg", id, "runtime"), "--lean-version", "9.9.9", "--revision", "test"]);
    expect(fs.existsSync(path.join(s, "work"))).toBe(false);
  });

  test("compiler-battery: flag, then QED64_MATHLIB_SNAP / QED64_LEAN_ARTIFACT / QED64_LIB_TREE, then the deprecated defaults, else exit 2", () => {
    const s = checkout([]);
    const io = { err: [] as string[], code: null as number | null };
    const sink = (environment: Record<string, string | undefined>) => ({ err: (x: string) => io.err.push(x), exit: (c: number) => { io.code = c; }, environment });
    const noFlags = () => null;
    expect(batteryInputs(noFlags, s, sink({}))).toBeNull();
    expect(io.code).toBe(2);
    expect(io.err).toEqual([
      `compiler-battery: no --snap given and QED64_MATHLIB_SNAP is unset; the deprecated default ${path.join(s, "work/snapshot/mathlib.snap")} is absent — pass --snap <file> or set QED64_MATHLIB_SNAP`,
      `usage: compiler-battery.mjs [--corpus <file>] [--jobs 3] [--run-dir <dir>] [--snap <mathlib.snap>] [--artifact <stage1>] [--lib <tree>]`,
    ]);
    io.err.length = 0; io.code = null;
    const env = { QED64_MATHLIB_SNAP: "/e/m.snap", QED64_LEAN_ARTIFACT: "/e/stage1", QED64_LIB_TREE: "/e/slim" };
    expect(batteryInputs(noFlags, s, sink(env))).toEqual({ snap: "/e/m.snap", artifact: "/e/stage1", lib: "/e/slim" });
    expect(batteryInputs((f) => (f === "lib" ? "/flag/lib" : null), s, sink(env))).toEqual({ snap: "/e/m.snap", artifact: "/e/stage1", lib: "/flag/lib" });
    expect([io.err, io.code]).toEqual([[], null]);
    fs.mkdirSync(path.join(s, "work/snapshot"), { recursive: true });
    fs.writeFileSync(path.join(s, "work/snapshot/mathlib.snap"), "raw");
    fakeStage1(legacyStage1(s), { wasm: true });
    fs.mkdirSync(path.join(s, "work/lib-tree-slim"));
    expect(batteryInputs(noFlags, s, sink({}))).toEqual({ snap: path.join(s, "work/snapshot/mathlib.snap"), artifact: legacyStage1(s), lib: path.join(s, "work/lib-tree-slim") });
    expect(io.err).toHaveLength(3);
    for (const line of io.err) expect(line).toMatch(DEPRECATED);
  });
});

describe("the tools in a scratch checkout: a deprecated default prints exactly one WARNING and still resolves", () => {
  test("node-runner: the default stage1 (it has bin/lean.js) is used, then its missing lib/lean refuses (exit 2), nothing created", () => {
    const s = toolCheckout("node-runner");
    const legacy = fakeStage1(legacyStage1(s));
    const before = tree(s);
    const r = run(s, "pipeline/snapshot/node-runner.mjs", ["--", "x.lean"]);
    expect(r.status).toBe(2);
    expect(r.lines).toEqual([
      `node-runner: WARNING — the default --artifact pipeline/toolchain/work/build/stage1 under the repo root (${legacy}) is deprecated; use --artifact <dir> or set QED64_LEAN_ARTIFACT (docs/CLI-CONTRACT.md)`,
      `error: ${legacy}/lib/lean not found`,
    ]);
    expect(tree(s)).toEqual(before);
  });

  test("snapshot-probe: the default stage1 and work/lib-tree, one WARNING each, then the missing --snap (exit 1)", () => {
    const s = toolCheckout("snapshot-probe");
    const legacy = fakeStage1(legacyStage1(s));
    fs.mkdirSync(path.join(s, "work/lib-tree"), { recursive: true });
    const r = run(s, "pipeline/snapshot/snapshot-probe.mjs", ["--snap", path.join(s, "missing.snap"), "--probe", "#check 1"]);
    expect(r.status).toBe(1);
    const warnings = r.lines.filter((l) => l.includes("WARNING"));
    expect(warnings).toEqual([
      `snapshot-probe: WARNING — the default --artifact pipeline/toolchain/work/build/stage1 under the repo root (${legacy}) is deprecated; use --artifact <dir> or set QED64_LEAN_ARTIFACT (docs/CLI-CONTRACT.md)`,
      `snapshot-probe: WARNING — the default --lib work/lib-tree under the repo root (${path.join(s, "work/lib-tree")}) is deprecated; use --lib <tree> or set QED64_LIB_TREE (docs/CLI-CONTRACT.md)`,
    ]);
    expect(fs.readdirSync(path.join(s, "tmp"))).toEqual([]);
  });

  test("persistent-probe: the default stage1 is used (one WARNING); its unreadable bin/lean.js is the documented exit 1", () => {
    const s = toolCheckout("persistent-probe");
    const legacy = fakeStage1(legacyStage1(s), { jsIsDir: true });
    const r = run(s, "pipeline/snapshot/persistent-probe.mjs", []);
    expect(r.status).toBe(1);
    expect(r.lines.filter((l) => l.includes("WARNING"))).toEqual([
      `persistent-probe: WARNING — the default --artifact pipeline/toolchain/work/build/stage1 under the repo root (${legacy}) is deprecated; use --artifact <dir> or set QED64_LEAN_ARTIFACT (docs/CLI-CONTRACT.md)`,
    ]);
    expect(r.stderr).toContain("EISDIR");
  });

  test("bake-snapshot: the default stage1 and the default --out, one WARNING each, then the foreign index refuses (exit 2) before the runner", () => {
    const s = toolCheckout("bake-snapshot");
    const legacy = fakeStage1(legacyStage1(s), { js: false, wasm: true });
    const id = runtimeBuildId(fs.readFileSync(path.join(legacy, "bin/lean.wasm")));
    const out = path.join(s, "work/staging", id, "snapshots");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ schema: "qed64.snapshot-index/v1", snapshots: [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: "wasm64-0000000000000000" }] }));
    const before = tree(s);
    const r = run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--name", "init"]);
    expect(r.status).toBe(2);
    expect(r.lines).toEqual([
      `bake-snapshot: WARNING — the default --artifact pipeline/toolchain/work/build/stage1 under the repo root (${legacy}) is deprecated; use --artifact <dir> or set QED64_LEAN_ARTIFACT (docs/CLI-CONTRACT.md)`,
      `bake-snapshot: WARNING — the default --out work/staging/<buildId>/snapshots under the repo root (${out}) is deprecated; use --out <dir> or set QED64_STAGING (docs/CLI-CONTRACT.md)`,
      `bake-snapshot: ${path.join(out, "index.json")} already holds entries for runtime wasm64-0000000000000000 (mathlib) — refusing to mix pairings`,
    ]);
    expect(tree(s)).toEqual(before);
  });

  test("chunk-runtime: the default --out (one WARNING) is still the checkout's work/staging/<buildId>/runtime, forwarded absolute", () => {
    const s = toolCheckout("chunk-runtime");
    const bin = path.join(fakeStage1(path.join(s, "art/stage1"), { wasm: true }), "bin");
    const r = run(s, "pipeline/toolchain/chunk-runtime.mjs", ["--bin", bin, "--revision", "test", "--lean-version", "9.9.9"], { LEAN4_WASM64_DIR: fakeChunker(s) });
    expect(r.status, r.stderr).toBe(7);
    const id = runtimeBuildId(fs.readFileSync(path.join(bin, "lean.wasm")));
    const out = path.join(s, "work/staging", id, "runtime");
    expect(r.lines).toEqual([`chunk-runtime: WARNING — the default --out work/staging/<buildId>/runtime under the repo root (${out}) is deprecated; use --out <dir> or set QED64_STAGING (docs/CLI-CONTRACT.md)`, CHUNK_FORWARD]);
    expect(r.lines[0]).toMatch(marker("chunk-runtime", "deprecated-default"));
    expect(r.lines[1]).toMatch(marker("chunk-runtime", "deprecated"));
    expect(JSON.parse(r.stdout)).toEqual(["--bin", bin, "--out", out, "--lean-version", "9.9.9", "--revision", "test"]);
    // without the package: the same front half, then exit 2 with one line
    const absent = run(s, "pipeline/toolchain/chunk-runtime.mjs", ["--bin", bin, "--revision", "test", "--lean-version", "9.9.9", "--out", path.join(s, "o")]);
    expect([absent.status, absent.stdout, absent.lines.length]).toEqual([2, "", 2]);
    expect(absent.lines[1]).toMatch(marker("chunk-runtime", "no-package"));
    expect(reservedHit(absent.stderr)).toBeNull();
    expect(fs.existsSync(path.join(s, "work"))).toBe(false);
    expect(fs.existsSync(path.join(s, "o"))).toBe(false);
  });
});

describe("gate and resident-probe: the deprecated defaults and QED64_SNAP_DIR", () => {
  // gate's deprecated default is the cwd; resolving it IS passing gate's own lean.js check, so the
  // next step is the forward to lean4-wasm64's gate: here a FAKE package whose gate.mjs records its
  // argv, prints the package gate's verdict line and exits 1.
  const FAKE_GATE = `console.log(" ok   numBits=64 (fake)");
console.log(JSON.stringify(process.argv.slice(2)));
console.log("\\nGATE FAILED (1)");
process.exit(1);
`;
  test("gate run from a stage1 dir: one path WARNING naming the current directory, one forward WARNING, then the package's gate gets --artifact <that dir>", () => {
    const s = checkout([...TOOLS.gate!, "pipeline/toolchain/artifact-paths.mjs"]);
    const pkg = path.join(s, "fake-lean4-wasm64");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "lean4-wasm64" }));
    fs.writeFileSync(path.join(pkg, "gate.mjs"), FAKE_GATE);
    const stage = fakeStage1(path.join(s, "stage1"));
    const r = run(s, "pipeline/toolchain/gate.mjs", [], { LEAN4_WASM64_DIR: pkg }, stage);
    expect(r.status, r.stderr).toBe(1);
    expect(r.lines).toEqual([
      `gate: WARNING — the default --artifact the current directory (${stage}) is deprecated; use --artifact <dir> or set QED64_LEAN_ARTIFACT (docs/CLI-CONTRACT.md)`,
      "gate: WARNING — pipeline/toolchain/gate.mjs is deprecated; use lean4-wasm64 gate --artifact <dir> (the fork's package) (docs/CLI-CONTRACT.md)",
    ]);
    expect(r.lines[0]).toMatch(DEPRECATED);
    const out = r.stdout.trimEnd().split("\n");
    expect(out.at(-1)).toMatch(/^GATE FAILED \(\d+\)$/);
    expect(JSON.parse(out[1]!)).toEqual(["--artifact", stage]);
  });

  // resident-probe resolves --snap-dir after its lean.js check; a bin/lean.js that is a directory
  // then stops it at the read (EISDIR, exit 1) before anything is evaluated.
  const residentStage = (s: string) => fakeStage1(path.join(s, "art/stage1"), { jsIsDir: true });
  test("resident-probe: QED64_SNAP_DIR is honoured (silent), then the unreadable lean.js stops it", () => {
    const s = toolCheckout("resident-probe");
    const r = run(s, "pipeline/snapshot/resident-probe.mjs", ["--artifact", residentStage(s)], { QED64_SNAP_DIR: path.join(s, "env-snaps") });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("EISDIR");
    expect(r.stderr).not.toMatch(/WARNING|no --\S+ given/);
  });
  test("resident-probe: the checkout's work/snapshot is the deprecated --snap-dir (exactly one WARNING)", () => {
    const s = toolCheckout("resident-probe");
    fs.mkdirSync(path.join(s, "work/snapshot"), { recursive: true });
    const r = run(s, "pipeline/snapshot/resident-probe.mjs", ["--artifact", residentStage(s)]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.lines.filter((l) => l.includes("WARNING"))).toEqual([
      `resident-probe: WARNING — the default --snap-dir work/snapshot under the repo root (${path.join(s, "work/snapshot")}) is deprecated; use --snap-dir <dir> or set QED64_SNAP_DIR (docs/CLI-CONTRACT.md)`,
    ]);
    expect(r.stderr).toContain("EISDIR");
  });
  test("resident-probe: no --snap-dir, QED64_SNAP_DIR unset, no work/snapshot: exit 2 naming the variable, nothing created", () => {
    const s = toolCheckout("resident-probe");
    const art = residentStage(s);
    const before = tree(s);
    const r = run(s, "pipeline/snapshot/resident-probe.mjs", ["--artifact", art]);
    expect(r.status, r.stderr).toBe(2);
    expect(r.lines).toEqual([
      `resident-probe: no --snap-dir given and QED64_SNAP_DIR is unset; the deprecated default ${path.join(s, "work/snapshot")} is absent — pass --snap-dir <dir> or set QED64_SNAP_DIR`,
      "usage: resident-probe.mjs [--artifact <stage1>] [--lib <tree>] [--budget-ms 180000] [--snap-dir <dir>] [--snapshots init,mathlib] [--mathlib] [--act2 | --act4 [--act4-ms 500]]",
    ]);
    expect(r.lines[0]).toMatch(NO_PATH);
    expect(tree(s)).toEqual(before);
  });
});

describe("compiler-battery's CLI refusal leaves a record (no stale or missing report)", () => {
  const BATTERY = ["tests/adversarial/compiler-battery.mjs", "tests/adversarial/harness.mjs", "pipeline/release/page-target.mjs", "pipeline/toolchain/artifact-paths.mjs"];
  function batteryCheckout() {
    const s = checkout(BATTERY);
    const corpus = path.join(s, "corpus.json");
    fs.writeFileSync(corpus, JSON.stringify({ items: ["one", "two"].map((name) => ({ name, category: "c", source: "#check 1", expect: {} })) }));
    // A previous run's report, which a refusal must replace, never leave standing.
    fs.mkdirSync(path.join(s, "work/adversarial"), { recursive: true });
    fs.writeFileSync(path.join(s, "work/adversarial/compiler-report.json"), JSON.stringify({ lane: "compiler", total: 120, failed: 2, infra: 0, results: [] }));
    return { s, corpus, runDir: path.join(s, "runs/r1") };
  }
  const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

  test("nothing resolves: exit 2, the no-path line in compiler.log, a fresh all-infra report in work/adversarial/ and the run dir, nothing spawned", () => {
    const { s, corpus, runDir } = batteryCheckout();
    const r = run(s, "tests/adversarial/compiler-battery.mjs", ["--corpus", corpus, "--run-dir", runDir]);
    expect(r.status, r.stderr).toBe(2);
    const why = `compiler-battery: no --snap given and QED64_MATHLIB_SNAP is unset; the deprecated default ${path.join(s, "work/snapshot/mathlib.snap")} is absent — pass --snap <file> or set QED64_MATHLIB_SNAP`;
    const usage = "usage: compiler-battery.mjs [--corpus <file>] [--jobs 3] [--run-dir <dir>] [--snap <mathlib.snap>] [--artifact <stage1>] [--lib <tree>]";
    expect(r.lines).toEqual([why, usage, `compiler battery: REFUSED — ${why}`]);
    expect(r.lines[0]).toMatch(NO_PATH);
    expect(fs.readFileSync(path.join(runDir, "compiler.log"), "utf8").split("\n").filter(Boolean)).toEqual(r.lines);
    const report = readJson(path.join(s, "work/adversarial/compiler-report.json"));
    expect(readJson(path.join(runDir, "compiler-report.json"))).toEqual(report);
    expect(report).toEqual({ lane: "compiler", total: 2, failed: 2, infra: 2, refused: why,
      results: ["one", "two"].map((name) => ({ name, category: "c", wallMs: 0, outcome: "infra", pass: false, failures: [`infra: ${why}`] })) });
    // no probe scratch dir (work/adv-*) was made
    expect(fs.readdirSync(path.join(s, "work"))).toEqual(["adversarial"]);
  });

  test("the snapshot resolves by its variable but no runtime does: the refusal names --artifact / QED64_LEAN_ARTIFACT", () => {
    const { s, corpus, runDir } = batteryCheckout();
    const r = run(s, "tests/adversarial/compiler-battery.mjs", ["--corpus", corpus, "--run-dir", runDir], { QED64_MATHLIB_SNAP: path.join(s, "m.snap") });
    expect(r.status, r.stderr).toBe(2);
    const report = readJson(path.join(runDir, "compiler-report.json"));
    expect(report.refused).toBe(`compiler-battery: no --artifact given and QED64_LEAN_ARTIFACT is unset; the deprecated default ${legacyStage1(s)} is absent — pass --artifact <dir> or set QED64_LEAN_ARTIFACT`);
    expect([report.total, report.infra]).toEqual([2, 2]);
  });
});

describe("bake-snapshot end to end with a FAKE runner (no wasm): --work's rule and --allow-legacy-imports", () => {
  // The fake stands where node-runner.mjs is: it records how it was started and writes the raw .snap.
  const FAKE_RUNNER = `import fs from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const work = a[a.indexOf("--work") + 1];
const save = a.find((x) => x.startsWith("--incr-header-save=")).split("=")[1].replace(/^\\/work\\//, "");
fs.writeFileSync(path.join(work, save), "a raw region");
fs.writeFileSync(path.join(work, "runner.json"), JSON.stringify({ argv: a, execArgv: process.execArgv, execPath: process.execPath, allow: process.env.QED64_ALLOW_LEGACY_IMPORTS ?? null }));
`;
  function bakeCheckout() {
    const s = toolCheckout("bake-snapshot");
    fs.writeFileSync(path.join(s, "pipeline/snapshot/node-runner.mjs"), FAKE_RUNNER);
    const art = fakeStage1(path.join(s, "art/stage1"), { wasm: true });
    return { s, art };
  }
  const recorded = (work: string) => JSON.parse(fs.readFileSync(path.join(work, "runner.json"), "utf8")) as { argv: string[]; execArgv: string[]; execPath: string; allow: string | null };

  test("the default --work: one WARNING, the bake completes there; the runner starts with --stack-size=8192 and no legacy-imports gate", () => {
    const { s, art } = bakeCheckout();
    const r = run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--artifact", art, "--out", path.join(s, "out")]);
    expect(r.status, r.stderr).toBe(0);
    const work = path.join(s, "work/snapshot");
    expect(r.lines).toEqual([`bake-snapshot: WARNING — the default --work work/snapshot under the repo root (${work}) is deprecated; use --work <dir> or set QED64_WORK (docs/CLI-CONTRACT.md)`]);
    expect(r.stdout.split("\n").filter((l) => marker("bake-snapshot", "baked").test(l))).toHaveLength(1);
    const rec = recorded(work);
    expect(rec.execArgv).toEqual(["--stack-size=8192"]);
    expect(rec.argv.slice(0, 4)).toEqual(["--work", work, "--artifact", art]);
    expect(rec.allow).toBeNull();
    expect(fs.existsSync(path.join(work, "init.snap"))).toBe(true);
  });

  test("QED64_WORK is honoured (no WARNING); --allow-legacy-imports and an inherited QED64_ALLOW_LEGACY_IMPORTS both reach the runner as 1", () => {
    const { s, art } = bakeCheckout();
    const w1 = path.join(s, "w1");
    const a = run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--artifact", art, "--out", path.join(s, "out1"), "--allow-legacy-imports"], { QED64_WORK: w1 });
    expect(a.status, a.stderr).toBe(0);
    expect(a.stderr).toBe("");
    expect(recorded(w1).allow).toBe("1");
    const w2 = path.join(s, "w2");
    const b = run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--artifact", art, "--out", path.join(s, "out2"), "--work", w2], { QED64_ALLOW_LEGACY_IMPORTS: "1" });
    expect(b.status, b.stderr).toBe(0);
    expect(b.stderr).toBe("");
    expect(recorded(w2).allow).toBe("1");
    expect(fs.existsSync(path.join(s, "work"))).toBe(false);
  });

  test("--runner <script>, else QED64_RUNNER, else the checkout's own node-runner (no WARNING); a missing one refuses before any side effect", () => {
    const { s, art } = bakeCheckout();
    const other = path.join(s, "other-runner.mjs");
    fs.writeFileSync(other, FAKE_RUNNER.replace('"runner.json"', '"other.json"'));
    const w1 = path.join(s, "w1");
    const a = run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--artifact", art, "--out", path.join(s, "out1"), "--work", w1, "--runner", "other-runner.mjs"]);
    expect([a.status, a.stderr]).toEqual([0, ""]);
    expect(fs.existsSync(path.join(w1, "other.json"))).toBe(true);
    expect(fs.existsSync(path.join(w1, "runner.json"))).toBe(false);
    const w2 = path.join(s, "w2");
    const b = run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--artifact", art, "--out", path.join(s, "out2"), "--work", w2], { QED64_RUNNER: other });
    expect([b.status, b.stderr]).toEqual([0, ""]);
    expect(JSON.parse(fs.readFileSync(path.join(w2, "other.json"), "utf8")).execArgv).toEqual(["--stack-size=8192"]);
    // The runner is spawned with the bake's own Node, not PATH's: with a PATH whose `node` exits 99
    // (and nothing else on it), the bake still completes and the runner ran under process.execPath.
    const fakeBin = path.join(s, "fake-bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "node"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const w4 = path.join(s, "w4");
    const d = run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--artifact", art, "--out", path.join(s, "out4"), "--work", w4], { PATH: fakeBin });
    expect([d.status, d.stderr]).toEqual([0, ""]);
    expect(recorded(w4).execPath).toBe(process.execPath);
    expect(recorded(w4).execArgv).toEqual(["--stack-size=8192"]);
    const w3 = path.join(s, "w3");
    fs.mkdirSync(w3);
    fs.writeFileSync(path.join(w3, "init.snap"), "the paired raw snapshot");
    const before = tree(s);
    const missing = path.join(s, "no-such-runner.mjs");
    const c = run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--artifact", art, "--out", path.join(s, "out3"), "--work", w3, "--runner", missing]);
    expect(c.status).toBe(2);
    expect(c.lines).toEqual([`bake-snapshot: no runner script ${missing} — pass --runner <script> or set QED64_RUNNER`]);
    expect(c.lines[0]).toMatch(marker("bake-snapshot", "no-runner"));
    expect(tree(s)).toEqual(before);
  });
});

describe("bake-snapshot writes the index's per-build copy (HARDENING #64) with a FAKE runner", () => {
  const FAKE_RUNNER = `import fs from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const work = a[a.indexOf("--work") + 1];
const save = a.find((x) => x.startsWith("--incr-header-save=")).split("=")[1].replace(/^\\/work\\//, "");
if (!process.env.FAKE_NO_SNAP) fs.writeFileSync(path.join(work, save), "a raw region " + save);
`;
  const OTHER = "wasm64-0000000000000000";
  function bakeCheckout() {
    const s = toolCheckout("bake-snapshot");
    fs.writeFileSync(path.join(s, "pipeline/snapshot/node-runner.mjs"), FAKE_RUNNER);
    const art = fakeStage1(path.join(s, "art/stage1"), { wasm: true });
    const id = runtimeBuildId(fs.readFileSync(path.join(art, "bin/lean.wasm")));
    return { s, art, id, out: path.join(s, "out") };
  }
  const bake = (s: string, art: string, out: string, name: string, env: Record<string, string> = {}) =>
    run(s, "pipeline/snapshot/bake-snapshot.mjs", ["--artifact", art, "--out", out, "--work", path.join(s, "w"), "--name", name], env);
  /** --out's files other than the .snapz: no lock, temp or stray file is left. */
  const indexFiles = (out: string) => fs.readdirSync(out).filter((f) => !f.endsWith(".snapz")).sort();

  test("copy bytes == index bytes, after a first bake and after a sibling's; one index-copy line each; another runtime's copy untouched", () => {
    const { s, art, id, out } = bakeCheckout();
    fs.mkdirSync(out);
    const otherCopy = path.join(out, `index.${OTHER}.json`);
    fs.writeFileSync(otherCopy, "another runtime's copy: never touched");
    const a = bake(s, art, out, "init");
    expect([a.status, a.stderr]).toEqual([0, ""]);
    const copy = path.join(out, `index.${id}.json`);
    const copyLines = a.stdout.split("\n").filter((l) => marker("bake-snapshot", "index-copy").test(l));
    expect(copyLines).toEqual([`index copy ${copy} written (runtime ${id})`]);
    expect(marker("bake-snapshot", "index-copy").exec(copyLines[0]!)?.slice(2)).toEqual([id, id]);
    expect(fs.readFileSync(copy)).toEqual(fs.readFileSync(path.join(out, "index.json")));
    const b = bake(s, art, out, "mathlib");
    expect([b.status, b.stderr]).toEqual([0, ""]);
    const index = fs.readFileSync(path.join(out, "index.json"));
    expect(fs.readFileSync(copy)).toEqual(index);
    expect(JSON.parse(index.toString()).snapshots.map((e: { name: string; runtime: string }) => [e.name, e.runtime])).toEqual([["init", id], ["mathlib", id]]);
    expect(fs.readFileSync(otherCopy, "utf8")).toBe("another runtime's copy: never touched");
    expect(indexFiles(out)).toEqual([`index.${OTHER}.json`, `index.${id}.json`, "index.json"].sort());
  });

  test("a refused bake (a foreign index) and a failed one (no .snap, exit 1) write neither file", () => {
    const { s, art, id, out } = bakeCheckout();
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ schema: "qed64.snapshot-index/v1", snapshots: [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: OTHER }] }));
    let before = tree(s);
    const refused = bake(s, art, out, "init");
    expect(refused.status).toBe(2);
    expect(refused.lines[0]).toMatch(marker("bake-snapshot", "refuse-foreign"));
    expect(tree(s)).toEqual(before);
    const out2 = path.join(s, "out2");
    fs.mkdirSync(out2);
    fs.mkdirSync(path.join(s, "w"), { recursive: true });
    fs.writeFileSync(path.join(s, "w/probe.lean"), "#check (2 + 2 : Nat)\n"); // what the bake writes, so the tree compares
    before = tree(s);
    const failed = bake(s, art, out2, "init", { FAKE_NO_SNAP: "1" });
    expect(failed.status).toBe(1);
    expect(failed.lines).toContain("FAIL: snapshot file was not produced");
    expect(tree(s)).toEqual(before);
    expect(fs.existsSync(path.join(out2, `index.${id}.json`))).toBe(false);
  });

  test("the upsert waits for the index's lock (another bake's) and takes over a stale one", async () => {
    const { s, art, id, out } = bakeCheckout();
    fs.mkdirSync(out);
    const lock = path.join(out, "index.json.lock");
    fs.writeFileSync(lock, "99999999\n"); // fresh: a sibling bake mid-upsert
    const child = spawn(process.execPath, [path.join(s, "pipeline/snapshot/bake-snapshot.mjs"), "--artifact", art, "--out", out, "--work", path.join(s, "w"), "--name", "init"], {
      cwd: s, stdio: ["ignore", "pipe", "pipe"], env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !RULE_ENV.includes(k))), TMPDIR: path.join(s, "tmp") },
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      // the .snapz is renamed into place just before the upsert: from then on the bake is at the lock
      for (let t = 0; t < 200 && !fs.readdirSync(out).some((f) => f.endsWith(".snapz")); t += 1) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 400));
      expect(fs.existsSync(path.join(out, "index.json"))).toBe(false);
      expect(fs.existsSync(path.join(out, `index.${id}.json`))).toBe(false);
      fs.rmSync(lock); // the sibling releases it
      expect(await exited).toBe(0);
    } finally {
      clearTimeout(killer);
      child.kill("SIGKILL");
    }
    expect(stdout).toContain(`index copy ${path.join(out, `index.${id}.json`)} written`);
    expect(fs.readFileSync(path.join(out, `index.${id}.json`))).toEqual(fs.readFileSync(path.join(out, "index.json")));
    // a lock older than LOCK_STALE_MS (30 s) is a crashed holder's: taken over, then released
    fs.writeFileSync(lock, "99999999\n");
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lock, old, old);
    const r = bake(s, art, out, "mathlib");
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(fs.readFileSync(path.join(out, `index.${id}.json`))).toEqual(fs.readFileSync(path.join(out, "index.json")));
    expect(JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8")).snapshots.map((e: { name: string }) => e.name)).toEqual(["init", "mathlib"]);
    expect(indexFiles(out)).toEqual([`index.${id}.json`, "index.json"].sort());
  });
});

describe("ensureStackSize: the re-exec keeps the PID, the stdio and the exit code", () => {
  /** A scratch tool that calls ensureStackSize first, reports itself, then exits 7 or (--hang) stays alive. */
  function scratchTool(): string {
    const f = path.join(fs.mkdtempSync(path.join(tmp, "stack-")), "tool.mjs");
    fs.writeFileSync(f, `import fs from "node:fs";
import { ensureStackSize } from ${JSON.stringify(pathToFileURL(pathsModule).href)};
const r = ensureStackSize("scratch-tool");
const self = { pid: process.pid, execArgv: process.execArgv, argv: process.argv.slice(2), r };
const at = process.argv.indexOf("--record");
if (at > 0) fs.writeFileSync(process.argv[at + 1], JSON.stringify(self));
const target = process.argv.indexOf("--target");
if (target > 0) fs.writeFileSync(process.argv[target + 1], "the job's output");
process.stdout.write(JSON.stringify(self) + "\\n");
process.stderr.write("to stderr\\n");
// --hang: alive until killed, but never longer than 25 s, whatever the test did.
if (process.argv.includes("--hang")) { setInterval(() => {}, 1000); setTimeout(() => process.exit(9), 25_000); } else process.exit(7);
`);
    return f;
  }
  const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } };

  test("started without --stack-size: replaced in place (same PID) with --stack-size=8192; stdout, stderr and the exit code are the tool's", () => {
    const tool = scratchTool();
    const r = spawnSync(process.execPath, [tool, "a", "--b"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(r.status).toBe(7);
    const self = JSON.parse(r.stdout);
    expect(self).toEqual({ pid: r.pid, execArgv: ["--stack-size=8192"], argv: ["a", "--b"], r: "present" });
    expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.stderr).toBe("to stderr\n");
  });

  test("an explicit --stack-size of any size is respected (no re-exec)", () => {
    const tool = scratchTool();
    const r = spawnSync(process.execPath, ["--stack-size=2000", tool], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(r.status).toBe(7);
    expect(JSON.parse(r.stdout)).toEqual({ pid: r.pid, execArgv: ["--stack-size=2000"], argv: [], r: "present" });
    expect(ensureStackSize("vitest-worker", 8192, { ...process, execArgv: ["--stack_size=50"] } as NodeJS.Process)).toBe("present");
  });

  test("a SIGKILL of the PID the parent spawned kills the re-exec'd tool: nothing is orphaned (gate's timeout, bake-snapshot's reap)", async () => {
    const tool = scratchTool();
    const child = spawn(process.execPath, [tool, "--hang"], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_c, sig) => resolve(sig)));
    let timer: NodeJS.Timeout | undefined;
    try {
      const line = await Promise.race([
        new Promise<string>((resolve) => { let b = ""; child.stdout.on("data", (d) => { b += d; if (b.includes("\n")) resolve(b); }); }),
        new Promise<string>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("no first line from the --hang tool in 10 s")); }, 10_000); }),
      ]);
      const self = JSON.parse(line);
      expect([self.pid, self.execArgv]).toEqual([child.pid, ["--stack-size=8192"]]);
      child.kill("SIGKILL");
      expect(await exited).toBe("SIGKILL");
      expect(dead(self.pid)).toBe(true);
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL"); // harmless when it is already dead
    }
    // spawnSync's timeout path, as a supervisor that runs node-runner without the flag times it out
    const record = path.join(path.dirname(tool), "sync.json");
    const r = spawnSync(process.execPath, [tool, "--hang", "--record", record], { timeout: 3000, killSignal: "SIGKILL", encoding: "utf8" });
    expect(r.signal).toBe("SIGKILL");
    const synced = JSON.parse(fs.readFileSync(record, "utf8"));
    expect([synced.pid, synced.execArgv]).toEqual([r.pid, ["--stack-size=8192"]]);
    expect(dead(synced.pid)).toBe(true);
  });

  test("under supervised-run (which starts its runner with --stack-size=8192): no re-exec, the verdict line, exit 0, the runner reaped", () => {
    const tool = scratchTool();
    const dir = path.dirname(tool);
    const record = path.join(dir, "runner.json");
    const target = path.join(dir, "out.olean");
    const r = spawnSync(process.execPath, [path.join(root, "pipeline/snapshot/supervised-run.mjs"), "--target", target, "--quiet-ms", "300", "--stable-ms", "300", "--give-up-ms", "20000",
      "--runner", tool, "--", "--hang", "--record", record, "--target", target], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.at(-1)).toMatch(marker("supervised-run", "verdict"));
    expect(lines.at(-1)).toMatch(marker("supervised-run", "done-reaped"));
    const runner = JSON.parse(fs.readFileSync(record, "utf8"));
    expect(runner.execArgv).toEqual(["--stack-size=8192"]);
    expect(dead(runner.pid)).toBe(true);
  });
});

describe("no tracked file points at another project's checkout", () => {
  test("the sibling codex checkout is named only by the two provenance notes, never as a path a tool could resolve", () => {
    const needle = ["wasm64", "lean", "codex"].join("-");
    let hits: string[] = [];
    try { hits = execFileSync("git", ["grep", "-l", "-F", needle], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean); } catch { hits = []; }
    // docs/history/UPSTREAM-NOTES.md: the provenance record; lean.worker.js: its Apache-2.0 attribution comment.
    expect(hits.sort()).toEqual(["docs/history/UPSTREAM-NOTES.md", "public/workers/lean.worker.js"]);
    for (const f of hits) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      expect(text, f).not.toMatch(new RegExp(`\\.\\./${needle}|${needle}/experiments`));
    }
    expect(fs.readFileSync(path.join(root, "public/workers/lean.worker.js"), "utf8").split(needle)).toHaveLength(2);
  });
});
