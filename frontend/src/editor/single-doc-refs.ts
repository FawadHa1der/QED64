// Find references (Shift+F12) and rename (F2) for the editor's one document (UX parity E5.3,
// E5.4; docs/HARDENING.md #90).
//
// Lean answers both only in its watchdog, from the ilean index of every module (Watchdog.lean
// handleReference, handleRename); QED64 runs the FileWorker alone, so the front door leaves both
// out (tests/unit/server-capabilities.test.ts). For one file the FileWorker's documentHighlight
// computes the same data (RequestHandling.lean handleDocumentHighlight: refs.findAt, the
// definition plus every usage), so both providers ask it, through the editor's own LSP client,
// which sends a pending didChange first (a request around the client would ask about old text):
//   * references: the highlight ranges, as locations in this document;
//   * rename: the watchdog's rule, each whole range replaced by the new name (byte-identical to
//     native Lean's rename in the UX parity study, 2026-11-06, `Foo.bar` → `baz` included).
// Two traps, both measured: on `return`, documentHighlight falls back to the enclosing `do`, so a
// result must contain the cursor and not be a keyword; and it reads only finished commands, so
// rename waits until the checker is ready on the editor's current text. Monaco drops a rename
// whose text or cursor changed meanwhile, refuses an edit whose versionId is stale, and applies
// the rename as one undo step.
//
// No monaco-editor import (as infoview-edits.ts): main.ts passes `monaco.languages`, and the
// unit tests load this module without Monaco.

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
export interface MonacoRange { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
export interface MonacoPosition { lineNumber: number; column: number }
/** The slice of Monaco's text model the providers read. */
export interface RefsModel {
  readonly uri: { toString(): string };
  getVersionId(): number;
  getValueInRange(range: MonacoRange): string;
}
type Rejectable<T> = T & { rejectReason?: string };
type RenameEdit = { resource: RefsModel["uri"]; versionId: number; textEdit: { range: MonacoRange; text: string } };
/** The slice of `monaco.languages` used here. */
export interface RefsLanguages {
  registerReferenceProvider(languageId: string, provider: {
    provideReferences(model: RefsModel, position: MonacoPosition, context: unknown, token: unknown): Promise<Array<{ uri: RefsModel["uri"]; range: MonacoRange }>>;
  }): { dispose(): void };
  registerRenameProvider(languageId: string, provider: {
    resolveRenameLocation(model: RefsModel, position: MonacoPosition, token: unknown): Promise<Rejectable<{ range: MonacoRange; text: string }>>;
    provideRenameEdits(model: RefsModel, position: MonacoPosition, newName: string, token: unknown): Promise<Rejectable<{ edits: RenameEdit[] }>>;
  }): { dispose(): void };
}
export interface RefsDeps {
  /** One request through the editor's LSP client (it sends a pending didChange first); rejects without a client. */
  request(method: string, params: unknown, token: unknown): Promise<unknown>;
  /** The checker's status (the page API's `status()`). */
  status(): { phase: string; relay: string; version: number | null };
}

export const RENAME_WAIT = "Lean is still checking this file: rename once the status reads ready";
export const RENAME_NOTHING = "You cannot rename this element";

const toLsp = (p: MonacoPosition): LspPosition => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toMonaco = (r: LspRange): MonacoRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });
const before = (a: LspPosition, b: LspPosition) => a.line < b.line || (a.line === b.line && a.character < b.character);
/** The end counts too, as in Lean's `findAt … (includeStop := true)`. */
const contains = (r: LspRange, p: LspPosition) => !before(p, r.start) && !before(r.end, p);
const isPos = (p: unknown): p is LspPosition => typeof (p as LspPosition | undefined)?.line === "number" && typeof (p as LspPosition | undefined)?.character === "number";

/** The occurrences of the name under the cursor in a documentHighlight reply, or null when there is none: the
 * reply's `return` fallback (its `do`, or the `return` keyword itself) is not a name. */
