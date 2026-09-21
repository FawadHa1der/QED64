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
import { fetchSnapshotIndex } from "../../src/runtime/snapshots";

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
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-artifacts-")); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A fake stage1/bin with distinct lean.js/lean.wasm bytes per tag. */
function fakeBin(tag: string): string {
  const bin = path.join(tmp, `bin-${tag}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "lean.js"), `// glue ${tag}\n`);
  fs.writeFileSync(path.join(bin, "lean.wasm"), Buffer.from(`\0asm${tag}`));
  return bin;
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

describe("chunk-runtime.mjs", () => {
  test("refuses --out inside public/ before writing anything", () => {
    const bin = fakeBin("refuse");
    const before = fs.existsSync(path.join(root, "public/runtime/chunks")) ? fs.readdirSync(path.join(root, "public/runtime/chunks")).length : -1;
    const r = run(chunker, ["--bin", bin, "--out", "public/runtime"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing --out .*public/);
    const after = fs.existsSync(path.join(root, "public/runtime/chunks")) ? fs.readdirSync(path.join(root, "public/runtime/chunks")).length : -1;
    expect(after).toBe(before);
  });

  test("is additive: a second build's chunks land beside the first's", () => {
    const out = path.join(tmp, "runtime-out");
    const a = run(chunker, ["--bin", fakeBin("A"), "--out", out, "--revision", "test"]);
    expect(a.status).toBe(0);
    const firstChunks = fs.readdirSync(path.join(out, "chunks"));
    const firstManifest = JSON.parse(fs.readFileSync(path.join(out, "runtime-manifest.json"), "utf8"));
    const b = run(chunker, ["--bin", fakeBin("B"), "--out", out, "--revision", "test"]);
    expect(b.status).toBe(0);
    const chunks = fs.readdirSync(path.join(out, "chunks"));
    for (const f of firstChunks) expect(chunks).toContain(f);
    expect(chunks.length).toBeGreaterThan(firstChunks.length);
    const second = JSON.parse(fs.readFileSync(path.join(out, "runtime-manifest.json"), "utf8"));
    expect(second.buildId).not.toBe(firstManifest.buildId);
    // both per-build manifests survive; the identity is the wasm digest
    expect(fs.existsSync(path.join(out, `runtime-manifest.${firstManifest.buildId}.json`))).toBe(true);
    expect(second.buildId).toBe(runtimeBuildId(Buffer.from("\0asmB")));
  });

  test("a missing --lean-version is a loud warning, not an error; --upstream-base feeds the default revision", () => {
    const silent = run(chunker, ["--bin", fakeBin("ver"), "--out", path.join(tmp, "runtime-ver"), "--revision", "test", "--lean-version", "9.9.9"]);
    expect(silent.status).toBe(0);
    expect(silent.stderr).not.toMatch(/no --lean-version/);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, "runtime-ver/runtime-manifest.json"), "utf8")).leanVersion).toBe("9.9.9");
    const loud = run(chunker, ["--bin", fakeBin("nover"), "--out", path.join(tmp, "runtime-nover"), "--upstream-base", "v9.9.9"]);
    expect(loud.status).toBe(0);
    expect(loud.stderr).toMatch(/WARNING — no --lean-version given; the manifest will say Lean 4\.33\.0-pre/);
    // no --revision for a binary outside pipeline/toolchain/work: said out loud
    expect(loud.stderr).toMatch(/WARNING — no --revision given for a binary outside pipeline\/toolchain\/work/);
    const m = JSON.parse(fs.readFileSync(path.join(tmp, "runtime-nover/runtime-manifest.json"), "utf8"));
    expect(m.leanVersion).toBe("4.33.0-pre");
    // The default revision needs the fork checkout; where it exists the base is the argument's.
    expect(m.sourceRevision === "unspecified" || /^qed64-wasm64@[0-9a-f]+ \(base v9\.9\.9\)$/.test(m.sourceRevision)).toBe(true);
  });

  test("default --out is work/staging/<buildId>/runtime (never public/)", () => {
    const bin = fakeBin("default");
    const r = run(chunker, ["--bin", bin, "--revision", "test"]);
    expect(r.status).toBe(0);
    const id = runtimeBuildId(Buffer.from("\0asmdefault"));
    const staged = path.join(root, "work/staging", id, "runtime");
    expect(fs.existsSync(path.join(staged, "runtime-manifest.json"))).toBe(true);
    fs.rmSync(path.join(root, "work/staging", id), { recursive: true, force: true });
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
    const bin = fakeBin(`p-${tag}`);
    const r = run(chunker, ["--bin", bin, "--out", path.join(dir, "runtime"), "--revision", "test", ...(opts.leanVersion ? ["--lean-version", opts.leanVersion] : [])]);
    expect(r.status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "runtime/runtime-manifest.json"), "utf8"));
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
});

describe("snapshot index schema", () => {
  test("accepts entries with and without `runtime`, rejects a non-string one", async () => {
    const mk = (entry: Record<string, unknown>) =>
      ({ ok: true, json: async () => ({ schema: "qed64.snapshot-index/v1", snapshots: [entry] }) }) as unknown as Response;
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
