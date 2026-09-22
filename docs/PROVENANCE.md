# Artifact provenance

Everything the browser executes or mounts arrives through a digest chain:

```
runtime-manifest.json ──sha256──► lean.js/lean.wasm chunks (10) ──whole-file sha256──► importScripts
profile manifest      ──sha256──► gzip transport parts (8+60) ──gunzip──► raw pack
                                    │                                        │
                                    └── byteLength + part digests            └── raw digest re-derived
                                        verified in-browser                      by verify-release (CI)
```

| Artifact | Identity | Source |
|---|---|---|
| **Runtime `wasm64-7a2879deebfbc2c7` (served)** | lean.wasm `7a2879de…` | QED64 clean-room build: `cauli/lean4@5732b84` + the 17-patch series (embedded githash matches HEAD of `work/lean4`). Adds 0016 (replay-control flags on `lean_wasm_load_snapshot_mem`) and 0017 (interpreter dlsym probes gated on the wasm export table — the ~100× snapshot-load fix). Emscripten 6.0.5 Docker, full gate incl. THE PARSE GATE |
| Runtime `wasm64-b33e19ecb8121edc` (previous) | lean.wasm `b33e19ec…` | 15-patch series (adds 0014 stage telemetry + streamed init progress, 0015 multi-arch emsdk image); superseded by the dlsym-gate build |
| Runtime `wasm64-2c197d38d7fbe922` (previous) | lean.wasm `2c197d38…` | 13-patch series; first umbrella-capable runtime, superseded by the telemetry build |
| Runtime `wasm64-bc6ede1a5ed48460`, `wasm64-f0a78c3352dff1a0` (interim, dev only) | — | Same series at patches 0011 and 0012 respectively; gate-passed, used to bake and validate the umbrella under Node, superseded |
| Runtime `wasm64-3d1f8042960a65a9` (interim, dev only) | lean.wasm `3d1f8042…` (105,927,492 B) | Same series + a 128 MB main-stack patch that chased a misdiagnosed crash; gate-passed and briefly served on the dev server, never baked against, superseded |
| **Runtime `wasm64-36a96239e08fd2e0` (served, Lean 4.34.0)** | lean.js `dc8a8dc0…` (48,971,105 B), lean.wasm `36a96239…` (109,869,533 B) | `FawadHa1der/lean4@8d91aadcda` on `qed64-wasm64` = upstream `v4.34.0` merged over the wasm64 series (resident transport 0031, resolver 0032, pump entry points retired 0033; exports generated as boxed ∪ initializers ∪ cells); built in the kernel repo's own `wasm64-build/` lane, gate 4/4; imported by `pipeline/release/import-packs.sh` on 2026-09-21 |
| Runtime `wasm64-c645477e817ac857` (previous, Lean 4.33.0-pre) | lean.wasm `c645477e…` (105,449,148 B) | series through 0033 on `cauli/lean4@5732b84`; the last 4.33 pairing |
| `lean-core` (4.34.0) | pack `1c5c75db…` (390,065,102 B), 649 modules × 5 facets | the runtime's own `stage1/lib/lean` (Init closure), packed by the import lane; native64 core facets verified byte-identical to it (12,592/12,592, header excepted) |
| `mathlib-essential` (4.34.0) | pack `eeab078f…` (3,568,001,947 B), 4,354 modules | Mathlib `5ed2965` (tag `v4.34.0`) + its Lake deps + the kernel's `Lean`/`Std`: closure of `Manifold.IsManifold.Basic`, `Manifold.Instances.Sphere`, `SpecialFunctions.Complex.Circle`, `Lean`, `Std`, plus the 80 `deprecated_module` shims whose imports are inside that closure (so pre-2026-08 module names still resolve); built natively by the same kernel commit configured as `wasm64-unknown-emscripten`/`USE_GMP=OFF` |
| `mathlib-game-extra` (4.34.0, lean4game only, not served here) | pack `7252fb7e…` (656,766,956 B), 737 modules | closure of the game's tactic roots minus essential minus Init; staged beside the profiles, consumed by the lean4game port |
| Snapshots (4.34.0) | init `22072ed1…` (122,364,149 B raw), mathlib `b6e7f7d0…` (1,127,273,069 B raw) | slim bakes (no `*.olean.private`) of the packs above against `wasm64-36a96239e08fd2e0`; the umbrella imports all 4,354 essential modules incl. the shims |
| Runtime `wasm64-189b7d28d16f62d5` (previous) | lean.js `008adf61…` (48,089,166 B), lean.wasm `189b7d28…` (105,927,487 B) | QED64 clean-room build: `cauli/lean4@5732b84` + the 10-patch series (tree `73573e1e…`; the binary embeds pre-rebase commit `26ee909`, whose tree is identical). Emscripten 6.0.5 Docker, full gate incl. THE PARSE GATE, accepted in the live pane |
| Runtime `wasm64-02e0ac24cced25d8` (previous) | lean.js `032ea876…` (48,089,166 B), lean.wasm `b7ae8a6b…` (105,923,507 B) | Browser64 workspace, accepted in real Chromium (629-module and 4,821-module proof gates); restorable via `sync:artifacts` |
| `lean-core` | pack `9f17a688…` (388,523,072 B), 629 modules × 5 facets | same producer, native64 artifacts of the exact fork revision |
| `mathlib-essential` | pack `642cf207…` (3,492,342,248 B), 4,192 modules | same producer, Mathlib `de3a9cf` + pinned compat patch |

Toolchain identity (served): Lean `4.34.0`, target `wasm64-unknown-emscripten`,
source `FawadHa1der/lean4@8d91aadcda` (`qed64-wasm64`, upstream `v4.34.0` +
the wasm64 series), `USE_GMP=OFF`, `USE_MIMALLOC=OFF`. Before 2026-09-21:
Lean `4.33.0-pre`, `cauli/lean4@5732b84bb744…+browser64.1`. Profiles are
only compatible with this exact triple — native x86-64 oleans or a rebuilt
runtime with a different function table must ship their own packs/snapshots.

`npm run sync:artifacts` re-verifies every byte against these manifests during
the copy; `npm run verify:release` re-derives the raw pack digests the browser
cannot stream-compute. Trust therefore never rests on file paths or names —
only on digests recorded in manifests served from the same origin.
