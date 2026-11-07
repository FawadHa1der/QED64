// The "first library search" hint (frontend/src/search-hint.ts, HARDENING #88): which tactics count, per family, and
// the per-session warm-index tracking with a fake clock.
import { describe, expect, it } from "vitest";
import { SEARCH_HINT_AFTER_MS, createSearchHint, searchFamilies, searchHintText } from "../../frontend/src/search-hint";

describe("searchFamilies", () => {
  it.each([
    ["example : 1 + 1 = 2 := by exact?", ["exact"]],
    ["  apply?", ["exact"]],
    ["exact?%", ["exact"]],
    ["  try?", ["exact"]],
    ["  try? +harder", ["exact"]],
    ["example : p := by\n  hint", ["exact"]],
    ["example : p := by hint", ["exact"]],
    ["  · observe h : 1 + 1 = 2", ["exact"]],
    ["  observe? h : 1 + 1 = 2", ["exact"]],
    ["  constructor <;> hint", ["exact"]],
    ["  (hint)", ["exact"]],
    ["  rw? at h", ["rw"]],
    ["  rw??", ["rwq"]],
    ["  rw?\n  rw??", ["rw", "rwq"]],
    ["  exact?\n  rw?", ["exact", "rw"]],
  ])("%j names %j", (text, families) => {
    expect(searchFamilies(text)).toEqual(families);
  });
  it.each([
    "theorem hint_foo : True := trivial",
    "def observer := 1",
    "#check Foo.hint",
    "-- hint: try simp",
    "-- a hint for later",
    "  exact h",
    "  try simp",
    "  rw [h]",
    "",
  ])("%j names none", (text) => {
    expect(searchFamilies(text)).toEqual([]);
  });
});

describe("searchHintText", () => {
  it("says about a minute unless only rw?? is cold", () => {
    expect(searchHintText(["exact"])).toMatch(/about a minute; editing this proof restarts it$/);
    expect(searchHintText(["rw", "rwq"])).toMatch(/about a minute/);
    expect(searchHintText(["rwq"])).toMatch(/about half a minute; editing this proof restarts it$/);
  });
});

describe("createSearchHint", () => {
  const setup = () => {
    let t = 0;
    const h = createSearchHint(() => t);
    const at = (ms: number) => { t = ms; };
    return { h, at };
  };

  it("hints once per stretch after the delay, and not again once the family is warm", () => {
    const { h, at } = setup();
    const doc = "example : 2 = 2 := by exact?";
    h.status({ session: "s1", phase: "elaborating" }, doc);
    at(SEARCH_HINT_AFTER_MS - 1);
    expect(h.tick(doc)).toBeNull();
    at(SEARCH_HINT_AFTER_MS);
    expect(h.tick(doc)).toMatch(/about a minute/);
    expect(h.tick(doc)).toBeNull(); // once per stretch
    expect(h.shown).toMatch(/about a minute/);
    h.status({ session: "s1", phase: "ready" }, doc);
    expect(h.shown).toBeNull();
    h.status({ session: "s1", phase: "elaborating" }, doc);
    at(10 * SEARCH_HINT_AFTER_MS);
    expect(h.tick(`${doc}\nexample : 3 = 3 := by apply?`)).toBeNull(); // the exact? family shares one index
  });

  it("hints for a first rw? after an exact? warmed its own index", () => {
    const { h, at } = setup();
    h.status({ session: "s1", phase: "elaborating" }, "");
    h.tick("by exact?");
    h.status({ session: "s1", phase: "ready" }, "by exact?");
    at(1000);
    h.status({ session: "s1", phase: "elaborating" }, "");
    at(1000 + SEARCH_HINT_AFTER_MS);
    expect(h.tick("by exact?\nexample : a = b := by rw?")).toMatch(/about a minute/);
  });

  it("gives rw?? alone the half-minute words", () => {
    const { h, at } = setup();
    h.status({ session: "s1", phase: "elaborating" }, "");
    at(SEARCH_HINT_AFTER_MS);
    expect(h.tick("  rw??")).toMatch(/about half a minute/);
  });

  it("marks a family warm when its search left the text before the stretch ended", () => {
    const { h, at } = setup();
    h.status({ session: "s1", phase: "elaborating" }, "");
    h.tick("  rw?"); // seen while elaborating
    h.status({ session: "s1", phase: "ready" }, "  rw [Nat.add_comm]"); // the suggestion replaced it
    h.status({ session: "s1", phase: "elaborating" }, "");
    at(SEARCH_HINT_AFTER_MS);
    expect(h.tick("  rw?")).toBeNull();
  });

  it("forgets warm indexes on a new session", () => {
    const { h, at } = setup();
    h.status({ session: "s1", phase: "elaborating" }, "");
    h.status({ session: "s1", phase: "ready" }, "by exact?");
    h.status({ session: "s2", phase: "elaborating" }, "");
    at(SEARCH_HINT_AFTER_MS);
    expect(h.tick("by exact?")).toMatch(/about a minute/);
  });

  it("stays quiet without a search", () => {
    const { h, at } = setup();
    h.status({ session: "s1", phase: "elaborating" }, "");
    at(10 * SEARCH_HINT_AFTER_MS);
    expect(h.tick("example : 1 = 1 := rfl")).toBeNull();
  });
});
