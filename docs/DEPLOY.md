# Deploying QED64 (demo tier, ~$0/month)

QED64 is fully static — no server ever sees a proof — but it needs two
things most free hosts cannot give: **cross-origin isolation headers**
(COOP/COEP, or SharedArrayBuffer/Memory64 refuse to exist) and **files up
to 845 MB with free egress** (a Mathlib user downloads ~2.2 GB once).
GitHub Pages (100 MB/file, no headers), Cloudflare Pages (25 MiB/file) and
Netlify/Vercel free bandwidth caps all fail one of these.

The setup that fits: **Cloudflare Workers static assets (the app shell and
QED64's two indexes) + R2 (artifacts), one origin, headers set in
`infra/worker.js`** (a thin wrapper over the reusable `infra/edge-worker.js`;
see "Reusing the edge worker" below).

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
   uploads QED64's snapshots (multipart); re-run only when they change.
   The two indexes ship with the deploy ("Atomic deploys" below).
4. `scripts/deploy-app.sh` — builds the shell and `wrangler deploy`s it
   (see "The deploy script" below; `--dry-run` first if you want to see the
   build pass without deploying). A first deploy to a new origin sets
   `QED64_DEPLOY_ORIGIN=none`: its guard has nothing to ask yet. Every later
   deploy from another account sets `QED64_DEPLOY_ORIGIN=<its origin>`: the
   default asks this repository's live site (fetch-artifacts'
   `DEFAULT_ORIGIN`), and the guard runs on `--dry-run` too. The app is live
   at `qed64.<account>.workers.dev` (or attach a domain).

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
  cores nor the ~15 GB wasm heap the umbrella bake needs). So the upload
  comes first and the push second; the script's guard (its step 6, below) makes
  the deploy refuse when a push names snapshots the live origin does not
  serve yet, and nothing deploys. Upload them, then start the workflow again
  ('Run workflow' on `main`).
  The workflow deploys one commit at a time, in push order, and only main's
  head. Its runs share one concurrency group (`qed64-deploy-<ref>`, one per
  branch, `cancel-in-progress: false`): a run waits for the deploy before
  it, a newer push replaces a run still waiting, and a running deploy is
  never cancelled midway. A manual 'Run workflow' deploys only on `main`:
  the job's `if: github.ref == 'refs/heads/main'` skips it on any other
  branch. Just before `scripts/deploy-app.sh`, a one-line `git ls-remote`
  check refuses unless the run's commit is still the head of `main` (exit 1,
  `deploy refused, <sha> is no longer the head of main`). So a 'Re-run jobs'
  of an older run, or a run a newer push overtook while it ran, never
  deploys over a newer commit; such a run fails with the `deploy refused`
  line by design and needs no action: the newer head deploys in its own
  run. Any run that joins main's group (a re-run, a 'Run workflow') replaces
  one still waiting, so to deploy main's head after a cancelled run, or
  after a refused one whose newer head did not deploy (after a guard
  refusal, upload first), use 'Run workflow' on `main`, never 'Re-run
  jobs', which deploys only while its commit is still the head.

### The deploy script

`scripts/deploy-app.sh` is the only place the shell is built for a deploy
and the only place `wrangler deploy` runs; `deploy.yml` adds nothing to it.
From the repository root, whatever the cwd, under `set -euo pipefail`:

1. `npm ci --prefix frontend`, only when `frontend/node_modules` is absent
   (local use; CI has installed both roots already);
2. `npm run typecheck:site`;
3. `npm run build:site` (into `dist/`);
4. the prune: `rm -rf dist/runtime`, and every entry of `dist/profiles/`
   and `dist/snapshots/` but `index.json`. The deploy carries the shell and
   QED64's two indexes, which the build copies from the tracked `public/`
   files ("Atomic deploys" below); every other artifact is served from R2
   and never bundled (Vite's `publicDir` is off for builds and the build
   copies only those two, so this is a defensive invariant);
5. the size and index check: if `dist/` still holds a `runtime/` path,
   holds a symlinked `dist/profiles` or `dist/snapshots`, lacks
   `dist/profiles/index.json` or `dist/snapshots/index.json`, holds
   one that is not byte-identical to the tracked `public/` file, holds any
   other `profiles/` or `snapshots/` path, or holds any file over 25 MiB
   (the Workers static-assets cap per file), the script prints one
   `deploy-app: REFUSED: …` line on stderr and exits 1 before wrangler
   uploads anything;
