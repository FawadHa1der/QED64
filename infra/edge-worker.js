/* QED64 edge worker library: static app assets + R2-backed artifacts on one
 * origin, with the cross-origin isolation headers a Memory64 Lean runtime
 * cannot start without.
 *
 * One self-contained ES module: no imports, no Node built-ins, only the
 * Fetch API globals every Workers runtime (and Node >= 18) provides. A
 * downstream project vendors THIS ONE FILE and writes a three-line worker:
 *
 *   import { createWorker } from "./edge-worker.js";
 *   export default createWorker({ r2Prefix: "my-game/" });
 *
 * or imports it from the package as `qed64/edge` (docs/DEPLOY.md, "Using
 * qed64/edge in your own Worker"; package.json exports, closure.json infra).
 *
 * `createWorker(QED64_LEGACY)` reproduces the pre-library QED64 worker byte
 * for byte (status, headers, body, and every binding call);
 * tests/unit/edge-worker.test.ts runs a request matrix through both. QED64's
 * own infra/worker.js is QED64_LEGACY plus its toolchain release
 * (`release`, `releaseFallback`), identical to it on site-owned paths and
 * assets. The hardened defaults (ranges, metadata HEAD, 405,
 * traversal refusal, explicit Content-Length, asset HEAD Content-Length,
 * no-store errors) come from the lean4game and widgets-showcase forks of that
 * worker; each one is a switch, and QED64_LEGACY sets every switch to the old
 * behaviour.
 *
 * Request order: rootRedirect (bare "/" without a query) → extraRoutes, in
 * order → artifact prefixes (R2) → static assets. See docs/DEPLOY.md,
 * "Reusing the edge worker".
 *
 * `release` (a lean4-wasm64.release/v1 record, checked once when the worker
 * is created) routes the toolchain's own files to the shared R2 prefix
 * `lean4-wasm64/<release id>/` (hosting.mount: `/runtime/*` onto the
 * release's `runtime/`, `/profiles/*` onto its `profiles/`) while the site's
 * own pointers (hosting.siteOwned: `/profiles/index.json`, `/snapshots/*`)
 * and every other artifact path stay under `r2Prefix`. Always on this one
 * origin: the browser is never pointed at another (the fork's
 * formats/HOSTING.md, rule 3). Errors on release-mapped paths are never
 * cached; `releaseFallback` retries a release-mapped miss once under the
 * site prefix (one deprecation cycle while the bucket root still holds the
 * older runtimes).
 *
 * An exception thrown while answering (a binding that throws or is missing)
 * becomes a 500 "internal error" with the isolation headers and
 * Cache-Control: no-store, logged with console.error, instead of the
 * runtime's own error page (which carries no COOP/COEP).
 */

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";

/** Path prefixes served from the artifacts bucket instead of static assets. */
export const DEFAULT_ARTIFACT_PREFIXES = Object.freeze(["/runtime/", "/profiles/", "/snapshots/"]);

const DEFAULT_ISOLATION = Object.freeze({ coop: "same-origin", coep: "require-corp", corp: "same-origin" });

export function isImmutable(pathname) {
  // Every manifest and index revalidates, INCLUDING the per-build
  // runtime-manifest.wasm64-<16hex>.json: the buildId is sha256(lean.wasm)
  // alone (artifact-paths.mjs), so a relink that changes only lean.js keeps
  // the name and rewrites the chunk digests inside — a year-long immutable
  // cache would hand the pinned shell stale digests and fail boot
  // verification (migration phase 1).
  if (/\/runtime-manifest(\.[^/]*)?\.json$/.test(pathname) || /\/index\.json$/.test(pathname)) return false;
  // Digest- or size-named files never change under the same name.
  return /(\.part-\d+|\.snapz|\.chunk\.|[0-9a-f]{16,})/.test(pathname);
}

// A "." or ".." segment, also percent-encoded (URL parsing folds these for
// real requests; artifactKey may be handed raw strings by an extra route).
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;
// Backslashes and control characters never name a published artifact.
const UNSAFE_CHAR = /[\\\u0000-\u001f\u007f]/;

/** The R2 key for an artifact path: `prefix` + the path without its leading
 * slash, or null when the path is unsafe — an empty segment ("//", trailing
 * "/"), a "." or ".." segment (also as %2e), a backslash or a control
 * character. The worker answers null with a 404 and never asks R2. */
