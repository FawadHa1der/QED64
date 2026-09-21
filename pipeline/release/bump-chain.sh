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
#
# A runtime built ELSEWHERE (a version import in its own build dir) is staged
# with `stage-artifact`, which skips build/finish, and with every tree it
# writes redirected so the served pairing's files are not touched:
#   QED64_ARTIFACT=<dir with bin/ and lib/lean>   (default pipeline/toolchain/work/build/stage1)
#   QED64_LIB_TREE=<unpacked core+Mathlib oleans> (default work/lib-tree)
#   QED64_SLIM=<dir for the two slim trees>       (default work; gives $QED64_SLIM/{core-lib-slim,lib-tree-slim})
#   QED64_SNAP_WORK=<dir for the raw .snap files> (default work/snapshot — the PAIRED set the battery and
#                                                  Node probes load; a foreign runtime MUST override it)
#   QED64_LEAN_VERSION=<x.y.z>                    (passed to chunk-runtime; its default is 4.33.0-pre)
set -u
Q=$(cd "$(dirname "$0")/../.." && pwd); cd "$Q"
ART=${QED64_ARTIFACT:-pipeline/toolchain/work/build/stage1}
LIBTREE=${QED64_LIB_TREE:-work/lib-tree}
SLIM=${QED64_SLIM:-work}
SNAPWORK=${QED64_SNAP_WORK:-work/snapshot}
LEANVER=${QED64_LEAN_VERSION:-}
stage() { echo "== $1 == $(date +%H:%M:%S)"; }
fail() { echo "BUMP-FAIL $1"; exit 1; }
id() { echo "wasm64-$(shasum -a 256 "$ART/bin/lean.wasm" | cut -c1-16)"; }
case "${1:-}" in
  stage|stage-artifact)
    if [ "$1" = stage-artifact ]; then
      [ -f "$ART/bin/lean.wasm" ] || fail "no $ART/bin/lean.wasm (set QED64_ARTIFACT)"
      if [ "$ART" != pipeline/toolchain/work/build/stage1 ] && [ "$SNAPWORK" = work/snapshot ]; then fail "a foreign artifact must set QED64_SNAP_WORK (work/snapshot is paired to the served runtime)"; fi
    else
    stage "build";  pipeline/toolchain/build.sh  > pipeline/toolchain/work/build-bump.log 2>&1  || fail "build (pipeline/toolchain/work/build-bump.log)"
    stage "finish"; pipeline/toolchain/finish.sh > pipeline/toolchain/work/finish-bump.log 2>&1 || fail "finish (pipeline/toolchain/work/finish-bump.log)"
    fi
    ID=$(id); echo "buildId=$ID"
    stage "gate";   node --stack-size=8192 pipeline/toolchain/gate.mjs --artifact "$ART" > work/gate-bump.log 2>&1 || { grep -E "^(FAIL| ok)" work/gate-bump.log; fail "gate"; }
    grep -E "^(FAIL| ok)" work/gate-bump.log
    stage "chunk";  node pipeline/toolchain/chunk-runtime.mjs --bin "$ART/bin" ${LEANVER:+--lean-version "$LEANVER"} > work/chunk-bump.log 2>&1 || fail "chunk (work/chunk-bump.log)"
    stage "slim trees"
    mkdir -p "$SLIM"; ABS() { (cd "$1" && pwd); }
    rsync -a --delete --exclude='*.olean.private' --link-dest="$(ABS "$LIBTREE")" "$LIBTREE/" "$SLIM/lib-tree-slim/" || fail "rsync lib-tree-slim"
    rsync -a --delete --exclude='*.olean.private' --link-dest="$(ABS "$ART/lib/lean")" "$ART/lib/lean/" "$SLIM/core-lib-slim/" || fail "rsync core-lib-slim"
    rm -f "work/staging/$ID/snapshots/"*.snapz "work/staging/$ID/snapshots/index.json"
    stage "bake init";    npm run bake:snapshot -- --name init    --lib "$SLIM/core-lib-slim" --reserve 1073741824 --artifact "$ART" --work "$SNAPWORK" > work/bake-bump-init.log 2>&1 || fail "bake init (work/bake-bump-init.log)"
    stage "bake mathlib"; npm run bake:snapshot -- --name mathlib --lib "$SLIM/lib-tree-slim" --reserve 3221225472 --probe 'import QED64.Essential' --artifact "$ART" --work "$SNAPWORK" > work/bake-bump-mathlib.log 2>&1 || fail "bake mathlib (work/bake-bump-mathlib.log)"
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
  *) echo "usage: $0 stage|stage-artifact|promote   (env: QED64_ARTIFACT QED64_LIB_TREE QED64_SLIM QED64_SNAP_WORK QED64_LEAN_VERSION)"; exit 2;;
esac
