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
# refused unless the shell's runtime manifest, every snapshot and the profile
# index are that release's runtime (buildId) and the release is already in R2.
#
# PINNED INDEXES (HARDENING #64). snapshots/index.json and profiles/index.json
# are MUTABLE: this upload replaces them while the deployed shell is still
# paired with the previous runtime, until the push deploys the new one. So it
# also uploads, FIRST, the per-build copies a shell reads instead of them
# when they name another runtime (lib/qed64-boot.ts), straight from the two
# mutable files:
#   public/snapshots/index.json  → snapshots/index.<buildId>.json
#   public/profiles/index.json   → snapshots/profiles-index.<buildId>.json
# (both under snapshots/, which every Worker leaves to the site). A shell
# pinned to another runtime reads that runtime's copies, which this upload
# never writes: local copies in public/snapshots/ (the promote's,
# fetch-artifacts') are excluded from the directory copy. And before anything
# else it pins what R2 serves NOW: when R2's mutable index names another
# runtime and that runtime has no copy in R2 yet (the first upload after this
# change, or a copy lost), it is copied there inside R2 first, so the shell
# deployed with it keeps its pairing through this upload. That pin fails
# closed: an R2 read that fails (not an absent index: an error) refuses, exit
# 3, before any write, rather than replace an unpinned pairing. Upload-then-deploy
# is therefore invisible to every deployed shell that reads the copies: one
# built from this change on. A shell deployed BEFORE this change reads only
# the mutable files and still sees the new pairing until the deploy (once).
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
  // The per-build copy of the profile index is named by this runtime, so it must pair with it.
  const pi = JSON.parse(fs.readFileSync("public/profiles/index.json", "utf8"));
  const piRuntime = pi.runtime && pi.runtime.buildId;
  if (piRuntime !== buildId) fail("public/profiles/index.json is for runtime " + (piRuntime || "(none recorded)") + ", the toolchain release " + rec.id + " is " + buildId);
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
# qed64-r2 remote, expired credentials, no network, an R2 5xx) is not an
# answer, and is reported as such, before any write; step (1) below reads R2
# the same way, so it never mistakes "unreadable" for "absent".
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

# The preflight checked it is the release's runtime.
BUILD_ID=$(node -p 'JSON.parse(require("fs").readFileSync("public/runtime/runtime-manifest.json","utf8")).buildId')

# The one runtime the index JSON on stdin names (a snapshot index's entries,
# or a profile index's runtime.buildId), or nothing (unparseable, mixed, none).
index_runtime() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const ids = new Set(Array.isArray(j.snapshots) ? j.snapshots.map((e) => e && e.runtime) : [j.runtime && j.runtime.buildId]);
        const [id] = ids;
        if (ids.size === 1 && /^wasm64-[0-9a-f]{16}$/.test(String(id))) console.log(id);
      } catch {}
    });'
}

# 1. Pin what R2 serves now (reads, then a copy inside R2 only when needed;
# DRY_RUN reads and prints the copy). Never overwrites an existing copy.
# Fails CLOSED: this is the only step that makes the deployed pairing's copies
# when they are absent (the first upload after HARDENING #64), so a read that
# fails (lsf or cat: a 5xx, throttling, a dropped connection) refuses, exit 3,
# and every read comes before the first write, so a refusal writes nothing.
# Only an index R2 does not list is "absent"; one it lists must be read. A
# body read in full that names no single runtime (unparseable, mixed, none)
# pins nothing, as there is nothing to pin.
pins=()
for pair in snapshots/index.json:snapshots/index profiles/index.json:snapshots/profiles-index; do
  src=${pair%%:*}
  r2_lsf "$src"
  [ "$LISTED" = "$(basename "$src")" ] || continue
  cat_rc=0
  body=$(rclone cat "qed64-r2:$BUCKET/$src" 2>"$r2_err") || cat_rc=$?
  if [ "$cat_rc" -ne 0 ]; then
    first=$(grep -m1 . "$r2_err" | tr -d '\r' || true)
    echo "upload-artifacts: cannot check R2 (rclone cat $src exit $cat_rc): ${first:-no error output}" >&2
    exit 3
  fi
  live=$(printf '%s' "$body" | index_runtime)
  [ -n "$live" ] && [ "$live" != "$BUILD_ID" ] || continue
  dst="${pair#*:}.$live.json"
  r2_lsf "$dst"
  [ "$LISTED" = "$(basename "$dst")" ] && continue
  echo "upload-artifacts: R2's $src is runtime $live, which has no $dst yet: copying it there first (HARDENING #64)" >&2
  pins+=("$src:$dst")
done
for pin in ${pins[@]+"${pins[@]}"}; do
  run rclone copyto "qed64-r2:$BUCKET/${pin%%:*}" "qed64-r2:$BUCKET/${pin#*:}" --s3-no-check-bucket
done

# 2. This runtime's per-build copies, from the mutable files' own bytes, before
# the mutable files change. --s3-no-check-bucket: an object-scoped R2 token may
# not create buckets, and a single-file copyto otherwise tries to (403
# AccessDenied on CreateBucket).
run rclone copyto public/snapshots/index.json "qed64-r2:$BUCKET/snapshots/index.$BUILD_ID.json" --checksum --s3-no-check-bucket
run rclone copyto public/profiles/index.json "qed64-r2:$BUCKET/snapshots/profiles-index.$BUILD_ID.json" --checksum --s3-no-check-bucket

# 3. The snapshots and the mutable files. No local per-build copy is sent: R2's
# are written by step 2 (this runtime) and step 1 (absent ones) only. (A local
# copy would add nothing here: step 2 already sends this runtime's bytes, and
# an older runtime's local copy must never overwrite R2's. bake-snapshot still
# writes index.<buildId>.json into its --out for a consumer whose own upload
# copies a baked snapshots dir as it is: there the copy is what pins its
# deployed page, HARDENING #64.)
run rclone copy public/snapshots "qed64-r2:$BUCKET/snapshots" --exclude 'index.*.json' --exclude 'profiles-index.*.json' --checksum --transfers 4 --s3-chunk-size 64M --progress
run rclone copyto public/profiles/index.json "qed64-r2:$BUCKET/profiles/index.json" --checksum --s3-no-check-bucket

if [ "$LEGACY_ROOT" = 1 ]; then
  # Immutable, digest-named copy of the manifest at the root ("atomic
  # promotes" in docs/DEPLOY.md), as before decision 3; the release carries
  # its own runtime/runtime-manifest.<buildId>.json. Gitignored.
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