export function artifactKey(pathname, prefix = "") {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  const rel = pathname.slice(1);
  if (UNSAFE_CHAR.test(rel)) return null;
  if (rel.split("/").some((s) => s === "" || DOT_SEGMENT.test(s))) return null;
  return prefix + rel;
}

/** A `Range` header this worker serves: exactly one `bytes` range (RFC 9110
 * §14.1.2), as `{first, last?}` or `{suffix}`. Anything else — another
 * unit, several ranges, a malformed or inverted spec — returns null and the
 * request is answered as if it carried no Range (a full 200, which the RFC
 * allows), so R2 only ever sees a header this worker has understood.
 * Verbatim from wasm64-lean4game/infra/worker.js. */
export function parseRange(header) {
  if (header === null || header === undefined) return null;
  // Canonical spelling only (what browsers send), positions within the safe
  // integers: the raw header goes to R2, whose parser is not ours to guess.
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (match === null) return null;
  const [, first, last] = match;
  if (first === "") return last === "" ? null : { suffix: Number(last) };
  if (last === "") return { first: Number(first) };
  return Number(last) < Number(first) ? null : { first: Number(first), last: Number(last) };
}

/** `{offset, length}` of a parsed range within an object of `size` bytes,
 * or null when no byte of the object is selected (→ 416). */
export function resolveRange(spec, size) {
  if (spec.suffix !== undefined) {
    const length = Math.min(spec.suffix, size);
    return length > 0 ? { offset: size - length, length } : null;
  }
  if (spec.first >= size) return null;
  const end = spec.last === undefined ? size - 1 : Math.min(spec.last, size - 1);
  return { offset: spec.first, length: end - spec.first + 1 };
}

/** The range R2 reports having returned. The binding types it as any of
 * `{offset, length?}`, `{offset?, length}` or `{suffix}`; normalise all
 * three to `{offset, length}`. */
