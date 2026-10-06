// Pins the pure helpers of the adversarial harness (review C7): `--only`
// matches whole names, the page URL determines the pairing the run boots,
// and the pill's terminal classes map onto the corpus's `expect.terminal`.
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MODE, batteryArgv, coolDown, laneSections, memoryReading, onlyMatches, parseMeminfo, parseVmStat, resolveTarget, settleClass, settleClassFromPhase, suiteExitCode } from "../../tests/adversarial/harness.mjs";
import { classify, missingInputs } from "../../tests/adversarial/compiler-battery.mjs";

describe("onlyMatches", () => {
  test("a plain name matches exactly, never as a substring", () => {
    expect(onlyMatches("import-composition", "import-composition")).toBe(true);
    expect(onlyMatches("unresolvable-import-composition", "import-composition")).toBe(false);
  });
  test("a pattern is anchored to the whole name", () => {
    expect(onlyMatches("switch-init", "switch-.*")).toBe(true);
    expect(onlyMatches("rapid-example-switch-storm", "switch-.*")).toBe(false);
    expect(onlyMatches("undo-redo-storm-15x", "undo|redo")).toBe(false);
    expect(onlyMatches("undo", "undo|redo")).toBe(true);
  });
});

describe("resolveTarget", () => {
  test("default page → mutable manifest, /snapshots/, resident (the only transport since 2026-09-04)", () => {
    const t = resolveTarget("http://localhost:5187/");
    expect(t).toMatchObject({ mode: "resident", runtimeOverride: null, snapshotsDir: "snapshots",
      manifestUrl: "http://localhost:5187/runtime/runtime-manifest.json", indexUrl: "http://localhost:5187/snapshots/index.json" });
    expect(MODE).toBe("resident");
  });
  test("a stale ?resident= query no longer selects anything (the page ignores it; the run dir stays resident)", () => {
    expect(resolveTarget("http://localhost:5184/?resident=0").mode).toBe("resident");
    expect(resolveTarget("http://localhost:5184/?resident=1").mode).toBe("resident");
  });
  test("dev overrides follow qed64-boot.ts (?runtime=, ?snapshots=)", () => {
    const t = resolveTarget("http://localhost:5184/?runtime=wasm64-464463c696d9aa2d&snapshots=snapshots-0031");
    expect(t).toMatchObject({ mode: "resident", runtimeOverride: "wasm64-464463c696d9aa2d", snapshotsDir: "snapshots-0031",
      manifestUrl: "http://localhost:5184/runtime/runtime-manifest.wasm64-464463c696d9aa2d.json", indexUrl: "http://localhost:5184/snapshots-0031/index.json" });
  });
});

describe("settleClass", () => {
  test("maps the page's pill labels (main.ts PHASE_LABEL) onto the terminal enum", () => {
    expect(settleClass("ready")).toBe("ready");
    expect(settleClass("ready — 3 s")).toBeNull();
    expect(settleClass("imports incomplete — finish the import line to continue")).toBe("headerUnresolvable");
    expect(settleClass("imports failed")).toBe("headerUnresolvable");
    expect(settleClass("the checker keeps crashing on this content — edit the file to retry")).toBe("halted");
    // The breaker on a session that had reached ready: "halted — <reason>".
    expect(settleClass("halted — heartbeat")).toBe("halted");
    expect(settleClass("elaborating")).toBeNull();
    expect(settleClass("the checker crashed — restarting (~15 s)")).toBeNull();
  });
  test("the phase enum is the primary oracle: ready / headerRefused / halted are terminal, the rest are not", () => {
    expect(settleClassFromPhase("ready")).toBe("ready");
    expect(settleClassFromPhase("headerRefused")).toBe("headerUnresolvable");
    expect(settleClassFromPhase("halted")).toBe("halted");
    for (const ph of ["booting", "starting", "elaborating", "dead", null]) expect(settleClassFromPhase(ph)).toBeNull();
  });
});

