// bake-snapshot's own correctness (docs/CLI-CONTRACT.md "bake-snapshot"; the architecture
// review's bake defects, ported as behaviour from the kernel copy, D4 a): a corrupt index is
// refused, never replaced; the pairing is re-checked under the index lock; the runner gets only
// the bake's environment and no output buffer; a runner killed by a signal the bake did not
// send, or exiting non-zero, fails the bake; a signal to the bake reaches its runner.
//
// Safety: no test here loads a lean.js or a lean.wasm. Each bake runs from a SCRATCH CHECKOUT
// (bake-snapshot.mjs and pipeline/toolchain/artifact-paths.mjs copied into a temp dir) with a
// fake stage1 and ONE configurable FAKE runner at pipeline/snapshot/node-runner.mjs. The bake
// strips its runner's environment, so the fake is configured by <work>/fake.json, written
// before the bake. Every child has a SIGKILL timeout (spawnSync's, or a timer and a finally for
// the async spawns), and the fake's hang mode exits by itself after 25 s whatever the test did.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeBuildId } from "../../pipeline/toolchain/artifact-paths.mjs";
import { SPECS } from "../../pipeline/snapshot/cli.mjs";

const root = path.resolve(__dirname, "../..");
const SCRIPT = "pipeline/snapshot/bake-snapshot.mjs";
const RULE_ENV = ["QED64_LEAN_ARTIFACT", "QED64_WORK", "QED64_STAGING", "QED64_ALLOW_LEGACY_IMPORTS", "QED64_PROFILE_INIT", "QED64_RUNNER", "QED64_BAKE_LOCK_WAIT_MS", "LEAN_PATH", "LEAN_COMPACTOR_RESERVE"];
const marker = (id: string) => SPECS["bake-snapshot"]!.markers.find((m) => m.id === id)!.regex;
const SCHEMA = "qed64.snapshot-index/v1";
const OTHER = "wasm64-0000000000000000";

// The fake runner: records how it was started (pid, argv, environment), then does what <work>/fake.json says.
const FAKE_RUNNER = String.raw`import fs from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const work = a[a.indexOf("--work") + 1];
const save = a.find((x) => x.startsWith("--incr-header-save=")).split("=")[1].replace(/^\/work\//, "");
const cfgFile = path.join(work, "fake.json");
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
fs.writeFileSync(path.join(work, "runner.json"), JSON.stringify({ pid: process.pid, argv: a, env: process.env }));
for (const [stream, line] of cfg.print ?? []) fs.writeSync(stream === "stderr" ? 2 : 1, line + "\n");
for (let i = 0; i < (cfg.bigStdoutMiB ?? 0); i++) fs.writeSync(1, "x".repeat(1 << 20) + "\n");
if (cfg.corrupt) fs.writeFileSync(cfg.corrupt, cfg.corruptWith ?? "{ not json");
const tmp = path.join(work, save + ".tmp.42");
if (cfg.snap !== false) { fs.writeFileSync(tmp, "a raw region " + save); fs.renameSync(tmp, path.join(work, save)); }
if (cfg.selfKill) process.kill(process.pid, "SIGKILL");
if (cfg.exitCode !== undefined) process.exit(cfg.exitCode);
if (cfg.hang) { setInterval(() => {}, 1 << 30); setTimeout(() => process.exit(9), 25_000); } // the wedged runtime: never exits
`;

type Fake = { print?: [string, string][]; bigStdoutMiB?: number; corrupt?: string; corruptWith?: string; snap?: boolean; selfKill?: boolean; exitCode?: number; hang?: boolean };