function returnedRange(range, size) {
  if (range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  return { offset, length: range.length ?? size - offset };
}

function resolveIsolation(isolation) {
  const out = { ...DEFAULT_ISOLATION };
  if (isolation === undefined || isolation === null) return out;
  if (typeof isolation !== "object") throw new TypeError("edge-worker: isolation must be an object {coop, coep, corp}");
  for (const [k, v] of Object.entries(isolation)) {
    if (!Object.hasOwn(DEFAULT_ISOLATION, k)) throw new TypeError(`edge-worker: unknown isolation key "${k}" (coop, coep, corp)`);
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") throw new TypeError(`edge-worker: isolation.${k} must be a string or null`);
    out[k] = v;
  }
  return out;
}

// The one place response headers are written. `opts` is already resolved.
function finish(response, pathname, opts, route, cacheControl) {
  const headers = new Headers(response.headers);
  const { coop, coep, corp } = opts.isolation;
  if (coop !== null) headers.set("Cross-Origin-Opener-Policy", coop);
  if (coep !== null) headers.set("Cross-Origin-Embedder-Policy", coep);
  if (corp !== null) headers.set("Cross-Origin-Resource-Policy", corp);
  const status = response.status;
  headers.set(
    "Cache-Control",
    cacheControl ??
      (status >= 400 && opts.errorCacheControl !== null
        ? opts.errorCacheControl
        : opts.isImmutable(pathname) ? IMMUTABLE : REVALIDATE),
  );
  if (opts.decorate !== null) opts.decorate(headers, { pathname, route, status });
  // statusText is not carried over (the pre-library worker never did; HTTP/2+ has none).
  return new Response(response.body, { status, headers });
}

/** Copy `response` with the cross-origin isolation headers and the cache
 * rule for `pathname` applied. With no `opts` it is exactly the pre-library
 * worker's withHeaders(): COOP same-origin, COEP require-corp, CORP
 * same-origin, Cache-Control immutable for digest-named paths and
 * must-revalidate otherwise, status kept, statusText dropped.
 *
 * opts: `isolation` {coop, coep, corp} (null leaves that header unset),
 * `isImmutable` (the cache rule), `errorCacheControl` (Cache-Control for
 * status >= 400; null = the path rule), `cacheControl` (forces the value),
 * `decorate(headers, {pathname, route, status})` (last word on the
 * headers) and `route` (passed to decorate). */
export function withIsolationHeaders(response, pathname, opts = {}) {
  const resolved = {
    isolation: resolveIsolation(opts.isolation),
    isImmutable: opts.isImmutable ?? isImmutable,
    errorCacheControl: opts.errorCacheControl ?? null,
    decorate: opts.decorate ?? null,
  };
  return finish(response, pathname, resolved, opts.route ?? null, opts.cacheControl ?? undefined);
}

const R2_PREFIX_SHAPE = /^([A-Za-z0-9._-]+\/)+$/;

function validR2Prefix(prefix) {
  if (prefix === "") return true;
  return R2_PREFIX_SHAPE.test(prefix) && !prefix.split("/").some((s) => s === "." || s === "..");
}

/** The R2 directory every lean4-wasm64 release lives under: `lean4-wasm64/<id>/`. */
export const RELEASE_R2_ROOT = "lean4-wasm64/";
const RELEASE_SCHEMA = "lean4-wasm64.release/v1";
// lean-v<version>[-<suffix>]-<kernel 7 hex>[-r<N>] (the fork's formats/README.md rule 5).
const RELEASE_ID = /^lean-v\d+\.\d+\.\d+(?:-[0-9a-z.]+)?-[0-9a-f]{7}(?:-r\d+)?$/;
const MOUNT_DIR = /^[A-Za-z0-9._-]+\/$/;

/** The routing a lean4-wasm64.release/v1 record asks for, checked: `{id,
 * prefix, mount: [[urlPrefix, releaseDir]] (longest prefix first),
 * siteOwned: [path]}`, frozen. Throws one TypeError naming the first rule
 * the record breaks: the schema; the id (lean-v<version>-<kernel7>, never a
 * run of 16+ hex digits, which the cache rule would read as a digest and
 * cache a manifest under that prefix for a year: HOSTING.md rule 8);
 * hosting.layout "served"; every hosting.mount key one of
 * `artifactPrefixes` and every value one top-level directory ("runtime/");
 * every hosting.siteOwned entry an exact path or a "/"-ended prefix under
 * an artifact prefix. Only the fields routing needs are read; the record's
 * own digest and files are the fork's to check. */
export function releaseRoutes(record, artifactPrefixes = DEFAULT_ARTIFACT_PREFIXES) {
  const fail = (why) => {
    throw new TypeError(`edge-worker: release: ${why}`);
  };
  if (record === null || typeof record !== "object" || Array.isArray(record)) fail("must be a lean4-wasm64.release/v1 object or null");
  if (record.schema !== RELEASE_SCHEMA) fail(`schema ${JSON.stringify(record.schema)} is not "${RELEASE_SCHEMA}"`);
  const id = record.id;
  if (typeof id !== "string" || !RELEASE_ID.test(id)) fail(`id ${JSON.stringify(id)} is not lean-v<version>[-<suffix>]-<kernel7>[-r<N>]`);
  if (/[0-9a-f]{16,}/.test(id)) fail(`id ${JSON.stringify(id)} holds a run of 16+ hex digits (the cache rule would call every manifest under it immutable)`);
  const h = record.hosting;
  if (h === null || typeof h !== "object" || Array.isArray(h)) fail("hosting must be an object");
  if (h.layout !== "served") fail(`hosting.layout ${JSON.stringify(h.layout)} is not "served"`);
  const m = h.mount;
  if (m === null || typeof m !== "object" || Array.isArray(m) || Object.keys(m).length === 0) fail("hosting.mount must be a non-empty object {urlPrefix: releaseDir}");
  const mount = [];
  for (const [url, dir] of Object.entries(m)) {
    if (!artifactPrefixes.includes(url)) fail(`hosting.mount key ${JSON.stringify(url)} is not one of the artifact prefixes ${artifactPrefixes.join(" ")}`);
    if (typeof dir !== "string" || !MOUNT_DIR.test(dir) || dir === "./" || dir === "../") {
      fail(`hosting.mount ${url} → ${JSON.stringify(dir)} is not one top-level directory ("runtime/")`);
    }
    mount.push(Object.freeze([url, dir]));
  }
  mount.sort((a, b) => b[0].length - a[0].length);
  const so = h.siteOwned ?? [];
  if (!Array.isArray(so)) fail("hosting.siteOwned must be an array of paths");
  for (const p of so) {
    const probe = typeof p === "string" && p.endsWith("/") ? p + "x" : p;
    if (typeof p !== "string" || artifactKey(probe) === null || !artifactPrefixes.some((a) => p.startsWith(a))) {
      fail(`hosting.siteOwned entry ${JSON.stringify(p)} is not a path (or "/"-ended prefix) under an artifact prefix`);
    }
  }
  return Object.freeze({ id, prefix: `${RELEASE_R2_ROOT}${id}/`, mount: Object.freeze(mount), siteOwned: Object.freeze([...so]) });
}

/** Where `pathname` lives under `routes` (from releaseRoutes): the
 * release-relative key ("runtime/x") for a mounted path, or null for a
 * site path (a siteOwned one, or any path no mount claims). */
function releaseRel(routes, pathname) {
  if (routes.siteOwned.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p))) return null;
  for (const [url, dir] of routes.mount) if (pathname.startsWith(url)) return dir + pathname.slice(url.length);
  return null;
}

