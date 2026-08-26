#!/bin/bash
# Upload the served artifacts (runtime chunks, profile packs, snapshots) into
# the R2 bucket via the S3-compatible API — wrangler's `r2 object put` caps
# single objects at ~300 MiB, and mathlib.snapz is ~845 MB, so rclone does
# multipart uploads instead. Content-addressed names make re-runs cheap:
# only changed files transfer.
#
# `rclone copy` (NOT sync): a promote must never delete the artifacts the
# currently-deployed manifest still points at — clients mid-session and the
# window between this upload and the app deploy both depend on them. Old
# digest-named files are harmless; garbage-collect them deliberately, later,
# once no deployed manifest references them.
#
# One-time rclone remote setup (credentials from an R2 API token, see
# docs/DEPLOY.md — never commit them):
#   rclone config create qed64-r2 s3 provider=Cloudflare \
#     access_key_id=$R2_ACCESS_KEY_ID secret_access_key=$R2_SECRET_ACCESS_KEY \
#     endpoint=https://$CF_ACCOUNT_ID.r2.cloudflarestorage.com acl=private
set -euo pipefail
cd "$(dirname "$0")/.."
BUCKET=qed64-artifacts
command -v rclone >/dev/null || { echo "rclone required: brew install rclone" >&2; exit 2; }

# Preflight: the manifest/index files being uploaded must reference chunk and
# snapshot files that exist locally — a partial tree would strand the site.
node -e '
  const fs = require("fs");
  let bad = 0;
  const need = (p) => { if (!fs.existsSync(p)) { console.error("MISSING: " + p); bad = 1; } };
  const rt = JSON.parse(fs.readFileSync("public/runtime/runtime-manifest.json", "utf8"));
  let chunkCount = 0;
  for (const f of Object.values(rt.files ?? {}))
    for (const c of f.chunks ?? []) { chunkCount++; need("public" + c.url); }
  if (chunkCount === 0) { console.error("manifest lists no chunks — refusing"); bad = 1; }
  const sn = JSON.parse(fs.readFileSync("public/snapshots/index.json", "utf8"));
  for (const s of sn.snapshots ?? []) need("public" + s.url);
  if (bad) process.exit(3);
  console.log("preflight ok: runtime " + rt.buildId + ": " + chunkCount + " chunks, " + (sn.snapshots ?? []).length + " snapshots");
'

# Immutable, digest-named copy of the manifest ("atomic promotes" in
# docs/DEPLOY.md): the deployed shell asks for the manifest of the exact
# runtime it was built against, so shell deploys never race the mutable
# manifest switch. Gitignored; regenerated on every upload.
BUILD_ID=$(node -p 'JSON.parse(require("fs").readFileSync("public/runtime/runtime-manifest.json","utf8")).buildId')
cp public/runtime/runtime-manifest.json "public/runtime/runtime-manifest.$BUILD_ID.json"

for dir in runtime profiles snapshots; do
  rclone copy "public/$dir" "qed64-r2:$BUCKET/$dir" --checksum --transfers 4 --s3-chunk-size 64M --progress
done
echo "artifact upload complete — verify a sample:"
rclone ls "qed64-r2:$BUCKET/snapshots" | head -3
