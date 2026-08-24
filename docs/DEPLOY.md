# Deploying QED64 (demo tier, ~$0/month)

QED64 is fully static — no server ever sees a proof — but it needs two
things most free hosts cannot give: **cross-origin isolation headers**
(COOP/COEP, or SharedArrayBuffer/Memory64 refuse to exist) and **files up
to 845 MB with free egress** (a Mathlib user downloads ~2.2 GB once).
GitHub Pages (100 MB/file, no headers), Cloudflare Pages (25 MiB/file) and
Netlify/Vercel free bandwidth caps all fail one of these.

The setup that fits: **Cloudflare Workers static assets (app shell) + R2
(artifacts), one origin, headers set in `infra/worker.js`.**

| | Free tier | We use |
|---|---|---|
| R2 storage | 10 GB, **zero egress fees** | 2.1 GB |
| R2 reads | 10 M/month | ~100–200/visitor |
| Workers requests | 100 k/day | ~100/install, ~5/revisit |

## One-time setup

1. Cloudflare account → R2 → create bucket `qed64-artifacts`.
2. `npx wrangler login` (or export `CLOUDFLARE_API_TOKEN`).
3. `scripts/upload-artifacts.sh` — pushes runtime chunks, profile packs and
   snapshots to R2 (one 2.1 GB upload; re-run only when artifacts change).
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