/** The options of the pre-library QED64 worker, exactly. Spread and override
 * to adopt one hardened switch at a time: `{...QED64_LEGACY, ranges: true}`. */
export const QED64_LEGACY = Object.freeze({
  assetsBinding: "ASSETS",
  artifactsBinding: "ARTIFACTS",
  artifactPrefixes: DEFAULT_ARTIFACT_PREFIXES,
  r2Prefix: "",
  rootRedirect: null,
  extraRoutes: Object.freeze([]),
  isImmutable,
  isolation: DEFAULT_ISOLATION,
  decorate: null,
  artifactHead: "get",
  ranges: false,
  artifactMethods: null,
  rejectUnsafeKeys: false,
  fullGetLength: false,
  assetHeadLength: false,
  errorCacheControl: null,
  release: null,
  releaseFallback: false,
});

const DEFAULTS = Object.freeze({
  ...QED64_LEGACY,
  // hardened
  artifactHead: "metadata",
  ranges: true,
  artifactMethods: Object.freeze(["GET", "HEAD"]),
  rejectUnsafeKeys: true,
  fullGetLength: true,
  assetHeadLength: true,
  errorCacheControl: "no-store",
});

function bindingResolver(spec, what) {
  if (typeof spec === "function") return spec;
  if (typeof spec !== "string" || spec === "") throw new TypeError(`edge-worker: ${what} must be an env binding name or (env) => binding`);
  return (env) => env[spec];
}

function resolveBinding(resolver, env, what) {
  const binding = resolver(env);
  if (binding === undefined || binding === null) throw new Error(`edge-worker: the ${what} binding is missing from env`);
  return binding;
}

