// Local production preview: the LIVE Worker's own code (infra/worker.js) behind
// a Node http server, so a local build and https://qed64.<account>.workers.dev
// answer through one code path. Use it to verify a production build end to
// end before pushing:
//   npm run build:site && npm run preview:prod   → http://localhost:5185
//
// Each request becomes a Fetch Request and goes to worker.fetch(request, env,
// ctx); its Response is written back (status, every header, the body streamed;
// HEAD sends none). env holds Node stand-ins for the two bindings in
// wrangler.toml:
//   ASSETS     the Workers static-assets subset QED64 relies on, over DIST
//              (`[assets] directory = "dist"`, run_worker_first, no
//              not_found_handling, the default html_handling
//              "auto-trailing-slash"): "/" and "<dir>/" serve their
//              index.html; "/x/index.html" and "/x.html" answer 307 to "/x/"
//              and "/x" (the query kept), "/x" serves x.html ("/index" and
//              "<dir>/index" instead answer 307 to "/" and "<dir>/") and
//              "/dir" answers 307 to "/dir/" when dir/index.html exists; a
//              path with a run of slashes ("//assets/x.html") is resolved
//              with them collapsed and answers one 307: to that rule's
//              target, or to the collapsed path when it would serve a file
//              (no Location ever starts with "//"); another
//              existing file is a 200 with the content type by extension
//              (ASSET_MIME), an etag and, on GET, Content-Length (HTML has
//              neither etag nor length, as on the live site); HEAD has no
//              body and, like the real binding, no Content-Length;
//              If-None-Match on the etag answers 304; anything else is a 404
//              with an empty body and no Content-Type, and methods other than
//              GET/HEAD a 405. Range is ignored. A path is percent-decoded
//              once; a "." or ".." segment, a backslash or a NUL is refused
//              (404), and so is a file whose realpath leaves DIST (a symlink
//              pointing outside).
//   ARTIFACTS  an R2 bucket, structurally, over <repo>/public: the key
//              "runtime/chunks/x" (artifactKey's shape) is public/runtime/
//              chunks/x, only under runtime/, profiles/ and snapshots/. The
//              toolchain release's keys (decision 3: infra/worker.js reads
//              /runtime/* and /profiles/<not index.json> from
//              "lean4-wasm64/<id>/runtime/…" and "…/profiles/…", <id> the
//              pinned toolchain/lean4-wasm64-release.json's) are
//              $QED64_RELEASE_DIR/<rest> when QED64_RELEASE_DIR names a
//              served-layout release directory of that id (a fork release dir
//              such as …/wasm64-lean-kernel-release/lean-v4.34.0-a8817d0,
//              read-only), else public/<rest>: today's public/ trees
//              (symlinked, or filled by `npm run fetch:artifacts`) keep
//              working unchanged, and a file only under public/ is still
//              found through the Worker's one-cycle fallback to the root key.
//              Another release id is absent. Nothing is ever written.
//              Symlinks inside public/ are followed (the worktree layout links
//              chunks/ and snapshots into the main checkout). head(key) and
//              get(key, {range}) return null when absent; the objects carry
//              size, httpEtag and writeHttpMetadata (the Content-Type rclone
//              stores: application/json for .json, application/wasm for
//              .wasm, else application/octet-stream), and get's body streams
//              the file (never read whole: snapshots are 350-850 MB). A range
//              read reports object.range {offset, length}. httpEtag is a
//              quoted md5 of "<size>-<mtimeMs>": stable while the file is
//              unchanged, NOT R2's md5 of the content, so it never equals the
//              live site's etag for the same bytes.
// A file that stats but cannot be opened (EACCES, or a snapshot replaced in
// the main checkout between stat and open) is opened before the binding
// returns, so the binding throws and the request answers 500 "internal error"
// with the isolation headers (logged), never a 200 head and a reset socket; a
// read error after the head is logged (a client going away is not).
// Content-Length: live R2 bodies carry their length, so an artifact GET on the
// live (legacy) Worker has Content-Length although the worker sets none. The
// Node layer adds it from the object's known size when the worker's response
// has none, and for the worker's own small bodies ("not found": the live 404
// has Content-Length: 9) from the bytes; it never does for HEAD (the live
// legacy HEAD carries none either). The live headers this mimics were read
// with curl on 2026-10-06; tests/unit/serve-dist.test.ts pins them.
//
// QED64_EDGE=legacy (default) runs infra/worker.js exactly, what the live site
// runs (createWorker({...QED64_LEGACY, release, releaseFallback: true}));
// QED64_EDGE=hardened runs createWorker({ release, releaseFallback: true }), the
// hardened defaults (ranges, metadata HEAD, 405, no-store errors), which
// the live site has NOT adopted: preview and test them here. Any other value
// exits 2 with the usage line, before listening.
//
// Local only, never in the Worker: GET/HEAD /embed-host.html is answered in
// the Node layer before the worker, from public/embed-host.html with the
// isolation headers (the test-only embed host; reload-storm --embed and the
// page-api lane load it on a build).
//
// PORT (default 5185) picks the port; DIST=<dir> serves a saved build instead
// of dist/ (an A/B against the current build on a second PORT);
// QED64_RELEASE_DIR=<dir> serves the toolchain release's files from a release
// directory (above). A QED64_RELEASE_DIR that is not a served-layout release
// directory of the pinned id exits 2 with the usage line, before listening.
// The hardened mode is what infra/worker.js would be with the hardened
// defaults: createWorker({ release, releaseFallback: true }) on the same pinned
// record, so it previews exactly what adopting them would ship.
//
// Tests import createDistServer (tests/unit/serve-dist.test.ts); it listens
// only when run as the main module.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import legacyWorker from "../infra/worker.js";
import { createWorker, DEFAULT_ARTIFACT_PREFIXES, parseRange, RELEASE_R2_ROOT, resolveRange } from "../infra/edge-worker.js";
import pinnedRelease from "../toolchain/lean4-wasm64-release.json" with { type: "json" };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_PORT = 5185;
export const DEFAULT_DIST = path.join(ROOT, "dist");
export const DEFAULT_PUBLIC = path.join(ROOT, "public");
export const USAGE = "usage: [PORT=<port>] [DIST=<dir>] [QED64_EDGE=legacy|hardened] [QED64_RELEASE_DIR=<release dir>] node scripts/serve-dist.mjs";
/** The release id infra/worker.js routes to (the pinned record's). */
export const RELEASE_ID = pinnedRelease.id;