let tmp: string;
// realpath: the script derives its repo root from import.meta.url, which Node gives as the real path.
beforeAll(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qed64-bake-snapshot-"))); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A scratch checkout: the bake, the path rule, the fake runner, a fake stage1; the fake configured by `fake`. */
function bakeCheckout(fake: Fake = {}) {
  const s = fs.mkdtempSync(path.join(tmp, "checkout-"));
  for (const f of [SCRIPT, "pipeline/toolchain/artifact-paths.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(s, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(s, f));
  }
  fs.writeFileSync(path.join(s, "pipeline/snapshot/node-runner.mjs"), FAKE_RUNNER);
  fs.mkdirSync(path.join(s, "tmp"));
  const art = path.join(s, "art/stage1");
  fs.mkdirSync(path.join(art, "bin"), { recursive: true });
  fs.writeFileSync(path.join(art, "bin/lean.wasm"), Buffer.from(`\0asm${path.basename(s)}`));
  const work = path.join(s, "w");
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "fake.json"), JSON.stringify(fake));
  const id = runtimeBuildId(fs.readFileSync(path.join(art, "bin/lean.wasm")));
  return { s, art, id, work, out: path.join(s, "out"), args: ["--artifact", art, "--out", path.join(s, "out"), "--work", work, "--name", "init"] };
}

