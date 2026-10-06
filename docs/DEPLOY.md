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
   keys (command in `scripts/upload-artifacts.sh`). The toolchain release
   (runtime chunks, library packs) must be in the bucket under
   `lean4-wasm64/<release id>/`, uploaded by its owner (see "The toolchain
   release prefix" below); then run `scripts/upload-artifacts.sh`, which
   uploads QED64's own snapshots (multipart) and `profiles/index.json`;
   re-run only when they change.
4. `scripts/deploy-app.sh` — builds the shell and `wrangler deploy`s it
   (see "The deploy script" below; `--dry-run` first if you want to see the
   build pass without deploying). The app is live at
   `qed64.<account>.workers.dev` (or attach a domain).

## Continuous integration & deployment

- `.github/workflows/ci.yml` — every push/PR: typecheck, 95 unit tests,
  worker syntax. No artifacts needed; runs in under a minute.
- `.github/workflows/deploy.yml` — pushes to `main` install both roots
  (`npm ci`, `npm ci --prefix frontend`), run the root typecheck and the
  unit suite, then run `scripts/deploy-app.sh`, the same script an operator
  runs by hand (needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
  repo secrets). Artifact
  changes stay a manual `scripts/upload-artifacts.sh` — they change only
  when the toolchain is rebuilt or snapshots re-baked, which requires the
  14-core local pipeline anyway (GitHub's free runners have neither the
  cores nor the ~15 GB wasm heap the umbrella bake needs).

### The deploy script

`scripts/deploy-app.sh` is the only place the shell is built for a deploy
and the only place `wrangler deploy` runs; `deploy.yml` adds nothing to it.
From the repository root, whatever the cwd, under `set -euo pipefail`:

1. `npm ci --prefix frontend`, only when `frontend/node_modules` is absent
   (local use; CI has installed both roots already);
2. `npm run typecheck:site`, then `npm run build:site` (into `dist/`);
3. the prune, `rm -rf dist/runtime dist/profiles dist/snapshots`: artifacts
   are served from R2 and never bundled (Vite's `publicDir` is off for
   builds, so this is a defensive invariant);
4. the size check: if `dist/` still holds a `runtime/`, `profiles/` or
   `snapshots/` path, or any file over 25 MiB (the Workers static-assets
   cap per file), the script prints one `deploy-app: REFUSED: …` line on
   stderr and exits 1 before wrangler uploads anything;
5. `npx wrangler deploy` (the wrangler pinned in devDependencies; plain
   wrangler rather than `wrangler-action`, whose wrapper swallowed error
   output). It authenticates with `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` when set, else with `wrangler login`.

`scripts/deploy-app.sh --dry-run` runs steps 1 to 4 and prints
`deploy-app: --dry-run: dist/ is ready; would run: npx wrangler deploy`
instead of deploying. Exit codes: 0 deployed (or ready, with `--dry-run`),
1 the size check refused, 2 an unknown argument, and otherwise the exit code
of the step that failed. 1 also comes from a failing step (vite build exits
1): a size refusal is the run whose stderr ends with a `deploy-app: REFUSED:`
line. `--help` prints the script's header.
`tests/unit/deploy-script.test.ts` pins `deploy.yml`'s step order (every
`run:` line, named or block, must be a one-line `- run:` step, and no line
but the script's step names `build:site` or `typecheck:site`), that no
other tracked file outside docs and tests runs the prune or `wrangler
deploy`, and the script itself, run with stub `npm`/`npx` commands.

### Local preview: the Worker's own code

`npm run build:site && npm run preview:prod` (`node scripts/serve-dist.mjs`,
http://localhost:5185) serves a production build through **the same code
the live site runs**: each request becomes a Fetch `Request` for
`infra/worker.js`'s `fetch(request, env, ctx)`, and its `Response` is written
back (status, every header, the body streamed; HEAD sends none). There are
no local path rules or headers to drift from the Worker's. `env` holds Node
stand-ins for the two `wrangler.toml` bindings:

- `ASSETS`: the Workers static-assets subset QED64 relies on, over `dist/`
  (or `DIST=<dir>`): `/` and `<dir>/` serve their `index.html`,
  `html_handling`'s default `auto-trailing-slash` redirects
  (`/index.html` and `/x.html` answer 307 to `/` and `/x`, `/index` and
  `<dir>/index` 307 to `/` and `<dir>/`; a run of slashes, `//assets/x.html`,
  collapses in one 307 to `/assets/x`, and no `Location` ever starts with
  `//`, as live), the live
  content types (`text/html`, `text/javascript`, ... without a charset),
  an etag and `Content-Length` on GET (HTML has neither, as live), no
  `Content-Length` on HEAD (the real binding sends none), an empty 404.
  Encoded `..` segments and symlinks that leave `dist/` are refused.
- `ARTIFACTS`: an R2 bucket over `public/` (`runtime/`, `profiles/`,
  `snapshots/`; symlinks followed, as in a worktree): `head`/`get` with R2's
  range semantics, streamed file bodies, the content type rclone stores
  (`application/json` for `.json`, else `application/octet-stream`). Its
  etag is a hash of size and mtime, not R2's MD5. The toolchain release's
  keys, `lean4-wasm64/<id>/runtime/…` and `…/profiles/…` (what the Worker
  asks for `/runtime/*` and `/profiles/<not index.json>`), read
  `$QED64_RELEASE_DIR/<rest>` when `QED64_RELEASE_DIR` names a served-layout
  release directory of the pinned id (a fork release dir, read-only), else
  `public/<rest>`, so today's `public/` trees keep working; a file only under
  `public/` is still found through the Worker's fallback to the root key. A
  `QED64_RELEASE_DIR` that is missing or of another release exits 2 with the
  usage line before listening. Nothing is ever written.

Both stand-ins open a file before they return it, so one that stats but
cannot be opened (`EACCES`, a snapshot replaced in the main checkout
mid-request) answers 500 `internal error` with the isolation headers and a
log line, never a 200 head on a reset connection.

Where the Workers runtime adds a `Content-Length` the worker does not set
(an R2 body, the worker's own `not found`), the Node layer adds it too, so
a legacy artifact GET carries its length and a legacy HEAD carries none,
exactly as on the live site (header table checked against
`qed64.fawadworkaddress.workers.dev` on 2026-10-06: the same headers apart
from Cloudflare's own, etag values, and lengths of files the two builds
differ in).

`QED64_EDGE` picks the worker: `legacy` (the default) is `infra/worker.js`,
`createWorker({...QED64_LEGACY, release, releaseFallback: true})`, what is deployed; `hardened` is
`createWorker({ release, releaseFallback: true })`, the defaults of "Legacy vs hardened" below, which the live
site has **not** adopted. Use it to preview and test that switch locally
(Range 206/416, metadata HEAD with `Content-Length`, 405, no-store errors)
before deciding on it (both modes route the same pinned release, so the
only difference is the hardened switches). Any other value exits 2 with the usage line before
listening. The startup line names the mode and the release: `prod preview:
http://localhost:5185 (<dist> + public artifacts) edge=legacy
release=lean-v4.34.0-a8817d0`, plus ` releaseDir=<dir>` when set.

One route is local only and never in the Worker: `/embed-host.html` (the
test embed host, `public/embed-host.html`) is answered by the Node layer
before the worker, with the isolation headers. `PORT` and `DIST` work as
before. `tests/unit/serve-dist.test.ts` pins the headers per mode and runs a
request matrix through serve-dist and through the worker's own `fetch` with
in-memory bindings, which must agree.

## Consistency rule

Snapshots are binary-paired to the runtime. **Never upload a runtime
without its snapshots** (or vice versa): sync R2 from a `promote:staging`
output so `runtime/`, `snapshots/` and `index.json` move together, exactly
like the local promote. A toolchain release is adopted with
`pipeline/release/adopt-release.sh` (docs/REBUILD.md §3), which bakes against
the release's runtime, stages the pairing under `work/staging/<buildId>/`
and promotes it into an ISOLATED served tree (`--public`; never this
checkout's or main's `public/`). `scripts/upload-artifacts.sh` reads only
its own checkout's `public/`, so make that tree another worktree's own real
`public/` (`--public <qed64-wt-a3>/public`) and upload from that worktree,
or promote the same staging into the uploading checkout's real `public/`
first (`promote-staging.mjs --staging work/staging/<buildId> --public
<checkout>/public`) and upload there. The digest-named chunk files make mixed CDN caches
harmless; the mutable files (`runtime-manifest.json`, `snapshots/index.json`)
are served `must-revalidate`.

## Atomic promotes (shell ↔ runtime pairing)

The shell and the runtime deploy through different channels (git push vs
`upload-artifacts.sh`), so a promote that changes both used to have a
broken window whichever went first. The pinning scheme closes it:

- The pinned manifest `runtime/runtime-manifest.<buildId>.json` sits beside
  the mutable one. Under decision 3 both are the toolchain release's
  (`lean4-wasm64/<id>/runtime/`, uploaded by its owner); older runtimes'
  pinned manifests stay at the bucket root, where `upload-artifacts.sh`
  put them before (and `--legacy-root` still does), and the Worker's
  fallback finds them.
- The shell build injects the `buildId` of the manifest committed in
  `public/runtime/runtime-manifest.json` and asks for the PINNED manifest
  first, falling back to the mutable path (dev, pre-scheme shells).
- `rclone copy` (never `sync`) keeps every older runtime's chunks in R2,
  so previously-deployed shells keep working during and after a promote.
  Garbage-collect superseded chunk sets deliberately, much later.

Promote checklist, in order:

0. For a new toolchain release: `pipeline/release/adopt-release.sh … --public
   <isolated tree>` (run `--dry-run` first), then its printed landing steps:
   `toolchain/lean4-wasm64-release.json` ← the adopted `release.json`,
   `pipeline/toolchain/KERNEL-PIN` ← the generated `work/adopt/<id>/KERNEL-PIN`
   (release-manifest checks its commit against the runtime's
   `sourceRevision`), the three tracked manifests from the isolated tree,
   and the devDependency re-pinned to the release's tgz once published.
1. Commit the new `public/runtime/runtime-manifest.json` (paired with the
   rebaked snapshots) together with the release record it belongs to
   (`toolchain/lean4-wasm64-release.json`) — the shell build reads its
   `buildId`, the Worker its release id.
2. The release's owner has uploaded `lean4-wasm64/<id>/`; then
   `scripts/upload-artifacts.sh` — additive; invisible to deployed shells
   until a shell that pins the new buildId ships. It uploads its own
   checkout's `public/`: after an adoption, the checkout whose `public/` is
   the isolated tree, or one the staging was promoted into (above).
3. Push `main` — CI deploys the shell and the Worker together; the shell
   asks for the runtime it was built against and finds it already in R2.
   No window. (The full order: "The toolchain release prefix" below.)

Optional, after step 1: `node pipeline/release/release-manifest.mjs --commit
HEAD --out release.json` writes the `qed64.release/v1` manifest of the
release. The manifest names every served object by sha256 and gives the
release three ids: `releaseId`, `artifactSetId` and `shellId`. The generator
refuses when KERNEL-PIN, the runtime manifest, the snapshot index and the
profiles disagree about the pairing. docs/RELEASE-BUNDLE.md covers the
manifest, how a downstream verifies a bundle with it, and a proposed CI
publishing step that has not been applied.

## The toolchain release prefix (decision 3)

The Lean runtime and the library packs are not QED64's to upload: they are
the lean4-wasm64 release's, uploaded once by its owner under
**`lean4-wasm64/<release id>/`** of the shared bucket `qed64-artifacts` and
served by every site that uses that release (QED64, lean4game, the widgets
showcase), each under its own origin; the browser is never pointed at R2 or
at another site (the fork's `formats/HOSTING.md`, rules 3 and 4). QED64's
Worker routes by the release record (`infra/worker.js`:
`createWorker({...QED64_LEGACY, release, releaseFallback: true})`):

| Request | R2 key | Owner |
|---|---|---|
| `/runtime/*` (manifests, per-build manifests, chunks) | `lean4-wasm64/<id>/runtime/*` | the release's owner |
| `/profiles/*` except `/profiles/index.json` (pack manifests, parts) | `lean4-wasm64/<id>/profiles/*` | the release's owner |
| `/profiles/index.json` | `profiles/index.json` (bucket root) | QED64 (`upload-artifacts.sh`) |
| `/snapshots/*` | `snapshots/*` (bucket root) | QED64 (`upload-artifacts.sh`) |

- **The record is the single source of the id.**
  `toolchain/lean4-wasm64-release.json` (a byte copy of the published
  `release.json`) is imported into the Worker (`with { type: "json" }`;
  wrangler bundles it) and checked when the module loads: a record that
  breaks a routing rule fails the deploy, not a request. No wrangler var
  names the id. Adopting a release is one commit of the new record together
  with the tracked manifests it pairs with (`public/runtime/
  runtime-manifest.json`, the profile manifests, the rebaked snapshot
  index); `tests/unit/toolchain-pin.test.ts` refuses a commit where they
  disagree (the record's digest, the runtime `buildId`, every tracked
  release-mapped file byte-identical to `record.files`).
- **The fallback, for one cycle.** A `/runtime/*` or `/profiles/*` lookup
  that finds nothing under the release prefix is retried once at the
  bucket root (`releaseFallback`), where the pre-decision-3 uploads live:
  shells deployed before the switch ask for their own
  `runtime-manifest.<buildId>.json` and chunks, which only the root holds.
  Remove it (`releaseFallback: false`) once no deployed shell predates the
  switch and the root copies are no longer the rollback.
- **Misses are never cached.** Every status ≥ 400 on a release-mapped path
  is `Cache-Control: no-store`, so a 404 during a deploy-before-upload
  window is not cached for a year under a digest-named URL. (QED64_LEGACY
  keeps `errorCacheControl: null` on its own paths, so a missing snapshot
  still gets the path rule; adopting `errorCacheControl: "no-store"` is
  part of the hardened decision, A4, and recommended.)
- **Adoption order.** (1) The release's owner uploads
  `lean4-wasm64/<id>/` (HOSTING.md's three rclone passes) and confirms it
  complete. (2) QED64 runs `scripts/upload-artifacts.sh`: it refuses unless
  `rclone lsf` lists `lean4-wasm64/<id>/release.json` and the shell's
  manifest and every snapshot are that release's runtime (an `lsf` that
  fails for a local reason, such as no `qed64-r2` remote, expired
  credentials or no network, prints `cannot check R2 (rclone lsf exit N)`
  instead of the not-in-R2 refusal; both exit 3), then uploads
  `public/snapshots/` and `public/profiles/index.json`. (3) One deploy of
  the shell and the Worker together: the user pushes `main` (CI runs
  `scripts/deploy-app.sh`). The shell and the Worker always ship in the same
  deploy, so the Worker never routes to a release the shell does not pin.
- **Rollback.** Revert the commit that changed the record and the manifests
  (or the Worker change itself) and push. For one cycle
  `scripts/upload-artifacts.sh --legacy-root` keeps the bucket root
  populated with `runtime/` and `profiles/` as before (plus the per-build
  manifest copy), so a reverted Worker, which reads the root, finds them.
- **Old shells.** A shell deployed before the switch asks for
  `/runtime/runtime-manifest.<its buildId>.json`: absent under the release
  prefix (another runtime), found at the root through the fallback; its
  chunks likewise. A shell of the release's own runtime finds everything
  under the release prefix. Snapshots and `profiles/index.json` never moved.

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
| `r2Prefix` | `""` | the site prefix, prepended to every R2 key the release does not own; string or `(env) => string` (null/undefined → `""`). `""` is allowed and means the bucket root (a bucket of your own, or QED64's). Otherwise it must match `^([A-Za-z0-9._-]+/)+$` with no `.`/`..` segment, else artifact requests answer **500 no-store** |
| `rootRedirect` | `null` | 302 target for a bare `/`; string or `(env) => string \| null` |
| `extraRoutes` | `[]` | `{prefix?, match?(url, request, env), handle(request, env, ctx, kit), rawHeaders?}`; `handle` returning null/undefined falls through |
| `isImmutable` | QED64's rule | the cache rule (lean4game adds vite-hashed `/assets/`) |
| `isolation` | `{coop: "same-origin", coep: "require-corp", corp: "same-origin"}` | per header; `null` = the worker does not set it (an upstream value passes through) |
| `decorate` | `null` | `(headers, {pathname, route, status})`, the last word on every non-raw response; route is `asset`, `artifact`, `redirect` or `extra` (`null` on the 500 below) |
| `release` | `null` | a `lean4-wasm64.release/v1` record (the parsed `release.json`): its `hosting.mount` paths are read from the shared prefix `lean4-wasm64/<id>/`, everything else from `r2Prefix` (below) |
| `releaseFallback` | `false` | `true`: a release-mapped lookup that finds nothing retries once under `r2Prefix` before the 404 (needs `release`) |

**`release`.** The toolchain's runtime and packs are uploaded once, by
their owner, under `lean4-wasm64/<release id>/` of the shared bucket
(the fork's `formats/HOSTING.md`), and every site serves them under its own
origin: the browser is never pointed at another. The record is checked once,
when `createWorker` runs, and a record that breaks a rule throws one
`TypeError` (`edge-worker: release: …`), so a Worker with a bad record fails
at module load, never per request. The rules: `schema` is
`lean4-wasm64.release/v1`; `id` is `lean-v<version>[-<suffix>]-<kernel7>[-r<N>]`
with no run of 16+ hex digits (the cache rule would call every manifest under
such a prefix immutable); `hosting.layout` is `"served"`; every
`hosting.mount` key is one of `artifactPrefixes` and every value one
top-level directory (`"runtime/"`); every `hosting.siteOwned` entry is an
exact path or a `/`-ended prefix under an artifact prefix. Routing of an
artifact path, after the unsafe-path refusal (always applied to
release-mapped paths, whatever `rejectUnsafeKeys` says, since the key lands
in a prefix other sites share):

| Path | R2 key | Example (QED64's record, `r2Prefix: ""`) |
|---|---|---|
| 1. a `hosting.siteOwned` path (exact, or under a `/`-ended entry) | `r2Prefix` + path | `/profiles/index.json` → `profiles/index.json`; `/snapshots/x.snapz` → `snapshots/x.snapz` |
| 2. under a `hosting.mount` prefix | `lean4-wasm64/<id>/` + the mount's directory + the rest | `/runtime/chunks/c.part-000` → `lean4-wasm64/lean-v4.34.0-a8817d0/runtime/chunks/c.part-000` |
| 3. any other artifact path | `r2Prefix` + path | (none for QED64) |

Every response ≥ 400 on a rule-2 path is `Cache-Control: no-store`,
whatever `errorCacheControl` says (a 404 cached as immutable under a
digest-named URL during a deploy-before-upload window would outlive the
upload); `errorCacheControl` keeps governing every other path. Range,
`If-Range`, 206/416 and HEAD `Content-Length` take the same code path
whichever prefix a path maps to (pinned per prefix in
`tests/unit/edge-worker.test.ts`). With `releaseFallback`, the first lookup
of a rule-2 request that finds nothing (`head()` for a metadata HEAD or a
Range decision, `get()` otherwise) is retried once with the rule-3 key, and
the key that answered serves the rest of the request; 405 and 416 never
consult it. The library also exports `releaseRoutes(record,
artifactPrefixes?)` (the check, returning the routes) and `RELEASE_R2_ROOT`
(`"lean4-wasm64/"`).

**Exceptions.** A throw while answering (a binding that throws or is
missing from `env`, an extra route's handler, `decorate`) is logged with
`console.error` and answered `500 internal error` with the isolation
headers and `Cache-Control: no-store`, not left to the Workers runtime's
own error page, which carries no COOP/COEP. `fetch` never rejects.

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
**`QED64_LEGACY`** (frozen) sets each one back: `createWorker(QED64_LEGACY)`
is byte-identical to the pre-library worker (status, headers, body and every
binding call, pinned by `tests/unit/edge-worker.test.ts` against the original
source in `tests/fixtures/edge-worker/worker-47f50e8.js`; the one deliberate
difference is a throw, now a 500 with the isolation headers instead of the
runtime's error page). QED64 deploys `QED64_LEGACY` plus its toolchain
release (`release`, `releaseFallback: true`, "The toolchain release prefix"
above): identical to the pre-library worker on site-owned paths and assets.

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
`createWorker({ ...QED64_LEGACY, errorCacheControl: "no-store" })`.
`QED64_EDGE=hardened npm run preview:prod` serves a local build through the
hardened defaults ("Local preview: the Worker's own code" above). Under
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

Every hardened switch is on by default, so the example needs no others.

**What changes against a hand-rolled worker.** Moving from a worker of your
own, such as the showcase's `infra/worker.js` (2026-10-05), to these options
changes five things. Each is deliberate:

- **`statusText` is dropped**, as QED64's worker always has (HTTP/2 and
  later carry none). The showcase's worker keeps the upstream one.
- **Every status ≥ 400 is `Cache-Control: no-store`** (`errorCacheControl`):
  404, 405, 416 and 500 alike. The hand-rolled worker sends no-store on a 416
  only and gives every other error the path rule, so a 404 for a digest-named
  path (an overlay `.snapz` asked for before its upload landed) is cached for
  a year as `immutable`.
- **A HEAD 404 carries `Content-Type: text/plain;charset=UTF-8`.** The
  library answers every miss with the same `not found` response, GET or HEAD
  (the runtime sends no body for a HEAD). The hand-rolled worker answers an
  artifact HEAD miss with `new Response(null, { status: 404 })`, which has no
  `Content-Type`. Only a check that compares headers sees it; the status is
  404 in both.
- **The asset-HEAD length GET drops `Range` and `If-Range`** (HEAD ignores
  them), so a HEAD that carries a `Range` still gets the asset's full
  `Content-Length`. The hand-rolled worker forwards every header to that GET:
  when the binding answers it 206, the HEAD goes out without a length.
- **An invalid `R2_PREFIX` answers 500 no-store** and never reaches R2
  (`r2Prefix` must be `name/` segments, see the options table). The
  hand-rolled worker prepends whatever the variable holds: `qed64-showcase`
  without its slash reads keys like `qed64-showcasesnapshots/index.json`, and
  every artifact is a 404.

The library's `artifactKey` also refuses a backslash, a control character and
a `%2e` segment. A real request never carries one, because URL parsing folds
them away first, so only an extra route that passes raw strings can tell the
two workers apart there.

`isImmutable`, `artifactKey`, `parseRange`, `resolveRange` and
`withIsolationHeaders` are exported for tests and extra routes.
`tests/unit/edge-worker.test.ts` ("the showcase's worker as createWorker
options") runs this exact configuration against fake bindings, and pins each
of the five differences.

QED64's own `infra/worker.js` is `createWorker({...QED64_LEGACY, release,
releaseFallback: true})`. Moving the live site to the hardened defaults is a
separate decision (plan step A4). A site that shares the bucket passes its
own prefix and the same record shape: the showcase's
`createWorker({ r2Prefix: "qed64-showcase/", release })` reads `/runtime/*`
and `/profiles/*` from `lean4-wasm64/<id>/` and its `profiles/index.json` and
`snapshots/*` from `qed64-showcase/`.

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
