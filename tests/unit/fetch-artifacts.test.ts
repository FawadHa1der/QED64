// pipeline/release/fetch-artifacts.mjs (docs/CLI-CONTRACT.md "fetch-artifacts"),
// against a tiny fake layout: tracked manifests with the real sha256 of small
// byte strings, served by an in-process 127.0.0.1 http server (a QED64 origin
// under /site/, a fork release under /rel/) or read from a directory. Nothing
// touches the network beyond 127.0.0.1, and nothing boots a runtime.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fetchArtifacts, main, oneLine, parseOnly, planFromManifests, type FetchOptions } from "../../pipeline/release/fetch-artifacts.mjs";
import { SPECS } from "../../pipeline/snapshot/cli.mjs";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "pipeline/release/fetch-artifacts.mjs");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const bytes = (label: string, n: number) => Buffer.from(Array.from({ length: n }, (_, i) => `${label}:${i};`).join("").slice(0, n));

let tmp: string;
let server: http.Server;
let base: string;
/** Served bytes by URL path (/site/…, /rel/…), and every GET path seen. */
const served = new Map<string, Buffer>();
const hits: string[] = [];
/** URL paths answered with a Content-Length of `total`, the first bytes `head`, then nothing (a stalled download). */
const stalls = new Map<string, { head: Buffer; total: number }>();
const stalled = new Set<http.ServerResponse>();

/** The fake layout: site path (no leading slash) → bytes. */
const lj = [bytes("lean.js-0", 64), bytes("lean.js-1", 40)];
const lw = [bytes("lean.wasm-0", 64)];
const parts = [bytes("core.part-0", 64), bytes("core.part-1", 17)];
const snapz = bytes("init.snapz", 50);
const buildId = `wasm64-${sha(Buffer.concat(lw)).slice(0, 16)}`;
const chunkUrl = (name: string, b: Buffer, i: number) => `/runtime/chunks/${name}.${sha(b).slice(0, 20)}.part-${String(i).padStart(3, "0")}`;
const runtimeManifest = {
  schema: "org.lean-browser64.runtime/v1",
  buildId,
  leanVersion: "0.0.0-test",
  files: Object.fromEntries((["lean.js", "lean.wasm"] as const).map((name) => {
    const cs = name === "lean.js" ? lj : lw;
    const whole = Buffer.concat(cs);
    return [name, { bytes: whole.length, sha256: sha(whole), chunks: cs.map((b, i) => ({ url: chunkUrl(name, b, i), bytes: b.length, sha256: sha(b) })) }];
  })),
};
const partUrl = (b: Buffer, i: number) => `/profiles/core.pack.gzip.${sha(b).slice(0, 20)}.part-${String(i).padStart(3, "0")}`;
const transport = Buffer.concat(parts);
const coreManifest = {
  format: "browser64.artifact-manifest", version: 1, digest: `sha256:${"0".repeat(64)}`,
  content: { release: "core-test", pack: { transport: { encoding: "gzip", digest: `sha256:${sha(transport)}`, byteLength: transport.length, parts: parts.map((b, i) => ({ url: partUrl(b, i), digest: `sha256:${sha(b)}`, byteLength: b.length })) } } },
};
const snapUrl = `/snapshots/init.${sha(snapz).slice(0, 16)}.snapz`;
const snapshotIndex = { schema: "qed64.snapshot-index/v1", snapshots: [{ name: "init", url: snapUrl, digest: `sha256:${sha(snapz)}`, bytes: 999, transfer: snapz.length, imports: [], runtime: buildId }] };
const profileIndex = { schema: "qed64.profile-index/v1", runtime: { buildId }, profiles: [{ id: "core", manifest: "/profiles/core.manifest.json", release: "core-test", modules: 1 }] };

const binaries = new Map<string, Buffer>([
  ...runtimeManifest.files["lean.js"]!.chunks.map((c, i) => [c.url.slice(1), lj[i]!] as const),
  ...runtimeManifest.files["lean.wasm"]!.chunks.map((c, i) => [c.url.slice(1), lw[i]!] as const),
  ...coreManifest.content.pack.transport.parts.map((p, i) => [p.url.slice(1), parts[i]!] as const),
  [snapUrl.slice(1), snapz],
]);
const groupOf = (rel: string) => rel.split("/")[0]!;
/** The files written from tracked bytes, never fetched (plan.copies): the digest-named runtime manifest only.
 * No per-build index copies since 2026-11 (architecture review D2: QED64's indexes ship in each deploy). */
const COPIES = new Map<string, string>([
  [`runtime/runtime-manifest.${buildId}.json`, JSON.stringify(runtimeManifest, null, 2)],
]);
const copyBytes = [...COPIES.values()].reduce((n, t) => n + Buffer.byteLength(t), 0);

