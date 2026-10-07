// snapshot-probe's watchdog (docs/CLI-CONTRACT.md §snapshot-probe, HARDENING #61): unless
// --watchdog-ms 0 (or QED64_PROBE_CHILD=1), the probe runs as ONE supervised child and the
// supervisor SIGKILLs it past the deadline, because from kernel patch 0037 on a task that never
// finishes hangs lean_wasm_compile, which blocks the probe's own thread.
//
// Safety: no real runtime. The artifact is a FAKE: its bin/lean.js is a stub glue (run by the
// probe through vm.runInThisContext, as the real one is) that implements the exports the probe
// calls and then calls onRuntimeInitialized; FAKE_LEAN_MODE picks what its lean_wasm_compile
// does (pass, an error message, an abort, or a busy loop that never returns, which blocks the
// thread exactly as a hung wasm call does). Every node process the tests start logs its PID
// through a --require preload (NODE_OPTIONS), so "no child" and "the child is gone" are facts,
// not inferences. Every child has a SIGKILL timeout, every async one a finally that kills what it
// started, and a hung child also dies with its supervisor (the probe's own guard, tested below).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SPECS, formatHelp, reservedHit } from "../../pipeline/snapshot/cli.mjs";

const root = path.resolve(__dirname, "../..");
const probe = path.join(root, "pipeline/snapshot/snapshot-probe.mjs");
const WATCHDOG_LINE = (ms: number) => `SNAPSHOT PROBE FAIL: watchdog: no verdict within ${ms} ms (lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on)`;
const CLEARED = ["QED64_PROBE_CHILD", "QED64_PROBE_SCRATCH", "QED64_LEAN_ARTIFACT", "QED64_LIB_TREE", "QED64_PROFILE_INIT", "NODE_OPTIONS"];

const FAKE_GLUE = `// fake lean.js: the exports snapshot-probe calls, no wasm
const M = globalThis.Module;
const mode = process.env.FAKE_LEAN_MODE || "pass";
Object.assign(M, {
  getValue: (p, t) => (t === "i64" ? 1n : 0), // tag 0, scalar box(0)
  stringToNewUTF8: () => 8, _lean_mk_string: () => 16, _free() {}, _malloc: () => 64,
  _lean_initialize_runtime_module() {}, _lean_initialize() {}, _lean_io_mark_end_initialization() {},
  _lean_init_search_path: () => 32,
  _lean_wasm_load_snapshot: () => 48,
  _lean_wasm_compile: () => {
    if (mode === "hang") for (;;) {}
    if (mode === "abort") M.onAbort("fake abort");
    M.print('{"severity":"information","pos":{"line":1,"column":0},"data":"1 : Nat"}');
    if (mode === "error") M.print('{"severity":"error","pos":{"line":1,"column":0},"data":"unknown identifier foo"}');
    return 48;
  },
});
M.onRuntimeInitialized();
`;

let tmp: string;
let art: string;
let lib: string;
let snap: string;
let preload: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qed64-probe-watchdog-")));
  art = path.join(tmp, "artifact");
  fs.mkdirSync(path.join(art, "bin"), { recursive: true });
  fs.writeFileSync(path.join(art, "bin/lean.js"), FAKE_GLUE);
  lib = path.join(tmp, "lib");
  fs.mkdirSync(lib);
  snap = path.join(tmp, "probe-input.snap");
  fs.writeFileSync(snap, "not a real snapshot");
  preload = path.join(tmp, "pid-log.cjs");
  fs.writeFileSync(preload, 'if (process.env.PROBE_PID_LOG) require("node:fs").appendFileSync(process.env.PROBE_PID_LOG, JSON.stringify({ pid: process.pid, ppid: process.ppid, execArgv: process.execArgv }) + "\\n");\n');
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