/** The edge modes: the worker each one runs. */
export const EDGE_MODES = Object.freeze({
  legacy: () => legacyWorker,
  hardened: () => createWorker({ release: pinnedRelease, releaseFallback: true }),
});

// Workers static assets' content types, as the live site sends them (checked
// 2026-10-06: text/html and text/javascript without a charset, and video/mp2t
// for the .d.ts files infoview ships).
export const ASSET_MIME = Object.freeze({
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".ts": "video/mp2t",
});

// What rclone (scripts/upload-artifacts.sh) stores as the R2 object's
// Content-Type: Go's type for the extension, application/octet-stream for the
// digest-suffixed .part-NNN and .snapz names.
export const ARTIFACT_MIME = Object.freeze({ ".json": "application/json", ".wasm": "application/wasm" });

const ARTIFACT_DIRS = DEFAULT_ARTIFACT_PREFIXES.map((p) => p.slice(1, -1));
const ISOLATION = Object.freeze({
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
});
// Request headers that describe the client connection, not the request.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "http2-settings"]);

// File streams the bindings made, by body: the length the Node layer sends as
// Content-Length when the worker's response carries none (as the Workers
// runtime does for an R2 body), or null to stream it chunked with no length
// (the live site's HTML assets).
const knownLength = new WeakMap();

const etagOf = (st) => `"${createHash("md5").update(`${st.size}-${st.mtimeMs}`).digest("hex")}"`;

// Opened here, eagerly: a file that stats but cannot be opened throws now, in
// the binding, rather than inside the response pipeline after a 200 head.
async function fileStream(file, start, length, { lengthKnown = true } = {}) {
  const fh = await open(file, "r");
  let body;
  if (length === 0) {
    await fh.close();
    body = new ReadableStream({ start: (c) => c.close() });
  } else {
    body = Readable.toWeb(fh.createReadStream({ start, end: start + length - 1, autoClose: true }));
  }
  knownLength.set(body, lengthKnown ? length : null);
  return body;
}

