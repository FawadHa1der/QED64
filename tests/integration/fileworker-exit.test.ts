// A resident FileWorker exit is a precise, immediate `died` reason "exit"
// (docs/HARDENING.md #52, the exit hook), proven against the REAL glue and the REAL worker
// script under Node by pipeline/snapshot/fileworker-exit-probe.mjs — one
// process per scenario (the glue evaluates once per global). Each run boots
// the stage1 runtime + init snapshot (~0.5 min) and holds the host's single
// heavy-wasm slot: the probe waits for it (no browser, no node-runner, no
// other `node --stack-size=8192`, free+inactive ≥ 14 GB), so run this file
// on its own:  npx vitest run tests/integration/fileworker-exit.test.ts
//
// QED64_SLOW=1 adds the long controls (an idle session's stall is caught only
// after the next edit, as "wedged"; an exit from an elaboration task is never
// caught) and the batch-path probe.
// From a worktree without build outputs, point QED64_LEAN_ARTIFACT (the stage1
// tree) and QED64_INIT_SNAP (its init.snap) at the main checkout's.

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const probe = path.join(root, "pipeline/snapshot/fileworker-exit-probe.mjs");
const artifact = process.env.QED64_LEAN_ARTIFACT || path.join(root, "pipeline/toolchain/work/build/stage1");
const snap = process.env.QED64_INIT_SNAP || path.join(root, "work/snapshot/init.snap");
const ready = existsSync(path.join(artifact, "bin/lean.js")) && existsSync(snap);
const slow = process.env.QED64_SLOW === "1";
const describeIf = ready ? describe : describe.skip;
const TIMEOUT = 40 * 60_000; // a run is ~1 min; the rest is the probe's wait (≤ 20 min) for the heavy slot

interface Died { code: number | null; reason: string; mode: string; afterTriggerMs: number | null }
interface Verdict {
  ok: boolean;
  why: string;
  hookInstalled: boolean;
  proxiedExits: { index: number; code: number }[];
  onExitCalls: { code: number }[];
  died: Died[];
  latencyMs?: number | null;
  checks?: Record<string, boolean>;
  postDeath?: { lsp: number; status: number; heartbeat: number; died: number; ringWriteAfterDeath: string };
  idle?: {
    diedWithinIdle: boolean;
    glue: { EXITSTATUS: number; keepalive: number };
    worker: { frontDoor: { phase: string; liveness?: { probes: number; answered: number } } };
  };
  afterEdit?: { reason: string; code: number | null; afterEditMs: number } | null;
  compile?: { type?: string; error?: { code: string; message: string } };
}

