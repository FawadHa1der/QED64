#!/bin/bash
# Build the app shell and deploy it to Cloudflare Workers (seconds; the
# multi-GB artifacts live in R2 and are uploaded separately, and rarely, by
# scripts/upload-artifacts.sh). The shell is the lean4monaco editor
# (frontend/), built into dist/.
#
# The one deploy path: .github/workflows/deploy.yml runs this script after its
# tests, and an operator runs the same script by hand. Steps, in order:
#   1. npm ci --prefix frontend   (only when frontend/node_modules is absent;
#                                  CI has installed both roots already)
#   2. npm run typecheck:site
#   3. npm run build:site         (dist/)
#   4. the prune: rm -rf dist/runtime dist/profiles dist/snapshots
#   5. the size check: refuse (exit 1, one line) when dist/ still holds a
#      runtime/, profiles/ or snapshots/ path, or any file over 25 MiB
#   6. npx wrangler deploy
#
# Usage: scripts/deploy-app.sh [--dry-run]
#   --dry-run  run steps 1-5 and print step 6 instead of running it (for an
#              operator checking a build, and for tests/unit/deploy-script.test.ts)
# It runs from the repository root whatever the cwd. Exit 0 deployed (or, with
# --dry-run, ready to deploy); 1 the size check refused; 2 a bad argument; a
# failing step stops the script with that step's own exit code.
#
# Auth: wrangler's native non-interactive variables, CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID (the account id spares narrowly-scoped tokens the
# /accounts discovery call); without them wrangler uses `wrangler login`.
set -euo pipefail

usage="usage: scripts/deploy-app.sh [--dry-run]"
dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,/^set -euo pipefail$/{/^set /d;s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "deploy-app: unknown argument: $arg" >&2; echo "$usage" >&2; exit 2 ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ -d frontend/node_modules ] || npm ci --prefix frontend
npm run typecheck:site
npm run build:site

# Artifacts are served from R2 — never bundle them as worker assets.
# (publicDir is off for builds; this prune is a defensive invariant, and the
# only copy of it: deploy.yml calls this script.)
rm -rf dist/runtime dist/profiles dist/snapshots

# Workers static assets refuse any file over 25 MiB, and an artifact
# directory in dist/ would ship a stale runtime beside R2's. Refuse here, in
# one line, before wrangler uploads anything.
refuse() { echo "deploy-app: REFUSED: $*" >&2; exit 1; }
[ -d dist ] || refuse "no dist/ after npm run build:site"
for dir in runtime profiles snapshots; do
  if [ -e "dist/$dir" ] || [ -L "dist/$dir" ]; then
    refuse "dist/$dir is still present after the prune (artifacts are served from R2, never bundled)"
  fi
done
max_bytes=$((25 * 1024 * 1024))
big="$(find -L dist -type f -size +${max_bytes}c)"
if [ -n "$big" ]; then
  count="$(printf '%s\n' "$big" | wc -l | tr -d ' ')"
  first="$(printf '%s\n' "$big" | head -n 1)"
  refuse "dist/ holds $count file(s) over 25 MiB, the Workers assets cap; first: $first ($(wc -c < "$first" | tr -d ' ') bytes)"
fi

# Plain wrangler (pinned in devDependencies) instead of wrangler-action: the
# wrapper swallowed error output on failure.
if [ "$dry_run" = 1 ]; then
  echo "deploy-app: --dry-run: dist/ is ready; would run: npx wrangler deploy"
else
  npx wrangler deploy
fi
