// toolchain/lean4-wasm64-release.json is the ONE place QED64 names its
// toolchain release (decision 3): infra/worker.js bundles it and routes
// /runtime/* and /profiles/<not index.json> to lean4-wasm64/<id>/ in R2. This
// pins the pairing against the tracked files, so a commit cannot move the
// record without the manifests (or the manifests without the record):
//   - the record's self-digest holds (the fork's release-record.mjs rule);
//   - the shell's runtime manifest is the release's runtime (buildId);
//   - every TRACKED file under public/runtime/ and public/profiles/ the Worker
//     routes to the release is byte-identical to the release's (record.files);
//   - the shipped Worker routes by this record.
// Imports nothing from lean4-wasm64: the record and the tracked files only.
import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import shipped from "../../infra/worker.js";

const root = path.resolve(__dirname, "../..");
const RECORD = path.join(root, "toolchain/lean4-wasm64-release.json");

type ReleaseFile = { path: string; bytes: number; sha256: string };
type Release = {
  schema: string;
  id: string;
  runtime: { buildId: string };
  hosting: { layout: string; mount: Record<string, string>; siteOwned: string[] };
  files: ReleaseFile[];
  digest: string;
};
const record = JSON.parse(fs.readFileSync(RECORD, "utf8")) as Release;
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The site path a tracked public/ file is served at, or null when the record leaves it to the site. */
function releasePath(sitePath: string): string | null {
  const owned = record.hosting.siteOwned.some((p) => (p.endsWith("/") ? sitePath.startsWith(p) : sitePath === p));
  if (owned) return null;
  for (const [url, dir] of Object.entries(record.hosting.mount)) if (sitePath.startsWith(url)) return dir + sitePath.slice(url.length);
  return null;
}

describe("toolchain/lean4-wasm64-release.json pins the release the Worker serves", () => {
  test("the record's digest is self-consistent: sha256 of JSON.stringify(record without digest, null, 2)", () => {
    const { digest, ...rest } = record;
    expect(record.schema).toBe("lean4-wasm64.release/v1");
    expect(digest).toBe("sha256:" + sha256(JSON.stringify(rest, null, 2)));
    // the canonical file: that serialisation of the whole record and one newline
    expect(fs.readFileSync(RECORD, "utf8")).toBe(JSON.stringify(record, null, 2) + "\n");
  });

  test("the shell's runtime manifest is the release's runtime (buildId), and so is every snapshot's", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "public/runtime/runtime-manifest.json"), "utf8")) as { buildId: string };
    expect(manifest.buildId).toBe(record.runtime.buildId);
    const index = JSON.parse(fs.readFileSync(path.join(root, "public/snapshots/index.json"), "utf8")) as { snapshots: { name: string; runtime: string }[] };
    for (const s of index.snapshots) expect(s.runtime, s.name).toBe(record.runtime.buildId);
  });

  test("every tracked public/runtime and public/profiles file the Worker routes to the release is the release's, byte for byte", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "public/runtime", "public/profiles"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    const byPath = new Map(record.files.map((f) => [f.path, f]));
    const routed: string[] = [];
    const siteOwned: string[] = [];
    for (const rel of tracked) {
      const sitePath = "/" + rel.slice("public/".length);
      const inRelease = releasePath(sitePath);
      if (inRelease === null) {
        siteOwned.push(sitePath);
        continue;
      }
      routed.push(inRelease);
      const want = byPath.get(inRelease);
      expect(want, `${rel}: ${inRelease} is not in the release's files[]`).toBeDefined();
      const bytes = fs.readFileSync(path.join(root, rel));
      expect({ bytes: bytes.length, sha256: sha256(bytes) }, rel).toEqual({ bytes: want!.bytes, sha256: want!.sha256 });
    }
    // what the pairing covers today: the runtime manifest and the two profile manifests; the index is the site's
    expect(routed).toContain("runtime/runtime-manifest.json");
    expect(routed.filter((p) => p.startsWith("profiles/")).length).toBeGreaterThan(0);
    expect(siteOwned).toEqual(["/profiles/index.json"]);
  });

  test("infra/worker.js routes by this record: the runtime manifest to lean4-wasm64/<id>/, the snapshot index to the bucket root", async () => {
    const asked: string[] = [];
    const bucket = {
      async get(key: string) {
        asked.push(`get ${key}`);
        return null;
      },
      async head(key: string) {
        asked.push(`head ${key}`);
        return null;
      },
    };
    const env = { ASSETS: { fetch: async () => new Response(null, { status: 404 }) }, ARTIFACTS: bucket };
    await shipped.fetch(new Request("https://qed64.example/runtime/runtime-manifest.json"), env);
    expect(asked[0]).toBe(`get lean4-wasm64/${record.id}/runtime/runtime-manifest.json`);
    asked.length = 0;
    await shipped.fetch(new Request("https://qed64.example/snapshots/index.json"), env);
    expect(asked).toEqual(["get snapshots/index.json"]);
    asked.length = 0;
    await shipped.fetch(new Request("https://qed64.example/profiles/index.json"), env);
    expect(asked).toEqual(["get profiles/index.json"]);
  });
});
