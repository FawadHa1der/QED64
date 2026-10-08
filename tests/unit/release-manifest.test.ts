// The release manifest (pipeline/release/release-manifest.mjs,
// docs/RELEASE-BUNDLE.md): generated for the CURRENT HEAD from git objects
// only (no network, no artifact bytes), byte-deterministic, self-verifying
// (digest, artifactSetId, shellId recomputed here the way a downstream
// would), and refusing every pairing fact it is meant to guard. The doctored
// inputs live in a temp copy of HEAD's tracked manifests; nothing here
// touches public/, work/ or dist/ of the repo. The shell's own half,
// frontend/build/build-info.mjs, is run inside real Vite builds at the end.
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import {
  ReleaseRefusal,
  artifactSetIdOf,
  buildReleaseManifest,
  commitSource,
  listingOf,
  manifestDigest,
  recordDigest,
  serializeManifest,
  treeSource,
  type ReleaseManifest,
  type ReleaseSource,
} from "../../pipeline/release/release-manifest.mjs";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "pipeline/release/release-manifest.mjs");
const run = (args: string[], cwd = root) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", timeout: 60_000 });
const git = (...args: string[]) => spawnSync("git", args, { cwd: root, maxBuffer: 1 << 30 });
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hasGit = git("rev-parse", "--verify", "HEAD").status === 0;
const atHead = (repoPath: string): Buffer => {
  const r = git("cat-file", "blob", `HEAD:${repoPath}`);
  if (r.status !== 0) throw new Error(`HEAD:${repoPath} is not readable`);
  return r.stdout;
};
const blobAtHead = (repoPath: string) => git("rev-parse", `HEAD:${repoPath}`).stdout.toString().trim();
const json = (b: Buffer | string) => JSON.parse(b.toString());
const OTHER_ID = "wasm64-0000000000000000";

let tmp: string;
let tree: string; // a doctorable copy of HEAD's tracked inputs: <tree>/toolchain/…, <tree>/embedding/…, <tree>/public/…
let head: string;
let buildId: string;
let inputPaths: string[];
const RECORD = "toolchain/lean4-wasm64-release.json";
const BASE_TREE = "embedding/base-tree.json";
const treeOpts = () => ({ publicDir: path.join(tree, "public"), toolchainRecord: path.join(tree, RECORD), baseTree: path.join(tree, BASE_TREE) });
const treeFile = (repoPath: string) => path.join(tree, repoPath);
const treeArgs = () => ["--worktree", "--public", path.join(tree, "public"), "--toolchain-record", path.join(tree, RECORD), "--base-tree", path.join(tree, BASE_TREE)];

/** Refusal message of a build, asserting it IS a refusal and one line. */
function refusal(build: () => unknown): string {
  try {
    build();
  } catch (e) {
    expect(e).toBeInstanceOf(ReleaseRefusal);
    const message = (e as Error).message;
    expect(message).not.toContain("\n");
    return message;
  }
  throw new Error("expected a ReleaseRefusal, the build succeeded");
}

/** Apply an edit to one doctored input, run `body`, restore HEAD's bytes. */
function doctored(repoPath: string, edit: (text: string) => string, body: () => void) {
  const file = treeFile(repoPath);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, edit(original.toString("utf8")));
  try { body(); } finally { fs.writeFileSync(file, original); }
}
const editJson = (fn: (o: any) => void) => (text: string) => { const o = JSON.parse(text); fn(o); return JSON.stringify(o, null, 2); };
/** Edit the release record and re-cut its self-digest, as a (wrong) record that is internally consistent. */
const editRecord = (fn: (o: any) => void) => editJson((o) => { fn(o); o.digest = recordDigest(o); });

