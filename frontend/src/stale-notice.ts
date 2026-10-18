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

/** The boot card's words for a stale cause (HARDENING #74): a lazily imported chunk of the page's own bundle
 * failed, which a deploy under the open page explains, and a connection cut during that import would read the
 * same; the module map keeps the failure for the document, so a reload is the fix either way. */
export const STALE_BOOT_NOTICE = "this page's own files could not be loaded, probably because QED64 was updated while it was open — reload to continue";

/** The boot card's words for a browser without what QED64 needs (the worker's CAPABILITY_MISSING: a working
 * shared Memory64, SharedArrayBuffer, Atomics): Safari, and every iOS browser (all WebKit). The stock page is always
 * cross-origin isolated, so a desktop Chrome or Firefox is the fix; a share link carries its code to it (HARDENING #77). */
export const CAPABILITY_BOOT_NOTICE = "this browser cannot run QED64 (it needs WebAssembly Memory64) — open this page, or the link you were sent, in desktop Chrome or Firefox";

/** What the boot card says for a failed boot: the stale and capability causes get words that say what to do,
 * every other failure its own message (the stock page keeps that message as the label's title either way). */
export function bootFailLabel(message: string, cause?: { kind?: string; code?: string } | null): string {
  if (cause?.kind === "stale") return STALE_BOOT_NOTICE;
  if (cause?.code === "CAPABILITY_MISSING" || /^Missing capability:/.test(message)) return CAPABILITY_BOOT_NOTICE;
  return message;
}

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