type Proc = { pid: number; ppid: number; execArgv: string[] };
/** A fresh case dir: its own TMPDIR (the probe's scratch lands there) and PID log. */
function caseDir() {
  const d = fs.mkdtempSync(path.join(tmp, "case-"));
  fs.mkdirSync(path.join(d, "tmp"));
  return { d, tmpdir: path.join(d, "tmp"), log: path.join(d, "pids.jsonl") };
}
/** Every node process the case started, one entry per PID (the --stack-size re-exec keeps the PID: last entry wins). */
function processes(log: string): Proc[] {
  if (!fs.existsSync(log)) return [];
  const byPid = new Map<number, Proc>();
  for (const line of fs.readFileSync(log, "utf8").split("\n").filter(Boolean)) {
    const p = JSON.parse(line) as Proc;
    byPid.set(p.pid, p);
  }
  return [...byPid.values()];
}
function envFor(c: ReturnType<typeof caseDir>, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !CLEARED.includes(k)) env[k] = v;
  return { ...env, TMPDIR: c.tmpdir, PROBE_PID_LOG: c.log, NODE_OPTIONS: `--require ${preload}`, ...extra };
}
const baseArgs = () => ["--snap", snap, "--probe", "#check 1", "--artifact", art, "--lib", lib];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

function run(args: string[], c: ReturnType<typeof caseDir>, extra: Record<string, string> = {}, nodeArgs = ["--stack-size=8192"]) {
  const r = spawnSync(process.execPath, [...nodeArgs, probe, ...args], { cwd: c.d, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: envFor(c, extra) });
  return { status: r.status, signal: r.signal, pid: r.pid!, stdout: r.stdout ?? "", stderr: r.stderr ?? "", procs: processes(c.log) };
}
/** The child the supervisor started (the one process whose PID is not the supervisor's). */
function childOf(procs: Proc[], parent: number): Proc {
  const others = procs.filter((p) => p.pid !== parent);
  expect(others.length, JSON.stringify(procs)).toBe(1);
  expect(others[0]!.ppid).toBe(parent);
  return others[0]!;
}
/** Milliseconds in the timing lines vary run to run; everything else must be byte-identical. */
const timing = (s: string) => s.replace(/elapsed=\d+ms/g, "elapsed=<n>ms");

