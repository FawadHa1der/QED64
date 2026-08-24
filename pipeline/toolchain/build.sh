#!/bin/bash
# QED64 clean-room wasm64 toolchain build. Logs everything; exits nonzero on
# the first failure. Expected wall-clock on a 14-core M-series: 1.5-3 h.
set -euo pipefail
W="$(cd "$(dirname "$0")/work" && pwd)"
IMG=qed64-toolchain:emsdk-6.0.5
mkdir -p "$W/build" "$W/ccache"
echo "=== [1/5] docker image ==="
docker build -t "$IMG" "$W/lean4/docker-wasm64"
run() {
  docker run --rm \
    -v "$W/lean4":/lean4 \
    -v "$W/build":/build \
    -v "$W/ccache":/root/.ccache \
    -e EM_COMPILER_WRAPPER=ccache \
    "$IMG" bash -lc "$1"
}
echo "=== [2/5] configure (outer) ==="
run "/lean4/docker-wasm64/configure-qed64.sh"
echo "=== [3/5] stage1-configure (builds native stage0 first) ==="
run "make -C /build stage1-configure -j12"
echo "=== [4/5] stage1 libraries ==="
run "make -C /build/stage1 libuv leanrt leanrt_initial-exec leancpp leanshell kernel library -j12"
echo "=== [5/5] final lean link ==="
run "make -C /build/stage1 lean -j12"
ls -la "$W/build/stage1/bin/" | grep -E "lean\.(js|wasm)"
echo "BUILD COMPLETE"
