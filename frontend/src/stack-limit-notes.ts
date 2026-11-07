// The stock page's half of HARDENING #92 (docs/EMBEDDING.md §7.10): Lean's engine-stack guard errors carry QED64's
// note wherever the visitor reads them. lib/stack-limit.ts recognises and annotates; this module only routes the
// relay's frames through it, and names the pill's label (main.ts counts, from the page API's `diagnostics` event).
import { annotateStackLimit } from "../../lib/stack-limit";
import type { LspMessage, RelayTaps } from "./relay-taps";

/** The pill at `ready` while `n` > 0 of Lean's current errors are the guard's (labels are internal, EMBEDDING §9). It
 * counts error diagnostics, not commands: one command can rarely carry two (an elaboration and a kernel error). */
export const stackLimitLabel = (n: number): string => `ready — ${n} ${n === 1 ? "place" : "places"} not checked (browser stack limit)`;

/** Append the note before anything else sees a relay → client frame:
 * - `textDocument/publishDiagnostics`: the editor's hover and markers, and the page API's `diagnostics` event;
 * - every reply whose `result` is an array: the InfoView reads its messages from `Lean.Widget.getInteractiveDiagnostics`
 *   (an array of diagnostics), not from the publish. The page's other array replies (code actions, completions,
 *   highlights, trace children) hold no error-severity diagnostic, so they pass as they are; object replies (goals) are
 *   not looked at.
 * An interceptor that returns false: interceptors run before every observer (relay-taps.ts), and the frame keeps its
 * identity (`fromPage`, the page API's liveness clock); only its one field is replaced, never the arrays in it. */
export function installStackLimitNotes(taps: RelayTaps): () => void {
  return taps.interceptOut((m: LspMessage) => {
    const p = m.params as { diagnostics?: unknown } | undefined;
    if (m.method === "textDocument/publishDiagnostics" && p && Array.isArray(p.diagnostics)) p.diagnostics = annotateStackLimit(p.diagnostics);
    else if (m.method === undefined && Array.isArray(m.result)) m.result = annotateStackLimit(m.result);
    return false;
  });
}