describe("snapshot-probe watchdog", () => {
  test("a compile that never returns: the watchdog SIGKILLs the child, prints exactly one FAIL line, exits 1 and leaves no scratch dir", () => {
    const c = caseDir();
    const t0 = Date.now();
    const r = run([...baseArgs(), "--watchdog-ms", "1500"], c, { FAKE_LEAN_MODE: "hang" });
    expect(r.signal).toBeNull();
    expect(r.status).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    const lines = r.stderr.split("\n").filter(Boolean);
    expect(lines).toEqual([WATCHDOG_LINE(1500)]);
    expect(SPECS["snapshot-probe"]!.markers.find((m) => m.id === "watchdog")!.regex.test(lines[0]!)).toBe(true);
    expect(SPECS["snapshot-probe"]!.markers.find((m) => m.id === "fail")!.regex.test(lines[0]!)).toBe(true);
    expect(reservedHit(lines[0]!)).toBeNull();
    // the child printed its lines up to the hung call, the supervisor nothing on stdout
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([
      "== load snapshot: probe-input.snap (19 bytes) ==",
      expect.stringMatching(/^load: tag=0 scalar=0 elapsed=\d+ms$/),
      "== compile the probe against the seeded environment ==",
    ]);
    const child = childOf(r.procs, r.pid);
    expect(alive(child.pid)).toBe(false);
    expect(fs.readdirSync(c.tmpdir)).toEqual([]);
  });

  test("the child's exit code is the probe's: 0 PASS, 1 FAIL, 2 a path-rule refusal in the child, 3 an abort", () => {
    const cases: [string, string[], number, Record<string, string>][] = [
      ["pass", baseArgs(), 0, { FAKE_LEAN_MODE: "pass" }],
      ["error", baseArgs(), 1, { FAKE_LEAN_MODE: "error" }],
      ["abort", baseArgs(), 3, { FAKE_LEAN_MODE: "abort" }],
      ["no artifact", ["--snap", snap, "--probe", "#check 1", "--lib", lib], 2, {}],
    ];
    for (const [name, args, code, extra] of cases) {
      const c = caseDir();
      const r = run(args, c, extra);
      expect([name, r.status], r.stderr).toEqual([name, code]);
      childOf(r.procs, r.pid); // every case ran in the supervised child
      expect(r.stderr, name).not.toMatch(/watchdog|killed by/);
      expect(fs.readdirSync(c.tmpdir), name).toEqual([]);
      if (name === "no artifact") {
        // the refusal is printed once, by the child, and the supervisor adds nothing
        expect(r.stderr.split("\n").filter(Boolean)).toEqual([
          expect.stringMatching(/^snapshot-probe: no --artifact given and QED64_LEAN_ARTIFACT is unset; the deprecated default .* — pass --artifact <dir> or set QED64_LEAN_ARTIFACT$/),
          `usage: ${SPECS["snapshot-probe"]!.synopsis}`,
        ]);
      }
      if (name === "abort") expect(r.stderr).toBe("ABORT: fake abort\n");
    }
  });

  test("--help, a missing required flag and a malformed --watchdog-ms never spawn a child", () => {
    const help = caseDir();
    const h = run([...baseArgs(), "--help"], help);
    expect([h.status, h.stdout, h.stderr]).toEqual([0, `${formatHelp("snapshot-probe")}\n`, ""]);
    expect(h.procs.map((p) => p.pid)).toEqual([h.pid]);

    const usage = caseDir();
    const u = run(["--snap", snap, "--artifact", art], usage);
    expect([u.status, u.stdout, u.stderr]).toEqual([2, "", `usage: ${SPECS["snapshot-probe"]!.synopsis}\n`]);
    expect(u.procs.map((p) => p.pid)).toEqual([u.pid]);

    for (const bad of ["-1", "1.5", "soon"]) {
      const c = caseDir();
      const r = run([...baseArgs(), "--watchdog-ms", bad], c);
      expect(r.status, bad).toBe(2);
      expect(r.stderr.split("\n").filter(Boolean)).toEqual([
        `snapshot-probe: --watchdog-ms takes a whole number of ms, 0 for no watchdog (got ${bad})`,
        `usage: ${SPECS["snapshot-probe"]!.synopsis}`,
      ]);
      expect(reservedHit(r.stderr)).toBeNull();
      expect(r.procs.map((p) => p.pid)).toEqual([r.pid]);
      expect(fs.readdirSync(c.tmpdir)).toEqual([]);
    }
  });

  test("--watchdog-ms 0 and QED64_PROBE_CHILD=1 run the probe in-process (no child)", () => {
    for (const [args, extra] of [[[...baseArgs(), "--watchdog-ms", "0"], {}], [baseArgs(), { QED64_PROBE_CHILD: "1" }]] as const) {
      const c = caseDir();
      const r = run([...args], c, { ...extra });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/\nSNAPSHOT PROBE PASS\n$/);
      expect(r.procs.map((p) => p.pid)).toEqual([r.pid]);
      expect(fs.readdirSync(c.tmpdir)).toEqual([]);
    }
  });

  test("stdout and stderr of a normal run are byte-identical supervised and in-process (timings aside)", () => {
    for (const mode of ["pass", "error"]) {
      const args = [...baseArgs(), "--dump-messages", "--bogus-flag", "--budget-ms", "5000", "--budget-ms=1"];
      const supervised = run(args, caseDir(), { FAKE_LEAN_MODE: mode });
      const inProcess = run([...args, "--watchdog-ms", "0"], caseDir(), { FAKE_LEAN_MODE: mode });
      const asChild = run(args, caseDir(), { FAKE_LEAN_MODE: mode, QED64_PROBE_CHILD: "1" });
      expect(supervised.status, mode).toBe(mode === "pass" ? 0 : 1);
      childOf(supervised.procs, supervised.pid);
      for (const other of [inProcess, asChild]) {
        expect(other.status, mode).toBe(supervised.status);
        expect(timing(other.stdout), mode).toBe(timing(supervised.stdout));
      }
      // The argument WARNINGs are printed once (the supervisor's); the child drops its repeat.
      expect(timing(supervised.stderr), mode).toBe(timing(inProcess.stderr));
      expect(supervised.stderr.split("\n").filter((l) => l.includes("WARNING"))).toEqual([
        "snapshot-probe: WARNING — unknown flag --bogus-flag ignored",
        "snapshot-probe: WARNING — flag --budget-ms repeated; the first value wins",
      ]);
      expect(supervised.stdout).toContain('[lean:stdout] {"severity":"information"');
    }
  });

  test("started without --stack-size: re-exec in place, then the child runs with --stack-size=8192", () => {
    const c = caseDir();
    const r = run(baseArgs(), c, {}, []);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const parent = r.procs.find((p) => p.pid === r.pid)!;
    expect(parent.execArgv).toEqual(["--stack-size=8192"]);
    expect(childOf(r.procs, r.pid).execArgv).toEqual(["--stack-size=8192"]);
  });
});

