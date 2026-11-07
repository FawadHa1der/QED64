// The page's words for the curated Mathlib (frontend/src/mathlib-coverage.ts; docs/HARDENING.md #89) against the
// tracked umbrella manifest, the kernel's aliases and README's "Which Mathlib" (the note beside the pill links there),
// so an import that serves an area the words call missing fails here until the words follow.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MATHLIB_FEW, MATHLIB_GAPS, MATHLIB_NONE, coverageHint } from "../../frontend/src/mathlib-coverage";
import { UMBRELLA_ALIASES } from "../../lib/snapshots";

const root = path.resolve(__dirname, "../..");
const served = Object.keys((JSON.parse(fs.readFileSync(path.join(root, "public/profiles/mathlib-essential.manifest.json"), "utf8")) as { content: { modules: Record<string, unknown> } }).content.modules);
const inArea = (area: string) => served.filter((m) => m === `Mathlib.${area}` || m.startsWith(`Mathlib.${area}.`)).length;

describe("the Mathlib areas the page says are missing", () => {
  it("the manifest is the umbrella (a sanity check, so the counts below are not vacuous)", () => {
    expect(served.filter((m) => m.startsWith("Mathlib.")).length).toBeGreaterThan(1000);
    expect(inArea("Algebra")).toBeGreaterThan(10);
  });
  it("have no module in the served umbrella", () => {
    for (const a of MATHLIB_NONE) expect(inArea(a), a).toBe(0);
  });
  it("or at most 10 modules for the 'almost no' areas", () => {
    for (const a of MATHLIB_FEW) expect(inArea(a), a).toBeLessThanOrEqual(10);
  });
  it("are each named in the clause the page shows and in README's 'Which Mathlib' section", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const at = readme.indexOf("\n## Which Mathlib\n");
    expect(at, "README.md has a '## Which Mathlib' section (index.html's #mathlibnote links to #which-mathlib)").toBeGreaterThan(0);
    const section = readme.slice(at, readme.indexOf("\n## ", at + 1));
    for (const a of [...MATHLIB_NONE, ...MATHLIB_FEW]) {
      expect(MATHLIB_GAPS, a).toContain(a);
      expect(section, a).toContain(a);
    }
  });
});

describe("coverageHint", () => {
  const unknown = [{ severity: 1, message: "Unknown identifier `SimpleGraph`" }];
  it("is true under each Mathlib alias the kernel serves from the umbrella", () => {
    const aliases = UMBRELLA_ALIASES.filter((a) => a === "Mathlib" || a.startsWith("Mathlib."));
    expect(aliases).toEqual(["Mathlib", "Mathlib.Tactic"]); // a new Mathlib alias must be added to ALIAS_IMPORT
    for (const a of aliases) expect(coverageHint(`import ${a}\n\n#check SimpleGraph\n`, unknown), a).toBe(true);
  });
  it("is false under a module imported by name: its whole closure is served", () => {
    expect(coverageHint("import Mathlib.Data.Real.Basic\n\n#check SimpleGraph\n", unknown)).toBe(false);
    expect(coverageHint("import Mathlib.Order\n", unknown)).toBe(false);
    expect(coverageHint("import Mathlib.Tactic.Ring\n", unknown)).toBe(false);
    expect(coverageHint("import MathlibX\n", unknown)).toBe(false);
    expect(coverageHint("-- import Mathlib\n", unknown)).toBe(false);
    expect(coverageHint("theorem t : True := trivial\n", unknown)).toBe(false);
  });
  it("takes the import modifiers, a trailing comment, a CRLF line end and other imports around it", () => {
    expect(coverageHint("module\npublic import Mathlib\n", unknown)).toBe(true);
    expect(coverageHint("meta import Mathlib.Tactic\n", unknown)).toBe(true);
    expect(coverageHint("import Mathlib -- everything\n", unknown)).toBe(true);
    expect(coverageHint("import Mathlib\r\n\r\n#check SimpleGraph\r\n", unknown)).toBe(true);
    expect(coverageHint("import Batteries\nimport Mathlib\n", unknown)).toBe(true);
  });
  it("takes Lean's unknown identifier, constant and namespace errors, in either phrasing", () => {
    for (const message of ["Unknown identifier `x`", "Unknown constant `Polynomial.Gal`", "Unknown namespace `CategoryTheory`", "unknown identifier 'x'"]) {
      expect(coverageHint("import Mathlib\n", [{ severity: 1, message }]), message).toBe(true);
    }
  });
  it("ignores warnings, information and other errors", () => {
    expect(coverageHint("import Mathlib\n", [{ severity: 2, message: "Unknown identifier `x`" }])).toBe(false);
    expect(coverageHint("import Mathlib\n", [{ severity: 1, message: "Type mismatch" }, { severity: 3, message: "Unknown" }])).toBe(false);
    expect(coverageHint("import Mathlib\n", [{ message: "Unknown identifier `x`" }])).toBe(false);
    expect(coverageHint("import Mathlib\n", [])).toBe(false);
  });
});
