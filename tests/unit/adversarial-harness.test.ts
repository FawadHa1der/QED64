// Pins the pure helpers of the adversarial harness (review C7): `--only`
// matches whole names, the page URL determines the pairing the run boots,
// and the pill's terminal classes map onto the corpus's `expect.terminal`.
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { onlyMatches, resolveTarget, settleClass } from "../../tests/adversarial/harness.mjs";

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
  test("default page → mutable manifest, /snapshots/, pump", () => {
    const t = resolveTarget("http://localhost:5187/");
    expect(t).toMatchObject({ mode: "pump", runtimeOverride: null, snapshotsDir: "snapshots",
      manifestUrl: "http://localhost:5187/runtime/runtime-manifest.json", indexUrl: "http://localhost:5187/snapshots/index.json" });
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
