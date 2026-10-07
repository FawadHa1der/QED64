# Artifact provenance

Everything the browser executes or mounts arrives through a digest chain:

```
runtime-manifest.json ──sha256──► lean.js/lean.wasm chunks (3 + 7) ──whole-file sha256──► importScripts
profile manifest      ──sha256──► gzip transport parts (8 + 61) ──gunzip──► raw pack
                                    │                                         │
                                    └── byteLength + part digests             └── raw digest re-derived
                                        verified in-browser                       by verify-release
snapshot index        ──sha256──► <name>.<digest16>.snapz ──runtime field──► refused unless it names the served buildId
```

## Where the served pairing comes from

QED64 compiles nothing. The served runtime and the two served library packs
are a release of the Lean fork, pinned by the record
`toolchain/lean4-wasm64-release.json`, which is a byte copy of that release's
`release.json` (schema `lean4-wasm64.release/v1`). The snapshots are QED64's
own bakes against that runtime. Four tracked files hold the whole identity:

- `toolchain/lean4-wasm64-release.json`: the release id, its digest,
  `kernel.commit` and `kernel.patch`, `runtime.buildId`, and every pack's raw
  digest.
- `public/runtime/runtime-manifest.json` and `public/profiles/*.json`: every
  chunk and transport part of the runtime and the packs, by sha256.
- `public/snapshots/index.json`: every snapshot's digest and the `runtime`
  that baked it.
