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

describe("bake-snapshot.mjs", () => {
  test("refuses --out inside public/ before the runner starts", () => {
    const art = path.join(tmp, "stage1-fake");
    fs.mkdirSync(path.join(art, "bin"), { recursive: true });
    fs.writeFileSync(path.join(art, "bin/lean.wasm"), Buffer.from("\0asmfake"));
    const t0 = Date.now();
    const r = run(baker, ["--artifact", art, "--out", "public/snapshots"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing --out .*public/);
    expect(Date.now() - t0).toBeLessThan(10_000); // no runner was launched
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
