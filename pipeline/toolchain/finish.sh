#!/bin/bash
# Finish the clean-room build: fix the container-side githash embedding
# (git safe.directory), reconfigure so LEAN_GITHASH lands, build the missing
# leaninitialize archive, and complete the lean link.
set -euo pipefail
W="$(cd "$(dirname "$0")/work" && pwd)"
IMG=qed64-toolchain:emsdk-6.0.5
run() {
  docker run --rm \
    -v "$W/lean4":/lean4 \
    -v "$W/build":/build \
    -v "$W/ccache":/root/.ccache \
    -e EM_COMPILER_WRAPPER=ccache \
    "$IMG" bash -lc "git config --global --add safe.directory /lean4 && $1"
}
echo "=== githash sanity inside container ==="
run "cd /lean4 && git rev-parse HEAD"
echo "=== reconfigure (embeds githash) ==="
run "/lean4/docker-wasm64/configure-qed64.sh"
run "make -C /build stage1-configure -j12"
echo "=== leaninitialize + final link ==="
run "make -C /build/stage1 leaninitialize -j12"
run "make -C /build/stage1 lean -j12"
ls -la "$W/build/stage1/bin/" | grep -E "lean\.(js|wasm)"
echo "FINISH COMPLETE"
