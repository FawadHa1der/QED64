// infra/edge-worker.js — the edge worker as a library — against fake ASSETS /
// R2 bindings (no network, no account, no wrangler).
//
// (a) EQUIVALENCE: QED64's deployed behaviour must not move. A request matrix
//     runs through the ORIGINAL worker (tests/fixtures/edge-worker/
//     worker-47f50e8.js, byte-for-byte `git show 47f50e8:infra/worker.js`,
//     sha256-pinned below), through createWorker(QED64_LEGACY) and through the
//     shipped infra/worker.js, and every response must agree on status,
//     statusText, headers and body, and every binding call on its arguments.
// (b) The hardened defaults other projects get: single-range GETs (If-Range,
//     416), metadata HEAD, 405 + Allow, traversal refusal, r2Prefix
//     validation, rootRedirect, extraRoutes + kit, decorate, isolation
//     overrides, no-store errors.
import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import shipped, { isImmutable as shippedIsImmutable } from "../../infra/worker.js";
import {
  artifactKey,
  createWorker,
  DEFAULT_ARTIFACT_PREFIXES,
  isImmutable,
  parseRange,
  QED64_LEGACY,
  resolveRange,
  withIsolationHeaders,
} from "../../infra/edge-worker.js";
import type { DecorateInfo, EdgeWorker, EdgeWorkerOptions, ExtraRoute } from "../../infra/edge-worker.js";

const root = path.resolve(__dirname, "../..");
const FIXTURE = path.join(root, "tests/fixtures/edge-worker/worker-47f50e8.js");
const FIXTURE_SHA256 = "257d238480f89cc19d95a09b9545c1975b2d273deee4ebb039c7be71f0c83457";
const legacy = (await import(pathToFileURL(FIXTURE).href)).default as EdgeWorker;

const ORIGIN = "https://qed64.example";
const HEX16 = "dca2763359db27e7";
const DIGEST = "0123456789abcdef".repeat(4);
const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) % 256);
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

// ------------------------------------------------------------------ fakes
type Obj = { bytes: Uint8Array; contentType?: string; cacheControl?: string; disposition?: string };
type Call = { op: "head" | "get"; key: string; argc?: number; range?: string | null };

/** R2, structurally. get(key, {range: Headers}) returns the selected bytes and `range`, and is
 * STRICTER than R2 where the worker must not lean on it (an unsatisfiable or unparsable range
 * throws), so a test passes only if the worker settled 416 / full-200 itself. */
function fakeBucket(objects: Record<string, Obj>) {
  const calls: Call[] = [];
  const meta = (key: string, e: Obj) => ({
    key,
    size: e.bytes.length,
    httpEtag: `"etag-${key}"`,
    writeHttpMetadata(h: Headers) {
      if (e.contentType !== undefined) h.set("content-type", e.contentType);
      if (e.cacheControl !== undefined) h.set("cache-control", e.cacheControl);
      if (e.disposition !== undefined) h.set("content-disposition", e.disposition);
    },
  });
  return {
    calls,
    async head(key: string) {
      calls.push({ op: "head", key });
      const e = objects[key];
      return e ? meta(key, e) : null;
    },
    async get(...args: [string, { range?: Headers }?]) {
      const [key, options] = args;
      const rangeHeader = options?.range instanceof Headers ? options.range.get("range") : undefined;
      calls.push(rangeHeader !== undefined ? { op: "get", key, argc: args.length, range: rangeHeader } : { op: "get", key, argc: args.length });
      const e = objects[key];
      if (!e) return null;
      const size = e.bytes.length;
      let offset = 0;
      let length = size;
      if (options?.range !== undefined) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? "");
        if (m === null || (m[1] === "" && m[2] === "")) throw new Error("get: invalid range (fake R2)");
        if (m[1] === "") {
          length = Math.min(Number(m[2]), size);
          offset = size - length;
        } else {
          offset = Number(m[1]);
          const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
          length = end - offset + 1;
        }
        if (length <= 0 || offset >= size) throw new Error("get: The requested range is not satisfiable (10039)");
      }
      return { ...meta(key, e), range: { offset, length }, body: new Blob([e.bytes.slice(offset, offset + length)]).stream() };
    },
  };
}

/** Workers static assets, structurally: 307 for /index.html (auto-trailing-slash), 405 for
 * non-GET/HEAD, a null body on HEAD, statusText set (the worker must drop it like before). */
function fakeAssets(files: Record<string, { body: string; type: string }>) {
  const calls: string[] = [];
  return {
    calls,
    async fetch(request: Request) {
      const u = new URL(request.url);
      calls.push(`${request.method} ${u.pathname}${u.search}`);
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405, statusText: "Method Not Allowed", headers: { allow: "GET, HEAD" } });
      }
      if (u.pathname === "/index.html") return new Response(null, { status: 307, statusText: "Temporary Redirect", headers: { location: "/" } });
      const f = files[u.pathname.endsWith("/") ? u.pathname + "index.html" : u.pathname];
      if (f === undefined) return new Response("asset not found", { status: 404, statusText: "Not Found" });
      return new Response(request.method === "HEAD" ? null : f.body, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": f.type, etag: `"a-${f.body.length}"`, "cache-control": "public, max-age=3600" },
      });
    },
  };
}

