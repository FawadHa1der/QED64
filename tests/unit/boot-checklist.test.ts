// The boot card's checklist (frontend/src/boot-checklist.ts; HARDENING #54,
// #58): forward-only progress with the next snapshot's download as the one
// way back, and a rewind to the runtime step on a deliberate replacement's
// first status, once per replacement session.
import { describe, expect, it } from "vitest";
import { STAGES, createBootChecklist, stageOf } from "../../frontend/src/boot-checklist";

const step = (c: { stage: number }) => STAGES[c.stage] ?? "done";
const userReboot = (session: string) => ({ relay: "rebooting", rebootReason: "user", session });

describe("stageOf", () => {
  it("maps the boot's progress reports to their steps", () => {
    expect(stageOf("fetching manifests…")).toBe("manifests");
    expect(stageOf("x", { phase: "core-pack" })).toBe("core");
    expect(stageOf("Starting the Lean runtime")).toBe("runtime");
    expect(stageOf("x", { phase: "memory" })).toBe("runtime");
    expect(stageOf("downloading the Mathlib environment (1.0 GB)", { phase: "snapshot" })).toBe("env");
    expect(stageOf("x", { phase: "snapshot-cache" })).toBe("env");
    expect(stageOf("loading Mathlib into Lean", { phase: "snapshot-load" })).toBe("load");
    expect(stageOf("elaborating")).toBe("check");
    expect(stageOf("something else")).toBeNull();
  });
});

describe("createBootChecklist", () => {
  it("moves forward only, except to the next snapshot's download after a load", () => {
    const c = createBootChecklist();
    expect(c.progress("Starting the Lean runtime")).toEqual({ moved: true, fresh: true });
    expect(c.progress("x", { phase: "snapshot" })).toEqual({ moved: true, fresh: true });
    expect(c.progress("Starting again")).toEqual({ moved: false, fresh: false }); // never back to runtime
    expect(c.progress("x", { phase: "snapshot" })).toEqual({ moved: true, fresh: false }); // same step: re-render only
    c.progress("loading init into Lean", { phase: "snapshot-load" });
    expect(step(c)).toBe("load");
    expect(c.progress("x", { phase: "snapshot" })).toEqual({ moved: true, fresh: true }); // mathlib's download follows init's load
    expect(step(c)).toBe("env");
    expect(c.progress("unrelated")).toEqual({ moved: false, fresh: false });
  });

  it("a deliberate replacement's first status rewinds to the runtime step, once per session", () => {
    const c = createBootChecklist();
    c.progress("elaborating");
    expect(step(c)).toBe("check");
    expect(c.observe(userReboot("s2"))).toBe(true);
    expect(step(c)).toBe("runtime");
    c.progress("x", { phase: "snapshot" });
    expect(c.observe(userReboot("s2"))).toBe(false); // the same replacement's later statuses keep its progress
    expect(step(c)).toBe("env");
    c.progress("elaborating");
    expect(c.observe(userReboot("s3"))).toBe(true); // another replacement rewinds again
    expect(step(c)).toBe("runtime");
  });

  it("crash reboots, serving statuses and a halt do not rewind", () => {
    const c = createBootChecklist();
    c.progress("elaborating");
    for (const reason of ["crash", "heartbeat", "wedged", "bootFailed", "boot"]) expect(c.observe({ relay: "rebooting", rebootReason: reason, session: "s2" })).toBe(false);
    expect(c.observe({ relay: "serving", rebootReason: null, session: "s2" })).toBe(false);
    expect(c.observe({ relay: "halted", rebootReason: null, session: "s2" })).toBe(false);
    expect(step(c)).toBe("check");
  });

  it("a replacement before the runtime step changes nothing; a finished checklist never moves", () => {
    const c = createBootChecklist();
    c.progress("Starting the Lean runtime");
    expect(c.observe(userReboot("s2"))).toBe(false);
    expect(step(c)).toBe("runtime");
    c.finish();
    expect(step(c)).toBe("done");
    expect(c.progress("x", { phase: "snapshot" })).toEqual({ moved: false, fresh: false });
    expect(c.observe(userReboot("s3"))).toBe(false);
    expect(step(c)).toBe("done");
  });
});
