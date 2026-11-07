// Find references and rename for the editor's one document (frontend/src/editor/single-doc-refs.ts; UX parity
// E5.3, E5.4, HARDENING #90), over a fake documentHighlight and small stand-ins for Monaco's model and `languages`.
import { describe, expect, it, vi } from "vitest";
import { RENAME_NOTHING, RENAME_WAIT, isLeanName, registerSingleDocRefs, renameRanges, renameRefusal, type RefsDeps, type RefsLanguages, type RefsModel } from "../../frontend/src/editor/single-doc-refs";

type RefsProvider = Parameters<RefsLanguages["registerReferenceProvider"]>[1];
type RenameProvider = Parameters<RefsLanguages["registerRenameProvider"]>[1];
type Status = ReturnType<RefsDeps["status"]>;
const URI = "file:///project/Probe.lean";
// The UX study's namespace example (2026-11-06), and native Lean's F2 → baz on `def bar` (live.lean-lang.org,
// Lean 4.35, Mathlib header): byte for byte, `Foo.bar` outside the namespace included.
const DOC = "namespace Foo\ndef bar (n : ℕ) : ℕ := n + 1\ntheorem bar_pos (n : ℕ) : 0 < bar n := Nat.succ_pos n\nend Foo\n\nexample : Foo.bar 1 = 2 := rfl\nopen Foo in\nexample : bar 2 = 3 := rfl\nexample (n : ℕ) : 0 < Foo.bar n := Foo.bar_pos n\n";
const NATIVE_RENAME = "namespace Foo\ndef baz (n : ℕ) : ℕ := n + 1\ntheorem bar_pos (n : ℕ) : 0 < baz n := Nat.succ_pos n\nend Foo\n\nexample : baz 1 = 2 := rfl\nopen Foo in\nexample : baz 2 = 3 := rfl\nexample (n : ℕ) : 0 < baz n := Foo.bar_pos n\n";
const DO = "def f : IO Unit := do\n  return ()\n";
const ON_RETURN = { lineNumber: 2, column: 4 };
const DEF_BAR = { lineNumber: 2, column: 6 }; // inside `bar` of `def bar`
const READY: Status = { phase: "ready", relay: "serving", version: 1 };

/** The LSP range of `len` characters at `needle` on 0-based `line`. */
function at(text: string, line: number, needle: string, len = needle.length) {
  const character = text.split("\n")[line]!.indexOf(needle);
  if (character < 0) throw new Error(`no ${needle} on line ${line}`);
  return { start: { line, character }, end: { line, character: character + len } };
}
// documentHighlight at `def bar` as the FileWorker answered it (5 ranges: bar, bar, Foo.bar, bar, Foo.bar), shuffled.
const BAR = [at(DOC, 7, "bar"), at(DOC, 1, "bar"), at(DOC, 5, "Foo.bar"), at(DOC, 8, "Foo.bar n", 7), at(DOC, 2, "bar n", 3)].map((range) => ({ kind: 1, range }));

function model(text: string, version = 1): RefsModel {
  const lines = text.split("\n");
  return {
    uri: { toString: () => URI },
    getVersionId: () => version,
    getValueInRange: (r) => (r.startLineNumber === r.endLineNumber ? lines[r.startLineNumber - 1]!.slice(r.startColumn - 1, r.endColumn - 1) : "<multi-line>"),
  };
}
function setup(reply: unknown, status: Status = READY) {
  let refs!: RefsProvider;
  let rename!: RenameProvider;
  const languages: RefsLanguages = {
    registerReferenceProvider: (id, p) => { expect(id).toBe("lean4"); refs = p; return { dispose() {} }; },
    registerRenameProvider: (id, p) => { expect(id).toBe("lean4"); rename = p; return { dispose() {} }; },
  };
  const request = vi.fn(async (_method: string, _params: unknown, _token: unknown) => { if (reply instanceof Error) throw reply; return reply; });
  registerSingleDocRefs(languages, { request, status: () => status });
  return { refs, rename, request };
}
/** Monaco's single-line text edits, applied back to front. */
function apply(text: string, edits: Array<{ textEdit: { range: { startLineNumber: number; startColumn: number; endColumn: number }; text: string } }>) {
  const lines = text.split("\n");
  const order = [...edits].sort((a, b) => b.textEdit.range.startLineNumber - a.textEdit.range.startLineNumber || b.textEdit.range.startColumn - a.textEdit.range.startColumn);
  for (const { textEdit: { range: r, text: t } } of order) {
    const l = lines[r.startLineNumber - 1]!;
    lines[r.startLineNumber - 1] = l.slice(0, r.startColumn - 1) + t + l.slice(r.endColumn - 1);
  }
  return lines.join("\n");
}

