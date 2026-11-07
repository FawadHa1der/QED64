// The plain page's Download and Open… decisions (frontend/src/file-io.ts; docs/HARDENING.md #89): which keys they
// take, and which files Open… refuses, in the words its button shows. Their wiring (the capture listener, the file
// input, the download, the button's words) is checked in a browser by tests/adversarial/page-ux.mjs `file-actions`.
import { describe, expect, it, vi } from "vitest";
import { MAX_OPEN_BYTES, fileKey, readLeanFile } from "../../frontend/src/file-io";

const key = (k: string | undefined, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; isComposing: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });

describe("fileKey", () => {
  it("Cmd+S saves and Cmd+O opens on a Mac, Ctrl+S and Ctrl+O elsewhere (either case of the letter)", () => {
    expect(fileKey(key("s", { metaKey: true }), true)).toBe("save");
    expect(fileKey(key("S", { metaKey: true }), true)).toBe("save"); // Caps Lock
    expect(fileKey(key("o", { metaKey: true }), true)).toBe("open");
    expect(fileKey(key("s", { ctrlKey: true }), false)).toBe("save");
    expect(fileKey(key("O", { ctrlKey: true }), false)).toBe("open");
  });
  it("leaves the other platform's modifier alone: on a Mac, Ctrl+O is Monaco's insert-line-break", () => {
    expect(fileKey(key("o", { ctrlKey: true }), true)).toBeNull();
    expect(fileKey(key("s", { ctrlKey: true }), true)).toBeNull();
    expect(fileKey(key("s", { metaKey: true }), false)).toBeNull(); // the Windows key
  });
  it("leaves every other key to the editor and the browser", () => {
    for (const mac of [true, false]) {
      const mod = mac ? { metaKey: true } : { ctrlKey: true };
      for (const e of [
        key("s"), key("o"), key("s", { shiftKey: true }),
        key("s", { ...mod, shiftKey: true }), key("o", { ...mod, shiftKey: true }), // Save As, the browser's own
        key("s", { ...mod, altKey: true }), key("z", mod), key("p", mod),
        key("s", { ...mod, isComposing: true }), // an IME composition
        key(undefined, mod), // Chrome's autofill sends keydown events without a key
      ]) {
        expect(fileKey(e, mac), JSON.stringify({ mac, e })).toBeNull();
      }
    }
  });
});

describe("readLeanFile", () => {
  it("returns a text file's text", async () => {
    expect(await readLeanFile(new File(["theorem t : True := trivial\n"], "a.lean"))).toEqual({ text: "theorem t : True := trivial\n" });
    expect(await readLeanFile(new File([""], "empty.lean"))).toEqual({ text: "" });
  });
  it("accepts exactly MAX_OPEN_BYTES (2 MiB, the share link's cap) and refuses one byte more without reading it", async () => {
    expect(MAX_OPEN_BYTES).toBe(2 * 1048576);
    expect(await readLeanFile(new File([new Uint8Array(MAX_OPEN_BYTES).fill(0x61)], "max.lean"))).toHaveProperty("text");
    const text = vi.fn();
    expect(await readLeanFile({ size: MAX_OPEN_BYTES + 1, text })).toEqual({ refused: "over 2 MB" });
    expect(text).not.toHaveBeenCalled();
  });
  it("refuses a binary file (a NUL character) and a file that cannot be read", async () => {
    expect(await readLeanFile(new File([new Uint8Array([0x74, 0, 0x65])], "bin.lean"))).toEqual({ refused: "not a text file" });
    expect(await readLeanFile({ size: 3, text: () => Promise.reject(new Error("NotFoundError")) })).toEqual({ refused: "could not be read" });
  });
});
