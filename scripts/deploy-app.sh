#!/bin/bash
# Build the app shell and deploy it to Cloudflare Workers (seconds; the
# multi-GB artifacts live in R2 and are uploaded separately, and rarely).
# The shell is the lean4monaco editor (frontend/), built into dist/.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d frontend/node_modules ] || npm ci --prefix frontend
npm run typecheck:site
npm run build:site
# Artifacts are served from R2 — never bundle them as worker assets.
# (publicDir is off for builds; this prune is a defensive invariant.)
rm -rf dist/runtime dist/profiles dist/snapshots
npx wrangler deploy