function occurrences(reply: unknown, at: LspPosition, textOf: (r: LspRange) => string): LspRange[] | null {
  const ranges = (Array.isArray(reply) ? reply : []).map((h) => (h as { range?: LspRange } | null)?.range)
    .filter((r): r is LspRange => isPos(r?.start) && isPos(r?.end));
  const here = ranges.find((r) => contains(r, at));
  return here && !/^(?:return|do)$/.test(textOf(here)) ? ranges : null;
}

/** Watchdog.lean handleRename's rule: one range per start (a later one replaces it), sorted by start, and a range
 * that starts before the previous kept one ends is dropped. */
export function renameRanges(ranges: LspRange[]): LspRange[] {
  const byStart = new Map(ranges.map((r) => [`${r.start.line}:${r.start.character}`, r] as const));
  const sorted = [...byStart.values()].sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character);
  const kept: LspRange[] = [];
  let last: LspPosition = { line: 0, character: 0 };
  for (const r of sorted) if (!before(r.start, last)) { kept.push(r); last = r.end; }
  return kept;
}

// Roughly Lean's identifier characters (Init/Meta/Defs.lean isIdFirst, isIdRest): «…» escapes a part, and parts are
// joined by dots. Lean reports what this lets through, and one undo restores the text.
const PART = String.raw`(?:«[^»]+»|[\p{L}_][\p{L}\p{N}_'!?]*)`;
const LEAN_NAME = new RegExp(String.raw`^${PART}(?:\.${PART})*$`, "u");
export const isLeanName = (name: string): boolean => LEAN_NAME.test(name);

/** Why rename must wait, or null: it reads only finished commands, so the checker must be ready on this text. */
export function renameRefusal(s: ReturnType<RefsDeps["status"]>, versionId: number): string | null {
  return s.phase === "ready" && s.relay === "serving" && s.version === versionId ? null : RENAME_WAIT;
}

export function registerSingleDocRefs(languages: RefsLanguages, deps: RefsDeps): { dispose(): void } {
  const occurrencesAt = async (model: RefsModel, position: MonacoPosition, token: unknown): Promise<LspRange[] | null> => {
    const at = toLsp(position);
    // A refused or cancelled request, a restart, or no client yet: no occurrences.
    const reply = await deps.request("textDocument/documentHighlight", { textDocument: { uri: model.uri.toString() }, position: at }, token).catch(() => null);
    return occurrences(reply, at, (r) => model.getValueInRange(toMonaco(r)));
  };
  const refs = languages.registerReferenceProvider("lean4", {
    async provideReferences(model, position, _context, token) {
      return ((await occurrencesAt(model, position, token)) ?? []).map((r) => ({ uri: model.uri, range: toMonaco(r) }));
    },
  });
  const rename = languages.registerRenameProvider("lean4", {
    // Monaco shows this rejection at the cursor, before the rename box opens (provideRenameEdits' would go to the
    // notification service, which this page does not show), so both refusals that matter are made here.
    async resolveRenameLocation(model, position, token) {
      const nowhere = { range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }, text: "" };
      const wait = renameRefusal(deps.status(), model.getVersionId());
      if (wait) return { ...nowhere, rejectReason: wait };
      const here = (await occurrencesAt(model, position, token))?.find((r) => contains(r, toLsp(position)));
      return here ? { range: toMonaco(here), text: model.getValueInRange(toMonaco(here)) } : { ...nowhere, rejectReason: RENAME_NOTHING };
    },
    async provideRenameEdits(model, position, newName, token) {
      if (!isLeanName(newName)) return { edits: [], rejectReason: `Can't rename: \`${newName}\` is not an identifier` };
      const versionId = model.getVersionId();
      const wait = renameRefusal(deps.status(), versionId);
      const ranges = wait ? null : await occurrencesAt(model, position, token);
      if (!ranges) return { edits: [], rejectReason: wait ?? RENAME_NOTHING };
      // versionId: Monaco refuses these edits if the text changed after this answer.
      return { edits: renameRanges(ranges).map((r) => ({ resource: model.uri, versionId, textEdit: { range: toMonaco(r), text: newName } })) };
    },
  });
  return { dispose() { refs.dispose(); rename.dispose(); } };
}