async function statFile(file) {
  try {
    const st = await stat(file); // follows symlinks
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** The ASSETS binding over `dist`: `{ fetch(request) }` (see the header). */
export function createAssetsBinding(dist) {
  const root = path.resolve(dist);
  const notFound = () => new Response(null, { status: 404 });
  // Never a protocol-relative Location ("//host/x" is another host to a browser).
  const redirect = (location) => new Response(null, { status: 307, headers: { location: location.replace(/^\/{2,}/, "/") } });
  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

  // The file for a decoded, segment-checked path, or null; its realpath must stay inside dist.
  async function lookup(rel) {
    const file = path.join(root, rel);
    const st = await statFile(file);
    if (st === null) return null;
    let real, realRoot;
    try {
      [real, realRoot] = await Promise.all([realpath(file), realpath(root)]);
    } catch {
      return null;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return { file, st };
  }

  async function serve(request, { file, st }) {
    const ext = path.extname(file).toLowerCase();
    const headers = new Headers({ "content-type": ASSET_MIME[ext] ?? "application/octet-stream" });
    // The live site's HTML (the shell, the extension-host iframe) comes with
    // neither an etag nor a Content-Length (checked 2026-10-06); every other
    // asset carries both.
    if (ext === ".html") {
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(await fileStream(file, 0, st.size, { lengthKnown: false }), { status: 200, headers });
    }
    const etag = etagOf(st);
    headers.set("etag", etag);
    const inm = request.headers.get("if-none-match");
    if (inm !== null && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*")) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    headers.set("content-length", String(st.size));
    return new Response(await fileStream(file, 0, st.size), { status: 200, headers });
  }

  // auto-trailing-slash for a decoded, segment-checked path with no run of
  // slashes: { to } (a redirect target, unencoded, without the query),
  // { found } (the file to serve), or null (404).
  async function resolve(p) {
    if (p.endsWith("/index.html")) return (await lookup(p)) ? { to: p.slice(0, -"index.html".length) } : null;
    if (p.endsWith(".html")) return (await lookup(p)) ? { to: p.slice(0, -".html".length) } : null;
    if (p.endsWith("/")) {
      const index = await lookup(p + "index.html");
      return index ? { found: index } : null;
    }
    const exact = await lookup(p);
    if (exact) return { found: exact };
    const html = await lookup(p + ".html");
    // "/index" and "<dir>/index" are index.html, which is "/" and "<dir>/" (live: 307)
    if (html) return p.endsWith("/index") ? { to: p.slice(0, -"index".length) } : { found: html };
    if (await lookup(p + "/index.html")) return { to: p + "/" };
    return null;
  }

  return {
    async fetch(request) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const url = new URL(request.url);
      let p;
      try {
        p = decodeURIComponent(url.pathname);
      } catch {
        return notFound();
      }
      if (/[\\\u0000]/.test(p) || p.split("/").some((s) => s === "." || s === "..")) return notFound();
      const q = url.search;
      // Runs of slashes collapse (as live): "//assets/x.html" answers one 307
      // straight to "/assets/x", "//assets/x.css" one 307 to "/assets/x.css".
      const c = p.replace(/\/{2,}/g, "/");
      const r = await resolve(c);
      if (r === null) return notFound();
      if (r.to !== undefined) return redirect(encodePath(r.to) + q);
      if (c !== p) return redirect(encodePath(c) + q);
      return serve(request, r.found);
    },
  };
}

/** Why `dir` is not a served-layout release directory of release `id`, or null when it is
 * (release.json there: schema lean4-wasm64.release/v1, that id, hosting.layout "served"). */
export function releaseDirProblem(dir, id = RELEASE_ID) {
  let record;
  try {
    record = JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8"));
  } catch (err) {
    return `QED64_RELEASE_DIR=${dir}: no readable release.json (${err?.code ?? err?.message ?? err})`;
  }
  if (record?.schema !== "lean4-wasm64.release/v1") return `QED64_RELEASE_DIR=${dir}: release.json is not lean4-wasm64.release/v1`;
  if (record.id !== id) return `QED64_RELEASE_DIR=${dir}: release ${JSON.stringify(record.id)}, but toolchain/lean4-wasm64-release.json pins ${JSON.stringify(id)}`;
  if (record.hosting?.layout !== "served") return `QED64_RELEASE_DIR=${dir}: hosting.layout is not "served"`;
  return null;
}

/** The ARTIFACTS binding over `publicDir`: an R2 bucket, structurally (see the header).
 * `releaseDir` (optional) serves the keys of release `releaseId`. */
export function createArtifactsBinding(publicDir, { releaseDir = null, releaseId = RELEASE_ID } = {}) {
  const root = path.resolve(publicDir);
  const releaseRoot = releaseDir === null ? null : path.resolve(releaseDir);
  const releaseHead = RELEASE_R2_ROOT.slice(0, -1);

  async function find(key) {
    if (typeof key !== "string" || /[\\\u0000]/.test(key)) return null;
    let segs = key.split("/");
    if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
    let base = root;
    if (segs[0] === releaseHead) {
      // lean4-wasm64/<id>/<rest>: the release directory, or public/<rest>
      if (segs[1] !== releaseId) return null;
      segs = segs.slice(2);
      if (releaseRoot !== null) base = releaseRoot;
    }
    if (segs.length < 2 || !ARTIFACT_DIRS.includes(segs[0])) return null;
    const file = path.join(base, ...segs);
    const st = await statFile(file);
    return st === null ? null : { key, file, st };
  }

  function meta({ key, file, st }) {
    const etag = etagOf(st);
    const contentType = ARTIFACT_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    return {
      key,
      size: st.size,
      etag: etag.slice(1, -1),
      httpEtag: etag,
      uploaded: st.mtime,
      httpMetadata: { contentType },
      customMetadata: {},
      writeHttpMetadata(headers) {
        headers.set("content-type", contentType);
      },
    };
  }

  // R2Range from get's `range` option: a Headers carrying Range, or {offset, length} / {suffix}.
  function rangeOf(option, size) {
    let spec;
    if (option instanceof Headers) {
      const header = option.get("range");
      if (header === null) return null;
      spec = parseRange(header);
      if (spec === null) throw new Error(`get: invalid range ${JSON.stringify(header)} (R2 10039)`);
    } else if (option.suffix !== undefined) {
      spec = { suffix: option.suffix };
    } else {
      const first = option.offset ?? 0;
      spec = option.length === undefined ? { first } : { first, last: first + option.length - 1 };
    }
    const r = resolveRange(spec, size);
    if (r === null) throw new Error("get: The requested range is not satisfiable (R2 10039)");
    return r;
  }

  return {
    async head(key) {
      const found = await find(key);
      return found === null ? null : meta(found);
    },
    async get(key, options) {
      const found = await find(key);
      if (found === null) return null;
      const size = found.st.size;
      const range = options?.range !== undefined && options.range !== null ? rangeOf(options.range, size) : null;
      const offset = range?.offset ?? 0;
      const length = range?.length ?? size;
      return { ...meta(found), range: { offset, length }, body: await fileStream(found.file, offset, length) };
    },
  };
}

/** The Fetch Request for a Node IncomingMessage, or null when its target is unusable. */
function toRequest(req) {
  const host = req.headers.host ?? "localhost";
  let url;
  try {
    url = new URL(req.url.startsWith("/") ? `http://${host}${req.url}` : req.url);
  } catch {
    return null;
  }
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    try {
      headers.append(name, req.rawHeaders[i + 1]);
    } catch {
      // a header value Headers refuses: dropped
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  try {
    return new Request(url, { method: req.method, headers, ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}) });
  } catch {
    return null; // a method Fetch forbids (CONNECT, TRACE, TRACK)
  }
}

// A body the worker made itself ("not found", "method not allowed") has no
// known length here; the Workers runtime sends its Content-Length (the live
// site does, Content-Length: 9 on an artifact 404), so up to this many bytes
// are read first and sent with their length. A longer one streams chunked.
const SMALL_BODY = 64 * 1024;

async function readSmall(body) {
  const reader = body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { whole: Buffer.concat(chunks, n) };
    chunks.push(value);
    n += value.byteLength;
    if (n > SMALL_BODY) return { chunks, reader };
  }
}

async function* rest(chunks, reader) {
  try {
    yield* chunks;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeResponse(req, res, response) {
  const headers = {};
  for (const [name, value] of response.headers) {
    headers[name] = name in headers ? [].concat(headers[name], value) : value;
  }
  const status = response.status;
  // HEAD: the headers the worker set, nothing added (the live legacy HEAD carries no Content-Length).
  if (req.method === "HEAD" || status === 204 || status === 304) {
    if (response.body !== null) await response.body.cancel().catch(() => {});
    res.writeHead(status, headers).end();
    return;
  }
  const hasLength = "content-length" in headers;
  if (response.body === null) {
    if (!hasLength) headers["content-length"] = "0";
    res.writeHead(status, headers).end();
    return;
  }
  let source;
  if (hasLength) {
    source = Readable.fromWeb(response.body);
  } else if (knownLength.has(response.body)) {
    const length = knownLength.get(response.body);
    if (length !== null) headers["content-length"] = String(length);
    source = Readable.fromWeb(response.body);
  } else {
    const small = await readSmall(response.body);
    if (small.whole !== undefined) {
      headers["content-length"] = String(small.whole.length);
      res.writeHead(status, headers).end(small.whole);
      return;
    }
    source = Readable.from(rest(small.chunks, small.reader));
  }
  res.writeHead(status, headers);
  try {
    await pipeline(source, res);
  } catch (err) {
    // pipeline has destroyed both ends. The client going away is routine;
    // anything else (a read error after the head) is the server's and logged.
    if (!CLIENT_GONE.has(err?.code)) console.error(`serve-dist: ${req.method} ${req.url}: body failed after the head: ${err?.stack ?? err}`);
  }
}

// Error codes of a client that went away mid-body.
const CLIENT_GONE = new Set(["ERR_STREAM_PREMATURE_CLOSE", "EPIPE", "ECONNRESET"]);

function plain(res, status, text, extra = {}) {
  res.writeHead(status, { "content-type": "text/plain", ...ISOLATION, ...extra }).end(text);
}

/** The local-only test embed host (see the header): true when it answered. */
async function serveEmbedHost(req, res, publicDir) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let pathname;
  try {
    pathname = new URL(req.url, "http://x").pathname;
  } catch {
    return false;
  }
  if (pathname !== "/embed-host.html") return false;
  let body;
  try {
    body = await readFile(path.join(publicDir, "embed-host.html"));
  } catch {
    plain(res, 404, "not found: /embed-host.html");
    return true;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...ISOLATION, "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

/** An http.Server (not listening) that answers every request through the
 * worker of `edge` ("legacy" | "hardened") over `dist` and `publicDir`, and
 * `releaseDir` (optional) for the toolchain release's keys. */
export function createDistServer({ dist = DEFAULT_DIST, publicDir = DEFAULT_PUBLIC, edge = "legacy", releaseDir = null } = {}) {
  if (!Object.hasOwn(EDGE_MODES, edge)) throw new TypeError(`serve-dist: unknown edge mode ${JSON.stringify(edge)} (legacy, hardened)`);
  if (releaseDir !== null) {
    const problem = releaseDirProblem(releaseDir);
    if (problem !== null) throw new TypeError(`serve-dist: ${problem}`);
  }
  const worker = EDGE_MODES[edge]();
  const pub = path.resolve(publicDir);
  const env = { ASSETS: createAssetsBinding(dist), ARTIFACTS: createArtifactsBinding(pub, { releaseDir }) };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  return createServer(async (req, res) => {
    try {
      if (await serveEmbedHost(req, res, pub)) return;
      const request = toRequest(req);
      if (request === null) return plain(res, 400, "bad request");
      await writeResponse(req, res, await worker.fetch(request, env, ctx));
    } catch (err) {
      console.error(`serve-dist: ${req.method} ${req.url}: ${err?.stack ?? err}`);
      if (!res.headersSent) plain(res, 500, "internal error");
      else res.destroy();
    }
  });
}

/** The startup line. */
export function startupLine(port, dist, edge, releaseDir = null, releaseId = RELEASE_ID) {
  return `prod preview: http://localhost:${port} (${dist} + public artifacts) edge=${edge} release=${releaseId}${releaseDir === null ? "" : ` releaseDir=${releaseDir}`}`;
}

// Run as a server only when this file is the main module (realpaths: a symlinked path keeps argv[1]'s link path).
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const edge = process.env.QED64_EDGE || "legacy";
  if (!Object.hasOwn(EDGE_MODES, edge)) {
    console.error(`serve-dist: unknown QED64_EDGE=${JSON.stringify(edge)} (legacy, hardened)`);
    console.error(USAGE);
    process.exit(2);
  }
  const releaseDir = process.env.QED64_RELEASE_DIR ? path.resolve(process.env.QED64_RELEASE_DIR) : null;
  const problem = releaseDir === null ? null : releaseDirProblem(releaseDir);
  if (problem !== null) {
    console.error(`serve-dist: ${problem}`);
    console.error(USAGE);
    process.exit(2);
  }
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const dist = process.env.DIST ? path.resolve(process.env.DIST) : DEFAULT_DIST;
  const server = createDistServer({ dist, publicDir: DEFAULT_PUBLIC, edge, releaseDir });
  server.listen(port, () => console.log(startupLine(server.address().port, dist, edge, releaseDir)));
}
