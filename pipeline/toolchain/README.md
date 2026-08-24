# Toolchain pipeline: rebuilding the wasm64 Lean runtime

The app consumes runtime `wasm64-02e0ac24cced25d8` by digest. This directory
records how to rebuild an equivalent runtime from source, following the
build contract proven by the wasm64 spike (Emscripten 6.0.5, Node 26,
2,308-module `import Lean` proof passing under LP64).

## Source

Fork `cauli/lean4`, branch `reinstate-wasm` (Lean 4.33.0-pre), plus the
wasm64 patch set (15 files, +78/−307) summarized in `PATCHES.md`. The patch
set's load-bearing pieces are all documented with rationale; apply them as
reviewable commits, not a blob.

## Build contract

```text
docker image : emscripten/emsdk:6.0.5 (pin by digest in CI)
stage0       : native 64-bit (host x86-64/arm64) — replaces the old i386 stage0
configure    : emcmake cmake ../../src
                 -DCMAKE_C_FLAGS=-m64 -DCMAKE_CXX_FLAGS=-m64
                 -DUSE_GMP=OFF -DMMAP=OFF -DUSE_MIMALLOC=OFF
                 -DSTAGE1_LEAN_PLATFORM_TARGET=wasm64-unknown-emscripten
memory       : -sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=17179869184
                 (the module's declared maximum MUST equal what the worker
                  imports; a smaller-linked module rejects a larger memory)
link         : -pthread -sMAIN_MODULE=2 -sALLOW_MEMORY_GROWTH=1
                 -sDISABLE_EXCEPTION_CATCHING=0   # JS exceptions; -fwasm-exceptions
                                                  # miscompiles this tree on emsdk 6
                 -sEXPORTED_FUNCTIONS=@emscripten-exports.txt (regenerated, 64-bit universe)
```

## Steps (verified end to end 2026-08-20)

```sh
cd pipeline/toolchain/work

# 0. Sources: clone the fork and apply the series
git clone --depth 1 --branch reinstate-wasm https://github.com/cauli/lean4.git lean4
git -C lean4 am ../../patches/*.patch     # 10 commits; tree 73573e1e…

# 1-5. Image, configure, stage0+stage1, link (≈45-90 min on 14 cores)
pipeline/toolchain/build.sh          # docker build → configure-qed64.sh → stage1-configure
                    # → stage1 libs → lean link
# If the link stops at libleaninitialize.a (fresh build trees lack the
# target), or to embed the githash correctly (git safe.directory inside
# the container), run:
pipeline/toolchain/finish.sh

# 6. Node quirk: the artifact must carry a CJS marker when it lives inside
# an ESM package (Emscripten pthread workers load lean.js as CommonJS)
printf '{ "type": "commonjs" }
' > build/stage1/bin/package.json

# 7. Gate — numBits, proofs, persistent path, THE PARSE GATE
node ../gate.mjs --artifact build/stage1

# 8. Ship
node ../chunk-runtime.mjs --bin build/stage1/bin --revision "$(git -C lean4 rev-parse HEAD)+qed64.1"
node ../../snapshot/bake-snapshot.mjs --artifact build/stage1   # rebake: snapshots are function-table-keyed
```

## Release gates (all mandatory)

1. `wasm-validate` passes on the optimized module (O3, not just O1).
2. Node smoke: `#eval System.Platform.numBits` = 64 + an `rfl` proof, exit 0.
3. The 88k-export list regenerated from the 64-bit symbol universe and diffed
   against the previous release (unexpected removals block).
4. A real-browser proof through the app's own worker before any deploy.
5. Never embed an empty githash: build from a normal clone, not a bare worktree.
