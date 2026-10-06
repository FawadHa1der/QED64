# Deploying QED64 (demo tier, ~$0/month)

QED64 is fully static — no server ever sees a proof — but it needs two
things most free hosts cannot give: **cross-origin isolation headers**
(COOP/COEP, or SharedArrayBuffer/Memory64 refuse to exist) and **files up
to 845 MB with free egress** (a Mathlib user downloads ~2.2 GB once).
GitHub Pages (100 MB/file, no headers), Cloudflare Pages (25 MiB/file) and
Netlify/Vercel free bandwidth caps all fail one of these.

The setup that fits: **Cloudflare Workers static assets (app shell) + R2
(artifacts), one origin, headers set in `infra/worker.js`** (a thin
wrapper over the reusable `infra/edge-worker.js`; see "Reusing the edge
worker" below).

The deployed shell is the lean4monaco editor in `frontend/` (Monaco + the
real vscode-lean4 InfoView on the in-browser wasm64 LSP). `npm run
build:site` builds it into the repo-root `dist/` that `wrangler deploy`
ships; `npm run dev` at the root starts its dev server (the older batch
shell at the repo root was retired with the pump transport in September
2026). All of the editor's runtime paths are root-absolute
(`/infoview/*`, `/workers/*`, `/runtime/*`), so the shell must stay mounted
at the origin root.

| | Free tier | We use |
|---|---|---|
| R2 storage | 10 GB, **zero egress fees** | 2.1 GB |
| R2 reads | 10 M/month | ~100–200/visitor |
| Workers requests | 100 k/day | ~100/install, ~5/revisit |

## One-time setup

1. Cloudflare account → R2 → create bucket `qed64-artifacts`.
2. `npx wrangler login` (or export `CLOUDFLARE_API_TOKEN`).
3. Create an **R2 API token** (R2 → Manage API Tokens → Object Read &
   Write, limited to `qed64-artifacts`) and configure rclone with its S3
   keys (command in `scripts/upload-artifacts.sh`), then run
   `scripts/upload-artifacts.sh` — one ~2.1 GB multipart upload; re-run
   only when artifacts change.
4. `scripts/deploy-app.sh` — builds the shell and `wrangler deploy`s it.
   The app is live at `qed64.<account>.workers.dev` (or attach a domain).

## Continuous integration & deployment

- `.github/workflows/ci.yml` — every push/PR: typecheck, 95 unit tests,
  worker syntax. No artifacts needed; runs in under a minute.
- `.github/workflows/deploy.yml` — pushes to `main` rebuild and redeploy
  the app shell (needs the `CLOUDFLARE_API_TOKEN` repo secret). Artifact
  changes stay a manual `scripts/upload-artifacts.sh` — they change only
  when the toolchain is rebuilt or snapshots re-baked, which requires the
  14-core local pipeline anyway (GitHub's free runners have neither the
  cores nor the ~15 GB wasm heap the umbrella bake needs).

## Consistency rule

Snapshots are binary-paired to the runtime. **Never upload a runtime
without its snapshots** (or vice versa): sync R2 from a `promote:staging`
output so `runtime/`, `snapshots/` and `index.json` move together, exactly
like the local promote. The digest-named chunk files make mixed CDN caches
harmless; the mutable files (`runtime-manifest.json`, `snapshots/index.json`)
are served `must-revalidate`.

## Atomic promotes (shell ↔ runtime pairing)

The shell and the runtime deploy through different channels (git push vs
`upload-artifacts.sh`), so a promote that changes both used to have a
broken window whichever went first. The pinning scheme closes it:

- `upload-artifacts.sh` uploads the manifest twice — at the mutable path
  and at `runtime/runtime-manifest.<buildId>.json` (immutable, cached
  forever, gitignored locally).
- The shell build injects the `buildId` of the manifest committed in
  `public/runtime/runtime-manifest.json` and asks for the PINNED manifest
  first, falling back to the mutable path (dev, pre-scheme shells).
- `rclone copy` (never `sync`) keeps every older runtime's chunks in R2,
  so previously-deployed shells keep working during and after a promote.
  Garbage-collect superseded chunk sets deliberately, much later.

Promote checklist, in order:

1. Commit the new `public/runtime/runtime-manifest.json` (paired with the
   rebaked snapshots) — the shell build reads its `buildId`.
2. `scripts/upload-artifacts.sh` — additive; invisible to deployed shells
   until a shell that pins the new buildId ships.
3. Push `main` — CI deploys the shell, which asks for the runtime it was
   built against and finds it already in R2. No window.

Optional, after step 1: `node pipeline/release/release-manifest.mjs --commit
HEAD --out release.json` writes the `qed64.release/v1` manifest of the
release. The manifest names every served object by sha256 and gives the
release three ids: `releaseId`, `artifactSetId` and `shellId`. The generator
refuses when KERNEL-PIN, the runtime manifest, the snapshot index and the
profiles disagree about the pairing. docs/RELEASE-BUNDLE.md covers the
manifest, how a downstream verifies a bundle with it, and a proposed CI
publishing step that has not been applied.

## Security model: who can write what

R2 buckets are **private by default** and this deployment never changes
that: the Worker's only bucket operation is `get` (read) through a binding,
there is no public-write path, and no code path uploads. "Nobody else can
upload" therefore reduces to credential hygiene:

| Credential | Can do | Where it lives | Scope it to |
|---|---|---|---|
| Your Cloudflare login (+ 2FA) | everything | your head / password manager | enable 2FA |
| R2 API token (S3 keys for rclone) | read/write **one bucket** | your local rclone config only | Object Read & Write, bucket `qed64-artifacts`, add an expiry |
| API token in GitHub secret `CLOUDFLARE_API_TOKEN` | deploy the Worker | GitHub Actions secrets | **Workers Scripts: Edit only — no R2 permission**, so a leaked CI secret cannot touch artifacts |

Rules that keep it that way: never enable the bucket's r2.dev public URL
(reads go through the Worker binding; public-bucket mode is unnecessary),
use two separate tokens as above rather than one broad one, never put
tokens in the repo or wrangler.toml, and remember that anyone who can push
to `main` can trigger the deploy workflow — protect the branch if the repo
gains collaborators.

## Reusing the edge worker

`infra/worker.js` is three lines over **`infra/edge-worker.js`**, a
self-contained ES module (no imports, no Node built-ins, only the Fetch
API globals) that any project serving the wasm64 runtime vendors as **one
file**. lean4game and the widgets showcase each began as a fork of this
worker; the forks' improvements (ranges, metadata HEAD, an R2 key prefix,
a root redirect) are switches here.

