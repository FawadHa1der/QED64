// The plain page's own file and link actions in the bar's `#pageactions` (frontend/index.html). main.ts installs them
// only outside `?embed=1` (docs/EMBEDDING.md §3); in embed mode they stay hidden and uninstalled. The link itself is
// `shareLink` in page-api.ts, beside its reader `codeFromHash`, and is unit-tested there; this is the DOM half.
import { shareLink } from "./page-api";

const SHARE_LABEL = "Copy link";

/** "Copy link": on a click, a `#codez=` link to `text()` goes to the clipboard. It never goes into this page's own
 * URL: a reload would then put the visitor's own buffer behind the share gate (HARDENING #77). The button's label says
 * what happened for 2 s. A refused or missing clipboard gets `window.prompt` with the link selected instead. */
export function installShareButton(button: HTMLButtonElement, text: () => string): void {
  let reset: number | undefined;
  const say = (label: string) => {
    window.clearTimeout(reset);
    button.textContent = label;
    reset = window.setTimeout(() => { button.textContent = SHARE_LABEL; }, 2000);
  };
  button.addEventListener("click", () => {
    const t = text();
    const link = shareLink(t, `${location.origin}${location.pathname}`);
    if (link === null) { say(t === "" ? "nothing to share" : "too long for a link"); return; }
    // Inside a promise, so a missing clipboard API (no secure context) is a refusal too.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(link))
      .then(() => say("Copied"), () => { window.prompt("Copy this link", link); });
  });
}