describe("compiler-battery classify", () => {
  // What snapshot-probe --dump-messages prints for an unresolvable header:
  // Lean's own wording (Lean/Util/Path.lean) contains "No directory", which
  // must read as the compiler's verdict, never as harness infrastructure.
  const unresolvable = [
    "== load snapshot: mathlib.snap (1234 bytes) ==",
    "load: tag=0 scalar=0 elapsed=9000ms",
    "== compile the probe against the seeded environment ==",
    `[lean:stdout] {"caption":"","severity":"error","pos":{"line":1,"column":0},"data":"unknown module prefix 'ZZZ'\\n\\nNo directory 'ZZZ' or file 'ZZZ.olean' in the search path entries:\\n/lib/lean"}`,
    "compile: tag=1 elapsed=40ms errors=1",
    "  error: unknown module prefix 'ZZZ'\n\nNo directory 'ZZZ' or file 'ZZZ.olean' in the search path entries",
    "SNAPSHOT PROBE FAIL: probe compile failed",
  ].join("\n");
  const item = (expect: Record<string, unknown>) => ({ name: "header-bogus-roots", category: "imports/header-import", expect: { panicFree: true, ...expect } });

  test("Lean's 'No directory' import error is a product verdict: mustError passes, mustSucceed fails", () => {
    const pass = classify(item({ mustError: true }), { out: unresolvable, code: 1, wallMs: 9000, budget: 20000 });
    expect(pass.outcome).toBe("pass");
    expect(pass.failures).toEqual([]);
    const fail = classify(item({ mustSucceed: true }), { out: unresolvable, code: 1, wallMs: 9000, budget: 20000 });
    expect(fail.outcome).toBe("fail");
    expect(fail.failures).toContain("expected success, saw errors");
  });

  test("a probe that died before its compile step is infra; a panic there is not", () => {
    const dead = "== load snapshot: mathlib.snap ==\nError: ENOENT: no such file or directory, open '/x/lib-tree-slim'\n";
    const r = classify(item({ mustError: true }), { out: dead, code: 1, wallMs: 100, budget: 20000 });
    expect(r.outcome).toBe("infra");
    expect(r.failures[0]).toMatch(/^infra: Error: ENOENT/);
    const spawn = classify(item({ mustSucceed: true }), { out: "", code: 1, wallMs: 1, budget: 20000, spawnError: Object.assign(new Error("spawn node EACCES"), { code: "EACCES" }) });
    expect(spawn.outcome).toBe("infra");
    const panic = classify(item({ mustSucceed: true }), { out: "== load snapshot ==\nPANIC at Lean.Environment.find? Lean.Environment:123\nABORT: unreachable\n", code: 3, wallMs: 100, budget: 20000 });
    expect(panic.outcome).toBe("fail");
    expect(panic.failures).toContain("PANIC detected in output");
  });

  test("a clean compile passes mustSucceed; the hang and budget checks still apply", () => {
    const ok = "== compile the probe against the seeded environment ==\ncompile: tag=0 elapsed=30ms errors=0\nSNAPSHOT PROBE PASS\n";
    expect(classify(item({ mustSucceed: true }), { out: ok, code: 0, wallMs: 12000, budget: 20000 }).outcome).toBe("pass");
    const hung = classify(item({ mustSucceed: true }), { out: "== load snapshot ==\n", code: null, wallMs: 80000, budget: 20000 });
    expect(hung.outcome).toBe("fail");
    expect(hung.failures).toContain("killed (hang)");
  });

  test("missing snapshot or runtime is decided from the harness's inputs, before any probe", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-battery-"));
    try {
      const art = path.join(tmp, "stage1");
      fs.mkdirSync(path.join(art, "bin"), { recursive: true });
      const snap = path.join(tmp, "mathlib.snap");
      expect(missingInputs({ snap, artifact: art })).toEqual([snap, path.join(art, "bin/lean.wasm")]);
      fs.writeFileSync(snap, "x");
      fs.writeFileSync(path.join(art, "bin/lean.wasm"), "\0asm");
      expect(missingInputs({ snap, artifact: art })).toEqual([]);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("corpus", () => {
  test("editor-action items carry only keys the e2e lane evaluates", () => {
    const corpus = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../adversarial/corpus.json"), "utf8"));
    const actionItems = corpus.items.filter((it: { actions?: unknown[] }) => Array.isArray(it.actions) && it.actions.length);
    expect(actionItems.length).toBeGreaterThan(0);
    for (const it of actionItems) {
      for (const dead of ["containsMsgs", "budgetMs", "mustError"]) expect(it.expect, it.name).not.toHaveProperty(dead);
      if (it.expect.terminal) expect(["ready", "headerUnresolvable", "halted"]).toContain(it.expect.terminal);
    }
    expect(actionItems.find((it: { name: string }) => it.name === "unresolvable-import-composition").expect.terminal).toBe("headerUnresolvable");
  });
});

describe("run.mjs: the battery's argv, the merged report's lanes, the suite's exit code", () => {
  test("--snap/--artifact/--lib given to run.mjs are forwarded after --run-dir; absent ones are not", () => {
    const given: Record<string, string> = { snap: "/p/m.snap", lib: "/p/slim" };
    expect(batteryArgv("/run", (f: string, d: string) => given[f] ?? d)).toEqual(["--run-dir", "/run", "--snap", "/p/m.snap", "--lib", "/p/slim"]);
    expect(batteryArgv("/run", (_f: string, d: string) => d)).toEqual(["--run-dir", "/run"]);
  });
  test("the battery's 2 (path-rule refusal) and any lane's 3 are refusals (3); other failures 1; green 0", () => {
    expect(suiteExitCode(2, 0)).toBe(3);
    expect(suiteExitCode(2, 1)).toBe(3);
    expect(suiteExitCode(3, 0)).toBe(3);
    expect(suiteExitCode(0, 3)).toBe(3);
    expect(suiteExitCode(1, 0)).toBe(1);
    expect(suiteExitCode(0, 1)).toBe(1);
    expect(suiteExitCode(0, 0)).toBe(0);
  });
  test("a lane that ran and left no report is a REFUSED / NO REPORT line, never silently absent; a lane that did not run is absent", () => {
    expect(laneSections([{ name: "compiler", report: null, code: 2, log: "compiler.log" }])[0])
      .toBe("## compiler: REFUSED (exit 2: no compiler-report.json was written; see compiler.log)");
    expect(laneSections([{ name: "e2e", report: null, code: 1, log: "run.log" }])[0]).toBe("## e2e: NO REPORT (exit 1: no e2e-report.json was written; see run.log)");
    expect(laneSections([{ name: "compiler", report: null, code: null, log: "x" }, { name: "e2e", report: null, code: 0, log: "x" }])).toEqual([]);
  });
  test("the battery's refusal report: the tally, the REFUSED reason, one INFRA row per item", () => {
    const why = "compiler-battery: no --snap given and QED64_MATHLIB_SNAP is unset — pass --snap <file> or set QED64_MATHLIB_SNAP";
    const report = { lane: "compiler", total: 2, failed: 2, infra: 2, refused: why,
      results: ["a", "b"].map((name) => ({ name, category: "c", outcome: "infra", pass: false, failures: [`infra: ${why}`] })) };
    expect(laneSections([{ name: "compiler", report, code: 2, log: "compiler.log" }])).toEqual([
      "## compiler: 0/2 passed (fail 0, infra 2, aborted 0)", "",
      `**REFUSED (exit 2):** ${why}`, "",
      `- **INFRA** \`a\` [c] — infra: ${why}`,
      `- **INFRA** \`b\` [c] — infra: ${why}`, "",
    ]);
  });
  test("run.mjs builds its argv, report and exit code from these helpers", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../tests/adversarial/run.mjs"), "utf8");
    expect(src).toContain("...batteryArgv(dir)");
    expect(src).toContain("laneSections([");
    expect(src).toContain("process.exit(suiteExitCode(");
    expect(src).not.toContain("filter(Boolean)");
  });
});

// The cool-down's memory reading (plan step A3b): macOS vm_stat, else Linux
// /proc/meminfo, else os.freemem(), else a REFUSED line. VM_STAT is captured
// on the owner's Apple Silicon Mac (2026-10-06); MEMINFO is the Linux format
// (procfs, `fs/proc/meminfo.c`), with MEMINFO_OLD as a pre-3.14 kernel prints
// it (no MemAvailable).
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     9839.
Pages active:                                 964521.
Pages inactive:                               929689.
Pages speculative:                             34593.
Pages throttled:                                   0.
Pages wired down:                             287723.
Pages purgeable:                                 993.
"Translation faults":                      951434378.
Pages copy-on-write:                        38483871.
Pages zero filled:                         623042842.
Pages reactivated:                          69380345.
Pages purged:                                4818633.
File-backed pages:                            230159.
Anonymous pages:                             1698644.
Pages stored in compressor:                  1575958.
Pages occupied by compressor:                  72954.
Decompressions:                             44312146.
Compressions:                               95683436.
Pageins:                                    25160470.
Pageouts:                                      78469.
Swapins:                                     2420500.
Swapouts:                                    5638650.
`;
const MEMINFO = `MemTotal:       16303428 kB
MemFree:          812344 kB
MemAvailable:    9876544 kB
Buffers:          254112 kB
Cached:          8420096 kB
SwapCached:            0 kB
Active:          7208120 kB
Inactive:        6721904 kB
HugePages_Total:       0
Hugepagesize:       2048 kB
`;
const MEMINFO_OLD = `MemTotal:        8174352 kB
MemFree:          512000 kB
Buffers:          100000 kB
Cached:          2000000 kB
SwapCached:            0 kB
`;

describe("the cool-down's memory reading", () => {
  test("parseVmStat: free + inactive + speculative pages times the page size; null without the counts", () => {
    expect(parseVmStat(VM_STAT)).toBe((9839 + 929689 + 34593) * 16384);
    expect(parseVmStat(VM_STAT.replace("page size of 16384", "page size of 4096"))).toBe((9839 + 929689 + 34593) * 4096);
    expect(parseVmStat("")).toBeNull();
    expect(parseVmStat("zsh: command not found: vm_stat")).toBeNull();
    expect(parseVmStat(VM_STAT.replace(/^Pages free:.*\n/m, ""))).toBeNull();
  });

  test("parseMeminfo: MemAvailable, else MemFree + Buffers + Cached; null without them", () => {
    expect(parseMeminfo(MEMINFO)).toBe(9876544 * 1024);
    expect(parseMeminfo(MEMINFO_OLD)).toBe((512000 + 100000 + 2000000) * 1024);
    expect(parseMeminfo("")).toBeNull();
    expect(parseMeminfo("MemTotal: 1 kB\n")).toBeNull();
  });

  const enoent = Object.assign(new Error("spawnSync vm_stat ENOENT"), { code: "ENOENT" });
  const noProc = () => { throw Object.assign(new Error("no such file"), { code: "ENOENT" }); };
  test("memoryReading: vm_stat on macOS; without it /proc/meminfo, then os.freemem(); else a reason naming each", () => {
    expect(memoryReading({ platform: "darwin", vmStat: () => ({ stdout: VM_STAT, status: 0 }), meminfo: noProc, freemem: () => 1 }))
      .toEqual({ bytes: (9839 + 929689 + 34593) * 16384, source: "vm_stat (free + inactive + speculative)" });
    expect(memoryReading({ platform: "darwin", vmStat: () => ({ stdout: null, status: null, error: enoent }), meminfo: () => MEMINFO, freemem: () => 1 }))
      .toEqual({ bytes: 9876544 * 1024, source: "/proc/meminfo" });
    expect(memoryReading({ platform: "darwin", vmStat: () => ({ stdout: null, status: null, error: enoent }), meminfo: noProc, freemem: () => 8e9 }))
      .toEqual({ bytes: 8e9, source: "os.freemem() (free pages only)" });
    expect(memoryReading({ platform: "linux", vmStat: () => { throw new Error("vm_stat must not run off macOS"); }, meminfo: () => MEMINFO_OLD, freemem: () => 1 }))
      .toEqual({ bytes: (512000 + 100000 + 2000000) * 1024, source: "/proc/meminfo" });
    expect(memoryReading({ platform: "darwin", vmStat: () => ({ stdout: null, status: null, error: enoent }), meminfo: noProc, freemem: () => 0 }))
      .toEqual({ bytes: null, reason: "no memory reading (vm_stat ENOENT; /proc/meminfo ENOENT; os.freemem() returned 0)" });
    expect(memoryReading({ platform: "linux", meminfo: () => "garbage", freemem: () => { throw new Error("unsupported"); } }))
      .toEqual({ bytes: null, reason: "no memory reading (/proc/meminfo has no MemAvailable or MemFree; os.freemem() threw unsupported)" });
  });

  test("coolDown: names the reading's source, passes with enough memory, and REFUSES without a reading", async () => {
    const log: string[] = [];
    const ok = await coolDown({ minFreeGB: 6, maxWaitS: 0, log: (l) => log.push(l), strays: () => [], reading: () => ({ bytes: 7 * 1024 ** 3, source: "/proc/meminfo" }) });
    expect(ok).toBe(true);
    expect(log).toEqual(["cool-down: memory from /proc/meminfo", "cool-down: 7.0 GB reclaimable (need 6) after 0 s — ok"]);
    log.length = 0;
    const refused = await coolDown({ minFreeGB: 6, maxWaitS: 0, log: (l) => log.push(l), strays: () => [], reading: () => ({ bytes: null, reason: "no memory reading (vm_stat ENOENT; /proc/meminfo ENOENT; os.freemem() returned 0)" }) });
    expect(refused).toBe(false);
    expect(log).toEqual(["cool-down: REFUSED — no memory reading (vm_stat ENOENT; /proc/meminfo ENOENT; os.freemem() returned 0)"]);
    log.length = 0;
    expect(await coolDown({ minFreeGB: 6, maxWaitS: 0, log: (l) => log.push(l), strays: () => ["123 chrome-headless-shell --x"], reading: () => { throw new Error("not read while a browser is alive"); } })).toBe(false);
    expect(log[0]).toMatch(/^cool-down: 1 chrome-headless-shell process\(es\) alive .* refusing to start a browser lane:/);
  });
});
