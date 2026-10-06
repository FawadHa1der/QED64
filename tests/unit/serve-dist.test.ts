// scripts/serve-dist.mjs: the local production preview is a Node adapter over
// the live Worker's own code (infra/worker.js, or createWorker({}) with
// QED64_EDGE=hardened). In-process servers on 127.0.0.1:0 over a scratch
// dist/ and public/ under the OS temp dir (tiny files, a digest-named chunk
// behind a symlinked directory, symlinks in and out of dist/), closed after.
//
// PARITY: the same request matrix answered over HTTP by serve-dist and by the
// worker's fetch with in-memory bindings over the same bytes (written here,
// independently of serve-dist's fs-backed ones) must agree on status, headers
// (apart from content-length, etag, date and Node's connection headers) and
// body, in both modes.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import shipped from "../../infra/worker.js";
import { createWorker, isImmutable, parseRange, resolveRange } from "../../infra/edge-worker.js";
import type { EdgeWorker } from "../../infra/edge-worker.js";
import { createArtifactsBinding, createDistServer, RELEASE_ID, releaseDirProblem, startupLine, USAGE } from "../../scripts/serve-dist.mjs";
import type { EdgeMode } from "../../scripts/serve-dist.mjs";

const root = path.resolve(__dirname, "../..");
const SCRIPT = path.join(root, "scripts/serve-dist.mjs");
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";

const CHUNK = "/runtime/chunks/lean.wasm.0123456789abcdef0123.part-000";
const SNAPZ = "/snapshots/init.dca2763359db27e7.snapz";
const MANIFEST = "/runtime/runtime-manifest.json";
const PINNED = "/runtime/runtime-manifest.wasm64-dca2763359db27e7.json";
const SNAP_BYTES = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) % 256);
const CHUNK_BYTES = Uint8Array.from({ length: 1000 }, (_, i) => (i * 13) % 256);

// dist/ (pathname → bytes, content type as the live Workers assets send it)
const DIST: Record<string, { body: string; type: string }> = {
  "/index.html": { body: "<!doctype html>qed64", type: "text/html" },
  "/assets/index-AbCd1234.js": { body: "export {}", type: "text/javascript" },
  "/assets/app.css": { body: "body{}", type: "text/css" },
  "/assets/codicon.ttf": { body: "ttf", type: "font/ttf" },
  "/assets/frame-AbCd1234.html": { body: "<!doctype html>frame", type: "text/html" },
  "/qed64-build.json": { body: '{"schema":"qed64.build/v1"}', type: "application/json" },
  "/sub/index.html": { body: "<!doctype html>sub", type: "text/html" },
};
// public/ artifacts (R2 key → bytes, the content type rclone stores)
const ARTIFACTS: Record<string, { bytes: Uint8Array; type: string }> = {
  [MANIFEST.slice(1)]: { bytes: new TextEncoder().encode('{"buildId":"wasm64-dca2763359db27e7"}'), type: "application/json" },
  [PINNED.slice(1)]: { bytes: new TextEncoder().encode('{"pinned":true}'), type: "application/json" },
  [CHUNK.slice(1)]: { bytes: CHUNK_BYTES, type: "application/octet-stream" },
  [SNAPZ.slice(1)]: { bytes: SNAP_BYTES, type: "application/octet-stream" },
  "snapshots/index.json": { bytes: new TextEncoder().encode('{"snapshots":[]}'), type: "application/json" },
  "profiles/index.json": { bytes: new TextEncoder().encode('{"profiles":[]}'), type: "application/json" },
};
const EMBED_HOST = "<!doctype html><title>embed host (test)</title><iframe></iframe>";

