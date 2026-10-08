// Artifact discipline (review C6, migration phase 1): producers never write
// into public/ and never delete what they produced before; promote is
// additive with an atomic manifest switch; the snapshot index carries the
// runtime pairing. These run the REAL scripts as child processes against
// temp trees — the incident they pin (HARDENING #32) was a real invocation.
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInsidePublic, runtimeBuildId } from "../../pipeline/toolchain/artifact-paths.mjs";
import { isImmutable } from "../../infra/worker.js";
import { fetchSnapshotIndex } from "../../lib/snapshots";

const root = path.resolve(__dirname, "../..");
const chunker = path.join(root, "pipeline/toolchain/chunk-runtime.mjs");
const baker = path.join(root, "pipeline/snapshot/bake-snapshot.mjs");
const promote = path.join(root, "pipeline/release/promote-staging.mjs");
const packer = path.join(root, "pipeline/artifacts/pack.mjs");
const verifyRelease = path.join(root, "pipeline/release/verify-release.mjs");
const run = (script: string, args: string[]) =>
  spawnSync("node", [script, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let tmp: string;
/** A FAKE lean4-wasm64 package: its chunk-runtime.mjs prints its argv as JSON and exits 7. */
let fakePkg: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qed64-artifacts-")));
  fakePkg = path.join(tmp, "fake-lean4-wasm64");
  fs.mkdirSync(fakePkg);
  fs.writeFileSync(path.join(fakePkg, "package.json"), JSON.stringify({ name: "lean4-wasm64", version: "0.0.0-fake" }));
  fs.writeFileSync(path.join(fakePkg, "chunk-runtime.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n");
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A fake stage1/bin with distinct lean.js/lean.wasm bytes per tag. */
function fakeBin(tag: string): string {
  const bin = path.join(tmp, `bin-${tag}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "lean.js"), `// glue ${tag}\n`);
  fs.writeFileSync(path.join(bin, "lean.wasm"), Buffer.from(`\0asm${tag}`));
  return bin;
}

/** The staged runtime layout the chunker writes (lean4-wasm64 chunk; its tests own the algorithm):
 * each file as sha256-named parts under <out>/chunks (one part: the fixtures are tiny) and the
 * manifest under both names. */
function stageChunks(bin: string, out: string, leanVersion = "4.33.0-pre") {
  const buildId = runtimeBuildId(fs.readFileSync(path.join(bin, "lean.wasm")));
  fs.mkdirSync(path.join(out, "chunks"), { recursive: true });
  const files: Record<string, unknown> = {};
  for (const name of ["lean.js", "lean.wasm"]) {
    const bytes = fs.readFileSync(path.join(bin, name));
    const digest = sha(bytes);
    const file = `${name}.${digest.slice(0, 20)}.part-000`;
    fs.writeFileSync(path.join(out, "chunks", file), bytes);
    files[name] = { bytes: bytes.length, sha256: digest, chunks: [{ url: `/runtime/chunks/${file}`, bytes: bytes.length, sha256: digest }] };
  }
  const manifest = {
    schema: "org.lean-browser64.runtime/v1", buildId, leanVersion, sourceRevision: "test", target: "wasm64-unknown-emscripten", pointerBits: 64,
    memory: { initialBytes: 134217728, maximumBytes: 17179869184, shared: true }, files,
  };
  fs.writeFileSync(path.join(out, "runtime-manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(out, `runtime-manifest.${buildId}.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe("isInsidePublic", () => {
  test("public/ and everything beneath it, by any spelling", () => {
    expect(isInsidePublic(root, "public")).toBe(true);
    expect(isInsidePublic(root, "public/runtime")).toBe(true);
    expect(isInsidePublic(root, path.join(root, "public/snapshots/../runtime"))).toBe(true);
    expect(isInsidePublic(root, "work/staging/x/runtime")).toBe(false);
    expect(isInsidePublic(root, "public-notreally")).toBe(false);
  });
});

describe("chunk-runtime.mjs (a forward to lean4-wasm64 chunk: QED64 keeps the front half)", () => {
  // The chunking itself is the fork's (its tests pin the manifest bytes); here the package is a
  // FAKE whose chunk-runtime.mjs prints the argv it was handed and exits 7.
  const forwarded = (r: { stdout: string }) => JSON.parse(r.stdout) as string[];
  const DEPRECATED = "chunk-runtime: WARNING — pipeline/toolchain/chunk-runtime.mjs is deprecated; use lean4-wasm64 chunk --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string> (the fork's package) (docs/CLI-CONTRACT.md)";
  const chunk = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("node", [chunker, ...args], { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...process.env, LEAN4_WASM64_DIR: fakePkg, QED64_STAGING: "", ...env } });

  test("refuses --out inside public/ before writing anything (and before the forward)", () => {
    const bin = fakeBin("refuse");
    const before = fs.existsSync(path.join(root, "public/runtime/chunks")) ? fs.readdirSync(path.join(root, "public/runtime/chunks")).length : -1;
    const r = chunk(["--bin", bin, "--out", "public/runtime"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing --out .*public/);
    expect(r.stdout).toBe("");
    const after = fs.existsSync(path.join(root, "public/runtime/chunks")) ? fs.readdirSync(path.join(root, "public/runtime/chunks")).length : -1;
    expect(after).toBe(before);
  });

  test("forwards --bin, an absolute --out, --lean-version and --revision; one deprecation WARNING; the package's exit code", () => {
    const bin = fakeBin("fwd");
    const r = chunk(["--bin", bin, "--out", path.join(tmp, "runtime-fwd"), "--revision", "test", "--lean-version", "9.9.9", "--upstream-base", "v9.9.9"]);
    expect(r.status).toBe(7);
    expect(forwarded(r)).toEqual(["--bin", bin, "--out", path.join(tmp, "runtime-fwd"), "--lean-version", "9.9.9", "--revision", "test"]);
    expect(r.stderr.split("\n").filter(Boolean)).toEqual([DEPRECATED]);
    expect(fs.existsSync(path.join(tmp, "runtime-fwd"))).toBe(false); // the fake writes nothing; neither does the front half
  });

  test("a missing --lean-version is a loud warning and forwards 4.33.0-pre; --upstream-base only feeds the default revision", () => {
    const loud = chunk(["--bin", fakeBin("nover"), "--out", path.join(tmp, "runtime-nover"), "--upstream-base", "v9.9.9"]);
    expect(loud.status).toBe(7);
    expect(loud.stderr).toMatch(/WARNING — no --lean-version given; the manifest will say Lean 4\.33\.0-pre/);
    // no --revision for a binary outside pipeline/toolchain/work: said out loud
    expect(loud.stderr).toMatch(/WARNING — no --revision given for a binary outside pipeline\/toolchain\/work/);
    const argv = forwarded(loud);
    expect(argv.slice(0, 6)).toEqual(["--bin", path.join(tmp, "bin-nover"), "--out", path.join(tmp, "runtime-nover"), "--lean-version", "4.33.0-pre"]);
    expect(argv[6]).toBe("--revision");
    // The default revision needs the fork checkout; where it exists the base is the argument's.
    expect(argv[7] === "unspecified" || /^qed64-wasm64@[0-9a-f]+ \(base v9\.9\.9\)$/.test(argv[7]!)).toBe(true);
    expect(argv).not.toContain("--upstream-base");
    expect(loud.stderr.split("\n").filter(Boolean).at(-1)).toBe(DEPRECATED);
  });

  test("default --out is work/staging/<buildId>/runtime (never public/), deprecated with one WARNING, forwarded absolute", () => {
    const bin = fakeBin("default");
    const r = chunk(["--bin", bin, "--revision", "test", "--lean-version", "9.9.9"]);
    expect(r.status).toBe(7);
    const id = runtimeBuildId(Buffer.from("\0asmdefault"));
    const staged = path.join(root, "work/staging", id, "runtime");
    expect(r.stderr.split("\n").filter(Boolean)).toEqual([
      `chunk-runtime: WARNING — the default --out work/staging/<buildId>/runtime under the repo root (${staged}) is deprecated; use --out <dir> or set QED64_STAGING (docs/CLI-CONTRACT.md)`,
      DEPRECATED,
    ]);
    expect(forwarded(r)).toEqual(["--bin", bin, "--out", staged, "--lean-version", "9.9.9", "--revision", "test"]);
    expect(fs.existsSync(path.join(root, "work/staging", id))).toBe(false);
  });

  test("no package: the front half's WARNING, then one not-found line, exit 2", () => {
    const r = chunk(["--bin", fakeBin("nopkg"), "--out", path.join(tmp, "runtime-nopkg"), "--revision", "test", "--lean-version", "9.9.9"], { LEAN4_WASM64_DIR: "" });
    // the walk from the repo root may find an installed package (CI's npm ci); this host has none
    if (r.status === 2) {
      expect(r.stdout).toBe("");
      expect(r.stderr.split("\n").filter(Boolean)).toEqual([DEPRECATED, expect.stringMatching(/^chunk-runtime: lean4-wasm64 not found — set LEAN4_WASM64_DIR=<package dir> or install it: /)]);
    }
  });
});

describe("infra/worker.js cache rule", () => {
  test("manifests and indexes revalidate; digest-named chunks and snapshots are immutable", () => {
    // The per-build manifest carries 16 hex chars in its NAME but its
    // contents change on a lean.js-only relink (buildId = sha256(lean.wasm)).
    expect(isImmutable("/runtime/runtime-manifest.wasm64-dca2763359db27e7.json")).toBe(false);
    expect(isImmutable("/runtime/runtime-manifest.json")).toBe(false);
    expect(isImmutable("/snapshots/index.json")).toBe(false);
    expect(isImmutable("/profiles/index.json")).toBe(false);
    // the per-build index copies (HARDENING #64): a rebake for the same runtime rewrites them
    expect(isImmutable("/snapshots/index.wasm64-dca2763359db27e7.json")).toBe(false);
    expect(isImmutable("/snapshots/profiles-index.wasm64-dca2763359db27e7.json")).toBe(false);
    expect(isImmutable(`/runtime/chunks/lean.js.${"a1b2c3d4e5f6a7b8c9d0"}.part-000`)).toBe(true);
    expect(isImmutable(`/runtime/chunks/${"0".repeat(64)}.bin`)).toBe(true);
    expect(isImmutable("/snapshots/init.dca2763359db27e7.snapz")).toBe(true);
    expect(isImmutable("/index.html")).toBe(false);
  });
});

describe("bake-snapshot.mjs", () => {
  function fakeArtifact(tag: string): string {
    const art = path.join(tmp, `stage1-${tag}`);
    fs.mkdirSync(path.join(art, "bin"), { recursive: true });
    fs.writeFileSync(path.join(art, "bin/lean.wasm"), Buffer.from(`\0asm${tag}`));
    return art;
  }
  test("refuses --out inside public/ before the runner starts", () => {
    const t0 = Date.now();
    const r = run(baker, ["--artifact", fakeArtifact("fake"), "--out", "public/snapshots"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing --out .*public/);
    expect(Date.now() - t0).toBeLessThan(10_000); // no runner was launched
  });

  test("refuses an index with foreign or unpaired siblings before the runner starts, naming what to rebake", () => {
    const art = fakeArtifact("pair");
    const mine = runtimeBuildId(Buffer.from("\0asmpair"));
    const write = (dir: string, snapshots: Record<string, unknown>[]) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ schema: "qed64.snapshot-index/v1", snapshots }));
    };
    const foreign = path.join(tmp, "idx-foreign");
    write(foreign, [{ name: "mathlib", url: "/snapshots/mathlib.x.snapz", runtime: "wasm64-0000000000000000" }]);
    const t0 = Date.now();
    const f = run(baker, ["--artifact", art, "--name", "init", "--out", foreign]);
    expect(f.status).toBe(2);
    expect(f.stderr).toMatch(/entries for runtime wasm64-0000000000000000 \(mathlib\)/);
    const unpaired = path.join(tmp, "idx-unpaired");
    write(unpaired, [{ name: "mathlib", url: "/snapshots/mathlib.x.snapz" }, { name: "init", url: "/snapshots/init.x.snapz" }]);
    const u = run(baker, ["--artifact", art, "--name", "init", "--out", unpaired]);
    expect(u.status).toBe(2);
    expect(u.stderr).toMatch(/no runtime pairing \(mathlib\).*rebake --name mathlib/);
    expect(Date.now() - t0).toBeLessThan(10_000);
    // The entry being rebaked is not a sibling, and a paired sibling is fine
    // (that bake would proceed to the runner, so it is not exercised here).
    expect(mine).toMatch(/^wasm64-[0-9a-f]{16}$/);
  });
});

describe("promote-staging.mjs", () => {
  function stageRuntime(dir: string, tag: string, opts: { runtime?: string | null; snapshotTag?: string; leanVersion?: string } = {}) {
    const manifest = stageChunks(fakeBin(`p-${tag}`), path.join(dir, "runtime"), opts.leanVersion);
    const snapDir = path.join(dir, "snapshots");
    fs.mkdirSync(snapDir, { recursive: true });
    const body = Buffer.from(`snap-${opts.snapshotTag ?? tag}`);
    const name = `init.${sha(body).slice(0, 16)}.snapz`;
    fs.writeFileSync(path.join(snapDir, name), body);
    const entry: Record<string, unknown> = { name: "init", url: `/snapshots/${name}`, digest: `sha256:${sha(body)}`, bytes: body.length, transfer: body.length, imports: [] };
    if (opts.runtime !== null) entry.runtime = opts.runtime ?? manifest.buildId;
    fs.writeFileSync(path.join(snapDir, "index.json"), JSON.stringify({ schema: "qed64.snapshot-index/v1", snapshots: [entry] }, null, 2));
    return { manifest, snapshotFile: name };
  }

  test("copies additively and switches the default manifest atomically", () => {
    const pub = path.join(tmp, "public-1");
    const oldStage = path.join(tmp, "stage-old");
    const newStage = path.join(tmp, "stage-new");
    const old = stageRuntime(oldStage, "old");
    const neu = stageRuntime(newStage, "new");
    expect(run(promote, ["--staging", oldStage, "--public", pub]).status).toBe(0);
    const oldChunks = fs.readdirSync(path.join(pub, "runtime/chunks"));
    expect(oldChunks.length).toBeGreaterThan(0);
    const dry = run(promote, ["--staging", newStage, "--public", pub, "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/DRY RUN/);
    // the dry run changed nothing
    expect(JSON.parse(fs.readFileSync(path.join(pub, "runtime/runtime-manifest.json"), "utf8")).buildId).toBe(old.manifest.buildId);
    expect(fs.readdirSync(path.join(pub, "runtime/chunks"))).toEqual(oldChunks);
    const real = run(promote, ["--staging", newStage, "--public", pub]);
    expect(real.status).toBe(0);
    // a public tree that publishes no profiles: nothing to re-point, nothing invented
    expect(real.stdout).toMatch(/kernel-only: no profiles\/index\.json/);
    expect(fs.existsSync(path.join(pub, "profiles"))).toBe(false);
    const chunks = fs.readdirSync(path.join(pub, "runtime/chunks"));
    for (const f of oldChunks) expect(chunks).toContain(f); // never deletes
    for (const file of Object.values(neu.manifest.files) as { chunks: { url: string }[] }[]) {
      for (const c of file.chunks) expect(chunks).toContain(path.basename(c.url));
    }
    expect(JSON.parse(fs.readFileSync(path.join(pub, "runtime/runtime-manifest.json"), "utf8")).buildId).toBe(neu.manifest.buildId);
    expect(fs.existsSync(path.join(pub, `runtime/runtime-manifest.${old.manifest.buildId}.json`))).toBe(true);
    expect(fs.existsSync(path.join(pub, `runtime/runtime-manifest.${neu.manifest.buildId}.json`))).toBe(true);
    // snapshots: both content-addressed files present, index switched, paired
    expect(fs.existsSync(path.join(pub, "snapshots", old.snapshotFile))).toBe(true);
    expect(fs.existsSync(path.join(pub, "snapshots", neu.snapshotFile))).toBe(true);
    const idx = JSON.parse(fs.readFileSync(path.join(pub, "snapshots/index.json"), "utf8"));
    expect(idx.snapshots[0].runtime).toBe(neu.manifest.buildId);
    expect(fs.readdirSync(path.join(pub, "runtime")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // HARDENING #64: each promote writes its snapshot index's per-build copy (the same bytes), and
    // never touches another runtime's: a shell pinned to the old runtime keeps reading its pairing.
    const copy = (id: string) => path.join(pub, `snapshots/index.${id}.json`);
    expect(fs.readFileSync(copy(neu.manifest.buildId), "utf8")).toBe(fs.readFileSync(path.join(pub, "snapshots/index.json"), "utf8"));
    expect(JSON.parse(fs.readFileSync(copy(old.manifest.buildId), "utf8")).snapshots[0].runtime).toBe(old.manifest.buildId);
    expect(JSON.parse(fs.readFileSync(copy(old.manifest.buildId), "utf8")).snapshots[0].url).toBe(`/snapshots/${old.snapshotFile}`);
    // no profile index published here: no profile-index copy invented
    expect(fs.readdirSync(path.join(pub, "snapshots")).filter((f) => f.startsWith("profiles-index."))).toEqual([]);
  });

  test("refuses a staged chunk or snapshot whose bytes do not match its recorded digest", () => {
    const pub = path.join(tmp, "public-3");
    const stage = path.join(tmp, "stage-truncated");
    const { manifest, snapshotFile } = stageRuntime(stage, "tr");
    const firstFile = Object.values(manifest.files as Record<string, { chunks: { url: string }[] }>)[0]!;
    const chunk = path.join(stage, "runtime/chunks", path.basename(firstFile.chunks[0]!.url));
    const whole = fs.readFileSync(chunk);
    fs.writeFileSync(chunk, whole.subarray(0, whole.length - 1)); // truncated by one byte
    const r = run(promote, ["--staging", stage, "--public", pub, "--dry-run"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/chunk .* is \d+ bytes, manifest says|has sha256/);
    expect(fs.existsSync(pub)).toBe(false);
    fs.writeFileSync(chunk, whole);
    fs.appendFileSync(path.join(stage, "snapshots", snapshotFile), "!"); // snapshot digest drift
    const s = run(promote, ["--staging", stage, "--public", pub, "--dry-run"]);
    expect(s.status).toBe(2);
    expect(s.stderr).toMatch(/snapshot init: .* has sha256/);
  });

  test("refuses an index whose entries are paired with another runtime, or with none", () => {
    const pub = path.join(tmp, "public-2");
    const mismatched = path.join(tmp, "stage-mismatch");
    stageRuntime(mismatched, "mm", { runtime: "wasm64-0000000000000000" });
    const r = run(promote, ["--staging", mismatched, "--public", pub]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/paired with runtime wasm64-0000000000000000/);
    expect(fs.existsSync(pub)).toBe(false);
    const unpaired = path.join(tmp, "stage-unpaired");
    stageRuntime(unpaired, "up", { runtime: null });
    const u = run(promote, ["--staging", unpaired, "--public", pub]);
    expect(u.status).toBe(2);
    expect(u.stderr).toMatch(/none recorded/);
  });

  // ---- packs: promoted in the SAME step as runtime + snapshots ------------
  const LEAN = "4.34.0-test";
  type PackManifest = { digest: string; content: { release: string; lean: { version: string }; modules: Record<string, unknown>; pack: { url: string; transport: { parts: { url: string; digest: string; byteLength: number }[] } } } };
  const contentDigest = (m: PackManifest) => `sha256:${sha(Buffer.from(JSON.stringify(m.content)))}`;
  const readManifest = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as PackManifest;
  const writeManifest = (file: string, m: PackManifest, rederive = true) => {
    if (rederive) m.digest = contentDigest(m);
    fs.writeFileSync(file, JSON.stringify(m));
  };
  /** The staging layout contract: <stage>/profiles/{index.json, the two
   * manifests, every part by basename}. Packs are REAL pack.mjs output over a
   * tiny fake olean tree, with the URLs re-rooted at /profiles/ and the
   * manifest digest re-derived, as the pack lane does. */
  function stageProfiles(dir: string, tag: string, buildId: string, opts: { leanVersion?: string; indexBuildId?: string } = {}) {
    const out = path.join(dir, "profiles");
    const packs = [
      { id: "core", base: "lean-core", files: { "Init.olean": `init ${tag}`, "Init/Prelude.olean": `prelude ${tag}`, "Init/Prelude.ir": `ir ${tag}` } },
      { id: "essential", base: "mathlib-essential", files: { "Mathlib/Logic/Basic.olean": `logic ${tag}`, "QED64/Essential.olean": `umbrella ${tag}` } },
    ];
    const entries = [];
    const parts: string[] = [];
    for (const p of packs) {
      const lib = path.join(tmp, `lib-${tag}-${p.base}`);
      for (const [relPath, text] of Object.entries(p.files)) {
        fs.mkdirSync(path.dirname(path.join(lib, relPath)), { recursive: true });
        fs.writeFileSync(path.join(lib, relPath), text);
      }
      // fixture oleans are plain text, not compacted regions: --no-imports
      const r = run(packer, ["--lib", lib, "--id", p.base, "--out", out, "--lean-version", opts.leanVersion ?? LEAN, "--no-imports"]);
      expect(r.status).toBe(0);
      const file = path.join(out, `${p.base}.manifest.json`);
      const m = readManifest(file);
      for (const part of m.content.pack.transport.parts) { part.url = `/profiles/${path.basename(part.url)}`; parts.push(path.basename(part.url)); }
      m.content.pack.url = `/profiles/${p.base}.pack.gzip`;
      writeManifest(file, m);
      entries.push({ id: p.id, manifest: `/profiles/${p.base}.manifest.json`, release: m.content.release, modules: Object.keys(m.content.modules).length });
    }
    const index = { schema: "qed64.profile-index/v1", runtime: { buildId: opts.indexBuildId ?? buildId, leanVersion: opts.leanVersion ?? LEAN }, profiles: entries };
    fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 2));
    return { parts, index, coreManifest: path.join(out, "lean-core.manifest.json"), essentialManifest: path.join(out, "mathlib-essential.manifest.json") };
  }
  function stagePairing(dir: string, tag: string, opts: { leanVersion?: string; packLeanVersion?: string; indexBuildId?: string } = {}) {
    const rt = stageRuntime(dir, tag, { leanVersion: opts.leanVersion ?? LEAN });
    const packs = stageProfiles(dir, tag, rt.manifest.buildId, { leanVersion: opts.packLeanVersion ?? opts.leanVersion ?? LEAN, indexBuildId: opts.indexBuildId });
    return { ...rt, ...packs };
  }
  /** Every file under a tree with its bytes' digest — "nothing was written". */
  function treeState(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full); else out[path.relative(dir, full)] = sha(fs.readFileSync(full));
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
  }
  const planLines = (stdout: string) => stdout.split("\n").filter((l) => /^(copy|keep|fix|swap) /.test(l));

  test("packs promote in the same step: parts additive, manifests + index switched after every part, dry-run exact", () => {
    const pub = path.join(tmp, "public-packs");
    const old = stagePairing(path.join(tmp, "stage-packs-old"), "pk-old");
    const neu = stagePairing(path.join(tmp, "stage-packs-new"), "pk-new");
    expect(old.parts).not.toEqual(neu.parts); // different bytes → different content-addressed names
    expect(run(promote, ["--staging", path.join(tmp, "stage-packs-old"), "--public", pub]).status).toBe(0);
    const before = treeState(pub);
    for (const part of old.parts) expect(before[`profiles/${part}`]).toBeDefined();

    const dry = run(promote, ["--staging", path.join(tmp, "stage-packs-new"), "--public", pub, "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/DRY RUN — would promote runtime/);
    expect(dry.stdout).toMatch(/would promote 2 profile\(s\): core \(2 modules, 1 part\(s\)/);
    expect(treeState(pub)).toEqual(before); // the dry run wrote nothing — no temp files either

    const real = run(promote, ["--staging", path.join(tmp, "stage-packs-new"), "--public", pub]);
    expect(real.status).toBe(0);
    // the dry run's plan IS the real run's plan
    expect(planLines(dry.stdout)).toEqual(planLines(real.stdout));
    const plan = planLines(real.stdout);
    for (const part of neu.parts) expect(plan.some((l) => l.startsWith("copy ") && l.endsWith(`profiles/${part}`))).toBe(true);
    // ORDER: every content-addressed file lands before the first mutable file
    // switches, and the profile index — the commit record — switches last.
    const firstSwap = plan.findIndex((l) => l.startsWith("swap "));
    expect(plan.slice(firstSwap).every((l) => l.startsWith("swap "))).toBe(true);
    expect(plan.at(-1)).toMatch(/^swap .*profiles\/index\.json$/);
    const swapOf = (suffix: string) => plan.findIndex((l) => l.startsWith("swap ") && l.endsWith(suffix));
    expect(swapOf("profiles/lean-core.manifest.json")).toBeLessThan(swapOf("runtime/runtime-manifest.json"));
    expect(swapOf("snapshots/index.json")).toBeLessThan(swapOf("runtime/runtime-manifest.json"));
    // HARDENING #64: each per-build index copy switches just before its mutable index
    expect(swapOf(`snapshots/index.${neu.manifest.buildId}.json`)).toBe(swapOf("snapshots/index.json") - 1);
    expect(plan.at(-2)).toMatch(new RegExp(`^swap .*snapshots/profiles-index\\.${neu.manifest.buildId}\\.json$`));

    const after = treeState(pub);
    for (const [file, digest] of Object.entries(before)) {
      // additive: nothing deleted; content-addressed files byte-identical
      expect(after[file]).toBeDefined();
      if (/\.part-\d+$|\.snapz$/.test(file)) expect(after[file]).toBe(digest);
    }
    for (const part of neu.parts) expect(after[`profiles/${part}`]).toBe(sha(fs.readFileSync(path.join(tmp, "stage-packs-new/profiles", part))));
    // the manifests and the index are the staged BYTES (they are committed to git as the trust anchor)
    expect(after["profiles/lean-core.manifest.json"]).toBe(sha(fs.readFileSync(neu.coreManifest)));
    expect(after["profiles/mathlib-essential.manifest.json"]).toBe(sha(fs.readFileSync(neu.essentialManifest)));
    const idx = JSON.parse(fs.readFileSync(path.join(pub, "profiles/index.json"), "utf8"));
    expect(idx.runtime).toEqual({ buildId: neu.manifest.buildId, leanVersion: LEAN });
    // the profile index's per-build copy: the staged index's bytes, under snapshots/ (site-owned); the old one stays
    expect(after[`snapshots/profiles-index.${neu.manifest.buildId}.json`]).toBe(after["profiles/index.json"]);
    expect(after[`snapshots/profiles-index.${old.manifest.buildId}.json`]).toBe(before["profiles/index.json"]);
    expect(JSON.parse(fs.readFileSync(path.join(pub, "runtime/runtime-manifest.json"), "utf8")).buildId).toBe(neu.manifest.buildId);
    expect(Object.keys(after).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // the raw .pack that pack.mjs leaves beside the parts is staging-only
    expect(Object.keys(after).filter((f) => f.endsWith(".pack"))).toEqual([]);
    expect(real.stdout).toMatch(/pack part file\(s\) under public\/profiles are referenced by no manifest \(left in place\)/);

    // what was promoted is a release verify-release accepts, index pairing included
    const verified = run(verifyRelease, ["--public", pub]);
    expect(verified.stdout).toMatch(/RELEASE VERIFIED/);
    expect(verified.status).toBe(0);
    // idempotent: a rerun keeps every content-addressed file and re-switches
    const again = run(promote, ["--staging", path.join(tmp, "stage-packs-new"), "--public", pub]);
    expect(again.status).toBe(0);
    expect(planLines(again.stdout).filter((l) => l.startsWith("copy "))).toEqual([]);
    expect(treeState(pub)).toEqual(after);
  }, 180_000);

  test("refuses staged packs that are mispaired, incomplete, or not the bytes their manifest names — before touching anything", () => {
    const pub = path.join(tmp, "public-packs-refused");
    const refuse = (stage: string, why: RegExp) => {
      const r = run(promote, ["--staging", stage, "--public", pub]); // a REAL run: nothing may be written
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(why);
      expect(fs.existsSync(pub)).toBe(false); // not even the (valid) runtime chunks were copied
    };
    // index paired with another runtime
    const mismatch = path.join(tmp, "stage-packs-mismatch");
    stagePairing(mismatch, "pk-mm", { indexBuildId: "wasm64-0000000000000000" });
    refuse(mismatch, /staged profile index is paired with runtime wasm64-0000000000000000, not wasm64-/);

    const stage = path.join(tmp, "stage-packs-bad");
    const good = stagePairing(stage, "pk-bad");
    const part = path.join(stage, "profiles", good.parts[0]!);
    const whole = fs.readFileSync(part);
    // missing part
    fs.rmSync(part);
    refuse(stage, /profile core: manifest lists \/profiles\/.* but .* is absent/);
    // truncated part
    fs.writeFileSync(part, whole.subarray(0, whole.length - 1));
    refuse(stage, /part .* is \d+ bytes, manifest says \d+/);
    // right size, wrong bytes
    const flipped = Buffer.from(whole); flipped[flipped.length - 1] = whole[whole.length - 1]! ^ 0xff;
    fs.writeFileSync(part, flipped);
    refuse(stage, /profile core: part .* has sha256 .* manifest says/);
    fs.writeFileSync(part, whole);
    // manifest edited after packing without re-deriving its digest
    const pristine = fs.readFileSync(good.coreManifest);
    const edited = readManifest(good.coreManifest);
    edited.content.pack.url = "/profiles/somewhere-else.pack.gzip";
    writeManifest(good.coreManifest, edited, false);
    refuse(stage, /profile core: manifest digest is .* its content hashes to/);
    // pack.mjs's bare part names (never re-rooted at /profiles/): would 404 in the page
    const bare = readManifest(good.coreManifest);
    for (const p of bare.content.pack.transport.parts) p.url = path.basename(p.url);
    writeManifest(good.coreManifest, bare);
    refuse(stage, /profile core part: url ".*" is not \/profiles\/<file>/);
    // index entry that does not describe its manifest
    fs.writeFileSync(good.coreManifest, pristine);
    const indexFile = path.join(stage, "profiles/index.json");
    const pristineIndex = fs.readFileSync(indexFile);
    const idx = JSON.parse(pristineIndex.toString());
    idx.profiles[0].modules += 1;
    fs.writeFileSync(indexFile, JSON.stringify(idx));
    refuse(stage, /profile core: index says 3 modules, manifest has 2/);
    // no core profile: the page cannot boot
    idx.profiles.shift();
    fs.writeFileSync(indexFile, JSON.stringify(idx));
    refuse(stage, /no `core` profile/);
    // a half-staged pack lane is not a kernel-only promote
    fs.rmSync(indexFile);
    refuse(stage, /profiles exists but has no index\.json/);
    // restored, the very same staging promotes
    fs.writeFileSync(indexFile, pristineIndex);
    expect(run(promote, ["--staging", stage, "--public", pub, "--dry-run"]).status).toBe(0);

    // two profiles naming ONE manifest: every per-entry check passes, and the
    // switch phase would rename the same temp file twice (half-switched tree)
    const dupIndex = JSON.parse(pristineIndex.toString());
    dupIndex.profiles.push({ ...dupIndex.profiles[0], id: "core-again" });
    fs.writeFileSync(indexFile, JSON.stringify(dupIndex));
    refuse(stage, /two profiles name the same manifest/);
    fs.writeFileSync(indexFile, pristineIndex);

    // packs of another Lean version than the runtime they are staged with
    const versions = path.join(tmp, "stage-packs-version");
    stagePairing(versions, "pk-ver", { packLeanVersion: "4.33.0-pre" });
    refuse(versions, /staged profile index says Lean 4\.33\.0-pre, the staged runtime manifest says Lean 4\.34\.0-test/);
    const vIndexFile = path.join(versions, "profiles/index.json");
    const vIndex = JSON.parse(fs.readFileSync(vIndexFile, "utf8"));
    vIndex.runtime.leanVersion = LEAN; // the index lies; the manifests do not
    fs.writeFileSync(vIndexFile, JSON.stringify(vIndex));
    refuse(versions, /profile core \(staged\) was packed for Lean 4\.33\.0-pre, the runtime being promoted is Lean 4\.34\.0-test/);
  }, 180_000);

  test("a kernel-only promote keeps the served packs and re-points profiles/index.json at the promoted runtime", () => {
    const pub = path.join(tmp, "public-kernel-only");
    const base = stagePairing(path.join(tmp, "stage-ko-base"), "ko-base");
    expect(run(promote, ["--staging", path.join(tmp, "stage-ko-base"), "--public", pub]).status).toBe(0);
    const before = treeState(pub);
    const servedIndex = JSON.parse(fs.readFileSync(path.join(pub, "profiles/index.json"), "utf8"));

    const bumpStage = path.join(tmp, "stage-ko-bump"); // runtime + snapshots only: no profiles/ dir
    const bump = stageRuntime(bumpStage, "ko-bump", { leanVersion: LEAN });
    const dry = run(promote, ["--staging", bumpStage, "--public", pub, "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(planLines(dry.stdout).at(-1)).toMatch(/^swap .*profiles\/index\.json$/);
    expect(dry.stdout).toMatch(/kernel-only: served packs kept, profiles\/index\.json would be re-pointed/);
    expect(treeState(pub)).toEqual(before);

    const real = run(promote, ["--staging", bumpStage, "--public", pub]);
    expect(real.status).toBe(0);
    expect(planLines(real.stdout)).toEqual(planLines(dry.stdout));
    const after = treeState(pub);
    // packs untouched: same manifests, same parts, nothing new under profiles/
    expect(Object.keys(after).filter((f) => f.startsWith("profiles/")).sort()).toEqual(Object.keys(before).filter((f) => f.startsWith("profiles/")).sort());
    for (const f of Object.keys(before)) if (f.startsWith("profiles/") && f !== "profiles/index.json") expect(after[f]).toBe(before[f]);
    const idx = JSON.parse(fs.readFileSync(path.join(pub, "profiles/index.json"), "utf8"));
    expect(idx).toEqual({ ...servedIndex, runtime: { buildId: bump.manifest.buildId, leanVersion: LEAN } });
    // the re-pointed index gets its per-build copy too; the base runtime's copy keeps the base pairing
    expect(after[`snapshots/profiles-index.${bump.manifest.buildId}.json`]).toBe(after["profiles/index.json"]);
    expect(JSON.parse(fs.readFileSync(path.join(pub, `snapshots/profiles-index.${base.manifest.buildId}.json`), "utf8"))).toEqual(servedIndex);
    expect(planLines(real.stdout).at(-2)).toMatch(new RegExp(`^swap .*snapshots/profiles-index\\.${bump.manifest.buildId}\\.json$`));
    expect(servedIndex.runtime.buildId).toBe(base.manifest.buildId);
    expect(run(verifyRelease, ["--public", pub]).status).toBe(0);

    // A kernel-only bump to ANOTHER Lean version would serve oleans the runtime
    // cannot read: refused, and the served pairing stays whole.
    const foreign = path.join(tmp, "stage-ko-foreign");
    stageRuntime(foreign, "ko-foreign", { leanVersion: "4.35.0-test" });
    const f = run(promote, ["--staging", foreign, "--public", pub]);
    expect(f.status).toBe(2);
    expect(f.stderr).toMatch(/profile core \(served, not restaged\) was packed for Lean 4\.34\.0-test, the runtime being promoted is Lean 4\.35\.0-test/);
    expect(treeState(pub)).toEqual(after);

    // verify-release is what notices an index that names another runtime
    // (an interrupted promote, or a runtime installed some other way).
    fs.writeFileSync(path.join(pub, "profiles/index.json"), JSON.stringify({ ...idx, runtime: servedIndex.runtime }, null, 2));
    const stale = run(verifyRelease, ["--public", pub]);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toMatch(/FAIL {2}profile index: runtime wasm64-[0-9a-f]{16} is the served runtime wasm64-[0-9a-f]{16} — rerun promote-staging/);
  }, 180_000);

  test("a torn copy under a content-addressed name is repaired, not kept", () => {
    const pub = path.join(tmp, "public-torn");
    const stage = path.join(tmp, "stage-torn");
    const s = stagePairing(stage, "torn");
    const served = path.join(pub, "profiles", s.parts[0]!);
    fs.mkdirSync(path.dirname(served), { recursive: true });
    fs.writeFileSync(served, "half a part"); // what an interrupted copy used to leave behind
    const r = run(promote, ["--staging", stage, "--public", pub]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`fix   .*profiles/${s.parts[0]!.replace(/\./g, "\\.")}`));
    expect(sha(fs.readFileSync(served))).toBe(sha(fs.readFileSync(path.join(stage, "profiles", s.parts[0]!))));
    expect(run(verifyRelease, ["--public", pub]).status).toBe(0);
  }, 120_000);

  test("refuses any target a symlink sends outside --public (a directory or a file), before writing anything", () => {
    const stage = path.join(tmp, "stage-escape");
    const esc = stageRuntime(stage, "esc");
    // runtime/chunks as a DIRECTORY symlink into another tree: this worktree's public/ has exactly that shape
    const pub = path.join(tmp, "public-escape-dir");
    const elsewhere = path.join(tmp, "elsewhere-chunks");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.join(pub, "runtime"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(pub, "runtime/chunks"));
    for (const extra of [["--dry-run"], []]) {
      const r = run(promote, ["--staging", stage, "--public", pub, ...extra]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`^promote: refusing .*runtime/chunks/lean\\.js\\.[0-9a-f]{20}\\.part-000: it resolves to ${fs.realpathSync(elsewhere).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.*, outside --public .* — nothing was written\n$`));
      expect(fs.readdirSync(elsewhere)).toEqual([]);
      expect(fs.readdirSync(path.join(pub, "runtime"))).toEqual(["chunks"]);
    }
    // a mutable file (the default manifest) as a symlink to a file outside: refused, the outside file untouched
    const pub2 = path.join(tmp, "public-escape-file");
    const outsideFile = path.join(tmp, "elsewhere-manifest.json");
    fs.writeFileSync(outsideFile, "the other checkout's manifest");
    fs.mkdirSync(path.join(pub2, "runtime"), { recursive: true });
    fs.symlinkSync(outsideFile, path.join(pub2, "runtime/runtime-manifest.json"));
    const f = run(promote, ["--staging", stage, "--public", pub2]);
    expect(f.status).toBe(2);
    expect(f.stderr).toMatch(/refusing .*runtime\/runtime-manifest\.json: it resolves to .*elsewhere-manifest\.json, outside --public/);
    expect(fs.readFileSync(outsideFile, "utf8")).toBe("the other checkout's manifest");
    expect(fs.readdirSync(path.join(pub2, "runtime"))).toEqual(["runtime-manifest.json"]);
    // HARDENING #64: the per-build index copies are confined up front too, so a symlinked copy refuses
    // before the chunks, the .snapz or a pack part is copied (switchFile's own confine comes too late)
    const escapes = (pubDir: string, copy: string, outside: string) => {
      const target = path.join(pubDir, "snapshots", copy);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(outside, `the other checkout's ${copy}`);
      fs.symlinkSync(outside, target);
      return target;
    };
    const copyRefusal = (copy: string, outside: string) =>
      new RegExp(`^promote: refusing .*snapshots/${copy.replace(/\./g, "\\.")}: it resolves to .*${path.basename(outside).replace(/\./g, "\\.")}, outside --public .* — nothing was written\n$`);
    // the one refusal line names the copy (and only it), whichever index it is
    const COPY_REFUSAL = /^promote: refusing .*snapshots\/(profiles-)?index\.wasm64-[0-9a-f]{16}\.json: it resolves to .*, outside --public .* — nothing was written\n$/;
    {
      // the snapshot index's copy: nothing written (no runtime/, no .snapz)
      const pub3 = path.join(tmp, "public-escape-snapshot-copy");
      const copy = `index.${esc.manifest.buildId}.json`;
      const outside = path.join(tmp, "elsewhere-snapshot-index.json");
      escapes(pub3, copy, outside);
      for (const extra of [["--dry-run"], []]) {
        const r = run(promote, ["--staging", stage, "--public", pub3, ...extra]);
        expect(r.status, r.stderr).toBe(2);
        expect(r.stderr).toMatch(copyRefusal(copy, outside));
        expect(r.stderr).toMatch(COPY_REFUSAL);
        expect(fs.readFileSync(outside, "utf8")).toBe(`the other checkout's ${copy}`);
        expect(fs.readdirSync(pub3)).toEqual(["snapshots"]);
        expect(fs.readdirSync(path.join(pub3, "snapshots"))).toEqual([copy]);
      }
    }
    {
      // the profile index's copy on a staged-packs promote: no runtime/, no .snapz, no pack part
      const packStage = path.join(tmp, "stage-escape-packs");
      const pk = stagePairing(packStage, "esc-pk");
      const pub4 = path.join(tmp, "public-escape-profile-copy");
      const copy = `profiles-index.${pk.manifest.buildId}.json`;
      const outside = path.join(tmp, "elsewhere-profile-index.json");
      escapes(pub4, copy, outside);
      const r = run(promote, ["--staging", packStage, "--public", pub4]);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(copyRefusal(copy, outside));
      expect(r.stderr).toMatch(COPY_REFUSAL);
      expect(fs.readFileSync(outside, "utf8")).toBe(`the other checkout's ${copy}`);
      expect(fs.readdirSync(pub4)).toEqual(["snapshots"]);
      expect(fs.readdirSync(path.join(pub4, "snapshots"))).toEqual([copy]);
    }
    {
      // ... and on a kernel-only re-point of a served profile index: the tree exactly as it was
      const pub5 = path.join(tmp, "public-escape-repoint-copy");
      expect(run(promote, ["--staging", path.join(tmp, "stage-escape-packs"), "--public", pub5]).status).toBe(0);
      const bumpStage = path.join(tmp, "stage-escape-repoint");
      const bump = stageRuntime(bumpStage, "esc-bump", { leanVersion: LEAN });
      const copy = `profiles-index.${bump.manifest.buildId}.json`;
      const outside = path.join(tmp, "elsewhere-repoint-index.json");
      escapes(pub5, copy, outside);
      const before = treeState(pub5);
      const r = run(promote, ["--staging", bumpStage, "--public", pub5]);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(copyRefusal(copy, outside));
      expect(r.stderr).toMatch(COPY_REFUSAL);
      expect(fs.readFileSync(outside, "utf8")).toBe(`the other checkout's ${copy}`);
      expect(treeState(pub5)).toEqual(before);
    }
    // a --public that is itself a symlink, and a symlink that stays inside the tree, are fine
    const realPub = path.join(tmp, "public-real-target");
    fs.mkdirSync(path.join(realPub, "snapshots-real"), { recursive: true });
    fs.symlinkSync("snapshots-real", path.join(realPub, "snapshots"));
    const linkPub = path.join(tmp, "public-link");
    fs.symlinkSync(realPub, linkPub);
    const ok = run(promote, ["--staging", stage, "--public", linkPub]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(fs.readdirSync(path.join(realPub, "snapshots-real")).sort()).toEqual(["index.json", expect.stringMatching(/^index\.wasm64-[0-9a-f]{16}\.json$/), expect.stringMatching(/^init\.[0-9a-f]{16}\.snapz$/)]);
  });

  test("a kernel-only re-point keeps the served profile index's trailing newline (and adds none it lacked)", () => {
    for (const eol of ["\n", ""]) {
      const tag = eol ? "nl" : "nonl";
      const pub = path.join(tmp, `public-eol-${tag}`);
      stagePairing(path.join(tmp, `stage-eol-base-${tag}`), `eol-base-${tag}`);
      expect(run(promote, ["--staging", path.join(tmp, `stage-eol-base-${tag}`), "--public", pub]).status).toBe(0);
      const indexFile = path.join(pub, "profiles/index.json");
      const served = JSON.parse(fs.readFileSync(indexFile, "utf8"));
      fs.writeFileSync(indexFile, JSON.stringify(served, null, 2) + eol); // the tracked file ends in a newline
      const bump = stageRuntime(path.join(tmp, `stage-eol-bump-${tag}`), `eol-bump-${tag}`, { leanVersion: LEAN });
      expect(run(promote, ["--staging", path.join(tmp, `stage-eol-bump-${tag}`), "--public", pub]).status).toBe(0);
      expect(fs.readFileSync(indexFile, "utf8")).toBe(JSON.stringify({ ...served, runtime: { buildId: bump.manifest.buildId, leanVersion: LEAN } }, null, 2) + eol);
    }
  }, 120_000);
});

describe("snapshot index schema", () => {
  test("accepts entries with and without `runtime`, rejects a non-string one", async () => {
    const mk = (entry: Record<string, unknown>) =>
      new Response(JSON.stringify({ schema: "qed64.snapshot-index/v1", snapshots: [entry] }), { status: 200 }); // a real Response: the loader reads text (to tell HTML from JSON)
    const base = { name: "init", url: "/snapshots/init.snapz", bytes: 1, imports: [] };
    const fetchWith = async (entry: Record<string, unknown>) => {
      const saved = globalThis.fetch;
      globalThis.fetch = (async () => mk(entry)) as typeof fetch;
      try { return await fetchSnapshotIndex(); } finally { globalThis.fetch = saved; }
    };
    expect((await fetchWith(base))?.snapshots[0]?.runtime).toBeUndefined();
    expect((await fetchWith({ ...base, runtime: "wasm64-dca2763359db27e7" }))?.snapshots[0]?.runtime).toBe("wasm64-dca2763359db27e7");
    expect(await fetchWith({ ...base, runtime: 42 })).toBeNull();
  });

  test("the served index (public/snapshots/index.json) names the default manifest's runtime", () => {
    const served = path.join(root, "public/snapshots/index.json");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "public/runtime/runtime-manifest.json"), "utf8"));
    const index = JSON.parse(fs.readFileSync(served, "utf8"));
    expect(index.snapshots.length).toBeGreaterThan(0);
    for (const s of index.snapshots) expect(s.runtime).toBe(manifest.buildId);
  });
});
