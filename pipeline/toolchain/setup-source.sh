#!/bin/bash
# Materialize the patched Lean toolchain source in work/lean4: clone the
# cauli/lean4 wasm fork, pin the base revision, and apply the QED64 patch
# series. Idempotent-ish: refuses to touch an existing work/lean4.
set -euo pipefail
T="$(cd "$(dirname "$0")" && pwd)"
BASE=5732b84bb744383629568dafbb06fd2f86b8be59
if [ -e "$T/work/lean4" ]; then
  echo "work/lean4 already exists — remove it first to re-materialize" >&2
  exit 1
fi
mkdir -p "$T/work"
git clone https://github.com/cauli/lean4.git "$T/work/lean4"
cd "$T/work/lean4"
git checkout -q "$BASE"
git checkout -qb qed64-wasm64
git am "$T"/patches/*.patch
echo "source ready: $(git log --oneline -1) ($(git rev-list --count $BASE..HEAD) patches on $BASE)"
