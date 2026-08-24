// A pragmatic Lean 4 tokenizer for CodeMirror's StreamLanguage.
//
// This is a highlighter, not a parser: Lean's real grammar is extensible and
// only the elaborator knows it. The token classes below cover the syntax that
// appears in practice (commands, tactics, attributes, literals, comments,
// unicode operators) and degrade gracefully on everything else.

import { StreamLanguage, type StringStream } from "@codemirror/language";

const COMMANDS = new Set([
  "import", "open", "namespace", "end", "section", "universe", "variable",
  "variables", "noncomputable", "mutual", "where", "deriving", "class",
  "instance", "structure", "inductive", "coinductive", "abbrev", "def",
  "theorem", "lemma", "example", "axiom", "constant", "opaque", "macro",
  "macro_rules", "syntax", "notation", "infix", "infixl", "infixr", "prefix",
  "postfix", "attribute", "export", "set_option", "public", "private",
  "protected", "scoped", "local", "partial", "unsafe", "meta", "module",
  "extends", "declare_syntax_cat", "elab", "elab_rules", "run_cmd", "builtin_initialize", "initialize",
]);

const HASH_COMMANDS = new Set([
  "#check", "#eval", "#print", "#reduce", "#exit", "#guard", "#guard_msgs",
  "#lint", "#help", "#version", "#synth", "#instances", "#whnf", "#simp",
]);

const KEYWORDS = new Set([
  "fun", "match", "with", "do", "if", "then", "else", "let", "have", "show",
  "from", "by", "calc", "at", "this", "return", "try", "catch", "finally",
  "for", "in", "while", "break", "continue", "unless", "mut", "rec",
  "termination_by", "decreasing_by", "deriving", "extends", "sorry", "admit",
]);

const TACTICS = new Set([
  "intro", "intros", "apply", "exact", "refine", "rfl", "rw", "rewrite",
  "simp", "simp_all", "dsimp", "norm_num", "ring", "ring_nf", "linarith",
  "nlinarith", "omega", "decide", "native_decide", "constructor", "cases",
  "rcases", "obtain", "induction", "generalize", "specialize", "use",
  "exists", "left", "right", "split", "split_ifs", "ext", "funext",
  "contradiction", "exfalso", "absurd", "push_neg", "by_contra", "by_cases",
  "unfold", "delta", "change", "convert", "congr", "gcongr", "positivity",
  "polyrith", "field_simp", "abel", "group", "aesop", "tauto", "trivial",
  "assumption", "exact_mod_cast", "norm_cast", "push_cast", "lift", "subst",
  "symm", "trans", "clear", "rename_i", "next", "all_goals", "any_goals",
  "focus", "repeat", "first", "skip", "done", "grind", "fun_prop", "bound",
]);

const SORTS = new Set(["Prop", "Type", "Sort"]);

interface LeanState {
  commentDepth: number;
}

function tokenBase(stream: StringStream, state: LeanState): string | null {
  if (stream.match("/-")) {
    state.commentDepth = 1;
    return tokenComment(stream, state);
  }
  if (stream.match("--")) {
    stream.skipToEnd();
    return "lineComment";
  }
  if (stream.match('"')) {
    let escaped = false;
    while (!stream.eol()) {
      const ch = stream.next();
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') return "string";
    }
    return "string";
  }
  if (stream.match(/^'(?:[^'\\]|\\.)'/)) return "string";
  if (stream.match(/^0[xX][0-9a-fA-F]+/) || stream.match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) {
    return "number";
  }
  if (stream.match(/^@\[[^\]]*\]/)) return "meta";
  if (stream.match(/^#[A-Za-z_]\w*/)) {
    const word = stream.current();
    return HASH_COMMANDS.has(word) ? "keyword" : "meta";
  }
  // Identifiers, including French-quoted «weird names» and namespaced paths.
  if (stream.match(/^«[^»]*»/)) return "variableName";
  const identifier = stream.match(/^[A-Za-z_α-ωΑ-ΩÀ-ɏ][\w!?'₀-₉α-ωΑ-ΩÀ-ɏ]*/);
  if (identifier) {
    const word = stream.current();
    if (COMMANDS.has(word)) return "definitionKeyword";
    if (KEYWORDS.has(word)) return "keyword";
    if (TACTICS.has(word)) return "controlKeyword";
    if (SORTS.has(word)) return "typeName";
    if (/^[A-Z]/.test(word)) return "typeName";
    return "variableName";
  }
  if (stream.match(/^[∀∃λ←→↔∧∨¬⊢⊨∈∉⊆⊂∪∩≤≥≠≈∘⁻¹∣∑∏∫√±×÷·⟨⟩⟦⟧⦃⦄‹›]+/)) return "operator";
  if (stream.match(/^:=|=>|->|<-|[:=+\-*/<>|&%^~]+/)) return "operator";
  stream.next();
  return null;
}

function tokenComment(stream: StringStream, state: LeanState): string {
  while (!stream.eol()) {
    if (stream.match("/-")) {
      state.commentDepth += 1;
    } else if (stream.match("-/")) {
      state.commentDepth -= 1;
      if (state.commentDepth === 0) return "blockComment";
    } else {
      stream.next();
    }
  }
  return "blockComment";
}

export const leanLanguage = StreamLanguage.define<LeanState>({
  name: "lean4",
  startState: () => ({ commentDepth: 0 }),
  token(stream, state) {
    if (state.commentDepth > 0) return tokenComment(stream, state);
    if (stream.eatSpace()) return null;
    return tokenBase(stream, state);
  },
  languageData: {
    commentTokens: { line: "--", block: { open: "/-", close: "-/" } },
    closeBrackets: { brackets: ["(", "[", "{", '"', "⟨", "⦃", "«"] },
  },
});
