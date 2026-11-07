// tests/adversarial/page-ux.mjs runs only against a real page; its scenario
// selection is pinned here, the lesson infoview-actions.mjs learned: an --only
// that selects nothing, or a run that judged nothing, is a refusal (exit 3),
// never "0/0 pass". Its verdicts are inline check maps in the lane; a run of its
// scenarios against the build before each change is their negative control.
import { describe, expect, test } from "vitest";
import { SCENARIOS, exitCodeFor, selectScenarios } from "../adversarial/page-ux.mjs";

describe("page-ux scenario selection", () => {
  test("every scenario runs alone, in SCENARIOS order", () => {
    expect(SCENARIOS).toEqual(["a11y-status", "share-link", "example-undo", "buffer-flush", "look", "layout", "content-halt"]);
    for (const name of SCENARIOS) expect(selectScenarios(name)).toEqual([name]);
    expect(selectScenarios("")).toEqual(SCENARIOS);
    expect(selectScenarios("a11y-.*")).toEqual(["a11y-status"]);
  });
  test("a selection of none, or a run that judged nothing, is a refusal (exit 3), never a pass", () => {
    expect(selectScenarios("a11y")).toEqual([]); // a plain name matches whole, never a substring
    expect(exitCodeFor(0, 0)).toBe(3);
    expect(exitCodeFor(1, 0)).toBe(0);
    expect(exitCodeFor(1, 1)).toBe(1);
  });
});