function checkOptions(options) {
  if (options === null || typeof options !== "object") throw new TypeError("edge-worker: options must be an object");
  for (const k of Object.keys(options)) {
    if (!Object.hasOwn(DEFAULTS, k)) throw new TypeError(`edge-worker: unknown option "${k}"`);
  }
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options)) if (v !== undefined) o[k] = v;

  if (!Array.isArray(o.artifactPrefixes) || o.artifactPrefixes.some((p) => typeof p !== "string" || !p.startsWith("/"))) {
    throw new TypeError('edge-worker: artifactPrefixes must be an array of paths starting with "/"');
  }
  if (typeof o.r2Prefix !== "string" && typeof o.r2Prefix !== "function") throw new TypeError("edge-worker: r2Prefix must be a string or (env) => string");
  if (o.rootRedirect !== null && typeof o.rootRedirect !== "string" && typeof o.rootRedirect !== "function") {
    throw new TypeError("edge-worker: rootRedirect must be null, a string or (env) => string | null");
  }
  if (!Array.isArray(o.extraRoutes)) throw new TypeError("edge-worker: extraRoutes must be an array");
  o.extraRoutes.forEach((r, i) => {
    if (r === null || typeof r !== "object" || typeof r.handle !== "function") throw new TypeError(`edge-worker: extraRoutes[${i}].handle must be a function`);
    if (r.prefix === undefined && r.match === undefined) throw new TypeError(`edge-worker: extraRoutes[${i}] needs a prefix or a match function`);
    if (r.prefix !== undefined && (typeof r.prefix !== "string" || !r.prefix.startsWith("/"))) throw new TypeError(`edge-worker: extraRoutes[${i}].prefix must start with "/"`);
    if (r.match !== undefined && typeof r.match !== "function") throw new TypeError(`edge-worker: extraRoutes[${i}].match must be a function`);
  });
  if (typeof o.isImmutable !== "function") throw new TypeError("edge-worker: isImmutable must be a function");
  if (o.decorate !== null && typeof o.decorate !== "function") throw new TypeError("edge-worker: decorate must be null or a function");
  if (o.artifactHead !== "metadata" && o.artifactHead !== "get") throw new TypeError('edge-worker: artifactHead must be "metadata" or "get"');
  for (const k of ["ranges", "rejectUnsafeKeys", "fullGetLength", "assetHeadLength"]) {
    if (typeof o[k] !== "boolean") throw new TypeError(`edge-worker: ${k} must be a boolean`);
  }
  if (o.artifactMethods !== null && (!Array.isArray(o.artifactMethods) || o.artifactMethods.length === 0 || o.artifactMethods.some((m) => typeof m !== "string" || m === ""))) {
    throw new TypeError("edge-worker: artifactMethods must be null or a non-empty array of method names");
  }
  if (o.errorCacheControl !== null && typeof o.errorCacheControl !== "string") throw new TypeError("edge-worker: errorCacheControl must be null or a string");
  if (typeof o.releaseFallback !== "boolean") throw new TypeError("edge-worker: releaseFallback must be a boolean");
  if (o.releaseFallback && o.release === null) throw new TypeError("edge-worker: releaseFallback needs a release");
  const release = o.release === null ? null : releaseRoutes(o.release, o.artifactPrefixes);

  return {
    assets: bindingResolver(o.assetsBinding, "assetsBinding"),
    artifacts: bindingResolver(o.artifactsBinding, "artifactsBinding"),
    artifactPrefixes: [...o.artifactPrefixes],
    r2Prefix: o.r2Prefix,
    rootRedirect: o.rootRedirect,
    extraRoutes: o.extraRoutes.map((r) => ({ prefix: r.prefix, match: r.match, handle: r.handle, rawHeaders: r.rawHeaders === true })),
    artifactHead: o.artifactHead,
    ranges: o.ranges,
    artifactMethods: o.artifactMethods === null ? null : o.artifactMethods.map((m) => m.toUpperCase()),
    rejectUnsafeKeys: o.rejectUnsafeKeys,
    fullGetLength: o.fullGetLength,
    assetHeadLength: o.assetHeadLength,
    release,
    releaseFallback: o.releaseFallback,
    headerOpts: {
      isolation: resolveIsolation(o.isolation),
      isImmutable: o.isImmutable,
      errorCacheControl: o.errorCacheControl,
      decorate: o.decorate,
    },
  };
}

/** The Workers assets binding answers HEAD with a null body and NO
 * Content-Length (it takes the length from the GET body stream only; seen
 * under wrangler dev 4.125.0, widgets-showcase rehearsal 2026-10-01). So a
 * 200 HEAD without one fetches the same asset with GET (Range and If-Range
 * dropped: HEAD ignores them), takes that length (counting the body when the
 * GET carries none) and discards the body: HEAD then carries the length GET
 * would (RFC 9110 §9.3.2). A GET that is not a 200 or yields no length
 * leaves the HEAD answer as it was. Only HEADs pay for this; browsers GET
 * assets. From the widgets showcase's infra/worker.js. */
async function assetHeadWithLength(assets, request, head) {
  const headers = new Headers(request.headers);
  headers.delete("range");
  headers.delete("if-range");
  const get = await assets.fetch(new Request(request.url, { method: "GET", headers }));
  let length = get.headers.get("content-length");
  if (get.status !== 200) {
    if (get.body) await get.body.cancel();
    return head;
  }
  if (length === null && get.body) {
    let n = 0;
    const reader = get.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
    }
    length = String(n);
  } else if (get.body) await get.body.cancel();
  if (length === null) return head;
  const out = new Headers(head.headers);
  out.set("content-length", length);
  return new Response(null, { status: head.status, headers: out });
}

