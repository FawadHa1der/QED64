#!/bin/bash
# Build the app shell and deploy it to Cloudflare Workers (seconds; the
# multi-GB artifacts live in R2 and are uploaded separately, and rarely).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
# Artifacts are served from R2 — never bundle them as worker assets.
rm -rf dist/runtime dist/profiles dist/snapshots
npx wrangler deploy
