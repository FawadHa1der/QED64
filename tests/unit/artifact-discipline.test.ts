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
  function stageRuntime(dir: string, tag: string, opts: { runtime?: string | null; snapshotTag?: string } = {}) {
    const bin = fakeBin(`p-${tag}`);
    const r = run(chunker, ["--bin", bin, "--out", path.join(dir, "runtime"), "--revision", "test"]);
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
