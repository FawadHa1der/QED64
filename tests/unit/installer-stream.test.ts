// The installer's streaming core: verified-part ingress → gunzip → sink.
// Pins the two failure classes hit in live bring-up: a sink that REJECTS
// (quota) and a sink that HANGS must both surface as rejections — never as a
// silent stall — and a corrupted part must be refused before it reaches the
// sink.

import { describe, expect, test, vi, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { inflateTransport, type ProfileManifest } from "../../src/install/profiles";

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
          parts: parts.map((p, i) => ({
            url: `/part-${i}`,
            digest: `sha256:${sha256(p)}`,
            byteLength: p.length,
          })),
        },
      },
      modules: { M: { imports: [] } },
      roots: ["M"],
      workerfs: { mountPoint: "/lib", metadata: { files: [{ filename: "/m", start: 0, end: raw.length }] } },
    },
  } as unknown as ProfileManifest;
  return { manifest, parts };
}

function stubFetch(parts: Uint8Array[], mutate?: (i: number, b: Uint8Array) => Uint8Array) {
  vi.stubGlobal("fetch", async (url: string) => {
    const i = Number(/part-(\d+)/.exec(url)![1]);
    let bytes = parts[i]!;
    if (mutate) bytes = mutate(i, bytes);
    return new Response(bytes.slice() as unknown as BodyInit, { status: 200 });
  });
}

afterEach(() => vi.unstubAllGlobals());

const raw = new Uint8Array(4096).map((_, i) => i % 251);

describe("inflateTransport", () => {
  test("happy path: inflates byte-exactly through a collecting sink", async () => {
    const { manifest, parts } = makeManifest(raw);
    stubFetch(parts);
    const chunks: Uint8Array[] = [];
    const n = await inflateTransport(manifest, async (c) => { chunks.push(c); }, () => {});
    expect(n).toBe(raw.length);
    const joined = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) { joined.set(c, off); off += c.length; }
    expect(Buffer.compare(Buffer.from(joined), Buffer.from(raw))).toBe(0);
  });

  test("a corrupted part is rejected before any sink write of its bytes", async () => {
    const { manifest, parts } = makeManifest(raw);
    stubFetch(parts, (i, b) => {
      if (i === 1) { const c = b.slice(); c[0]! ^= 0xff; return c; }
      return b;
    });
    await expect(inflateTransport(manifest, async () => {}, () => {})).rejects.toThrow(/SHA-256/);
  });

  test("a sink that rejects (quota) fails the transport instead of hanging", async () => {
    const { manifest, parts } = makeManifest(raw);
    stubFetch(parts);
    let written = 0;
    const quota = Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    await expect(
      inflateTransport(manifest, async (c) => {
        written += c.length;
        if (written > 1024) throw quota;
      }, () => {}),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  test("a sink that HANGS still fails once the caller's guard rejects", async () => {
    // Model the OPFS stall: the sink returns a promise that resolves only for
    // the first write, then never settles — but the caller wraps it with a
    // watchdog, exactly as installProfile does.
    const { manifest, parts } = makeManifest(raw);
    stubFetch(parts);
    let calls = 0;
    const guarded = (p: Promise<void>) =>
      Promise.race([
        p,
        new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("stall"), { name: "OpfsStallError" })), 50)),
      ]);
    await expect(
      inflateTransport(manifest, (c) => {
        calls += 1;
        return guarded(calls === 1 ? Promise.resolve() : new Promise<void>(() => {}));
      }, () => {}),
    ).rejects.toMatchObject({ name: "OpfsStallError" });
  }, 10_000);

  test("declared-length overflow is refused (zip-bomb guard)", async () => {
    const { manifest, parts } = makeManifest(raw);
    (manifest.content.pack as { byteLength: number }).byteLength = raw.length - 1;
    stubFetch(parts);
    await expect(inflateTransport(manifest, async () => {}, () => {})).rejects.toThrow(/inflated past|WORKERFS range/);
  });
});
