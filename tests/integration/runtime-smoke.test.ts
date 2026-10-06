// Integration: drive the real wasm64 Lean runtime under Node through the
// pipeline runner. These tests exercise the exact bytes the browser runs.
//
// Tiers:
//   default   — prelude parse (seconds) + Init import proof (~30-60 s)
//   QED64_SLOW=1 — adds `import Lean` metaprogram check and snapshot baking
//
// Since the keepalive guard (toolchain patch 0020) and the resident transport
// (0031) the one-shot CLI does its work and then never exits (docs/HARDENING.md
// #47), so a run is judged by its OUTPUT, not by an exit status: every run goes
// through pipeline/snapshot/supervised-run.mjs (docs/CLI-CONTRACT.md), which
// compiles to a target file, fails on a Lean error line, and reaps the
// kept-alive runner once the target is written and the output has gone quiet.
// `status` below is that verdict: 0 done, 1 failed.
//
// The artifact tree is QED64_LEAN_ARTIFACT, else (deprecated, with a WARNING)
// this checkout's pipeline/toolchain/work/build/stage1 (docs/CLI-CONTRACT.md
// "Path resolution"); skip everything gracefully, naming the variable, when
// neither holds a runtime (e.g. CI without the toolchain volume), or when it
// predates 0020: such a runtime exits on its own, is not the one the browser
// runs, and once let these tests pass while the served one timed out. From a
// worktree without build outputs, point QED64_LEAN_ARTIFACT at the main
// checkout's pipeline/toolchain/work/build/stage1.
//
// Each run is one heavy wasm process; run this suite under the host's browser
// lock, one file at a time (`--no-file-parallelism`).

import { afterEach, describe, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toolPath } from "../../pipeline/toolchain/artifact-paths.mjs";

const root = path.resolve(__dirname, "../..");
const supervisor = path.join(root, "pipeline/snapshot/supervised-run.mjs");
const found = toolPath({
  env: "QED64_LEAN_ARTIFACT",
  legacy: path.join(root, "pipeline/toolchain/work/build/stage1"),
  holds: (dir) => existsSync(path.join(dir, "bin/lean.js")),
});
if (found?.source === "default") console.warn(`runtime-smoke: WARNING — the default artifact ${found.path} is deprecated; set QED64_LEAN_ARTIFACT (docs/CLI-CONTRACT.md)`);
const artifact = found?.path ?? "";
const haveArtifact = !!found && existsSync(path.join(artifact, "bin/lean.js"));
// Patch 0020 makes the glue's checkMailbox hold a runtime keepalive across the
// mailbox service; that keepalive is what keeps the CLI alive after main.
const keptAlive =
  haveArtifact &&
  /checkMailbox\s*=\s*\(\)\s*=>\s*\{[^}]*runtimeKeepalivePush\(\)/.test(
    readFileSync(path.join(artifact, "bin/lean.js"), "utf8"),
  );
const slow = process.env.QED64_SLOW === "1";

const skipReason = !haveArtifact
  ? `no wasm64 runtime ${found ? `at ${artifact}` : "(QED64_LEAN_ARTIFACT is unset and this checkout has no pipeline/toolchain/work/build/stage1)"}: set QED64_LEAN_ARTIFACT to a stage1 dir`
  : !keptAlive
    ? `${artifact} predates toolchain patch 0020 (its CLI exits after main), so it is not ` +
      "the runtime the browser runs; set QED64_LEAN_ARTIFACT to the paired stage1 " +
      "(pipeline/toolchain/work/build/stage1 in the main checkout)"
    : null;
if (skipReason) console.warn(`runtime-smoke: skipped — ${skipReason}`);

const describeIf = skipReason ? describe.skip : describe;

interface RunResult {
  stdout: string; // the runner's stdout, then supervised-run's verdict line
  stderr: string;
  status: number | null; // supervised-run's verdict: 0 done, 1 failed
}

interface Budget {
  quietMs: number; // supervised-run --quiet-ms
  stableMs: number; // supervised-run --stable-ms
  giveUpMs: number; // supervised-run --give-up-ms; the test timeout must exceed it by a minute
}

const QUICK: Budget = { quietMs: 3_000, stableMs: 2_000, giveUpMs: 120_000 };
const IMPORT: Budget = { ...QUICK, giveUpMs: 240_000 };

// supervised-run leads its own process group (`detached`), so a stuck run can
// be stopped together with the runner it spawned, by our own PID only.
const live = new Set<ChildProcess>();
const killGroup = (child: ChildProcess) => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
};
// A test that timed out must not leave its runner holding the heavy slot.
afterEach(() => {
  for (const child of live) killGroup(child);
  live.clear();
});

