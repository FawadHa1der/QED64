// The editor/InfoView splitter's share (frontend/src/splitter.ts, UX L1.2). Its pointer wiring and the layout are
// checked in a browser: tests/adversarial/page-ux.mjs `splitter-drag` (Chromium and Firefox) and `layout`.
import { describe, expect, it } from "vitest";
import { splitPercent } from "../../frontend/src/splitter";

describe("splitPercent", () => {
  it("is the pointer's share of the row, to a tenth of a percent", () => {
    expect(splitPercent(400, 100, 1000)).toBe(30);
    expect(splitPercent(723.456, 100, 1000)).toBe(62.3);
  });
  it("is clamped to 15-85, so neither pane can vanish", () => {
    expect(splitPercent(0, 100, 1000)).toBe(15);
    expect(splitPercent(5000, 100, 1000)).toBe(85);
  });
  it("is the stock 55 for a row with no width (not laid out yet)", () => {
    expect(splitPercent(10, 0, 0)).toBe(55);
  });
});