/** Build the worker. `options` are documented in infra/edge-worker.d.ts and
 * docs/DEPLOY.md; omitted ones take the hardened defaults, and
 * `createWorker(QED64_LEGACY)` is the pre-library QED64 worker. Returns
 * `{ fetch(request, env, ctx?) }`, the module-worker default export. */
export function createWorker(options = {}) {
  const cfg = checkOptions(options);
  const h = cfg.headerOpts;
  // Responses already carrying our headers (from the kit): an extra route
  // that returns one unchanged is not re-wrapped.
  const finished = new WeakSet();
  const done = (response, pathname, route, cacheControl) => {
    const out = finish(response, pathname, h, route, cacheControl);
    finished.add(out);
    return out;
  };
  const notFound = (pathname, route) => done(new Response("not found", { status: 404 }), pathname, route);

  async function serveArtifact(request, env, pathname) {
    let prefix = typeof cfg.r2Prefix === "function" ? cfg.r2Prefix(env) : cfg.r2Prefix;
    if (prefix === undefined || prefix === null) prefix = "";
    if (typeof prefix !== "string" || !validR2Prefix(prefix)) {
      return done(new Response("artifact prefix misconfigured", { status: 500 }), pathname, "artifact", "no-store");
    }
    // A path the release mounts (hosting.mount, not hosting.siteOwned) is
    // read from lean4-wasm64/<id>/<dir>/<rest>; every other one from the
    // site prefix. Release-mapped paths are always refused when unsafe
    // (whatever rejectUnsafeKeys says: the key lands in a prefix other
    // sites share) and their errors are never cached: a 404 under a
    // digest-named URL cached for a year during a deploy-before-upload
    // window would outlive the upload.
    const rel = cfg.release === null ? null : releaseRel(cfg.release, pathname);
    const mapped = rel !== null;
    const errorCache = mapped ? "no-store" : undefined;
    const miss = () => (mapped ? done(new Response("not found", { status: 404 }), pathname, "artifact", "no-store") : notFound(pathname, "artifact"));
    let key;
    let fallbackKey = null;
    if (mapped) {
      if (artifactKey(pathname) === null) return miss();
      key = cfg.release.prefix + rel;
      if (cfg.releaseFallback) fallbackKey = prefix + pathname.slice(1);
    } else {
      key = cfg.rejectUnsafeKeys ? artifactKey(pathname, prefix) : prefix + pathname.slice(1);
      if (key === null) return notFound(pathname, "artifact");
    }
    if (cfg.artifactMethods !== null && !cfg.artifactMethods.includes(request.method)) {
      const allow = cfg.artifactMethods.join(", ");
      return done(new Response("method not allowed", { status: 405, headers: { allow } }), pathname, "artifact", errorCache);
    }
    const bucket = resolveBinding(cfg.artifacts, env, "artifacts");
    // The first lookup of a request that finds nothing may retry once under
    // the site prefix (releaseFallback); the key that answered is used from
    // then on, so Range, If-Range and HEAD see one object.
    const lookup = async (op) => {
      let found = await op(key);
      if (found === null && fallbackKey !== null) {
        key = fallbackKey;
        found = await op(key);
      }
      fallbackKey = null;
      return found;
    };

    // Range is defined for GET only (HEAD ignores it).
    let spec = cfg.ranges && request.method === "GET" ? parseRange(request.headers.get("range")) : null;
    if (spec !== null) {
      // Validators and size first: whether the range applies (If-Range) and
      // whether it is satisfiable are decided here, not inferred from how R2
      // reacts to a range it cannot serve.
      const meta = await lookup((k) => bucket.head(k));
      if (meta === null) return miss();
      const ifRange = request.headers.get("if-range");
      if (ifRange !== null && ifRange.trim() !== meta.httpEtag) {
        // The client's partial copy is of another version (or the validator
        // is a date or a weak etag, which can never strongly match): full 200.
        spec = null;
      } else if (resolveRange(spec, meta.size) === null) {
        const headers = new Headers();
        headers.set("accept-ranges", "bytes");
        headers.set("content-range", `bytes */${meta.size}`);
        return done(new Response("range not satisfiable", { status: 416, headers }), pathname, "artifact", "no-store");
      }
    }

    if (request.method === "HEAD" && cfg.artifactHead === "metadata") {
      // Metadata only: head() answers in tens of milliseconds, while a get()
      // opens the object's body (hundreds of MB for a snapshot) only for the
      // runtime to discard it (lean4game live campaign 2026-10-01).
      const meta = await lookup((k) => bucket.head(k));
      if (meta === null) return miss();
      const headers = new Headers();
      meta.writeHttpMetadata(headers);
      headers.set("etag", meta.httpEtag);
      if (cfg.ranges) headers.set("accept-ranges", "bytes");
      headers.set("content-length", String(meta.size));
      return done(new Response(null, { headers }), pathname, "artifact");
    }

    const object = await lookup((k) => (spec !== null ? bucket.get(k, { range: request.headers }) : bucket.get(k)));
    if (object === null) return miss();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    if (cfg.ranges) headers.set("accept-ranges", "bytes");
    if (spec !== null && object.range !== undefined && object.range !== null) {
      const { offset, length } = returnedRange(object.range, object.size);
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("content-length", String(length));
      return done(new Response(object.body, { status: 206, headers }), pathname, "artifact");
    }
    if (cfg.fullGetLength && typeof object.size === "number") headers.set("content-length", String(object.size));
    return done(new Response(object.body, { headers }), pathname, "artifact");
  }

  async function serveAsset(request, env) {
    const assets = resolveBinding(cfg.assets, env, "assets");
    let response = await assets.fetch(request);
    if (cfg.assetHeadLength && request.method === "HEAD" && response.status === 200 && !response.headers.has("content-length")) {
      response = await assetHeadWithLength(assets, request, response);
    }
    return done(response, new URL(request.url).pathname, "asset");
  }

  function kitFor(request, env, url) {
    return {
      serveArtifact: (req = request, pathname = new URL(req.url).pathname) => serveArtifact(req, env, pathname),
      serveAsset: (req = request) => serveAsset(req, env),
      withHeaders: (response, pathname = url.pathname) => done(response, pathname, "extra"),
      notFound: (pathname = url.pathname) => notFound(pathname, "extra"),
      isImmutable: h.isImmutable,
    };
  }

  async function handle(request, env, ctx) {
    const url = new URL(request.url);
    if (cfg.rootRedirect !== null && url.pathname === "/" && url.search === "") {
      const target = typeof cfg.rootRedirect === "function" ? cfg.rootRedirect(env) : cfg.rootRedirect;
      if (target) return done(Response.redirect(new URL(target, url).toString(), 302), url.pathname, "redirect");
    }
    if (cfg.extraRoutes.length > 0) {
      let kit = null;
      for (const route of cfg.extraRoutes) {
        if (route.prefix !== undefined && !url.pathname.startsWith(route.prefix)) continue;
        if (route.match !== undefined && !route.match(url, request, env)) continue;
        kit ??= kitFor(request, env, url);
        const response = await route.handle(request, env, ctx, kit);
        // null/undefined: not this route's request after all; try the next.
        if (response === null || response === undefined) continue;
        if (route.rawHeaders || finished.has(response)) return response;
        return done(response, url.pathname, "extra");
      }
    }
    if (cfg.artifactPrefixes.some((p) => url.pathname.startsWith(p))) {
      return serveArtifact(request, env, url.pathname);
    }
    return serveAsset(request, env);
  }

  // A throw anywhere above (a binding that throws or is missing, an extra
  // route's handler, decorate) answers 500 with the isolation headers and
  // no-store instead of the runtime's error page, which has no COOP/COEP and
  // may be cached under the path's rule by nothing but luck. Logged.
  async function guarded(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      let pathname = "/";
      try {
        pathname = new URL(request.url).pathname;
      } catch {
        // keep "/"
      }
      console.error(`edge-worker: ${request.method} ${pathname}: ${err?.stack ?? err}`);
      const failed = () => new Response("internal error", { status: 500 });
      try {
        return done(failed(), pathname, null, "no-store");
      } catch {
        // decorate itself threw: the headers without it
        return finish(failed(), pathname, { ...h, decorate: null }, null, "no-store");
      }
    }
  }

  return { fetch: (request, env, ctx) => guarded(request, env, ctx) };
}