let tmp = "";
let distDir = "";
let publicDir = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-serve-dist-"));
  distDir = path.join(tmp, "dist");
  publicDir = path.join(tmp, "public");
  const write = (file: string, data: string | Uint8Array) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };
  for (const [p, f] of Object.entries(DIST)) write(path.join(distDir, p), f.body);
  // outside dist/: a secret a symlink and an encoded traversal both try to reach
  write(path.join(tmp, "outside/secret.txt"), "secret");
  fs.symlinkSync(path.join(tmp, "outside/secret.txt"), path.join(distDir, "leak.txt"));
  fs.symlinkSync(path.join(tmp, "outside"), path.join(distDir, "leakdir"));
  fs.symlinkSync(path.join(distDir, "assets/app.css"), path.join(distDir, "inside-link.css"));
  // public/: runtime/chunks is a symlink into another tree (the worktree layout)
  for (const [key, a] of Object.entries(ARTIFACTS)) {
    if (key.startsWith("runtime/chunks/")) write(path.join(tmp, "main-checkout/chunks", key.slice("runtime/chunks/".length)), a.bytes);
    else write(path.join(publicDir, key), a.bytes);
  }
  fs.symlinkSync(path.join(tmp, "main-checkout/chunks"), path.join(publicDir, "runtime/chunks"));
  write(path.join(publicDir, "embed-host.html"), EMBED_HOST);
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ HTTP client
type Answer = { status: number; headers: Record<string, string>; body: Buffer };

async function withServer<T>(edge: EdgeMode, fn: (port: number) => Promise<T>): Promise<T> {
  const server = createDistServer({ dist: distDir, publicDir, edge });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn((server.address() as AddressInfo).port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function ask(port: number, method: string, rawPath: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port, method, path: rawPath, headers, agent: false }, (r) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: r.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) });
      });
    });
    q.on("error", reject);
    q.end(body);
  });
}

