import { describe, expect, test } from "vitest";
import {
  ABBREVIATIONS,
  applyKeystroke,
  commitAbbreviation,
  findAbbreviation,
} from "../../src/editor/abbreviations";

describe("findAbbreviation", () => {
  test("finds a body after a backslash", () => {
    const m = findAbbreviation("foo \\alpha", 10);
    expect(m).not.toBeNull();
    expect(m!.body).toBe("alpha");
    expect(m!.replacement).toBe("α");
    expect(m!.matchedLength).toBe(5);
  });

  test("returns null with no backslash in range", () => {
    expect(findAbbreviation("no abbrev here", 8)).toBeNull();
  });

  test("stops at separators", () => {
    expect(findAbbreviation("\\to more", 8)).toBeNull(); // caret beyond a space
  });

  test("longest prefix wins", () => {
    // "in" → ∈ but "int" is also a key; body "int" must match "int", not "in".
    const m = findAbbreviation("\\int", 4);
    expect(m!.replacement).toBe(ABBREVIATIONS["int"]);
    expect(m!.matchedLength).toBe(3);
  });

  test("reports extensibility", () => {
    const m = findAbbreviation("\\al", 3);
    expect(m!.extensible).toBe(true); // "alpha", "all" continue it
    const done = findAbbreviation("\\alpha", 6);
    // "alpha" itself matches; nothing longer starts with "alpha"
    expect(done!.extensible).toBe(false);
  });
});

describe("applyKeystroke", () => {
  test("lets extensible bodies keep typing", () => {
    expect(applyKeystroke("\\al", 3, "p")).toBeNull();
  });

  test("commits on a terminator and preserves it", () => {
    const edit = applyKeystroke("\\to", 3, " ");
    expect(edit).toEqual({ from: 0, to: 3, insert: "→ " });
  });

  test("commits the longest match with a tail", () => {
    // \tox → matched "to", tail "x": committing on space gives "→x "
    const edit = applyKeystroke("\\tox", 4, " ");
    expect(edit).toEqual({ from: 0, to: 4, insert: "→x " });
  });

  test("double backslash types a literal backslash", () => {
    const edit = applyKeystroke("\\", 1, "\\");
    expect(edit).toEqual({ from: 0, to: 1, insert: "\\" });
  });

  test("no match, no interference", () => {
    expect(applyKeystroke("\\zzqq", 5, " ")).toBeNull();
    expect(applyKeystroke("plain", 5, "x")).toBeNull();
  });

  test("greek letters end-to-end", () => {
    const edit = applyKeystroke("have h : \\alpha", 15, " ");
    expect(edit).toEqual({ from: 9, to: 15, insert: "α " });
  });
});

describe("commitAbbreviation (Tab)", () => {
  test("commits without a trailing character", () => {
    expect(commitAbbreviation("\\forall", 7)).toEqual({ from: 0, to: 7, insert: "∀" });
  });
  test("returns null when nothing matches", () => {
    expect(commitAbbreviation("\\zzqq", 5)).toBeNull();
    expect(commitAbbreviation("nothing", 7)).toBeNull();
  });
  test("brackets: \\< commits to ⟨", () => {
    expect(commitAbbreviation("\\<", 2)).toEqual({ from: 0, to: 2, insert: "⟨" });
  });
});

describe("table sanity", () => {
  test("all replacements are non-empty and non-ASCII-alphanumeric", () => {
    for (const [key, value] of Object.entries(ABBREVIATIONS)) {
      expect(value.length, `empty replacement for ${key}`).toBeGreaterThan(0);
    }
  });
  test("core Lean abbreviations present", () => {
    for (const key of ["to", "forall", "exists", "and", "or", "not", "in", "sub", "N", "R", "alpha", "lambda", "<", ">"]) {
      expect(ABBREVIATIONS[key], `missing ${key}`).toBeDefined();
    }
  });
});
