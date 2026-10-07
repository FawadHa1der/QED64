// snapshot-probe's watchdog (docs/CLI-CONTRACT.md §snapshot-probe, HARDENING #61): unless
// --watchdog-ms 0, a worker thread in the probe process prints one FAIL line and SIGKILLs the
// process past the deadline, because from kernel patch 0037 on a task that never finishes hangs
// lean_wasm_compile, which blocks the probe's main thread. One process: the PID, the exit status
// of a verdict and every per-PID measure stay the probe's.
//
// Safety: no real runtime. The artifact is a FAKE: its bin/lean.js is a stub glue (run by the
// probe through vm.runInThisContext, as the real one is) that implements the exports the probe
// calls and then calls onRuntimeInitialized; FAKE_LEAN_MODE picks what its lean_wasm_compile
// does (pass, an error message, an abort, or a busy loop that never returns, which blocks the
// thread exactly as a hung wasm call does). Every node process the tests start logs its PID
// through a --require preload (NODE_OPTIONS), so "one process" is a fact, not an inference. Every
// child has a SIGKILL timeout, every async one a finally that kills what it started.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SPECS, formatHelp, reservedHit } from "../../pipeline/snapshot/cli.mjs";

const root = path.resolve(__dirname, "../..");
const probe = path.join(root, "pipeline/snapshot/snapshot-probe.mjs");
const WATCHDOG_LINE = (ms: number) => `SNAPSHOT PROBE FAIL: watchdog: no verdict within ${ms} ms (lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on)`;
const CLEARED = ["QED64_LEAN_ARTIFACT", "QED64_LIB_TREE", "QED64_PROFILE_INIT", "NODE_OPTIONS"];

