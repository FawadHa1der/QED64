// Unicode abbreviation input for Lean: `\alpha` → α, `\to` → →, `\<` → ⟨ …
//
// Behavior follows the convention Lean users know from VS Code and
// live.lean-lang.org: a backslash starts an abbreviation; typing narrows the
// candidates; the replacement commits when (a) the text is a unique longest
// match and the next keystroke cannot extend it, (b) Tab is pressed, or
// (c) a non-abbreviation character arrives after at least one match.
//
// The engine is a pure function over (text, caret) so it is trivially
// testable; the CodeMirror plugin below is a thin adapter.

import { EditorView, keymap } from "@codemirror/view";
import { EditorState, type TransactionSpec } from "@codemirror/state";

// A curated table covering everything the bundled examples and mainstream
// Mathlib work need. Order does not matter; longest-match wins.
export const ABBREVIATIONS: Record<string, string> = {
  // Logic
  "to": "→", "r": "→", "imp": "→", "iff": "↔", "l": "←", "gets": "←",
  "and": "∧", "or": "∨", "not": "¬", "neg": "¬", "forall": "∀", "all": "∀",
  "exists": "∃", "ex": "∃", "top": "⊤", "bot": "⊥", "entails": "⊢",
  "vdash": "⊢", "models": "⊨", "proves": "⊢", "fa": "∀",
  // Equality and order
  "ne": "≠", "neq": "≠", "le": "≤", "ge": "≥", "ll": "≪", "gg": "≫",
  "sim": "∼", "equiv": "≃", "cong": "≅", "approx": "≈", "prec": "≺",
  "succeq": "≽", "preceq": "≼", "mid": "∣", "nmid": "∤",
  // Sets
  "in": "∈", "notin": "∉", "nin": "∉", "sub": "⊆", "subset": "⊂",
  "sup": "⊇", "supset": "⊃", "ssub": "⊂", "cup": "∪", "cap": "∩",
  "union": "∪", "inter": "∩", "empty": "∅", "setminus": "∖", "smallsetminus": "∖",
  "compl": "ᶜ", "powerset": "𝒫",
  // Arrows
  "hom": "⟶", "iso": "≅", "mapsto": "↦", "map": "↦", "hookrightarrow": "↪",
  "twoheadrightarrow": "↠", "rightarrow": "→", "leftarrow": "←",
  "leftrightarrow": "↔", "Rightarrow": "⇒", "Leftarrow": "⇐", "Leftrightarrow": "⇔",
  "up": "↑", "down": "↓", "uparrow": "↑", "downarrow": "↓",
  // Operators
  "comp": "∘", "circ": "∘", "times": "×", "x": "×", "cdot": "·", "mul": "·",
  "div": "÷", "pm": "±", "mp": "∓", "oplus": "⊕", "otimes": "⊗", "odot": "⊙",
  "sum": "∑", "prod": "∏", "int": "∫", "sqrt": "√", "infty": "∞", "inf": "⊓",
  "sup'": "⊔", "glb": "⊓", "lub": "⊔", "bub": "⊔", "sqcup": "⊔", "sqcap": "⊓",
  "star": "⋆", "ast": "∗", "bullet": "•", "smul": "•", "vadd": "+ᵥ",
  "inv": "⁻¹", "-1": "⁻¹", "prime": "′", "'": "′", "dagger": "†",
  // Brackets
  "<": "⟨", ">": "⟩", "<<": "⟪", ">>": "⟫", "lb": "⟦", "rb": "⟧",
  "[[": "⟦", "]]": "⟧", "{{": "⦃", "}}": "⦄", "f<": "‹", "f>": "›",
  "flr": "⌊", "frr": "⌋", "clr": "⌈", "crr": "⌉", "norm": "‖", "||": "‖",
  "abs": "|",
  // Greek (lowercase)
  "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
  "eps": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "iota": "ι",
  "kappa": "κ", "lambda": "λ", "fun": "λ", "mu": "μ", "nu": "ν", "xi": "ξ",
  "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ",
  "phi": "φ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
  // Greek (uppercase)
  "Alpha": "Α", "Beta": "Β", "Gamma": "Γ", "Delta": "Δ", "Epsilon": "Ε",
  "Zeta": "Ζ", "Eta": "Η", "Theta": "Θ", "Iota": "Ι", "Kappa": "Κ",
  "Lambda": "Λ", "Mu": "Μ", "Nu": "Ν", "Xi": "Ξ", "Pi": "Π", "Rho": "Ρ",
  "Sigma": "Σ", "Tau": "Τ", "Upsilon": "Υ", "Phi": "Φ", "Chi": "Χ",
  "Psi": "Ψ", "Omega": "Ω",
  // Blackboard bold and script
  "N": "ℕ", "Z": "ℤ", "Q": "ℚ", "R": "ℝ", "C": "ℂ", "F": "𝔽", "H": "ℍ",
  "A": "𝔸", "P": "ℙ", "K": "𝕂", "nat": "ℕ", "int'": "ℤ", "rat": "ℚ",
  "real": "ℝ", "complex": "ℂ", "aleph": "ℵ", "beth": "ℶ",
  "cal": "𝓒", "scr": "𝒮", "frak": "𝔉",
  // Subscripts and superscripts (digits)
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆",
  "7": "₇", "8": "₈", "9": "₉", "^0": "⁰", "^1": "¹", "^2": "²", "^3": "³",
  "^4": "⁴", "^5": "⁵", "^6": "⁶", "^7": "⁷", "^8": "⁸", "^9": "⁹",
  "_i": "ᵢ", "_j": "ⱼ", "_n": "ₙ", "_m": "ₘ", "_k": "ₖ", "_a": "ₐ",
  "_e": "ₑ", "_o": "ₒ", "_x": "ₓ", "^n": "ⁿ", "^i": "ⁱ",
  "T": "ᵀ", "op": "ᵒᵖ",
  // Misc Lean-isms
  "bs": "\\", "comment": "/-", "ldots": "…", "dots": "…", "..": "…",
  "deg": "°", "angle": "∠", "parallel": "∥", "perp": "⊥", "triangle": "△",
  "nabla": "∇", "partial": "∂", "wedge": "⋀", "vee": "⋁", "bigcup": "⋃",
  "bigcap": "⋂", "oint": "∮", "pr": "↣", "questeq": "≟", "eqq": "≟",
  "heq": "≍", "coloneq": "≔", "colon": "ː",
};

