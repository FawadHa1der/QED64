// Parser-coverage lint.
//
// The shipped runtime's wasmCompile drops PARSER messages (see
// pipeline/toolchain/PATCHES.md), so text the parser skips produces no
// diagnostic at all. This module closes the user-visible gap with a
// deliberately conservative client-side check built on the same convention
// Lean's own error recovery uses: a top-level command begins at column 0 with
// a recognized command token. Any column-0 line that cannot begin a command —
// while we are not inside a comment, string, or open bracket — is text the
// parser will silently discard, and gets a clearly-labeled warning.
//
// False negatives are fine (an unterminated `theorem … :` still slips
// through); false positives are treated as bugs and pinned by tests.

import type { Diagnostic } from "../runtime/client";

/** Tokens that can begin a top-level command (or its modifiers). */
const COMMAND_STARTERS = new Set([
  "import", "open", "namespace", "end", "section", "universe", "variable",
  "variables", "noncomputable", "mutual", "class", "instance", "structure",
  "inductive", "coinductive", "abbrev", "def", "theorem", "lemma", "example",
  "axiom", "constant", "opaque", "macro", "macro_rules", "syntax", "notation",
  "infix", "infixl", "infixr", "prefix", "postfix", "attribute", "export",
  "set_option", "public", "private", "protected", "scoped", "local",
  "partial", "unsafe", "meta", "module", "prelude", "deriving",
  "declare_syntax_cat", "elab", "elab_rules", "run_cmd", "run_elab",
  "initialize", "builtin_initialize", "recall", "in", "where",
]);

interface ScanState {
  commentDepth: number;
  inString: boolean;
  bracketDepth: number;
}

const OPEN_BRACKETS = new Set(["(", "[", "{", "⟨", "⟦", "⦃", "«"]);
const CLOSE_BRACKETS = new Set([")", "]", "}", "⟩", "⟧", "⦄", "»"]);

/** Advance the scan state across one line's characters. */
function scanLine(line: string, state: ScanState): void {
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    const next = line[i + 1];
    if (state.inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') state.inString = false;
      i += 1;
      continue;
    }
    if (state.commentDepth > 0) {
      if (ch === "/" && next === "-") {
        state.commentDepth += 1;
        i += 2;
        continue;
      }
      if (ch === "-" && next === "/") {
        state.commentDepth -= 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") return; // line comment
    if (ch === "/" && next === "-") {
      state.commentDepth += 1;
      i += 2;
      continue;
    }
    if (ch === '"') {
      state.inString = true;
      i += 1;
      continue;
    }
    if (ch === "'" && line[i + 2] === "'" && next !== "\\") {
      i += 3; // simple char literal
      continue;
    }
    if (OPEN_BRACKETS.has(ch)) state.bracketDepth += 1;
    else if (CLOSE_BRACKETS.has(ch)) state.bracketDepth = Math.max(0, state.bracketDepth - 1);
    i += 1;
  }
}

/** Can this column-0 line begin (or continue) a top-level command? */
function lineCanStartCommand(line: string): boolean {
  const first = line[0]!;
  // Continuation forms that legitimately sit at column 0.
  if (first === "|" || first === "@" || first === "#" || first === "«") return true;
  if (first === "/" && line[1] === "-") return true;
  if (first === "-" && line[1] === "-") return true;
  const match = /^[A-Za-z_][A-Za-z0-9_'.]*/.exec(line);
  if (!match) return false;
  return COMMAND_STARTERS.has(match[0]);
}

/**
 * Return warnings for column-0 lines the Lean parser would silently skip.
 * `source` is the full buffer; line/column follow Lean (1-based line,
 * 0-based column).
 */
export function parseCoverageLints(source: string): Diagnostic[] {
  const warnings: Diagnostic[] = [];
  const state: ScanState = { commentDepth: 0, inString: false, bracketDepth: 0 };
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const atTopLevel =
      state.commentDepth === 0 && !state.inString && state.bracketDepth === 0;
    if (
      atTopLevel &&
      line.length > 0 &&
      line[0] !== " " &&
      line[0] !== "\t" &&
      !lineCanStartCommand(line)
    ) {
      warnings.push({
        fileName: "input.lean",
        line: index + 1,
        column: 0,
        severity: "warning",
        message:
          "This text cannot start a Lean command; the parser will skip it. " +
          "Remove it or indent it under the command it belongs to.",
      });
    }
    scanLine(line, state);
  }
  return warnings;
}