function writeTree(dir: string, files: Iterable<readonly [string, Buffer | string]>) {
  for (const [rel, data] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
}
/** The tracked manifests, as a checkout's public/ holds them. */
function manifestsDir(edit: (m: { runtime: typeof runtimeManifest; snapshots: typeof snapshotIndex }) => void = () => {}): string {
  const d = fs.mkdtempSync(path.join(tmp, "manifests-"));
  const runtime = structuredClone(runtimeManifest);
  const snapshots = structuredClone(snapshotIndex);
  edit({ runtime, snapshots });
  writeTree(d, [
    ["runtime/runtime-manifest.json", JSON.stringify(runtime, null, 2)],
    ["profiles/index.json", JSON.stringify(profileIndex, null, 2)],
    ["profiles/core.manifest.json", JSON.stringify(coreManifest)],
    ["snapshots/index.json", JSON.stringify(snapshots, null, 2)],
  ]);
  return d;
}
/** A fork release in the served layout: runtime/ and profiles/ (binaries and the release's own manifests). */
function release(edit: (r: Record<string, any>) => void = () => {}) {
  const files = new Map<string, Buffer>([...binaries].filter(([rel]) => groupOf(rel) !== "snapshots"));
  files.set("runtime/runtime-manifest.json", Buffer.from(JSON.stringify(runtimeManifest)));
  files.set("profiles/core.manifest.json", Buffer.from(JSON.stringify(coreManifest)));
  const r: Record<string, any> = {
    schema: "lean4-wasm64.release/v1", id: "lean-test",
    runtime: { buildId, manifest: "runtime/runtime-manifest.json" },
    hosting: { layout: "served", mount: { "/runtime/": "runtime/", "/profiles/": "profiles/" }, siteOwned: ["/profiles/index.json", "/snapshots/"] },
    files: [...files].map(([p, b]) => ({ path: p, bytes: b.length, sha256: sha(b) })),
  };
  edit(r);
  files.set("release.json", Buffer.from(JSON.stringify(r)));
  return files;
}
function serve(prefix: string, files: Iterable<readonly [string, Buffer]>) { for (const [rel, b] of files) served.set(`${prefix}${rel}`, b); }
function releaseDir(files = release()): string {
  const d = fs.mkdtempSync(path.join(tmp, "release-"));
  writeTree(d, files);
  return d;
}
/** Every file under `dir`, relative, sorted. */
function list(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
  walk(dir);
  return out.sort();
}
const outDir = () => path.join(fs.mkdtempSync(path.join(tmp, "out-")), "public");
const origin = () => `${base}/site/`;

async function run(opts: Partial<FetchOptions> & { out: string; manifests: string }) {
  const lines: string[] = [];
  try {
    const stats = await fetchArtifacts({ origin: origin(), log: (l) => lines.push(l), ...opts });
    return { code: 0, stats, lines, message: "" };
  } catch (e) {
    const err = e as Error & { code?: number };
    return { code: err.code ?? -1, stats: null, lines, message: err.message };
  }
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-fetch-artifacts-"));
  server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url!, "http://x").pathname);
    hits.push(p);
    const st = stalls.get(p);
    if (st) { res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.total }); res.write(st.head); stalled.add(res); return; }
    const b = served.get(p);
    if (!b) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": b.length });
    res.end(b);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const r of stalled) r.destroy();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  for (const r of stalled) r.destroy();
  stalled.clear();
  stalls.clear();
  served.clear();
  hits.length = 0;
  serve("/site/", binaries);
  serve("/rel/", release());
});

describe("planFromManifests", () => {
  test("names every chunk, part and snapshot with its pin, the whole files, and the digest-named runtime manifest", async () => {
    const plan = await planFromManifests(manifestsDir(), ["runtime", "profiles", "snapshots"]);
    expect(plan.items.map((i) => i.rel).sort()).toEqual([...binaries.keys()].sort());
    for (const i of plan.items) expect([i.bytes, i.sha256]).toEqual([binaries.get(i.rel)!.length, sha(binaries.get(i.rel)!)]);
    expect(plan.wholes.map((w) => [w.label, w.rels.length])).toEqual([["runtime lean.js", 2], ["runtime lean.wasm", 1], ["core transport", 2]]);
    expect(plan.copies.map((c) => c.rel)).toEqual([...COPIES.keys()]);
    for (const c of plan.copies) expect(Buffer.from(c.data).toString("utf8"), c.rel).toBe(COPIES.get(c.rel));
    expect(plan.copies.map((c) => [c.group, c.from])).toEqual([["runtime", "runtime/runtime-manifest.json"]]);
    expect(plan.buildId).toBe(buildId);
    // the snapshots and profiles groups write no copy (D2: no per-build index copies)
    expect((await planFromManifests(manifestsDir(), ["profiles", "snapshots"])).copies).toEqual([]);
    expect((await planFromManifests(manifestsDir(), ["snapshots"])).items.map((i) => i.rel)).toEqual([snapUrl.slice(1)]);
  });

  test("--only parses a comma list of the three groups, in a fixed order", () => {
    expect(parseOnly(undefined)).toEqual(["runtime", "profiles", "snapshots"]);
    expect(parseOnly("snapshots,runtime")).toEqual(["runtime", "snapshots"]);
    expect(parseOnly("runtime,bogus")).toBeNull();
    expect(parseOnly(",")).toBeNull();
  });
});

