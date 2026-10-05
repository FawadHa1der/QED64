// The persistent-runtime contract, exercised by the standalone probe: manual
// init sequence, resident-environment compile reuse (ms-scale), JSON
// diagnostics, error-count return values, and survival after failed proofs.
//
// The parse-error test also needs toolchain patch 0010; it skips, and says
// why, on a runtime that predates it (the old codex stage1 fallback). From a
// worktree without build outputs, point QED64_LEAN_ARTIFACT at the main
// checkout's pipeline/toolchain/work/build/stage1.

import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const builtHere = path.join(root, "pipeline/toolchain/work/build/stage1");
const artifact =
  process.env.QED64_LEAN_ARTIFACT ||
  (existsSync(path.join(builtHere, "bin/lean.js"))
    ? builtHere
    : path.join(root, "../../wasm64-lean-codex/experiments/lean4-wasm64-build/stage1"));
const haveArtifact = existsSync(path.join(artifact, "bin/lean.js"));

// Patch 0010 replaces wasmCompile's `Frontend.processCommand` loop with an
// inlined `Parser.parseCommand` step. It changes compiled Lean code only (no
// export, nothing in the glue, and lean.wasm has no name section), so it shows
// in the build's Lean/Shell.ilean: wasmCompile references Parser.parseCommand.
// null when that file is absent or unreadable: no evidence either way, so the
// test runs and the probe's own output decides.
function wasmCompileParsesInline(): boolean | null {
  const ilean = path.join(artifact, "lib/lean/Lean/Shell.ilean");
  if (!existsSync(ilean)) return null;
  try {
    const refs: Record<string, { usages?: unknown[][] }> =
      JSON.parse(readFileSync(ilean, "utf8")).references ?? {};
    return Object.entries(refs).some(
      ([key, ref]) =>
        JSON.parse(key)?.c?.n === "Lean.Parser.parseCommand" &&
        (ref.usages ?? []).some((u) => String(u[4]).endsWith("Lean.wasmCompile")),
    );
  } catch {
    return null;
  }
}

const skipReason = !haveArtifact
  ? `no wasm64 runtime at ${artifact} (set QED64_LEAN_ARTIFACT to a stage1 dir)`
  : null;
const parseSkipReason =
  skipReason ??
  (wasmCompileParsesInline() === false
    ? `${artifact} predates toolchain patch 0010 (its wasmCompile drops parser ` +
      "diagnostics; lib/lean/Lean/Shell.ilean shows no Parser.parseCommand use), so " +
      "the parse-error assertion cannot hold; set QED64_LEAN_ARTIFACT to the paired " +
      "stage1 (pipeline/toolchain/work/build/stage1 in the main checkout)"
    : null);
if (skipReason) console.warn(`persistent-path: skipped — ${skipReason}`);
else if (parseSkipReason) console.warn(`persistent-path: parse-error test skipped — ${parseSkipReason}`);

const describeIf = skipReason ? describe.skip : describe;
const describeIfParses = parseSkipReason ? describe.skip : describe;

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

describeIfParses("parse-error reporting (fixed by toolchain patch 0010)", () => {
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