6. the guard, `node scripts/deploy-guard.mjs` (architecture review R19a,
   below): it exits 1 with a `deploy-guard: REFUSED: …` line unless every
   snapshot the tracked index names already answers on the live origin;
7. `npx wrangler deploy` (the wrangler pinned in devDependencies; plain
   wrangler rather than `wrangler-action`, whose wrapper swallowed error
   output). It authenticates with `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` when set, else with `wrangler login`.

**The guard.** A push that comes before its upload must deploy nothing: a
shell whose index names `.snapz` files R2 does not hold yet fails every new
visit until the upload (lean4game's 90 s window on 2026-10-09; QED64's
2026-10-08 outage, HARDENING #64, was the same deploy-ordering class run the
other way: an upload before its deploy). So before the deploy,
`scripts/deploy-guard.mjs` sends one `HEAD` (redirects not followed, 20 s
each) for every `url` in `public/snapshots/index.json`, on the live origin
(`QED64_DEPLOY_ORIGIN`, else fetch-artifacts' `DEFAULT_ORIGIN`,
`https://qed64.fawadworkaddress.workers.dev/`). Each must answer 200; a
5xx, a network error or a timeout is retried after 2 s and after 4 s (three
tries). When the answer carries a `Content-Length`, it must equal the
entry's `transfer` (else `bytes`). A Worker from before 2026-11
(`QED64_LEGACY`, `artifactHead: "get"`) sends none on `HEAD`, so against it
the check is the status alone (the first deploy of "Atomic deploys" is
checked that way); the hardened Worker deployed since answers `HEAD` from
R2's metadata with the length, so the sizes are checked too. The first refusal stops the check; it
reads no body and writes nothing, so `--dry-run` runs it too. Each line on
stderr starts `deploy-guard: `: one `live <url> (…)` line per snapshot, then
`OK <k> snapshot(s) live on <origin>`, or a last `REFUSED: <url>: …` line
(`HTTP 404 from <href> — upload it first (scripts/upload-artifacts.sh),
then re-run the deploy`, a wrong length, or `could not be reached`). An
index entry whose `url` is not a `.snapz` directly under `/snapshots/`, an
index that is missing, not JSON or of another schema, and an origin that is
not http(s) are refused before any request.

It checks only these site-owned files: every QED64 Worker, old or new,
serves `/snapshots/*.snapz` from the same bucket-root key, so the live
Worker answers for exactly the bytes the new deploy reads. It never checks
release-mapped files (`/runtime/*`, `/profiles/<not index.json>`) through
the origin: the live Worker maps them into *its* release, so the next
release's digest-named chunks would 404 and its fixed-name manifests would
pass falsely. `scripts/upload-artifacts.sh` checks those, by refusing to
upload unless the release's `release.json` is in R2. An adoption always
rebakes the snapshots under new names, so the guard refuses an adoption
pushed before its upload too. `QED64_DEPLOY_ORIGIN=<url>` points it at
another origin, and `QED64_DEPLOY_ORIGIN=none` skips it with a
`deploy-guard: SKIPPED:` line (a first deploy to a new origin, which has
nothing to ask yet). By hand: `node scripts/deploy-guard.mjs [--index
<file>] [--origin <url>]`; exit 0 every snapshot live (or skipped), 1
refused, 2 a bad argument, with the usage line.

`scripts/deploy-app.sh --dry-run` runs steps 1 to 6 and prints
`deploy-app: --dry-run: dist/ is ready; would run: npx wrangler deploy`
instead of deploying. Exit codes: 0 deployed (or ready, with `--dry-run`),
1 the size check or the guard refused, 2 an unknown argument, and otherwise
the exit code of the step that failed. 1 also comes from a failing step
(vite build exits 1): a refusal is the run whose stderr ends with a
`deploy-app: REFUSED:` or `deploy-guard: REFUSED:` line. `--help` prints the
script's header.
`tests/unit/deploy-script.test.ts` pins `deploy.yml`'s step order (every
`run:` line, named or block, must be a one-line `- run:` step, and no line
but the script's step names `build:site` or `typecheck:site`), its
concurrency group, the main-only `if:` and the head check just before the
script's step, that no other tracked file outside docs and tests runs the
prune or `wrangler deploy`, and the script itself, run with stub
`npm`/`npx`/`node` commands (the prune keeping exactly the two indexes, a
build missing one or holding other bytes refused, the guard in its place,
and a guard refusal that stops the deploy).
`tests/unit/deploy-guard.test.ts` runs the guard against a local http
server: live, no length, a 404, a wrong length, a retried 503, a closed
port, refused entry URLs and indexes, the skip, and HEAD only.