describe("fetchArtifacts", () => {
  test("happy path from an http origin: every binary byte for byte, the digest-named manifest copy, no temp files", async () => {
    const out = outDir();
    const r = await run({ out, manifests: manifestsDir() });
    expect(r.message).toBe("");
    expect(r.stats).toEqual({ files: binaries.size + COPIES.size, bytes: [...binaries.values()].reduce((s, b) => s + b.length, 0) + copyBytes, fetched: binaries.size + COPIES.size, present: 0 });
    expect(list(out)).toEqual([...binaries.keys(), ...COPIES.keys()].sort());
    for (const [rel, b] of binaries) expect(fs.readFileSync(path.join(out, rel)).equals(b), rel).toBe(true);
    for (const [rel, text] of COPIES) expect(fs.readFileSync(path.join(out, rel), "utf8"), rel).toBe(text);
    expect(r.lines).toContain(`fetch-artifacts: wrote runtime/runtime-manifest.${buildId}.json (${Buffer.byteLength(COPIES.get(`runtime/runtime-manifest.${buildId}.json`)!)} bytes, the tracked runtime/runtime-manifest.json)`);
    expect(hits.every((h) => h.startsWith("/site/"))).toBe(true);
    expect(r.lines).toContain(`fetch-artifacts: runtime: 3 files, 168 bytes from ${origin()}`);
    expect(r.lines.filter((l) => l.startsWith("fetch-artifacts: verified "))).toHaveLength(3);
    // every progress line is one of the contract's stderr markers
    const markers = SPECS["fetch-artifacts"]!.markers.filter((m) => m.stream === "stderr");
    for (const line of r.lines) expect(markers.some((m) => m.regex.test(line)), line).toBe(true);
  });

  test("skip-if-present: a second run fetches nothing; a corrupted file is replaced", async () => {
    const out = outDir();
    const manifests = manifestsDir();
    expect((await run({ out, manifests })).code).toBe(0);
    hits.length = 0;
    const again = await run({ out, manifests });
    expect(again.stats).toMatchObject({ files: binaries.size + COPIES.size, fetched: 0, present: binaries.size + COPIES.size });
    expect(hits).toEqual([]);
    const victim = [...binaries.keys()].find((k) => k.startsWith("profiles/"))!;
    fs.writeFileSync(path.join(out, victim), "tampered");
    const third = await run({ out, manifests });
    expect(third.stats).toMatchObject({ fetched: 1, present: binaries.size + COPIES.size - 1 });
    expect(third.lines).toContain(`fetch-artifacts: replacing ${victim}: the file there does not match its pin`);
    expect(fs.readFileSync(path.join(out, victim)).equals(binaries.get(victim)!)).toBe(true);
    expect(hits).toEqual([`/site/${victim}`]);
  });

  test("a digest mismatch deletes the temp file, writes nothing under the final name, and fails (1) naming the file", async () => {
    const victim = runtimeManifest.files["lean.wasm"]!.chunks[0]!.url.slice(1);
    const wrong = Buffer.from(binaries.get(victim)!);
    wrong[3] = wrong[3]! ^ 1;
    served.set(`/site/${victim}`, wrong);
    const out = outDir();
    const r = await run({ out, manifests: manifestsDir(), only: ["runtime"] });
    expect(r.code).toBe(1);
    expect(r.message).toBe(`${victim}: digest mismatch (sha256 ${sha(wrong)}; the manifest pins ${sha(binaries.get(victim)!)})`);
    expect(fs.existsSync(path.join(out, victim))).toBe(false);
    expect(list(out).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // a longer body is cut off at the pinned size
    served.set(`/site/${victim}`, Buffer.concat([binaries.get(victim)!, Buffer.from("x")]));
    const longer = await run({ out, manifests: manifestsDir(), only: ["runtime"] });
    expect([longer.code, longer.message]).toEqual([1, `${victim}: size mismatch (more than the 64 bytes the manifest pins)`]);
    expect(list(out).filter((f) => f.endsWith(".tmp") || f === victim)).toEqual([]);
  });

  test("a 404 fails (1) naming the file and the URL", async () => {
    served.delete(`/site${snapUrl}`);
    const out = outDir();
    const r = await run({ out, manifests: manifestsDir(), only: ["snapshots"] });
    expect(r.code).toBe(1);
    expect(r.message).toBe(`${snapUrl.slice(1)}: HTTP 404 from ${origin()}${snapUrl.slice(1)}`);
    expect(list(out)).toEqual([]);
  });

  test("a partial release (--only runtime from an http release) writes the runtime only and never asks the origin", async () => {
    const out = outDir();
    const r = await run({ out, manifests: manifestsDir(), only: ["runtime"], release: `${base}/rel` });
    expect(r.message).toBe("");
    expect(list(out)).toEqual([...[...binaries.keys()].filter((k) => k.startsWith("runtime/")), `runtime/runtime-manifest.${buildId}.json`].sort());
    expect(hits.filter((h) => h.startsWith("/site/"))).toEqual([]);
    expect(hits).toContain("/rel/release.json");
    expect(r.lines).toContain(`fetch-artifacts: runtime: 3 files, 168 bytes from ${base}/rel/`);
  });

  test("--release from a local dir: runtime and profiles from the release, snapshots (site-owned) from the origin", async () => {
    const rel = releaseDir();
    const out = outDir();
    const r = await run({ out, manifests: manifestsDir(), release: rel });
    expect(r.message).toBe("");
    expect(r.stats?.fetched).toBe(binaries.size + COPIES.size);
    for (const [p, b] of binaries) expect(fs.readFileSync(path.join(out, p)).equals(b), p).toBe(true);
    expect(hits).toEqual([`/site${snapUrl}`]);
    expect(r.lines).toContain(`fetch-artifacts: profiles: 2 files, 81 bytes from ${rel}`);
  });

  test("a release that pins a file differently, carries another runtime, or has another schema fails (1) before any write", async () => {
    const victim = coreManifest.content.pack.transport.parts[1]!.url.slice(1);
    const cases: [(r: Record<string, any>) => void, string][] = [
      [(r) => { r.files.find((f: { path: string }) => f.path === victim).sha256 = "f".repeat(64); },
        `${victim}: release lean-test lists ${victim} as sha256 ${"f".repeat(64)} (17 bytes); the tracked manifest pins ${sha(parts[1]!)} (17 bytes)`],
      [(r) => { r.files = r.files.filter((f: { path: string }) => f.path !== victim); }, `${victim}: release lean-test does not list ${victim} in files[]`],
      [(r) => { r.runtime.buildId = "wasm64-0000000000000000"; }, `release lean-test carries runtime wasm64-0000000000000000; the tracked manifests pin ${buildId}`],
      [(r) => { r.schema = "lean4-wasm64.release/v0"; }, 'release.json schema is "lean4-wasm64.release/v0", not lean4-wasm64.release/v1'],
      // runtime.schema (additive in lean4-wasm64.release/v1, absent = v1) must be the tracked manifest's (architecture review M3)
      [(r) => { r.runtime.schema = "org.lean-browser64.runtime/v2"; }, "release lean-test carries a runtime of schema org.lean-browser64.runtime/v2; the tracked runtime manifest's is org.lean-browser64.runtime/v1"],
    ];
    const none = await run({ out: outDir(), manifests: manifestsDir(), only: ["runtime"], release: `${base}/no-release` });
    expect([none.code, none.message]).toEqual([1, `release.json: HTTP 404 from ${base}/no-release/release.json`]);
    for (const [edit, message] of cases) {
      const out = outDir();
      const r = await run({ out, manifests: manifestsDir(), only: ["runtime", "profiles"], release: releaseDir(release(edit)) });
      expect([r.code, r.message]).toEqual([1, message]);
      expect(list(out)).toEqual([]);
    }
  });

  test("refuses (2) to write outside the root: a manifest URL that climbs out, a symlink out of the tree", async () => {
    const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
    const climbing = manifestsDir(({ snapshots }) => { snapshots.snapshots[0]!.url = `/snapshots/../../${path.basename(outside)}/x.snapz`; });
    const out = outDir();
    const a = await run({ out, manifests: climbing, only: ["snapshots"] });
    expect(a.code).toBe(2);
    expect(a.message).toMatch(/names "\/snapshots\/\.\.\/\.\.\/outside-\w+\/x\.snapz", not a file directly under \/snapshots\/: refusing to write outside the tree$/);
    const linked = outDir();
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(outside, path.join(linked, "snapshots"));
    const b = await run({ out: linked, manifests: manifestsDir(), only: ["snapshots"] });
    expect([b.code, b.message]).toEqual([2, `${snapUrl.slice(1)} resolves outside --out ${linked}: refusing to write there`]);
    expect(list(outside)).toEqual([]);
    expect(hits).toEqual([]);
  });

  test("a temp file a dead process left beside a target is deleted first; a live process's, and other names, are left alone", async () => {
    const out = outDir();
    const dir = path.join(out, "snapshots");
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(snapUrl);
    const dead = `.${name}.99999999-deadbeef.tmp`;
    const live = `.${name}.${process.ppid}-0badf00d.tmp`;
    const other = ".other.snapz.99999999-deadbeef.tmp";
    for (const f of [dead, live, other]) fs.writeFileSync(path.join(dir, f), "partial");
    const r = await run({ out, manifests: manifestsDir(), only: ["snapshots"] });
    expect(r.message).toBe("");
    expect(r.lines).toContain(`fetch-artifacts: removed snapshots/${dead}, a temp file left by process 99999999`);
    expect(r.lines.filter((l) => l.includes(" removed "))).toHaveLength(1);
    expect(list(out)).toEqual([`snapshots/${live}`, `snapshots/${other}`, snapUrl.slice(1)].sort());
    const markers = SPECS["fetch-artifacts"]!.markers.filter((m) => m.stream === "stderr");
    for (const line of r.lines) expect(markers.some((m) => m.regex.test(line)), line).toBe(true);
  });

  test("--with-manifests also writes the tracked manifests; a missing manifest tree refuses (2)", async () => {
    const out = outDir();
    const manifests = manifestsDir();
    expect((await run({ out, manifests, only: ["profiles", "snapshots"], withManifests: true })).code).toBe(0);
    for (const f of ["profiles/index.json", "profiles/core.manifest.json", "snapshots/index.json"]) {
      expect(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(manifests, f))), f).toBe(true);
    }
    const r = await run({ out: outDir(), manifests: path.join(tmp, "no-such-dir") });
    expect(r.code).toBe(2);
    expect(r.message).toMatch(/^no tracked manifest .*no-such-dir\/runtime\/runtime-manifest\.json \(ENOENT\); pass --manifests <dir>, a QED64 checkout's public\/$/);
  });
});

