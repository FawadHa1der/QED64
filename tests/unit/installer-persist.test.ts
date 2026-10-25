// HARDENING #75: installProfile asks for durable storage (navigator.storage.persist) before a multi-hundred-MB OPFS
// write, and must not WAIT for the answer: in Playwright Firefox 153 the page's persist() never settled (45 s), so an
// awaited call held every Firefox boot at "installing the Lean core library" (Firefox prompts for persistent storage;
// that the promise waits on the prompt is inferred from headless runs). The install here runs against
// a fake OPFS with a persist() that never settles, and must still download, inflate, commit and return.
// HARDENING #81, on the same fakes: a manifest of another release than the index entry names is refused
// before any part is fetched or the cache is touched.
import { afterEach, describe, expect, test, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { installProfile, type ProfileIndexEntry, type ProfileManifest } from "../../lib/profiles";
import { failureCauseOf, WORKER_DEP_MISMATCH } from "../../lib/failure";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function makeManifest(raw: Uint8Array, partSize = 64): { manifest: ProfileManifest; parts: Uint8Array[] } {
  const gz = gzipSync(raw);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < gz.length; i += partSize) parts.push(new Uint8Array(gz.subarray(i, i + partSize)));
  const manifest = {
    format: "browser64.artifact-manifest",
    version: 1,
    digest: "sha256:x",
    content: {
      release: "test",
      lean: { version: "t", target: "t", gitRevision: "t" },
      pack: {
        url: "pack",
        digest: `sha256:${sha256(raw)}`,
        byteLength: raw.length,
        transport: {
          encoding: "gzip",
          digest: `sha256:${sha256(gz)}`,
          byteLength: gz.length,
          parts: parts.map((p, i) => ({ url: `/part-${i}`, digest: `sha256:${sha256(p)}`, byteLength: p.length })),
        },
      },
      modules: { M: { imports: [] } },
      roots: ["M"],
      workerfs: { mountPoint: "/lib", metadata: { files: [{ filename: "/m", start: 0, end: raw.length }] } },
    },
  } as unknown as ProfileManifest;
  return { manifest, parts };
}

/** A minimal OPFS: one directory of named byte arrays, the handle methods installProfile uses. */
function fakeOpfs() {
  const notFound = (name: string) => Object.assign(new Error(`Entry not found: ${name}`), { name: "NotFoundError" });
  class Dir {
    files = new Map<string, Uint8Array<ArrayBuffer>>();
    dirs = new Map<string, Dir>();
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      if (!this.dirs.has(name)) { if (!opts?.create) throw notFound(name); this.dirs.set(name, new Dir()); }
      return this.dirs.get(name)!;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!this.files.has(name)) { if (!opts?.create) throw notFound(name); this.files.set(name, new Uint8Array(0)); }
      return new FileHandle(this, name);
    }
    async removeEntry(name: string) { if (!this.files.delete(name)) throw notFound(name); }
    async *keys() { yield* [...this.files.keys()]; }
  }
  class FileHandle {
    constructor(private dir: Dir, public name: string) {}
    async getFile() { return new File([this.dir.files.get(this.name)!], this.name); }
    async createWritable() {
      const pieces: Uint8Array<ArrayBuffer>[] = [];
      return {
        write: async (chunk: Uint8Array<ArrayBuffer> | string) => { pieces.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk); },
        close: async () => { const n = pieces.reduce((s, p) => s + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of pieces) { out.set(p, o); o += p.length; } this.dir.files.set(this.name, out); },
        abort: async () => {},
      };
    }
    async move(name: string) { const bytes = this.dir.files.get(this.name)!; this.dir.files.delete(this.name); this.dir.files.set(name, bytes); this.name = name; }
  }
  return new Dir();
}

afterEach(() => vi.unstubAllGlobals());

