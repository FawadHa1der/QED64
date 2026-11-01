// A Lean option reaches the resident FileWorker (architecture review R3): the
// headless check of the page's `ResidentHost.leanOptions` channel. It runs
// pipeline/snapshot/resident-probe.mjs, which builds its command line with
// public/workers/worker-constants.js's residentArgv (the merge lean.worker.js
// runs at boot) and the page's thread setup, on the document
// `def idA (x : α) : α := x`. With `--lean-option autoImplicit=false` Lean must
// refuse the auto-bound α; without it (the control) the document elaborates
// and the probe's `--option-check` verdict is FAIL. Each run takes a few
// seconds (it boots the stage1 runtime and init snapshot under Node) and is a
// heavy wasm process: run this file on its own, through the host's
// heavy-process lock:
//   npx vitest run tests/integration/lean-options.test.ts
//
// The inputs are the integration tier's two: QED64_LEAN_ARTIFACT (the stage1
// tree) and QED64_INIT_SNAP (its init.snap; the probe gets that file's
// directory as --snap-dir and reads <snap-dir>/init.snap, so the file must be
// named init.snap). QED64_SNAP_DIR (the dir holding init.snap), when set,
// takes precedence over QED64_INIT_SNAP. Only with neither snapshot variable
// set does it take (deprecated, with a WARNING) this checkout's work/snapshot,
// as it takes pipeline/toolchain/work/build/stage1 without
// QED64_LEAN_ARTIFACT: a given init.snap is never swapped for a stale one.
// Without them the suite skips and names the variables.

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { toolPath } from "../../pipeline/toolchain/artifact-paths.mjs";

const root = path.resolve(__dirname, "../..");
const probe = path.join(root, "pipeline/snapshot/resident-probe.mjs");
const input = (env: string, rel: string, holds: (p: string) => boolean) => {
  const found = toolPath({ env, legacy: path.join(root, rel), holds });
  if (found?.source === "default") console.warn(`lean-options: WARNING — the default ${rel} is deprecated; set ${env} (docs/CLI-CONTRACT.md)`);
  return found?.path ?? "";
};
const artifact = input("QED64_LEAN_ARTIFACT", "pipeline/toolchain/work/build/stage1", (d) => existsSync(path.join(d, "bin/lean.js")));
const initSnap = process.env.QED64_INIT_SNAP;
const snapDir = process.env.QED64_SNAP_DIR || !initSnap
  ? input("QED64_SNAP_DIR", "work/snapshot", (d) => existsSync(path.join(d, "init.snap")))
  : path.basename(initSnap) === "init.snap" ? path.dirname(path.resolve(initSnap)) : "";
if (!process.env.QED64_SNAP_DIR && initSnap && !snapDir) console.warn(`lean-options: QED64_INIT_SNAP (${initSnap}) is not named init.snap, which resident-probe reads from its --snap-dir; set QED64_SNAP_DIR`);
const ready = !!artifact && !!snapDir && existsSync(path.join(artifact, "bin/lean.js")) && existsSync(path.join(snapDir, "init.snap"));
if (!ready) console.warn("lean-options: skipped — set QED64_LEAN_ARTIFACT (a stage1 dir) and QED64_INIT_SNAP (its init.snap) or QED64_SNAP_DIR (the dir holding it)");
const describeIf = ready ? describe : describe.skip;
const TIMEOUT = 20 * 60_000;

interface Verdict {
  ok: boolean;
  why: string;
  progressDrained: boolean;
  argv: string[];
  optionError: boolean;
}

function run(...extra: string[]): Verdict {
  // The probe's experiment switches would change its document or its setup.
  const env = { ...process.env };
  for (const name of ["PROBE_HEADER", "PROBE_MINIMAL", "SKIP_TASK_MANAGER", "DUMP_MSGS", "RAW_TAP"]) delete env[name];
  let stdout: string;
  try {
    stdout = execFileSync("node", [probe, "--artifact", artifact, "--snap-dir", snapDir, "--budget-ms", "300000", "--option-check", ...extra], {
      timeout: TIMEOUT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env,
    });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    // 1 = the probe's FAIL verdict; anything else (setup error, timeout) has no verdict to assert on.
    if (e.status !== 1) throw new Error(`resident-probe exited ${e.status}: ${String(e.stderr ?? "").slice(-1000)}${String(e.stdout ?? "").slice(-2000)}`);
    stdout = String(e.stdout ?? "");
  }
  const lines = [...stdout.matchAll(/^RESIDENT PROBE (PASS|FAIL) (\{.*\})$/gm)];
  const last = lines.at(-1);
  if (!last) throw new Error(`resident-probe printed no verdict: ${stdout.slice(-2000)}`);
  const v = JSON.parse(last[2]!) as Verdict;
  expect(v.ok).toBe(last[1] === "PASS");
  return v;
}

describeIf("Lean options reach the resident FileWorker (resident-probe --option-check, the page's argv)", () => {
  test("--lean-option autoImplicit=false: Lean refuses the auto-bound α (PASS), merged over the page's defaults", { timeout: TIMEOUT }, () => {
    const v = run("--lean-option", "autoImplicit=false");
    expect(v.why).toMatch(/^option-check: /);
    expect(v.ok).toBe(true);
    expect(v.optionError).toBe(true);
    expect(v.argv).toEqual(["--worker", "-Dserver.reportDelayMs=0", "-DElab.async=false", "-DautoImplicit=false"]);
  });

  test("the control, no --lean-option: the page's default argv, α is auto-bound, the check FAILs", { timeout: TIMEOUT }, () => {
    const v = run();
    expect(v.why).toMatch(/^option-check: /);
    expect(v.progressDrained).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.optionError).toBe(false);
    expect(v.argv).toEqual(["--worker", "-Dserver.reportDelayMs=0", "-DElab.async=false"]);
  });
});
