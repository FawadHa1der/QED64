// GAP 3, the other half of the light boot (docs/EMBEDDING.md §8): the kernel
// refuses a header a session cannot cover (K1: nothing loaded contains the
// modules) and reports which modules are missing. When one entry of the
// snapshot index not yet loaded covers them by its roots (the umbrella for
// Mathlib, an overlay for its own roots — snapshots.ts `widenTarget`), the
// fix is that entry: restart ONCE with it (a user restart, never a death; the
// relay remembers these options across a crash reboot while the header stays
// the same). A refusal no entry covers is final, and so is one for modules a
// loaded entry already claims: no snapshot would change the verdict.
//
// The decision is a function of the index, the session's loads and the
// header — never of what this page widened before. A per-header memory of
// past widens outlived the session that earned it: once a reboot had dropped
// the umbrella (the header changed, then a crash), the same Mathlib header
// was never widened again.
import type { LspRelay, RelayStatus } from "./lsp-relay";
import { importedModulesOf, type ResidentSession } from "./resident-session";
import { BASE_SNAPSHOTS, LEGACY_UMBRELLA_ROOTS, coversModule, widenTarget, type SnapshotEntry, type SnapshotIndex } from "../../src/runtime/snapshots";

/** The relay status sink that widens. `relay` is read per status (the page
 * assigns it after building this closure); `onWiden` runs before the restart,
 * so the replacement's first status already reads its label. Without an index
 * the legacy rule: a session without the umbrella, every missing module under
 * an umbrella root. */
export function selfWiden(relay: () => LspRelay, index: SnapshotIndex | null, onWiden: (target: Pick<SnapshotEntry, "name" | "label">) => void): (s: RelayStatus) => void {
  let widened: string | null = null; // one widen per session, whatever its statuses repeat
  return (s) => {
    const r = relay();
    if (s.phase !== "headerRefused" || !s.header || s.header.mode !== "refused" || r.state.kind !== "serving") return;
    const session = r.session as ResidentSession;
    if (session.id !== s.session || widened === s.session) return;
    const missing = s.header.missing;
    const target = index
      ? widenTarget(index, missing, session.snapshots, importedModulesOf(r.lastText))
      : !session.snapshots.includes("mathlib") && missing.length > 0 && missing.every((m) => coversModule(LEGACY_UMBRELLA_ROOTS, m)) ? { name: "mathlib" } : null;
    if (!target) return;
    widened = s.session;
    onWiden(target);
    r.restart({ snapshots: [...BASE_SNAPSHOTS, target.name] });
  };
}