describe("installProfile and navigator.storage.persist (HARDENING #75)", () => {
  test("a persist() that never settles does not hold the install: the pack is downloaded, inflated and committed", async () => {
    const raw = new Uint8Array(4096).map((_, i) => i % 251);
    const { manifest, parts } = makeManifest(raw);
    const root = fakeOpfs();
    const persist = vi.fn(() => new Promise<boolean>(() => { /* Firefox: waiting for the doorhanger */ }));
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root, persist } });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      if (url === "/core.manifest.json") return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });
      const i = Number(/part-(\d+)/.exec(url)![1]);
      return new Response(parts[i]!.slice() as unknown as BodyInit, { status: 200 });
    });
    const entry: ProfileIndexEntry = { id: "core", manifest: "/core.manifest.json", release: "test", modules: 1 };

    const installed = await installProfile(entry);

    expect(persist).toHaveBeenCalledTimes(1); // the ask still happens
    expect(fetched.filter((u) => u.startsWith("/part-"))).toHaveLength(parts.length);
    expect(installed).toMatchObject({ id: "core", release: "test", fromCache: false, persistent: true, totalBytes: raw.length });
    const committed = installed.segments[0]!.blob;
    expect(committed).toBeDefined();
    expect(new Uint8Array(await committed!.arrayBuffer())).toEqual(raw);
    // The committed pack and its meta marker are in the store; the staging name is gone.
    const store = await root.getDirectoryHandle("qed64-packs");
    const names: string[] = []; for await (const n of store.keys()) names.push(n);
    expect(names.some((n) => n.endsWith(".pack"))).toBe(true);
    expect(names.some((n) => n.endsWith(".pack.meta.json"))).toBe(true);
    expect(names.some((n) => n.endsWith(".staging"))).toBe(false);
  }, 15_000);
});

describe("installProfile and the index entry's release (HARDENING #81)", () => {
  /** A site whose /core.manifest.json is the manifest of `served`, recording every fetch. */
  function site(served: string, opfs: boolean) {
    const raw = new Uint8Array(2048).map((_, i) => i % 239);
    const { manifest, parts } = makeManifest(raw);
    (manifest.content as { release: string }).release = served;
    const root = fakeOpfs();
    vi.stubGlobal("navigator", { storage: opfs ? { getDirectory: async () => root, persist: async () => true } : {} });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      if (url === "/core.manifest.json") return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });
      const i = Number(/part-(\d+)/.exec(url)![1]);
      return new Response(parts[i]!.slice() as unknown as BodyInit, { status: 200 });
    });
    return { raw, root, fetched };
  }
  const entry = (release: string): ProfileIndexEntry => ({ id: "core", manifest: "/core.manifest.json", release, modules: 1 });

  test.each([["OPFS", true], ["memory", false]] as const)("%s: a manifest of the next release is refused as stale before a part is fetched or the store touched", async (_mode, opfs) => {
    const { root, fetched } = site("lean-core-4.35.0-wasm64-new", opfs);
    const err = await installProfile(entry("lean-core-4.34.0-wasm64-old")).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe(WORKER_DEP_MISMATCH);
    expect((err as Error).message).toBe("library pack core: the site serves release lean-core-4.35.0-wasm64-new, this page pairs with lean-core-4.34.0-wasm64-old (a deploy mixed versions) — reload the page");
    expect(failureCauseOf(err, { stage: "profile", subject: "core" })).toMatchObject({ kind: "stale", code: WORKER_DEP_MISMATCH, stage: "profile", subject: "core" });
    expect(fetched).toEqual(["/core.manifest.json"]);
    expect(root.dirs.size).toBe(0); // the pack store was never opened, so nothing was read, staged or collected
  });

  test("the release the entry names installs; an entry that names no release is not checked", async () => {
    for (const named of ["lean-core-4.35.0-wasm64-new", ""]) {
      const { raw, fetched } = site("lean-core-4.35.0-wasm64-new", true);
      const installed = await installProfile(entry(named));
      expect(installed).toMatchObject({ id: "core", release: "lean-core-4.35.0-wasm64-new", fromCache: false, totalBytes: raw.length });
      expect(fetched.filter((u) => u.startsWith("/part-")).length).toBeGreaterThan(0);
    }
  });
});