const isolated = (a: Answer) => {
  expect(a.headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(a.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(a.headers["cross-origin-resource-policy"]).toBe("same-origin");
};
const cacheRule = (p: string) => (isImmutable(p) ? IMMUTABLE : REVALIDATE);

// ------------------------------------------------------------------ headers per mode
describe.each(["legacy", "hardened"] as const)("serve-dist, edge=%s", (edge) => {
  test('"/" and a static asset: isolation, the cache rule, the live content types', async () => {
    await withServer(edge, async (port) => {
      const index = await ask(port, "GET", "/");
      expect(index.status).toBe(200);
      isolated(index);
      expect(index.headers["content-type"]).toBe("text/html");
      expect(index.headers["cache-control"]).toBe(REVALIDATE);
      expect(index.body.toString()).toBe(DIST["/index.html"]!.body);
      // as the live site: HTML carries neither a length nor an etag (other assets carry both)
      expect(index.headers["content-length"]).toBeUndefined();
      expect(index.headers["etag"]).toBeUndefined();

      const js = await ask(port, "GET", "/assets/index-AbCd1234.js");
      expect(js.status).toBe(200);
      isolated(js);
      expect(js.headers["content-type"]).toBe("text/javascript");
      expect(js.headers["cache-control"]).toBe(cacheRule("/assets/index-AbCd1234.js"));
      expect(js.headers["etag"]).toMatch(/^"[0-9a-f]{32}"$/);
      expect(js.headers["content-length"]).toBe("9");
      expect(js.body.toString()).toBe("export {}");
      const revalidated = await ask(port, "GET", "/assets/index-AbCd1234.js", { "if-none-match": js.headers["etag"]! });
      expect(revalidated.status).toBe(304);
      expect(revalidated.body.length).toBe(0);

      // the Workers html_handling default (auto-trailing-slash)
      const redirect = await ask(port, "GET", "/index.html?x=1");
      expect(redirect.status).toBe(307);
      expect(redirect.headers["location"]).toBe("/?x=1");
      expect((await ask(port, "GET", "/sub/")).body.toString()).toBe("<!doctype html>sub");
      expect((await ask(port, "GET", "/sub")).headers["location"]).toBe("/sub/");
      expect((await ask(port, "GET", "/assets/frame-AbCd1234.html")).headers["location"]).toBe("/assets/frame-AbCd1234");
      expect((await ask(port, "GET", "/assets/frame-AbCd1234")).body.toString()).toBe("<!doctype html>frame");
      // a symlink that stays inside dist/ is served
      expect((await ask(port, "GET", "/inside-link.css")).body.toString()).toBe("body{}");
    });
  });

  test("artifacts: immutable for a digest-named path, must-revalidate for a manifest (the worker's isImmutable)", async () => {
    expect(isImmutable(CHUNK)).toBe(true);
    expect(isImmutable(SNAPZ)).toBe(true);
    expect(isImmutable(MANIFEST)).toBe(false);
    expect(isImmutable(PINNED)).toBe(false);
    await withServer(edge, async (port) => {
      for (const p of [CHUNK, SNAPZ, MANIFEST, PINNED, "/snapshots/index.json", "/profiles/index.json"]) {
        const a = await ask(port, "GET", p);
        const want = ARTIFACTS[p.slice(1)]!;
        expect(a.status, p).toBe(200);
        isolated(a);
        expect(a.headers["cache-control"], p).toBe(cacheRule(p));
        expect(a.headers["content-type"], p).toBe(want.type);
        expect(a.headers["etag"], p).toMatch(/^"[0-9a-f]{32}"$/);
        // live R2 bodies carry their length, legacy mode included
        expect(a.headers["content-length"], p).toBe(String(want.bytes.length));
        expect(Buffer.compare(a.body, Buffer.from(want.bytes)), p).toBe(0);
      }
      // the chunk came through public/runtime/chunks, a symlink out of public/
      expect(fs.lstatSync(path.join(publicDir, "runtime/chunks")).isSymbolicLink()).toBe(true);
    });
  });

  test("404 for a missing asset and a missing artifact", async () => {
    await withServer(edge, async (port) => {
      const asset = await ask(port, "GET", "/assets/missing-AbCd1234.js");
      expect(asset.status).toBe(404);
      isolated(asset);
      expect(asset.headers["content-type"]).toBeUndefined(); // the live assets 404: empty, no type
      expect(asset.headers["content-length"]).toBe("0");
      const artifact = await ask(port, "GET", "/runtime/chunks/missing.part-000");
      expect(artifact.status).toBe(404);
      isolated(artifact);
      expect(artifact.headers["content-type"]).toBe("text/plain;charset=UTF-8");
      expect(artifact.headers["content-length"]).toBe("9");
      // a release-mapped miss is never cached, in either mode (the shipped worker's toolchain release)
      expect(artifact.headers["cache-control"]).toBe("no-store");
      // a site-owned miss keeps legacy's path rule (errorCacheControl null), no-store when hardened
      const snapshot = await ask(port, "GET", "/snapshots/missing.dca2763359db27e7.snapz");
      expect([snapshot.status, snapshot.headers["cache-control"]]).toEqual([404, edge === "legacy" ? IMMUTABLE : "no-store"]);
      expect((await ask(port, "GET", "/runtime/")).status).toBe(404);
      expect((await ask(port, "GET", "/runtime/chunks")).status).toBe(404); // a directory is no R2 object
      expect((await ask(port, "GET", "/favicon.ico")).status).toBe(404);
    });
  });

  test("HEAD: no body; Content-Length as the live site (legacy: none) or the hardened switches give it", async () => {
    await withServer(edge, async (port) => {
      const art = await ask(port, "HEAD", SNAPZ);
      expect(art.status).toBe(200);
      expect(art.body.length).toBe(0);
      isolated(art);
      expect(art.headers["content-type"]).toBe("application/octet-stream");
      expect(art.headers["content-length"]).toBe(edge === "legacy" ? undefined : String(SNAP_BYTES.length));
      const asset = await ask(port, "HEAD", "/assets/index-AbCd1234.js");
      expect(asset.status).toBe(200);
      expect(asset.body.length).toBe(0);
      expect(asset.headers["content-type"]).toBe("text/javascript");
      expect(asset.headers["content-length"]).toBe(edge === "legacy" ? undefined : "9");
      expect(asset.headers["transfer-encoding"]).toBeUndefined();
      expect((await ask(port, "HEAD", "/nope.js")).status).toBe(404);
    });
  });

  test("traversal is refused: encoded %2e%2e and %2f, and symlinks pointing outside dist/", async () => {
    await withServer(edge, async (port) => {
      for (const p of [
        "/%2e%2e/outside/secret.txt",
        "/%2E%2E/%2e%2e/outside/secret.txt",
        "/..%2foutside%2fsecret.txt",
        "/assets/..%2f..%2foutside%2fsecret.txt",
        "/assets/%2e%2e%2f%2e%2e%2foutside/secret.txt",
        "/..%5coutside%5csecret.txt",
        "/../outside/secret.txt",
        "/leak.txt",
        "/leakdir/secret.txt",
        "/snapshots/..%2f..%2foutside%2fsecret.txt",
        "/snapshots/%2e%2e/%2e%2e/outside/secret.txt",
      ]) {
        const a = await ask(port, "GET", p);
        expect(a.status, p).toBe(404);
        expect(a.body.toString(), p).not.toContain("secret");
      }
    });
  });

  test("doubled slashes collapse in one 307 (as live) and no Location is protocol-relative; /index is /", async () => {
    await withServer(edge, async (port) => {
      const want: Record<string, string> = {
        "//assets/frame-AbCd1234.html": "/assets/frame-AbCd1234",
        "//assets/frame-AbCd1234.html?x=1": "/assets/frame-AbCd1234?x=1",
        "//assets/app.css": "/assets/app.css",
        "/assets//app.css": "/assets/app.css",
        "/%2Fassets/app.css": "/assets/app.css",
        "//sub": "/sub/",
        "//sub/": "/sub/",
        "//sub/index.html": "/sub/",
        "//index.html": "/",
        "//": "/",
        "/index": "/",
        "/index?x=1": "/?x=1",
        "/sub/index": "/sub/",
        "//sub/index": "/sub/",
      };
      for (const [p, location] of Object.entries(want)) {
        for (const method of ["GET", "HEAD"]) {
          const a = await ask(port, method, p);
          expect(a.status, `${method} ${p}`).toBe(307);
          isolated(a);
          expect(a.headers["location"], `${method} ${p}`).toBe(location);
        }
      }
      for (const p of [...PATHS, ...Object.keys(want), "///assets//frame-AbCd1234.html", "//nope.html", "//x/"]) {
        const a = await ask(port, "GET", p);
        expect(a.headers["location"] ?? "", p).not.toMatch(/^\/\//);
      }
      expect((await ask(port, "GET", "//nope.html")).status).toBe(404);
    });
  });

  test("a file that stats but cannot be opened: 500 with the isolation headers, not a reset", async () => {
    if (process.getuid?.() === 0) return; // root opens a mode-000 file
    const lockedArtifact = path.join(publicDir, "snapshots/locked.0123456789abcdef.snapz");
    const lockedAsset = path.join(distDir, "assets/locked-AbCd1234.js");
    const lockedHtml = path.join(distDir, "locked.html");
    for (const f of [lockedArtifact, lockedAsset, lockedHtml]) {
      fs.writeFileSync(f, "x");
      fs.chmodSync(f, 0o000);
    }
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
    try {
      await withServer(edge, async (port) => {
        for (const p of ["/snapshots/locked.0123456789abcdef.snapz", "/assets/locked-AbCd1234.js", "/locked"]) {
          const a = await ask(port, "GET", p);
          expect(a.status, p).toBe(500);
          isolated(a);
          expect(a.body.toString(), p).toBe("internal error");
          expect(errors.some((e) => e.includes(p) && e.includes("EACCES")), p).toBe(true);
        }
        // legacy HEAD on an artifact reads it with get() too
        if (edge === "legacy") expect((await ask(port, "HEAD", "/snapshots/locked.0123456789abcdef.snapz")).status).toBe(500);
      });
    } finally {
      spy.mockRestore();
      for (const f of [lockedArtifact, lockedAsset, lockedHtml]) fs.rmSync(f, { force: true });
    }
  });

  test("/embed-host.html comes from public/ with the isolation headers (Node layer, not the worker)", async () => {
    await withServer(edge, async (port) => {
      const a = await ask(port, "GET", "/embed-host.html?src=%2F");
      expect(a.status).toBe(200);
      isolated(a);
      expect(a.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(a.body.toString()).toBe(EMBED_HOST);
      const head = await ask(port, "HEAD", "/embed-host.html");
      expect(head.status).toBe(200);
      expect(head.body.length).toBe(0);
    });
    // the worker alone has no such route
    const viaWorker = await shipped.fetch(new Request("http://x/embed-host.html"), { ASSETS: memAssets(), ARTIFACTS: memBucket() });
    expect(viaWorker.status).toBe(404);
  });
});

describe("Range", () => {
  test("hardened: 206 with Content-Range, a suffix range, 416 past the end", async () => {
    await withServer("hardened", async (port) => {
      const a = await ask(port, "GET", SNAPZ, { range: "bytes=0-0" });
      expect(a.status).toBe(206);
      isolated(a);
      expect(a.headers["content-range"]).toBe(`bytes 0-0/${SNAP_BYTES.length}`);
      expect(a.headers["content-length"]).toBe("1");
      expect(a.headers["accept-ranges"]).toBe("bytes");
      expect([...a.body]).toEqual([SNAP_BYTES[0]]);
      const tail = await ask(port, "GET", SNAPZ, { range: "bytes=-10" });
      expect(tail.status).toBe(206);
      expect(tail.headers["content-range"]).toBe(`bytes 4086-4095/${SNAP_BYTES.length}`);
      expect(Buffer.compare(tail.body, Buffer.from(SNAP_BYTES.slice(-10)))).toBe(0);
      const past = await ask(port, "GET", SNAPZ, { range: "bytes=5000-" });
      expect(past.status).toBe(416);
      expect(past.headers["content-range"]).toBe(`bytes */${SNAP_BYTES.length}`);
      const otherVersion = await ask(port, "GET", SNAPZ, { range: "bytes=0-0", "if-range": '"stale"' });
      expect(otherVersion.status).toBe(200);
      expect(otherVersion.body.length).toBe(SNAP_BYTES.length);
    });
  });

  test("legacy: the Range header is ignored, a full 200 with its length (what the live site answers)", async () => {
    await withServer("legacy", async (port) => {
      const a = await ask(port, "GET", SNAPZ, { range: "bytes=0-0" });
      expect(a.status).toBe(200);
      expect(a.headers["content-range"]).toBeUndefined();
      expect(a.headers["accept-ranges"]).toBeUndefined();
      expect(a.headers["content-length"]).toBe(String(SNAP_BYTES.length));
      expect(Buffer.compare(a.body, Buffer.from(SNAP_BYTES))).toBe(0);
    });
  });
});

describe("the CLI", () => {
  test("QED64_EDGE=bogus exits 2 with the usage line before listening", () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, QED64_EDGE: "bogus", PORT: "0" },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown QED64_EDGE="bogus"');
    expect(r.stderr).toContain(USAGE);
    expect(r.stdout).not.toContain("prod preview");
  });

  test("the startup line keeps its shape and names the mode and the release (and the release dir when set)", () => {
    expect(startupLine(5185, "/x/dist", "legacy")).toBe(`prod preview: http://localhost:5185 (/x/dist + public artifacts) edge=legacy release=${RELEASE_ID}`);
    expect(startupLine(5185, "/x/dist", "hardened", "/r/lean-v4.34.0-a8817d0")).toBe(
      `prod preview: http://localhost:5185 (/x/dist + public artifacts) edge=hardened release=${RELEASE_ID} releaseDir=/r/lean-v4.34.0-a8817d0`,
    );
    const pinned = JSON.parse(fs.readFileSync(path.join(root, "toolchain/lean4-wasm64-release.json"), "utf8")) as { id: string };
    expect(RELEASE_ID).toBe(pinned.id);
  });

  test("QED64_RELEASE_DIR naming a missing dir, or a release dir of another id, exits 2 with the usage line before listening", () => {
    const other = path.join(tmp, "other-release");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "release.json"), JSON.stringify({ schema: "lean4-wasm64.release/v1", id: "lean-v4.99.0-0000000", hosting: { layout: "served" } }));
    for (const [dir, msg] of [[path.join(tmp, "no-such-release"), /no readable release\.json/], [other, /release "lean-v4\.99\.0-0000000", but toolchain\/lean4-wasm64-release\.json pins/]] as const) {
      const r = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, QED64_RELEASE_DIR: dir, QED64_EDGE: "legacy", PORT: "0" }, encoding: "utf8", timeout: 15000 });
      expect(r.status, dir).toBe(2);
      expect(r.stderr, dir).toMatch(msg);
      expect(r.stderr, dir).toContain(USAGE);
      expect(r.stdout, dir).not.toContain("prod preview");
    }
    expect(() => createDistServer({ dist: distDir, publicDir, releaseDir: other })).toThrow(/pins/);
  });
});