function supervise(target: string, runnerArgs: string[], budget: Budget): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [supervisor, "--target", target,
        "--quiet-ms", String(budget.quietMs), "--stable-ms", String(budget.stableMs),
        "--give-up-ms", String(budget.giveUpMs), "--", ...runnerArgs],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    live.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (s: string) => (stdout += s));
    child.stderr!.setEncoding("utf8").on("data", (s: string) => (stderr += s));
    // supervised-run gives up on its own at --give-up-ms; this only covers a
    // supervisor that is itself stuck.
    const backstop = setTimeout(() => killGroup(child), budget.giveUpMs + 30_000);
    child.on("close", (code) => {
      clearTimeout(backstop);
      live.delete(child);
      resolve({ stdout, stderr, status: code });
    });
  });
}

/** Compile `source` as /work/input.lean to /work/input.olean and judge the run. */
async function runLean(source: string, budget: Budget = IMPORT): Promise<RunResult> {
  const work = mkdtempSync(path.join(tmpdir(), "qed64-run-"));
  try {
    writeFileSync(path.join(work, "input.lean"), source);
    return await supervise(
      path.join(work, "input.olean"),
      ["--artifact", artifact, "--work", work, "--", "-o", "/work/input.olean", "/work/input.lean"],
      budget,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describeIf("wasm64 runtime under Node", () => {
  test("prelude file parses instantly (no artifact loads)", { timeout: 180_000 }, async () => {
    const r = await runLean("prelude\nset_option linter.all false\n", QUICK);
    expect(r.status).toBe(0);
    // Patch 0031 moved the progress line to stderr.
    expect(r.stdout + r.stderr).toContain("Loading 0 modules");
  });

  test(
    "Init import: numBits=64, rfl proof kernel-checked, theorem printed",
    { timeout: 300_000 },
    async () => {
      const r = await runLean(
        [
          "#eval System.Platform.numBits",
          "",
          "example : (2 + 2 : Nat) = 4 := by rfl",
          "",
          "theorem qed64_smoke (a b : Nat) : a + b = b + a := Nat.add_comm a b",
          "#check qed64_smoke",
        ].join("\n"),
      );
      expect(r.status).toBe(0);
      // `64` on a line of its own (stdout opens with it since 0031 moved the
      // progress line to stderr).
      expect(r.stdout).toMatch(/^64$/m);
      expect(r.stdout).toContain("qed64_smoke (a b : Nat) : a + b = b + a");
      expect(r.stdout).not.toMatch(/error/i);
    },
  );

  test(
    "a broken proof fails with a positioned error and a failed verdict",
    { timeout: 300_000 },
    async () => {
      const r = await runLean("example : (1 + 1 : Nat) = 3 := by rfl\n");
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/input\.lean:1:\d+: error/);
    },
  );

  test(
    "sorry produces a warning, not an error, and the run is done",
    { timeout: 300_000 },
    async () => {
      const r = await runLean("theorem hard : 1 = 1 := by sorry\n");
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/warning.*sorry|declaration uses 'sorry'/);
    },
  );
});

const describeSlow = !skipReason && slow ? describe : describe.skip;

describeSlow("wasm64 runtime — slow tier (QED64_SLOW=1)", () => {
  test(
    "import Lean loads the full 2,308-module closure and runs metaprograms",
    { timeout: 660_000 },
    async () => {
      const r = await runLean(
        [
          "import Lean",
          "#eval System.Platform.numBits",
          "open Lean in",
          '#eval do let env ← importModules #[] {} ; pure ()',
          "example : (1 + 1 : Nat) = 2 := by rfl",
        ].join("\n"),
        { ...QUICK, giveUpMs: 600_000 },
      );
      // The verdict first: a metaprogram that throws is a Lean error line, a
      // failed run, while `64` is already printed (and the verdict line's
      // elapsed time can contain "64" too).
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^64$/m);
      expect(r.stdout).not.toMatch(/error/i);
    },
  );

  test(
    "snapshot bake: --incr-header-save emits a compacted-region file",
    { timeout: 660_000 },
    async () => {
      const work = mkdtempSync(path.join(tmpdir(), "qed64-snap-"));
      try {
        writeFileSync(path.join(work, "probe.lean"), "#check (2 + 2 : Nat)\n");
        // The region is hundreds of MB: let its size settle before the reap.
        const r = await supervise(
          path.join(work, "init.snap"),
          ["--artifact", artifact, "--work", work, "--",
            "--incr-header-save=/work/init.snap", "/work/probe.lean"],
          { quietMs: 15_000, stableMs: 15_000, giveUpMs: 600_000 },
        );
        expect(r.status).toBe(0);
        const snapPath = path.join(work, "init.snap");
        expect(statSync(snapPath).size).toBeGreaterThan(1024 * 1024);
        const magic = Buffer.alloc(5);
        const fd = openSync(snapPath, "r");
        readSync(fd, magic, 0, 5, 0);
        closeSync(fd);
        expect(magic.toString("ascii")).toBe("olean");
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});
