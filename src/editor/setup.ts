// CodeMirror 6 assembly for the QED64 editor pane.

import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { leanLanguage } from "./lean-language";
import { leanAbbreviations } from "./abbreviations";
import type { Diagnostic } from "../runtime/client";

const highlight = HighlightStyle.define([
  { tag: tags.definitionKeyword, color: "var(--syn-command)", fontWeight: "600" },
  { tag: tags.keyword, color: "var(--syn-keyword)" },
  { tag: tags.controlKeyword, color: "var(--syn-tactic)" },
  { tag: tags.typeName, color: "var(--syn-type)" },
  { tag: tags.variableName, color: "var(--syn-var)" },
  { tag: tags.string, color: "var(--syn-string)" },
  { tag: tags.number, color: "var(--syn-number)" },
  { tag: tags.lineComment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: tags.blockComment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: tags.operator, color: "var(--syn-operator)" },
  { tag: tags.meta, color: "var(--syn-attribute)" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "14px",
    backgroundColor: "var(--editor-bg)",
    color: "var(--editor-fg)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.55",
  },
  ".cm-content": { padding: "12px 0", caretColor: "var(--accent)" },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--editor-gutter)",
    border: "none",
    paddingRight: "6px",
  },
  ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--editor-active-line)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--editor-selection) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--error) 1px",
    textUnderlineOffset: "3px",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--warn) 1px",
    textUnderlineOffset: "3px",
  },
  ".cm-diagnostic": {
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    whiteSpace: "pre-wrap",
  },
});

export interface EditorHandle {
  view: EditorView;
  getSource(): string;
  setSource(text: string): void;
  setLeanDiagnostics(diagnostics: Diagnostic[]): void;
  onChange(listener: () => void): void;
  onCursor(listener: (line: number) => void): void;
}

/** Convert Lean 1-based line/column diagnostics into CodeMirror ranges. */
export function toCmDiagnostics(state: EditorState, diagnostics: Diagnostic[]): CmDiagnostic[] {
  const out: CmDiagnostic[] = [];
  for (const d of diagnostics) {
    if (!Number.isFinite(d.line) || d.line < 1) continue;
    const lineNumber = Math.min(d.line, state.doc.lines);
    const line = state.doc.line(lineNumber);
    const from = Math.min(line.from + Math.max(0, d.column), line.to);
    let to: number;
    if (d.endLine && d.endColumn !== undefined && d.endLine >= d.line) {
      const endLine = state.doc.line(Math.min(d.endLine, state.doc.lines));
      to = Math.min(endLine.from + Math.max(0, d.endColumn), endLine.to);
    } else {
      // Highlight to the end of the token: nearest whitespace, else line end.
      const rest = state.doc.sliceString(from, line.to);
      const space = rest.search(/\s/);
      to = space > 0 ? from + space : line.to;
    }
    if (to <= from) to = Math.min(from + 1, state.doc.length);
    out.push({
      from,
      to,
      severity: d.severity === "information" ? "info" : d.severity,
      message: d.message,
      source: "lean",
    });
  }
  return out;
}

export function createEditor(parent: HTMLElement, initialSource: string): EditorHandle {
  const changeListeners: (() => void)[] = [];
  const cursorListeners: ((line: number) => void)[] = [];
  const themeCompartment = new Compartment();

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: initialSource,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        leanLanguage,
        syntaxHighlighting(highlight),
        leanAbbreviations(),
        lintGutter(), // diagnostics are pushed via setDiagnostics, not pulled
        themeCompartment.of(editorTheme),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) for (const fn of changeListeners) fn();
          if (update.selectionSet) {
            const line = update.state.doc.lineAt(update.state.selection.main.head).number;
            for (const fn of cursorListeners) fn(line);
          }
        }),
      ],
    }),
  });

  return {
    view,
    getSource: () => view.state.doc.toString(),
    setSource: (text) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    setLeanDiagnostics: (diagnostics) =>
      view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state, diagnostics))),
    onChange: (fn) => changeListeners.push(fn),
    onCursor: (fn) => cursorListeners.push(fn),
  };
}