describe("a v2 (gzip) runtime manifest (org.lean-browser64.runtime/v2, architecture review M3)", () => {
  // The v2 shape: each file's parts are gzip members of its decoded slices, every slice but the last exactly 16 MiB;
  // a part's bytes/sha256 are as served, its decodedBytes and the file's bytes/sha256 over the inflated bytes.
  const V2 = "org.lean-browser64.runtime/v2";
  const SLICE = 16 << 20;
  const raw = { "lean.js": [Buffer.concat(lj)], "lean.wasm": [Buffer.alloc(SLICE, "lean.wasm-v2;"), bytes("lean.wasm-v2-tail", 70)] };
  const wire = { "lean.js": raw["lean.js"].map((b) => gzipSync(b, { level: 9 })), "lean.wasm": raw["lean.wasm"].map((b) => gzipSync(b, { level: 9 })) };
  const v2BuildId = `wasm64-${sha(Buffer.concat(raw["lean.wasm"])).slice(0, 16)}`;
  const v2Manifest = {
    schema: V2,
    buildId: v2BuildId,
    leanVersion: "0.0.0-test",
    files: Object.fromEntries((["lean.js", "lean.wasm"] as const).map((name) => {
      const whole = Buffer.concat(raw[name]);
      return [name, {
        bytes: whole.length, sha256: sha(whole), encoding: "gzip" as string | undefined,
        chunks: wire[name].map((b, i) => ({ url: chunkUrl(name, b, i), bytes: b.length, sha256: sha(b), decodedBytes: raw[name][i]!.length as number | undefined })),
      }];
    })),
  };
  type V2Manifest = typeof v2Manifest;
  const v2Parts = (["lean.js", "lean.wasm"] as const).flatMap((name) => v2Manifest.files[name]!.chunks.map((c, i) => [c.url.slice(1), wire[name][i]!] as const));
  /** The tracked manifests (manifestsDir) with the runtime manifest replaced by the (edited) v2 one. */
  const v2Dir = (edit: (rt: V2Manifest) => void = () => {}) => {
    const d = manifestsDir();
    const rt = structuredClone(v2Manifest);
    edit(rt);
    fs.writeFileSync(path.join(d, "runtime/runtime-manifest.json"), JSON.stringify(rt, null, 2));
    return d;
  };
  const wasmTail = v2Manifest.files["lean.wasm"]!.chunks[1]!.url.slice(1);
  beforeEach(() => serve("/site/", v2Parts));

  test("the plan: the served parts are the items, a gzip file's whole carries its encoding and each part's decoded size", async () => {
    const plan = await planFromManifests(v2Dir(), ["runtime"]);
    expect(plan.runtimeSchema).toBe(V2);
    expect(plan.buildId).toBe(v2BuildId);
    expect(plan.items.map((i) => [i.rel, i.bytes, i.sha256])).toEqual(v2Parts.map(([rel, b]) => [rel, b.length, sha(b)]));
    expect(plan.wholes).toEqual((["lean.js", "lean.wasm"] as const).map((name) => ({
      label: `runtime ${name}`, rels: v2Manifest.files[name]!.chunks.map((c) => c.url.slice(1)),
      bytes: Buffer.concat(raw[name]).length, sha256: sha(Buffer.concat(raw[name])), encoding: "gzip", decoded: raw[name].map((b) => b.length),
    })));
    // v1, with or without a schema: no encoding on the wholes, read as v1
    const v1 = await planFromManifests(manifestsDir(), ["runtime"]);
    expect(v1.runtimeSchema).toBe("org.lean-browser64.runtime/v1");
    for (const w of v1.wholes) expect(Object.keys(w).sort()).toEqual(["bytes", "label", "rels", "sha256"]);
    const bare = await planFromManifests(manifestsDir(({ runtime }) => { delete (runtime as { schema?: string }).schema; }), ["runtime"]);
    expect(bare.runtimeSchema).toBe("org.lean-browser64.runtime/v1");
  });

  test("happy path: the gzip parts land as served, each whole file verified over its inflated parts", async () => {
    const out = outDir();
    const r = await run({ out, manifests: v2Dir(), only: ["runtime"] });
    expect(r.message).toBe("");
    for (const [rel, b] of v2Parts) expect(fs.readFileSync(path.join(out, rel)).equals(b), rel).toBe(true);
    expect(list(out)).toEqual([...v2Parts.map(([rel]) => rel), `runtime/runtime-manifest.${v2BuildId}.json`].sort());
    const wasm = Buffer.concat(raw["lean.wasm"]);
    expect(r.lines).toContain(`fetch-artifacts: verified runtime lean.wasm (${wasm.length} bytes, sha256 ${sha(wasm).slice(0, 16)}…, 2 parts)`);
    expect(r.lines).toContain(`fetch-artifacts: verified runtime lean.js (${raw["lean.js"][0]!.length} bytes, sha256 ${sha(raw["lean.js"][0]!).slice(0, 16)}…, 1 parts)`);
    const markers = SPECS["fetch-artifacts"]!.markers.filter((m) => m.stream === "stderr");
    for (const line of r.lines) expect(markers.some((m) => m.regex.test(line)), line).toBe(true);
    // from a release that records the schema (release.json runtime.schema), and refused from one that records none (v1)
    const v2Release = (schema?: string) => {
      const files = new Map<string, Buffer>(v2Parts);
      const rj = {
        schema: "lean4-wasm64.release/v1", id: "lean-test-v2",
        runtime: { buildId: v2BuildId, manifest: "runtime/runtime-manifest.json", ...(schema ? { schema } : {}) },
        hosting: { layout: "served", mount: { "/runtime/": "runtime/" }, siteOwned: ["/profiles/index.json", "/snapshots/"] },
        files: [...files].map(([p, b]) => ({ path: p, bytes: b.length, sha256: sha(b) })),
      };
      files.set("release.json", Buffer.from(JSON.stringify(rj)));
      return releaseDir(files);
    };
    hits.length = 0;
    const fromRelease = await run({ out: outDir(), manifests: v2Dir(), only: ["runtime"], release: v2Release(V2) });
    expect([fromRelease.code, fromRelease.message]).toEqual([0, ""]);
    expect(hits).toEqual([]);
    const unrecorded = outDir();
    const v1Release = await run({ out: unrecorded, manifests: v2Dir(), only: ["runtime"], release: v2Release() });
    expect([v1Release.code, v1Release.message]).toEqual([1, `release lean-test-v2 carries a runtime of schema org.lean-browser64.runtime/v1; the tracked runtime manifest's is ${V2}`]);
    expect(list(unrecorded)).toEqual([]);
  });

  test("a part that inflates to another size than its decodedBytes, or does not inflate, fails (1) naming the part", async () => {
    // the tail's decodedBytes (and so the file's bytes) one more than it inflates to: the plan is well-formed, the bytes are not
    const off = await run({ out: outDir(), manifests: v2Dir((rt) => { rt.files["lean.wasm"]!.chunks[1]!.decodedBytes! += 1; rt.files["lean.wasm"]!.bytes += 1; }), only: ["runtime"] });
    expect([off.code, off.message]).toEqual([1, `runtime lean.wasm: ${wasmTail} inflates to 70 bytes; the manifest pins 71`]);
    // a part served as pinned (its own sha256 and size) that is not a gzip member
    const plain = raw["lean.js"][0]!;
    const plainUrl = chunkUrl("lean.js", plain, 0);
    served.set(`/site${plainUrl}`, plain);
    const notGzip = await run({ out: outDir(), manifests: v2Dir((rt) => { Object.assign(rt.files["lean.js"]!.chunks[0]!, { url: plainUrl, bytes: plain.length, sha256: sha(plain) }); }), only: ["runtime"] });
    expect(notGzip.code).toBe(1);
    expect(notGzip.message).toMatch(new RegExp(`^runtime lean\\.js: ${plainUrl.slice(1).replace(/\./g, "\\.")} does not inflate \\(`));
  });

  test("refuses (2) before any request or write: a schema it does not read, an encoding or decodedBytes the schema does not allow", async () => {
    const file = (d: string) => path.join(d, "runtime/runtime-manifest.json");
    const cases: [string, string][] = [];
    const add = (manifests: string, why: string) => cases.push([manifests, why]);
    add(v2Dir((rt) => { rt.schema = "org.lean-browser64.runtime/v9"; }), 'runtime manifest schema "org.lean-browser64.runtime/v9" is not one this tool reads (org.lean-browser64.runtime/v1, org.lean-browser64.runtime/v2)');
    add(v2Dir((rt) => { rt.files["lean.wasm"]!.encoding = "br"; }), `lean.wasm: encoding "br" is not one ${V2} allows (identity, gzip)`);
    add(v2Dir((rt) => { delete rt.files["lean.js"]!.encoding; }), `lean.js: encoding (none) is not one ${V2} allows (identity, gzip)`);
    add(v2Dir((rt) => { delete rt.files["lean.js"]!.chunks[0]!.decodedBytes; }), "lean.js: chunk 0 has no usable decodedBytes (none)");
    // every part but the last decodes to exactly 16 MiB (the v1 chunk size), even when the sum is right
    add(v2Dir((rt) => { rt.files["lean.wasm"]!.chunks[0]!.decodedBytes! -= 1; rt.files["lean.wasm"]!.chunks[1]!.decodedBytes! += 1; }),
      `lean.wasm: chunk 0 decodes to ${SLICE - 1} bytes; every part but the last decodes to exactly ${SLICE}, the last to at most that`);
    add(v2Dir((rt) => { rt.files["lean.js"]!.chunks[0]!.decodedBytes! += 1; }), `lean.js: its parts decode to ${raw["lean.js"][0]!.length + 1} bytes, the file is ${raw["lean.js"][0]!.length}`);
    add(v2Dir((rt) => { rt.files["lean.js"]!.encoding = "identity"; }),
      `lean.js: chunk 0 is identity-encoded, but its decodedBytes ${raw["lean.js"][0]!.length} is not its bytes ${wire["lean.js"][0]!.length}`);
    // v1 allows identity only (absent = identity)
    add(manifestsDir(({ runtime }) => { Object.assign(runtime.files["lean.js"]!, { encoding: "gzip" }); }), 'lean.js: encoding "gzip" is not one org.lean-browser64.runtime/v1 allows (identity)');
    for (const [manifests, why] of cases) {
      hits.length = 0;
      const out = outDir();
      const r = await run({ out, manifests, only: ["runtime"] });
      expect([r.code, r.message], why).toEqual([2, `${file(manifests)}: ${why}`]);
      expect(list(out)).toEqual([]);
      expect(hits).toEqual([]);
    }
  });
});

