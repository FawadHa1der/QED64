// The InfoView's editor actions on the page's Monaco model
// (frontend/src/editor/infoview-edits.ts, docs/HARDENING.md #56), against a
// small in-memory stand-in for Monaco's editor and model.
import { describe, expect, it } from "vitest";
import { applyWorkspaceEdit, insertTextIn, installInfoviewEditorApi, sameUri, showDocumentIn, wrapEditorRpcApi, type EditsEditor } from "../../frontend/src/editor/infoview-edits";

const URI = "file:///project/Probe.lean";
type R = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
function fakeEditor(text: string, uri = URI) {
  let doc = text;
  const log: string[] = [];
  const offset = (line: number, col: number) => {
    const lines = doc.split("\n");
    let o = 0;
    for (let i = 0; i < line - 1; i++) o += lines[i]!.length + 1;
    return o + col - 1;
  };
  let selection: R | null = null;
  let position = { lineNumber: 1, column: 1 };
  const editor: EditsEditor & { text(): string; log: string[]; selection(): R | null; setPosition(p: { lineNumber: number; column: number }): void } = {
    getModel: () => ({ uri: { toString: () => uri }, getLineContent: (n) => doc.split("\n")[n - 1] ?? "", getLineCount: () => doc.split("\n").length }),
    getPosition: () => position,
    executeEdits: (_src, edits) => {
      // Apply back to front so earlier offsets stay valid (Monaco does the same).
      const sorted = [...edits].sort((a, b) => offset(b.range.startLineNumber, b.range.startColumn) - offset(a.range.startLineNumber, a.range.startColumn));
      for (const e of sorted) doc = doc.slice(0, offset(e.range.startLineNumber, e.range.startColumn)) + e.text + doc.slice(offset(e.range.endLineNumber, e.range.endColumn));
      log.push(`edit×${edits.length}`);
      return true;
    },
    pushUndoStop: () => { log.push("undo-stop"); return true; },
    setSelection: (r) => { selection = r; },
    revealRangeInCenterIfOutsideViewport: () => { log.push("reveal"); },
    focus: () => { log.push("focus"); },
    text: () => doc,
    log,
    selection: () => selection,
    setPosition: (p) => { position = p; },
  };
  return editor;
}
const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

describe("applyEdit (core Try this [apply], MakeEditLink, conv? Generate)", () => {
  it("applies `changes` for this document as one undoable step", () => {
    const ed = fakeEditor("example (n : Nat) : n + 0 = n := by simp?\n");
    expect(applyWorkspaceEdit(ed, { changes: { [URI]: [{ range: range(0, 36, 0, 41), newText: "simp only [Nat.add_zero]" }] } })).toBe(true);
    expect(ed.text()).toBe("example (n : Nat) : n + 0 = n := by simp only [Nat.add_zero]\n");
    expect(ed.log).toEqual(["undo-stop", "edit×1", "undo-stop", "focus"]);
  });
  it("applies `documentChanges` (TextDocumentEdit) with several edits, URI spelled with percent-encoding", () => {
    const ed = fakeEditor("ab\ncd\n");
    const edit = { documentChanges: [{ textDocument: { uri: "file:///project/Probe%2Elean", version: 3 }, edits: [{ range: range(0, 0, 0, 1), newText: "A" }, { range: range(1, 1, 1, 2), newText: "D" }] }] };
    expect(applyWorkspaceEdit(ed, edit)).toBe(true);
    expect(ed.text()).toBe("Ab\ncD\n");
  });
  it("ignores an edit that touches another document or creates files (vscode-lean4: one document only)", () => {
    const ed = fakeEditor("x\n");
    expect(applyWorkspaceEdit(ed, { changes: { [URI]: [{ range: range(0, 0, 0, 1), newText: "y" }], "file:///other.lean": [] } })).toBe(false);
    expect(applyWorkspaceEdit(ed, { documentChanges: [{ kind: "create", textDocument: { uri: URI } }] })).toBe(false);
    expect(applyWorkspaceEdit(ed, { changes: {} })).toBe(false);
    expect(ed.text()).toBe("x\n");
  });
});

describe("insertText", () => {
  it("'above' inserts a new line indented like the target line", () => {
    const ed = fakeEditor("theorem t : True := by\n  trivial\n");
    expect(insertTextIn(ed, "skip\nskip", "above", { textDocument: { uri: URI }, position: { line: 1, character: 4 } })).toBe(true);
    expect(ed.text()).toBe("theorem t : True := by\n  skip\n  skip\n  trivial\n");
  });
  it("'here' inserts at the cursor and leaves the cursor there", () => {
    const ed = fakeEditor("by \n");
    ed.setPosition({ lineNumber: 1, column: 4 });
    expect(insertTextIn(ed, "rfl", "here")).toBe(true);
    expect(ed.text()).toBe("by rfl\n");
    expect(ed.selection()).toEqual({ startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 4 });
  });
  it("ignores another document", () => {
    const ed = fakeEditor("x");
    expect(insertTextIn(ed, "y", "here", { textDocument: { uri: "file:///Mathlib/Order/Basic.lean" }, position: { line: 0, character: 0 } })).toBe(false);
    expect(ed.text()).toBe("x");
  });
});

describe("showDocument", () => {
  it("reveals and selects a range of this document", () => {
    const ed = fakeEditor("a\nb\nc\n");
    expect(showDocumentIn(ed, { uri: URI, selection: range(2, 0, 2, 1) })).toBe(true);
    expect(ed.selection()).toEqual({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 2 });
    expect(ed.log).toEqual(["reveal", "focus"]);
  });
  it("ignores another document (go-to-definition into Mathlib cannot open a file here)", () => {
    const ed = fakeEditor("a");
    expect(showDocumentIn(ed, { uri: "file:///lib/lean/Mathlib/Order/Basic.lean", selection: range(0, 0, 0, 1) })).toBe(false);
    expect(ed.log).toEqual([]);
  });
});

describe("the EditorRpcApi wrapper and its install hook", () => {
  it("keeps every other member and replaces only the three editor actions", async () => {
    const ed = fakeEditor("x\n");
    const unsupported = (..._a: unknown[]): Promise<void> => { throw new Error("unsupported"); };
    const api = { startClientRequest: () => 1, applyEdit: unsupported, insertText: unsupported, showDocument: unsupported };
    const wrapped = wrapEditorRpcApi(api, () => ed);
    expect(wrapped.startClientRequest).toBe(api.startClientRequest);
    await wrapped.applyEdit({ changes: { [URI]: [{ range: range(0, 0, 0, 1), newText: "y" }] } } as never);
    expect(ed.text()).toBe("y\n");
    // No editor yet (the InfoView can register before the editor mounts): a no-op, not a throw.
    await expect(wrapEditorRpcApi(api, () => undefined).showDocument({ uri: URI } as never)).resolves.toBeUndefined();
  });
  it("installs the hook the patched lean4monaco page module calls", () => {
    installInfoviewEditorApi(() => undefined);
    const hook = (globalThis as unknown as { __qed64InfoviewEditorApi?: (a: object) => Record<string, unknown> }).__qed64InfoviewEditorApi;
    expect(typeof hook).toBe("function");
    const api = hook!({ saveConfig: 1 });
    expect(api.saveConfig).toBe(1);
    expect(typeof api.applyEdit).toBe("function");
  });
  it("sameUri compares percent-decoded spellings", () => {
    expect(sameUri("file:///a%20b.lean", "file:///a b.lean")).toBe(true);
    expect(sameUri("file:///a.lean", "file:///b.lean")).toBe(false);
  });
});