### Local preview: the Worker's own code

`npm run build:site && npm run preview:prod` (`node scripts/serve-dist.mjs`,
http://localhost:5185) serves a production build through **the same code
the live site runs**: each request becomes a Fetch `Request` for
`infra/worker.js`'s `fetch(request, env, ctx)`, and its `Response` is written
back (status, every header, the body streamed; HEAD sends none). There are
no local path rules or headers to drift from the Worker's. `env` holds Node
stand-ins for the two `wrangler.toml` bindings:

- `ASSETS`: the Workers static-assets subset QED64 relies on, over `dist/`
  (or `DIST=<dir>`), the shell plus the two indexes the build copies in:
  `/` and `<dir>/` serve their `index.html`,
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
  `public/<rest>`, so today's `public/` trees keep working; with a release
  directory, a file only under `public/` is a 404, as on the live site (no
  fallback to the root key). A
  `QED64_RELEASE_DIR` that is missing or of another release exits 2 with the
  usage line before listening. Nothing is ever written.

Both stand-ins open a file before they return it, so one that stats but
cannot be opened (`EACCES`, a snapshot replaced in the main checkout
mid-request) answers 500 `internal error` with the isolation headers and a
log line, never a 200 head on a reset connection.

Where the Workers runtime adds a `Content-Length` the worker does not set
(an R2 body, the worker's own `not found`), the Node layer adds it too, so
a legacy artifact GET carries its length and a legacy HEAD carries none,
exactly as on the live site while it ran the legacy Worker (header table
checked against `qed64.fawadworkaddress.workers.dev` on 2026-10-06: the
same headers apart from Cloudflare's own, etag values, and lengths of files
the two builds differ in).

`QED64_EDGE` picks the worker: `hardened` (the default) is `infra/worker.js`,
what is deployed: the hardened defaults of "Legacy vs hardened" below
(Range 206/416, metadata HEAD with `Content-Length`, 405, no-store errors),
the pinned record, and the two indexes answered from `dist/`. `legacy` is
`createWorker({...QED64_LEGACY, release})`, the Worker deployed before
2026-11 and a rollback target while it is one ("Atomic deploys"): it reads
`/snapshots/index.json` and `/profiles/index.json` from `public/`, as that
Worker reads them from R2. Use it to preview a rollback to it. Both modes
route the same pinned release. A `dist/` built before the indexes shipped
in it has none: under `hardened` they answer 404 and the page finds no
snapshot index, so rebuild it. Any other value exits 2 with the usage line before
listening. The startup line names the mode and the release: `prod preview:
http://localhost:5185 (<dist> + public artifacts) edge=hardened
release=lean-v4.35.0-b081e7c`, plus ` releaseDir=<dir>` when set.

One route is local only and never in the Worker: `/embed-host.html` (the
test embed host, `public/embed-host.html`) is answered by the Node layer
before the worker, with the isolation headers. `PORT` and `DIST` work as
before. `tests/unit/serve-dist.test.ts` pins the headers per mode and runs a
request matrix through serve-dist and through the worker's own `fetch` with
in-memory bindings, which must agree.

## Consistency rule

Snapshots are binary-paired to the runtime. **Never serve a runtime
without its snapshots** (or vice versa). The runtime and the packs are the
toolchain release's, uploaded by its owner under `lean4-wasm64/<id>/` first;
QED64 uploads only its `.snapz`, from a promote of the same staging, with
`scripts/upload-artifacts.sh` (`rclone copy`/`copyto`, never `sync`), and
the commit of the record and the two indexes, deployed together, pairs
them, exactly like the local promote. A toolchain release is adopted with
`pipeline/release/adopt-release.sh` (docs/REBUILD.md §3), which bakes against
the release's runtime, stages the pairing under `work/staging/<buildId>/`
and promotes it into an ISOLATED served tree (`--public`; never this
checkout's or main's `public/`). `scripts/upload-artifacts.sh` reads only
its own checkout's `public/`, so make that tree another worktree's own real
`public/` (`--public <qed64-wt-a3>/public`) and upload from that worktree,
or promote the same staging into the uploading checkout's real `public/`
first (`promote-staging.mjs --staging work/staging/<buildId> --public
<checkout>/public`) and upload there. The digest-named chunk files make mixed CDN caches
harmless; the mutable files (`runtime-manifest.json`, `snapshots/index.json`,
`profiles/index.json`) are served `must-revalidate`.

## Atomic deploys (shell, Worker and indexes)

One `wrangler deploy` carries everything a boot reads that is not
digest-named: the shell (`dist/`), the Worker with the release record it
bundles (`toolchain/lean4-wasm64-release.json`, "The toolchain release
prefix" below), and QED64's two site indexes, `/snapshots/index.json` and
`/profiles/index.json`. The indexes are static assets of the deploy since
2026-11 (architecture review D2):

- `npm run build:site` copies the tracked `public/snapshots/index.json` and
  `public/profiles/index.json` into `dist/` byte for byte (a build-only
  `viteStaticCopy` target in `frontend/vite.config.ts`; dev keeps reading
  them through `publicDir`). The copy runs before `dist/qed64-build.json` is
  written, so the two count in the shell id, and `release-manifest --dist`
  refuses them when they differ from the tracked files.
- `scripts/deploy-app.sh` refuses a build without them or with other bytes
  ("The deploy script" above).
- `infra/worker.js` answers a GET or HEAD of exactly those two paths from
  `ASSETS` (one `extraRoutes` entry: "Serving a site's own indexes from the
  deploy" below). An overlay's own `index.json` and the frozen per-build
  copies are not those paths and stay in R2.

Workers static assets are versioned with the Worker, so a deploy switches
the shell, the record and the indexes in one step, `npx wrangler rollback`
restores all three of an earlier version together, and a revert-and-push
redeploys an earlier commit's three. The pointer and its reader always
switch together (the rule of HARDENING #64), and an upload changes nothing
a deployed shell reads.

What R2 holds for QED64:

- the toolchain release's prefix `lean4-wasm64/<id>/` (the runtime and the
  packs), uploaded by the release's owner, never by QED64;
- QED64's digest-named `.snapz` at `snapshots/<file>`, and any overlay
  directory at `snapshots/<overlay>/` (opt-in, with its own index),
  uploaded by `scripts/upload-artifacts.sh` before the push;
- frozen since 2026-11: the bucket-root `snapshots/index.json`,
  `profiles/index.json` and the per-build copies
  `snapshots/index.wasm64-*.json` and `snapshots/profiles-index.wasm64-*.json`.
  Only a Worker version from before 2026-11 reads the two bucket-root
  indexes (it served both from R2); the hardened Worker still serves the
  per-build copies, to an old shell that boots after a runtime deploy (a
  page restored from a cache; "Old shells"). Nothing writes them any more,
  and they stay while such a version is a rollback target ("R2 clean-up"
  below).

The pinned runtime manifest is unchanged: the shell build injects the
`buildId` of the committed `public/runtime/runtime-manifest.json` and asks
for `runtime/runtime-manifest.<buildId>.json` first, falling back to the
mutable path (dev, an embedder without the define). Both are the toolchain
release's (`lean4-wasm64/<id>/runtime/`), and the Worker reads `/runtime/*`
only from the release its record pins (no fallback to the bucket root since
2026-10-25), so the runtime pairing was already atomic; D2 makes the
indexes so too. An open tab, or an old shell that boots after a deploy, is
another matter: see "Old shells" under "The toolchain release prefix".

The reader rule of HARDENING #64 stays in the library: when the mutable
snapshot index names another runtime than the one the shell pins, the shell
reads that runtime's per-build copy `snapshots/index.<buildId>.json` and
uses it when it is an index paired with that runtime (`pairedBuildId`,
docs/EMBEDDING.md §4). lean4game's and the showcase's sites still publish
copies. On QED64's own site the index always pairs with the shell deployed
with it, so a shell deployed with the index never asks for one; an older
shell that boots after a deploy does ("Old shells").

A same-runtime rebake is visible at its deploy, no longer at its upload:
the new `.snapz` are inert in R2 until the push deploys the index that
names them.

Promote checklist, in order:

0. Adoption: `pipeline/release/adopt-release.sh … --public <isolated tree>`
   (run `--dry-run` first), then its printed landing steps. Use the release's
   own tools (its tgz installed in a scratch dir,
   `--tools <scratch dir>/node_modules/lean4-wasm64`): an older package
   refuses a v2 record whole (docs/REBUILD.md §3).
1. Make one commit with the record (`toolchain/lean4-wasm64-release.json`;
   release-manifest checks its `kernel.commit` against the runtime's
   `sourceRevision`, and its `runtime.buildId` and files against the served
   manifests), `embedding/base-tree.json` and, when the umbrella was
   rebuilt, `embedding/umbrella/QED64/Essential.olean*`,
   `public/runtime/runtime-manifest.json`, the profile manifests, and both
   indexes (and, once the release is published, the `lean4-wasm64`
   devDependency re-pinned to its tgz in package.json and package-lock.json:
   adopt-release's landing step 4). Do not push yet. Push nothing to `main`
   from this commit until step 3 has finished: a push is the deploy
   (step 5), and it would deploy this commit's shell and indexes before
   their snapshots are in R2. The deploy's guard (the one step 4 runs by hand)
   refuses such a deploy, so nothing deploys, the push's other changes
   included, until the upload and a 'Run workflow' on `main`. When to adopt
   a release at all: the cadence in docs/REBUILD.md §3.
2. For a new release: its owner has uploaded `lean4-wasm64/<id>/`
   (normally before step 1: docs/REBUILD.md §3 orders publish, land, upload,
   push).
3. Run `DRY_RUN=1 scripts/upload-artifacts.sh`, then
   `scripts/upload-artifacts.sh`, from a checkout whose `public/` holds the
   new `.snapz` (after an adoption, the checkout whose `public/` is the
   isolated tree, or one the staging was promoted into: "Consistency rule"
   above). It refuses (exit 3) unless the release's `release.json` is in R2
   and the pairing is that release's runtime. It sends only the `.snapz` the
   index names (each a `rclone copyto`; a failed one stops the upload) and
   each overlay directory whole, and no index. Nothing a visitor sees
   changes.
4. Optional: `node scripts/deploy-guard.mjs`, the deploy's guard by hand.
5. Push `main`. CI runs the tests, the head check, the build and its
   refusals, the guard and `wrangler deploy`: one Worker version with the
   shell, the record and the indexes. If the guard refuses, nothing
   deployed: upload, then 'Run workflow' on `main`. A re-run of an older run
   refuses once `main` has moved.
6. Check: `curl -s https://qed64.fawadworkaddress.workers.dev/qed64-build.json`
   names the pushed commit, and the page boots.

A same-runtime rebake is steps 1, 3 and 5. A change that touches no index
is step 5 alone.

**Rollback.**
- Revert and push. Nothing is uploaded: the old `.snapz` are never deleted
  (`rclone copy`/`copyto`, never `sync`; "R2 clean-up" below), and the
  release's owner keeps its prefix.
- In an emergency, `npx wrangler rollback` restores a version's own
  assets, record and indexes in seconds. Then revert and push, so `main` is
  what is live.
- A version from before 2026-11 serves the frozen R2 indexes, which still
  name its pairing.
- Revert D2's commits together (the deploy change and the two clean-ups of
  the per-build copies after it). Reverting the Worker change alone after
  an upload of a new pairing would put the legacy Worker in front of
  indexes frozen at the old pairing.

**R2 clean-up.**
- Delete by exact keys only: `rclone delete --files-from-raw <list>
  --dry-run` first.
- Delete only keys that no rollback-target version names. A version from
  2026-11 on names its `.snapz` in `git show <commit>:public/snapshots/index.json`;
  a version from before names them through R2's frozen `snapshots/index.json`.
- The Worker version that was live when D2 was first pushed stays a
  rollback target until the next runtime adoption after D2 is live and
  stable (the default chosen 2026-11-01). Then delete, at the bucket root,
  `snapshots/index.json`, `profiles/index.json`, `snapshots/index.wasm64-*.json`
  and `snapshots/profiles-index.wasm64-*.json`, plus the 5650321f grace
  keys (`work/r2-gc-2026-10-23/` in the main checkout, not tracked), and
  remove `serve-dist.mjs`'s `legacy` mode in the same change. Deleting the
  per-build copies also changes what an old shell does: one that boots after
  the next runtime deploy then gets a 404 for its copy and pairs with the
  new snapshots instead of being refused `unpaired` ("Old shells"). QED64's
  root then holds only `.snapz`. Superseded `.snapz` are garbage-collected the
  same way, deliberately, once no rollback needs them (the 2026-10-23 sweep
  kept the live and the previous pairing: `work/r2-gc-2026-10-23/README.md`).

**The first deploy of this scheme** (the live Worker is the pre-change one):
1. Before pushing, both commands must print nothing:
   - `curl -s https://qed64.fawadworkaddress.workers.dev/snapshots/index.json | cmp - public/snapshots/index.json`
   - `curl -s https://qed64.fawadworkaddress.workers.dev/profiles/index.json | cmp - public/profiles/index.json`

   If one differs, R2 serves an uncommitted pairing: resolve it before
   pushing. Note the live commit (`/qed64-build.json`): it is the
   pre-change rollback target.
2. No upload is needed (the same pairing).
3. Push the guard (`deploy: a guard before every deploy …`), the
   `deploy.yml` fixes and this change in one push, the clean-ups after it
   too if they are ready. The guard checks `init.81276a747b990f32.snapz` and
   `mathlib.79936198cd60caf2.snapz` through the old Worker (the status only:
   it sends no length on HEAD); the key is the same under both Workers.
4. Run the live checks below.
5. From then on, upload only with an `upload-artifacts.sh` from this change
   on. An older one still writes R2's frozen indexes, which the pre-change
   rollback target reads.

**Live checks** (`…` is `https://qed64.fawadworkaddress.workers.dev`):
- `curl -sI …/snapshots/index.json`: 200, `public, max-age=0,
  must-revalidate`, `application/json`, COOP/COEP/CORP.
- `curl -sI …/snapshots/init.81276a747b990f32.snapz`: 200, immutable,
  `content-length: 31719003`.
- `curl -sI …/snapshots/x.0123456789abcdef.snapz`: 404 `no-store`.
- `curl -sI …/runtime/chunks/x.part-000`: 404 `no-store`.
- `curl -s -o /dev/null -w '%{http_code}\n' -r 0-9 …/snapshots/init.81276a747b990f32.snapz`: 206.
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST …/snapshots/index.json`: 405.
- The page boots, and DevTools shows `/snapshots/index.json` served.

Optional, after step 1: `node pipeline/release/release-manifest.mjs --commit
HEAD --out release.json` writes the `qed64.release/v1` manifest of the
release. The manifest names every served object by sha256 and gives the
release three ids: `releaseId`, `artifactSetId` and `shellId`. The generator
refuses when the pinned toolchain record, the base tree, the runtime
manifest, the snapshot index and the profiles disagree about the pairing. docs/RELEASE-BUNDLE.md covers the
manifest and how a downstream verifies a release with it (nothing publishes
it: the release bundle was retired on 2026-11-01).

## The toolchain release prefix (decision 3)

The Lean runtime and the library packs are not QED64's to upload: they are
the lean4-wasm64 release's, uploaded once by its owner under
**`lean4-wasm64/<release id>/`** of the shared bucket `qed64-artifacts` and
served by every site that uses that release (QED64, lean4game, the widgets
showcase), each under its own origin; the browser is never pointed at R2 or
at another site (the fork's `formats/HOSTING.md`, rules 3 and 4). QED64's
Worker routes by the release record (`infra/worker.js`:
`createWorker({ release, extraRoutes })`, its two indexes from the deploy):

| Request | Served from | Owner |
|---|---|---|
| `/runtime/*` | R2 `lean4-wasm64/<id>/runtime/*` | the release's owner |
| `/profiles/*` except `/profiles/index.json` | R2 `lean4-wasm64/<id>/profiles/*` | the release's owner |
| `/profiles/index.json` and `/snapshots/index.json` (GET, HEAD) | the deploy's static assets (`dist/`, from the tracked files) | QED64, by the push |
| every other `/snapshots/*` (`.snapz`, an overlay, the frozen per-build copies) | R2 `snapshots/*` | QED64, `upload-artifacts.sh` |

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
- **No fallback to the bucket root.** A `/runtime/*` or `/profiles/*`
  lookup reads the release prefix only; a miss is a 404. From decision 3
  until 2026-10-25 a miss was retried once at the bucket root
  (`releaseFallback: true`, one deprecation cycle), for shells deployed
  before the switch, whose runtime and packs only the root held. The last
  root upload was the e1a79c1 landing's (2026-10-08, `--legacy-root`, now
  retired: runtime `wasm64-f69cca24d0878a58`, the rollback for the Worker
  change). The live shell never reads the root, and the 2026-10-23 delete
  removed the root `runtime/` and `profiles/` except `profiles/index.json`,
  accepting that tabs of the f69cca24 shell open since before 2026-10-16
  could no longer reboot; with nothing left for it to find, the option is
  off. The library keeps it for other sites ("Reusing the edge worker": the
  options table and the `release` paragraph).
- **Misses are never cached.** Every status ≥ 400 is `Cache-Control:
  no-store` on every path since 2026-11 (the hardened `errorCacheControl`,
  review R18 inside D2), so a 404 during a deploy-before-upload window is
  not cached for a year under a digest-named URL. Before that, only
  release-mapped paths were no-store, and a missing snapshot got the path
  rule (`immutable`).
- **The fork's cache rule (HARDENING #64; relay closed 2026-11-03).** The
  fork's `formats/HOSTING.md` rule 8 and its Python reference server's
  `MUTABLE` carry the same test as `infra/edge-worker.js`, so a site that
  copies either revalidates the per-build index copies. Consumers still import
  `isImmutable` from `qed64/edge` (the showcase does) rather than copy the
  snippet.
- **Adoption order.** (1) The release's owner uploads
  `lean4-wasm64/<id>/` (HOSTING.md's three rclone passes) and confirms it
  complete. (2) QED64 runs `scripts/upload-artifacts.sh`, `.snapz` only: it
  refuses unless `rclone lsf` lists `lean4-wasm64/<id>/release.json` and
  the shell's manifest, every snapshot and the profile index are that
  release's runtime (an `lsf` that fails for a local reason, such as no
  `qed64-r2` remote, expired credentials or no network, prints `cannot
  check R2 (rclone lsf exit N)` instead of the not-in-R2 refusal; both exit
  3), then uploads each `.snapz` the index names. (3) The push: one deploy
  of the shell, the Worker and the two indexes together (CI runs
  `scripts/deploy-app.sh`), refused by its guard if it comes before (2). The
  shell and the Worker always ship in the same deploy, so the Worker never
  routes to a release the shell does not pin.
- **Rollback.** "Atomic deploys" above. Revert the commit that changed the
  record and the manifests and push: the reverted record routes the Worker
  to the previous release's prefix (`lean4-wasm64/<previous id>/`, which its
  owner keeps), the reverted indexes ship in the same deploy, and the
  previous pairing's snapshots are still at the bucket root as long as
  nobody deleted them. No upload is needed. Reverting decision 3's Worker
  change itself would need the root `runtime/` and `profiles/` copies,
  which are gone.
- **Old shells.** The Worker routes by the record it was deployed with, so
  after a deploy nothing of an older release's runtime or packs is
  reachable. A tab that booted before the deploy keeps the runtime it has
  in memory; a reload loads the new shell (the HTML is `must-revalidate`).
  Until then it can trip in three places. A session restart re-fetches its
  runtime chunks by URL: the HTTP cache usually has them (immutable), and
  a miss is a 404. A tab of a release before D1 (2026-11) can still
  install a pack on demand and gets the new release's manifest, which its
  installProfile refuses `stale` (HARDENING #81); since D1 no tab installs
  a pack, and a D1 tab removes the old OPFS pack store at boot, which an
  older tab may still have mounted (not observed; its exact import then
  falls back to the covered header).
  An old shell that boots after the deploy (a page restored from a cache)
  asks for `/runtime/runtime-manifest.<its buildId>.json`: a 404
  (no-store), then the mutable `/runtime/runtime-manifest.json`, the new
  runtime. No page installs a pack at boot since D1, so it gets as far as
  the snapshot index: it reads the deploy's, which names the new runtime,
  and asks for its own runtime's per-build copy. That copy exists only for
  a runtime QED64 served before 2026-11 (frozen in R2; QED64 publishes none
  since): it refuses the new runtime (`unpaired`; the boot card names the
  runtimes, with Reload beside it). Otherwise the copy is a 404 (no-store),
  the page keeps the deploy's index and pairs with the new snapshots under
  the old page. The snapshots' and the two indexes' URLs never moved.

## Security model: who can write what

R2 buckets are **private by default** and this deployment never changes
that: the Worker's only bucket operations are `get` and `head` (reads) through a binding,
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
directory = "dist"          # the shell, never the runtime, packs or .snapz (25 MiB/file cap; R2 serves them)
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

### Serving a site's own indexes from the deploy

A site whose mutable indexes live in R2 has a window between their upload
and its deploy, which HARDENING #64's per-build copies paper over. Serving
them from the deploy instead closes it: copy each index into the assets
directory at its own URL path, and route exactly those paths to the assets
before the artifact prefixes. QED64's `infra/worker.js`:

```js
import { createWorker } from "./edge-worker.js";
import release from "../toolchain/lean4-wasm64-release.json" with { type: "json" };

// Exact paths, GET and HEAD only: an overlay's /snapshots/<dir>/index.json, the frozen per-build
// copies and any other method fall through to the artifact route (R2; 405 for other methods).
const DEPLOYED_INDEXES = new Set(["/snapshots/index.json", "/profiles/index.json"]);

export default createWorker({
  release,
  extraRoutes: [{
    match: (url, request) => DEPLOYED_INDEXES.has(url.pathname) && (request.method === "GET" || request.method === "HEAD"),
    handle: (request, env, ctx, kit) => kit.serveAsset(request),
  }],
});
```

- `kit.serveAsset` returns the assets binding's answer with the isolation
  headers and the cache rule already on it (`must-revalidate` for an
  `index.json`), and, under the defaults, a HEAD carries the GET's
  `Content-Length` (`assetHeadLength`).
- A file missing from the assets is a 404, `no-store` under the default
  `errorCacheControl`, so a browser asks again after the next deploy.
- Any other method falls through to the artifact route, which answers 405
  with `Allow: GET, HEAD` without asking R2.
- The deploy must refuse a build without the files (QED64's
  `scripts/deploy-app.sh` refuses a missing one and one that is not
  byte-identical to the tracked file). Without `/snapshots/index.json` every
  boot fails. QED64's pages read no profile index since D1 (`lib/qed64-boot.ts`),
  so a missing `/profiles/index.json` fails no boot on them.

### Legacy vs hardened

The behaviour switches default to the hardened forks' behaviour;
**`QED64_LEGACY`** (frozen) sets each one back: `createWorker(QED64_LEGACY)`
is byte-identical to the pre-library worker (status, headers, body and every
binding call, pinned by `tests/unit/edge-worker.test.ts` against the original
source in `tests/fixtures/edge-worker/worker-47f50e8.js`; the one deliberate
difference is a throw, now a 500 with the isolation headers instead of the
runtime's error page). QED64 deployed `QED64_LEGACY` plus its release until
2026-11; it now takes the defaults (with `release` and one extra route,
"Serving a site's own indexes from the deploy" above).

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
`npm run preview:prod` serves a local build through them (it runs
`infra/worker.js`); `QED64_EDGE=legacy` through `QED64_LEGACY` with the
release ("Local preview: the Worker's own code" above). Under
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

QED64's own `infra/worker.js` is `createWorker({ release, extraRoutes: [its
two indexes from ASSETS] })`. A site that shares the bucket passes its
own prefix and the same record shape:
`createWorker({ r2Prefix: "<site>/", release })` reads `/runtime/*` and
`/profiles/*` from `lean4-wasm64/<id>/`, and its `profiles/index.json` and
`snapshots/*` from `<site>/`. (The showcase's Worker does not call
`createWorker` today: it imports `isImmutable` from its submodule's
`infra/worker.js`, checked 2026-11-01. `tests/unit/edge-worker.test.ts` runs
the configuration it would pass.)

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
