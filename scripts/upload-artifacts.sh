#!/bin/bash
# Sync the served artifacts (runtime chunks, profile packs, snapshots) into
# the R2 bucket via the S3-compatible API — wrangler's `r2 object put` caps
# single objects at ~300 MiB, and mathlib.snapz is ~845 MB, so rclone does
# multipart uploads instead. Content-addressed names make re-runs cheap:
# `rclone sync` only transfers what changed.
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
for dir in runtime profiles snapshots; do
  rclone sync "public/$dir" "qed64-r2:$BUCKET/$dir" --checksum --transfers 4 --s3-chunk-size 64M --progress
done
echo "artifact sync complete — verify a sample:"
rclone ls "qed64-r2:$BUCKET/snapshots" | head -3
