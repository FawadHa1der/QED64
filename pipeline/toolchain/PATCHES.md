# The wasm64 patch series: moved to the Lean fork

The compiler build and its patch series belong to the Lean fork since plan step B1 (2026-10):
[FawadHa1der/lean4](https://github.com/FawadHa1der/lean4), branch `qed64-wasm64`, `wasm64-build/PATCHES.md`.

- Which patch QED64 serves: `toolchain/lean4-wasm64-release.json` → `kernel.patch` (`0035b` for lean-v4.34.0-a8817d0, `0036` for lean-v4.34.0-41ec565), with `kernel.commit` naming the exact fork commit.
- The runtime floor QED64's workers need: `embedding/closure.json` → `runtime.minKernelPatch`, compared with `comparePatchIds` (NNNN, then an optional lowercase suffix).
- The QED64-side history of this file and of the 35 patch copies that lived in `patches/` is in git (before plan B1); docs/HARDENING.md cites the patches by number.