function run(...args: string[]): Verdict {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "qed64-exit-")), "verdict.json");
  try {
    execFileSync("node", ["--stack-size=8192", probe, "--artifact", artifact, "--snap", snap, "--wait-slot-s", "1200", "--json", out, ...args], {
      timeout: TIMEOUT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { status?: number; stdout?: string };
    // 1 = an expectation failed: the verdict file says which; anything else
    // (setup error, host rule, timeout) has no verdict to assert on.
    if (e.status !== 1 || !existsSync(out)) throw new Error(`probe exited ${e.status}: ${String(e.stdout ?? "").slice(-2000)}`);
  }
  return JSON.parse(readFileSync(out, "utf8")) as Verdict;
}

describeIf("resident FileWorker exit → died 'exit' (real glue, real worker, under Node)", () => {
  test("`exit` notification: forceExit 0 → proxied _proc_exit [0] → died exit 0 at once", { timeout: TIMEOUT }, () => {
    const v = run("--scenario", "exit");
    expect(v.hookInstalled).toBe(true);
    expect(v.checks).toBeDefined();
    expect(v.died).toHaveLength(1);
    expect(v.died[0]).toMatchObject({ reason: "exit", code: 0, mode: "resident" });
    expect(v.latencyMs!).toBeLessThan(5000);
    expect(v.proxiedExits.some((p) => p.index === 0 && p.code === 0)).toBe(true);
    // The glue's own exit path stays silent: the keepalive is held.
    expect(v.onExitCalls).toHaveLength(0);
    // The death path on a runtime that is not quiescent (the exiting thread
    // parked, the others alive): nothing dies twice, the timers stop, a page
    // edit is dropped and a ring write refused.
    expect(v.postDeath!.died).toBe(0);
    expect(v.postDeath!.heartbeat).toBe(0);
    expect(v.postDeath!.ringWriteAfterDeath).toMatch(/^refused/);
    expect(v.ok, v.why).toBe(true);
  });

  test("`shutdown` + `exit`: the param-less request kills the main loop first → died exit 1", { timeout: TIMEOUT }, () => {
    const v = run("--scenario", "shutdown-exit");
    expect(v.died).toHaveLength(1);
    expect(v.died[0]).toMatchObject({ reason: "exit", code: 1, mode: "resident" });
    expect(v.proxiedExits.some((p) => p.index === 0 && p.code === 1)).toBe(true);
    expect(v.ok, v.why).toBe(true);
  });

  test("`#eval IO.Process.exit 3` typed in the buffer: exit() → exitOnMainThread [1] → died exit 3", { timeout: TIMEOUT }, () => {
    const v = run("--scenario", "eval-exit");
    expect(v.died).toHaveLength(1);
    expect(v.died[0]).toMatchObject({ reason: "exit", code: 3, mode: "resident" });
    expect(v.latencyMs!).toBeLessThan(5000);
    expect(v.proxiedExits.some((p) => p.index === 1 && p.code === 3)).toBe(true);
    expect(v.onExitCalls).toHaveLength(0);
    expect(v.ok, v.why).toBe(true);
  });

  test("control, hook removed: the exit runs (EXITSTATUS set) and nothing reports it", { timeout: TIMEOUT }, () => {
    // Code 1, not the `exit` scenario's 0: callMain's own exitJS(0) already
    // left EXITSTATUS at 0 when the loop opened, so only a non-zero code
    // shows the proxied exit ran on this thread and was swallowed there.
    const v = run("--scenario", "shutdown-exit", "--no-hook", "--idle-ms", "15000");
    expect(v.hookInstalled).toBe(true); // the worker installed it; the control took it back out
    expect(v.proxiedExits.some((p) => p.index === 0 && p.code === 1)).toBe(true);
    expect(v.idle!.diedWithinIdle).toBe(false);
    expect(v.idle!.glue.EXITSTATUS).toBe(1);
    expect(v.onExitCalls).toHaveLength(0);
    expect(v.ok, v.why).toBe(true);
  });

  test.runIf(slow)("control, hook removed: an idle session is caught only after the next edit, as 'wedged'", { timeout: TIMEOUT }, () => {
    const v = run("--scenario", "exit", "--no-hook", "--idle-ms", "20000", "--edit-after-idle");
    expect(v.idle!.diedWithinIdle).toBe(false);
    expect(v.afterEdit).toMatchObject({ reason: "wedged" });
    expect(v.ok, v.why).toBe(true);
  });

  test.runIf(slow)("control, hook removed: an exit from an elaboration task is never caught at all", { timeout: TIMEOUT }, () => {
    // The user-reachable exit leaves the FileWorker's main loop alive (only
    // the elaboration task's pthread unwound), so the #52 liveness probe is
    // answered and the page shows "elaborating" forever: the hook is the
    // only detector of this death.
    const v = run("--scenario", "eval-exit", "--no-hook", "--idle-ms", "40000");
    expect(v.proxiedExits.some((p) => p.index === 1 && p.code === 3)).toBe(true);
    expect(v.died).toHaveLength(0);
    expect(v.idle!.glue.EXITSTATUS).toBe(3);
    expect(v.idle!.worker.frontDoor.phase).toBe("elaborating");
    expect(v.idle!.worker.frontDoor.liveness!.answered).toBeGreaterThan(0);
    expect(v.ok, v.why).toBe(true);
  });

  test.runIf(slow)("batch path (no loop open): the exit runs on the main thread and fails the compile", { timeout: TIMEOUT }, () => {
    // Batch compiles elaborate on the runtime thread itself: exitJS calls
    // _proc_exit directly (no proxied call, nothing for the hook to see) and
    // the ExitStatus unwinds out of lean_wasm_compile into the error reply.
    // The app's only batch compile is the import-only warm header.
    const v = run("--scenario", "batch-eval-exit");
    expect(v.ok, v.why).toBe(true);
    expect(v.proxiedExits).toHaveLength(0);
    expect(v.died).toHaveLength(0);
    expect(v.compile).toMatchObject({ type: "error", error: { code: "COMPILE_CRASHED", message: "Program terminated with exit(3)" } });
  });
});
