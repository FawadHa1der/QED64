#!/usr/bin/env bash
# The kernel pairing bump, end to end, in the order that keeps KERNEL-PIN's
# invariant (snapshots are binary-paired to one runtime; served together or
# not at all). Run from the qed64 root after the fork commit is in place.
#
#   pipeline/release/bump-chain.sh stage     # build → finish → gate → chunk → slim trees → bake both (staged)
#   pipeline/release/bump-chain.sh promote   # promote the staged pairing + verify:release (after the pyramid)
#
# Between the two: point public/snapshots-0031 at work/staging/<id>/snapshots,
# restart the dev server, run tests/adversarial/resident-gate.sh and the
# gauntlets against tests/adversarial/resident-url.sh, and write KERNEL-PIN.
# Bakes use the SLIM trees (no *.olean.private) — the 0032/0033 pairings were
# baked that way (docs/SERVER-SLIM-REBAKE.md); a full-tree bake is 2.5x larger.
set -u
Q=$(cd "$(dirname "$0")/../.." && pwd); cd "$Q"
stage() { echo "== $1 == $(date +%H:%M:%S)"; }
fail() { echo "BUMP-FAIL $1"; exit 1; }
id() { echo "wasm64-$(shasum -a 256 pipeline/toolchain/work/build/stage1/bin/lean.wasm | cut -c1-16)"; }
case "${1:-}" in
  stage)
    stage "build";  pipeline/toolchain/build.sh  > pipeline/toolchain/work/build-bump.log 2>&1  || fail "build (pipeline/toolchain/work/build-bump.log)"
    stage "finish"; pipeline/toolchain/finish.sh > pipeline/toolchain/work/finish-bump.log 2>&1 || fail "finish (pipeline/toolchain/work/finish-bump.log)"
    ID=$(id); echo "buildId=$ID"
    stage "gate";   node --stack-size=8192 pipeline/toolchain/gate.mjs --artifact pipeline/toolchain/work/build/stage1 > work/gate-bump.log 2>&1 || { grep -E "^(FAIL| ok)" work/gate-bump.log; fail "gate"; }
    grep -E "^(FAIL| ok)" work/gate-bump.log
    stage "chunk";  node pipeline/toolchain/chunk-runtime.mjs --bin pipeline/toolchain/work/build/stage1/bin > work/chunk-bump.log 2>&1 || fail "chunk (work/chunk-bump.log)"
    stage "slim trees"
    rsync -a --delete --exclude='*.olean.private' --link-dest="$PWD/work/lib-tree" work/lib-tree/ work/lib-tree-slim/ || fail "rsync lib-tree-slim"
    rsync -a --delete --exclude='*.olean.private' --link-dest="$PWD/pipeline/toolchain/work/build/stage1/lib/lean" pipeline/toolchain/work/build/stage1/lib/lean/ work/core-lib-slim/ || fail "rsync core-lib-slim"
    rm -f "work/staging/$ID/snapshots/"*.snapz "work/staging/$ID/snapshots/index.json"
    stage "bake init";    npm run bake:snapshot -- --name init    --lib work/core-lib-slim --reserve 1073741824 --artifact pipeline/toolchain/work/build/stage1 > work/bake-bump-init.log 2>&1 || fail "bake init (work/bake-bump-init.log)"
    stage "bake mathlib"; npm run bake:snapshot -- --name mathlib --lib work/lib-tree-slim --reserve 3221225472 --probe 'import QED64.Essential' --artifact pipeline/toolchain/work/build/stage1 > work/bake-bump-mathlib.log 2>&1 || fail "bake mathlib (work/bake-bump-mathlib.log)"
    grep -hE "^baked" work/bake-bump-init.log work/bake-bump-mathlib.log | cut -c1-200
    echo "BUMP-STAGED $ID — next: symlink, pyramid, KERNEL-PIN, then '$0 promote'";;
  promote)
    ID=$(id); echo "buildId=$ID"
    [ -f "work/staging/$ID/snapshots/index.json" ] || fail "no staged snapshots for $ID"
    stage "promote"; node pipeline/release/promote-staging.mjs --staging "work/staging/$ID" > work/promote-bump.log 2>&1 || { tail -20 work/promote-bump.log; fail "promote"; }
    tail -3 work/promote-bump.log
    stage "verify:release"; npm run verify:release > work/verify-bump.log 2>&1 || { tail -20 work/verify-bump.log; fail "verify:release"; }
    tail -2 work/verify-bump.log
    echo "BUMP-PROMOTED $ID — commit public/ + KERNEL-PIN; the user uploads artifacts (scripts/upload-artifacts.sh) and pushes";;
  *) echo "usage: $0 stage|promote"; exit 2;;
esac