// ------------------------------------------------------------------ the toolchain release's keys (decision 3)
describe("ARTIFACTS: lean4-wasm64/<id>/ keys", () => {
  const RELEASE_MANIFEST = new TextEncoder().encode('{"buildId":"wasm64-dca2763359db27e7","from":"release dir"}');
  let releaseDir = "";
  beforeAll(() => {
    releaseDir = path.join(tmp, RELEASE_ID);
    fs.mkdirSync(path.join(releaseDir, "runtime/chunks"), { recursive: true });
    fs.mkdirSync(path.join(releaseDir, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(releaseDir, "release.json"), JSON.stringify({ schema: "lean4-wasm64.release/v1", id: RELEASE_ID, hosting: { layout: "served" } }));
    fs.writeFileSync(path.join(releaseDir, "runtime/runtime-manifest.json"), RELEASE_MANIFEST);
    fs.writeFileSync(path.join(releaseDir, CHUNK.slice(1)), CHUNK_BYTES);
    fs.writeFileSync(path.join(releaseDir, "profiles/lean-core.manifest.json"), "{}");
  });
  const RK = (rest: string) => `lean4-wasm64/${RELEASE_ID}/${rest}`;

  test("with a release dir: release keys read it; root keys read public/; another id or a site dir under the release is absent", async () => {
    expect(releaseDirProblem(releaseDir)).toBeNull();
    const b = createArtifactsBinding(publicDir, { releaseDir });
    const m = await b.get(RK("runtime/runtime-manifest.json"));
    expect(Buffer.from(await new Response(m!.body).arrayBuffer()).toString()).toContain("release dir");
    expect((await b.head(RK(CHUNK.slice(1))))?.size).toBe(CHUNK_BYTES.length);
    expect((await b.head(RK("profiles/lean-core.manifest.json")))?.size).toBe(2);
    expect((await b.head(MANIFEST.slice(1)))?.size).toBe(ARTIFACTS[MANIFEST.slice(1)]!.bytes.length); // the root key: public/
    for (const key of [`lean4-wasm64/lean-v4.99.0-0000000/runtime/runtime-manifest.json`, RK("release.json"), RK("snapshots/index.json"), RK("runtime/../release.json"), "lean4-wasm64/", RK("")]) {
      expect(await b.head(key), key).toBeNull();
    }
  });

  test("without one: release keys read public/<rest> (today's trees keep working)", async () => {
    const b = createArtifactsBinding(publicDir);
    const m = await b.get(RK("runtime/runtime-manifest.json"));
    expect(Buffer.from(await new Response(m!.body).arrayBuffer()).toString()).toBe(new TextDecoder().decode(ARTIFACTS[MANIFEST.slice(1)]!.bytes));
    expect((await b.head(RK("profiles/index.json")))?.size).toBe(ARTIFACTS["profiles/index.json"]!.bytes.length);
  });

  test.each(["legacy", "hardened"] as const)("over HTTP (edge=%s; both route the pinned release): the release dir answers, a file only under public/ comes through the fallback, a miss is no-store", async (edge) => {
    // a pinned manifest present only in public/ (the root): the Worker's one-cycle fallback finds it
    const server = createDistServer({ dist: distDir, publicDir, edge, releaseDir });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const manifest = await ask(port, "GET", MANIFEST);
      expect([manifest.status, manifest.body.toString()]).toEqual([200, new TextDecoder().decode(RELEASE_MANIFEST)]);
      isolated(manifest);
      expect(manifest.headers["cache-control"]).toBe(REVALIDATE);
      const chunk = await ask(port, "GET", CHUNK);
      expect([chunk.status, chunk.headers["cache-control"], chunk.body.length]).toEqual([200, IMMUTABLE, CHUNK_BYTES.length]);
      const pinned = await ask(port, "GET", PINNED); // not in the release dir: public/ through the fallback
      expect([pinned.status, pinned.body.toString()]).toEqual([200, '{"pinned":true}']);
      const index = await ask(port, "GET", "/profiles/index.json"); // site-owned: public/
      expect([index.status, index.body.toString()]).toEqual([200, '{"profiles":[]}']);
      const miss = await ask(port, "GET", "/runtime/chunks/missing.0123456789abcdef0123.part-000");
      expect([miss.status, miss.headers["cache-control"]]).toEqual([404, "no-store"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the CLI (factory)", () => {
  test("an unknown mode is refused by the factory too", () => {
    expect(() => createDistServer({ dist: distDir, publicDir, edge: "bogus" as EdgeMode })).toThrow(/unknown edge mode/);
  });
});

// ------------------------------------------------------------------ parity
/** Workers static assets over DIST, in memory: the same subset (auto-trailing-slash, empty 404, HEAD without length). */
function memAssets() {
  const files = new Map(Object.entries(DIST));
  // the inside symlink, as the bytes it points at
  files.set("/inside-link.css", DIST["/assets/app.css"]!);
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      const u = new URL(request.url);
      let p: string;
      try {
        p = decodeURIComponent(u.pathname);
      } catch {
        return new Response(null, { status: 404 });
      }
      if (p.split("/").some((s) => s === ".." || s === ".")) return new Response(null, { status: 404 });
      const redirect = (to: string) => new Response(null, { status: 307, headers: { location: (to + u.search).replace(/^\/{2,}/, "/") } });
      const ok = (f: { body: string; type: string }) =>
        new Response(request.method === "HEAD" ? null : f.body, {
          headers:
            f.type === "text/html" // the live site's HTML: no etag, no length
              ? { "content-type": f.type }
              : { "content-type": f.type, etag: `"${"0".repeat(32)}"`, ...(request.method === "HEAD" ? {} : { "content-length": String(f.body.length) }) },
        });
      // auto-trailing-slash on a path without runs of slashes: a redirect target, a file, or null
      const resolve = (c: string): { to: string } | { file: { body: string; type: string } } | null => {
        if (c.endsWith("/index.html")) return files.has(c) ? { to: c.slice(0, -"index.html".length) } : null;
        if (c.endsWith(".html")) return files.has(c) ? { to: c.slice(0, -".html".length) } : null;
        if (c.endsWith("/")) return files.has(c + "index.html") ? { file: files.get(c + "index.html")! } : null;
        if (files.has(c)) return { file: files.get(c)! };
        if (files.has(c + ".html")) return c.endsWith("/index") ? { to: c.slice(0, -"index".length) } : { file: files.get(c + ".html")! };
        if (files.has(c + "/index.html")) return { to: c + "/" };
        return null;
      };
      // runs of slashes collapse: one 307 to the rule's target, or to the collapsed path
      const c = p.replace(/\/{2,}/g, "/");
      const r = resolve(c);
      if (r === null) return new Response(null, { status: 404 });
      if ("to" in r) return redirect(r.to);
      if (c !== p) return redirect(c);
      return ok(r.file);
    },
  };
}

/** R2 over ARTIFACTS, in memory. */
function memBucket() {
  const meta = (key: string, a: { bytes: Uint8Array; type: string }) => ({
    key,
    size: a.bytes.length,
    httpEtag: `"${"1".repeat(32)}"`,
    writeHttpMetadata(h: Headers) {
      h.set("content-type", a.type);
    },
  });
  return {
    async head(key: string) {
      const a = ARTIFACTS[key];
      return a ? meta(key, a) : null;
    },
    async get(key: string, options?: { range?: Headers }) {
      const a = ARTIFACTS[key];
      if (!a) return null;
      let offset = 0;
      let length = a.bytes.length;
      if (options?.range) {
        const r = resolveRange(parseRange(options.range.get("range"))!, a.bytes.length)!;
        offset = r.offset;
        length = r.length;
      }
      return { ...meta(key, a), range: { offset, length }, body: new Blob([a.bytes.slice(offset, offset + length)]).stream() };
    },
  };
}

const IGNORED = new Set(["content-length", "etag", "date", "connection", "keep-alive", "transfer-encoding"]);
const comparable = (entries: Iterable<[string, string]>) =>
  [...entries].filter(([k]) => !IGNORED.has(k.toLowerCase())).map(([k, v]) => `${k.toLowerCase()}: ${v}`).sort();

type Case = { method: string; path: string; headers?: Record<string, string>; body?: string };
const PATHS = [
  "/", "/?snapshots=snapshots/x", "/index.html", "/index.html?x=1", "/assets/index-AbCd1234.js", "/assets/app.css", "/assets/codicon.ttf",
  "/assets/missing-AbCd1234.js", "/assets/frame-AbCd1234.html", "/assets/frame-AbCd1234", "/sub/", "/sub", "/qed64-build.json",
  "/inside-link.css", "/nope", "/favicon.ico", "/assets/", "/assets/..%2f..%2foutside%2fsecret.txt",
  MANIFEST, PINNED, CHUNK, SNAPZ, "/snapshots/index.json", "/profiles/index.json", "/runtime/chunks/missing.part-000",
  "/snapshots/missing.dca2763359db27e7.snapz", "/runtime/", "/snapshots/a/../index.json", "/snapshots/%2e%2e/runtime/runtime-manifest.json",
  `${SNAPZ}?v=1`, "//runtime/runtime-manifest.json",
  "//assets/frame-AbCd1234.html", "//assets/app.css", "/index", "/sub/index",
];
const MATRIX: Case[] = [
  ...PATHS.flatMap((p) => ["GET", "HEAD"].map((method) => ({ method, path: p }))),
  ...[MANIFEST, "/assets/app.css"].map((p) => ({ method: "POST", path: p, body: "x" })),
  ...[SNAPZ, CHUNK].flatMap((p) => ["bytes=0-0", "bytes=-10", "bytes=100-", "bytes=5000-", "bytes=0-1,5-6", "items=0-1"].map((range) => ({ method: "GET", path: p, headers: { range } }))),
  { method: "GET", path: SNAPZ, headers: { range: "bytes=0-9", "if-range": '"stale"' } },
  { method: "HEAD", path: SNAPZ, headers: { range: "bytes=0-9" } },
  { method: "GET", path: "/assets/app.css", headers: { range: "bytes=0-1" } },
];

describe.each(["legacy", "hardened"] as const)("parity with the worker's own fetch, edge=%s", (edge) => {
  test(`${MATRIX.length} requests: the same status, headers and body`, async () => {
    const worker: EdgeWorker = edge === "legacy" ? (shipped as EdgeWorker) : createWorker({});
    await withServer(edge, async (port) => {
      for (const c of MATRIX) {
        const label = `${c.method} ${c.path} ${JSON.stringify(c.headers ?? {})}`;
        const viaNode = await ask(port, c.method, c.path, c.headers, c.body);
        const direct = await worker.fetch(
          new Request(`http://127.0.0.1:${port}${c.path}`, { method: c.method, headers: c.headers, ...(c.body !== undefined ? { body: c.body } : {}) }),
          { ASSETS: memAssets(), ARTIFACTS: memBucket() },
        );
        const directBody = Buffer.from(await direct.arrayBuffer());
        expect(viaNode.status, label).toBe(direct.status);
        expect(comparable(Object.entries(viaNode.headers)), label).toEqual(comparable(direct.headers.entries()));
        expect(viaNode.body.toString("base64"), label).toBe(c.method === "HEAD" ? "" : directBody.toString("base64"));
        // when the worker states a length, the Node layer keeps it
        const stated = direct.headers.get("content-length");
        if (stated !== null) expect(viaNode.headers["content-length"], label).toBe(stated);
      }
    });
  });
});
