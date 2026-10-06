// Structural types for infra/edge-worker.js. Deliberately no dependency on
// @cloudflare/workers-types: the real ASSETS Fetcher and R2Bucket bindings
// satisfy these shapes, and so do the fakes in tests/unit/edge-worker.test.ts.
// Only the Fetch API globals (Request, Response, Headers, ReadableStream) are
// assumed, which both the DOM and the Workers type libraries declare.

/** The static-assets binding (`[assets] binding = "ASSETS"`): a Fetcher. */
export interface AssetsFetcher {
  fetch(request: Request): Promise<Response>;
}

/** What `head()` returns: R2Object, structurally. */
export interface ArtifactObjectMeta {
  readonly size: number;
  readonly httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

/** The range R2 reports having returned (R2Range). */
export type ArtifactReturnedRange = { offset: number; length?: number } | { offset?: number; length: number } | { suffix: number };

/** What `get()` returns: R2ObjectBody, structurally. */
export interface ArtifactObjectBody extends ArtifactObjectMeta {
  readonly body: ReadableStream | null;
  readonly range?: ArtifactReturnedRange | null;
}

/** The artifacts binding (`[[r2_buckets]] binding = "ARTIFACTS"`): an R2Bucket, structurally.
 * `get` is called with one argument for a full read and with `{range: request.headers}` for a
 * single-range read; `head` only when `ranges` or `artifactHead: "metadata"` is on. */
export interface ArtifactBucket {
  get(key: string, options?: { range?: Headers }): Promise<ArtifactObjectBody | null>;
  head(key: string): Promise<ArtifactObjectMeta | null>;
}

/** ExecutionContext, structurally (only handed through to extra routes). */
export interface ExecutionContextLike {
  waitUntil?(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/** A binding: the env key it is bound under, or a function that picks it out of env. */
export type BindingSpec<Env, B> = string | ((env: Env) => B);

export type Route = "asset" | "artifact" | "redirect" | "extra";

export interface DecorateInfo {
  pathname: string;
  route: Route | null;
  status: number;
}

export interface IsolationHeaders {
  /** Cross-Origin-Opener-Policy; null = the worker does not set it. Default "same-origin". */
  coop?: string | null;
  /** Cross-Origin-Embedder-Policy; null = the worker does not set it. Default "require-corp". */
  coep?: string | null;
  /** Cross-Origin-Resource-Policy; null = the worker does not set it. Default "same-origin". */
  corp?: string | null;
}

/** Handed to an extra route's handler; every Response it returns already carries the
 * worker's headers and is returned as-is if the handler passes it on unchanged. */
export interface RouteKit {
  /** Serve `pathname` (default: the request's) from the artifacts bucket with every artifact switch applied. */
  serveArtifact(request?: Request, pathname?: string): Promise<Response>;
  /** Serve the request from the assets binding. */
  serveAsset(request?: Request): Promise<Response>;
  /** Apply isolation + cache headers (+ decorate, route "extra") for `pathname` (default: the request's). */
  withHeaders(response: Response, pathname?: string): Response;
  /** The worker's 404 ("not found", headers applied). */
  notFound(pathname?: string): Response;
  /** The worker's effective cache rule. */
  isImmutable(pathname: string): boolean;
}

export interface ExtraRoute<Env = any> {
  /** Path prefix this route claims (e.g. "/api/"). With `match`, both must hold. */
  prefix?: string;
  /** Predicate this route claims. With `prefix`, both must hold. */
  match?(url: URL, request: Request, env: Env): boolean;
  /** Return a Response, or null/undefined to fall through to the next route (then artifacts, then assets). */
  handle(request: Request, env: Env, ctx: ExecutionContextLike | undefined, kit: RouteKit): Response | null | undefined | Promise<Response | null | undefined>;
  /** true: the handler's own Responses are returned untouched (no isolation/cache headers, no decorate). */
  rawHeaders?: boolean;
}

/** The fields of a lean4-wasm64.release/v1 record (the fork's formats/release.md) the worker
 * routes by; pass the whole parsed release.json. Other fields are carried, never read. */
export interface ReleaseRecord {
  readonly schema: "lean4-wasm64.release/v1" | (string & {});
  /** lean-v<version>[-<suffix>]-<kernel 7 hex>[-r<N>], never a run of 16+ hex digits. */
  readonly id: string;
  readonly hosting: {
    /** Must be "served". */
    readonly layout: string;
    /** Site URL prefix → release directory, e.g. {"/runtime/": "runtime/", "/profiles/": "profiles/"}.
     * Every key must be one of `artifactPrefixes`; every value one top-level directory ending in "/". */
    readonly mount: { readonly [urlPrefix: string]: string };
    /** Site paths under the mounts that stay the site's: exact paths, or prefixes ending in "/"
     * (["/profiles/index.json", "/snapshots/"]). Each must lie under an artifact prefix. */
    readonly siteOwned?: readonly string[];
    readonly [k: string]: unknown;
  } | null;
  readonly [k: string]: unknown;
}

/** The routing a release record asks for, as `releaseRoutes` returns it (frozen). */
export interface ReleaseRoutes {
  readonly id: string;
  /** `lean4-wasm64/<id>/`. */
  readonly prefix: string;
  /** [urlPrefix, releaseDir], longest prefix first. */
  readonly mount: readonly (readonly [string, string])[];
  readonly siteOwned: readonly string[];
}

export interface EdgeWorkerOptions<Env = any> {
  /** Static assets binding. Default "ASSETS". */
  assetsBinding?: BindingSpec<Env, AssetsFetcher>;
  /** R2 artifacts binding. Default "ARTIFACTS". */
  artifactsBinding?: BindingSpec<Env, ArtifactBucket>;
  /** Path prefixes served from R2. Default DEFAULT_ARTIFACT_PREFIXES. */
  artifactPrefixes?: readonly string[];
  /** The site prefix, prepended to every R2 key the release does not own ("" is allowed: the bucket
   * root, a bucket of your own or QED64's). Must be "" or match /^([A-Za-z0-9._-]+\/)+$/ without "."
   * or ".." segments; an invalid value answers artifact requests 500 no-store. A function returning
   * null/undefined means "". Default "". */
  r2Prefix?: string | ((env: Env) => string | null | undefined);
  /** 302 target for a bare "/" without a query (resolved against the request URL); null/"" = none. Default null. */
  rootRedirect?: string | null | ((env: Env) => string | null | undefined);
  /** Tried in order after rootRedirect and before the artifact prefixes. Default []. */
  extraRoutes?: readonly ExtraRoute<Env>[];
  /** The cache rule: true → "public, max-age=31536000, immutable", false → "public, max-age=0, must-revalidate".
   * Default: the exported isImmutable. */
  isImmutable?: (pathname: string) => boolean;
  /** Cross-origin isolation headers on every response. Default COOP same-origin, COEP require-corp, CORP same-origin. */
  isolation?: IsolationHeaders;
  /** Last word on every response's headers (not raw extra routes). Default null. */
  decorate?: ((headers: Headers, info: DecorateInfo) => void) | null;
  /** HEAD on an artifact: "metadata" answers from head() with Content-Length = size (no body opened);
   * "get" reads the object like a GET. Default "metadata"; legacy "get". */
  artifactHead?: "metadata" | "get";
  /** Single-range GETs on artifacts (206 / If-Range / 416) and Accept-Ranges: bytes. Default true; legacy false. */
  ranges?: boolean;
  /** Methods allowed on artifact paths, others get 405 with Allow; null = any method reads.
   * Default ["GET", "HEAD"]; legacy null. */
  artifactMethods?: readonly string[] | null;
  /** 404 without touching R2 for empty, "." or ".." segments, backslashes and control characters.
   * Default true; legacy false. */
  rejectUnsafeKeys?: boolean;
  /** Explicit Content-Length (object size) on a full artifact GET. Default true; legacy false. */
  fullGetLength?: boolean;
  /** HEAD on a static asset: when the assets binding answers 200 without a Content-Length (the
   * Workers assets binding does), fetch the same asset with GET and answer the HEAD with that
   * length, discarding the body. Default true; legacy false. */
  assetHeadLength?: boolean;
  /** Cache-Control for any status >= 400; null = the path's cache rule (a 404 on a digest-named
   * path is then cached for a year). Default "no-store"; legacy null. */
  errorCacheControl?: string | null;
  /** A lean4-wasm64.release/v1 record (the parsed release.json), or null. Checked once, when the worker
   * is created: a record that breaks a routing rule throws a TypeError there (a Worker with a bad record
   * fails at module load, never per request). Then, after the unsafe-path refusal (always applied to
   * release-mapped paths, whatever rejectUnsafeKeys says):
   *   1. a hosting.siteOwned path (exact, or under a "/"-ended entry) → `r2Prefix` + path;
   *   2. a path under a hosting.mount prefix → `lean4-wasm64/<id>/` + the mount's directory + the rest;
   *   3. any other artifact path → `r2Prefix` + path.
   * Every response >= 400 on a rule-2 path is Cache-Control: no-store, whatever errorCacheControl says.
   * Range, If-Range, 206/416 and HEAD Content-Length behave the same whichever prefix a path maps to.
   * Default null (QED64_LEGACY: null). */
  release?: ReleaseRecord | null;
  /** true: a rule-2 lookup that finds nothing (head() for a metadata HEAD or a Range decision, get()
   * otherwise) retries once with the rule-3 key before the 404; the key that answered serves the rest of
   * the request. Never consulted for 405 or 416. Needs `release`. Default false. */
  releaseFallback?: boolean;
}

export interface EdgeWorker<Env = any> {
  /** Never rejects: an exception while answering (a binding that throws or is missing, an extra route,
   * decorate) is logged with console.error and answered 500 "internal error" with the isolation
   * headers and Cache-Control: no-store. */
  fetch(request: Request, env: Env, ctx?: ExecutionContextLike): Promise<Response>;
}

export type RangeSpec = { first: number; last?: number } | { suffix: number };

export const DEFAULT_ARTIFACT_PREFIXES: readonly string[];

/** The pre-library QED64 worker's options, exactly (frozen). */
export const QED64_LEGACY: Readonly<Required<EdgeWorkerOptions<any>>>;

export function createWorker<Env = any>(options?: EdgeWorkerOptions<Env>): EdgeWorker<Env>;

/** "lean4-wasm64/": every release lives at `lean4-wasm64/<id>/` in the bucket. */
export const RELEASE_R2_ROOT: string;

/** Check a release record against the routing rules (see `release`) and return its routes; throws a
 * TypeError ("edge-worker: release: …") naming the first rule it breaks. */
export function releaseRoutes(record: ReleaseRecord, artifactPrefixes?: readonly string[]): ReleaseRoutes;

/** QED64's cache rule: digest/size-named files are immutable; every manifest and index revalidates. */
export function isImmutable(pathname: string): boolean;

/** `prefix` + pathname without its leading slash, or null for an unsafe path. */
export function artifactKey(pathname: string, prefix?: string): string | null;

/** One canonical `bytes=` range, or null (multi-range, other units, malformed, inverted). */
export function parseRange(header: string | null | undefined): RangeSpec | null;

/** `{offset, length}` within `size` bytes, or null when unsatisfiable (→ 416). */
export function resolveRange(spec: RangeSpec, size: number): { offset: number; length: number } | null;

export interface WithIsolationHeadersOptions {
  isolation?: IsolationHeaders;
  isImmutable?: (pathname: string) => boolean;
  errorCacheControl?: string | null;
  /** Forces Cache-Control (decorate may still change it). */
  cacheControl?: string;
  decorate?: ((headers: Headers, info: DecorateInfo) => void) | null;
  route?: Route | null;
}

/** A copy of `response` with isolation + cache headers; with no `opts`, exactly the pre-library withHeaders(). */
export function withIsolationHeaders(response: Response, pathname: string, opts?: WithIsolationHeadersOptions): Response;
