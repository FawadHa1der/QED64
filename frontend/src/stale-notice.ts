// The stale-page prompt (docs/EMBEDDING.md §7.2, kind `stale`), and the boot card's and pill's words for a stale page,
// a browser without Memory64 and a cut download. The stale page: the site was
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
import { WORKER_SCRIPT_LOAD_FAILED } from "../../lib/failure";

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

/** A failure the network explains (UX FILL-A7, HARDENING #88): a transfer that was cut or refused (`network`: the
 * snapshot and runtime downloads classify their cuts so, HARDENING #63), or a worker script that did not load
 * (WORKER_SCRIPT_LOAD_FAILED: offline it reads the same as a deploy that dropped the file, docs/EMBEDDING.md §7.2). A
 * connection cut during a first visit also refuses every replacement worker's script, so the death the breaker halts
 * on can be either. */
export const isNetworkCause = (cause?: { kind?: string; code?: string } | null): boolean =>
  cause?.kind === "network" || cause?.code === WORKER_SCRIPT_LOAD_FAILED;

/** The boot card's words for it. A reload resumes from what the browser already cached (measured 12.9 s after a cut
 * at 43 %); nothing retries by itself. */
export const NETWORK_BOOT_NOTICE = "the download was interrupted — check your connection, then Reload (what already downloaded is kept)";

/** The pill's words for a page that was up and halted on it (a reboot or widen that could not download). */
export const NETWORK_HALT_LABEL = "the connection dropped while Lean was loading — edit the file to retry";

/** What the boot card says for a failed boot: the stale, capability and network causes get words that say what to
 * do, every other failure its own message (the stock page keeps that message as the label's title either way). The
 * order matters: a lost bundle chunk is `stale` (its words also read as a network failure), and stays stale. */
export function bootFailLabel(message: string, cause?: { kind?: string; code?: string } | null): string {
  if (cause?.kind === "stale") return STALE_BOOT_NOTICE;
  if (cause?.code === "CAPABILITY_MISSING" || /^Missing capability:/.test(message)) return CAPABILITY_BOOT_NOTICE;
  if (isNetworkCause(cause)) return NETWORK_BOOT_NOTICE;
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
