// The release bundle writer (pipeline/release/write-bundle.mjs, plan B2c,
// docs/RELEASE-BUNDLE.md "The bundle"): byte-identical across runs, tars that
// list exactly the expected entries with the pinned metadata, and refusals of a
// tampered umbrella and an occupied --out. The inputs are a temp copy of HEAD's
// tracked manifests whose base-tree.json is re-pointed at a fake umbrella (the
// real umbrella bytes are not tracked); nothing here writes under the repo.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ReleaseRefusal, treeSource, type ReleaseSource } from "../../pipeline/release/release-manifest.mjs";
import { BUNDLE_FILES, buildBundle, gzipPinned, tarOf, writeBundleDir } from "../../pipeline/release/write-bundle.mjs";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "pipeline/release/write-bundle.mjs");
const git = (...args: string[]) => spawnSync("git", args, { cwd: root, maxBuffer: 1 << 30 });
const hasGit = git("rev-parse", "--verify", "HEAD").status === 0;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const atHead = (p: string): Buffer => {
  const r = git("cat-file", "blob", `HEAD:${p}`);
  if (r.status !== 0) throw new Error(`HEAD:${p} is not readable`);
  return r.stdout;
};
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", timeout: 120_000 });

interface TarEntry { name: string; mode: number; uid: number; gid: number; size: number; mtime: number; type: string; uname: string; gname: string; magic: string; data: Buffer }
/** A strict ustar reader: every header's checksum, fields and padding checked. */
function readTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  const str = (h: Buffer, o: number, w: number) => h.subarray(o, o + w).toString("utf8").replace(/\0.*$/s, "");
  const num = (h: Buffer, o: number, w: number) => parseInt(str(h, o, w).trim() || "0", 8);
  let off = 0;
  expect(tar.length % 512).toBe(0);
  for (;;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      expect(tar.subarray(off).every((b) => b === 0)).toBe(true);
      expect(tar.length - off).toBe(1024);
      return out;
    }
    const sum = [...h].reduce((n, b, i) => n + (i >= 148 && i < 156 ? 0x20 : b), 0);
    expect(num(h, 148, 8)).toBe(sum);
    const prefix = str(h, 345, 155);
    const name = prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100);
    const size = num(h, 124, 12);
    out.push({ name, mode: num(h, 100, 8), uid: num(h, 108, 8), gid: num(h, 116, 8), size, mtime: num(h, 136, 12), type: str(h, 156, 1),
      uname: str(h, 265, 32), gname: str(h, 297, 32), magic: h.subarray(257, 265).toString("latin1"), data: Buffer.from(tar.subarray(off + 512, off + 512 + size)) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
}
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

let tmp: string;
let tree: string;
let umbrella: string;
let dist: string;
let buildId: string;
let commitTime: number;
const UMB = { "QED64/Essential.olean": "fake umbrella olean\n", "QED64/Essential.olean.server": "fake server\n", "QED64/Essential.olean.private": "fake private\n" };
const source = (): ReleaseSource => treeSource({
  publicDir: path.join(tree, "public"), toolchainRecord: path.join(tree, "toolchain/lean4-wasm64-release.json"), baseTree: path.join(tree, "embedding/base-tree.json"),
});

beforeAll(() => {
  if (!hasGit) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-write-bundle-"));
  tree = path.join(tmp, "tree");
  const pi = JSON.parse(atHead("public/profiles/index.json").toString());
  const workers = git("ls-tree", "-r", "--name-only", "HEAD", "--", "public/workers/").stdout.toString().split("\n").filter(Boolean);
  const inputs = ["public/runtime/runtime-manifest.json", "public/snapshots/index.json", "public/profiles/index.json",
    ...pi.profiles.map((p: { manifest: string }) => `public${p.manifest}`), ...workers, "toolchain/lean4-wasm64-release.json", "embedding/base-tree.json"];
  for (const p of inputs) {
    fs.mkdirSync(path.dirname(path.join(tree, p)), { recursive: true });
    fs.writeFileSync(path.join(tree, p), atHead(p));
  }
  // The fake umbrella, and base-tree.json naming it (top-level pair, and each tree's files).
  umbrella = path.join(tmp, "umbrella");
  for (const [p, text] of Object.entries(UMB)) {
    fs.mkdirSync(path.dirname(path.join(umbrella, p)), { recursive: true });
    fs.writeFileSync(path.join(umbrella, p), text);
  }
  fs.writeFileSync(path.join(umbrella, "QED64/unrelated.txt"), "not named by base-tree.json, not shipped\n");
  const bt = JSON.parse(fs.readFileSync(path.join(tree, "embedding/base-tree.json"), "utf8"));
  const fake = (u: { path: string }) => ({ path: u.path, sha256: sha(UMB[u.path as keyof typeof UMB]), bytes: Buffer.byteLength(UMB[u.path as keyof typeof UMB]) });
  bt.umbrella = bt.umbrella.map(fake);
  for (const t of Object.values<any>(bt.trees)) t.umbrella = t.umbrella.map(fake);
  fs.writeFileSync(path.join(tree, "embedding/base-tree.json"), `${JSON.stringify(bt, null, 2)}\n`);
  // A minimal vite-shaped dist built "from HEAD": workers verbatim, the bundle pinning the runtime.
  buildId = JSON.parse(atHead("public/runtime/runtime-manifest.json").toString()).buildId;
  dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), '<!doctype html>\n<script type="module" src="/assets/index-T3st.js"></script>\n');
  fs.writeFileSync(path.join(dist, "assets/index-T3st.js"), `export const paired = ${JSON.stringify(buildId)};\n`);
  fs.writeFileSync(path.join(dist, "favicon.svg"), "<svg/>\n");
  for (const p of workers) {
    fs.mkdirSync(path.dirname(path.join(dist, p.slice("public/".length))), { recursive: true });
    fs.writeFileSync(path.join(dist, p.slice("public/".length)), atHead(p));
  }
  commitTime = Number(git("show", "-s", "--format=%ct", "HEAD").stdout.toString().trim());
});
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(!hasGit)("write-bundle.mjs", () => {
  test("two runs write byte-identical bundles; SHA256SUMS lists every other file", () => {
    const a = buildBundle(source(), { dist, umbrella });
    const b = buildBundle(source(), { dist, umbrella });
    const outA = writeBundleDir(a.files, path.join(tmp, "out-a"));
    const outB = writeBundleDir(b.files, path.join(tmp, "out-b"));
    const listing = (d: string) => { const w = (rel: string): string[] => fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? w(path.posix.join(rel, e.name)) : [path.posix.join(rel, e.name)])); return w("").sort(byteOrder); };
    const expected = ["SHA256SUMS", "qed64-manifests.tar.gz", "qed64-shell.tar.gz", "release.json",
      "umbrella/QED64/Essential.olean", "umbrella/QED64/Essential.olean.private", "umbrella/QED64/Essential.olean.server"];
    expect(listing(outA)).toEqual(expected);
    expect(listing(outB)).toEqual(expected);
    for (const rel of expected) expect(fs.readFileSync(path.join(outA, rel)).equals(fs.readFileSync(path.join(outB, rel))), rel).toBe(true);
    const sums = fs.readFileSync(path.join(outA, "SHA256SUMS"), "utf8");
    expect(sums).toBe(expected.filter((r) => r !== "SHA256SUMS").map((r) => `${sha(fs.readFileSync(path.join(outA, r)))}  ${r}\n`).join(""));
    // release.json is the manifest (with the shell section) and names the umbrella files the bundle ships.
    const m = JSON.parse(fs.readFileSync(path.join(outA, "release.json"), "utf8"));
    expect(m.schema).toBe("qed64.release/v1");
    expect(m.shell.shellId).toMatch(/^shell-[0-9a-f]{16}$/);
    for (const u of m.baseTree.umbrellaFiles) {
      const bytes = fs.readFileSync(path.join(outA, "umbrella", u.path));
      expect({ sha256: sha(bytes), bytes: bytes.length }).toEqual({ sha256: u.sha256, bytes: u.bytes });
    }
    expect(fs.readdirSync(tmp).filter((n) => n.includes(".tmp-"))).toEqual([]); // no temp dir left behind
  });

  test("the tars: entries byte-ordered with their directories, commit mtime, uid/gid 0, empty owner names, 0644/0755; gzip header pinned", () => {
    const { files, manifest } = buildBundle(source(), { dist, umbrella });
    for (const name of [BUNDLE_FILES.shell, BUNDLE_FILES.manifests]) {
      const gz = files.get(name)!;
      expect([gz[0], gz[1], gz[2]]).toEqual([0x1f, 0x8b, 8]);
      expect(gz.readUInt32LE(4)).toBe(0);
      expect(gz[9]).toBe(0x03);
    }
    const check = (entries: TarEntry[]) => {
      expect(entries.map((e) => e.name)).toEqual([...entries.map((e) => e.name)].sort(byteOrder));
      for (const e of entries) {
        expect(e).toMatchObject({ uid: 0, gid: 0, uname: "", gname: "", mtime: commitTime, magic: "ustar\x0000" });
        expect(e.type === "5" ? [e.mode, e.size, e.name.endsWith("/")] : [e.mode, e.type]).toEqual(e.type === "5" ? [0o755, 0, true] : [0o644, "0"]);
      }
    };
    const shell = readTar(zlib.gunzipSync(files.get(BUNDLE_FILES.shell)!));
    check(shell);
    const distFiles = ["assets/index-T3st.js", "favicon.svg", "index.html", ...fs.readdirSync(path.join(dist, "workers")).map((w) => `workers/${w}`)];
    expect(shell.filter((e) => e.type === "0").map((e) => e.name)).toEqual([...distFiles].sort(byteOrder));
    expect(shell.filter((e) => e.type === "5").map((e) => e.name)).toEqual(["assets/", "workers/"]);
    for (const e of shell.filter((x) => x.type === "0")) expect(e.data.equals(fs.readFileSync(path.join(dist, e.name))), e.name).toBe(true);
    // The listing a downstream recomputes from the extracted tar is the manifest's shell listing.
    expect(sha(shell.filter((e) => e.type === "0").map((e) => `${sha(e.data)}  ${e.name}\n`).join(""))).toBe(manifest.shell!.listingSha256);

    const roots = readTar(zlib.gunzipSync(files.get(BUNDLE_FILES.manifests)!));
    check(roots);
    const pi = JSON.parse(fs.readFileSync(path.join(tree, "public/profiles/index.json"), "utf8"));
    expect(roots.filter((e) => e.type === "0").map((e) => e.name)).toEqual([
      "embedding/base-tree.json", "public/profiles/index.json", ...pi.profiles.map((p: { manifest: string }) => `public${p.manifest}`),
      "public/runtime/runtime-manifest.json", "public/snapshots/index.json", "toolchain/lean4-wasm64-release.json",
    ].sort(byteOrder));
    expect(roots.some((e) => /KERNEL-PIN/.test(e.name))).toBe(false); // retired 2026-10 (plan B2c)
    for (const e of roots.filter((x) => x.type === "0")) expect(e.data.equals(fs.readFileSync(path.join(tree, e.name))), e.name).toBe(true);
    // The system tar reads it too (bsdtar on macOS, GNU tar on Linux).
    const sys = spawnSync("tar", ["-tzf", "-"], { input: files.get(BUNDLE_FILES.manifests)!, encoding: "utf8" });
    if (sys.status === 0) expect(sys.stdout.split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, ""))).toEqual(roots.map((e) => e.name));
  });

  test("tarOf splits a long name into ustar prefix + name, and refuses one that cannot be split", () => {
    const d = "d".repeat(60);
    const e = "e".repeat(60);
    const long = `${d}/${e}/${"f".repeat(90)}.js`; // 214 bytes: prefix "<d>/<e>", name "<f>.js"
    const entries = readTar(tarOf(new Map([[long, Buffer.from("x")]]), 7));
    expect(entries.map((x) => [x.name, x.mtime])).toEqual([[`${d}/`, 7], [`${d}/${e}/`, 7], [long, 7]]);
    expect(() => tarOf(new Map([[`${"e".repeat(101)}.js`, Buffer.from("x")]]), 0)).toThrow(/too long for a ustar header/);
    expect(() => tarOf(new Map([["../x", Buffer.from("x")]]), 0)).toThrow(/is not a relative path/);
    const gz = gzipPinned(Buffer.from("same"));
    expect(gz.equals(gzipPinned(Buffer.from("same")))).toBe(true);
    expect(zlib.gunzipSync(gz).toString()).toBe("same");
  });

  test("a tampered or missing umbrella file is refused, and nothing is written", () => {
    const file = path.join(umbrella, "QED64/Essential.olean.server");
    const original = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, "tampered\n");
      expect(() => buildBundle(source(), { dist, umbrella })).toThrow(ReleaseRefusal);
      expect(() => buildBundle(source(), { dist, umbrella })).toThrow(/--umbrella: QED64\/Essential\.olean\.server is [0-9a-f]{16}… \(9 B\), base-tree\.json names [0-9a-f]{16}… \(12 B\) — not the umbrella the base trees carry/);
      fs.rmSync(file);
      expect(() => buildBundle(source(), { dist, umbrella })).toThrow(/--umbrella: .*Essential\.olean\.server is not readable \(ENOENT\)/);
    } finally {
      fs.writeFileSync(file, original);
    }
    // A shell file edited after the manifest was built is a release-manifest refusal of its own (workers), or caught here.
    const worker = fs.readdirSync(path.join(dist, "workers")).sort()[0]!;
    const wfile = path.join(dist, "workers", worker);
    const w = fs.readFileSync(wfile);
    try {
      fs.appendFileSync(wfile, "\n// edited\n");
      expect(() => buildBundle(source(), { dist, umbrella })).toThrow(/differs from .*public\/workers\//);
    } finally {
      fs.writeFileSync(wfile, w);
    }
  });

  test("CLI: --help, usage errors (2), an occupied --out (2), a refusal (1, one line, no --out)", () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/^usage: node pipeline\/release\/write-bundle\.mjs /);
    for (const args of [[], ["--dist", "d", "--umbrella", "u"], ["--bogus", "x"], ["--dist", "d", "--dist", "e", "--umbrella", "u", "--out", "o"], ["--out"]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/^write-bundle: /);
    }
    const occupied = path.join(tmp, "occupied");
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, "keep.txt"), "mine\n");
    const busy = run(["--commit", "HEAD", "--dist", dist, "--umbrella", umbrella, "--out", occupied]);
    expect(busy.status).toBe(2);
    expect(busy.stderr.trimEnd().split("\n")).toEqual([`write-bundle: --out ${occupied} exists and is not an empty directory`]);
    expect(fs.readdirSync(occupied)).toEqual(["keep.txt"]);
    // --commit HEAD reads HEAD's base-tree.json, which names the real umbrella: the fake one is refused.
    const out = path.join(tmp, "refused-out");
    const r = run(["--commit", "HEAD", "--dist", dist, "--umbrella", umbrella, "--out", out]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(r.stderr).toMatch(/^write-bundle: REFUSED: --umbrella: QED64\/Essential\.olean is [0-9a-f]{16}… \(20 B\), base-tree\.json names /);
    expect(fs.existsSync(out)).toBe(false);
    // An empty --out directory is fine to fill (in-process: the fake umbrella needs the doctored base tree).
    const empty = path.join(tmp, "empty-out");
    fs.mkdirSync(empty);
    expect(writeBundleDir(buildBundle(source(), { dist, umbrella }).files, empty)).toBe(empty);
    expect(fs.readdirSync(empty)).toContain("release.json");
  });
});
