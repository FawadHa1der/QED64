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
import { fetchArtifacts, main, parseOnly, planFromManifests, type FetchOptions } from "../../pipeline/release/fetch-artifacts.mjs";
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
    const b = served.get(p);
    if (!b) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": b.length });
    res.end(b);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
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
    expect(plan.copies.map((c) => c.rel)).toEqual([`runtime/runtime-manifest.${buildId}.json`]);
    expect(plan.buildId).toBe(buildId);
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
    expect(r.stats).toEqual({ files: binaries.size + 1, bytes: [...binaries.values()].reduce((s, b) => s + b.length, 0) + Buffer.byteLength(JSON.stringify(runtimeManifest, null, 2)), fetched: binaries.size + 1, present: 0 });
    expect(list(out)).toEqual([...binaries.keys(), `runtime/runtime-manifest.${buildId}.json`].sort());
    for (const [rel, b] of binaries) expect(fs.readFileSync(path.join(out, rel)).equals(b), rel).toBe(true);
    expect(fs.readFileSync(path.join(out, `runtime/runtime-manifest.${buildId}.json`), "utf8")).toBe(JSON.stringify(runtimeManifest, null, 2));
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
    expect(again.stats).toMatchObject({ files: binaries.size + 1, fetched: 0, present: binaries.size + 1 });
    expect(hits).toEqual([]);
    const victim = [...binaries.keys()].find((k) => k.startsWith("profiles/"))!;
    fs.writeFileSync(path.join(out, victim), "tampered");
    const third = await run({ out, manifests });
    expect(third.stats).toMatchObject({ fetched: 1, present: binaries.size });
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
    expect(r.stats?.fetched).toBe(binaries.size + 1);
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

  test("as a process: exit 1 and FETCH FAILED on a 404, exit 0 and FETCH OK from a release dir", async () => {
    const exec = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
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
