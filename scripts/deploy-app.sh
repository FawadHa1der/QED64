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
#   4. the prune: rm -rf dist/runtime, and every entry of dist/profiles/
#      and dist/snapshots/ but index.json (the deploy carries QED64's two
#      indexes with the shell: docs/DEPLOY.md "Atomic deploys")
#   5. the size check: refuse (exit 1, one line) when dist/ still holds a
#      runtime/ path, holds a symlinked dist/profiles or dist/snapshots, lacks
#      dist/profiles/index.json or dist/snapshots/index.json or holds one that
#      is not byte-identical to the tracked public/ file, holds any other
#      profiles/ or snapshots/ path, or any file over 25 MiB
#   6. the guard: node scripts/deploy-guard.mjs (architecture review R19a):
#      refuse (exit 1) unless every .snapz public/snapshots/index.json names
#      already answers on the live origin
#   7. npx wrangler deploy
#
# Usage: [QED64_DEPLOY_ORIGIN=<url>|none] scripts/deploy-app.sh [--dry-run]
#   --dry-run  run steps 1-6 and print step 7 instead of running it (for an
#              operator checking a build, and for tests/unit/deploy-script.test.ts)
#   QED64_DEPLOY_ORIGIN  the origin the guard asks (default the live site;
#              none skips the guard, for a first deploy to a new origin)
# It runs from the repository root whatever the cwd. Exit 0 deployed (or, with
# --dry-run, ready to deploy); 1 the size check or the guard refused; 2 a bad
# argument; a failing step stops the script with that step's own exit code. 1
# also comes from a failing step (vite build exits 1): a refusal is the run
# whose stderr ends with a `deploy-app: REFUSED:` or `deploy-guard: REFUSED:`
# line.
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

# The deploy carries the shell and QED64's two indexes (dist/profiles/index.json and
# dist/snapshots/index.json, copied from the tracked public/ files by the build: docs/DEPLOY.md
# "Atomic deploys"); every other artifact is served from R2 and never bundled. (publicDir is off
# for builds and the build copies only those two, so this prune is a defensive invariant, and the
# only copy of it: deploy.yml calls this script.)
rm -rf dist/runtime
for dir in profiles snapshots; do
  [ -d "dist/$dir" ] || continue
  find "dist/$dir" -mindepth 1 -maxdepth 1 ! -name index.json -exec rm -rf {} +
done

# Workers static assets refuse any file over 25 MiB, an artifact in dist/
# would ship a stale runtime or snapshot beside R2's, and a deploy without
# its two indexes (or with other bytes than the tracked ones) would serve
# another pairing, or none. Refuse here, in one line, before wrangler uploads
# anything.
refuse() { echo "deploy-app: REFUSED: $*" >&2; exit 1; }
[ -d dist ] || refuse "no dist/ after npm run build:site"
if [ -e dist/runtime ] || [ -L dist/runtime ]; then
  refuse "dist/runtime is still present after the prune (the runtime is the toolchain release's, served from R2, never bundled)"
fi
for dir in profiles snapshots; do
  [ ! -L "dist/$dir" ] || refuse "dist/$dir is a symlink: the deploy carries a plain dist/$dir/ holding only index.json"
done
for idx in profiles/index.json snapshots/index.json; do
  { [ -f "dist/$idx" ] && [ ! -L "dist/$idx" ]; } || refuse "dist/$idx is missing: the deploy serves QED64's tracked public/$idx with the shell (npm run build:site copies it)"
  cmp -s "dist/$idx" "public/$idx" || refuse "dist/$idx is not byte-identical to the tracked public/$idx"
done
stray="$(find dist/profiles dist/snapshots -mindepth 1 ! -path dist/profiles/index.json ! -path dist/snapshots/index.json -print -quit)"
[ -z "$stray" ] || refuse "dist/ holds $stray: of the artifact directories the deploy carries only profiles/index.json and snapshots/index.json (everything else is served from R2)"
max_bytes=$((25 * 1024 * 1024))
big="$(find -L dist -type f -size +${max_bytes}c)"
if [ -n "$big" ]; then
  count="$(printf '%s\n' "$big" | wc -l | tr -d ' ')"
  first="$(printf '%s\n' "$big" | head -n 1)"
  refuse "dist/ holds $count file(s) over 25 MiB, the Workers assets cap; first: $first ($(wc -c < "$first" | tr -d ' ') bytes)"
fi

# R19a: every .snapz public/snapshots/index.json names must already answer on the live origin
# (scripts/upload-artifacts.sh uploads them before the push), or nothing deploys. Release-mapped
# files are never checked through the live origin (its Worker maps them into ITS release);
# upload-artifacts.sh checks the release's release.json in R2. Read-only, so --dry-run runs it too.
# QED64_DEPLOY_ORIGIN overrides the origin (none: skip, for a first deploy to a new origin).
node scripts/deploy-guard.mjs

# Plain wrangler (pinned in devDependencies) instead of wrangler-action: the
# wrapper swallowed error output on failure.
if [ "$dry_run" = 1 ]; then
  echo "deploy-app: --dry-run: dist/ is ready; would run: npx wrangler deploy"
else
  npx wrangler deploy
fi
