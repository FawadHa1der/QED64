// HARDENING #67's interim: lean.worker.js sets the runtime's engine-stack probe size
// (LEAN_WASM_STACK_PROBE_SLOTS) at preRun. The runtime reads it once per process with atoi, so a
// value that is not a plain decimal number is 0 and turns the stack guard OFF (HARDENING #60's crash
// returns). These pin the invariants the source must keep; the browser lane
// (tests/adversarial/deep-recursion.mjs, scenarios seeded/typing/legal) measures the behaviour.
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve(__dirname, "../../public/workers/lean.worker.js"), "utf8");

describe("lean.worker.js: the engine-stack probe size (HARDENING #67)", () => {
  test("the value is one digits-only literal, at least the kernel's measured floor 8192 and at most its default 16384", () => {
    const consts = [...src.matchAll(/const STACK_PROBE_SLOTS = (".*?"|[^;]+);/g)].map((m) => m[1]);
    expect(consts).toHaveLength(1);
    expect(consts[0]).toMatch(/^"\d+"$/);
    const n = Number(JSON.parse(consts[0]!));
    expect(n).toBeGreaterThanOrEqual(8192); // 4096 and below overflow the kernel's deep probes
    expect(n).toBeLessThanOrEqual(16384); // the runtime's own default
  });

  test("it is set at preRun (mountEverything), where getenv reads it, and nowhere in the Module literal", () => {
    const assigns = [...src.matchAll(/Module\.ENV\.LEAN_WASM_STACK_PROBE_SLOTS\s*=\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(assigns).toEqual(["STACK_PROBE_SLOTS"]);
    const mount = src.slice(src.indexOf("function mountEverything()"), src.indexOf("onRuntimeInitialized()"));
    expect(mount).toContain("self.Module.ENV.LEAN_WASM_STACK_PROBE_SLOTS = STACK_PROBE_SLOTS;");
    expect(src).not.toMatch(/\bENV:\s*\{/); // a literal ENV key is replaced by the glue (HARDENING #66)
  });
});
