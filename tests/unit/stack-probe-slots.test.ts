// HARDENING #71: QED64 does not tune the runtime's engine-stack guard. lean.worker.js leaves
// LEAN_WASM_STACK_PROBE_SLOTS unset, so kernel patch 0036's own reserve (16384 slots) applies. #67's interim 8192
// checked deeper proofs but let heavy tactic recursion overrun the reserve between two probes and kill the
// FileWorker on two proof sheets; deaths are handled by the stack-overflow pause (#72). The browser lane
// (tests/adversarial/deep-recursion.mjs) measures the behaviour; this pins the source.
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve(__dirname, "../../public/workers/lean.worker.js"), "utf8");

describe("lean.worker.js: the engine-stack probe size (HARDENING #67, #71)", () => {
  test("the worker never sets LEAN_WASM_STACK_PROBE_SLOTS: the runtime's default reserve applies", () => {
    expect(src).not.toMatch(/LEAN_WASM_STACK_PROBE_SLOTS\s*=/);
    expect(src).not.toMatch(/STACK_PROBE_SLOTS\s*=/);
  });

  test("environment variables are still set at preRun (mountEverything), never in the Module literal", () => {
    const mount = src.slice(src.indexOf("function mountEverything()"), src.indexOf("onRuntimeInitialized()"));
    expect(mount).toContain("self.Module.ENV.LEAN_PATH = bootConfig.leanPath;");
    expect(src).not.toMatch(/\bENV:\s*\{/); // a literal ENV key is replaced by the glue (HARDENING #66)
  });
});
