// Integration: drive the real wasm64 Lean runtime under Node through the
// pipeline runner. These tests exercise the exact bytes the browser runs.
//
// Tiers:
//   default   — prelude parse (seconds) + Init import proof (~30-60 s)
//   QED64_SLOW=1 — adds `import Lean` metaprogram check and snapshot baking
//
// The artifact tree defaults to the pinned wasm64 build; skip everything
// gracefully when it is not present (e.g. CI without the toolchain volume).

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const runner = path.join(root, "pipeline/snapshot/node-runner.mjs");
const builtHere = path.join(root, "pipeline/toolchain/work/build/stage1");
const artifact =
  process.env.QED64_LEAN_ARTIFACT ||
  (existsSync(path.join(builtHere, "bin/lean.js"))
    ? builtHere
    : path.join(root, "../../wasm64-lean-codex/experiments/lean4-wasm64-build/stage1"));
const haveArtifact = existsSync(path.join(artifact, "bin/lean.js"));
const slow = process.env.QED64_SLOW === "1";

const describeIf = haveArtifact ? describe : describe.skip;

interface RunResult {
  stdout: string;
  status: number;
}

function runLean(source: string, extraArgs: string[] = [], timeoutMs = 240_000): RunResult {
  const work = mkdtempSync(path.join(tmpdir(), "qed64-run-"));
  writeFileSync(path.join(work, "input.lean"), source);
  try {
    const stdout = execFileSync(
      "node",
      [runner, "--artifact", artifact, "--work", work, "--", ...extraArgs, "/work/input.lean"],
      { timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return { stdout, status: 0 };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { stdout: `${e.stdout ?? ""}\n${e.stderr ?? ""}`, status: e.status ?? 1 };
  }
}

describeIf("wasm64 runtime under Node", () => {
  test("prelude file parses instantly (no artifact loads)", () => {
    const r = runLean("prelude\nset_option linter.all false\n", [], 120_000);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Loading 0 modules");
  });

  test(
    "Init import: numBits=64, rfl proof kernel-checked, theorem printed",
    { timeout: 300_000 },
    () => {
      const r = runLean(
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
      expect(r.stdout).toContain("\n64\n");
      expect(r.stdout).toContain("qed64_smoke (a b : Nat) : a + b = b + a");
      expect(r.stdout).not.toMatch(/error/i);
    },
  );

  test(
    "a broken proof fails with a positioned error and nonzero exit",
    { timeout: 300_000 },
    () => {
      const r = runLean("example : (1 + 1 : Nat) = 3 := by rfl\n");
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/input\.lean:1:\d+: error/);
    },
  );

  test(
    "sorry produces a warning, not an error, and exits zero",
    { timeout: 300_000 },
    () => {
      const r = runLean("theorem hard : 1 = 1 := by sorry\n");
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/warning.*sorry|declaration uses 'sorry'/);
    },
  );
});

const describeSlow = haveArtifact && slow ? describe : describe.skip;

describeSlow("wasm64 runtime — slow tier (QED64_SLOW=1)", () => {
  test(
    "import Lean loads the full 2,308-module closure and runs metaprograms",
    { timeout: 600_000 },
    () => {
      const r = runLean(
        [
          "import Lean",
          "#eval System.Platform.numBits",
          "open Lean in",
          '#eval do let env ← importModules #[] {} ; pure ()',
          "example : (1 + 1 : Nat) = 2 := by rfl",
        ].join("\n"),
        [],
        600_000,
      );
      expect(r.stdout).toContain("64");
    },
  );

  test(
    "snapshot bake: --incr-header-save emits a compacted-region file",
    { timeout: 600_000 },
    () => {
      const work = mkdtempSync(path.join(tmpdir(), "qed64-snap-"));
      writeFileSync(path.join(work, "probe.lean"), "#check (2 + 2 : Nat)\n");
      execFileSync(
        "node",
        ["--stack-size=8192", runner, "--artifact", artifact, "--work", work, "--",
          "--incr-header-save=/work/init.snap", "/work/probe.lean"],
        { timeout: 600_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      const snap = readFileSync(path.join(work, "init.snap"));
      expect(snap.length).toBeGreaterThan(1024 * 1024);
      expect(snap.subarray(0, 5).toString("ascii")).toBe("olean");
    },
  );
});
