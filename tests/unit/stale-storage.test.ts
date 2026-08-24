// Mid-session storage-rot recovery: classification of stale-storage compile
// failures, and the install-time cache probe that refuses unreadable packs.
//
// Live-observed failure this guards (Electron pane, after an OPFS quota
// event): the pack directory silently emptied while WORKERFS still held File
// objects over it; the first real olean read then threw FileReaderSync
// NotFoundError and the compile failed with no recovery path.

import { describe, expect, it } from "vitest";
import { isStaleStorageError } from "../../src/runtime/errors";
import { readCached, type PackMeta } from "../../src/install/profiles";

describe("isStaleStorageError", () => {
  it("matches the live-observed WORKERFS failure verbatim", () => {
    expect(
      isStaleStorageError(
        "Failed to execute 'readAsArrayBuffer' on 'FileReaderSync': " +
          "A requested file or directory could not be found at the time an operation was processed.",
      ),
    ).toBe(true);
  });

  it("matches DOMException names for dead file snapshots", () => {
    expect(isStaleStorageError("NotFoundError: file gone")).toBe(true);
    expect(isStaleStorageError("NotReadableError: the requested file could not be read")).toBe(true);
  });

  it("does not match unrelated compile-path failures", () => {
    expect(isStaleStorageError("worker terminated")).toBe(false);
    expect(isStaleStorageError("snapshot fetch: HTTP 404")).toBe(false);
    expect(isStaleStorageError("Lean process wrote a malformed IO result")).toBe(false);
    expect(isStaleStorageError("RangeError: Maximum call stack size exceeded")).toBe(false);
  });
});

// -- readCached probe --------------------------------------------------------

const META: PackMeta = { digest: "sha256:abc", byteLength: 8, release: "r1" };

interface FakeFileParts {
  size: number;
  text?: () => Promise<string>;
  sliceReadable?: boolean;
}

function fakeFile({ size, text, sliceReadable = true }: FakeFileParts): File {
  return {
    size,
    text: text ?? (() => Promise.resolve("")),
    slice: (_start: number, _end: number) => ({
      arrayBuffer: () =>
        sliceReadable
          ? Promise.resolve(new ArrayBuffer(1))
          : Promise.reject(
              new DOMException(
                "A requested file or directory could not be found at the time an operation was processed.",
                "NotFoundError",
              ),
            ),
    }),
  } as unknown as File;
}

function fakeDir(files: Record<string, File>): FileSystemDirectoryHandle {
  return {
    getFileHandle: (name: string) => {
      const file = files[name];
      if (!file) {
        return Promise.reject(new DOMException("not found", "NotFoundError"));
      }
      return Promise.resolve({ getFile: () => Promise.resolve(file) });
    },
  } as unknown as FileSystemDirectoryHandle;
}

describe("readCached", () => {
  const validMetaFile = () =>
    fakeFile({ size: 60, text: () => Promise.resolve(JSON.stringify(META)) });

  it("returns the pack when meta matches and both end-probes read", async () => {
    const dir = fakeDir({
      "p.pack.meta.json": validMetaFile(),
      "p.pack": fakeFile({ size: 8 }),
    });
    expect(await readCached(dir, "p.pack", META)).not.toBeNull();
  });

  it("misses when the pack entry exists but its data is unreadable", async () => {
    const dir = fakeDir({
      "p.pack.meta.json": validMetaFile(),
      "p.pack": fakeFile({ size: 8, sliceReadable: false }),
    });
    expect(await readCached(dir, "p.pack", META)).toBeNull();
  });

  it("misses when the pack file vanished", async () => {
    const dir = fakeDir({ "p.pack.meta.json": validMetaFile() });
    expect(await readCached(dir, "p.pack", META)).toBeNull();
  });

  it("misses on digest mismatch even when readable", async () => {
    const dir = fakeDir({
      "p.pack.meta.json": fakeFile({
        size: 60,
        text: () => Promise.resolve(JSON.stringify({ ...META, digest: "sha256:other" })),
      }),
      "p.pack": fakeFile({ size: 8 }),
    });
    expect(await readCached(dir, "p.pack", META)).toBeNull();
  });
});
