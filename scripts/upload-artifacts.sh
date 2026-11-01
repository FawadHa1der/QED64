#!/bin/bash
# Upload QED64's OWN served artifacts into the R2 bucket via the S3-compatible
# API (rclone: wrangler's `r2 object put` caps single objects at ~300 MiB, and
# mathlib.snapz is ~845 MB, so rclone does multipart uploads instead).
#
# Decision 3 (docs/DEPLOY.md, "The toolchain release prefix"): the Lean
# runtime and the library packs are the lean4-wasm64 release's, uploaded once
# by its owner under lean4-wasm64/<release id>/ (the fork's formats/HOSTING.md),
# and the Worker reads /runtime/* and /profiles/* from there. QED64 uploads
# only its snapshots, all digest-named:
#   each .snapz the tracked public/snapshots/index.json names → snapshots/<file>
#   each overlay directory public/snapshots/<overlay>/        → snapshots/<overlay>/
# (an overlay is opt-in, ?snapshots=snapshots/<overlay>, and goes whole, its
# own index.json travelling with it as before). The release id is
# toolchain/lean4-wasm64-release.json's; the upload is refused unless the
# shell's runtime manifest, every snapshot and the profile index are that
# release's runtime (buildId) and the release is already in R2.
#
# The two indexes are NOT uploaded: /snapshots/index.json and
# /profiles/index.json ship in the deploy (dist/, served from the Worker's
# static assets: docs/DEPLOY.md "Atomic deploys"), so this upload changes
# nothing a deployed shell reads. Run it BEFORE the push: the push's guard
# (scripts/deploy-guard.mjs) refuses the deploy until every .snapz the
# committed index names answers on the live origin.
#
# R2's own snapshots/index.json, profiles/index.json and the per-build copies
# (snapshots/index.<buildId>.json, snapshots/profiles-index.<buildId>.json)
# date from before 2026-11. They are never written again, and stay frozen
# while a pre-change Worker version (which reads them) is a rollback target:
# never run an upload-artifacts.sh from before this change, which would
# rewrite them.
#
# The root runtime/ and profiles/ copies (all but profiles/index.json) are
# gone: the Worker reads /runtime/* and /profiles/<not index.json> only from
# the release prefix (no fallback to the bucket root since 2026-10-25), so
# --legacy-root, which uploaded them for one deprecation cycle, is retired
# and refused.
#
# Environment:
#   DRY_RUN=1      print the plan (every rclone write it would run) and write
#                  nothing; the preflight and the R2 check still run.
#
# `rclone copy`/`copyto`, never sync, never delete: open tabs and every
# rollback target read older .snapz. Old digest-named files are harmless;
# garbage-collect them deliberately, later, by exact keys, once no
# rollback-target version names them (docs/DEPLOY.md "Atomic deploys").
#
# One-time rclone remote setup (credentials from an R2 API token, see
# docs/DEPLOY.md — never commit them):
#   rclone config create qed64-r2 s3 provider=Cloudflare \
#     access_key_id=$R2_ACCESS_KEY_ID secret_access_key=$R2_SECRET_ACCESS_KEY \
#     endpoint=https://$CF_ACCOUNT_ID.r2.cloudflarestorage.com acl=private
set -euo pipefail
cd "$(dirname "$0")/.."
BUCKET=qed64-artifacts
USAGE="usage: [DRY_RUN=1] scripts/upload-artifacts.sh"

for arg in "$@"; do
  case "$arg" in
    --legacy-root) echo "upload-artifacts: --legacy-root is retired: the Worker serves /runtime/* and /profiles/<not index.json> only from lean4-wasm64/<release id>/, so bucket-root copies would never be read (docs/DEPLOY.md)" >&2; exit 2 ;;
    *) echo "upload-artifacts: unknown argument $arg" >&2; echo "$USAGE" >&2; exit 2 ;;
  esac
done
command -v rclone >/dev/null || { echo "rclone required: brew install rclone" >&2; exit 2; }