describe("the CLI", () => {
  test("main(): one stdout summary line; a malformed --only exits 2", async () => {
    const io = { out: [] as string[], err: [] as string[] };
    const sink = { out: (s: string) => io.out.push(s), err: (s: string) => io.err.push(s) };
    const out = outDir();
    expect(await main(["--out", out, "--manifests", manifestsDir(), "--origin", origin(), "--only", "snapshots"], sink)).toBe(0);
    expect(io.out).toEqual([`FETCH OK 1 files, ${snapz.length} bytes (1 fetched, 0 already present)`]);
    io.out.length = 0;
    expect(await main(["--out", out, "--only", "runtime,bogus"], sink)).toBe(2);
    expect(io.out).toEqual(["FETCH FAILED --only runtime,bogus: not a comma list of runtime, profiles, snapshots"]);
    expect(list(out)).toEqual([snapUrl.slice(1)]);
  });

  test("the default --out inside node_modules (an installed package) refuses (2) before anything is read, fetched or written", async () => {
    const io = { out: [] as string[], err: [] as string[] };
    const sink = { out: (s: string) => io.out.push(s), err: (s: string) => io.err.push(s) };
    // Never created: the guard fires on the path alone.
    const consumer = path.join(tmp, "consumer-never-created");
    const installed = path.join(consumer, "node_modules", "qed64");
    const manifests = manifestsDir();
    expect(await main(["--manifests", manifests, "--origin", origin()], sink, { repoRoot: installed })).toBe(2);
    expect(io.out).toEqual([`FETCH FAILED the default --out ${path.join(installed, "public")} is inside node_modules (an installed package); pass --out <dir>`]);
    expect(io.err).toEqual([]);
    expect(fs.existsSync(consumer)).toBe(false);
    expect(hits).toEqual([]);
    // an explicit --out is not refused, whatever the package root
    io.out.length = 0;
    const out = outDir();
    expect(await main(["--out", out, "--manifests", manifests, "--origin", origin(), "--only", "snapshots"], sink, { repoRoot: installed })).toBe(0);
    expect(list(out)).toEqual([snapUrl.slice(1)]);
  });

  test("FETCH FAILED is one stdout line even when the reason quotes a newline (a release.json that is an HTML page)", async () => {
    const io = { out: [] as string[], err: [] as string[] };
    const sink = { out: (s: string) => io.out.push(s), err: (s: string) => io.err.push(s) };
    const rel = releaseDir(new Map([["release.json", Buffer.from("\n<html>")]]));
    const out = outDir();
    expect(await main(["--out", out, "--manifests", manifestsDir(), "--release", rel, "--only", "runtime"], sink)).toBe(1);
    const failedMarker = SPECS["fetch-artifacts"]!.markers.find((m) => m.id === "failed")!;
    expect(io.out).toHaveLength(1);
    expect(io.out[0]).not.toMatch(/[\r\n]/);
    expect(io.out[0]).toMatch(failedMarker.regex);
    expect(io.out[0]).toMatch(/^FETCH FAILED release\.json: .*<html>/);
    expect(list(out)).toEqual([]);
    expect(oneLine("a\n  b \r\n\nc")).toBe("a b c");
  });

  const exec = (args: string[], onSpawn: (child: ReturnType<typeof spawn>) => void = () => {}) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (d) => { stdout += d; });
      child.stderr!.on("data", (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
      onSpawn(child);
    });

  test.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("as a process, %s during a stalled download: its temp file is deleted, exit %i, one FETCH FAILED line", async (sig, code) => {
    const big = Buffer.alloc(4 << 20, "big.snapz;");
    const url = `/snapshots/big.${sha(big).slice(0, 16)}.snapz`;
    const manifests = manifestsDir(({ snapshots }) => { snapshots.snapshots[0] = { ...snapshots.snapshots[0]!, url, digest: `sha256:${sha(big)}`, transfer: big.length }; });
    stalls.set(`/site${url}`, { head: big.subarray(0, 1 << 20), total: big.length });
    const out = outDir();
    const temps = () => list(out).filter((f) => f.endsWith(".tmp"));
    const r = await exec(["--out", out, "--manifests", manifests, "--origin", origin(), "--only", "snapshots"], async (child) => {
      // wait until the first MiB is in the temp file, then interrupt
      for (const until = Date.now() + 15_000; Date.now() < until;) {
        const t = temps()[0];
        if (t && fs.statSync(path.join(out, t), { throwIfNoEntry: false })?.size === 1 << 20) break;
        await new Promise((res) => setTimeout(res, 25));
      }
      expect(temps()).toHaveLength(1);
      child.kill(sig);
    });
    expect([r.code, r.signal]).toEqual([code, null]);
    expect(r.stdout).toBe(`FETCH FAILED interrupted (${sig})\n`);
    expect(list(out)).toEqual([]);
  });

  test("as a process: exit 1 and FETCH FAILED on a 404, exit 0 and FETCH OK from a release dir", async () => {
    served.delete(`/site${snapUrl}`);
    const out = outDir();
    const a = await exec(["--out", out, "--manifests", manifestsDir(), "--origin", origin()]);
    expect(a.code).toBe(1);
    expect(a.stdout).toBe(`FETCH FAILED ${snapUrl.slice(1)}: HTTP 404 from ${origin()}${snapUrl.slice(1)}\n`);
    const b = await exec(["--out", out, "--manifests", manifestsDir(), "--release", releaseDir(), "--only=runtime,profiles"]);
    expect(b.code).toBe(0);
    expect(b.stdout).toMatch(/^FETCH OK 6 files, \d+ bytes \(\d+ fetched, \d+ already present\)\n$/);
    expect(b.stderr).not.toMatch(/WARNING/);
  });
});