describe("snapshot-probe watchdog: signals", () => {
  /** Start a supervised hung probe; resolves once its child is up. */
  async function startHung(c: ReturnType<typeof caseDir>) {
    const proc = spawn(process.execPath, ["--stack-size=8192", probe, ...baseArgs(), "--watchdog-ms", "60000"], {
      cwd: c.d, env: envFor(c, { FAKE_LEAN_MODE: "hang" }), stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr!.on("data", (d) => { stderr += d; });
    proc.stdout!.on("data", () => {});
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 20_000;
    let child: Proc | undefined;
    while (!child && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      child = processes(c.log).find((p) => p.pid !== proc.pid);
    }
    // the child is up; give it time to reach the hung call (its stdout says when)
    await new Promise((r) => setTimeout(r, 300));
    return { proc, child: child!, exited, stderr: () => stderr };
  }
  const kill = (pid: number | undefined) => { if (pid) try { process.kill(pid, "SIGKILL"); } catch {} };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${signal} to the supervisor is passed on: the child dies of it, one FAIL line, exit 1`, async () => {
      const c = caseDir();
      const h = await startHung(c);
      try {
        expect(h.child, "the supervised child never started").toBeDefined();
        h.proc.kill(signal);
        const { code, signal: died } = await h.exited;
        expect([code, died]).toEqual([1, null]);
        expect(h.stderr().split("\n").filter(Boolean)).toEqual([`SNAPSHOT PROBE FAIL: the probe process was killed by ${signal} (${signal} passed on by the supervisor)`]);
        expect(alive(h.child.pid)).toBe(false);
        expect(fs.readdirSync(c.tmpdir)).toEqual([]);
      } finally {
        kill(h.child?.pid);
        kill(h.proc.pid);
      }
    });
  }

  test("a supervisor that is SIGKILLed cannot pass it on: its hung child kills itself within a second", async () => {
    const c = caseDir();
    const h = await startHung(c);
    try {
      expect(h.child, "the supervised child never started").toBeDefined();
      h.proc.kill("SIGKILL");
      await h.exited;
      const deadline = Date.now() + 5000;
      while (alive(h.child.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(alive(h.child.pid)).toBe(false);
    } finally {
      kill(h.child?.pid);
    }
  });
});

test("the compiler battery, which kills a hung probe itself, runs it in-process (--watchdog-ms 0): its SIGKILL must not orphan a child", () => {
  const src = fs.readFileSync(path.join(root, "tests/adversarial/compiler-battery.mjs"), "utf8");
  expect(src).toMatch(/"--watchdog-ms", "0"/);
});
