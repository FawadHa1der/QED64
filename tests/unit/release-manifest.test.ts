// The release manifest (pipeline/release/release-manifest.mjs,
// docs/RELEASE-BUNDLE.md): generated for the CURRENT HEAD from git objects
// only (no network, no artifact bytes), byte-deterministic, self-verifying
// (digest, artifactSetId, shellId recomputed here the way a downstream
// would), and refusing every pairing fact it is meant to guard. The doctored
// inputs live in a temp copy of HEAD's tracked manifests; nothing here
// touches public/, work/ or dist/ of the repo.
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ReleaseRefusal,
  artifactSetIdOf,
  buildReleaseManifest,
  commitSource,
  listingOf,
  manifestDigest,
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
let tree: string; // a doctorable copy of HEAD's tracked inputs: <tree>/KERNEL-PIN, <tree>/public/...
let head: string;
let buildId: string;
let inputPaths: string[];
const treeOpts = () => ({ publicDir: path.join(tree, "public"), kernelPin: path.join(tree, "KERNEL-PIN") });
const treeFile = (repoPath: string) =>
  repoPath === "pipeline/toolchain/KERNEL-PIN" ? path.join(tree, "KERNEL-PIN") : path.join(tree, repoPath);

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
  ];
  for (const p of inputPaths) {
    fs.mkdirSync(path.dirname(path.join(tree, p)), { recursive: true });
    fs.writeFileSync(path.join(tree, p), atHead(p));
  }
  fs.writeFileSync(path.join(tree, "KERNEL-PIN"), atHead("pipeline/toolchain/KERNEL-PIN"));
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
    for (const args of [["--bogus"], ["--commit"], ["--commit", "HEAD", "--worktree"], ["--out", "a", "--check", "b"], ["--public", "x"]]) {
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
    expect(Object.keys(m)).toEqual(["schema", "digest", "releaseId", "artifactSetId", "qed64", "lean", "kernel", "runtime", "snapshots", "profiles", "shell"]);
    expect(m.schema).toBe("qed64.release/v1");
    expect(m.releaseId).toBe(`qed64-${head.slice(0, 7)}`);
    const seconds = Number(git("show", "-s", "--format=%ct", "HEAD").stdout.toString().trim());
    expect(m.qed64).toEqual({
      repo: "FawadHa1der/QED64", commit: head, committedAt: new Date(seconds * 1000).toISOString().replace(".000Z", "Z"), source: "commit", dirty: false,
    });

    const rtBytes = atHead("public/runtime/runtime-manifest.json");
    const rt = json(rtBytes);
    const pin = atHead("pipeline/toolchain/KERNEL-PIN").toString();
    expect(m.lean).toEqual({ version: rt.leanVersion, target: rt.target });
    expect(m.kernel).toEqual({ repo: "FawadHa1der/lean4", branch: "qed64-wasm64", commit: pin.split(/\s/)[0], sourceRevision: rt.sourceRevision });
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
  });

  test("a refusal is exit 1, one line on stderr, and no output file", () => {
    doctored("public/snapshots/index.json", editJson((o) => { o.snapshots[0].runtime = OTHER_ID; }), () => {
      const out = path.join(tmp, "refused.json");
      const r = run(["--worktree", "--public", path.join(tree, "public"), "--kernel-pin", path.join(tree, "KERNEL-PIN"), "--out", out]);
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
    doctored("public/runtime/runtime-manifest.json", editJson((rt) => {
      const file = rt.files[Object.keys(rt.files)[0]!];
      const fresh = "f".repeat(64);
      file.chunks[0].url = file.chunks[0].url.replace(/\.[0-9a-f]{20}\.part-/, `.${fresh.slice(0, 20)}.part-`);
      file.chunks[0].sha256 = fresh;
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

  test("sourceRevision built from another kernel commit than KERNEL-PIN", () => {
    doctored("public/runtime/runtime-manifest.json", editJson((rt) => { rt.sourceRevision = "qed64-wasm64@deadbeef00 (somewhere else)"; }), () => {
      expect(refusal(build)).toMatch(/was built from kernel deadbeef00 \(sourceRevision\), KERNEL-PIN pins [0-9a-f]{12}/);
    });
    doctored("public/runtime/runtime-manifest.json", editJson((rt) => { rt.sourceRevision = "local build"; }), () => {
      expect(refusal(build)).toMatch(/sourceRevision "local build" names no kernel commit/);
    });
  });

  test("KERNEL-PIN that does not name the buildId", () => {
    doctored("pipeline/toolchain/KERNEL-PIN", (t) => t.split(buildId).join(OTHER_ID), () => {
      expect(refusal(build)).toMatch(new RegExp(`KERNEL-PIN does not name the served runtime ${buildId}`));
    });
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