# Preflight: the files being uploaded must reference files that exist locally
# (a partial tree would strand the site), and the shell and the snapshots must
# be paired with the release the Worker routes to.
PLAN=$(node -e '
  const fs = require("fs");
  let bad = 0;
  const fail = (m) => { console.error("upload-artifacts: " + m); bad = 1; };
  const need = (p) => { if (!fs.existsSync(p)) fail("MISSING: " + p); };
  const rec = JSON.parse(fs.readFileSync("toolchain/lean4-wasm64-release.json", "utf8"));
  const buildId = rec.runtime && rec.runtime.buildId;
  const rt = JSON.parse(fs.readFileSync("public/runtime/runtime-manifest.json", "utf8"));
  if (rt.buildId !== buildId) fail("public/runtime/runtime-manifest.json is runtime " + rt.buildId + ", the toolchain release " + rec.id + " is " + buildId);
  const sn = JSON.parse(fs.readFileSync("public/snapshots/index.json", "utf8"));
  const files = [];
  for (const s of sn.snapshots ?? []) {
    const m = /^\/snapshots\/([A-Za-z0-9][A-Za-z0-9._-]*\.snapz)$/.exec(typeof s.url === "string" ? s.url : "");
    if (!m) { fail("snapshot " + s.name + " names " + JSON.stringify(s.url) + ", not a .snapz directly under /snapshots/"); continue; }
    files.push(m[1]);
    need("public" + s.url);
    if (s.runtime !== buildId) fail("snapshot " + s.name + " is for runtime " + s.runtime + ", the toolchain release " + rec.id + " is " + buildId);
  }
  need("public/profiles/index.json");
  // The deploy serves this index with the record: it must pair with the release.
  const pi = JSON.parse(fs.readFileSync("public/profiles/index.json", "utf8"));
  const piRuntime = pi.runtime && pi.runtime.buildId;
  if (piRuntime !== buildId) fail("public/profiles/index.json is for runtime " + (piRuntime || "(none recorded)") + ", the toolchain release " + rec.id + " is " + buildId);
  if (bad) process.exit(3);
  console.error("preflight ok: release " + rec.id + ", runtime " + buildId + ", " + (sn.snapshots ?? []).length + " snapshots");
  console.log([rec.id, ...files].join("\n"));
')
RELEASE_ID=$(printf '%s\n' "$PLAN" | head -n 1)
SNAPZ_FILES=$(printf '%s\n' "$PLAN" | tail -n +2)

# The release must already be in R2: its owner uploads it (a read; DRY_RUN too).
# "Not in R2" is said only when rclone could look: lsf listed nothing, or
# exited 3/4 (rclone's directory/file not found). Any other failure (no
# qed64-r2 remote, expired credentials, no network, an R2 5xx) is not an
# answer, and is reported as such, before any write: "unreadable" is never
# taken for "absent".
r2_err=$(mktemp "${TMPDIR:-/tmp}/upload-artifacts-lsf.XXXXXX")
trap 'rm -f "$r2_err"' EXIT
# Sets LISTED to what `rclone lsf` lists for the R2 key $1 (empty: absent), or
# refuses, exit 3, when rclone could not look.
r2_lsf() {
  local rc=0
  LISTED=$(rclone lsf "qed64-r2:$BUCKET/$1" 2>"$r2_err") || rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 3 ] && [ "$rc" -ne 4 ]; then
    local first
    first=$(grep -m1 . "$r2_err" | tr -d '\r' || true)
    echo "upload-artifacts: cannot check R2 (rclone lsf exit $rc): ${first:-no error output}" >&2
    exit 3
  fi
  [ "$rc" -eq 0 ] || LISTED=""
}
r2_lsf "lean4-wasm64/$RELEASE_ID/release.json"
listed=$LISTED
if [ "$listed" != "release.json" ]; then
  echo "upload-artifacts: REFUSED: the toolchain release $RELEASE_ID is not in R2 (its owner uploads it: lean4-wasm64 formats/HOSTING.md)" >&2
  exit 3
fi

run() {
  if [ "${DRY_RUN:-}" = 1 ]; then echo "would run: $*"; else "$@"; fi
}

# The snapshots: each .snapz the index names, then each overlay directory whole (its own index.json
# with it, as before; local per-build copies are never sent). Nothing else: a .snapz in
# public/snapshots/ that the index does not name (an older bake) is not sent. set -e: a failed copy
# stops the upload there. --s3-no-check-bucket: an object-scoped R2 token may not create buckets,
# and a single-file copyto otherwise tries to (403 AccessDenied on CreateBucket).
while IFS= read -r f; do
  [ -n "$f" ] || continue
  run rclone copyto "public/snapshots/$f" "qed64-r2:$BUCKET/snapshots/$f" --checksum --s3-chunk-size 64M --s3-no-check-bucket --progress
done <<< "$SNAPZ_FILES"
for d in public/snapshots/*/; do
  [ -d "$d" ] || continue
  o=$(basename "$d")
  run rclone copy "public/snapshots/$o" "qed64-r2:$BUCKET/snapshots/$o" --exclude 'index.*.json' --exclude 'profiles-index.*.json' --checksum --transfers 4 --s3-chunk-size 64M --progress
done

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "dry run: nothing uploaded"
  exit 0
fi
echo "snapshot upload complete; nothing a visitor sees has changed. Next: push main (one deploy switches the shell, the record and both indexes; its guard checks these .snapz on the live origin). A sample:"
rclone ls "qed64-r2:$BUCKET/snapshots" | head -3 || true