export interface AbbrevMatch {
  /** Offset of the leading backslash in the document. */
  from: number;
  /** End of the typed abbreviation body (the caret). */
  to: number;
  /** The abbreviation body typed so far, without the backslash. */
  body: string;
  /** The replacement for the longest matching prefix, if any. */
  replacement: string | null;
  /** Length (in body characters) consumed by the longest match. */
  matchedLength: number;
  /** Whether some longer abbreviation could still match with more typing. */
  extensible: boolean;
}

const NON_BODY = /[\s)\]},;]/;

/** Find the abbreviation under the caret: scan back to an unescaped `\`. */
export function findAbbreviation(text: string, caret: number): AbbrevMatch | null {
  let start = -1;
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (ch === "\\") {
      start = i;
      break;
    }
    if (NON_BODY.test(ch) || caret - i > 24) return null;
  }
  if (start < 0) return null;
  const body = text.slice(start + 1, caret);
  if (body.includes("\\")) return null;
  let replacement: string | null = null;
  let matchedLength = 0;
  for (let len = body.length; len >= 1; len -= 1) {
    const candidate = ABBREVIATIONS[body.slice(0, len)];
    if (candidate !== undefined) {
      replacement = candidate;
      matchedLength = len;
      break;
    }
  }
  let extensible = false;
  for (const key of Object.keys(ABBREVIATIONS)) {
    if (key.length > body.length && key.startsWith(body)) {
      extensible = true;
      break;
    }
  }
  return { from: start, to: caret, body, replacement, matchedLength, extensible };
}

/**
 * Decide what a keystroke does to a pending abbreviation.
 * Returns a document edit, or null to let the keystroke through untouched.
 */
export function applyKeystroke(
  text: string,
  caret: number,
  inserted: string,
): { from: number; to: number; insert: string } | null {
  const match = findAbbreviation(text, caret);
  if (!match) return null;
  // A second backslash right after `\` types a literal `\` (VS Code behavior).
  if (inserted === "\\" && match.body.length === 0) {
    return { from: match.from, to: caret, insert: "\\" };
  }
  if (match.replacement === null) return null;
  const wholeBodyMatched = match.matchedLength === match.body.length;

  // A body character that keeps some candidate alive: let typing continue.
  if (/^[\w'^_<>\-|[\]{}.!?=~+*/\\]$/.test(inserted) && match.extensible) return null;
  if (!wholeBodyMatched && match.matchedLength === 0) return null;
  const tail = match.body.slice(match.matchedLength);
  return {
    from: match.from,
    to: caret,
    insert: `${match.replacement}${tail}${inserted}`,
  };
}

/** Commit eagerly (Tab): replace if anything matches. */
export function commitAbbreviation(
  text: string,
  caret: number,
): { from: number; to: number; insert: string } | null {
  const match = findAbbreviation(text, caret);
  if (!match || match.replacement === null) return null;
  const tail = match.body.slice(match.matchedLength);
  return { from: match.from, to: caret, insert: `${match.replacement}${tail}` };
}

// ---------------------------------------------------------------------------
// CodeMirror integration
// ---------------------------------------------------------------------------

export function leanAbbreviations() {
  const inputFilter = EditorState.transactionFilter.of((tr) => {
    if (!tr.isUserEvent("input.type")) return tr;
    // Leave IME composition and multi-cursor input untouched: rewriting those
    // transactions corrupts composed text and drops secondary cursors.
    if (tr.isUserEvent("input.type.compose")) return tr;
    if (tr.startState.selection.ranges.length !== 1) return tr;
    let inserted = "";
    let insertFrom = -1;
    tr.changes.iterChanges((_fromA, _toA, fromB, _toB, text) => {
      inserted = text.toString();
      insertFrom = fromB;
    });
    if (inserted.length !== 1 || insertFrom < 0) return tr;
    const before = tr.startState.doc.toString();
    const caret = tr.startState.selection.main.head;
    const edit = applyKeystroke(before, caret, inserted);
    if (!edit) return tr;
    const spec: TransactionSpec = {
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: edit.from + edit.insert.length },
      userEvent: "input.type",
    };
    return [spec];
  });

  const tabCommit = keymap.of([
    {
      key: "Tab",
      run(view: EditorView) {
        const caret = view.state.selection.main.head;
        const edit = commitAbbreviation(view.state.doc.toString(), caret);
        if (!edit) return false;
        view.dispatch({
          changes: { from: edit.from, to: edit.to, insert: edit.insert },
          selection: { anchor: edit.from + edit.insert.length },
        });
        return true;
      },
    },
  ]);

  return [inputFilter, tabCommit];
}