const FAKE_GLUE = `// fake lean.js: the exports snapshot-probe calls, no wasm
const M = globalThis.Module;
const mode = process.env.FAKE_LEAN_MODE || "pass";
// slow-exit: the verdict is printed, then process.exit stalls past the deadline (the verdict won)
if (mode === "slow-exit") {
  const realExit = process.exit;
  process.exit = (c) => { const t = Date.now() + Number(process.env.FAKE_EXIT_DELAY_MS); while (Date.now() < t) {} realExit.call(process, c); };
}
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
/** The run was one process: the PID the caller spawned (the --stack-size re-exec keeps it). */
const oneProcess = (r: { pid: number; procs: Proc[] }) => expect(r.procs.map((p) => p.pid), JSON.stringify(r.procs)).toEqual([r.pid]);
/** Milliseconds in the timing lines vary run to run; everything else must be byte-identical. */
const timing = (s: string) => s.replace(/elapsed=\d+ms/g, "elapsed=<n>ms");

describe("snapshot-probe watchdog", () => {
  test("a compile that never returns: one FAIL line, then the probe's own PID dies of SIGKILL, and no scratch dir is left", () => {
    const c = caseDir();
    const t0 = Date.now();
    const r = run([...baseArgs(), "--watchdog-ms", "1500"], c, { FAKE_LEAN_MODE: "hang" });
    expect([r.status, r.signal]).toEqual([null, "SIGKILL"]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    const lines = r.stderr.split("\n").filter(Boolean);
    expect(lines).toEqual([WATCHDOG_LINE(1500)]);
    expect(SPECS["snapshot-probe"]!.markers.find((m) => m.id === "watchdog")!.regex.test(lines[0]!)).toBe(true);
    expect(SPECS["snapshot-probe"]!.markers.find((m) => m.id === "fail")!.regex.test(lines[0]!)).toBe(true);
    expect(reservedHit(lines[0]!)).toBeNull();
    // the probe printed its lines up to the hung call
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([
      "== load snapshot: probe-input.snap (19 bytes) ==",
      expect.stringMatching(/^load: tag=0 scalar=0 elapsed=\d+ms$/),
      "== compile the probe against the seeded environment ==",
    ]);
    oneProcess(r);
    expect(alive(r.pid)).toBe(false);
    expect(fs.readdirSync(c.tmpdir)).toEqual([]);
  });

  test("a verdict printed before the deadline wins: an exit that stalls past it is not reported as the watchdog", () => {
    const c = caseDir();
    const r = run([...baseArgs(), "--watchdog-ms", "1000"], c, { FAKE_LEAN_MODE: "slow-exit", FAKE_EXIT_DELAY_MS: "2000" });
    expect([r.status, r.signal], r.stderr).toEqual([0, null]);
    expect(r.stdout).toMatch(/\nSNAPSHOT PROBE PASS\n$/);
    expect(r.stderr).toBe("");
    oneProcess(r);
    expect(fs.readdirSync(c.tmpdir)).toEqual([]);
  });

  test("exit codes are the probe's, in one process: 0 PASS, 1 FAIL, 2 a path-rule refusal, 3 an abort", () => {
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
      oneProcess(r);
      expect(r.stderr, name).not.toMatch(/watchdog/);
      expect(fs.readdirSync(c.tmpdir), name).toEqual([]);
      if (name === "no artifact") {
        expect(r.stderr.split("\n").filter(Boolean)).toEqual([
          expect.stringMatching(/^snapshot-probe: no --artifact given and QED64_LEAN_ARTIFACT is unset; the deprecated default .* — pass --artifact <dir> or set QED64_LEAN_ARTIFACT$/),
          `usage: ${SPECS["snapshot-probe"]!.synopsis}`,
        ]);
      }
      if (name === "abort") expect(r.stderr).toBe("ABORT: fake abort\n");
    }
  });

  test("--help, a missing required flag and a malformed --watchdog-ms exit before any side effect", () => {
    const help = caseDir();
    const h = run([...baseArgs(), "--help"], help);
    expect([h.status, h.stdout, h.stderr]).toEqual([0, `${formatHelp("snapshot-probe")}\n`, ""]);
    oneProcess(h);

    const usage = caseDir();
    const u = run(["--snap", snap, "--artifact", art], usage);
    expect([u.status, u.stdout, u.stderr]).toEqual([2, "", `usage: ${SPECS["snapshot-probe"]!.synopsis}\n`]);
    oneProcess(u);

    for (const bad of ["-1", "1.5", "soon"]) {
      const c = caseDir();
      const r = run([...baseArgs(), "--watchdog-ms", bad], c);
      expect(r.status, bad).toBe(2);
      expect(r.stderr.split("\n").filter(Boolean)).toEqual([
        `snapshot-probe: --watchdog-ms takes a whole number of ms, 0 for no watchdog (got ${bad})`,
        `usage: ${SPECS["snapshot-probe"]!.synopsis}`,
      ]);
      expect(reservedHit(r.stderr)).toBeNull();
      oneProcess(r);
      expect(fs.readdirSync(c.tmpdir)).toEqual([]);
    }
  });

  test("--watchdog-ms 0: no watchdog, a hung compile stays hung until the caller kills it", () => {
    const c = caseDir();
    const r = spawnSync(process.execPath, ["--stack-size=8192", probe, ...baseArgs(), "--watchdog-ms", "0"], {
      cwd: c.d, encoding: "utf8", timeout: 2500, killSignal: "SIGKILL", env: envFor(c, { FAKE_LEAN_MODE: "hang" }),
    });
    expect([r.status, r.signal]).toEqual([null, "SIGKILL"]);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/== compile the probe against the seeded environment ==\n$/);
  });

  test("stdout and stderr of a normal run are byte-identical with and without the watchdog (timings aside)", () => {
    for (const mode of ["pass", "error"]) {
      const args = [...baseArgs(), "--dump-messages", "--bogus-flag", "--budget-ms", "5000", "--budget-ms=1"];
      const watched = run(args, caseDir(), { FAKE_LEAN_MODE: mode });
      const unwatched = run([...args, "--watchdog-ms", "0"], caseDir(), { FAKE_LEAN_MODE: mode });
      expect(watched.status, mode).toBe(mode === "pass" ? 0 : 1);
      expect(unwatched.status, mode).toBe(watched.status);
      expect(timing(unwatched.stdout), mode).toBe(timing(watched.stdout));
      expect(timing(unwatched.stderr), mode).toBe(timing(watched.stderr));
      expect(watched.stderr.split("\n").filter((l) => l.includes("WARNING"))).toEqual([
        "snapshot-probe: WARNING — unknown flag --bogus-flag ignored",
        "snapshot-probe: WARNING — flag --budget-ms repeated; the first value wins",
      ]);
      expect(watched.stdout).toContain('[lean:stdout] {"severity":"information"');
    }
  });

  test("started without --stack-size: re-exec in place, still one process", () => {
    const c = caseDir();
    const r = run(baseArgs(), c, {}, []);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    oneProcess(r);
    expect(r.procs[0]!.execArgv).toEqual(["--stack-size=8192"]);
  });
});

describe("snapshot-probe watchdog: a caller's signal reaches the probe itself", () => {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(`${signal} to the spawned PID ends the hung probe, with nothing left behind`, async () => {
      const c = caseDir();
      const proc = spawn(process.execPath, ["--stack-size=8192", probe, ...baseArgs(), "--watchdog-ms", "60000"], {
        cwd: c.d, env: envFor(c, { FAKE_LEAN_MODE: "hang" }), stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout!.on("data", (d) => { stdout += d; });
      proc.stderr!.on("data", (d) => { stderr += d; });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => proc.on("close", (code, sig) => resolve({ code, signal: sig })));
      try {
        const deadline = Date.now() + 20_000;
        while (!stdout.includes("== compile the probe") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
        expect(stdout).toContain("== compile the probe");
        proc.kill(signal);
        // 'close': every stdio pipe closed, so no other process holds them
        expect(await closed).toEqual({ code: null, signal });
        expect(stderr).toBe("");
        expect(processes(c.log).map((p) => p.pid)).toEqual([proc.pid]);
      } finally {
        try { process.kill(proc.pid!, "SIGKILL"); } catch {}
      }
    });
  }
});
