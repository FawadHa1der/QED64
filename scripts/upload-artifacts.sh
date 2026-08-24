#!/bin/bash
# Sync the served artifacts (runtime chunks, profile packs, snapshots) into
# the R2 bucket. Run once after each artifact change (new runtime, re-bake,
# profile update) — pushes only what changed, keyed by name; digest-named
# files never collide. Requires `npx wrangler login` (or CLOUDFLARE_API_TOKEN).
set -euo pipefail
cd "$(dirname "$0")/.."
BUCKET=qed64-artifacts
for dir in runtime profiles snapshots; do
  find "public/$dir" -type f | while read -r f; do
    key="${f#public/}"
    remote=$(npx wrangler r2 object head "$BUCKET/$key" 2>/dev/null | grep -c etag || true)
    size=$(stat -f%z "$f")
    echo "put $key ($size bytes)"
    npx wrangler r2 object put "$BUCKET/$key" --file "$f" --content-type "$( [[ $f == *.json ]] && echo application/json || echo application/octet-stream )"
  done
done
echo "artifact sync complete"