const SNAPZ = `/snapshots/init.${HEX16}.snapz`;
const KEY = SNAPZ.slice(1);
const ETAG = `"etag-${KEY}"`;
const PART = `/runtime/chunks/lean.wasm.${DIGEST.slice(0, 20)}.part-000`;
const OBJECTS: Record<string, Obj> = {
  "runtime/runtime-manifest.json": { bytes: json({ buildId: HEX16 }), contentType: "application/json" },
  [`runtime/runtime-manifest.wasm64-${HEX16}.json`]: { bytes: json({ pinned: true }), contentType: "application/json" },
  [PART.slice(1)]: { bytes: BYTES.slice(0, 333) },
  [`runtime/chunks/${DIGEST}.part-000`]: { bytes: BYTES.slice(0, 64), contentType: "application/octet-stream" },
  "snapshots/index.json": { bytes: json({ schema: "qed64.snapshot-index/v1" }), contentType: "application/json" },
  [KEY]: { bytes: BYTES, cacheControl: "private, max-age=5", disposition: "attachment" },
  "profiles/index.json": { bytes: json({ profiles: [] }), contentType: "application/json" },
  "profiles/lean-core.pack.gzip.1016929d99bb0ba0e148.part-007": { bytes: BYTES.slice(10, 90) },
  "lean4game/snapshots/index.json": { bytes: json({ game: true }), contentType: "application/json" },
  [`lean4game/${KEY}`]: { bytes: BYTES },
};
const FILES: Record<string, { body: string; type: string }> = {
  "/index.html": { body: "<!doctype html>qed64", type: "text/html" },
  "/assets/x.js": { body: "console.log(1)", type: "text/javascript" },
  "/assets/index-AbCd1234.js": { body: "export {}", type: "text/javascript" },
  "/workers/lean.worker.js": { body: "self.onmessage=null", type: "text/javascript" },
  "/showcase/index.html": { body: "<!doctype html>gallery", type: "text/html" },
};

type FakeEnv = { ASSETS: ReturnType<typeof fakeAssets>; ARTIFACTS: ReturnType<typeof fakeBucket>; [k: string]: unknown };
const makeEnv = (extra: Record<string, unknown> = {}): FakeEnv => ({ ASSETS: fakeAssets(FILES), ARTIFACTS: fakeBucket(OBJECTS), ...extra });
const req = (p: string, init?: RequestInit) => new Request(ORIGIN + p, init);

