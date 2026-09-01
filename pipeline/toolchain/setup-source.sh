#!/bin/bash
# Materialize the wasm64 kernel source in work/lean4 from its home repo:
# github.com/FawadHa1der/lean4, branch qed64-wasm64 (cauli's Memory64 base +
# the QED64 patch series as real git history + the wasm64-build/ tooling).
# The commit to pin lives in KERNEL-PIN next to this script.
# Idempotent-ish: refuses to touch an existing work/lean4.
set -euo pipefail
T="$(cd "$(dirname "$0")" && pwd)"
KERNEL_REPO="${QED64_KERNEL_REPO:-https://github.com/FawadHa1der/lean4}"
KERNEL_BRANCH=qed64-wasm64
PIN="$(grep -Eo '^[0-9a-f]{40}' "$T/KERNEL-PIN" | head -1)"
if [ -e "$T/work/lean4" ]; then
  echo "work/lean4 already exists — remove it first to re-materialize" >&2
  exit 1
fi
mkdir -p "$T/work"
git clone --branch "$KERNEL_BRANCH" "$KERNEL_REPO" "$T/work/lean4"
cd "$T/work/lean4"
git checkout -q "$PIN"
# Trust nothing: the checkout must land exactly on the pin, and the pin must
# be an ancestor of the branch (a hash that exists but was never on the
# branch would otherwise slip through silently).
[ "$(git rev-parse HEAD)" = "$PIN" ] || { echo "pin checkout mismatch" >&2; exit 1; }
git merge-base --is-ancestor "$PIN" "origin/$KERNEL_BRANCH"   || { echo "KERNEL-PIN $PIN is not on branch $KERNEL_BRANCH" >&2; exit 1; }
echo "source ready: $(git log --oneline -1)"
echo "REMINDER: any rebuild of stage1 requires rebaking work/snapshot/*.snap"
echo "(snapshots are binary-paired to the runtime; see docs/REBUILD.md)."
