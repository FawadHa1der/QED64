// The pipeline CLI contract (docs/CLI-CONTRACT.md, pipeline/snapshot/cli.mjs),
// pinned against the REAL scripts run as child processes.
//
// Safety: before this contract, `bake-snapshot --help` unlinked
// <work>/<name>.snap and started a ~20 min, 11 GB bake, and `node-runner
// --help` booted wasm and never exited. Every child here therefore runs with
// a SIGKILL timeout, with QED64_LEAN_ARTIFACT and --artifact naming a path
// that does not exist (no runtime can boot), with every path flag pointing
// into a temp tree, and only with --help or a deliberately invalid usage —
// except chunk-runtime, which is run for real against a fake bin (as
// artifact-discipline.test.ts does) to prove --flag=value reaches it.
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SPECS, ENV, RESERVED_OUTPUT, compactSpec, cliContract, formatHelp, parseCli, reservedHit,
  PRELUDE_BEGIN, PRELUDE_END, type CliIo,
} from "../../pipeline/snapshot/cli.mjs";

const root = path.resolve(__dirname, "../..");
const cliScript = path.join(root, "pipeline/snapshot/cli.mjs");
const TOOLS = Object.keys(SPECS);

let tmp: string;
let missing: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-cli-contract-"));
  missing = path.join(tmp, "no-such-artifact");
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Run a script in `cwd` with no runtime reachable, killed after 30 s. */
function run(script: string, args: string[], cwd: string) {
  const r = spawnSync("node", [path.join(root, script), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    env: { ...process.env, QED64_LEAN_ARTIFACT: missing },
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Every path under `dir` with its kind, size, mtime and content digest-ish: any write, unlink or mkdir shows. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(dir, p)} ${e.isDirectory() ? "dir" : "file"} ${st.size} ${st.mtimeMs}${e.isFile() ? ` ${fs.readFileSync(p, "latin1")}` : ""}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** A temp tree holding what a run of `tool` would touch: the raw snapshot a
 * bake unlinks first, a supervised target, a fake bin, an index. */
function sandbox(tool: string): string {
  const d = fs.mkdtempSync(path.join(tmp, `${tool}-`));
  fs.mkdirSync(path.join(d, "work"));
  fs.writeFileSync(path.join(d, "work/init.snap"), "the paired raw snapshot a bake would unlink");
  fs.writeFileSync(path.join(d, "target.olean"), "a supervised target that would be deleted");
  fs.mkdirSync(path.join(d, "bin"));
  fs.writeFileSync(path.join(d, "bin/lean.js"), "// glue\n");
  fs.writeFileSync(path.join(d, "bin/lean.wasm"), "\0asm-cli-contract");
  fs.mkdirSync(path.join(d, "lib"));
  fs.writeFileSync(path.join(d, "manifest.json"), "{}");
  return d;
}

/** Realistic flags for each tool, every path inside the sandbox; the [own, passthrough] split. */
const ARGS: Record<string, (d: string) => [string[], string[]]> = {
  "bake-snapshot": (d) => [["--name", "init", "--artifact", missing, "--lib", path.join(d, "lib"), "--work", path.join(d, "work"), "--out", path.join(d, "out")], []],
  "node-runner": (d) => [["--artifact", missing, "--work", path.join(d, "work"), "--lib", path.join(d, "lib")], ["--", "-o", "/work/x.olean", "/work/x.lean"]],
  "supervised-run": (d) => [["--target", path.join(d, "target.olean"), "--quiet-ms", "100", "--stable-ms", "100", "--give-up-ms", "1000"], ["--", "--artifact", missing, "--work", path.join(d, "work")]],
  "snapshot-probe": (d) => [["--snap", path.join(d, "work/init.snap"), "--probe", "#check 1", "--artifact", missing, "--lib", path.join(d, "lib"), "--budget-ms", "1000"], []],
  "persistent-probe": () => [["--artifact", missing], []],
  preflight: (d) => [["--url", "http://127.0.0.1:9/", "--no-boot", "--run-dir", path.join(d, "run")], []],
  "fetch-artifacts": (d) => [["--out", path.join(d, "out"), "--manifests", d, "--origin", "http://127.0.0.1:9/", "--only", "runtime", "--with-manifests"], []],
  "olean-imports": (d) => [["--audit", path.join(d, "lib")], []],
  "chunk-runtime": (d) => [["--bin", path.join(d, "bin"), "--out", path.join(d, "out"), "--revision", "test"], []],
  pack: (d) => [["--lib", path.join(d, "lib"), "--id", "x", "--out", path.join(d, "out"), "--no-imports"], []],
  unpack: (d) => [["--manifest", path.join(d, "manifest.json"), "--out", path.join(d, "out")], []],
};

/** `own` without the flags of one required group (and their values). */
function without(tool: string, own: string[], group: string[]): string[] {
  const arity = compactSpec(tool).flags;
  const out: string[] = [];
  for (let i = 0; i < own.length; i += 1) {
    const name = own[i]!.replace(/^--/, "");
    if (group.includes(name)) { i += arity[name] ?? 0; continue; }
    out.push(own[i]!);
  }
  return out;
}

/** A format string as it appears in source → the lines it can print. `${…}`
 * holes (balanced braces) match anything; escapes in template literals are
 * undone; `prefix` = the line only starts with it. */
function templateRegex(pieces: string[], prefix = false): RegExp {
  const text = pieces.join("");
  let src = "";
  for (let i = 0; i < text.length; ) {
    if (text.startsWith("${", i)) {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j += 1) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}" && (depth -= 1) === 0) break;
      }
      src += "[\\s\\S]*?";
      i = j + 1;
      continue;
    }
    let ch = text[i]!;
    if (ch === "\\" && i + 1 < text.length) { ch = text[i + 1]!; i += 2; } else i += 1;
    src += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${src}${prefix ? "" : "$"}`);
}

/** cliContract with captured io; `exit` records instead of exiting. */
function captured(tool: string, args: string[]) {
  const io = { out: [] as string[], err: [] as string[], code: null as number | null };
  const sink: CliIo = { out: (s) => io.out.push(s), err: (s) => io.err.push(s), exit: (c) => { io.code = c; } };
  const result = parseCli(tool, args, sink);
  return { ...io, result };
}

describe("SPECS", () => {
  test("cover the Tier 1/2 tools, each with a script, a synopsis, flags, exit codes and markers", () => {
    expect(TOOLS.sort()).toEqual(Object.keys(ARGS).sort());
    for (const tool of TOOLS) {
      const s = SPECS[tool]!;
      expect(fs.existsSync(path.join(root, s.script)), s.script).toBe(true);
      expect([1, 2]).toContain(s.tier);
      expect(s.synopsis.startsWith(`${path.basename(s.script)} `), tool).toBe(true);
      expect(Object.keys(s.exits)).toContain("0");
      expect(s.markers.length).toBeGreaterThan(0);
      for (const name of s.env) expect(ENV[name], `${tool} env ${name}`).toBeDefined();
      for (const group of s.required ?? []) for (const name of group) expect(s.flags.map((f) => f.name)).toContain(name);
      if (s.npm) expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts[s.npm]).toBe(`node ${s.script}`);
    }
  });

  test("every marker's template is the real format string in the script, and the marker regex matches what it prints", () => {
    for (const tool of TOOLS) {
      const s = SPECS[tool]!;
      for (const m of s.markers) {
        const source = fs.readFileSync(path.join(root, m.source ?? s.script), "utf8");
        for (const piece of m.template) expect(source, `${tool}/${m.id}: ${piece}`).toContain(piece);
        expect(templateRegex(m.template, m.prefix).test(m.example), `${tool}/${m.id}: the example is not what the format prints`).toBe(true);
        expect(m.regex.test(m.example), `${tool}/${m.id}: the regex does not match the example`).toBe(true);
      }
      // The usage refusal is the contract's one line, `usage: <synopsis>`; a
      // script that kept its own (now second-line) check prints the same bytes.
      const legacy = [...fs.readFileSync(path.join(root, s.script), "utf8").matchAll(/console\.error\("(usage: [^"]*)"\)/g)];
      for (const m of legacy) expect(m[1], tool).toBe(`usage: ${s.synopsis}`);
    }
    const sr = SPECS["supervised-run"]!;
    expect(fs.readFileSync(path.join(root, sr.script), "utf8")).toContain(sr.classifier!.template);
  });

  test("help text and warnings never contain a reserved substring a downstream log judge matches", () => {
    expect(RESERVED_OUTPUT.map((r) => r.text)).toEqual([": error", "error:", ": warning:", "warning:", "PANIC", "ABORT:", "uncaught", "RuntimeError", "object compactor:"]);
    for (const tool of TOOLS) expect(reservedHit(formatHelp(tool)), tool).toBeNull();
    const w = captured("pack", ["--lib", "l", "--id", "x", "--error", "--warning:", "uncaughtx"]);
    expect(w.err.length).toBe(3);
    // The flag NAMES are echoed verbatim (the user typed them); the contract's own words are clean.
    expect(reservedHit(w.err.map((l) => l.replace(/--error|--warning:|uncaughtx/, "<flag>")).join("\n"))).toBeNull();
    expect(reservedHit("x: error: y")).not.toBeNull();
    expect(reservedHit("  error: indented is fine")).toBeNull();
    expect(reservedHit("error: line-initial is not")).not.toBeNull();
  });

  test("docs/CLI-CONTRACT.md has a section per tool with its usage line, every flag, every exit code and every marker regex", () => {
    // Table cells escape `|` as `\|`; compare against the unescaped text.
    const doc = fs.readFileSync(path.join(root, "docs/CLI-CONTRACT.md"), "utf8").replaceAll("\\|", "|");
    const sections = doc.split("\n### ").slice(1);
    for (const tool of TOOLS) {
      const s = SPECS[tool]!;
      const section = sections.find((x) => x.split("\n")[0]!.split(" ")[0] === tool);
      expect(section, `no "### ${tool}" section`).toBeDefined();
      expect(section).toContain(`**Tier ${s.tier}.**`);
      expect(section).toContain(`usage: ${s.synopsis}`);
      for (const f of s.flags) expect(section, `${tool} --${f.name}`).toContain(`\`--${f.name}`);
      for (const code of Object.keys(s.exits)) expect(section, `${tool} exit ${code}`).toMatch(new RegExp(`\\n\\| ${code}( |/)`));
      for (const m of s.markers) expect(section, `${tool}/${m.id}`).toContain(m.regex.source);
      if (s.classifier) expect(section).toContain(s.classifier.template.replace(/^const FAILURE = |;$/g, ""));
    }
    for (const name of Object.keys(ENV)) expect(doc).toContain(`| \`${name}\` |`);
    for (const r of RESERVED_OUTPUT) expect(doc).toContain(`| \`${r.text}\` |`);
  });

  test("node pipeline/snapshot/cli.mjs --print-specs is valid JSON carrying every spec and regex", () => {
    const r = spawnSync("node", [cliScript, "--print-specs"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout) as { contractVersion: number; specs: Record<string, { synopsis: string; markers: { regex: string; example: string }[] }>; env: object; exitClasses: object };
    expect(json.contractVersion).toBe(2); // 2: the path rule of 2026-10-06 (the sibling-checkout fallback deleted)
    expect(Object.keys(json.specs).sort()).toEqual([...TOOLS].sort());
    expect(Object.keys(json.exitClasses)).toEqual(["0", "1", "2", "3"]);
    for (const tool of TOOLS) {
      expect(json.specs[tool]!.synopsis).toBe(SPECS[tool]!.synopsis);
      for (const m of json.specs[tool]!.markers) expect(new RegExp(m.regex).test(m.example)).toBe(true);
    }
  });

  test("every inline prelude is the current rendering of its SPEC; import-bound scripts use parseCli", () => {
    const r = spawnSync("node", [cliScript, "--check-preludes"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    expect(r.stdout).toMatch(/preludes match SPECS/);
    expect(r.status).toBe(0);
    for (const tool of TOOLS) {
      const s = SPECS[tool]!;
      const source = fs.readFileSync(path.join(root, s.script), "utf8");
      const begins = source.split("\n").filter((l) => l.trimStart().startsWith(PRELUDE_BEGIN)).length;
      if (s.binding === "inline") {
        expect(begins, tool).toBe(1);
        expect(source.split("\n").filter((l) => l.trim() === PRELUDE_END).length, tool).toBe(1);
        expect(source).not.toMatch(/cli\.mjs["']/);
      } else {
        expect(begins, tool).toBe(0);
        expect(source).toMatch(/import \{ parseCli \} from "(\.\/|(\.\.\/)+(pipeline\/)?snapshot\/)cli\.mjs";/);
        expect(source).toMatch(new RegExp(`parseCli\\(${JSON.stringify(tool)}[,)]`));
      }
    }
  });

  test("the files downstream vendors one by one import only files it vendors (cli.mjs stays out of them)", () => {
    // lean4game scripts/sync-qed64.sh (PIPELINE + PIPELINE_OPTIONAL) and the
    // showcase's pin-qed64.mjs VENDOR_PATHS; lean4game's own sanity regex.
    const lean4game = [
      "pipeline/toolchain/chunk-runtime.mjs", "pipeline/toolchain/artifact-paths.mjs", "pipeline/toolchain/gate.mjs",
      "pipeline/snapshot/persistent-probe.mjs", "pipeline/snapshot/bake-snapshot.mjs", "pipeline/snapshot/node-runner.mjs",
      "pipeline/snapshot/snapshot-probe.mjs", "pipeline/artifacts/pack.mjs", "pipeline/artifacts/unpack.mjs",
      "pipeline/artifacts/inspect.mjs", "pipeline/release/verify-release.mjs", "pipeline/artifacts/olean-imports.mjs",
    ];
    const snapshotDir = fs.readdirSync(path.join(root, "pipeline/snapshot")).filter((f) => f.endsWith(".mjs")).map((f) => `pipeline/snapshot/${f}`);
    const showcase = [...snapshotDir, "pipeline/toolchain/artifact-paths.mjs", "pipeline/artifacts/olean-imports.mjs", "pipeline/artifacts/unpack.mjs"];
    const RELATIVE = /(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g;
    for (const [who, set] of [["lean4game", lean4game], ["showcase", showcase]] as const) {
      for (const file of set) {
        const source = fs.readFileSync(path.join(root, file), "utf8");
        for (const m of source.matchAll(RELATIVE)) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]!));
          expect(set, `${who}: ${file} imports ${m[1]}, which ${who} does not vendor`).toContain(target);
        }
      }
    }
  });
});