beforeAll(() => {
  if (!hasGit) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-release-manifest-"));
  tree = path.join(tmp, "tree");
  head = git("rev-parse", "HEAD").stdout.toString().trim();
  const profileIndex = json(atHead("public/profiles/index.json"));
  const workers = git("ls-tree", "-r", "--name-only", "HEAD", "--", "public/workers/").stdout.toString().split("\n").filter(Boolean);
  inputPaths = [
    "public/runtime/runtime-manifest.json",
    "public/snapshots/index.json",
    "public/profiles/index.json",
    ...profileIndex.profiles.map((p: { manifest: string }) => `public${p.manifest}`),
    ...workers,
    RECORD,
    BASE_TREE,
  ];
  for (const p of inputPaths) {
    fs.mkdirSync(path.dirname(path.join(tree, p)), { recursive: true });
    fs.writeFileSync(path.join(tree, p), atHead(p));
  }
  buildId = json(atHead("public/runtime/runtime-manifest.json")).buildId;
});
afterAll(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(!hasGit)("release-manifest.mjs CLI", () => {
  test("--help prints usage and nothing else happens (no git, no file)", () => {
    const out = path.join(tmp, "help.json");
    const before = fs.readdirSync(tmp).sort();
    // PATH empty: any git call would fail and turn into a refusal (exit 1).
    const r = spawnSync(process.execPath, [script, "--help", "--commit", "HEAD", "--out", out], {
      cwd: tmp, encoding: "utf8", timeout: 60_000, env: { PATH: "" },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^usage: node pipeline\/release\/release-manifest\.mjs/);
    expect(r.stderr).toBe("");
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.readdirSync(tmp).sort()).toEqual(before);
  });

  test("usage errors exit 2", () => {
    const cases = [["--bogus"], ["--commit"], ["--commit", "HEAD", "--worktree"], ["--out", "a", "--check", "b"], ["--public", "x"],
      ["--toolchain-record", "x"], ["--base-tree", "x"], ["--worktree", "--kernel-pin", "x"], ["--repo"]];
    for (const args of cases) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/^release-manifest: /);
    }
  });

  test("HEAD's manifest: schema, identity, and every digest taken from the tracked manifests", () => {
    const out = path.join(tmp, "head.json");
    const r = run(["--commit", "HEAD", "--out", out]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^release-manifest: qed64-${head.slice(0, 7)} set-[0-9a-f]{16} runtime ${buildId}, \\d+ snapshot\\(s\\), \\d+ pack\\(s\\) → `));
    const text = fs.readFileSync(out, "utf8");
    const m: ReleaseManifest = JSON.parse(text);
    expect(text).toBe(`${JSON.stringify(m, null, 2)}\n`);
    expect(Object.keys(m)).toEqual(["schema", "digest", "releaseId", "artifactSetId", "qed64", "lean", "kernel", "toolchain", "hosting", "baseTree", "runtime", "snapshots", "profiles", "shell"]);
    expect(m.schema).toBe("qed64.release/v1");
    expect(m.releaseId).toBe(`qed64-${head.slice(0, 7)}`);
    const seconds = Number(git("show", "-s", "--format=%ct", "HEAD").stdout.toString().trim());
    expect(m.qed64).toEqual({
      repo: "FawadHa1der/QED64", commit: head, committedAt: new Date(seconds * 1000).toISOString().replace(".000Z", "Z"), source: "commit", dirty: false,
    });

    const rtBytes = atHead("public/runtime/runtime-manifest.json");
    const rt = json(rtBytes);
    const recBytes = atHead(RECORD);
    const rec = json(recBytes);
    expect(m.lean).toEqual({ version: rt.leanVersion, target: rt.target });
    // `kernel` keeps its shape; the commit is the pinned record's (KERNEL-PIN retired 2026-10).
    expect(m.kernel).toEqual({ repo: "FawadHa1der/lean4", branch: "qed64-wasm64", commit: rec.kernel.commit, sourceRevision: rt.sourceRevision });
    expect(m.kernel.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(m.toolchain).toEqual({
      releaseId: rec.id,
      digest: rec.digest,
      record: { path: RECORD, sha256: sha(recBytes), gitBlob: blobAtHead(RECORD) },
      kernel: { commit: rec.kernel.commit, patch: rec.kernel.patch },
      runtimeBuildId: rt.buildId,
      packs: rec.packs.map((p: any) => ({ id: p.id, rawSha256: p.rawSha256 })),
      tools: { package: rec.tools.package, version: rec.tools.version, tgz: rec.tools.tgz },
    });
    expect(m.toolchain.digest).toBe(recordDigest(rec));
    expect(m.hosting).toEqual({
      toolchainPrefix: `lean4-wasm64/${rec.id}/`,
      siteOwned: rec.hosting.siteOwned,
      rule: "a path under runtime/ or profiles/ that is not site-owned is stored at <toolchainPrefix><path>; every other path at <path>",
    });
    const btBytes = atHead(BASE_TREE);
    const bt = json(btBytes);
    const bare = (packs: any[]) => packs.map((p) => ({ id: p.id, release: p.release, rawSha256: p.rawSha256.replace(/^sha256:/, "") }));
    expect(Object.keys(m.baseTree)).toEqual(["path", "sha256", "gitBlob", "schema", "releaseId", "releaseDigest", "runtime", "packs", "slim", "umbrella", "umbrellaSource", "initLib", "digestRule", "trees", "umbrellaFiles"]);
    expect(m.baseTree).toMatchObject({
      path: BASE_TREE, sha256: sha(btBytes), gitBlob: blobAtHead(BASE_TREE), schema: "qed64.base-tree/v1", releaseId: bt.releaseId, releaseDigest: bt.releaseDigest,
      runtime: bt.runtime, packs: bare(bt.packs), slim: bt.slim, umbrella: bt.umbrella, umbrellaSource: bt.umbrellaSource, initLib: bt.initLib, digestRule: bt.digestRule,
    });
    for (const [name, t] of Object.entries<any>(bt.trees)) expect(m.baseTree.trees[name]).toEqual({ ...t, packs: bare(t.packs) });
    const union = new Map<string, unknown>();
    for (const u of [...bt.umbrella, ...Object.values<any>(bt.trees).flatMap((t) => t.umbrella)]) union.set(u.path, u);
    expect(m.baseTree.umbrellaFiles).toEqual([...union.keys()].sort().map((k) => union.get(k)));
    expect(m.baseTree.umbrellaFiles.map((u) => u.path)).toEqual(expect.arrayContaining(["QED64/Essential.olean", "QED64/Essential.olean.server"]));
    expect(m.runtime.buildId).toBe(rt.buildId);
    expect(m.runtime.manifest).toEqual({
      path: "runtime/runtime-manifest.json", sha256: sha(rtBytes), gitBlob: blobAtHead("public/runtime/runtime-manifest.json"),
      pinnedPath: `runtime/runtime-manifest.${rt.buildId}.json`,
    });
    expect(m.runtime.files.map((f) => f.name)).toEqual(Object.keys(rt.files).sort());
    for (const f of m.runtime.files) {
      const src = rt.files[f.name];
      expect({ bytes: f.bytes, sha256: f.sha256 }).toEqual({ bytes: src.bytes, sha256: src.sha256 });
      expect(f.chunks).toEqual(src.chunks.map((c: any) => ({ path: c.url.slice(1), bytes: c.bytes, sha256: c.sha256 })));
    }

    const siBytes = atHead("public/snapshots/index.json");
    expect(m.snapshots.index).toEqual({ path: "snapshots/index.json", sha256: sha(siBytes), gitBlob: blobAtHead("public/snapshots/index.json") });
    expect(m.snapshots.entries).toEqual(json(siBytes).snapshots.map((e: any) => ({
      name: e.name, path: e.url.slice(1), sha256: e.digest.slice(7), transferBytes: e.transfer, rawBytes: e.bytes, imports: e.imports, runtime: e.runtime,
    })));

    const piBytes = atHead("public/profiles/index.json");
    const pi = json(piBytes);
    expect(m.profiles.index).toEqual({ path: "profiles/index.json", sha256: sha(piBytes), gitBlob: blobAtHead("public/profiles/index.json") });
    expect(m.profiles.packs.map((p) => p.id)).toEqual(pi.profiles.map((p: any) => p.id));
    for (const [i, pack] of m.profiles.packs.entries()) {
      const repoPath = `public${pi.profiles[i].manifest}`;
      const bytes = atHead(repoPath);
      const pm = json(bytes);
      expect(pack.release).toBe(pm.content.release);
      expect(pack.modules).toBe(Object.keys(pm.content.modules).length);
      expect(pack.manifest).toEqual({ path: repoPath.slice(7), sha256: sha(bytes), gitBlob: blobAtHead(repoPath), contentDigest: pm.digest });
      expect(pack.lean).toEqual({ version: pm.content.lean.version, gitRevision: pm.content.lean.gitRevision });
      expect(pack.pack).toEqual({ sha256: pm.content.pack.digest.slice(7), bytes: pm.content.pack.byteLength });
      expect(pack.transport).toEqual({
        sha256: pm.content.pack.transport.digest.slice(7),
        bytes: pm.content.pack.transport.byteLength,
        parts: pm.content.pack.transport.parts.map((p: any) => ({ path: p.url.slice(1), sha256: p.digest.slice(7), bytes: p.byteLength })),
      });
    }
    expect(m.shell).toBeNull();

    // The identities, recomputed the way a downstream would.
    const { digest, ...body } = m;
    expect(digest).toBe(`sha256:${sha(JSON.stringify(body))}`);
    expect(manifestDigest(m)).toBe(digest);
    expect(m.artifactSetId).toBe(`set-${sha(JSON.stringify({ runtime: m.runtime, snapshots: m.snapshots, profiles: m.profiles })).slice(0, 16)}`);
    expect(artifactSetIdOf(m)).toBe(m.artifactSetId);
  });

  test("deterministic: two runs, another cwd and the in-process build are byte-identical", () => {
    const a = run(["--commit", "HEAD"]);
    const b = run(["--commit", head], tmp);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stdout.length).toBeGreaterThan(1000);
    expect(b.stdout).toBe(a.stdout);
    expect(serializeManifest(buildReleaseManifest(commitSource("HEAD")))).toBe(a.stdout);
  });

  test("--check: 0 on the regenerated bytes, 1 with a line diff on any other", () => {
    const file = path.join(tmp, "check.json");
    expect(run(["--commit", "HEAD", "--out", file]).status).toBe(0);
    const ok = run(["--check", file]); // source defaults to the file's own (commit <head>)
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/matches/);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(`"releaseId": "qed64-${head.slice(0, 7)}"`, '"releaseId": "qed64-0000000"'));
    const bad = run(["--check", file, "--commit", "HEAD"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/differs from the manifest regenerated from commit/);
    expect(bad.stderr).toMatch(/file: +"releaseId": "qed64-0000000"/);
    // The worktree form round-trips too (record and base tree read from the given files), byte for byte.
    const wt = path.join(tmp, "check-worktree.json");
    expect(run([...treeArgs(), "--out", wt]).status).toBe(0);
    expect(fs.readFileSync(wt, "utf8")).toBe(fs.readFileSync(file, "utf8").replace('"releaseId": "qed64-0000000"', `"releaseId": "qed64-${head.slice(0, 7)}"`)
      .replace('"source": "commit"', '"source": "worktree"').replace(/"digest": "sha256:[0-9a-f]{64}",\n  "releaseId"/, `"digest": "${json(fs.readFileSync(wt)).digest}",\n  "releaseId"`));
    expect(run(["--check", wt, ...treeArgs()]).status).toBe(0);
    doctored(BASE_TREE, (t) => t.replace('"slim": true', '"slim": false'), () => {
      const drift = run(["--check", wt, ...treeArgs()]);
      expect(drift.status).toBe(1);
      expect(drift.stderr).toMatch(/differs from the manifest regenerated from the working tree/);
    });
  });

  test("a refusal is exit 1, one line on stderr, and no output file", () => {
    doctored("public/snapshots/index.json", editJson((o) => { o.snapshots[0].runtime = OTHER_ID; }), () => {
      const out = path.join(tmp, "refused.json");
      const r = run([...treeArgs(), "--out", out]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(r.stderr).toMatch(/^release-manifest: REFUSED: snapshot \S+ is paired with runtime wasm64-0000000000000000/);
      expect(fs.existsSync(out)).toBe(false);
    });
  });
});

describe.skipIf(!hasGit)("artifactSetId", () => {
  test("is the same from the commit and from an identical working tree, and across qed64 commits", () => {
    const fromCommit = buildReleaseManifest(commitSource("HEAD"));
    const fromTree = buildReleaseManifest(treeSource(treeOpts()));
    expect(fromTree.qed64).toMatchObject({ commit: head, source: "worktree", dirty: false });
    expect(fromTree.artifactSetId).toBe(fromCommit.artifactSetId);
    expect({ ...fromTree, digest: "", qed64: null }).toEqual({ ...fromCommit, digest: "", qed64: null });

    // Same artifacts released from another qed64 commit: new release, same set.
    const base = treeSource(treeOpts());
    const later: ReleaseSource = { ...base, describe: (inputs) => ({ ...base.describe(inputs), commit: "0123456789abcdef0123456789abcdef01234567" }) };
    const moved = buildReleaseManifest(later);
    expect(moved.releaseId).toBe("qed64-0123456");
    expect(moved.artifactSetId).toBe(fromCommit.artifactSetId);
    expect(moved.digest).not.toBe(fromTree.digest);
    expect(moved.digest).toBe(manifestDigest(moved));
  });

  test("moves when any artifact digest moves (and the tree reports dirty)", () => {
    const before = buildReleaseManifest(commitSource("HEAD"));
    // A snapshot (site-owned: a runtime chunk that moves must move in the pinned record too, see the hosting checks).
    doctored("public/snapshots/index.json", editJson((si) => {
      const e = si.snapshots[0];
      const fresh = "f".repeat(64);
      e.url = e.url.replace(/\.[0-9a-f]{16}\.snapz$/, `.${fresh.slice(0, 16)}.snapz`);
      e.digest = `sha256:${fresh}`;
    }), () => {
      const after = buildReleaseManifest(treeSource(treeOpts()));
      expect(after.qed64.dirty).toBe(true);
      expect(after.artifactSetId).not.toBe(before.artifactSetId);
      expect(after.artifactSetId).toBe(artifactSetIdOf(after));
    });
  });
});

describe.skipIf(!hasGit)("cross-checks refuse doctored inputs", () => {
  const build = () => buildReleaseManifest(treeSource(treeOpts()));

  test("the pristine copy passes (the fixture is sound)", () => {
    expect(build().runtime.buildId).toBe(buildId);
  });

  test("sourceRevision built from another kernel commit than the record's kernel.commit", () => {
    doctored("public/runtime/runtime-manifest.json", editJson((rt) => { rt.sourceRevision = "qed64-wasm64@deadbeef00 (somewhere else)"; }), () => {
      expect(refusal(build)).toMatch(/was built from kernel deadbeef00 \(sourceRevision\), lean-v\S+ names kernel [0-9a-f]{12} — the record and the served binary disagree/);
    });
    doctored("public/runtime/runtime-manifest.json", editJson((rt) => { rt.sourceRevision = "local build"; }), () => {
      expect(refusal(build)).toMatch(/sourceRevision "local build" names no kernel commit/);
    });
    // The record moves to another kernel commit (re-cut, so its own digest holds).
    doctored(RECORD, editRecord((r) => { r.kernel.commit = "0".repeat(40); }), () => {
      expect(refusal(build)).toMatch(/names kernel 000000000000 — the record and the served binary disagree/);
    });
  });

  test("the toolchain record: schema, its own digest, the fields read", () => {
    doctored(RECORD, editJson((r) => { r.schema = "lean4-wasm64.release/v0"; }), () => {
      expect(refusal(build)).toMatch(/toolchain\/lean4-wasm64-release\.json: schema is "lean4-wasm64\.release\/v0", expected lean4-wasm64\.release\/v1/);
    });
    // Edited without re-cutting the digest: the record is no longer the one the release published.
    doctored(RECORD, editJson((r) => { r.kernel.patch = "0099"; }), () => {
      expect(refusal(build)).toMatch(/digest sha256:[0-9a-f]+… is not its own content's sha256:[0-9a-f]+… — the record was edited after it was cut/);
    });
    // Whitespace alone changes nothing the digest covers (2-space JSON of the parsed record), and the build passes.
    doctored(RECORD, (t) => JSON.stringify(JSON.parse(t)), () => { expect(build().toolchain.digest).toMatch(/^sha256:/); });
    doctored(RECORD, editRecord((r) => { r.kernel.patch = "35b"; }), () => { expect(refusal(build)).toMatch(/kernel\.patch "35b" is malformed/); });
    doctored(RECORD, editRecord((r) => { r.kernel.branch = "master"; }), () => {
      expect(refusal(build)).toMatch(/kernel is master @ https:\/\/github\.com\/FawadHa1der\/lean4, this generator records qed64-wasm64 @ FawadHa1der\/lean4/);
    });
    doctored(RECORD, editRecord((r) => { r.id = "lean-v4.34.0/../x"; }), () => { expect(refusal(build)).toMatch(/: id "lean-v4\.34\.0\/\.\.\/x" is malformed/); });
    doctored(RECORD, editRecord((r) => { r.hosting.mount = { "/runtime/": "rt/", "/profiles/": "profiles/" }; }), () => {
      expect(refusal(build)).toMatch(/hosting\.mount .* is not .*the mounts this generator's hosting rule describes/);
    });
    doctored(RECORD, editRecord((r) => { delete r.tools.tgz; }), () => { expect(refusal(build)).toMatch(/tools\.tgz undefined is malformed/); });
  });

  test("a record that names another runtime than the served buildId", () => {
    doctored(RECORD, editRecord((r) => { r.runtime.buildId = OTHER_ID; }), () => {
      expect(refusal(build)).toMatch(new RegExp(`names runtime ${OTHER_ID}, the served runtime is ${buildId}`));
    });
  });

  test("a served runtime or profile manifest that is not the record's file (the hosting rule stores it under the release prefix)", () => {
    doctored(RECORD, editRecord((r) => { r.files.find((f: any) => f.path === "runtime/runtime-manifest.json").sha256 = "e".repeat(64); }), () => {
      expect(refusal(build)).toMatch(/the served runtime manifest runtime\/runtime-manifest\.json is [0-9a-f]{16}… \(\d+ B\), lean-v\S+'s files say eeeeeeeeeeeeeeee… .* — the served tree and the pinned record disagree/);
    });
    const first = json(fs.readFileSync(treeFile("public/profiles/index.json"))).profiles[0];
    const manifest = first.manifest.slice(1);
    doctored(RECORD, editRecord((r) => { r.files.find((f: any) => f.path === manifest).bytes += 1; }), () => {
      expect(refusal(build)).toMatch(new RegExp(`the served profile ${first.id} manifest ${manifest.replace(/\./g, "\\.")} is .*'s files say`));
    });
    doctored(RECORD, editRecord((r) => { r.files = r.files.filter((f: any) => f.path !== manifest); }), () => {
      expect(refusal(build)).toMatch(new RegExp(`${manifest.replace(/\./g, "\\.")} is not in lean-v\\S+'s files, but the hosting rule stores it under lean4-wasm64/`));
    });
    // A chunk the record does not carry, and profiles/index.json made toolchain-hosted (no longer site-owned).
    doctored(RECORD, editRecord((r) => { r.files = r.files.filter((f: any) => !f.path.startsWith("runtime/chunks/lean.wasm.")); }), () => {
      expect(refusal(build)).toMatch(/runtime lean\.wasm chunk runtime\/chunks\/lean\.wasm\.\S+ is not in/);
    });
    // The per-build runtime manifest (the pinned shell fetches it first, from the release prefix):
    // the record must carry it with the default one's bytes, and an absent entry is refused too.
    const perBuild = `runtime/runtime-manifest.${buildId}.json`;
    doctored(RECORD, editRecord((r) => { r.files.find((f: any) => f.path === perBuild).sha256 = "e".repeat(64); }), () => {
      expect(refusal(build)).toMatch(/the per-build runtime manifest .* runtime\/runtime-manifest\.wasm64-[0-9a-f]{16}\.json is [0-9a-f]{16}… .*'s files say eeeeeeeeeeeeeeee… .* — the served tree and the pinned record disagree/);
    });
    doctored(RECORD, editRecord((r) => { r.files = r.files.filter((f: any) => f.path !== perBuild); }), () => {
      expect(refusal(build)).toMatch(/the per-build runtime manifest .* runtime\/runtime-manifest\.wasm64-[0-9a-f]{16}\.json is not in lean-v\S+'s files/);
    });
    // A pack part the record does not carry, or carries with other bytes.
    const part = json(fs.readFileSync(treeFile(`public${first.manifest}`))).content.pack.transport.parts[0].url.slice(1);
    doctored(RECORD, editRecord((r) => { r.files = r.files.filter((f: any) => f.path !== part); }), () => {
      expect(refusal(build)).toMatch(new RegExp(`profile ${first.id} part ${part.replace(/\./g, "\\.")} is not in lean-v\\S+'s files`));
    });
    doctored(RECORD, editRecord((r) => { r.files.find((f: any) => f.path === part).bytes += 1; }), () => {
      expect(refusal(build)).toMatch(new RegExp(`profile ${first.id} part ${part.replace(/\./g, "\\.")} is .*'s files say`));
    });
    doctored(RECORD, editRecord((r) => { r.hosting.siteOwned = ["/snapshots/"]; }), () => {
      expect(refusal(build)).toMatch(/the profile index profiles\/index\.json is not in lean-v\S+'s files/);
    });
  });

  test("base-tree.json: schema, the release it names, the served packs, the umbrella", () => {
    const editBt = (fn: (o: any) => void) => editJson(fn);
    const Z = (c: string) => `sha256:${c.repeat(64)}`;
    doctored(BASE_TREE, editBt((o) => { o.schema = "qed64.base-tree/v0"; }), () => { expect(refusal(build)).toMatch(/embedding\/base-tree\.json: schema is "qed64\.base-tree\/v0"/); });
    // The pristine file names the record's own release: its digest and runtime are the record's.
    const ok = build().baseTree;
    const rec = json(fs.readFileSync(treeFile(RECORD)));
    expect([ok.releaseId, ok.releaseDigest, ok.runtime]).toEqual([rec.id, rec.digest, rec.runtime.buildId]);
    // Another release whose packs are the same raw bytes: accepted (a runtime-only release keeps the trees),
    // and its digest and runtime, which the record cannot vouch for, are recorded as null.
    doctored(BASE_TREE, editBt((o) => { o.releaseId = "lean-v4.34.0-0000000"; o.releaseDigest = Z("9"); o.runtime = OTHER_ID; }), () => {
      const bt = build().baseTree;
      expect([bt.releaseId, bt.releaseDigest, bt.runtime]).toEqual(["lean-v4.34.0-0000000", null, null]);
    });
    // Another release with other packs: refused.
    doctored(BASE_TREE, editBt((o) => { o.releaseId = "lean-v4.34.0-0000000"; o.trees["core-lib-slim"].packs[0].rawSha256 = Z("1"); }), () => {
      expect(refusal(build)).toMatch(/embedding\/base-tree\.json \(release lean-v4\.34\.0-0000000\): trees\.core-lib-slim\.packs names lean-lib raw 1111111111111111…, the record lean-v\S+ carries [0-9a-f]{16}…/);
    });
    // The SAME release: every pack, at the top and in every tree, is still checked against the record.
    doctored(BASE_TREE, editBt((o) => { o.trees["core-lib-slim"].packs[0].rawSha256 = Z("0"); }), () => {
      expect(refusal(build)).toMatch(/\(release lean-v\S+\): trees\.core-lib-slim\.packs names lean-lib raw 0000000000000000…, the record lean-v\S+ carries/);
    });
    doctored(BASE_TREE, editBt((o) => { o.trees["lib-tree-slim"].packs[1].rawSha256 = Z("0"); }), () => {
      expect(refusal(build)).toMatch(/: trees\.lib-tree-slim\.packs names mathlib-essential raw 0000000000000000…, the record lean-v\S+ carries/);
    });
    doctored(BASE_TREE, editBt((o) => { o.packs[1].rawSha256 = Z("2"); }), () => {
      expect(refusal(build)).toMatch(/: packs names mathlib-essential raw 2222222222222222…, the record lean-v\S+ carries/);
    });
    doctored(BASE_TREE, editBt((o) => { o.trees["lib-tree"].packs.push({ id: "mathlib-bogus", rawSha256: Z("4") }); }), () => {
      expect(refusal(build)).toMatch(/: trees\.lib-tree\.packs names mathlib-bogus, which lean-v\S+ does not carry/);
    });
    doctored(BASE_TREE, editBt((o) => { o.trees["lib-tree-slim"].packs[0].release = "lean-core-4.99.0-wasm64-0000000000000000"; }), () => {
      expect(refusal(build)).toMatch(/: trees\.lib-tree-slim\.packs lean-core is release lean-core-4\.99\.0-wasm64-0000000000000000, lean-v\S+ carries lean-core-/);
    });
    // The same release with another releaseDigest or runtime.
    doctored(BASE_TREE, editBt((o) => { o.releaseDigest = Z("5"); }), () => {
      expect(refusal(build)).toMatch(/: releaseDigest sha256:5555555555555555… is not lean-v\S+'s sha256:[0-9a-f]{16}…/);
    });
    doctored(BASE_TREE, editBt((o) => { o.runtime = OTHER_ID; }), () => {
      expect(refusal(build)).toMatch(new RegExp(`: runtime "${OTHER_ID}" is not lean-v\\S+'s ${buildId}`));
    });
    // The top-level packs are exactly the served packs: a record pack that is not served, one served pack missing.
    const game = rec.packs.find((p: any) => p.id === "mathlib-game-extra");
    doctored(BASE_TREE, editBt((o) => { o.packs[1] = { id: game.id, rawSha256: `sha256:${game.rawSha256}` }; }), () => {
      expect(refusal(build)).toMatch(/: the base trees were unpacked from mathlib-game-extra, which is not served \(the profile index has no profiles\/mathlib-game-extra\.manifest\.json\)/);
    });
    doctored(BASE_TREE, editBt((o) => { o.packs = o.packs.filter((p: any) => p.id !== "mathlib-essential"); }), () => {
      expect(refusal(build)).toMatch(/: packs does not list mathlib-essential, a served pack/);
    });
    // Every tree but core-lib-slim carries the umbrella pair.
    doctored(BASE_TREE, editBt((o) => { o.trees["lib-tree-slim"].umbrella = []; }), () => {
      expect(refusal(build)).toMatch(/: trees\.lib-tree-slim\.umbrella does not list QED64\/Essential\.olean \(every tree but core-lib-slim carries the pair\)/);
    });
    doctored(BASE_TREE, editBt((o) => { o.trees["lib-tree"].umbrella = o.trees["lib-tree"].umbrella.filter((u: any) => !u.path.endsWith(".server")); }), () => {
      expect(refusal(build)).toMatch(/: trees\.lib-tree\.umbrella does not list QED64\/Essential\.olean\.server/);
    });
    doctored(BASE_TREE, editBt((o) => { o.umbrella = o.umbrella.filter((u: any) => !u.path.endsWith(".server")); }), () => {
      expect(refusal(build)).toMatch(/umbrella does not list QED64\/Essential\.olean\.server/);
    });
    doctored(BASE_TREE, editBt((o) => { o.trees["lib-tree-slim"].umbrella[0].sha256 = "3".repeat(64); }), () => {
      expect(refusal(build)).toMatch(/QED64\/Essential\.olean is listed with two contents/);
    });
    doctored(BASE_TREE, editBt((o) => { o.umbrella[0].path = "../Essential.olean"; }), () => { expect(refusal(build)).toMatch(/umbrella\[\] .* is malformed/); });
  });

  test("--repo names the checkout: a directory that is not one refuses (the shipped copy reads a QED64 clone)", () => {
    const r = run(["--repo", tmp, "--commit", "HEAD"], tmp);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`^release-manifest: REFUSED: HEAD is not a commit in ${tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const ok = run(["--repo", root, "--commit", "HEAD"], tmp);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(run(["--commit", "HEAD"]).stdout);
  });

  test("a snapshot paired with another runtime", () => {
    doctored("public/snapshots/index.json", editJson((o) => { o.snapshots.at(-1).runtime = OTHER_ID; }), () => {
      expect(refusal(build)).toMatch(new RegExp(`snapshot \\S+ is paired with runtime ${OTHER_ID}, the served runtime is ${buildId}`));
    });
    doctored("public/snapshots/index.json", editJson((o) => { delete o.snapshots[0].runtime; }), () => {
      expect(refusal(build)).toMatch(/is paired with runtime \(none recorded\)/);
    });
  });

  test("a profile index paired with another runtime or Lean version", () => {
    doctored("public/profiles/index.json", editJson((o) => { o.runtime.buildId = OTHER_ID; }), () => {
      expect(refusal(build)).toMatch(new RegExp(`profiles/index.json is paired with runtime ${OTHER_ID}`));
    });
    doctored("public/profiles/index.json", editJson((o) => { o.runtime.leanVersion = "4.99.0"; }), () => {
      expect(refusal(build)).toMatch(/profiles\/index.json says Lean 4\.99\.0/);
    });
  });

  test("a pack built for another Lean version (digest correctly re-derived)", () => {
    const pi = json(fs.readFileSync(path.join(tree, "public/profiles/index.json")));
    const first = pi.profiles[0];
    doctored(`public${first.manifest}`, editJson((pm) => {
      pm.content.lean.version = "4.99.0";
      pm.digest = `sha256:${sha(JSON.stringify(pm.content))}`;
    }), () => {
      expect(refusal(build)).toMatch(new RegExp(`profile ${first.id} was packed for Lean 4\\.99\\.0, the served runtime is Lean `));
    });
  });

  test("a pack manifest edited without re-deriving pack.mjs's content digest", () => {
    const first = json(fs.readFileSync(path.join(tree, "public/profiles/index.json"))).profiles[0];
    doctored(`public${first.manifest}`, editJson((pm) => { pm.content.roots = [...pm.content.roots, "Extra"]; }), () => {
      expect(refusal(build)).toMatch(/manifest digest sha256:[0-9a-f]+… is not its content's/);
    });
  });

  test("a part that is not content-addressed, and parts that do not add up", () => {
    const first = json(fs.readFileSync(path.join(tree, "public/profiles/index.json"))).profiles[0];
    const redigest = (fn: (pm: any) => void) => editJson((pm) => { fn(pm); pm.digest = `sha256:${sha(JSON.stringify(pm.content))}`; });
    doctored(`public${first.manifest}`, redigest((pm) => { pm.content.pack.transport.parts[0].url = "/profiles/renamed.part-000"; }), () => {
      expect(refusal(build)).toMatch(/not content-addressed/);
    });
    doctored(`public${first.manifest}`, redigest((pm) => { pm.content.pack.transport.byteLength += 1; }), () => {
      expect(refusal(build)).toMatch(/parts sum to \d+ bytes, the transport says \d+/);
    });
  });

  test("a per-build runtime manifest that is not byte-identical to the default one", () => {
    const pinned = path.join(tree, `public/runtime/runtime-manifest.${buildId}.json`);
    const original = fs.readFileSync(path.join(tree, "public/runtime/runtime-manifest.json"));
    try {
      fs.writeFileSync(pinned, original);
      expect(build().runtime.buildId).toBe(buildId); // identical: fine (and not an input: still clean)
      expect(build().qed64.dirty).toBe(false);
      fs.writeFileSync(pinned, `${original.toString()} `);
      expect(refusal(build)).toMatch(new RegExp(`runtime-manifest\\.${buildId}\\.json is not byte-identical to public/runtime/runtime-manifest\\.json`));
    } finally {
      fs.rmSync(pinned, { force: true });
    }
  });

  test("a per-build index copy (HARDENING #64) that is not byte-identical to the index it copies", () => {
    for (const [copyPath, of] of [
      [`public/snapshots/index.${buildId}.json`, "public/snapshots/index.json"],
      [`public/snapshots/profiles-index.${buildId}.json`, "public/profiles/index.json"],
    ] as const) {
      const copy = path.join(tree, copyPath);
      const original = fs.readFileSync(path.join(tree, of));
      const before = build();
      try {
        fs.writeFileSync(copy, original);
        const m = build();
        expect(m.qed64.dirty).toBe(false); // identical: fine, and neither an input nor listed
        expect(m.artifactSetId).toBe(before.artifactSetId);
        fs.writeFileSync(copy, `${original.toString()} `);
        expect(refusal(build)).toBe(`${copyPath} is not byte-identical to ${of} — the pinned shell would read another pairing's index; rerun the promote (or delete the copy: the upload sends ${of}'s bytes under that name)`);
      } finally {
        fs.rmSync(copy, { force: true });
      }
    }
  });
});

describe.skipIf(!hasGit)("--dist: the shell section", () => {
  let dist: string;
  /** A minimal vite-shaped dist built "from HEAD": workers verbatim, the main
   * bundle pinning `pins`. */
  function makeDist(pins: string | null) {
    dist = path.join(tmp, `dist-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"),
      '<!doctype html>\n<script type="module" crossorigin src="/assets/index-T3st.js"></script>\n<link rel="stylesheet" href="/assets/app.css">\n');
    fs.writeFileSync(path.join(dist, "assets/index-T3st.js"), `const paired = ${JSON.stringify(pins ?? "")};\nexport default paired;\n`);
    fs.writeFileSync(path.join(dist, "assets/app.css"), "body { margin: 0 }\n");
    for (const p of inputPaths.filter((q) => q.startsWith("public/workers/"))) {
      const to = path.join(dist, p.slice("public/".length));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, atHead(p));
    }
    return dist;
  }
  /** The listing recomputed independently: what `shasum -a 256` prints over
   * the byte-sorted file list. */
  function independentListing(dir: string) {
    const walk = (rel: string): string[] => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.posix.join(rel, e.name)) : [path.posix.join(rel, e.name)]));
    return walk("").sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map((rel) => `${sha(fs.readFileSync(path.join(dir, rel)))}  ${rel}\n`).join("");
  }
  const withDist = (d: string) => () => buildReleaseManifest(commitSource("HEAD"), { dist: d });

  test("describes the shell: listing digest, shellId, the pinned runtime; outside the artifact set", () => {
    const d = makeDist(buildId);
    const plain = buildReleaseManifest(commitSource("HEAD"));
    const m = withDist(d)();
    const listing = independentListing(d);
    expect(m.shell!.listingSha256).toBe(sha(listing));
    expect(listingOf(m.shell!.files)).toBe(listing);
    expect(m.shell!.shellId).toBe(`shell-${sha(listing).slice(0, 16)}`);
    expect(m.shell!.bundle).toEqual({ entries: ["assets/index-T3st.js"], buildIds: [buildId] });
    expect(m.shell!.bytes).toBe(m.shell!.files.reduce((n, f) => n + f.bytes, 0));
    expect(m.artifactSetId).toBe(plain.artifactSetId);
    expect(m.digest).not.toBe(plain.digest);
    expect(m.digest).toBe(manifestDigest(m));

    // CLI round trip, and --check needs the same --dist to match.
    const file = path.join(tmp, "with-shell.json");
    const r = run(["--commit", "HEAD", "--dist", d, "--out", file]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`, ${m.shell!.shellId} → `));
    expect(fs.readFileSync(file, "utf8")).toBe(serializeManifest(m));
    expect(run(["--check", file, "--dist", d]).status).toBe(0);
    const noDist = run(["--check", file]);
    expect(noDist.status).toBe(1);
    expect(noDist.stderr).toMatch(/pass --dist <dir>/);
  });

  test("dist/qed64-build.json names the shell: excluded from the listing, refused when it disagrees (frontend/build/build-info.mjs)", async () => {
    const { shellIdOf } = await import("../../frontend/build/build-info.mjs" as string) as { shellIdOf(dir: string): string };
    const d = makeDist(buildId);
    const before = withDist(d)();
    const info = (shell: string, id = buildId) => fs.writeFileSync(path.join(d, "qed64-build.json"), JSON.stringify({ schema: "qed64.build/v1", buildId: id, shell }));
    expect(shellIdOf(d)).toBe(before.shell!.shellId); // the build plugin and the manifest compute one id
    info(before.shell!.shellId);
    const m = withDist(d)();
    expect(m.shell!.shellId).toBe(before.shell!.shellId);
    expect(m.shell!.files.some((f) => f.path === "qed64-build.json")).toBe(false);
    expect(before.shell).toMatchObject({ apiRevision: null, embedApiRevision: null }); // no build-info file: unknown
    expect(m.shell).toMatchObject({ apiRevision: null, embedApiRevision: null }); // a file without the keys: unknown
    // The two revisions the build stamps (page API, qed64/embed barrel) are recorded, in this key order.
    fs.writeFileSync(path.join(d, "qed64-build.json"), JSON.stringify({ schema: "qed64.build/v1", buildId, shell: before.shell!.shellId, apiRevision: "1.2.3", embedApiRevision: "4.5.6-pre.7" }));
    const stamped = withDist(d)();
    expect(Object.keys(stamped.shell!)).toEqual(["shellId", "listingSha256", "bytes", "apiRevision", "embedApiRevision", "bundle", "files"]);
    expect(stamped.shell).toMatchObject({ shellId: before.shell!.shellId, apiRevision: "1.2.3", embedApiRevision: "4.5.6-pre.7" });
    fs.writeFileSync(path.join(d, "qed64-build.json"), JSON.stringify({ schema: "qed64.build/v1", buildId, shell: before.shell!.shellId, apiRevision: 7 }));
    expect(refusal(withDist(d))).toMatch(/qed64-build\.json apiRevision 7 is not a revision string/);
    info("shell-0000000000000000");
    expect(refusal(withDist(d))).toMatch(/qed64-build\.json names shell-0000000000000000, the tree is shell-/);
    info(before.shell!.shellId, OTHER_ID);
    expect(refusal(withDist(d))).toMatch(new RegExp(`qed64-build\\.json pairs runtime ${OTHER_ID}`));
  });

  test("a worker that is not the commit's public/workers/*", () => {
    const d = makeDist(buildId);
    const worker = fs.readdirSync(path.join(d, "workers")).sort()[0]!;
    fs.appendFileSync(path.join(d, "workers", worker), "\n// edited after the build\n");
    expect(refusal(withDist(d))).toMatch(new RegExp(`workers/${worker.replace(/\./g, "\\.")} differs from commit [0-9a-f]{7}'s public/workers/`));

    const extra = makeDist(buildId);
    fs.writeFileSync(path.join(extra, "workers/stray.js"), "1;\n");
    expect(refusal(withDist(extra))).toMatch(/workers\/stray\.js is not in commit [0-9a-f]{7}'s public\/workers/);

    const missing = makeDist(buildId);
    fs.rmSync(path.join(missing, "workers", worker));
    expect(refusal(withDist(missing))).toMatch(/is missing/);
  });

  test("--worktree --dist: a worker the tree edited or lacks is a difference from HEAD (dirty)", () => {
    const fromTree = (d: string) => buildReleaseManifest(treeSource(treeOpts()), { dist: d });
    const d = makeDist(buildId); // workers verbatim from HEAD, as the tree has them
    expect(fromTree(d).qed64.dirty).toBe(false);
    const worker = fs.readdirSync(path.join(d, "workers")).sort()[0]!;
    // Edited in the tree (uncommitted) and built: the shell matches the tree, the tree is not HEAD.
    doctored(`public/workers/${worker}`, (t) => `${t}\n// edited, not committed\n`, () => {
      fs.copyFileSync(treeFile(`public/workers/${worker}`), path.join(d, "workers", worker));
      const m = fromTree(d);
      expect(m.qed64).toMatchObject({ commit: head, source: "worktree", dirty: true });
    });
    // Deleted from the tree and so absent from its build: HEAD still has it.
    const gone = makeDist(buildId);
    const original = fs.readFileSync(treeFile(`public/workers/${worker}`));
    fs.rmSync(treeFile(`public/workers/${worker}`));
    fs.rmSync(path.join(gone, "workers", worker));
    try {
      expect(fromTree(gone).qed64.dirty).toBe(true);
    } finally {
      fs.writeFileSync(treeFile(`public/workers/${worker}`), original);
    }
  });

  test("a bundle that pins another runtime, none, or more than one", () => {
    expect(refusal(withDist(makeDist(OTHER_ID)))).toMatch(new RegExp(`main bundle pins runtime ${OTHER_ID}, expected exactly ${buildId}`));
    expect(refusal(withDist(makeDist(null)))).toMatch(/main bundle pins runtime \(none\)/);
    const both = makeDist(buildId);
    fs.appendFileSync(path.join(both, "assets/index-T3st.js"), `const fallback = "${OTHER_ID}";\n`);
    expect(refusal(withDist(both))).toMatch(/main bundle pins runtime wasm64-/);
    const stray = makeDist(buildId);
    fs.writeFileSync(path.join(stray, "assets/lazy-chunk.js"), `export const old = "${OTHER_ID}";\n`);
    expect(refusal(withDist(stray))).toMatch(new RegExp(`assets/lazy-chunk\\.js embeds runtime ${OTHER_ID}`));
  });

  test("an artifact directory in the shell, or no main bundle", () => {
    const bundled = makeDist(buildId);
    fs.mkdirSync(path.join(bundled, "runtime/chunks"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "runtime/chunks/x.part-000"), "x");
    expect(refusal(withDist(bundled))).toMatch(/contains runtime\/ — artifacts are served from R2/);

    const noEntry = makeDist(buildId);
    fs.writeFileSync(path.join(noEntry, "index.html"), "<!doctype html><p>static</p>\n");
    expect(refusal(withDist(noEntry))).toMatch(/loads no module script/);

    expect(refusal(withDist(path.join(tmp, "no-such-dist")))).toMatch(/is not a directory/);
  });
});

