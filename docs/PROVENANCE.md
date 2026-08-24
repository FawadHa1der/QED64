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
| **Runtime `wasm64-b33e19ecb8121edc` (served)** | lean.wasm `b33e19ec…` | QED64 clean-room build: `cauli/lean4@5732b84` + the 14-patch series (embedded githash matches HEAD of `work/lean4`). Adds 0014: snapshot-load stage telemetry + per-module init progress streamed through the blocking load. Emscripten 6.0.5 Docker, full gate incl. THE PARSE GATE |
| Runtime `wasm64-2c197d38d7fbe922` (previous) | lean.wasm `2c197d38…` | 13-patch series; first umbrella-capable runtime, superseded by the telemetry build |
| Runtime `wasm64-bc6ede1a5ed48460`, `wasm64-f0a78c3352dff1a0` (interim, dev only) | — | Same series at patches 0011 and 0012 respectively; gate-passed, used to bake and validate the umbrella under Node, superseded |
| Runtime `wasm64-3d1f8042960a65a9` (interim, dev only) | lean.wasm `3d1f8042…` (105,927,492 B) | Same series + a 128 MB main-stack patch that chased a misdiagnosed crash; gate-passed and briefly served on the dev server, never baked against, superseded |
| Runtime `wasm64-189b7d28d16f62d5` (previous) | lean.js `008adf61…` (48,089,166 B), lean.wasm `189b7d28…` (105,927,487 B) | QED64 clean-room build: `cauli/lean4@5732b84` + the 10-patch series (tree `73573e1e…`; the binary embeds pre-rebase commit `26ee909`, whose tree is identical). Emscripten 6.0.5 Docker, full gate incl. THE PARSE GATE, accepted in the live pane |
| Runtime `wasm64-02e0ac24cced25d8` (previous) | lean.js `032ea876…` (48,089,166 B), lean.wasm `b7ae8a6b…` (105,923,507 B) | Browser64 workspace, accepted in real Chromium (629-module and 4,821-module proof gates); restorable via `sync:artifacts` |
| `lean-core` | pack `9f17a688…` (388,523,072 B), 629 modules × 5 facets | same producer, native64 artifacts of the exact fork revision |
| `mathlib-essential` | pack `642cf207…` (3,492,342,248 B), 4,192 modules | same producer, Mathlib `de3a9cf` + pinned compat patch |

Toolchain identity: Lean `4.33.0-pre`, target `wasm64-unknown-emscripten`,
source `cauli/lean4@5732b84bb744…+browser64.1`, `USE_GMP=OFF`. Profiles are
only compatible with this exact triple — native x86-64 oleans or a rebuilt
runtime with a different function table must ship their own packs/snapshots.

`npm run sync:artifacts` re-verifies every byte against these manifests during
the copy; `npm run verify:release` re-derives the raw pack digests the browser
cannot stream-compute. Trust therefore never rests on file paths or names —
only on digests recorded in manifests served from the same origin.