describe("single-document references (UX parity E5.3)", () => {
  it("asks documentHighlight through the client at the cursor, 0-based, with Monaco's token", async () => {
    const { refs, request } = setup(BAR);
    await refs.provideReferences(model(DOC), DEF_BAR, {}, "tok");
    expect(request).toHaveBeenCalledWith("textDocument/documentHighlight", { textDocument: { uri: URI }, position: { line: 1, character: 5 } }, "tok");
  });
  it("lists every highlight as a location in this document", async () => {
    const got = await setup(BAR).refs.provideReferences(model(DOC), DEF_BAR, {}, null);
    expect(got).toHaveLength(5);
    expect(got.map((l) => l.uri.toString())).toEqual(Array(5).fill(URI));
    expect(got.map((l) => l.range)).toContainEqual({ startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 8 });
    expect(got.map((l) => l.range)).toContainEqual({ startLineNumber: 6, startColumn: 11, endLineNumber: 6, endColumn: 18 }); // Foo.bar
  });
  it("counts the cursor at a name's end as on it (Lean's findAt includes the stop)", async () => {
    expect(await setup(BAR).refs.provideReferences(model(DOC), { lineNumber: 2, column: 8 }, {}, null)).toHaveLength(5);
  });
  it("gives nothing for documentHighlight's return fallback (measured: `return` answers its `do`)", async () => {
    expect(await setup([{ kind: 1, range: at(DO, 0, "do") }]).refs.provideReferences(model(DO), ON_RETURN, {}, null)).toEqual([]);
    expect(await setup([{ kind: 1, range: at(DO, 1, "return") }]).refs.provideReferences(model(DO), ON_RETURN, {}, null)).toEqual([]);
  });
  it("gives nothing when the request fails (no client, cancelled, a restart) or the reply is not an array of ranges", async () => {
    expect(await setup(new Error("No connection to Lean")).refs.provideReferences(model(DOC), DEF_BAR, {}, null)).toEqual([]);
    expect(await setup(null).refs.provideReferences(model(DOC), DEF_BAR, {}, null)).toEqual([]);
    expect(await setup([{ kind: 1 }, { range: { start: {} } }]).refs.provideReferences(model(DOC), DEF_BAR, {}, null)).toEqual([]);
  });
});

describe("single-document rename (UX parity E5.4)", () => {
  it("reproduces native Lean's rename byte for byte", async () => {
    const { rename } = setup(BAR);
    expect(await rename.resolveRenameLocation(model(DOC), DEF_BAR, null)).toEqual({ range: { startLineNumber: 2, startColumn: 5, endLineNumber: 2, endColumn: 8 }, text: "bar" });
    const result = await rename.provideRenameEdits(model(DOC), DEF_BAR, "baz", null);
    expect(result.rejectReason).toBeUndefined();
    expect(apply(DOC, result.edits)).toBe(NATIVE_RENAME);
    expect(result.edits.every((e) => e.versionId === 1 && e.resource.toString() === URI)).toBe(true);
  });
  it("keeps the watchdog's rule: sorted, one range per start (the later wins), overlaps dropped", () => {
    const r = (line: number, s: number, e: number) => ({ start: { line, character: s }, end: { line, character: e } });
    expect(renameRanges([r(3, 0, 3), r(1, 4, 11), r(1, 6, 9), r(1, 4, 7), r(0, 0, 2)])).toEqual([r(0, 0, 2), r(1, 4, 7), r(3, 0, 3)]);
  });
  it("waits until the checker is ready on the editor's text, without asking Lean", async () => {
    const cases: Array<[Status, number]> = [
      [{ phase: "elaborating", relay: "serving", version: 1 }, 1],
      [{ phase: "ready", relay: "rebooting", version: 1 }, 1],
      [{ phase: "halted", relay: "halted", version: 1 }, 1],
      [READY, 2], // a keystroke the client has not sent yet
      [{ phase: "ready", relay: "serving", version: null }, 1],
    ];
    for (const [status, version] of cases) {
      expect(renameRefusal(status, version)).toBe(RENAME_WAIT);
      const { rename, request } = setup(BAR, status);
      expect(await rename.resolveRenameLocation(model(DOC, version), DEF_BAR, null)).toMatchObject({ rejectReason: RENAME_WAIT });
      expect(await rename.provideRenameEdits(model(DOC, version), DEF_BAR, "baz", null)).toEqual({ edits: [], rejectReason: RENAME_WAIT });
      expect(request).not.toHaveBeenCalled();
    }
    expect(renameRefusal(READY, 1)).toBeNull();
  });
  it("refuses where there is no name: blank space, and `return`", async () => {
    expect(await setup([]).rename.resolveRenameLocation(model(DOC), { lineNumber: 5, column: 1 }, null)).toMatchObject({ rejectReason: RENAME_NOTHING });
    expect(await setup([{ kind: 1, range: at(DO, 0, "do") }]).rename.resolveRenameLocation(model(DO), ON_RETURN, null)).toMatchObject({ rejectReason: RENAME_NOTHING });
    expect(await setup([{ kind: 1, range: at(DO, 1, "return") }]).rename.provideRenameEdits(model(DO), ON_RETURN, "x", null)).toEqual({ edits: [], rejectReason: RENAME_NOTHING });
  });
  it("refuses a new name that is not a Lean identifier, without asking Lean", async () => {
    for (const bad of ["", "a b", "1x", "x.", ".x", "f(x)", "a..b"]) expect(isLeanName(bad), bad).toBe(false);
    for (const good of ["baz", "Foo.baz", "h₁", "x'", "α", "«my name»", "_root_.baz", "ℕ_le", "foo!", "bar?"]) expect(isLeanName(good), good).toBe(true);
    const { rename, request } = setup(BAR);
    expect((await rename.provideRenameEdits(model(DOC), DEF_BAR, "a b", null)).rejectReason).toMatch(/not an identifier/);
    expect(request).not.toHaveBeenCalled();
  });
});
