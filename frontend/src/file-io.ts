// The plain page's own file and link actions in the bar's `#pageactions` (frontend/index.html): Open…, Download and
// Copy link. main.ts installs them only outside `?embed=1` (docs/EMBEDDING.md §3); in embed mode they stay hidden and
// uninstalled. The link itself is `shareLink` in page-api.ts, beside its reader `codeFromHash`, and is unit-tested
// there; this is the DOM half. The file decisions (`fileKey`, `readLeanFile`) are unit-tested in
// tests/unit/file-io.test.ts, their wiring in tests/adversarial/page-ux.mjs `file-actions`.
//
// A button says what happened on its own label for 2 s ("Copied", "not a text file"): the pill is render(status), and
// the relay's next status (a liveness probe, an edit) replaces any note there within moments.
import { shareLink } from "./page-api";

/** `say(label)` shows `label` on the button for 2 s, then its own label again; a newer label restarts the 2 s. */
function sayOn(button: HTMLButtonElement): (label: string) => void {
  const own = button.textContent ?? "";
  let reset: number | undefined;
  return (label) => {
    window.clearTimeout(reset);
    button.textContent = label;
    reset = window.setTimeout(() => { button.textContent = own; }, 2000);
  };
}

/** "Copy link": on a click, a `#codez=` link to `text()` goes to the clipboard. It never goes into this page's own
 * URL: a reload would then put the visitor's own buffer behind the share gate (HARDENING #77). The button's label says
 * what happened for 2 s. A refused or missing clipboard gets `window.prompt` with the link selected instead. */
export function installShareButton(button: HTMLButtonElement, text: () => string): void {
  const say = sayOn(button);
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

// ---- Download and Open… (UX F1.5, F1.3; docs/HARDENING.md #89) ----------------------------------------------------
// Ctrl/Cmd+S and Ctrl/Cmd+O reached the browser (Save Page As saved the HTML, Open File left the page), and there was
// no way to keep work as a file. Download writes the editor's text to a .lean file; Open… reads one into the editor
// through the page API's setDocument, one undoable edit (Ctrl/Cmd+Z brings the earlier text back), the example menu's
// path (HARDENING #86). A local file is the visitor's own act, like typing: no consent panel (#77 is for links), and
// the autosave keeps it. The keys are taken in the capture phase on window, before Monaco; a key pressed while the
// InfoView iframe has the focus belongs to the iframe's document and still reaches the browser. No drop target: Open…
// and the key cover it (a drop handler would fight Monaco's drop-into-editor and miss the InfoView).

/** The largest file Open… accepts: the share link's cap (page-api.ts), 2 MiB. */
export const MAX_OPEN_BYTES = 2 * 1048576;
/** Download's file name until a file is opened (then the opened file's). */
const DEFAULT_FILE_NAME = "QED64.lean";

export interface FileKeyEvent { key?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean }

/** The file action a key press is: Cmd+S (on a Mac; elsewhere Ctrl+S) "save", Cmd+O (Ctrl+O) "open", anything else
 * null. Only the platform's own modifier, the one the browser's Save and Open use: on a Mac, Ctrl+O is Monaco's
 * insert-line-break. */
export function fileKey(e: FileKeyEvent, mac: boolean): "save" | "open" | null {
  if (!(mac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing) return null;
  const k = (e.key ?? "").toLowerCase(); // Chrome's autofill sends keydown events without a key
  return k === "s" ? "save" : k === "o" ? "open" : null;
}

/** A file's text, or why Open… refuses it (the button's words): over MAX_OPEN_BYTES (not read), unreadable, or
 * binary (a NUL character). */
export async function readLeanFile(file: { size: number; text(): Promise<string> }): Promise<{ text: string } | { refused: string }> {
  if (file.size > MAX_OPEN_BYTES) return { refused: "over 2 MB" };
  let text: string;
  try { text = await file.text(); } catch { return { refused: "could not be read" }; }
  if (text.includes("\u0000")) return { refused: "not a text file" };
  return { text };
}

export interface FileActionsHost {
  /** The editor's text, or null before the editor exists. */
  getText(): string | null;
  /** Replace the document as one undoable edit (the page API's setDocument). */
  setText(text: string): Promise<unknown>;
  /** The same words for the screen reader (the pill's announcer). */
  announce(message: string): void;
}

/** Wires Open… and Download: the buttons, the two keys, and a hidden file input (`#fileinput`, made here so an
 * embedded page has none). */
export function installFileActions(host: FileActionsHost, buttons: { open: HTMLButtonElement; save: HTMLButtonElement }): void {
  const sayOpen = sayOn(buttons.open);
  const saySave = sayOn(buttons.save);
  let name = DEFAULT_FILE_NAME;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".lean,text/plain";
  input.id = "fileinput";
  input.hidden = true;
  document.body.append(input);
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = ""; // picking the same file again is a change again
    if (!file) return;
    void readLeanFile(file).then((read) => {
      if ("refused" in read) {
        sayOpen(read.refused);
        host.announce(`${file.name} not opened: ${read.refused}`);
        return;
      }
      name = file.name;
      return host.setText(read.text);
    }).catch((e: unknown) => console.warn("[qed64] file not opened:", e));
  });
  const open = (): void => input.click();
  const download = (): void => {
    const text = host.getText();
    if (text === null) {
      saySave("not yet");
      host.announce("nothing to download yet — the editor is still starting");
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000); // Firefox may still be reading it right after click()
  };
  buttons.open.addEventListener("click", open);
  buttons.save.addEventListener("click", download);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  window.addEventListener("keydown", (e) => {
    const action = fileKey(e, mac);
    if (!action) return;
    e.preventDefault(); // not the browser's Save Page As / Open File
    e.stopPropagation(); // nor Monaco's keybindings
    if (e.repeat) return; // a held key: one download, one chooser
    if (action === "save") download(); else open();
  }, true);
}
