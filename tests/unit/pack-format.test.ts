// Round-trip test of the pipeline packer against real olean bytes: pack a
// fixture library, then verify the manifest invariants the app loader relies
// on and the byte-exact recoverability of every artifact from the pack.

import { describe, expect, test, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const fixtureLib = path.join(root, "tests/fixtures/mini-lib");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const haveFixture = existsSync(fixtureLib);
const describeIf = haveFixture ? describe : describe.skip;

describeIf("pack.mjs round trip", () => {
  let outDir: string;
  let manifest: any;
  let pack: Buffer;

  beforeAll(() => {
    outDir = mkdtempSync(path.join(tmpdir(), "qed64-pack-"));
    execFileSync("node", [
      path.join(root, "pipeline/artifacts/pack.mjs"),
      "--lib", fixtureLib, "--id", "t", "--out", outDir, "--roots", "Init.Prelude",
    ]);
    manifest = JSON.parse(readFileSync(path.join(outDir, "t.manifest.json"), "utf8"));
    const parts = readdirSync(outDir).filter((f: string) => f.includes(".part-")).sort();
    pack = gunzipSync(Buffer.concat(parts.map((p: string) => readFileSync(path.join(outDir, p)))));
  });

  test("manifest declares the loader contract", () => {
    expect(manifest.format).toBe("browser64.artifact-manifest");
    expect(manifest.content.pack.transport.encoding).toBe("gzip");
    expect(manifest.content.workerfs.mountPoint).toBe("/lib/lean/library");
  });

  test("raw pack matches its declared identity", () => {
    expect(pack.length).toBe(manifest.content.pack.byteLength);
    expect(`sha256:${sha256(pack)}`).toBe(manifest.content.pack.digest);
  });

  test("every artifact recovers byte-exactly through its WORKERFS range", () => {
    const byName = new Map<string, { start: number; end: number }>(
      manifest.content.workerfs.metadata.files.map((f: { filename: string; start: number; end: number }) => [f.filename, f]),
    );
    for (const mod of Object.values<any>(manifest.content.modules)) {
      for (const ref of Object.values<any>(mod.artifacts)) {
        const range = byName.get(`/${ref.filename}`)!;
        const bytes = pack.subarray(range.start, range.end);
        const original = readFileSync(path.join(fixtureLib, ref.filename));
        expect(bytes.length).toBe(ref.byteLength);
        expect(Buffer.compare(bytes, original)).toBe(0);
        expect(`sha256:${sha256(bytes)}`).toBe(ref.digest);
      }
    }
  });

  test("artifact starts are 8-byte aligned (compacted-region friendly)", () => {
    for (const f of manifest.content.workerfs.metadata.files) {
      expect(f.start % 8).toBe(0);
    }
  });

  test("olean payloads carry the olean magic", () => {
    for (const f of manifest.content.workerfs.metadata.files) {
      if (!f.filename.endsWith(".olean")) continue;
      expect(pack.subarray(f.start, f.start + 5).toString("ascii")).toBe("olean");
    }
  });
});