describe("the argument grammar (cliContract, the one implementation)", () => {
  test("--flag=value and --flag value parse alike; args are normalized to the two-token form", () => {
    const a = captured("pack", ["--lib=/l", "--id", "x", "--out=", "--no-imports"]);
    expect(a.code).toBeNull();
    expect(a.result!.values).toEqual({ lib: "/l", id: "x", "no-imports": true });
    expect(a.result!.args).toEqual(["--lib", "/l", "--id", "x", "--out", "", "--no-imports"]);
    expect(a.err).toEqual(["pack: WARNING — flag --out has no value; ignored"]);
    const b = captured("pack", ["--lib", "/l", "--id=x=y"]);
    expect(b.result!.values).toEqual({ lib: "/l", id: "x=y" });
  });

  test("unknown flags are a WARNING in the fixed format and parsing continues; the first value of a repeated flag wins", () => {
    const r = captured("pack", ["--lib", "/l", "--libb", "/m", "--id", "a", "--id", "b", "--no-imports=1", "stray"]);
    expect(r.code).toBeNull();
    expect(r.err).toEqual([
      "pack: WARNING — unknown flag --libb ignored",
      "pack: WARNING — unexpected argument /m ignored",
      "pack: WARNING — flag --id repeated; the first value wins",
      "pack: WARNING — unknown flag --no-imports=1 ignored",
      "pack: WARNING — unexpected argument stray ignored",
    ]);
    expect(r.result!.values).toEqual({ lib: "/l", id: "a" });
    // The later value leaves the normalized argv too: a script's own parser may keep the last.
    expect(r.result!.args).toEqual(["--lib", "/l", "--libb", "/m", "--id", "a", "--no-imports=1", "stray"]);
    expect(captured("node-runner", ["--artifact=/A", "--artifact", "/B", "--", "x.lean"]).result!.args).toEqual(["--artifact", "/A", "--", "x.lean"]);
  });

  test("a missing required flag (or an empty one) prints the usage line and exits 2, after the warnings", () => {
    const r = captured("pack", ["--id", "x", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.result).toBeNull();
    expect(r.err).toEqual(["pack: WARNING — unknown flag --bogus ignored", "usage: pack.mjs --lib <dir> --id <name> --out <dir> [...]"]);
    expect(captured("pack", ["--id", "x", "--lib", ""]).code).toBe(2);
    // one-of groups
    expect(captured("snapshot-probe", ["--fresh-import", "--probe", "#check 1"]).code).toBeNull();
    expect(captured("snapshot-probe", ["--snap", "s", "--probe-file", "p"]).code).toBeNull();
    expect(captured("snapshot-probe", ["--probe", "#check 1"]).code).toBe(2);
    expect(captured("snapshot-probe", ["--snap", "s"]).code).toBe(2);
  });

  test("--help/-h anywhere in the tool's own arguments wins over everything, even in a value position", () => {
    for (const args of [["--help"], ["-h"], ["--id", "x", "--bogus", "--help"], ["--lib", "--help"], ["--lib=-h"]]) {
      const r = captured("pack", args);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.out).toEqual([formatHelp("pack")]);
      expect(r.err).toEqual([]);
    }
  });

  test("passthrough: after `--` (separator) or from the first non-runner token (implicit) arguments are not the tool's", () => {
    const s = captured("supervised-run", ["--target", "t", "--", "--help", "--artifact", "a"]);
    expect(s.code).toBeNull();
    expect(s.result!.passthrough).toEqual(["--help", "--artifact", "a"]);
    expect(s.result!.args).toEqual(["--target", "t", "--", "--help", "--artifact", "a"]);
    expect(captured("supervised-run", ["--target", "t"]).code).toBe(2);
    expect(captured("supervised-run", ["--target", "t", "--"]).code).toBe(2);
    const n = captured("node-runner", ["--work=w", "-o", "/work/x.olean", "--help"]);
    expect(n.code).toBeNull();
    expect(n.err).toEqual([]);
    expect(n.result!.values).toEqual({ work: "w" });
    expect(n.result!.passthrough).toEqual(["-o", "/work/x.olean", "--help"]);
    expect(n.result!.args).toEqual(["--work", "w", "-o", "/work/x.olean", "--help"]);
    expect(captured("node-runner", ["--", "--help"]).result!.passthrough).toEqual(["--help"]);
    expect(captured("node-runner", ["--artifact", "a", "--help", "/work/x.lean"]).code).toBe(0);
    // an unknown runner-position flag is Lean's, not a warning
    const u = captured("node-runner", ["--bogus", "x"]);
    expect(u.err).toEqual([]);
    expect(u.result!.passthrough).toEqual(["--bogus", "x"]);
  });

  test("cliContract uses nothing but its parameters and Node globals (it is inlined into vendored scripts)", () => {
    const fresh = new Function(`return (${cliContract.toString()})`)() as typeof cliContract;
    const io = { out: [] as string[], err: [] as string[], code: null as number | null };
    const r = fresh({ ...compactSpec("unpack") }, ["--manifest=m", "--out", "o"], { out: (s) => io.out.push(s), err: (s) => io.err.push(s), exit: (c) => { io.code = c; } });
    expect(r!.values).toEqual({ manifest: "m", out: "o" });
  });
});