/** The bake's environment: this process's, the rule's variables cleared, TMPDIR inside the checkout, then `env`. */
function bakeEnv(s: string, env: Record<string, string> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, TMPDIR: path.join(s, "tmp") };
  for (const name of RULE_ENV) delete base[name];
  return { ...base, ...env };
}
function run(s: string, args: string[], env: Record<string, string> = {}, stdio: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"]) {
  const r = spawnSync(process.execPath, [path.join(s, SCRIPT), ...args], {
    cwd: s, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: bakeEnv(s, env), stdio: stdio as never,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", lines: (r.stderr ?? "").split("\n").filter(Boolean) };
}

/** Every path under `dir` with its size, so a refusal that touched the filesystem shows. */
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
const recorded = (work: string) => JSON.parse(fs.readFileSync(path.join(work, "runner.json"), "utf8")) as { pid: number; argv: string[]; env: Record<string, string> };
const unindexed = (stderr: string) => {
  const line = stderr.split("\n").find((l) => l.startsWith("bake-snapshot: unindexed entry "));
  return line === undefined ? undefined : JSON.parse(line.slice("bake-snapshot: unindexed entry ".length));
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("bake-snapshot refuses a corrupt index, never replaces it", () => {
  test("before the runner: an unreadable or corrupt index.json is exit 2 with one line; nothing is touched and the runner never starts", () => {
    const { s, out, work, args } = bakeCheckout();
    fs.writeFileSync(path.join(work, "init.snap"), "the paired raw snapshot");
    const indexPath = path.join(out, "index.json");
    const corrupt: [string, string][] = [
      ["{ not json", "it is not JSON"],
      ["[]", "it is not a JSON object"],
      ['{"schema":"other","snapshots":[]}', 'its schema is "other", not qed64.snapshot-index/v1'],
      [`{"schema":"${SCHEMA}"}`, "it has no snapshots array"],
      [`{"schema":"${SCHEMA}","snapshots":[{"url":"x"}]}`, "snapshots[0] is not an entry with a string name"],
    ];
    fs.mkdirSync(out);
    for (const [text, problem] of corrupt) {
      fs.writeFileSync(indexPath, text);
      const before = tree(s);
      const r = run(s, args);
      expect(r.status, text).toBe(2);
      expect(r.lines).toEqual([`bake-snapshot: ${indexPath} is not a snapshot index: ${problem} — refusing to replace it`]);
      expect(r.lines[0]).toMatch(marker("refuse-index-corrupt"));
      expect(r.stdout).toBe("");
      expect(tree(s)).toEqual(before);
      expect(fs.existsSync(path.join(work, "runner.json"))).toBe(false);
    }
    fs.rmSync(indexPath);
    fs.mkdirSync(indexPath); // a directory: read(2) answers EISDIR
    const before = tree(s);
    const r = run(s, args);
    expect(r.status).toBe(2);
    expect(r.lines).toEqual([`bake-snapshot: cannot read ${indexPath} (EISDIR) — refusing to replace it`]);
    expect(r.lines[0]).toMatch(marker("refuse-index-unreadable"));
    expect(tree(s)).toEqual(before);
    expect(fs.readFileSync(path.join(work, "init.snap"), "utf8")).toBe("the paired raw snapshot");
    expect(fs.existsSync(path.join(work, "runner.json"))).toBe(false);
  }, 30_000);

  test("under the lock: an index corrupted while the runner ran is exit 1, written over by nothing; the .snapz kept and its entry printed", () => {
    const { s, id, out, work, args } = bakeCheckout();
    const indexPath = path.join(out, "index.json");
    fs.mkdirSync(out);
    fs.writeFileSync(indexPath, JSON.stringify({ schema: SCHEMA, snapshots: [] }));
    fs.writeFileSync(path.join(work, "fake.json"), JSON.stringify({ corrupt: indexPath }));
    const r = run(s, args);
    expect(r.status, r.stderr).toBe(1);
    expect(r.lines.filter((l) => marker("refuse-index-corrupt").test(l))).toEqual([`bake-snapshot: ${indexPath} is not a snapshot index: it is not JSON — refusing to replace it`]);
    expect(unindexed(r.stderr)).toMatchObject({ name: "init", runtime: id });
    expect(r.stdout).not.toMatch(/^baked /m);
    expect(fs.readFileSync(indexPath, "utf8")).toBe("{ not json");
    expect(fs.readdirSync(out).sort()).toEqual(["index.json", expect.stringMatching(/^init\.[0-9a-f]{16}\.snapz$/)]); // no lock, temp or copy left
  }, 30_000);

  test("under the lock: the pairing is re-checked; a sibling of another runtime upserted meanwhile is refused (exit 1), never mixed in", () => {
    const { s, id, out, work, args } = bakeCheckout();
    const indexPath = path.join(out, "index.json");
    const foreign = JSON.stringify({ schema: SCHEMA, snapshots: [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: OTHER }] });
    fs.writeFileSync(path.join(work, "fake.json"), JSON.stringify({ corrupt: indexPath, corruptWith: foreign }));
    fs.mkdirSync(out); // an empty --out: the check before the runner passes
    const r = run(s, args);
    expect(r.status, r.stderr).toBe(1);
    expect(r.lines.filter((l) => marker("refuse-foreign").test(l))).toEqual([`bake-snapshot: ${indexPath} already holds entries for runtime ${OTHER} (mathlib) — refusing to mix pairings`]);
    expect(unindexed(r.stderr)).toMatchObject({ name: "init", runtime: id });
    expect(fs.readFileSync(indexPath, "utf8")).toBe(foreign);
    expect(fs.existsSync(path.join(out, `index.${id}.json`))).toBe(false);
  }, 30_000);
});

describe("bake-snapshot owns its runner's environment and output", () => {
  test("the runner gets exactly PATH, HOME, TMPDIR and the bake's variables: a host LEAN_PATH and anything else stay out", () => {
    const { s, work, args } = bakeCheckout();
    const r = run(s, args, { LEAN_PATH: "/nope", QED64_FAKE_EXTRA: "1", QED64_PROFILE_INIT: "1", QED64_ALLOW_LEGACY_IMPORTS: "yes", NODE_OPTIONS: "--no-warnings" });
    expect([r.status, r.stderr]).toEqual([0, ""]);
    const env = recorded(work).env;
    expect(env.LEAN_PATH).toBeUndefined();
    expect(env.QED64_FAKE_EXTRA).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LEAN_COMPACTOR_RESERVE).toBe("3758096384");
    expect(env.QED64_PROFILE_INIT).toBe("1");
    expect(env.QED64_ALLOW_LEGACY_IMPORTS).toBe("1");
    const allowed = ["PATH", "HOME", "TMPDIR", "LEAN_COMPACTOR_RESERVE", "QED64_PROFILE_INIT", "QED64_ALLOW_LEGACY_IMPORTS"];
    // macOS itself adds __CF_USER_TEXT_ENCODING to a process started without it: not the bake's
    const keys = (e: Record<string, string>) => Object.keys(e).filter((k) => !k.startsWith("__CF_"));
    expect(keys(env).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(env.TMPDIR).toBe(path.join(s, "tmp"));
    // without them: no legacy-imports gate and no profiling variable, the reserve from --reserve
    const b = run(s, [...args, "--reserve", "1073741824"]);
    expect([b.status, b.stderr]).toEqual([0, ""]);
    expect(keys(recorded(work).env).filter((k) => !["PATH", "HOME", "TMPDIR"].includes(k))).toEqual(["LEAN_COMPACTOR_RESERVE"]);
    expect(recorded(work).env.LEAN_COMPACTOR_RESERVE).toBe("1073741824");
  }, 30_000);

  test("no output buffer: a runner that prints 70 MiB still bakes (execFile's 64 MiB maxBuffer killed it)", () => {
    const { s, out, args } = bakeCheckout({ bigStdoutMiB: 70 });
    // stdout ignored here: spawnSync's own maxBuffer would otherwise kill the bake
    const r = run(s, args, {}, ["ignore", "ignore", "pipe"]);
    expect([r.status, r.stderr]).toEqual([0, ""]);
    expect(JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8")).snapshots.map((e: { name: string }) => e.name)).toEqual(["init"]);
  }, 30_000);

  test("a runner killed by a signal the bake did not send is exit 1 with one line: nothing compressed, no index", () => {
    const { s, out, work, args } = bakeCheckout({ selfKill: true });
    const r = run(s, args);
    expect(r.status).toBe(1);
    expect(r.lines).toEqual(["bake-snapshot: the runner was killed by SIGKILL, a signal this bake did not send — nothing compressed, the index is not written"]);
    expect(marker("runner-signal").exec(r.lines[0]!)?.[1]).toBe("SIGKILL");
    expect(fs.existsSync(path.join(work, "init.snap"))).toBe(true); // it saved, then died: still not a bake
    expect(fs.existsSync(out)).toBe(false);
  }, 30_000);

  test("a runner that exits non-zero is exit 1 with one line (before: an unhandled rejection and its stack)", () => {
    const { s, out, args } = bakeCheckout({ snap: false, exitCode: 7 });
    const r = run(s, args);
    expect(r.status).toBe(1);
    expect(r.lines).toEqual(["bake-snapshot: runner exited 7"]);
    expect(r.lines[0]).toMatch(marker("runner-exit"));
    expect(fs.existsSync(out)).toBe(false);
  }, 30_000);
});

describe("bake-snapshot's lifecycle: signals and a gone reader", () => {
  /** Start the bake asynchronously; `exited` resolves with its exit code (null: killed by a signal). */
  function startBake(s: string, args: string[]) {
    const child = spawn(process.execPath, [path.join(s, SCRIPT), ...args], { cwd: s, stdio: ["ignore", "pipe", "pipe"], env: bakeEnv(s) });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    const killer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    return { child, exited, stderr: () => stderr, done: () => { clearTimeout(killer); child.kill("SIGKILL"); } };
  }

  for (const [sig, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as [NodeJS.Signals, number][]) {
    test(`${sig}: forwarded to the runner, which is gone; the bake exits ${code} and writes no index`, async () => {
      const { s, out, work, args } = bakeCheckout({ snap: false, hang: true });
      const bake = startBake(s, args);
      try {
        for (let t = 0; t < 400 && !fs.existsSync(path.join(work, "runner.json")); t += 1) await sleep(25);
        const { pid } = recorded(work);
        expect(alive(pid)).toBe(true);
        bake.child.kill(sig);
        expect(await bake.exited).toBe(code);
        let t = 0;
        for (; t < 80 && alive(pid); t += 1) await sleep(25);
        expect(alive(pid), `runner ${pid} still alive`).toBe(false);
      } finally {
        bake.done();
      }
      expect(fs.existsSync(path.join(out, "index.json"))).toBe(false);
      expect(bake.stderr()).not.toContain("the bake ended with its runner");
    }, 30_000);
  }

  test("a gone reader: the bake's stdout closed at once never ends it; exit 0 and the index written", async () => {
    const { s, out, args } = bakeCheckout({ print: [["stdout", "a runner line"], ["stderr", "a runner line on stderr"]] });
    const bake = startBake(s, args);
    bake.child.stdout.destroy();
    try {
      expect(await bake.exited).toBe(0);
    } finally {
      bake.done();
    }
    expect(bake.stderr()).toBe("a runner line on stderr\n");
    expect(JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8")).snapshots.map((e: { name: string }) => e.name)).toEqual(["init"]);
  }, 30_000);
});
