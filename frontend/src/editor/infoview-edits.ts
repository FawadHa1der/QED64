// The InfoView's editor actions, done against the page's Monaco model
// (docs/HARDENING.md #56, the half of the lean4monaco fix that lives in the page).
//
// vscode-lean4's InfoProvider implements `applyEdit` (core "Try this" [apply],
// ProofWidgets MakeEditLink, `conv?`'s "Generate conv"), `insertText` and
// `showDocument` through the vscode API (`window.showTextDocument`,
// `workspace.applyEdit`); lean4monaco's editor-service stub throws
// "unsupported" for `showTextDocument`, so every one of them failed. QED64 has
// exactly one document — the editor's model — so the three actions are done
// on it directly, with vscode-lean4's semantics:
//   * applyEdit: one document only (an edit touching any other URI is ignored,
//     as upstream ignores an edit for a file no editor shows); the text edits
//     are applied as ONE undoable step;
//   * insertText: "above" inserts a new line above the position, indented like
//     it; anything else inserts at the position (default: the cursor) and puts
//     the cursor there;
//   * showDocument: reveals and selects the range in this document; other
//     documents (go-to-definition into Mathlib) cannot be opened and are
//     ignored.
// The page installs the wrapper through `globalThis.__qed64InfoviewEditorApi`,
// which the patched lean4monaco page module (frontend/build/lean4monaco-fixes.mjs)
// calls when it registers the API for the InfoView iframe.

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspTextEdit { range: LspRange; newText: string }
interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument?: { uri: string; version?: number | null }; edits?: LspTextEdit[]; kind?: string }>;
}
interface MonacoRange { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
interface MonacoPosition { lineNumber: number; column: number }
/** The slice of Monaco's ITextModel this module uses. */
export interface EditsModel {
  uri: { toString(): string };
  getLineContent(lineNumber: number): string;
  getLineCount(): number;
}
/** The slice of Monaco's ICodeEditor this module uses. */
export interface EditsEditor {
  getModel(): EditsModel | null;
  getPosition(): MonacoPosition | null;
  executeEdits(source: string, edits: Array<{ range: MonacoRange; text: string; forceMoveMarkers?: boolean }>): boolean;
  pushUndoStop(): boolean;
  setSelection(range: MonacoRange): void;
  revealRangeInCenterIfOutsideViewport(range: MonacoRange): void;
  focus(): void;
}

const SOURCE = "qed64-infoview";
const decode = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };
/** Same document? (URI spellings differ in percent-encoding only.) */
export const sameUri = (a: string, b: string) => decode(a) === decode(b);
const toRange = (r: LspRange): MonacoRange => ({
  startLineNumber: r.start.line + 1, startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1, endColumn: r.end.character + 1,
});
const at = (p: LspPosition): MonacoRange => toRange({ start: p, end: p });

/** Apply an LSP WorkspaceEdit to the editor's document. Returns whether anything was applied. */
export function applyWorkspaceEdit(editor: EditsEditor, edit: LspWorkspaceEdit): boolean {
  const model = editor.getModel();
  if (!model || !edit) return false;
  const uri = model.uri.toString();
  const edits: LspTextEdit[] = [];
  let foreign = false;
  for (const [u, tes] of Object.entries(edit.changes ?? {})) {
    if (sameUri(u, uri)) edits.push(...tes);
    else foreign = true;
  }
  for (const dc of edit.documentChanges ?? []) {
    if (dc.kind !== undefined || !dc.textDocument || !Array.isArray(dc.edits)) { foreign = true; continue; } // create/rename/delete file
    if (sameUri(dc.textDocument.uri, uri)) edits.push(...dc.edits);
    else foreign = true;
  }
  if (foreign || edits.length === 0) return false;
  editor.pushUndoStop();
  editor.executeEdits(SOURCE, edits.map((te) => ({ range: toRange(te.range), text: te.newText, forceMoveMarkers: true })));
  editor.pushUndoStop();
  editor.focus();
  return true;
}

/** vscode-lean4's handleInsertText on the editor's document. */
export function insertTextIn(editor: EditsEditor, text: string, kind: string, tdpp?: { textDocument: { uri: string }; position: LspPosition }): boolean {
  const model = editor.getModel();
  if (!model) return false;
  if (tdpp && !sameUri(tdpp.textDocument.uri, model.uri.toString())) return false;
  const cursor = editor.getPosition();
  const pos: LspPosition = tdpp ? tdpp.position : cursor ? { line: cursor.lineNumber - 1, character: cursor.column - 1 } : { line: 0, character: 0 };
  editor.pushUndoStop();
  if (kind === "above") {
    const line = model.getLineContent(Math.min(pos.line + 1, model.getLineCount()));
    const indent = line.length - line.trimStart().length; // VS Code: firstNonWhitespaceCharacterIndex (whole line when blank)
    const margin = " ".repeat(indent);
    const block = `${margin}${text.replace(/\n/g, `\n${margin}`)}\n`;
    editor.executeEdits(SOURCE, [{ range: at({ line: pos.line, character: 0 }), text: block, forceMoveMarkers: true }]);
  } else {
    editor.executeEdits(SOURCE, [{ range: at(pos), text, forceMoveMarkers: true }]);
    editor.setSelection(at(pos));
  }
  editor.pushUndoStop();
  editor.focus();
  return true;
}

/** Reveal and select a range of the editor's document; another document is ignored. */
export function showDocumentIn(editor: EditsEditor, show: { uri: string; selection?: LspRange }): boolean {
  const model = editor.getModel();
  if (!model || !show || !sameUri(show.uri, model.uri.toString())) return false;
  if (show.selection) {
    const range = toRange(show.selection);
    editor.revealRangeInCenterIfOutsideViewport(range);
    editor.setSelection(range);
  }
  editor.focus();
  return true;
}

/** The InfoProvider's EditorRpcApi with the three editor actions replaced
 * (Rpc.register copies own properties, so a plain spread is enough). */
export function wrapEditorRpcApi<T extends object>(api: T, getEditor: () => EditsEditor | undefined): T {
  const run = <A extends unknown[]>(f: (e: EditsEditor, ...a: A) => boolean) => async (...a: A): Promise<void> => {
    const editor = getEditor();
    if (editor) f(editor, ...a);
  };
  return {
    ...api,
    applyEdit: run(applyWorkspaceEdit),
    insertText: run(insertTextIn),
    showDocument: run(showDocumentIn),
  };
}

/** Install the hook the patched lean4monaco page module calls; before the editor starts. */
export function installInfoviewEditorApi(getEditor: () => EditsEditor | undefined): void {
  (globalThis as unknown as { __qed64InfoviewEditorApi?: (api: object) => object }).__qed64InfoviewEditorApi = (api) => wrapEditorRpcApi(api, getEditor);
}