```js
// your infra/worker.js — vendor infra/edge-worker.js (and edge-worker.d.ts for TS) beside it
import { createWorker } from "./edge-worker.js";
export default createWorker({
  r2Prefix: (env) => env.R2_PREFIX,              // shared bucket, e.g. "lean4game/"; unset → ""
  rootRedirect: (env) => env.ROOT_REDIRECT ?? null,
});
```

Required wrangler settings (same as QED64's `wrangler.toml`):

```toml
main = "infra/worker.js"
[assets]
directory = "dist"          # the shell, MINUS runtime/ profiles/ snapshots/ (25 MiB/file cap; they come from R2)
binding = "ASSETS"
run_worker_first = true     # REQUIRED: without it assets bypass the worker and ship without COOP/COEP
[[r2_buckets]]
binding = "ARTIFACTS"
bucket_name = "your-artifacts"
```

Request order: `rootRedirect` (a bare `/` without a query) → `extraRoutes`
in order → `artifactPrefixes` (R2) → static assets. Every response gets
COOP/COEP/CORP and the cache rule (`isImmutable` → `public,
max-age=31536000, immutable`, else `public, max-age=0, must-revalidate`).

| Option | Default | Meaning |
|---|---|---|
| `assetsBinding` / `artifactsBinding` | `"ASSETS"` / `"ARTIFACTS"` | env binding name, or `(env) => binding` |
| `artifactPrefixes` | `["/runtime/", "/profiles/", "/snapshots/"]` | paths served from R2 (`DEFAULT_ARTIFACT_PREFIXES`) |
| `r2Prefix` | `""` | prepended to every R2 key; string or `(env) => string` (null/undefined → `""`). Must match `^([A-Za-z0-9._-]+/)+$` with no `.`/`..` segment, else artifact requests answer **500 no-store** |
| `rootRedirect` | `null` | 302 target for a bare `/`; string or `(env) => string \| null` |
| `extraRoutes` | `[]` | `{prefix?, match?(url, request, env), handle(request, env, ctx, kit), rawHeaders?}`; `handle` returning null/undefined falls through |
| `isImmutable` | QED64's rule | the cache rule (lean4game adds vite-hashed `/assets/`) |
| `isolation` | `{coop: "same-origin", coep: "require-corp", corp: "same-origin"}` | per header; `null` = the worker does not set it (an upstream value passes through) |
| `decorate` | `null` | `(headers, {pathname, route, status})`, the last word on every non-raw response; route is `asset`, `artifact`, `redirect` or `extra` |

`kit` gives an extra route the worker's own pieces, each returning a
response that already carries the headers (returned unchanged, it is not
re-wrapped): `serveArtifact(request?, pathname?)` (e.g. map
`/game/<id>/snapshots/…` onto `/snapshots/…`), `serveAsset(request?)`,
`withHeaders(response, pathname?)`, `notFound(pathname?)`, `isImmutable`.
A route's own responses get the headers too unless it sets
`rawHeaders: true`. The library also exports `isImmutable`,
`artifactKey`, `parseRange`, `resolveRange` and `withIsolationHeaders`.

### Legacy vs hardened

The behaviour switches default to the hardened forks' behaviour;
**`QED64_LEGACY`** (frozen) sets each one back, and QED64 deploys
`createWorker(QED64_LEGACY)` — byte-identical to the pre-library worker
(status, headers, body and every binding call, pinned by
`tests/unit/edge-worker.test.ts` against the original source in
`tests/fixtures/edge-worker/worker-47f50e8.js`).

| Switch | Hardened (default) | `QED64_LEGACY` |
|---|---|---|
| `artifactHead` | `"metadata"`: HEAD answered from `head()` with `Content-Length` = size, no body opened | `"get"`: HEAD reads the object like a GET |
| `ranges` | `true`: one `bytes=` range on GET → `head()` first, `If-Range` must strongly match the etag (else full 200), unsatisfiable → **416** `Content-Range: bytes */size` no-store, else ranged `get()` → **206** + `Content-Range`; multi-range/malformed → full 200; `Accept-Ranges: bytes` on artifact responses | `false`: Range ignored |
| `artifactMethods` | `["GET", "HEAD"]`: others → **405** + `Allow`, R2 untouched | `null`: any method reads |
| `rejectUnsafeKeys` | `true`: empty/`.`/`..` segments, `\`, control chars → 404 without R2 | `false` |
| `fullGetLength` | `true`: explicit `Content-Length` on a full GET | `false` |
| `assetHeadLength` | `true`: a 200 HEAD on a static asset that the assets binding answers without `Content-Length` (it never sends one for HEAD) gets the length of the same asset fetched with GET (Range/If-Range dropped; the body is discarded); a GET that is not a 200 leaves the HEAD as it was | `false`: the binding's HEAD passes through |
| `errorCacheControl` | `"no-store"` for every status ≥ 400 | `null`: the path rule (a 404 on a digest-named path is cached for a year) |

New consumers take the defaults. Adopt switches one at a time with
`createWorker({ ...QED64_LEGACY, errorCacheControl: "no-store" })`. Under
the hardened switches the worker's bucket operations are still reads only
(`get` and `head`). Neither mode sets a `Content-Encoding` (the runtime
worker refuses transformed chunks) or carries an upstream `statusText`.

## Using qed64/edge in your own Worker

The package exports the library as `qed64/edge` (`infra/edge-worker.js` plus
`infra/edge-worker.d.ts`; it imports nothing, so wrangler bundles it as is).
With `"qed64": "github:FawadHa1der/QED64#<sha>"` in your `package.json`:

```js
// infra/worker.js: the widgets showcase's worker, as options
import { createWorker } from "qed64/edge";

export default createWorker({
  r2Prefix: (env) => env.R2_PREFIX,               // "qed64-showcase/" in a shared bucket; unset → "" (a bucket of your own)
  rootRedirect: (env) => env.ROOT_REDIRECT ?? null, // "/showcase/": a bare "/" goes to the gallery; "/?snapshots=…" is never redirected
});
```

```toml
name = "your-worker"
main = "infra/worker.js"
compatibility_date = "2026-08-01"   # the showcase's; wrangler requires a name and a date
[assets]
directory = "out/deploy/assets"     # the pinned QED64 dist at / and the gallery under showcase/
binding = "ASSETS"
run_worker_first = true             # REQUIRED (COOP/COEP on the shell)
not_found_handling = "none"
html_handling = "auto-trailing-slash"
[[r2_buckets]]
binding = "ARTIFACTS"
bucket_name = "qed64-artifacts"
[vars]
R2_PREFIX = "qed64-showcase/"
ROOT_REDIRECT = "/showcase/"
```

What each need of that worker maps to:

- **A second static root (`/showcase/`).** Nothing to configure. Both roots
  are directories of the one `[assets]` tree, and every path outside
  `artifactPrefixes` is a static asset. A root served by something else
  (another binding, a rewrite) is an `extraRoutes` entry that calls
  `kit.serveAsset(request)` or returns its own response.
- **A root redirect.** `rootRedirect`. It applies to a bare `/` without a
  query only, and a function returning null or `""` turns it off.
- **An R2 key prefix.** `r2Prefix`. A value that is not `name/`
  segments answers artifact requests 500 no-store and never reaches R2.
- **HEAD with Content-Length.** On artifacts this is `artifactHead:
  "metadata"`, from `head()`, so no body is opened; on static assets it is
  `assetHeadLength`. Both are on by default.
- **A single Range on `.snapz`.** `ranges` (on by default) covers every
  artifact path. See the table above for 206, If-Range and 416.

Every hardened switch is on by default, so the example needs no others. The
showcase's own worker also keeps an upstream `statusText`; this library drops
it, as QED64's worker always has. `isImmutable`, `artifactKey`, `parseRange`,
`resolveRange` and `withIsolationHeaders` are exported for tests and extra
routes. `tests/unit/edge-worker.test.ts` ("the showcase's worker as
createWorker options") runs this exact configuration against fake bindings.

QED64's own `infra/worker.js` stays `createWorker(QED64_LEGACY)`. Moving the
live site to the hardened defaults is a separate decision (plan step A4).

## Alternative: one small VPS (~€4/month)

If you prefer boring: any VPS + Caddy. The entire config is:

    qed64.example.com {
        root * /srv/qed64
        file_server
        header {
            Cross-Origin-Opener-Policy same-origin
            Cross-Origin-Embedder-Policy require-corp
        }
    }

Deploy = `rsync -a dist/ server:/srv/qed64/`. Costs money, no request
caps, and you own the logs.
