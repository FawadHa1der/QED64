// Lean's engine-stack guard errors (kernel patch 0036; docs/EMBEDDING.md §7.10, docs/HARDENING.md #92). Pure: no
// DOM, no timer, no state.
//
// When a browser's engine stack runs low, the fork's Lean reports an error of its own instead of dying: an ordinary
// error diagnostic on the command it was checking, which was therefore NOT checked. These helpers recognise that error,
// also nested inside another one ("failed to synthesize …", "Tactic `simp` failed with a nested error: …"), and put
// QED64's explanation after Lean's words. Lean's limits that desktop Lean has too (maxRecDepth, maxHeartbeats,
// "(kernel) deep recursion detected") are other errors, and are left alone.

/** Patch 0036's two phrases, the only Lean words that mean "the browser's stack ran out": Core.checkSystem (the fork's
 * src/Lean/CoreM.lean:524-529) and the kernel's scope_rec_depth (src/runtime/interrupt.cpp:97-101). Upstream Lean has
 * neither. Lean's plain maxRecDepth error starts with the same six words as the first, so no shorter rule will do.
 * Exported for the tests, not through the barrel: tests/integration/stack-guard-phrases.test.ts finds both in the
 * runtime's lean.wasm, so a kernel release that rewords them fails at its adoption, not silently in the browser. */
export const GUARD_PHRASES = ["the WebAssembly runtime's stack is exhausted", "the WebAssembly engine's stack is exhausted"] as const;

/** QED64's explanation, appended after Lean's words: the one wording source (the stock page's editor and InfoView, its
 * pill tooltip, and an embedder that calls `annotateStackLimit`). It does not repeat why a browser has less stack:
 * Lean's own words before it say so. */
export const STACK_LIMIT_NOTE = "QED64: this was not checked. Lean ran out of the browser's stack here. That is a limit of running Lean in a browser, not a mistake found in your proof, but the proof is not verified. What helps: check a long file in smaller parts, break a long proof into helper lemmas, split a deep `decide` or computation into smaller cases, or check it with desktop Lean or live.lean-lang.org.";

/** The fields these helpers read of an LSP `Diagnostic` (`message` a string), or of Lean's `InteractiveDiagnostic` as a
 * `Lean.Widget.getInteractiveDiagnostics` reply carries it (`message` a TaggedText, as JSON). */
export interface StackLimitDiagnostic { severity?: number; message?: unknown; isSilent?: boolean }

/** A message's text to search: a string is itself; anything else (a TaggedText) is its JSON. Lean puts an interactive
 * message's words inside `expr` embeds, so the JSON reads them wherever they sit; the phrases and the note hold no
 * character JSON escapes, so they read the same in both forms. */
function textOf(message: unknown): string {
  if (typeof message === "string") return message;
  try { return JSON.stringify(message) ?? ""; } catch { return ""; }
}

/** Is this an error (severity 1, not `isSilent`) whose message, or a message nesting it, is the guard's? Then the
 * command it sits on was not checked. Warnings and infos that quote the words are not. An error that merely quotes a
 * phrase (a string literal in a type mismatch, `#guard_msgs`' expected text) is taken for the guard's too: the words
 * alone cannot tell a quote from the guard (HARDENING #92). */
export function isStackLimitDiagnostic(d: StackLimitDiagnostic): boolean {
  if (d?.severity !== 1 || d.isSilent === true) return false;
  const text = textOf(d.message);
  return GUARD_PHRASES.some((p) => text.includes(p));
}

const SUFFIX = `\n\n${STACK_LIMIT_NOTE}`;
/** A string gains "\n\n" + the note; a TaggedText gains a `{text}` node at the end of its `append` (or a new `append`
 * around it: Lean's TaggedText nests no `append` directly in another). */
function withNote(message: unknown): unknown {
  if (typeof message === "string") return message + SUFFIX;
  const node = { text: SUFFIX };
  const append = (message as { append?: unknown }).append;
  return Array.isArray(append) ? { ...(message as object), append: [...append, node] } : { append: [message, node] };
}

/** `diagnostics` with the note after Lean's words on each guard error that does not carry it yet (severity, range and
 * every other field kept: the verdict stays "error"). Returns `diagnostics` itself when none needs it, so a second call
 * changes nothing; otherwise a new array. Never mutates. */
export function annotateStackLimit<D extends StackLimitDiagnostic>(diagnostics: D[]): D[] {
  let out: D[] | null = null;
  diagnostics.forEach((d, i) => {
    if (!isStackLimitDiagnostic(d) || textOf(d.message).includes(STACK_LIMIT_NOTE)) return;
    (out ??= diagnostics.slice())[i] = { ...d, message: withNote(d.message) };
  });
  return out ?? diagnostics;
}
