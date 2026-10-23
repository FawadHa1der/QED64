# Artifact provenance

Everything the browser executes or mounts arrives through a digest chain:

```
runtime-manifest.json ──sha256──► lean.js/lean.wasm chunks (1 + 7) ──whole-file sha256──► importScripts
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

| Served from this landing on (lean-v4.35.0-b081e7c, adopted 2026-10-23) | Identity | Source |
|---|---|---|
| **Release** | `lean-v4.35.0-b081e7c`, digest `sha256:5450ccc0…`, a full release (its own runtime, packs, native64 and lists) | GitHub release on FawadHa1der/lean4, mirrored in R2 at `lean4-wasm64/lean-v4.35.0-b081e7c/` (docs/DEPLOY.md "The toolchain release prefix") |
| **Kernel** | `FawadHa1der/lean4@b081e7c041da4490f997ec18ccb9b9ea38f5f68f`, branch `qed64-wasm64`, patch level `0042` (a `module` file served from a shared environment sees every loaded module publicly, and imports run at the `.server` level, so imported docstrings load; on top of 0041, 0040's native Wasm exceptions, legacy encoding, and the series before) | upstream `v4.35.0` with the wasm64 series (the fork's `wasm64-build/PATCHES.md`); its release gate passed 61/61 checks on this commit |
| **Runtime `wasm64-36d7f415704473d9`** | lean.js `8ab11236…` (120,123 B, 1 chunk), lean.wasm `36d7f415…` (106,157,611 B, 7 chunks) | the release's `runtime/`, byte-identical to the served chunks; the buildId is `wasm64-` + the first 16 hex of sha256(lean.wasm) |
| `lean-core` (4.35.0) | pack release `lean-core-4.35.0-wasm64-36d7f415704473d9`, raw `8aca4fa4…` (385,478,334 B), 653 modules | the release's pack, cut from the v4.35.0 import's build |
| `mathlib-essential` (4.35.0) | pack release `mathlib-essential-56a0058-wasm64-36d7f415704473d9`, raw `c064bea4…` (3,597,650,667 B), 4,438 modules | Mathlib `56a0058` (tag `v4.35.0`) and its Lake dependencies plus the kernel's `Lean`/`Std`, built natively by the import; the closure of its roots plus the 82 `deprecated_module` shims inside it |
| Snapshots | init `81276a74…` (116,893,325 B raw, 31,719,003 B download), mathlib `79936198…` (1,114,335,677 B raw, 319,645,483 B download) | slim bakes (no `*.olean.private`) against `wasm64-36d7f415704473d9` by `pipeline/release/adopt-release.sh`: init from the release's `lean-lib` tree, mathlib (the `QED64.Essential` umbrella over all 4,438 essential modules, rebuilt for this release as one legacy `.olean`, HARDENING #79) from lean-core + mathlib-essential (`embedding/base-tree.json`); the slim audit is recorded in docs/SERVER-SLIM-REBAKE.md |

The release also carries `lean-lib` (the runtime's own `lib/lean`, 2,546
modules, the tree the init snapshot is baked from) and `mathlib-game-extra`
(lean4game's, not served here). Toolchain identity: Lean `4.35.0`, target
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
| `wasm64-5650321f3f58aeb0` | 2026-10-16 (QED64 d1646ae, adopted 2026-10-15) until this landing; release `lean-v4.34.0-53cb11e` (gate 56/56), a runtime release by reference of `lean-v4.34.0-e1a79c1`, snapshots init `ecf69553…`, mathlib `b1ffb871…` | `53cb11e6d6`, patch 0041 |
| `wasm64-086ef19b1135d43b` | the lean-v4.34.0-64d6ebb landing (feature/adopt-64d6ebb 2708239, 2026-10-13), withdrawn before deploy: since kernel 0039 Binaryen had folded `lean_apply_16` and `lean_apply_m` into `lean_apply_n` and the proof sheets' bake died of it (HARDENING #71; fixed by 0041, the lean-v4.34.0-53cb11e landing); snapshots init `ecf69553…`, mathlib `b1ffb871…` | `64d6ebb7b4`, patch 0040 |
| `wasm64-f69cca24d0878a58` | 2026-10-08 (QED64 fc945e4, adopted 2026-10-07; live with the 8c461a8 push) until 2026-10-16 (the 53cb11e landing); release `lean-v4.34.0-e1a79c1` (gate 33/33), snapshots init `fcbe485f…`, mathlib `6ca0fa64…` | `e1a79c1ce9`, patch 0037 |
| `wasm64-57ae00dc5f6ce958` | the lean-v4.34.0-41ec565 landing (feature/land-41ec565), superseded by e1a79c1's; snapshots init `c185aafb…`, mathlib `bfda2b55…` | `41ec56530d`, patch 0036 |
| `wasm64-3ab1c6a9da03bc29` | 2026-10-02 (QED64 3b42714) until 2026-10-08 (e1a79c1's landing); release `lean-v4.34.0-a8817d0` (gate 13/13), snapshots init `b6d945e3…`, mathlib `265cd10c…` | `a8817d01f9`, patch 0035b |
| `wasm64-4b025db7729c5f89` | 2026-09-30 to 2026-10-01, and again for a few hours on 2026-10-02 | `9fbb45afcb`, patch 0034 (HARDENING #51) |
| `wasm64-2c18773ecfba45bb` | 2026-10-01 to 2026-10-02, withdrawn (HARDENING #53: page-reload OOM with parked threads) | `3ae65d36f9`, patch 0035 |
| `wasm64-36a96239e08fd2e0` | 2026-09-22 to 2026-09-30, the first Lean 4.34.0 pairing (packs cut then, still served) | `8d91aadcda` |
| `wasm64-c645477e817ac857` | 2026-09-07 to 2026-09-22, the last Lean `4.33.0-pre` pairing | series through 0033 on `cauli/lean4@5732b84` |
| `wasm64-5dcdda005a7c5ae0` | 2026-09-03 to 2026-09-07 | patch 0032 on `cauli/lean4@5732b84` |

Before 2026-09-03, the runtimes were QED64's clean-room builds of
`cauli/lean4@5732b84` plus the 10- to 31-patch series, with the core and
Mathlib `de3a9cf` packs of that time. This file's git history before 2026-10
lists them with their digests.

## What Lean 4.35.0 changed for users (2026-10-23)

The landing of lean-v4.35.0-b081e7c serves Lean `4.35.0` and Mathlib at tag
`v4.35.0` (`56a0058`). Visible differences from the 4.34 pairing:

- **`module` files work.** A buffer that starts with `module` sees its
  `public import`s (and Init, with no import at all), and `public meta
  import` with `public meta def` elaborates; on 4.34 every one failed with
  "Unknown identifier … imported privately" (HARDENING #80, kernel 0042).
  What such a buffer sees publicly is a superset of stock Lean's: every
  module the session's environment loaded counts as public.
- **Hovers show docstrings** of imported declarations (`List.map`,
  `Finset.sum`, …); on 4.34 a hover showed the signature and the defining
  module only. Go-to-definition still finds nothing for an imported name:
  no `.lean` sources are served.
- **Messages move toward stock**: `@[inherit_doc X]` no longer warns about a
  missing docstring, and doc commands see imported docstrings.
- **Module names.** 87 modules of the 4.34 packs are gone: 70 removed
  upstream, 14 `deprecated_module` shims whose targets left every closure
  (`Mathlib.MeasureTheory.Measure.MeasureSpace`, `Mathlib.Data.Real.Hom`,
  `Mathlib.Data.Real.StarOrdered`, `Mathlib.Topology.Algebra.Module.WeakDual`,
  …) and 3 Batteries modules nothing imports any more
  (`Batteries.Control.LawfulMonadState`, `Batteries.Control.OptionT`,
  `Batteries.Tactic.OpenPrivate`). No example or test of this repository used
  one. An import of a removed name is refused with the usual note.
- **Unchanged from 4.34:** `deriving Fintype` on an enum still needs
  `set_option backward.isDefEq.respectTransparency false in` (Mathlib
  v4.35.0's handler is not adapted; the compiler battery pins both cases),
  `norm_num` for primality still needs a module outside the preloaded
  environment, and `decide` still cannot unfold a definition whose body a
  `module` file keeps private (`Nat.toDigits`; docs/SERVER-SLIM-REBAKE.md).
- **Deep but legal proofs go a little further**: `∀ n m : Fin 18, n * m = m * n
  := by decide` now checks (it ended in Lean's "stack is exhausted" on the 4.34
  runtimes); `Fin 20` still does, with no crash (HARDENING #71).
- **Downloads** are slightly smaller: the snapshots are 31.7 MB (init) and
  319.6 MB (Mathlib) compressed, from 32.6 and 321.5 MB.

## What Lean 4.34.0 changed for users (2026-09-22)

The playground served Lean `4.34.0` and Mathlib at tag `v4.34.0` from
2026-09-22 until the 4.35.0 landing (this section moved here from the README
in 2026-10). Visible differences from the earlier 4.33 pairing, as they were
then (the section above says which still hold):

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
