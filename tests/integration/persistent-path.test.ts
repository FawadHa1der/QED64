// The persistent-runtime contract, exercised by the standalone probe: manual
// init sequence, resident-environment compile reuse (ms-scale), JSON
// diagnostics, error-count return values, and survival after failed proofs.

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const builtHere = path.join(root, "pipeline/toolchain/work/build/stage1");
const artifact =
  process.env.QED64_LEAN_ARTIFACT ||
  (existsSync(path.join(builtHere, "bin/lean.js"))
    ? builtHere
    : path.join(root, "../../wasm64-lean-codex/experiments/lean4-wasm64-build/stage1"));

const describeIf = existsSync(path.join(artifact, "bin/lean.js")) ? describe : describe.skip;

describeIf("persistent runtime path (browser architecture, under Node)", () => {
  test("full probe passes", { timeout: 600_000 }, () => {
    const out = execFileSync(
      "node",
      [path.join(root, "pipeline/snapshot/persistent-probe.mjs"), "--artifact", artifact],
      { timeout: 600_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    expect(out).toContain("init OK");
    expect(out).toContain("PERSISTENT PROBE PASS");
    // Resident-environment reuse: compile 2 must be at least 100x faster
    // than the import-paying compile 1.
    const times = [...out.matchAll(/elapsed=(\d+)ms/g)].map((m) => Number(m[1]));
    expect(times.length).toBeGreaterThanOrEqual(4);
    expect(times[1]!).toBeLessThan(times[0]! / 100);
  });
});

describeIf("parse-error reporting (fixed by toolchain patch 0010)", () => {
  test("wasmCompile reports parser diagnostics for garbage input", { timeout: 600_000 }, () => {
    const out = execFileSync(
      "node",
      [path.join(root, "pipeline/snapshot/persistent-probe.mjs"), "--artifact", artifact],
      { timeout: 600_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    expect(out).toContain("runtime defect is FIXED");
    expect(out).not.toContain("PARSE-ERROR-SWALLOWED");
  });
});
