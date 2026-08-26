# Deploying QED64 (demo tier, ~$0/month)

QED64 is fully static — no server ever sees a proof — but it needs two
things most free hosts cannot give: **cross-origin isolation headers**
(COOP/COEP, or SharedArrayBuffer/Memory64 refuse to exist) and **files up
to 845 MB with free egress** (a Mathlib user downloads ~2.2 GB once).
GitHub Pages (100 MB/file, no headers), Cloudflare Pages (25 MiB/file) and
Netlify/Vercel free bandwidth caps all fail one of these.

The setup that fits: **Cloudflare Workers static assets (app shell) + R2
(artifacts), one origin, headers set in `infra/worker.js`.**

The deployed shell is the lean4monaco editor in `frontend/` (Monaco + the
real vscode-lean4 InfoView on the in-browser wasm64 LSP). `npm run
build:site` builds it into the repo-root `dist/` that `wrangler deploy`
ships; the older shell at the repo root remains dev-only (`npm run dev`,
port 5183). All of the editor's runtime paths are root-absolute
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
