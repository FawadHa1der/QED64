#!/bin/bash
# Upload QED64's OWN served artifacts into the R2 bucket via the S3-compatible
# API (rclone: wrangler's `r2 object put` caps single objects at ~300 MiB, and
# mathlib.snapz is ~845 MB, so rclone does multipart uploads instead).
#
# Decision 3 (docs/DEPLOY.md, "The toolchain release prefix"): the Lean
# runtime and the library packs are the lean4-wasm64 release's, uploaded once
# by its owner under lean4-wasm64/<release id>/ (the fork's formats/HOSTING.md),
# and the Worker reads /runtime/* and /profiles/* from there. QED64 uploads
# only what is its own — the site-owned paths of the release's hosting rules:
#   public/snapshots/        → snapshots/            (the snapshots + their index)
#   public/profiles/index.json → profiles/index.json (which packs the page offers)
# The release id is toolchain/lean4-wasm64-release.json's; the upload is
# refused unless the shell's runtime manifest and every snapshot are that
# release's runtime (buildId) and the release is already in R2.
#
#   --legacy-root  ALSO upload public/runtime/ and public/profiles/ to the
#                  bucket root, as before decision 3 (with the per-build
#                  manifest copy): for one cycle, the rollback path if the
#                  Worker change is reverted, and what old shells read
#                  through the Worker's fallback.
#   DRY_RUN=1      print the plan (every rclone write it would run) and write
#                  nothing; the preflight and the R2 check still run.
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
USAGE="usage: [DRY_RUN=1] scripts/upload-artifacts.sh [--legacy-root]"

LEGACY_ROOT=0
for arg in "$@"; do
  case "$arg" in
    --legacy-root) LEGACY_ROOT=1 ;;
    *) echo "upload-artifacts: unknown argument $arg" >&2; echo "$USAGE" >&2; exit 2 ;;
  esac
done
command -v rclone >/dev/null || { echo "rclone required: brew install rclone" >&2; exit 2; }

# Preflight: the files being uploaded must reference files that exist locally
# (a partial tree would strand the site), and the shell and the snapshots must
# be paired with the release the Worker routes to.
RELEASE_ID=$(LEGACY_ROOT=$LEGACY_ROOT node -e '
  const fs = require("fs");
  let bad = 0;
  const fail = (m) => { console.error("upload-artifacts: " + m); bad = 1; };
  const need = (p) => { if (!fs.existsSync(p)) fail("MISSING: " + p); };
  const rec = JSON.parse(fs.readFileSync("toolchain/lean4-wasm64-release.json", "utf8"));
  const buildId = rec.runtime && rec.runtime.buildId;
  const rt = JSON.parse(fs.readFileSync("public/runtime/runtime-manifest.json", "utf8"));
  if (rt.buildId !== buildId) fail("public/runtime/runtime-manifest.json is runtime " + rt.buildId + ", the toolchain release " + rec.id + " is " + buildId);
  const sn = JSON.parse(fs.readFileSync("public/snapshots/index.json", "utf8"));
  for (const s of sn.snapshots ?? []) {
    need("public" + s.url);
    if (s.runtime !== buildId) fail("snapshot " + s.name + " is for runtime " + s.runtime + ", the toolchain release " + rec.id + " is " + buildId);
  }
  need("public/profiles/index.json");
  let chunkCount = 0;
  if (process.env.LEGACY_ROOT === "1") {
    for (const f of Object.values(rt.files ?? {}))
      for (const c of f.chunks ?? []) { chunkCount++; need("public" + c.url); }
    if (chunkCount === 0) fail("manifest lists no chunks — refusing");
  }
  if (bad) process.exit(3);
  console.error("preflight ok: release " + rec.id + ", runtime " + buildId + ", " + (sn.snapshots ?? []).length + " snapshots" + (process.env.LEGACY_ROOT === "1" ? ", " + chunkCount + " chunks (--legacy-root)" : ""));
  console.log(rec.id);
')

# The release must already be in R2: its owner uploads it (a read; DRY_RUN too).
# "Not in R2" is said only when rclone could look: lsf listed nothing, or
# exited 3/4 (rclone's directory/file not found). Any other failure (no
# qed64-r2 remote, expired credentials, no network) is a local problem, not
# the release owner's, and is reported as such.
lsf_err=$(mktemp "${TMPDIR:-/tmp}/upload-artifacts-lsf.XXXXXX")
trap 'rm -f "$lsf_err"' EXIT
lsf_rc=0
listed=$(rclone lsf "qed64-r2:$BUCKET/lean4-wasm64/$RELEASE_ID/release.json" 2>"$lsf_err") || lsf_rc=$?
if [ "$lsf_rc" -ne 0 ] && [ "$lsf_rc" -ne 3 ] && [ "$lsf_rc" -ne 4 ]; then
  first=$(grep -m1 . "$lsf_err" | tr -d '\r' || true)
  echo "upload-artifacts: cannot check R2 (rclone lsf exit $lsf_rc): ${first:-no error output}" >&2
  exit 3
fi
if [ "$listed" != "release.json" ]; then
  echo "upload-artifacts: REFUSED: the toolchain release $RELEASE_ID is not in R2 (its owner uploads it: lean4-wasm64 formats/HOSTING.md)" >&2
  exit 3
fi

run() {
  if [ "${DRY_RUN:-}" = 1 ]; then echo "would run: $*"; else "$@"; fi
}

run rclone copy public/snapshots "qed64-r2:$BUCKET/snapshots" --checksum --transfers 4 --s3-chunk-size 64M --progress
# --s3-no-check-bucket: an object-scoped R2 token may not create buckets, and a
# single-file copyto otherwise tries to (403 AccessDenied on CreateBucket).
run rclone copyto public/profiles/index.json "qed64-r2:$BUCKET/profiles/index.json" --checksum --s3-no-check-bucket

if [ "$LEGACY_ROOT" = 1 ]; then
  # Immutable, digest-named copy of the manifest at the root ("atomic
  # promotes" in docs/DEPLOY.md), as before decision 3; the release carries
  # its own runtime/runtime-manifest.<buildId>.json. Gitignored.
  BUILD_ID=$(node -p 'JSON.parse(require("fs").readFileSync("public/runtime/runtime-manifest.json","utf8")).buildId')
  run cp public/runtime/runtime-manifest.json "public/runtime/runtime-manifest.$BUILD_ID.json"
  for dir in runtime profiles; do
    run rclone copy "public/$dir" "qed64-r2:$BUCKET/$dir" --checksum --transfers 4 --s3-chunk-size 64M --progress
  done
fi

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "dry run: nothing uploaded"
  exit 0
fi
echo "artifact upload complete — verify a sample:"
rclone ls "qed64-r2:$BUCKET/snapshots" | head -3 || true
