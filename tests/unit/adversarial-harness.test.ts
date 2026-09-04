// Pins the pure helpers of the adversarial harness (review C7): `--only`
// matches whole names, the page URL determines the pairing the run boots,
// and the pill's terminal classes map onto the corpus's `expect.terminal`.
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { onlyMatches, resolveTarget, settleClass } from "../../tests/adversarial/harness.mjs";
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
  test("default page → mutable manifest, /snapshots/, resident (the default transport; ?resident=0 is pump)", () => {
    const t = resolveTarget("http://localhost:5187/");
    expect(t).toMatchObject({ mode: "resident", runtimeOverride: null, snapshotsDir: "snapshots",
      manifestUrl: "http://localhost:5187/runtime/runtime-manifest.json", indexUrl: "http://localhost:5187/snapshots/index.json" });
  });
  test("?resident=0 → pump (the fallback transport)", () => {
    expect(resolveTarget("http://localhost:5184/?resident=0").mode).toBe("pump");
  });
  test("dev overrides follow qed64-boot.ts (?runtime=, ?snapshots=, ?resident=1)", () => {
    const t = resolveTarget("http://localhost:5184/?resident=1&runtime=wasm64-464463c696d9aa2d&snapshots=snapshots-0031");
    expect(t).toMatchObject({ mode: "resident", runtimeOverride: "wasm64-464463c696d9aa2d", snapshotsDir: "snapshots-0031",
      manifestUrl: "http://localhost:5184/runtime/runtime-manifest.wasm64-464463c696d9aa2d.json", indexUrl: "http://localhost:5184/snapshots-0031/index.json" });
  });
});

describe("settleClass", () => {
  test("maps today's pill labels onto the terminal enum", () => {
    expect(settleClass("ready")).toBe("ready");
    expect(settleClass("ready — 3 s")).toBeNull();
    expect(settleClass("imports incomplete — finish the import line")).toBe("headerUnresolvable");
    expect(settleClass("imports failed")).toBe("headerUnresolvable");
    expect(settleClass("Lean keeps crashing — halted")).toBe("halted");
    expect(settleClass("elaborating")).toBeNull();
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
