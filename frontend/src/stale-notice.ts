// The stale-page prompt (docs/EMBEDDING.md §7.2, kind `stale`): the site was
// deployed under this page, so its worker scripts no longer match each other
// (WORKER_DEP_MISMATCH). The relay heals by itself — its replacement worker
// loads the new scripts, and the relay replays `initialize` and the document,
// so the language client needs no re-initialize — but it then serves under
// this page's OLDER bundle, which holds only while the worker protocol changes
// additively. A reload loads the new version, so the page offers one. Kept out
// of lsp-relay.ts (its line budget) and of main.ts (unit-tested here): the
// watch reads the relay's status, the page renders the prompt.
//
// Pure: unit-tested under node.
import type { RelayStatus } from "../../lib/lsp-relay";

/** What the stock page says beside its Reload button. */
export const STALE_NOTICE = "QED64 was updated while this page was open — reload to use the new version";

/** Is this death a stale page's (its cause kind, from failure.ts)? */
export const isStaleDeath = (d: RelayStatus["lastDeath"] | null | undefined): boolean => d?.cause?.kind === "stale";

/** A status observer that calls `show` once, on the first status whose last
 * death is a stale page's. Sticky: `lastDeath` is cleared when the healed
 * session reports ready, but the page's bundle stays old until it reloads. */
export function createStaleWatch(show: (death: NonNullable<RelayStatus["lastDeath"]>) => void): (s: Pick<RelayStatus, "lastDeath">) => boolean {
  let shown = false;
  return (s) => {
    if (shown || !s.lastDeath || !isStaleDeath(s.lastDeath)) return false;
    shown = true;
    show(s.lastDeath);
    return true;
  };
}