async function snapshot(r: Response) {
  return {
    status: r.status,
    statusText: r.statusText,
    headers: [...r.headers.entries()],
    body: Buffer.from(await r.arrayBuffer()).toString("base64"),
  };
}
const bytesOf = async (r: Response) => new Uint8Array(await r.arrayBuffer());
const isolated = (r: Response) => {
  expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  expect(r.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
};

// ------------------------------------------------------------------ (a) equivalence
type Case = { method: string; path: string; headers?: Record<string, string>; body?: string };
const PATHS = [
  "/", "/?snapshots=snapshots/x", "/index.html", "/assets/x.js", "/assets/index-AbCd1234.js", "/assets/missing-AbCd1234.js",
  "/workers/lean.worker.js", "/showcase/", "/nope.js", "/favicon.ico",
  "/runtime/runtime-manifest.json", `/runtime/runtime-manifest.wasm64-${HEX16}.json`, PART, `/runtime/chunks/${DIGEST}.part-000`,
  "/snapshots/index.json", SNAPZ, `/snapshots/missing.${HEX16}.snapz`, "/profiles/index.json",
  "/profiles/lean-core.pack.gzip.1016929d99bb0ba0e148.part-007", "/profiles/missing.json", "/runtime/chunks/nope.part-001",
  // odd paths
  "/runtime/", "/snapshots/", "/runtime", "/runtimex/a.json", "/RUNTIME/runtime-manifest.json", "//runtime/runtime-manifest.json",
  "/snapshots//index.json", "/snapshots/a/../index.json", "/snapshots/%2e%2e/runtime/runtime-manifest.json",
  "/snapshots/a%2Fb", `${SNAPZ}?v=1`, "/snapshots/index.json#frag", "/profiles/%E2%9C%93.json", "/lean4game/snapshots/index.json",
];
const MATRIX: Case[] = [
  ...PATHS.flatMap((p) => ["GET", "HEAD", "POST"].map((method) => ({ method, path: p, ...(method === "POST" ? { body: "x" } : {}) }))),
  ...["PUT", "DELETE", "OPTIONS", "PATCH"].flatMap((method) => [SNAPZ, "/index.html", "/assets/x.js"].map((p) => ({ method, path: p }))),
  { method: "GET", path: SNAPZ, headers: { range: "bytes=0-99" } },
  { method: "GET", path: SNAPZ, headers: { range: "bytes=0-99", "if-range": ETAG } },
  { method: "GET", path: SNAPZ, headers: { range: "bytes=5000-" } },
  { method: "HEAD", path: SNAPZ, headers: { range: "bytes=0-9" } },
  { method: "GET", path: "/assets/x.js", headers: { range: "bytes=0-3" } },
  { method: "GET", path: "/snapshots/index.json", headers: { "if-none-match": '"x"', accept: "application/json" } },
];

describe("equivalence: createWorker(QED64_LEGACY) is the pre-library worker, byte for byte", () => {
  test("the fixture is the original infra/worker.js (sha256-pinned; cross-checked with git when the commit is present)", () => {
    const src = fs.readFileSync(FIXTURE);
    expect(createHash("sha256").update(src).digest("hex")).toBe(FIXTURE_SHA256);
    const git = spawnSync("git", ["show", "47f50e8:infra/worker.js"], { cwd: root, encoding: "buffer" });
    if (git.status === 0) expect(Buffer.compare(git.stdout, src)).toBe(0); // shallow CI clones skip this half
  });

  test(`${MATRIX.length} requests: identical status, statusText, headers, body and binding calls`, async () => {
    const subjects: [string, EdgeWorker][] = [
      ["legacy", legacy],
      ["createWorker(QED64_LEGACY)", createWorker(QED64_LEGACY)],
      ["infra/worker.js", shipped as EdgeWorker],
    ];
    let compared = 0;
    for (const c of MATRIX) {
      const label = `${c.method} ${c.path}${c.headers ? " " + JSON.stringify(c.headers) : ""}`;
      const results = [];
      for (const [name, w] of subjects) {
        const env = makeEnv();
        const init: RequestInit = { method: c.method, headers: c.headers };
        if (c.body !== undefined) init.body = c.body;
        const r = await w.fetch(req(c.path, init), env);
        results.push({ name, snap: await snapshot(r), r2: env.ARTIFACTS.calls, assets: env.ASSETS.calls });
      }
      const [want, ...rest] = results;
      for (const got of rest) {
        expect(got.snap, `${got.name}: ${label}`).toEqual(want!.snap);
        expect(got.r2, `${got.name} R2 calls: ${label}`).toEqual(want!.r2);
        expect(got.assets, `${got.name} ASSETS calls: ${label}`).toEqual(want!.assets);
        compared++;
      }
    }
    expect(compared).toBe(MATRIX.length * 2);
  });

  test("the matrix exercises what it claims (pins the legacy behaviour it preserves)", async () => {
    const w = createWorker(QED64_LEGACY);
    const at = async (p: string, init?: RequestInit) => {
      const env = makeEnv();
      const r = await w.fetch(req(p, init), env);
      return { r, env };
    };
    // artifact GET: R2 metadata passed through, Cache-Control replaced, no Accept-Ranges / Content-Length added
    const snap = await at(SNAPZ);
    expect(snap.r.status).toBe(200);
    isolated(snap.r);
    expect(snap.r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(snap.r.headers.get("content-disposition")).toBe("attachment");
    expect(snap.r.headers.get("etag")).toBe(ETAG);
    expect(snap.r.headers.get("accept-ranges")).toBeNull();
    expect(snap.r.headers.get("content-length")).toBeNull();
    expect(snap.env.ARTIFACTS.calls).toEqual([{ op: "get", key: KEY, argc: 1 }]);
    // HEAD reads the object; Range is ignored; any method reads
    for (const init of [{ method: "HEAD" }, { headers: { range: "bytes=0-9" } }, { method: "POST", body: "x" }] as RequestInit[]) {
      const x = await at(SNAPZ, init);
      expect(x.r.status).toBe(200);
      expect(x.env.ARTIFACTS.calls).toEqual([{ op: "get", key: KEY, argc: 1 }]);
    }
    // the year-long cached 404 (what errorCacheControl closes) and the unguarded key
    const miss = await at(`/snapshots/missing.${HEX16}.snapz`);
    expect(miss.r.status).toBe(404);
    expect(miss.r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const dbl = await at("/snapshots//index.json");
    expect(dbl.env.ARTIFACTS.calls).toEqual([{ op: "get", key: "snapshots//index.json", argc: 1 }]);
    // manifests revalidate; statusText is dropped; assets pass through
    expect((await at(`/runtime/runtime-manifest.wasm64-${HEX16}.json`)).r.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const asset404 = await at("/nope.js");
    expect([asset404.r.status, asset404.r.statusText]).toEqual([404, ""]);
    const redirect = await at("/index.html");
    expect([redirect.r.status, redirect.r.headers.get("location")]).toEqual([307, "/"]);
  });

  test("infra/worker.js re-exports the library's isImmutable; QED64_LEGACY and the defaults are frozen", () => {
    expect(shippedIsImmutable).toBe(isImmutable);
    expect(Object.isFrozen(QED64_LEGACY)).toBe(true);
    expect(Object.isFrozen(QED64_LEGACY.isolation)).toBe(true);
    expect(Object.isFrozen(QED64_LEGACY.extraRoutes)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ARTIFACT_PREFIXES)).toBe(true);
    expect([...DEFAULT_ARTIFACT_PREFIXES]).toEqual(["/runtime/", "/profiles/", "/snapshots/"]);
    expect(QED64_LEGACY).toMatchObject({
      artifactHead: "get", ranges: false, artifactMethods: null, rejectUnsafeKeys: false, fullGetLength: false,
      errorCacheControl: null, r2Prefix: "", rootRedirect: null, decorate: null, isImmutable,
    });
  });

  test("edge-worker.js is self-contained: no imports, no Node built-ins", () => {
    const src = fs.readFileSync(path.join(root, "infra/edge-worker.js"), "utf8");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/\bimport\s*\(/);
    expect(src).not.toMatch(/\brequire\s*\(/);
    expect(src).not.toMatch(/["']node:/);
    expect(src).not.toMatch(/\b(process|Buffer|__dirname)\b/);
  });
});

// ------------------------------------------------------------------ (b) hardened defaults
describe("hardened defaults: single-range GETs", () => {
  const w = createWorker();
  const get = (p: string, headers: Record<string, string> = {}, env = makeEnv()) => w.fetch(req(p, { headers }), env);

  test("a full GET carries Accept-Ranges and the object's Content-Length, and asks R2 for no range", async () => {
    const env = makeEnv();
    const r = await get(SNAPZ, {}, env);
    expect(r.status).toBe(200);
    isolated(r);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe("1000");
    expect(r.headers.get("content-range")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await bytesOf(r)).toEqual(BYTES);
    expect(env.ARTIFACTS.calls).toEqual([{ op: "get", key: KEY, argc: 1 }]);
  });

  test("bytes=0-99 → 206 with Content-Range and the partial Content-Length, head() first", async () => {
    const env = makeEnv();
    const r = await get(SNAPZ, { range: "bytes=0-99" }, env);
    expect(r.status).toBe(206);
    isolated(r);
    expect(r.headers.get("content-range")).toBe("bytes 0-99/1000");
    expect(r.headers.get("content-length")).toBe("100");
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await bytesOf(r)).toEqual(BYTES.slice(0, 100));
    expect(env.ARTIFACTS.calls).toEqual([{ op: "head", key: KEY }, { op: "get", key: KEY, argc: 2, range: "bytes=0-99" }]);
  });

  test("suffix, open-ended and clamped ranges", async () => {
    for (const [range, cr, len, from] of [
      ["bytes=-100", "bytes 900-999/1000", "100", 900],
      ["bytes=-5000", "bytes 0-999/1000", "1000", 0],
      ["bytes=100-", "bytes 100-999/1000", "900", 100],
      ["bytes=990-4999", "bytes 990-999/1000", "10", 990],
    ] as const) {
      const r = await get(SNAPZ, { range });
      expect(r.status, range).toBe(206);
      expect(r.headers.get("content-range"), range).toBe(cr);
      expect(r.headers.get("content-length"), range).toBe(len);
      expect(await bytesOf(r), range).toEqual(BYTES.slice(from));
    }
  });

  test("If-Range: the strong etag resumes (206); a mismatch, weak etag or date gets the full 200", async () => {
    const ok = await get(SNAPZ, { range: "bytes=500-", "if-range": ETAG });
    expect(ok.status).toBe(206);
    expect(await bytesOf(ok)).toEqual(BYTES.slice(500));
    for (const validator of ['"older"', "W/" + ETAG, "Mon, 21 Sep 2026 10:00:00 GMT"]) {
      const env = makeEnv();
      const r = await get(SNAPZ, { range: "bytes=500-", "if-range": validator }, env);
      expect(r.status, validator).toBe(200);
      expect(r.headers.get("content-range"), validator).toBeNull();
      expect(r.headers.get("content-length"), validator).toBe("1000");
      expect(await bytesOf(r), validator).toEqual(BYTES);
      expect(env.ARTIFACTS.calls, validator).toEqual([{ op: "head", key: KEY }, { op: "get", key: KEY, argc: 1 }]);
    }
    // a mismatched validator wins over an unsatisfiable range
    expect((await get(SNAPZ, { range: "bytes=1000-", "if-range": '"older"' })).status).toBe(200);
  });

  test("past the end → 416, Content-Range bytes */size, no-store, no ranged get", async () => {
    for (const range of ["bytes=1000-", "bytes=1000-1001", "bytes=5000-6000", "bytes=-0"]) {
      const env = makeEnv();
      const r = await get(SNAPZ, { range }, env);
      expect(r.status, range).toBe(416);
      isolated(r);
      expect(r.headers.get("content-range"), range).toBe("bytes */1000");
      expect(r.headers.get("accept-ranges"), range).toBe("bytes");
      expect(r.headers.get("cache-control"), range).toBe("no-store");
      expect(env.ARTIFACTS.calls, range).toEqual([{ op: "head", key: KEY }]);
    }
    // no-store even when errors otherwise follow the path rule
    const legacyErrors = createWorker({ errorCacheControl: null });
    expect((await legacyErrors.fetch(req(SNAPZ, { headers: { range: "bytes=1000-" } }), makeEnv())).headers.get("cache-control")).toBe("no-store");
  });

  test("multi-range, other units, malformed or inverted specs → full 200 without asking R2 for a range", async () => {
    for (const range of ["bytes=0-9,20-29", "items=0-9", "bytes=abc", "bytes=-", "bytes=9-0", "0-9", "BYTES=0-9", "bytes= 0-9", "bytes=0-99999999999999999999"]) {
      const env = makeEnv();
      const r = await get(SNAPZ, { range }, env);
      expect(r.status, range).toBe(200);
      expect(r.headers.get("content-range"), range).toBeNull();
      expect(await bytesOf(r), range).toEqual(BYTES);
      expect(env.ARTIFACTS.calls, range).toEqual([{ op: "get", key: KEY, argc: 1 }]);
    }
  });

  test("missing artifact with Range: 404 from head(); assets never see range handling", async () => {
    const env = makeEnv();
    const r = await get(`/snapshots/absent.${HEX16}.snapz`, { range: "bytes=0-9" }, env);
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(env.ASSETS.calls).toEqual([]);
    const a = makeEnv();
    const asset = await get("/assets/x.js", { range: "bytes=0-3" }, a);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("accept-ranges")).toBeNull();
    expect(a.ARTIFACTS.calls).toEqual([]);
  });

  test("ranges: false keeps every other hardened switch", async () => {
    const env = makeEnv();
    const r = await createWorker({ ranges: false }).fetch(req(SNAPZ, { headers: { range: "bytes=0-9" } }), env);
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBeNull();
    expect(r.headers.get("content-length")).toBe("1000");
    expect(env.ARTIFACTS.calls).toEqual([{ op: "get", key: KEY, argc: 1 }]);
  });

  test("parseRange / resolveRange", () => {
    expect(parseRange("bytes=0-99")).toEqual({ first: 0, last: 99 });
    expect(parseRange(" bytes=100- ")).toEqual({ first: 100 });
    expect(parseRange("bytes=-100")).toEqual({ suffix: 100 });
    for (const h of [null, undefined, "Bytes = 100 - ", "bytes=0-99999999999999999999", "bytes=0-1,3-4", "bytes=-", "bytes=5-4"]) expect(parseRange(h), String(h)).toBeNull();
    expect(resolveRange({ first: 0, last: 99 }, 1000)).toEqual({ offset: 0, length: 100 });
    expect(resolveRange({ first: 82182072, last: 82182072 }, 154373030)).toEqual({ offset: 82182072, length: 1 });
    expect(resolveRange({ suffix: 100 }, 1000)).toEqual({ offset: 900, length: 100 });
    expect(resolveRange({ first: 1000 }, 1000)).toBeNull();
    expect(resolveRange({ suffix: 0 }, 1000)).toBeNull();
    expect(resolveRange({ suffix: 10 }, 0)).toBeNull();
  });
});

describe("hardened defaults: HEAD, methods, keys, errors", () => {
  const w = createWorker();

  test("HEAD is answered from head() with Content-Length == size and the R2 metadata", async () => {
    for (const [p, len, type] of [[SNAPZ, "1000", null], ["/snapshots/index.json", String(json({ schema: "qed64.snapshot-index/v1" }).length), "application/json"]] as const) {
      const env = makeEnv();
      const r = await w.fetch(req(p, { method: "HEAD", headers: { range: "bytes=0-9" } }), env);
      expect(r.status, p).toBe(200);
      isolated(r);
      expect(r.headers.get("content-length"), p).toBe(len);
      expect(r.headers.get("content-type"), p).toBe(type);
      expect(r.headers.get("accept-ranges"), p).toBe("bytes");
      expect(r.headers.get("content-range"), p).toBeNull();
      expect(r.headers.get("etag"), p).toBe(`"etag-${p.slice(1)}"`);
      expect(r.body, p).toBeNull();
      expect(env.ARTIFACTS.calls, p).toEqual([{ op: "head", key: p.slice(1) }]);
    }
    const env = makeEnv();
    const miss = await w.fetch(req(`/snapshots/absent.${HEX16}.snapz`, { method: "HEAD" }), env);
    expect(miss.status).toBe(404);
    expect(miss.headers.get("cache-control")).toBe("no-store");
    expect(env.ARTIFACTS.calls).toEqual([{ op: "head", key: `snapshots/absent.${HEX16}.snapz` }]);
  });

  test('artifactHead: "get" reads the object for HEAD', async () => {
    const env = makeEnv();
    const r = await createWorker({ artifactHead: "get" }).fetch(req(SNAPZ, { method: "HEAD" }), env);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-length")).toBe("1000");
    expect(env.ARTIFACTS.calls).toEqual([{ op: "get", key: KEY, argc: 1 }]);
  });

  test("other methods on artifacts: 405 with Allow, no R2 access, no-store; custom method lists", async () => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const env = makeEnv();
      const init: RequestInit = { method };
      if (method === "POST" || method === "PUT") init.body = "x";
      const r = await w.fetch(req(SNAPZ, init), env);
      expect(r.status, method).toBe(405);
      isolated(r);
      expect(r.headers.get("allow"), method).toBe("GET, HEAD");
      expect(r.headers.get("cache-control"), method).toBe("no-store");
      expect(env.ARTIFACTS.calls, method).toEqual([]);
    }
    const getOnly = createWorker({ artifactMethods: ["get"] });
    const head = await getOnly.fetch(req(SNAPZ, { method: "HEAD" }), makeEnv());
    expect([head.status, head.headers.get("allow")]).toEqual([405, "GET"]);
    // methods on assets are the assets binding's business
    const env = makeEnv();
    const asset = await w.fetch(req("/assets/x.js", { method: "POST", body: "x" }), env);
    expect(asset.status).toBe(405);
    expect(env.ASSETS.calls).toEqual(["POST /assets/x.js"]);
  });

  test("unsafe keys: 404 without touching R2", async () => {
    for (const p of ["/snapshots//index.json", "/snapshots/", "/runtime/", "/runtime/chunks/", "/profiles//x.json"]) {
      const env = makeEnv();
      const r = await w.fetch(req(p), env);
      expect(r.status, p).toBe(404);
      isolated(r);
      expect(r.headers.get("cache-control"), p).toBe("no-store");
      expect(env.ARTIFACTS.calls, p).toEqual([]);
      expect(env.ASSETS.calls, p).toEqual([]);
    }
    // URL parsing folds "..", "%2e%2e" and "\" before the worker sees the path
    const folded = makeEnv();
    expect((await w.fetch(req("/snapshots/a/../index.json"), folded)).status).toBe(200);
    expect(folded.ARTIFACTS.calls).toEqual([{ op: "get", key: "snapshots/index.json", argc: 1 }]);
  });

  test("artifactKey", () => {
    expect(artifactKey("/snapshots/index.json")).toBe("snapshots/index.json");
    expect(artifactKey("/snapshots/index.json", "lean4game/")).toBe("lean4game/snapshots/index.json");
    expect(artifactKey(SNAPZ, "a/b/")).toBe(`a/b/${KEY}`);
    for (const p of [
      "/snapshots/../runtime/x", "/snapshots/./x", "/snapshots//x", "/snapshots/", "/", "", "snapshots/x",
      "/snapshots/%2e%2e/x", "/snapshots/%2E/x", "/snapshots/.%2e/x", "/snapshots\\x", "/snapshots/a\u0000b", "/snapshots/a\nb",
    ]) {
      expect(artifactKey(p), JSON.stringify(p)).toBeNull();
    }
    expect(artifactKey("/snapshots/..x/y.json")).toBe("snapshots/..x/y.json"); // only whole dot segments
  });

  test("errorCacheControl: no-store on artifact and asset errors by default; a custom value; null = the path rule", async () => {
    const miss = `/snapshots/missing.${HEX16}.snapz`;
    expect((await w.fetch(req(miss), makeEnv())).headers.get("cache-control")).toBe("no-store");
    const asset404 = await w.fetch(req("/assets/missing-AbCd1234.js"), makeEnv());
    expect([asset404.status, asset404.headers.get("cache-control")]).toEqual([404, "no-store"]);
    const custom = createWorker({ errorCacheControl: "public, max-age=60" });
    expect((await custom.fetch(req(miss), makeEnv())).headers.get("cache-control")).toBe("public, max-age=60");
    const pathRule = createWorker({ errorCacheControl: null });
    expect((await pathRule.fetch(req(miss), makeEnv())).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // successes keep the path rule, overriding whatever the asset or object said
    const ok = await w.fetch(req("/assets/x.js"), makeEnv());
    expect(ok.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const manifest = await w.fetch(req("/runtime/runtime-manifest.json"), makeEnv());
    expect(manifest.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });
});

describe("configuration", () => {
  test("r2Prefix: a string or (env) => string is prepended to every R2 key (head and ranged get too)", async () => {
    for (const r2Prefix of ["lean4game/", (env: { R2_PREFIX?: string }) => env.R2_PREFIX ?? ""] as EdgeWorkerOptions["r2Prefix"][]) {
      const w = createWorker({ r2Prefix });
      const env = makeEnv({ R2_PREFIX: "lean4game/" });
      const r = await w.fetch(req(SNAPZ, { headers: { range: "bytes=10-19" } }), env);
      expect(r.status).toBe(206);
      expect(await bytesOf(r)).toEqual(BYTES.slice(10, 20));
      expect(env.ARTIFACTS.calls).toEqual([
        { op: "head", key: `lean4game/${KEY}` },
        { op: "get", key: `lean4game/${KEY}`, argc: 2, range: "bytes=10-19" },
      ]);
    }
    // a function that finds nothing means no prefix
    const env = makeEnv();
    const r = await createWorker({ r2Prefix: (e: FakeEnv) => e.R2_PREFIX as string | undefined }).fetch(req("/snapshots/index.json"), env);
    expect(r.status).toBe(200);
    expect(env.ARTIFACTS.calls).toEqual([{ op: "get", key: "snapshots/index.json", argc: 1 }]);
    for (const ok of ["a/", "a/b/", "x.y_z-1/", "...a/"]) {
      expect((await createWorker({ r2Prefix: ok }).fetch(req("/snapshots/index.json"), makeEnv())).status, ok).not.toBe(500);
    }
  });

  test("r2Prefix: an invalid value answers 500 no-store without touching R2 (static or from env)", async () => {
    const bad: unknown[] = ["lean4game", "/abs/", "a/../", "../", "./", "a/./", "a//", "a b/", "ä/", "a\\b/", "/"];
    for (const value of bad) {
      for (const w of [createWorker({ r2Prefix: value as string }), createWorker({ r2Prefix: () => value as string })]) {
        const env = makeEnv();
        const r = await w.fetch(req("/snapshots/index.json"), env);
        expect(r.status, JSON.stringify(value)).toBe(500);
        isolated(r);
        expect(r.headers.get("cache-control"), JSON.stringify(value)).toBe("no-store");
        expect(env.ARTIFACTS.calls, JSON.stringify(value)).toEqual([]);
      }
    }
    const nonString = await createWorker({ r2Prefix: () => 42 as unknown as string }).fetch(req("/snapshots/index.json"), makeEnv());
    expect(nonString.status).toBe(500);
    // assets are unaffected by a broken artifact prefix
    expect((await createWorker({ r2Prefix: "bad" }).fetch(req("/assets/x.js"), makeEnv())).status).toBe(200);
  });

  test("rootRedirect: only a bare '/' without a query; string or (env) => string | null", async () => {
    const w = createWorker({ rootRedirect: "/showcase/" });
    const env = makeEnv();
    const r = await w.fetch(req("/"), env);
    expect(r.status).toBe(302);
    isolated(r);
    expect(r.headers.get("location")).toBe(ORIGIN + "/showcase/");
    expect(r.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(env.ASSETS.calls).toEqual([]);
    for (const p of ["/?snapshots=snapshots/widgets8", "/index.html", "/showcase/"]) {
      expect((await w.fetch(req(p), makeEnv())).status, p).not.toBe(302);
    }
    const fromEnv = createWorker({ rootRedirect: (e: FakeEnv) => (e.ROOT_REDIRECT as string | undefined) ?? null });
    expect((await fromEnv.fetch(req("/"), makeEnv({ ROOT_REDIRECT: "https://elsewhere.example/x" }))).headers.get("location")).toBe("https://elsewhere.example/x");
    expect((await fromEnv.fetch(req("/"), makeEnv())).status).toBe(200);
    expect((await createWorker().fetch(req("/"), makeEnv())).status).toBe(200);
  });

  test("extraRoutes: tried in order before artifacts, fall through on null, kit serves finished responses", async () => {
    const seen: string[] = [];
    const ctx = { waitUntil() {} };
    const routes: ExtraRoute[] = [
      { prefix: "/api/", handle: () => { seen.push("api"); return new Response("api", { status: 201, headers: { "x-api": "1" } }); } },
      { prefix: "/snapshots/special/", handle: (_r, _e, c) => { seen.push("special"); expect(c).toBe(ctx); return Response.json({ special: true }); } },
      { prefix: "/api/", handle: () => { seen.push("shadowed"); return new Response("never"); } },
      { match: (url) => url.searchParams.has("skip"), handle: () => { seen.push("skip"); return undefined; } },
      { prefix: "/game/", handle: (request, _e, _c, kit) => kit.serveArtifact(request, new URL(request.url).pathname.replace(/^\/game\/[^/]+/, "")) },
      { prefix: "/raw/", rawHeaders: true, handle: () => new Response("raw", { headers: { "x-raw": "1" } }) },
      { prefix: "/rawkit/", rawHeaders: true, handle: (_r, _e, _c, kit) => kit.withHeaders(new Response("wrapped"), "/rawkit/a.0123456789abcdef.js") },
      { prefix: "/gone/", handle: (_r, _e, _c, kit) => kit.notFound() },
      { prefix: "/shell/", handle: (request, _e, _c, kit) => kit.serveAsset(new Request(new URL("/showcase/", request.url))) },
      { match: (url, request) => request.method === "HEAD" && url.pathname === "/probe", handle: (_r, _e, _c, kit) => new Response(null, { headers: { "x-immutable": String(kit.isImmutable("/x.snapz")) } }) },
    ];
    const decorated: DecorateInfo[] = [];
    const w = createWorker({ extraRoutes: routes, decorate: (_h, info) => { decorated.push(info); } });
    const run = async (p: string, init?: RequestInit) => {
      const env = makeEnv();
      decorated.length = 0;
      const r = await w.fetch(req(p, init), env, ctx);
      return { r, env, decorated: [...decorated] };
    };

    const api = await run("/api/x");
    expect([api.r.status, await api.r.text(), api.r.headers.get("x-api")]).toEqual([201, "api", "1"]);
    isolated(api.r);
    expect(api.decorated).toEqual([{ pathname: "/api/x", route: "extra", status: 201 }]);
    expect(seen).toEqual(["api"]);

    // an extra route beats the artifact prefix it lives under
    const special = await run("/snapshots/special/x.json");
    expect(await special.r.json()).toEqual({ special: true });
    expect(special.env.ARTIFACTS.calls).toEqual([]);
    isolated(special.r);

    // null/undefined falls through to the next route, then to artifacts
    seen.length = 0;
    const skipped = await run("/snapshots/index.json?skip=1");
    expect(skipped.r.status).toBe(200);
    expect(seen).toEqual(["skip"]);
    expect(skipped.env.ARTIFACTS.calls).toEqual([{ op: "get", key: "snapshots/index.json", argc: 1 }]);

    // kit.serveArtifact under a rewritten path: served, cache rule of the artifact path, not re-wrapped
    const game = await run(`/game/nng${SNAPZ}`, { headers: { range: "bytes=0-9" } });
    expect(game.r.status).toBe(206);
    expect(await bytesOf(game.r)).toEqual(BYTES.slice(0, 10));
    expect(game.r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(game.decorated).toEqual([{ pathname: SNAPZ, route: "artifact", status: 206 }]);
    const traversal = await run("/game/nng/../../snapshots/x"); // URL-folded to /snapshots/x: not this route
    expect(traversal.env.ARTIFACTS.calls).toEqual([{ op: "get", key: "snapshots/x", argc: 1 }]);
    const unsafe = await w.fetch(req("/game/nng/snapshots//x"), makeEnv(), ctx);
    expect(unsafe.status).toBe(404);

    // rawHeaders: untouched; kit.withHeaders inside a raw route applies the headers once
    const raw = await run("/raw/x");
    expect(raw.r.headers.get("x-raw")).toBe("1");
    expect(raw.r.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(raw.r.headers.get("cache-control")).toBeNull();
    expect(raw.decorated).toEqual([]);
    const rawkit = await run("/rawkit/x");
    isolated(rawkit.r);
    expect(rawkit.r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(rawkit.decorated).toEqual([{ pathname: "/rawkit/a.0123456789abcdef.js", route: "extra", status: 200 }]);

    const gone = await run("/gone/x.0123456789abcdef.js");
    expect([gone.r.status, gone.r.headers.get("cache-control"), await gone.r.text()]).toEqual([404, "no-store", "not found"]);
    expect(gone.decorated).toEqual([{ pathname: "/gone/x.0123456789abcdef.js", route: "extra", status: 404 }]);

    const shell = await run("/shell/");
    expect(await shell.r.text()).toBe("<!doctype html>gallery");
    expect(shell.decorated).toEqual([{ pathname: "/showcase/", route: "asset", status: 200 }]);

    const probe = await run("/probe", { method: "HEAD" });
    expect(probe.r.headers.get("x-immutable")).toBe("true");
    expect((await run("/probe")).r.status).toBe(404); // GET is not matched: falls to assets
  });

  test("decorate: once per response, after the standard headers, with the route", async () => {
    const infos: DecorateInfo[] = [];
    const w = createWorker({
      rootRedirect: "/showcase/",
      decorate: (headers, info) => {
        infos.push(info);
        headers.set("x-route", info.route ?? "");
        if (info.route === "asset" && info.pathname.startsWith("/showcase/")) headers.set("cache-control", "public, max-age=60");
      },
    });
    const cases: [string, RequestInit | undefined, string, number][] = [
      ["/", undefined, "redirect", 302],
      ["/showcase/", undefined, "asset", 200],
      ["/nope.js", undefined, "asset", 404],
      [SNAPZ, undefined, "artifact", 200],
      [SNAPZ, { headers: { range: "bytes=0-1" } }, "artifact", 206],
      [SNAPZ, { method: "HEAD" }, "artifact", 200],
      [SNAPZ, { method: "POST", body: "x" }, "artifact", 405],
    ];
    for (const [p, init, route, status] of cases) {
      infos.length = 0;
      const r = await w.fetch(req(p, init), makeEnv());
      expect(r.status, p).toBe(status);
      expect(r.headers.get("x-route"), p).toBe(route);
      expect(infos, p).toEqual([{ pathname: new URL(ORIGIN + p).pathname, route, status }]);
    }
    expect((await w.fetch(req("/showcase/"), makeEnv())).headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("isolation: null omits a header, strings replace it, unset keys keep the defaults", async () => {
    const one = await createWorker({ isolation: { coop: null } }).fetch(req("/assets/x.js"), makeEnv());
    expect(one.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(one.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(one.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const none = await createWorker({ isolation: { coop: null, coep: null, corp: null } }).fetch(req(SNAPZ), makeEnv());
    for (const h of ["cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy"]) expect(none.headers.get(h), h).toBeNull();
    expect(none.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const custom = await createWorker({ isolation: { coep: "credentialless", corp: "cross-origin" } }).fetch(req("/"), makeEnv());
    expect(custom.headers.get("cross-origin-embedder-policy")).toBe("credentialless");
    expect(custom.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(custom.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });

  test("isImmutable override (lean4game: vite-hashed /assets/ bundles), and kit.isImmutable is that rule", async () => {
    const vite = (p: string) => isImmutable(p) || /^\/assets\/[^/]+[-.][A-Za-z0-9_-]{8}\.[a-z0-9]+$/.test(p);
    const w = createWorker({ isImmutable: vite });
    expect((await w.fetch(req("/assets/index-AbCd1234.js"), makeEnv())).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await createWorker().fetch(req("/assets/index-AbCd1234.js"), makeEnv())).headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    let kitRule: unknown;
    await createWorker({ isImmutable: vite, extraRoutes: [{ prefix: "/", handle: (_r, _e, _c, kit) => { kitRule = kit.isImmutable; return null; } }] }).fetch(req("/x"), makeEnv());
    expect(kitRule).toBe(vite);
  });

  test("bindings: custom env names, functions, artifact prefixes; a missing binding throws", async () => {
    const assets = fakeAssets(FILES);
    const bucket = fakeBucket(OBJECTS);
    const w = createWorker({ assetsBinding: "SHELL", artifactsBinding: (env: { STORE: { inner: typeof bucket } }) => env.STORE.inner, artifactPrefixes: ["/data/"] });
    const env = { SHELL: assets, STORE: { inner: bucket } };
    expect((await w.fetch(req("/assets/x.js"), env)).status).toBe(200);
    expect((await w.fetch(req("/data/snapshots/index.json"), env)).status).toBe(404);
    expect(bucket.calls).toEqual([{ op: "get", key: "data/snapshots/index.json", argc: 1 }]);
    // /snapshots/ is no longer an artifact prefix: it goes to the assets binding
    await w.fetch(req("/snapshots/index.json"), env);
    expect(assets.calls).toEqual(["GET /assets/x.js", "GET /snapshots/index.json"]);
    await expect(createWorker().fetch(req("/assets/x.js"), {})).rejects.toThrow(/assets binding/);
    await expect(createWorker().fetch(req(SNAPZ), { ASSETS: assets })).rejects.toThrow(/artifacts binding/);
  });

  test("options are checked when the worker is created", () => {
    const bad: [unknown, RegExp][] = [
      [{ range: true }, /unknown option "range"/],
      [{ constructor: 1 }, /unknown option/],
      [{ artifactHead: "body" }, /artifactHead/],
      [{ ranges: "yes" }, /ranges/],
      [{ artifactMethods: [] }, /artifactMethods/],
      [{ artifactPrefixes: ["runtime/"] }, /artifactPrefixes/],
      [{ extraRoutes: [{ handle: () => null }] }, /prefix or a match/],
      [{ extraRoutes: [{ prefix: "/x/" }] }, /handle/],
      [{ isolation: { coop: 1 } }, /isolation\.coop/],
      [{ isolation: { cors: "x" } }, /unknown isolation key/],
      [{ errorCacheControl: 0 }, /errorCacheControl/],
      [{ decorate: "x" }, /decorate/],
      [{ assetsBinding: "" }, /assetsBinding/],
      [{ rootRedirect: 3 }, /rootRedirect/],
      [null, /options must be an object/],
    ];
    for (const [opts, msg] of bad) expect(() => createWorker(opts as EdgeWorkerOptions), JSON.stringify(opts)).toThrow(msg);
    expect(() => createWorker({ ...QED64_LEGACY, ranges: true, isolation: undefined })).not.toThrow();
  });

  test("withIsolationHeaders: with no opts it is the pre-library withHeaders()", async () => {
    const src = new Response("x", { status: 404, statusText: "Not Found", headers: { "cache-control": "private", "x-keep": "1" } });
    const r = withIsolationHeaders(src, "/snapshots/a.0123456789abcdef.snapz");
    isolated(r);
    expect([r.status, r.statusText, r.headers.get("x-keep"), r.headers.get("cache-control"), await r.text()]).toEqual([
      404, "", "1", "public, max-age=31536000, immutable", "x",
    ]);
    const opts = withIsolationHeaders(new Response(null, { status: 500 }), "/a", {
      isolation: { corp: null }, errorCacheControl: "no-store", route: "asset",
      decorate: (h, info) => h.set("x-info", JSON.stringify(info)),
    });
    expect(opts.headers.get("cross-origin-resource-policy")).toBeNull();
    expect(opts.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(opts.headers.get("x-info")!)).toEqual({ pathname: "/a", route: "asset", status: 500 });
    expect(withIsolationHeaders(new Response(""), "/a", { cacheControl: "no-cache" }).headers.get("cache-control")).toBe("no-cache");
  });
});
