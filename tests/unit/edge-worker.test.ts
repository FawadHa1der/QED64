// infra/edge-worker.js — the edge worker as a library — against fake ASSETS /
// R2 bindings (no network, no account, no wrangler).
//
// (a) EQUIVALENCE: QED64's deployed behaviour must not move. A request matrix
//     runs through the ORIGINAL worker (tests/fixtures/edge-worker/
//     worker-47f50e8.js, byte-for-byte `git show 47f50e8:infra/worker.js`,
//     sha256-pinned below) and through createWorker(QED64_LEGACY), and every
//     response must agree on status, statusText, headers and body, and every
//     binding call on its arguments. The shipped infra/worker.js (QED64_LEGACY +
//     the toolchain release, decision 3) agrees exactly on site-owned paths and
//     assets; on /runtime/* and /profiles/<not index.json> it reads
//     lean4-wasm64/<id>/ first, falls back to the root key on a miss, and its
//     misses there are no-store ("the shipped worker" below).
// (b) The hardened defaults other projects get: single-range GETs (If-Range,
//     416), metadata HEAD, 405 + Allow, traversal refusal, r2Prefix
//     validation, rootRedirect, extraRoutes + kit, decorate, isolation
//     overrides, no-store errors.
import { describe, expect, test, vi } from "vitest";
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
  RELEASE_R2_ROOT,
  releaseRoutes,
  resolveRange,
  withIsolationHeaders,
} from "../../infra/edge-worker.js";
import type { DecorateInfo, EdgeWorker, EdgeWorkerOptions, ExtraRoute, ReleaseRecord } from "../../infra/edge-worker.js";

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
/** The paths QED64's record (hosting.mount /runtime/ /profiles/, siteOwned /profiles/index.json) gives the release. */
const releaseMapped = (p: string) => {
  const { pathname } = new URL(ORIGIN + p);
  return pathname.startsWith("/runtime/") || (pathname.startsWith("/profiles/") && pathname !== "/profiles/index.json");
};
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
      // the shipped worker routes release-mapped paths elsewhere: compared below
      for (const [name, w] of subjects.filter(([n]) => n !== "infra/worker.js" || !releaseMapped(c.path))) {
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
    const mappedCases = MATRIX.filter((c) => releaseMapped(c.path)).length;
    expect(mappedCases).toBeGreaterThan(20);
    expect(compared).toBe(MATRIX.length * 2 - mappedCases);
  });

  test("the shipped worker: release-mapped paths read lean4-wasm64/<id>/ first, fall back to the root key, misses are no-store", async () => {
    const pinned = JSON.parse(fs.readFileSync(path.join(root, "toolchain/lean4-wasm64-release.json"), "utf8")) as { id: string };
    const rp = `lean4-wasm64/${pinned.id}/`;
    const toRelease = (key: string) => rp + key; // runtime/x → lean4-wasm64/<id>/runtime/x (the mounts are identity: /runtime/ → runtime/)
    // the same objects, the release's at its prefix: what R2 holds once decision 3 is live
    const moved = Object.fromEntries(Object.entries(OBJECTS).map(([k, v]) => [releaseMapped("/" + k) ? toRelease(k) : k, v]));
    const noStoreErrors = (snap: Awaited<ReturnType<typeof snapshot>>) =>
      snap.status < 400 ? snap : { ...snap, headers: snap.headers.map(([k, v]) => [k, k === "cache-control" ? "no-store" : v] as [string, string]) };
    let compared = 0;
    for (const c of MATRIX.filter((m) => releaseMapped(m.path))) {
      const label = `${c.method} ${c.path}${c.headers ? " " + JSON.stringify(c.headers) : ""}`;
      const init = (): RequestInit => ({ method: c.method, headers: c.headers, ...(c.body !== undefined ? { body: c.body } : {}) });
      const want = makeEnv();
      const wantSnap = noStoreErrors(await snapshot(await legacy.fetch(req(c.path, init()), want)));
      const pathname = new URL(ORIGIN + c.path).pathname;
      const unsafe = artifactKey(pathname) === null;
      // (1) the release prefix populated
      const live = { ASSETS: fakeAssets(FILES), ARTIFACTS: fakeBucket(moved) };
      const liveSnap = await snapshot(await (shipped as EdgeWorker).fetch(req(c.path, init()), live));
      // (2) only the root populated (today's bucket): every read falls back
      const old = makeEnv();
      const oldSnap = await snapshot(await (shipped as EdgeWorker).fetch(req(c.path, init()), old));
      if (unsafe) {
        // refused before R2: the same 404 body, no-store, nothing asked
        for (const [snap, env] of [[liveSnap, live], [oldSnap, old]] as const) {
          expect([snap.status, Buffer.from(snap.body, "base64").toString(), env.ARTIFACTS.calls], label).toEqual([404, "not found", []]);
          expect(snap.headers, label).toContainEqual(["cache-control", "no-store"]);
        }
        compared++;
        continue;
      }
      // a release key's object carries the release key's etag (the fake R2 names etags by key)
      const etagFix = (snap: typeof liveSnap) => ({ ...snap, headers: snap.headers.map(([k, v]) => [k, k === "etag" ? v.replace(rp, "") : v] as [string, string]) });
      expect(etagFix(liveSnap), `release prefix: ${label}`).toEqual(wantSnap);
      expect(oldSnap, `root fallback: ${label}`).toEqual(wantSnap);
      const legacyCalls = want.ARTIFACTS.calls;
      expect(legacyCalls.length, label).toBe(1);
      const [call] = legacyCalls;
      const hit = OBJECTS[call!.key] !== undefined;
      expect(live.ARTIFACTS.calls, `release prefix calls: ${label}`).toEqual(hit ? [{ ...call, key: toRelease(call!.key) }] : [{ ...call, key: toRelease(call!.key) }, call]);
      expect(old.ARTIFACTS.calls, `root fallback calls: ${label}`).toEqual([{ ...call, key: toRelease(call!.key) }, call]);
      compared++;
    }
    expect(compared).toBe(MATRIX.filter((m) => releaseMapped(m.path)).length);
    // what this pins, spelled out
    const env = makeEnv();
    const miss = await (shipped as EdgeWorker).fetch(req("/runtime/chunks/nope.part-001"), env);
    expect([miss.status, miss.headers.get("cache-control")]).toEqual([404, "no-store"]);
    expect(env.ARTIFACTS.calls.map((c) => c.key)).toEqual([`${rp}runtime/chunks/nope.part-001`, "runtime/chunks/nope.part-001"]);
    const site = makeEnv();
    const index = await (shipped as EdgeWorker).fetch(req("/profiles/index.json"), site);
    expect([index.status, site.ARTIFACTS.calls.map((c) => c.key)]).toEqual([200, ["profiles/index.json"]]);
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
      assetHeadLength: false, errorCacheControl: null, r2Prefix: "", rootRedirect: null, decorate: null, isImmutable,
      release: null, releaseFallback: false,
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

  test("HEAD on a static asset carries the Content-Length a GET would (the binding sends none); legacy passes the binding's answer through", async () => {
    const env = makeEnv();
    const r = await w.fetch(req("/showcase/", { method: "HEAD", headers: { range: "bytes=0-3" } }), env);
    expect(r.status).toBe(200);
    isolated(r);
    expect(r.headers.get("content-length")).toBe(String("<!doctype html>gallery".length));
    expect(r.headers.get("content-type")).toBe("text/html");
    expect(r.headers.get("etag")).toBe(`"a-${"<!doctype html>gallery".length}"`);
    expect(r.body).toBeNull();
    expect(env.ASSETS.calls).toEqual(["HEAD /showcase/", "GET /showcase/"]);
    // the follow-up GET drops Range and If-Range (HEAD ignores them) and keeps the other headers
    const seen: Request[] = [];
    const spy = { fetch: async (q: Request) => { seen.push(q); return makeEnv().ASSETS.fetch(q); } };
    await w.fetch(req("/assets/x.js", { method: "HEAD", headers: { range: "bytes=0-3", "if-range": '"x"', "x-pass": "1" } }), { ...makeEnv(), ASSETS: spy });
    expect(seen.map((q) => [q.method, q.headers.get("range"), q.headers.get("if-range"), q.headers.get("x-pass")])).toEqual([["HEAD", "bytes=0-3", '"x"', "1"], ["GET", null, null, "1"]]);
    // a GET that declares its length is not read; a HEAD that already has one, a non-200 HEAD, GET and legacy make no second call
    let cancelled = false;
    const declared = {
      fetch: async (q: Request) => q.method === "HEAD"
        ? new Response(null, { headers: { "content-type": "text/javascript" } })
        : new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": "4242" } }),
    };
    const big = await w.fetch(req("/big.js", { method: "HEAD" }), { ...makeEnv(), ASSETS: declared });
    expect([big.headers.get("content-length"), cancelled]).toEqual(["4242", true]);
    for (const [p, init, worker, calls] of [
      ["/missing.js", { method: "HEAD" }, w, ["HEAD /missing.js"]],
      ["/assets/x.js", {}, w, ["GET /assets/x.js"]],
      ["/showcase/", { method: "HEAD" }, createWorker(QED64_LEGACY), ["HEAD /showcase/"]],
      ["/showcase/", { method: "HEAD" }, createWorker({ assetHeadLength: false }), ["HEAD /showcase/"]],
    ] as [string, RequestInit, EdgeWorker, string[]][]) {
      const e = makeEnv();
      const x = await worker.fetch(req(p, init), e);
      expect(e.ASSETS.calls, `${init.method ?? "GET"} ${p}`).toEqual(calls);
      if (init.method === "HEAD" && x.status === 200) expect(x.headers.get("content-length")).toBeNull();
    }
    const withLength = { fetch: async () => new Response(null, { headers: { "content-length": "7" } }) };
    const seenOnce: string[] = [];
    const once = { fetch: async (q: Request) => { seenOnce.push(q.method); return withLength.fetch(); } };
    expect((await w.fetch(req("/a.js", { method: "HEAD" }), { ...makeEnv(), ASSETS: once })).headers.get("content-length")).toBe("7");
    expect(seenOnce).toEqual(["HEAD"]);
    // the GET is not a 200 (the file changed under us, a 304, …): the HEAD answer stands, the GET body is released
    let released = false;
    const flaky = {
      fetch: async (q: Request) => q.method === "HEAD"
        ? new Response(null, { status: 200 })
        : new Response(new ReadableStream({ cancel() { released = true; } }), { status: 404 }),
    };
    const stands = await w.fetch(req("/gone.js", { method: "HEAD" }), { ...makeEnv(), ASSETS: flaky });
    expect([stands.status, stands.headers.get("content-length"), released]).toEqual([200, null, true]);
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

  test("bindings: custom env names, functions, artifact prefixes; a missing binding answers 500 (logged)", async () => {
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
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.join(" ")));
    try {
      for (const [r, env, msg] of [[req("/assets/x.js"), {}, /assets binding/], [req(SNAPZ), { ASSETS: assets }, /artifacts binding/]] as const) {
        logged.length = 0;
        const out = await createWorker().fetch(r, env);
        expect([out.status, out.headers.get("cache-control"), await out.text()]).toEqual([500, "no-store", "internal error"]);
        isolated(out);
        expect(logged.join("\n")).toMatch(msg);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test("options are checked when the worker is created", () => {
    const bad: [unknown, RegExp][] = [
      [{ range: true }, /unknown option "range"/],
      [{ constructor: 1 }, /unknown option/],
      [{ artifactHead: "body" }, /artifactHead/],
      [{ ranges: "yes" }, /ranges/],
      [{ assetHeadLength: 1 }, /assetHeadLength/],
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

// ------------------------------------------------------------------ (c) the widgets showcase
// Its infra/worker.js (qed64-showcase, 2026-10-05) hand-rolls: the pinned QED64 dist at "/" and
// the gallery at "/showcase/" (two static roots, ONE assets directory: no route needed), a
// ROOT_REDIRECT var for a bare "/", an R2_PREFIX var into the shared bucket, HEAD answered with
// Content-Length (artifacts from head(), assets via GET), and one Range on .snapz. The same
// worker as options, the docs/DEPLOY.md "Using qed64/edge in your own Worker" example:
describe("the showcase's worker as createWorker options", () => {
  type ShowcaseEnv = FakeEnv & { R2_PREFIX?: string; ROOT_REDIRECT?: string };
  const showcase = createWorker<ShowcaseEnv>({
    r2Prefix: (env) => env.R2_PREFIX,
    rootRedirect: (env) => env.ROOT_REDIRECT ?? null,
  });
  const OVERLAY = `/snapshots/widgets8/widgets.${HEX16}.snapz`;
  const objects: Record<string, Obj> = {
    "qed64-showcase/snapshots/widgets8/index.json": { bytes: json({ schema: "qed64.snapshot-index/v1" }), contentType: "application/json" },
    [`qed64-showcase${OVERLAY}`]: { bytes: BYTES },
  };
  const env = (vars: Partial<ShowcaseEnv> = { R2_PREFIX: "qed64-showcase/", ROOT_REDIRECT: "/showcase/" }): ShowcaseEnv =>
    ({ ASSETS: fakeAssets(FILES), ARTIFACTS: fakeBucket(objects), ...vars });

  test("a bare / redirects to the gallery; the gallery's iframe URL (a query) and /showcase/ are static assets", async () => {
    const root = await showcase.fetch(req("/"), env());
    expect([root.status, root.headers.get("location")]).toEqual([302, `${ORIGIN}/showcase/`]);
    isolated(root);
    const frame = await showcase.fetch(req("/?snapshots=snapshots/widgets8"), env());
    expect([frame.status, await frame.text()]).toEqual([200, "<!doctype html>qed64"]);
    const gallery = await showcase.fetch(req("/showcase/"), env());
    expect([gallery.status, await gallery.text()]).toEqual([200, "<!doctype html>gallery"]);
    isolated(gallery);
    // ROOT_REDIRECT unset: "/" is the stock QED64 page
    expect((await showcase.fetch(req("/"), env({ R2_PREFIX: "qed64-showcase/" }))).status).toBe(200);
  });

  test("artifacts come from R2_PREFIX; HEAD carries Content-Length (overlay .snapz and gallery assets); one Range on the .snapz", async () => {
    const e = env();
    const head = await showcase.fetch(req(OVERLAY, { method: "HEAD" }), e);
    expect([head.status, head.headers.get("content-length"), head.headers.get("accept-ranges")]).toEqual([200, "1000", "bytes"]);
    expect(e.ARTIFACTS.calls).toEqual([{ op: "head", key: `qed64-showcase${OVERLAY}` }]);
    const asset = await showcase.fetch(req("/showcase/", { method: "HEAD" }), env());
    expect(asset.headers.get("content-length")).toBe(String("<!doctype html>gallery".length));
    const ranged = await showcase.fetch(req(OVERLAY, { headers: { range: "bytes=100-199" } }), env());
    expect([ranged.status, ranged.headers.get("content-range"), ranged.headers.get("content-length")]).toEqual([206, "bytes 100-199/1000", "100"]);
    expect(await bytesOf(ranged)).toEqual(BYTES.slice(100, 200));
    const past = await showcase.fetch(req(OVERLAY, { headers: { range: "bytes=5000-" } }), env());
    expect([past.status, past.headers.get("content-range"), past.headers.get("cache-control")]).toEqual([416, "bytes */1000", "no-store"]);
    const index = await showcase.fetch(req("/snapshots/widgets8/index.json"), env());
    expect([index.status, index.headers.get("cache-control")]).toEqual([200, "public, max-age=0, must-revalidate"]);
    // without the var the keys are unprefixed (a bucket of one's own)
    const own = env({});
    expect((await showcase.fetch(req(OVERLAY, { method: "HEAD" }), own)).status).toBe(404);
    expect(own.ARTIFACTS.calls).toEqual([{ op: "head", key: OVERLAY.slice(1) }]);
  });

  // docs/DEPLOY.md "What changes against a hand-rolled worker": the five places this configuration
  // answers differently from the showcase's own worker, each pinned on the library's side.
  test("the five differences from the hand-rolled worker: statusText, no-store errors, a HEAD 404's Content-Type, the asset-HEAD GET without Range, an invalid R2_PREFIX", async () => {
    // 1. statusText is dropped (the fake assets binding sets "OK").
    const asset = await showcase.fetch(req("/showcase/"), env());
    expect([asset.status, asset.statusText]).toEqual([200, ""]);
    // 2. no-store on every status >= 400, also on a digest-named path the cache rule calls immutable.
    const missing = `/snapshots/widgets8/widgets.${"f".repeat(16)}.snapz`;
    expect(isImmutable(missing)).toBe(true);
    const errors: [string, RequestInit | undefined, Partial<ShowcaseEnv> | undefined, number][] = [
      [missing, undefined, undefined, 404],
      [missing, { method: "HEAD" }, undefined, 404],
      ["/nope.js", undefined, undefined, 404],
      [OVERLAY, { method: "DELETE" }, undefined, 405],
      [OVERLAY, { headers: { range: "bytes=5000-" } }, undefined, 416],
      [OVERLAY, undefined, { R2_PREFIX: "qed64-showcase" }, 500],
    ];
    for (const [p, init, vars, status] of errors) {
      const r = await showcase.fetch(req(p, init), vars === undefined ? env() : env(vars));
      expect([r.status, r.headers.get("cache-control")], `${init?.method ?? "GET"} ${p}`).toEqual([status, "no-store"]);
    }
    // 3. a HEAD 404 is the same `not found` response as a GET 404, so it carries text/plain.
    const head404 = await showcase.fetch(req(missing, { method: "HEAD" }), env());
    expect([head404.status, head404.headers.get("content-type")]).toEqual([404, "text/plain;charset=UTF-8"]);
    const get404 = await showcase.fetch(req(missing), env());
    expect([get404.status, get404.headers.get("content-type"), await get404.text()]).toEqual([404, "text/plain;charset=UTF-8", "not found"]);
    // 4. the GET that measures an asset HEAD carries no Range or If-Range: the HEAD gets the full length.
    const seen: Request[] = [];
    const spy = { fetch: async (q: Request) => { seen.push(q); return fakeAssets(FILES).fetch(q); } };
    const head = await showcase.fetch(req("/showcase/", { method: "HEAD", headers: { range: "bytes=0-3", "if-range": '"a-22"' } }), { ...env(), ASSETS: spy } as unknown as ShowcaseEnv);
    expect(head.headers.get("content-length")).toBe(String("<!doctype html>gallery".length));
    expect(seen.map((q) => [q.method, q.headers.get("range"), q.headers.get("if-range")])).toEqual([["HEAD", "bytes=0-3", '"a-22"'], ["GET", null, null]]);
    // 5. an R2_PREFIX that is not `name/` segments answers 500 no-store and never reaches R2.
    const e = env({ R2_PREFIX: "qed64-showcase", ROOT_REDIRECT: "/showcase/" });
    const bad = await showcase.fetch(req("/snapshots/widgets8/index.json"), e);
    expect([bad.status, bad.headers.get("cache-control"), await bad.text()]).toEqual([500, "no-store", "artifact prefix misconfigured"]);
    expect(e.ARTIFACTS.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ (c) release: the toolchain's shared R2 prefix
// `release` (decision 3): /runtime/* and /profiles/<not index.json> are the lean4-wasm64 release's,
// read from lean4-wasm64/<id>/; the site's pointers stay under r2Prefix. The record is checked once,
// when the worker is created.
const RID = "lean-v4.34.0-a8817d0";
const RP = `lean4-wasm64/${RID}/`;
const RELEASE: ReleaseRecord = Object.freeze({
  schema: "lean4-wasm64.release/v1",
  id: RID,
  hosting: {
    layout: "served",
    mount: { "/runtime/": "runtime/", "/profiles/": "profiles/" },
    siteOwned: ["/profiles/index.json", "/snapshots/"],
    crossOriginIsolation: { coop: "same-origin", coep: "require-corp", corp: "same-origin" },
  },
  files: [],
  digest: "sha256:" + "0".repeat(64),
});
const withHosting = (hosting: Record<string, unknown>): ReleaseRecord => ({ ...RELEASE, hosting: { ...RELEASE.hosting!, ...hosting } as ReleaseRecord["hosting"] });
const CHUNK = `/runtime/chunks/lean.wasm.${DIGEST.slice(0, 20)}.part-000`;
const PACK = "/profiles/lean-core.pack.gzip.1016929d99bb0ba0e148.part-007";

describe("release: the record is checked when the worker is created", () => {
  const refuse = (opts: EdgeWorkerOptions, msg: RegExp) => {
    let err: unknown;
    try {
      createWorker(opts);
    } catch (e) {
      err = e;
    }
    expect(err, JSON.stringify(opts)).toBeInstanceOf(TypeError);
    expect((err as Error).message, JSON.stringify(opts)).toMatch(msg);
    expect((err as Error).message.split("\n")).toHaveLength(1);
  };

  test("the published record shape is accepted; RELEASE_R2_ROOT is lean4-wasm64/", () => {
    expect(RELEASE_R2_ROOT).toBe("lean4-wasm64/");
    const routes = releaseRoutes(RELEASE);
    expect(routes).toEqual({ id: RID, prefix: RP, mount: [["/profiles/", "profiles/"], ["/runtime/", "runtime/"]], siteOwned: ["/profiles/index.json", "/snapshots/"] });
    expect(Object.isFrozen(routes) && Object.isFrozen(routes.mount) && Object.isFrozen(routes.siteOwned)).toBe(true);
    for (const id of ["lean-v4.34.0-a8817d0", "lean-v4.34.0-41ec565-r2", "lean-v4.35.0-rc1-0123abc", "lean-v4.35.0-rc1.2-0123abc-r10"]) {
      expect(() => createWorker({ release: { ...RELEASE, id } }), id).not.toThrow();
    }
    expect(() => createWorker({ ...QED64_LEGACY, release: RELEASE, releaseFallback: true })).not.toThrow();
  });

  test("not an object", () => {
    for (const bad of ["lean-v4.34.0-a8817d0", [RELEASE], 7]) refuse({ release: bad as unknown as ReleaseRecord }, /release: must be a lean4-wasm64\.release\/v1 object or null/);
  });

  test("schema", () => {
    refuse({ release: { ...RELEASE, schema: "qed64.release/v1" } }, /release: schema "qed64\.release\/v1" is not "lean4-wasm64\.release\/v1"/);
  });

  test("id: lean-v<version>-<kernel7>", () => {
    for (const id of ["v4.34.0-a8817d0", "lean-v4.34-a8817d0", "lean-v4.34.0-a8817d", "lean-v4.34.0-A8817D0", "lean-v4.34.0-a8817d0/", "lean-v4.34.0-a8817d0-r", 7]) {
      refuse({ release: { ...RELEASE, id } as ReleaseRecord }, /release: id .* is not lean-v<version>/);
    }
  });

  test("id: no run of 16+ hex digits (the cache rule would make manifests under it immutable)", () => {
    const id = "lean-v4.34.0-0123456789abcdef0-a8817d0";
    expect(isImmutable(`/lean4-wasm64/${id}/runtime/x.json`)).toBe(true);
    refuse({ release: { ...RELEASE, id } }, /run of 16\+ hex digits/);
  });

  test('hosting.layout "served"', () => {
    refuse({ release: { ...RELEASE, hosting: null } }, /release: hosting must be an object/);
    refuse({ release: withHosting({ layout: "archive" }) }, /release: hosting\.layout "archive" is not "served"/);
  });

  test("hosting.mount: keys are configured artifact prefixes", () => {
    refuse({ release: withHosting({ mount: { "/lib/": "lib/" } }) }, /hosting\.mount key "\/lib\/" is not one of the artifact prefixes/);
    refuse({ release: withHosting({ mount: {} }) }, /hosting\.mount must be a non-empty object/);
    // against the CONFIGURED prefixes, not the defaults
    refuse({ artifactPrefixes: ["/data/"], release: RELEASE }, /hosting\.mount key "\/runtime\/" is not one of the artifact prefixes \/data\//);
  });

  test("hosting.mount: values are one top-level directory", () => {
    for (const dir of ["runtime", "a/b/", "../", "./", "/runtime/", "", "run time/", 3]) {
      refuse({ release: withHosting({ mount: { "/runtime/": dir } }) }, /hosting\.mount \/runtime\/ → .* is not one top-level directory/);
    }
  });

  test("hosting.siteOwned: exact paths or /-ended prefixes under an artifact prefix", () => {
    for (const entry of ["/index.json", "profiles/index.json", "/snapshots//x", "/profiles/../index.json", 5]) {
      refuse({ release: withHosting({ siteOwned: [entry] }) }, /hosting\.siteOwned entry .* is not a path/);
    }
    refuse({ release: withHosting({ siteOwned: "/snapshots/" }) }, /hosting\.siteOwned must be an array/);
    expect(() => createWorker({ release: withHosting({ siteOwned: undefined }) })).not.toThrow();
  });

  test("releaseFallback: a boolean, and only with a release", () => {
    refuse({ release: RELEASE, releaseFallback: "yes" as unknown as boolean }, /releaseFallback must be a boolean/);
    refuse({ releaseFallback: true }, /releaseFallback needs a release/);
    refuse({ ...QED64_LEGACY, releaseFallback: true }, /releaseFallback needs a release/);
  });
});

describe("release: routing", () => {
  const bucketWith = (keys: string[]) => fakeBucket(Object.fromEntries(keys.map((k) => [k, { bytes: BYTES, contentType: "application/octet-stream" }])));
  const keysAsked = async (w: EdgeWorker, p: string, init?: RequestInit, keys: string[] = []) => {
    const env = { ASSETS: fakeAssets(FILES), ARTIFACTS: bucketWith(keys) };
    const r = await w.fetch(req(p, init), env);
    return { r, calls: env.ARTIFACTS.calls.map((c) => `${c.op} ${c.key}`) };
  };

  test("1. siteOwned → r2Prefix; 2. a mount → lean4-wasm64/<id>/<dir><rest>; 3. any other artifact path → r2Prefix", async () => {
    const w = createWorker({ release: RELEASE, r2Prefix: "site/", artifactPrefixes: [...DEFAULT_ARTIFACT_PREFIXES, "/extra/"] });
    const table: [string, string][] = [
      ["/runtime/runtime-manifest.json", `${RP}runtime/runtime-manifest.json`],
      [`/runtime/runtime-manifest.wasm64-${HEX16}.json`, `${RP}runtime/runtime-manifest.wasm64-${HEX16}.json`],
      [CHUNK, `${RP}runtime${CHUNK.slice("/runtime".length)}`],
      ["/profiles/lean-core.manifest.json", `${RP}profiles/lean-core.manifest.json`],
      [PACK, `${RP}profiles${PACK.slice("/profiles".length)}`],
      ["/profiles/index.json", "site/profiles/index.json"],
      ["/profiles/sub/index.json", `${RP}profiles/sub/index.json`], // siteOwned is exact unless it ends in "/"
      ["/profiles/index.json.gz", `${RP}profiles/index.json.gz`], // ... so an exact entry is not a prefix
      ["/profiles/index.jsonx", `${RP}profiles/index.jsonx`],
      ["/snapshots/index.json", "site/snapshots/index.json"],
      [SNAPZ, `site${SNAPZ}`],
      ["/extra/x.json", "site/extra/x.json"],
    ];
    for (const [p, key] of table) {
      const { r, calls } = await keysAsked(w, p, undefined, [key]);
      expect([r.status, calls], p).toEqual([200, [`get ${key}`]]);
    }
  });

  test('r2Prefix "" (the bucket root) and (env) => prefix; a "/"-ended siteOwned prefix inside a mount', async () => {
    const root = createWorker({ release: RELEASE, r2Prefix: "" });
    expect((await keysAsked(root, "/snapshots/index.json")).calls).toEqual(["get snapshots/index.json"]);
    expect((await keysAsked(root, "/profiles/index.json")).calls).toEqual(["get profiles/index.json"]);
    expect((await keysAsked(root, "/runtime/runtime-manifest.json")).calls).toEqual([`get ${RP}runtime/runtime-manifest.json`]);
    const fromEnv = createWorker<{ P?: string } & FakeEnv>({ release: RELEASE, r2Prefix: (env) => env.P });
    const env = { ...makeEnv(), P: "game/" };
    await fromEnv.fetch(req("/snapshots/index.json"), env);
    await fromEnv.fetch(req("/runtime/runtime-manifest.json"), env);
    expect(env.ARTIFACTS.calls.map((c) => c.key)).toEqual(["game/snapshots/index.json", `${RP}runtime/runtime-manifest.json`]);
    const local = createWorker({ release: withHosting({ siteOwned: ["/profiles/index.json", "/snapshots/", "/runtime/local/"] }), r2Prefix: "site/" });
    expect((await keysAsked(local, "/runtime/local/a.json")).calls).toEqual(["get site/runtime/local/a.json"]);
    expect((await keysAsked(local, "/runtime/localx.json")).calls).toEqual([`get ${RP}runtime/localx.json`]);
  });

  test("kit.serveArtifact routes by the pathname it is given", async () => {
    const w = createWorker({
      release: RELEASE,
      r2Prefix: "site/",
      extraRoutes: [{ prefix: "/game/", handle: (r, _e, _c, kit) => kit.serveArtifact(r, new URL(r.url).pathname.replace(/^\/game\/[^/]+/, "")) }],
    });
    expect((await keysAsked(w, "/game/nng/runtime/runtime-manifest.json")).calls).toEqual([`get ${RP}runtime/runtime-manifest.json`]);
    expect((await keysAsked(w, "/game/nng/snapshots/index.json")).calls).toEqual(["get site/snapshots/index.json"]);
  });

  test("unsafe release paths: 404 no-store without asking R2, even under QED64_LEGACY (rejectUnsafeKeys false)", async () => {
    for (const opts of [{ release: RELEASE }, { ...QED64_LEGACY, release: RELEASE, releaseFallback: true }] as EdgeWorkerOptions[]) {
      const raw: string[] = [];
      const w = createWorker({ ...opts, extraRoutes: [{ prefix: "/raw/", handle: (r, _e, _c, kit) => kit.serveArtifact(r, raw.shift()) }] });
      for (const p of ["/runtime/", "/runtime//runtime-manifest.json", "/profiles/a//b.json", "/profiles/x/"]) {
        const { r, calls } = await keysAsked(w, p);
        expect([r.status, r.headers.get("cache-control"), await r.text(), calls], p).toEqual([404, "no-store", "not found", []]);
        isolated(r);
      }
      for (const p of ["/runtime/%2e%2e/x.json", "/runtime/a\\b.json", "/profiles/a\u0001.json", "/runtime/./x.json"]) {
        raw.push(p);
        const { r, calls } = await keysAsked(w, "/raw/x");
        expect([r.status, r.headers.get("cache-control"), calls], JSON.stringify(p)).toEqual([404, "no-store", []]);
      }
    }
    // site paths keep rejectUnsafeKeys' answer: legacy reads the key as is
    const legacyRelease = createWorker({ ...QED64_LEGACY, release: RELEASE });
    expect((await keysAsked(legacyRelease, "/snapshots//index.json")).calls).toEqual(["get snapshots//index.json"]);
  });
});

describe("release: the one-cycle fallback to the site prefix", () => {
  const ROOT_ONLY = (p: string) => ({ [p.slice(1)]: { bytes: BYTES, contentType: "application/octet-stream" } as Obj });
  const run = async (w: EdgeWorker, p: string, objects: Record<string, Obj>, init?: RequestInit) => {
    const env = { ASSETS: fakeAssets(FILES), ARTIFACTS: fakeBucket(objects) };
    const r = await w.fetch(req(p, init), env);
    return { r, calls: env.ARTIFACTS.calls };
  };
  const hardened = createWorker({ release: RELEASE, releaseFallback: true });
  const legacyish = createWorker({ ...QED64_LEGACY, release: RELEASE, releaseFallback: true });
  const releaseKey = `${RP}runtime${CHUNK.slice("/runtime".length)}`;
  const rootKey = CHUNK.slice(1);
  const both = { [releaseKey]: { bytes: BYTES }, [rootKey]: { bytes: BYTES.slice(0, 10) } };

  test("GET: a hit never falls back; a miss retries once under the site prefix; both missing → 404 no-store", async () => {
    for (const w of [hardened, legacyish]) {
      const hit = await run(w, CHUNK, both);
      expect([hit.r.status, (await bytesOf(hit.r)).length, hit.calls]).toEqual([200, 1000, [{ op: "get", key: releaseKey, argc: 1 }]]);
      const fell = await run(w, CHUNK, ROOT_ONLY(CHUNK));
      expect([fell.r.status, fell.r.headers.get("cache-control"), fell.calls]).toEqual([
        200, "public, max-age=31536000, immutable", [{ op: "get", key: releaseKey, argc: 1 }, { op: "get", key: rootKey, argc: 1 }],
      ]);
      expect(await bytesOf(fell.r)).toEqual(BYTES);
      const gone = await run(w, CHUNK, {});
      expect([gone.r.status, gone.r.headers.get("cache-control"), gone.calls.map((c) => c.key)]).toEqual([404, "no-store", [releaseKey, rootKey]]);
    }
    // without releaseFallback the miss is final
    const strict = await run(createWorker({ release: RELEASE }), CHUNK, ROOT_ONLY(CHUNK));
    expect([strict.r.status, strict.calls.map((c) => c.key)]).toEqual([404, [releaseKey]]);
  });

  test("HEAD (metadata): head() hit, head() miss → head() at the site key, Content-Length of the object that answered", async () => {
    const hit = await run(hardened, CHUNK, both, { method: "HEAD" });
    expect([hit.r.status, hit.r.headers.get("content-length"), hit.calls]).toEqual([200, "1000", [{ op: "head", key: releaseKey }]]);
    const fell = await run(hardened, CHUNK, ROOT_ONLY(CHUNK), { method: "HEAD" });
    expect([fell.r.status, fell.r.headers.get("content-length"), fell.calls]).toEqual([200, "1000", [{ op: "head", key: releaseKey }, { op: "head", key: rootKey }]]);
    const gone = await run(hardened, CHUNK, {}, { method: "HEAD" });
    expect([gone.r.status, gone.r.headers.get("cache-control"), gone.calls.length]).toEqual([404, "no-store", 2]);
    // legacy HEAD reads with get(), so its fallback is a get() too
    const legacyHead = await run(legacyish, CHUNK, ROOT_ONLY(CHUNK), { method: "HEAD" });
    expect([legacyHead.r.status, legacyHead.calls.map((c) => c.op)]).toEqual([200, ["get", "get"]]);
  });

  test("Range: the decision head() falls back, the ranged get() reads the key that answered; If-Range and 416 against that object", async () => {
    const hit = await run(hardened, CHUNK, both, { headers: { range: "bytes=0-9" } });
    expect([hit.r.status, hit.calls]).toEqual([206, [{ op: "head", key: releaseKey }, { op: "get", key: releaseKey, argc: 2, range: "bytes=0-9" }]]);
    const fell = await run(hardened, CHUNK, ROOT_ONLY(CHUNK), { headers: { range: "bytes=10-19" } });
    expect([fell.r.status, fell.r.headers.get("content-range"), fell.calls]).toEqual([
      206, "bytes 10-19/1000", [{ op: "head", key: releaseKey }, { op: "head", key: rootKey }, { op: "get", key: rootKey, argc: 2, range: "bytes=10-19" }],
    ]);
    expect(await bytesOf(fell.r)).toEqual(BYTES.slice(10, 20));
    const resumed = await run(hardened, CHUNK, ROOT_ONLY(CHUNK), { headers: { range: "bytes=10-", "if-range": `"etag-${rootKey}"` } });
    expect(resumed.r.status).toBe(206);
    const stale = await run(hardened, CHUNK, ROOT_ONLY(CHUNK), { headers: { range: "bytes=10-", "if-range": `"etag-${releaseKey}"` } });
    expect([stale.r.status, stale.calls.map((c) => `${c.op} ${c.key}`)]).toEqual([200, [`head ${releaseKey}`, `head ${rootKey}`, `get ${rootKey}`]]);
    // 416 is decided on the object found; the fallback is not consulted again
    const past = await run(hardened, CHUNK, ROOT_ONLY(CHUNK), { headers: { range: "bytes=5000-" } });
    expect([past.r.status, past.r.headers.get("cache-control"), past.calls.length]).toEqual([416, "no-store", 2]);
    const pastHit = await run(hardened, CHUNK, both, { headers: { range: "bytes=5000-" } });
    expect([pastHit.r.status, pastHit.calls.length]).toEqual([416, 1]);
  });

  test("Range: once head() answered at the release key, a ranged get() that then misses is a 404, never a site-key read", async () => {
    // The object is removed between head() and get(): the site key holds other bytes, whose size and
    // etag did not decide If-Range or 416, so it must not be read.
    const objects = { [releaseKey]: { bytes: BYTES }, [rootKey]: { bytes: BYTES.slice(0, 10) } };
    const bucket = fakeBucket(objects);
    const realHead = bucket.head;
    bucket.head = async (key: string) => {
      const found = await realHead(key);
      if (key === releaseKey) delete (objects as Record<string, Obj>)[releaseKey];
      return found;
    };
    const env = { ASSETS: fakeAssets(FILES), ARTIFACTS: bucket };
    const r = await hardened.fetch(req(CHUNK, { headers: { range: "bytes=0-9" } }), env);
    expect([r.status, r.headers.get("cache-control"), bucket.calls.map((c) => `${c.op} ${c.key}`)]).toEqual([
      404, "no-store", [`head ${releaseKey}`, `get ${releaseKey}`],
    ]);
    isolated(r);
  });

  test("405 never looks anything up; site-owned misses never fall back", async () => {
    const del = await run(hardened, CHUNK, ROOT_ONLY(CHUNK), { method: "DELETE" });
    expect([del.r.status, del.r.headers.get("cache-control"), del.r.headers.get("allow"), del.calls]).toEqual([405, "no-store", "GET, HEAD", []]);
    const snap = await run(hardened, `/snapshots/missing.${HEX16}.snapz`, {});
    expect(snap.calls.map((c) => c.key)).toEqual([`snapshots/missing.${HEX16}.snapz`]);
    const index = await run(hardened, "/profiles/index.json", {});
    expect(index.calls.map((c) => c.key)).toEqual(["profiles/index.json"]);
  });
});

describe("release: errors on release-mapped paths are never cached", () => {
  test("QED64_LEGACY + release: release-mapped 404s are no-store, site 404s keep the legacy path rule", async () => {
    const w = createWorker({ ...QED64_LEGACY, release: RELEASE, releaseFallback: true });
    for (const p of [`/runtime/chunks/missing.${HEX16}.part-000`, "/runtime/runtime-manifest.json", `/profiles/missing.${DIGEST.slice(0, 20)}.part-001`]) {
      const r = await w.fetch(req(p), { ASSETS: fakeAssets(FILES), ARTIFACTS: fakeBucket({}) });
      expect([r.status, r.headers.get("cache-control"), await r.text()], p).toEqual([404, "no-store", "not found"]);
      isolated(r);
    }
    const site = await w.fetch(req(`/snapshots/missing.${HEX16}.snapz`), makeEnv());
    expect([site.status, site.headers.get("cache-control")]).toEqual([404, "public, max-age=31536000, immutable"]);
  });

  test("a custom errorCacheControl applies to site paths only; 405 and 416 on release paths are no-store", async () => {
    const w = createWorker({ release: RELEASE, errorCacheControl: "public, max-age=60" });
    const env = () => ({ ASSETS: fakeAssets(FILES), ARTIFACTS: fakeBucket({ [`${RP}runtime${CHUNK.slice(8)}`]: { bytes: BYTES } }) });
    const cases: [string, RequestInit | undefined, number, string][] = [
      [`/runtime/chunks/missing.${HEX16}.part-000`, undefined, 404, "no-store"],
      [CHUNK, { method: "PUT", body: "x" }, 405, "no-store"],
      [CHUNK, { headers: { range: "bytes=5000-" } }, 416, "no-store"],
      [`/snapshots/missing.${HEX16}.snapz`, undefined, 404, "public, max-age=60"],
      [SNAPZ, { method: "PUT", body: "x" }, 405, "public, max-age=60"],
      ["/nope.js", undefined, 404, "public, max-age=60"],
    ];
    for (const [p, init, status, cc] of cases) {
      const r = await w.fetch(req(p, init), env());
      expect([r.status, r.headers.get("cache-control")], `${init?.method ?? "GET"} ${p}`).toEqual([status, cc]);
    }
    // a release-mapped success keeps the path rule
    const ok = await w.fetch(req(CHUNK), env());
    expect([ok.status, ok.headers.get("cache-control")]).toEqual([200, "public, max-age=31536000, immutable"]);
  });
});

describe("release: Range and HEAD are the same whichever prefix a path maps to", () => {
  // One path, three routings of the same bytes: the release prefix, the site prefix (a record that
  // leaves /profiles/ to the site) and the release miss that falls back to the site prefix.
  const routings: [string, EdgeWorker, string][] = [
    ["release", createWorker({ release: RELEASE, r2Prefix: "site/" }), `${RP}profiles${PACK.slice("/profiles".length)}`],
    ["site", createWorker({ release: withHosting({ siteOwned: ["/profiles/", "/snapshots/"] }), r2Prefix: "site/" }), `site${PACK}`],
    ["fallback", createWorker({ release: RELEASE, r2Prefix: "site/", releaseFallback: true }), `site${PACK}`],
  ];
  const ETAG_FIXED = '"etag-fixed"';
  const objects = (key: string): ReturnType<typeof fakeBucket> => {
    const b = fakeBucket({ [key]: { bytes: BYTES, contentType: "application/octet-stream" } });
    const head = b.head.bind(b);
    const get = b.get.bind(b);
    // the same object under either key: the same etag
    return Object.assign(b, {
      head: async (k: string) => { const m = await head(k); return m && { ...m, httpEtag: ETAG_FIXED }; },
      get: async (k: string, o?: { range?: Headers }) => { const m = await get(k, o); return m && { ...m, httpEtag: ETAG_FIXED }; },
    });
  };
  const variants: [string, RequestInit][] = [
    ["HEAD", { method: "HEAD" }],
    ["HEAD + Range", { method: "HEAD", headers: { range: "bytes=0-9" } }],
    ["GET", {}],
    ["bytes=0-99", { headers: { range: "bytes=0-99" } }],
    ["bytes=-100", { headers: { range: "bytes=-100" } }],
    ["bytes=990-", { headers: { range: "bytes=990-" } }],
    ["If-Range strong", { headers: { range: "bytes=500-", "if-range": ETAG_FIXED } }],
    ["If-Range weak", { headers: { range: "bytes=500-", "if-range": "W/" + ETAG_FIXED } }],
    ["If-Range stale", { headers: { range: "bytes=500-", "if-range": '"other"' } }],
    ["416", { headers: { range: "bytes=1000-" } }],
    ["multi-range", { headers: { range: "bytes=0-1,5-6" } }],
  ];

  test(`${variants.length} requests × ${routings.length} routings: identical status, headers and body`, async () => {
    for (const [label, init] of variants) {
      const seen = [];
      for (const [name, w, key] of routings) {
        const r = await w.fetch(req(PACK, init), { ASSETS: fakeAssets(FILES), ARTIFACTS: objects(key) });
        seen.push({ name, snap: await snapshot(r) });
      }
      for (const s of seen.slice(1)) expect(s.snap, `${s.name}: ${label}`).toEqual(seen[0]!.snap);
    }
    // what they agree on
    const [, w, key] = routings[0]!;
    const head = await w.fetch(req(PACK, { method: "HEAD" }), { ASSETS: fakeAssets(FILES), ARTIFACTS: objects(key) });
    expect([head.headers.get("content-length"), head.headers.get("accept-ranges")]).toEqual(["1000", "bytes"]);
    const part = await w.fetch(req(PACK, { headers: { range: "bytes=0-99" } }), { ASSETS: fakeAssets(FILES), ARTIFACTS: objects(key) });
    expect([part.status, part.headers.get("content-range"), part.headers.get("content-length")]).toEqual([206, "bytes 0-99/1000", "100"]);
  });
});

describe("an exception while answering", () => {
  test("a throwing binding: 500 internal error, isolation headers, no-store, logged with the path", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.join(" ")));
    try {
      const boom = { get: async () => { throw new Error("R2 exploded"); }, head: async () => { throw new Error("R2 exploded"); } };
      const assetsBoom = { fetch: async () => { throw new Error("assets exploded"); } };
      for (const [w, p, env] of [
        [createWorker({ release: RELEASE, releaseFallback: true }), CHUNK, { ASSETS: fakeAssets(FILES), ARTIFACTS: boom }],
        [createWorker({ ...QED64_LEGACY, release: RELEASE }), SNAPZ, { ASSETS: fakeAssets(FILES), ARTIFACTS: boom }],
        [createWorker(QED64_LEGACY), "/assets/x.js", { ASSETS: assetsBoom, ARTIFACTS: boom }],
      ] as const) {
        logged.length = 0;
        const r = await w.fetch(req(p), env);
        expect([r.status, r.headers.get("cache-control"), await r.text()], p).toEqual([500, "no-store", "internal error"]);
        isolated(r);
        expect(logged.join("\n"), p).toMatch(new RegExp(`edge-worker: GET ${p.replace(/[.]/g, "\\.")}: .*exploded`));
      }
      // decorate throwing: still a 500 with the isolation headers (without decorate's word)
      const bad = createWorker({ decorate: () => { throw new Error("decorate exploded"); } });
      const r = await bad.fetch(req("/assets/x.js"), makeEnv());
      expect([r.status, r.headers.get("cache-control")]).toEqual([500, "no-store"]);
      isolated(r);
    } finally {
      spy.mockRestore();
    }
  });
});