// The build half: frontend/build/build-info.mjs inside real Vite builds (the
// root's vite; the frontend's calls the same Rollup hooks) of a one-module
// project. Rollup runs closeBundle for a FAILED build too — with the error
// after a failed build phase, and with none from Vite's `finally {
// bundle.close() }` after a failed write — so a stamp written there described
// a stale or half-written dist/, or threw ENOENT over the real error.
describe.skipIf(!hasGit)("frontend/build/build-info.mjs: dist/qed64-build.json only for a build that wrote dist/", () => {
  let work: string;
  beforeAll(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-build-info-")); });
  afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });
  const fixes = () => import("../../frontend/build/lean4monaco-fixes.mjs" as string) as Promise<{
    lean4monacoFixesVite(): Plugin; patchWebviewJs(webviewJs: string, rpcJs: string): string;
  }>;

  /** Build `<work>/<name>`, whose entry is a lean4monaco infowebview.js (the
   * real page-half transform applies to it), with build-info wired as
   * frontend/vite.config.ts wires it, then `extra`. */
  async function viteBuild(name: string, entry: string, extra: (dist: string) => Plugin[], seed?: (dist: string) => void) {
    const dir = path.join(work, name);
    const input = path.join(dir, "lean4monaco/dist/infowebview.js");
    fs.mkdirSync(path.dirname(input), { recursive: true });
    fs.writeFileSync(input, entry);
    fs.writeFileSync(path.join(dir, "runtime-manifest.json"), JSON.stringify({ buildId, leanVersion: "9.9.9", sourceRevision: "test" }));
    fs.writeFileSync(path.join(dir, "page-api.ts"), 'export const API_REVISION = "1.2.3";\n');
    fs.writeFileSync(path.join(dir, "embed-index.ts"), 'export const EMBED_API_REVISION = "4.5.6-pre.7";\n');
    const dist = path.join(dir, "dist");
    seed?.(dist);
    const { buildInfoPlugin } = await import("../../frontend/build/build-info.mjs" as string) as { buildInfoPlugin(o: object): Plugin };
    const { build } = await import("vite");
    const run = build({
      configFile: false, root: dir, logLevel: "silent", publicDir: false,
      build: { outDir: dist, emptyOutDir: true, minify: false, rollupOptions: { input } },
      plugins: [
        (await fixes()).lean4monacoFixesVite(),
        buildInfoPlugin({ manifestUrl: pathToFileURL(path.join(dir, "runtime-manifest.json")), pageApiUrl: pathToFileURL(path.join(dir, "page-api.ts")), embedApiUrl: pathToFileURL(path.join(dir, "embed-index.ts")), repoDir: dir }),
        ...extra(dist),
      ],
    });
    return { dist, stamp: path.join(dist, "qed64-build.json"), run };
  }
  const REGISTERED = "rpc.register(editorApiOfRpc(editorRpcApi));\nexport {};\n"; // the anchor the page half patches
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("the lean4monaco tripwire in the build phase is the error Vite reports, and nothing is stamped", async () => {
    const fresh = await viteBuild("tripwire-fresh", "rpc.register(api);\n", () => []);
    await expect(fresh.run).rejects.toThrow(/infowebview\.js register: anchor not found \(lean4monaco changed\?\)/);
    expect(fs.existsSync(fresh.dist)).toBe(false);
    // A previous build's dist/ keeps its own stamp, not one for the failed build.
    const old = await viteBuild("tripwire-old", "rpc.register(api);\n", () => [], (dist) => {
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(dist, "old.js"), "export const previous = 1;\n");
      fs.writeFileSync(path.join(dist, "qed64-build.json"), "the previous build's stamp\n");
    });
    await expect(old.run).rejects.toThrow(/anchor not found/);
    expect(fs.readFileSync(old.stamp, "utf8")).toBe("the previous build's stamp\n");
  });

  test("a failed write (a static-copy transform throwing in writeBundle) leaves no stamp", async () => {
    const b = await viteBuild("failed-write", REGISTERED, () => [{
      name: "static-copy-stand-in",
      async writeBundle() { await sleep(5); (await fixes()).patchWebviewJs("const a=x;", "export function editorApiOfRpc(api) { return api; }"); },
    }]);
    await expect(b.run).rejects.toThrow(/webview\.js editor API: anchor not found/);
    expect(fs.readdirSync(path.join(b.dist, "assets")).length).toBeGreaterThan(0); // Rollup did write the bundle
    expect(fs.existsSync(b.stamp)).toBe(false);
  });

  test("a good build is stamped after every other writeBundle: the shell id covers the copied files", async () => {
    const { shellIdOf } = await import("../../frontend/build/build-info.mjs" as string) as { shellIdOf(dir: string): string };
    const b = await viteBuild("good", REGISTERED, (dist) => [{
      name: "static-copy-stand-in",
      async writeBundle() {
        await sleep(20);
        fs.mkdirSync(path.join(dist, "workers"), { recursive: true });
        fs.writeFileSync(path.join(dist, "workers/lean.worker.js"), "// copied after the bundle\n");
      },
    }]);
    await b.run;
    const info = JSON.parse(fs.readFileSync(b.stamp, "utf8"));
    expect(info).toMatchObject({ schema: "qed64.build/v1", buildId, leanVersion: "9.9.9", sourceRevision: "test", apiRevision: "1.2.3", embedApiRevision: "4.5.6-pre.7" });
    expect(fs.readFileSync(path.join(b.dist, "workers/lean.worker.js"), "utf8")).toContain("copied");
    expect(info.shell).toBe(shellIdOf(b.dist));
  });

  // frontend/vite.config.ts itself, loaded by Node (as Vite's loader does, with
  // import.meta.url the file's URL) from a checkout whose path has a space:
  // its repoDir must reach git as that directory (URL.pathname handed git
  // "Lean%20Projects", and commit/dirty read null).
  test.skipIf(!fs.existsSync(path.join(root, "frontend/node_modules/vite")))("frontend/vite.config.ts names the commit of a checkout under a path with a space", async () => {
    const checkout = path.join(work, "Lean Projects", "QED64");
    const frontend = path.join(checkout, "frontend");
    fs.mkdirSync(path.join(checkout, "public/runtime"), { recursive: true });
    fs.mkdirSync(frontend, { recursive: true });
    for (const f of ["vite.config.ts", "package.json"]) fs.copyFileSync(path.join(root, "frontend", f), path.join(frontend, f));
    fs.copyFileSync(path.join(root, "public/runtime/runtime-manifest.json"), path.join(checkout, "public/runtime/runtime-manifest.json"));
    for (const d of ["build", "src", "node_modules"]) fs.symlinkSync(path.join(root, "frontend", d), path.join(frontend, d));
    fs.symlinkSync(path.join(root, "lib"), path.join(checkout, "lib")); // the barrel the config reads EMBED_API_REVISION from
    const g = (...args: string[]) => spawnSync("git", args, { cwd: checkout, encoding: "utf8" });
    g("init", "-q");
    g("add", "frontend/vite.config.ts", "public/runtime/runtime-manifest.json");
    g("-c", "user.name=qed64-test", "-c", "user.email=test@qed64.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "a checkout under a space");
    const commit = g("rev-parse", "HEAD").stdout.trim();
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    fs.mkdirSync(path.join(checkout, "dist"));
    fs.writeFileSync(path.join(checkout, "dist/index.html"), "<!doctype html>\n");
    const probe = [
      'import { pathToFileURL } from "node:url";',
      'const [file, root] = process.argv.slice(1);',
      'const config = (await import(pathToFileURL(file).href)).default({ command: "build", mode: "production" });',
      'const plugin = config.plugins.flat().find((p) => p?.name === "qed64-build-info");',
      'plugin.configResolved({ root, build: config.build });',
      'plugin.writeBundle.handler();',
    ].join("\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe, path.join(frontend, "vite.config.ts"), frontend], { encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const info = JSON.parse(fs.readFileSync(path.join(checkout, "dist/qed64-build.json"), "utf8"));
    expect(info).toMatchObject({ commit, dirty: false, buildId });
    // vite.config.ts wires the barrel's revision (lib/index.ts) into the stamp.
    const barrel = fs.readFileSync(path.join(root, "lib/index.ts"), "utf8");
    expect(info.embedApiRevision).toBe(/export const EMBED_API_REVISION = "([^"]+)"/.exec(barrel)?.[1]);
    expect(info.embedApiRevision).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});