describe("the real scripts", () => {
  test("tests/adversarial/preflight.mjs (moved 2026-10-06) is a shim: the same stdout, exit code and run dir, plus one stderr deprecation WARNING", () => {
    const outputs = ["pipeline/release/preflight.mjs", "tests/adversarial/preflight.mjs"].map((script) => {
      const d = sandbox("preflight-shim");
      const r = run(script, ["--url", "http://127.0.0.1:9/", "--no-boot", "--run-dir", path.join(d, "run")], d);
      const json = JSON.parse(fs.readFileSync(path.join(d, "run/preflight.json"), "utf8"));
      return { ...r, json };
    });
    const [moved, shim] = outputs as [typeof outputs[0], typeof outputs[0]];
    expect(moved.status).toBe(3);
    expect(moved.stdout).toMatch(/^PREFLIGHT REFUSED: /m);
    expect([shim.status, shim.stdout, shim.json]).toEqual([moved.status, moved.stdout, moved.json]);
    expect(moved.stderr).toBe("");
    expect(shim.stderr).toBe("preflight: WARNING — tests/adversarial/preflight.mjs is deprecated; use pipeline/release/preflight.mjs (docs/CLI-CONTRACT.md)\n");
    expect(reservedHit(shim.stderr)).toBeNull();
    const help = run("tests/adversarial/preflight.mjs", ["--help"], tmp);
    expect([help.status, help.stdout]).toEqual([0, `${formatHelp("preflight")}\n`]);
  });

  for (const tool of Object.keys(ARGS)) {
    const spec = SPECS[tool]!;
    test(`${tool}: --help and -h exit 0 with the help (synopsis first), before any side effect`, () => {
      const d = sandbox(tool);
      const before = tree(d);
      const [own, rest] = ARGS[tool]!(d);
      for (const flag of ["--help", "-h"]) {
        const r = run(spec.script, [...own, flag, ...rest], d);
        expect(r.signal, `${tool} ${flag} was killed by the timeout`).toBeNull();
        expect(r.status, `${tool} ${flag}: ${r.stderr}`).toBe(0);
        expect(r.stdout.split("\n")[0]).toBe(`usage: ${spec.synopsis}`);
        expect(r.stdout).toBe(`${formatHelp(tool)}\n`);
        expect(r.stderr).toBe("");
        expect(tree(d), `${tool} ${flag} touched the filesystem`).toEqual(before);
      }
      // --help first, as a user types it
      const first = run(spec.script, ["--help"], d);
      expect(first.status).toBe(0);
      expect(first.stdout).toBe(`${formatHelp(tool)}\n`);
      expect(tree(d)).toEqual(before);
    });

    const groups = [...(spec.required ?? [])];
    if (groups.length || spec.passthrough?.required) {
      test(`${tool}: a missing required flag exits 2 with the usage line, before any side effect`, () => {
        const d = sandbox(tool);
        const before = tree(d);
        const [own, rest] = ARGS[tool]!(d);
        const cases: string[][] = groups.map((group) => [...without(tool, own, group), "--bogus-flag", ...rest]);
        if (spec.passthrough?.required) cases.push([...own, "--bogus-flag"]);
        for (const args of cases) {
          const r = run(spec.script, args, d);
          expect(r.signal).toBeNull();
          expect(r.status, `${tool} ${args.join(" ")}: ${r.stderr}`).toBe(2);
          expect(r.stdout).toBe("");
          // the unknown flag is warned about first: the tool kept running up to the usage check
          expect(r.stderr).toBe(`${tool}: WARNING — unknown flag --bogus-flag ignored\nusage: ${spec.synopsis}\n`);
          expect(tree(d), `${tool} ${args.join(" ")} touched the filesystem`).toEqual(before);
        }
      });
    }
  }

  test("bake-snapshot: a typo'd flag is warned about, --artifact=<dir> is honoured, and a missing artifact refuses (exit 2) before the bake", () => {
    const d = sandbox("bake-typo");
    const before = tree(d);
    const r = run(SPECS["bake-snapshot"]!.script, [`--artifact=${missing}`, "--wrok", path.join(d, "elsewhere"), "--work", path.join(d, "work"), "--out", path.join(d, "out")], d);
    expect(r.status).toBe(2);
    expect(r.stderr.split("\n")).toEqual([
      "bake-snapshot: WARNING — unknown flag --wrok ignored",
      `bake-snapshot: WARNING — unexpected argument ${path.join(d, "elsewhere")} ignored`,
      `bake-snapshot: no lean.wasm under ${missing} — pass --artifact <stage1 dir>`,
      "",
    ]);
    expect(tree(d)).toEqual(before);
  });

  test("node-runner: a missing artifact refuses (exit 2) without creating --work; an unknown runner-position flag is Lean's", () => {
    const d = sandbox("runner-missing");
    const before = tree(d);
    const r = run(SPECS["node-runner"]!.script, [`--artifact=${missing}`, "--work", path.join(d, "fresh-work"), "--bogus"], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(`error: ${path.join(missing, "bin/lean.js")} not found — pass --artifact or set QED64_LEAN_ARTIFACT\n`);
    expect(tree(d)).toEqual(before);
  });

  test("node-runner: a repeated flag uses the first value, as the WARNING says (its own parser keeps the last)", () => {
    const d = sandbox("runner-repeated");
    const before = tree(d);
    const [first, second] = [path.join(missing, "first"), path.join(missing, "second")];
    const r = run(SPECS["node-runner"]!.script, ["--artifact", first, `--artifact=${second}`, "--work", path.join(d, "fresh-work"), "--", "x.lean"], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe([
      "node-runner: WARNING — flag --artifact repeated; the first value wins",
      `error: ${path.join(first, "bin/lean.js")} not found — pass --artifact or set QED64_LEAN_ARTIFACT`,
      "",
    ].join("\n"));
    expect(tree(d)).toEqual(before);
  });

  test("chunk-runtime: --flag=value reaches the script's own parser (a real chunk of a fake bin)", () => {
    const d = sandbox("chunk-eq");
    const r = run(SPECS["chunk-runtime"]!.script, [`--bin=${path.join(d, "bin")}`, `--out=${path.join(d, "out")}`, "--revision=test", "--lean-version=9.9.9"], d);
    expect(r.status, r.stderr).toBe(0);
    // no contract WARNING and no --lean-version warning (git's own complaint
    // about a missing fork checkout, from the eager default revision, may appear)
    expect(r.stderr).not.toMatch(/WARNING/);
    // markers are per-line regexes: every stdout line is one of the stable ones
    const markers = SPECS["chunk-runtime"]!.markers.filter((m) => m.stream === "stdout");
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.length).toBe(3);
    for (const line of lines) expect(markers.some((m) => m.regex.test(line)), line).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(d, "out/runtime-manifest.json"), "utf8"));
    expect(manifest.leanVersion).toBe("9.9.9");
    expect(manifest.sourceRevision).toBe("test");
  });
});