- `embedding/base-tree.json` (`qed64.base-tree/v1`): the olean trees the
  snapshots were baked from (per-tree pack ids, raw digests, the umbrella
  module's bytes and the tree digests).

| Served from this landing on (lean-v4.34.0-41ec565, adopted 2026-10-06) | Identity | Source |
|---|---|---|
| **Release** | `lean-v4.34.0-41ec565`, digest `sha256:f958ba75…` | GitHub release on FawadHa1der/lean4, mirrored in R2 at `lean4-wasm64/lean-v4.34.0-41ec565/` (docs/DEPLOY.md "The toolchain release prefix") |
| **Kernel** | `FawadHa1der/lean4@41ec56530df541dcfb1d612a876fdc992d7ab8f5`, branch `qed64-wasm64`, patch level `0036` (the deep-recursion fix, HARDENING #60) | upstream `v4.34.0` with the wasm64 series (the series is the fork's `wasm64-build/PATCHES.md`); its release gate passed 16/16 checks on this commit, the three deep-recursion checks included |
| **Runtime `wasm64-57ae00dc5f6ce958`** | lean.js `e0b8397a…` (48,973,198 B, 3 chunks), lean.wasm `57ae00dc…` (109,877,359 B, 7 chunks) | the release's `runtime/`, byte-identical to the served chunks; the buildId is `wasm64-` + the first 16 hex of sha256(lean.wasm) |
| `lean-core` (4.34.0) | pack release `lean-core-4.34.0-wasm64-36a96239e08fd2e0`, raw `1c5c75db…` (390,065,102 B), 649 modules | the release's pack, written by the v4.34.0 import's wasm compiler `8d91aadcda`; unchanged since 2026-09-22, so its name still carries that import's runtime id |
| `mathlib-essential` (4.34.0) | pack release `mathlib-essential-5ed2965-wasm64-36a96239e08fd2e0`, raw `eeab078f…` (3,568,001,947 B), 4,354 modules | Mathlib `5ed2965` (tag `v4.34.0`) and its Lake dependencies plus the kernel's `Lean`/`Std`, built natively by `857544b439`; the closure of three roots plus the 80 `deprecated_module` shims inside it, so pre-2026-08 module names still resolve |
| Snapshots | init `c185aafb…` (122,364,117 B raw), mathlib `bfda2b55…` (1,127,272,685 B raw) | slim bakes (no `*.olean.private`) against `wasm64-57ae00dc5f6ce958` by `pipeline/release/adopt-release.sh`: init from the release's `lean-lib` tree, mathlib (the `QED64.Essential` umbrella over all 4,354 essential modules) from lean-core + mathlib-essential (`embedding/base-tree.json`) |

The release also carries `lean-lib` (the runtime's own `lib/lean`, 2,520
modules, the tree the init snapshot is baked from) and `mathlib-game-extra`
(lean4game's, not served here). Toolchain identity: Lean `4.34.0`, target
`wasm64-unknown-emscripten`, `USE_GMP=OFF`, `USE_MIMALLOC=OFF`. Packs and
snapshots are only compatible with this exact triple: native x86-64 oleans,
or a rebuilt runtime with a different function table, must ship their own
packs and snapshots.

## How to verify it

- `node pipeline/release/release-manifest.mjs --commit HEAD` derives the
  `qed64.release/v1` manifest of a commit from its tracked files
  (docs/RELEASE-BUNDLE.md). It refuses, with exit 1 and a one-line reason,
  unless the record's self-digest holds and the record, the runtime manifest,
  every snapshot's `runtime`, the base tree's packs and every
  toolchain-hosted file agree. Its `toolchain` section is this page's table
  as data.
- `npm run verify:release` re-derives, from the bytes in `public/`, every
  digest the browser will trust, including the multi-GB raw packs WebCrypto
  cannot stream-compute.
- `tests/unit/toolchain-pin.test.ts` (in `npm test`) pins the record to the
  tracked manifests: the record's digest, the runtime and snapshot buildIds,
  and every Worker-routed file byte for byte.
- The release itself: `node <lean4-wasm64>/cli.mjs verify --release <release
  dir>` (the fork's package, as `pipeline/release/adopt-release.sh` runs it)
  checks a fetched release against its `release.json`, and
  `npm run fetch:artifacts -- --release <dir|url>` checks every file it takes
  from one against the release's `files[]`.

`npm run promote:staging` verifies every byte against these manifests as it
publishes (the retired `npm run sync:artifacts`, removed 2026-10, did the
same for copies from the owner's sibling checkout), and the worker
re-verifies every chunk before `importScripts`. Trust therefore never rests
on file paths or names, only on digests recorded in manifests served from the
same origin.

## Earlier served runtimes

| Runtime | Served | Kernel |
|---|---|---|
| `wasm64-3ab1c6a9da03bc29` | 2026-10-02 (QED64 3b42714) until this landing; release `lean-v4.34.0-a8817d0` (gate 13/13), snapshots init `b6d945e3…`, mathlib `265cd10c…` | `a8817d01f9`, patch 0035b |
| `wasm64-4b025db7729c5f89` | 2026-09-30 to 2026-10-01, and again for a few hours on 2026-10-02 | `9fbb45afcb`, patch 0034 (HARDENING #51) |
| `wasm64-2c18773ecfba45bb` | 2026-10-01 to 2026-10-02, withdrawn (HARDENING #53: page-reload OOM with parked threads) | `3ae65d36f9`, patch 0035 |
| `wasm64-36a96239e08fd2e0` | 2026-09-22 to 2026-09-30, the first Lean 4.34.0 pairing (packs cut then, still served) | `8d91aadcda` |
| `wasm64-c645477e817ac857` | 2026-09-07 to 2026-09-22, the last Lean `4.33.0-pre` pairing | series through 0033 on `cauli/lean4@5732b84` |
| `wasm64-5dcdda005a7c5ae0` | 2026-09-03 to 2026-09-07 | patch 0032 on `cauli/lean4@5732b84` |

Before 2026-09-03, the runtimes were QED64's clean-room builds of
`cauli/lean4@5732b84` plus the 10- to 31-patch series, with the core and
Mathlib `de3a9cf` packs of that time. This file's git history before 2026-10
lists them with their digests.

## What Lean 4.34.0 changed for users (2026-09-22)

The playground has served Lean `4.34.0` and Mathlib at tag `v4.34.0` since
2026-09-22 (this section moved here from the README in 2026-10). Visible
differences from the earlier 4.33 pairing:

- **Module renames.** Mathlib moved its most-imported modules under
  `Mathlib.Basic.*` (`Mathlib.Data.Real.Basic` → `Mathlib.Basic.Real.Basic`,
  `Data.Complex.Basic` → `Basic.Complex.Basic`, …). The old names still
  resolve here, because the library ships upstream's deprecated shims, but a
  few were removed outright with no shim (`Mathlib.Logic.Basic` →
  `Mathlib.Basic.Logic.Basic`), exactly as on live.lean-lang.org. A header
  served from the preloaded Mathlib environment does not show upstream's
  deprecation warning for an old name.
- **`deriving Fintype` needs an option.** Upstream Lean 4.34 turned
  `backward.isDefEq.respectTransparency` on by default and Mathlib's
  `Fintype` deriving handler was not adapted, so
  `inductive Foo | a | b deriving Fintype` fails in any file
  ("Application type mismatch … `Foo.enumList.Nodup`"). Write
  `set_option backward.isDefEq.respectTransparency false in` before the
  `inductive`, as Mathlib's own tests do. Not a playground defect; the
  compiler battery pins both behaviours.
- **`norm_num` for primality** (`Nat.Prime 37`) needs
  `Mathlib.Tactic.NormNum.Prime`, which is outside the preloaded environment,
  as it was before; `decide` and `norm_num` on arithmetic are unaffected.
