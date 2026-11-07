// The editor/InfoView splitter (UX L1.2; docs/HARDENING.md #87's 2026-11-07 paragraph): a 5 px handle (#splitter,
// index.html) between #editor and #infoview. Drag it to give either pane more room; a reload restores the stock 55/45.
//   * It sets one CSS variable, `--split` on #split, which index.html's #editor rule reads. Never an inline `flex`: a
//     later stylesheet rule on #editor (the page's narrow-width stack, the CSS the widgets showcase injects into its
//     frame) must still win.
//   * The handle captures the pointer, and while #split has the `dragging` class index.html takes pointer events off
//     the InfoView iframe, so a fast drag that lands over the frame never reaches the frame's document (Firefox).
//   * Monaco follows by itself (lean4monaco creates the editor with automaticLayout); the iframe fills its pane.
// The plain page's only: main.ts installs it outside ?embed=1, where the embedder owns the layout.

const MIN = 15; // the editor's share of the row, in percent, at least
const MAX = 85; // and at most: neither pane can vanish
const STOCK = 55; // index.html's fallback for an unset --split (change both together)

/** The editor's share of the row (percent, to a tenth) for a pointer at `x` over a row from `left`, `width` wide. */
export function splitPercent(x: number, left: number, width: number): number {
  const pct = width > 0 ? ((x - left) / width) * 100 : STOCK;
  return Math.round(Math.min(MAX, Math.max(MIN, pct)) * 10) / 10;
}

/** Wire the handle: a drag with the primary button sets the editor's share of `split`. */
export function installSplitter(split: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    split.classList.add("dragging");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!split.classList.contains("dragging")) return;
    const r = split.getBoundingClientRect();
    split.style.setProperty("--split", `${splitPercent(e.clientX, r.left, r.width)}%`);
  });
  // pointerup ends a drag; lostpointercapture also ends one the browser cancels. Either may come second.
  const end = () => split.classList.remove("dragging");
  handle.addEventListener("pointerup", end);
  handle.addEventListener("lostpointercapture", end);
}
