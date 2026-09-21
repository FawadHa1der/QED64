# Rebuilding the entire toolchain from source

Everything a stranger with a fresh clone needs to reproduce the served
runtime, library packs, and snapshots. Nothing lives only in a Docker
image or on the original author's machine: the patched compiler is the
commit named in `pipeline/toolchain/KERNEL-PIN` on branch `qed64-wasm64` of
`github.com/FawadHa1der/lean4` (real git history on top of
`cauli/lean4@5732b84`; local checkout `~/code/wasm64-lean-kernel`), the
build environment is the Dockerfile under `docker-wasm64/` in that tree, and
every downstream artifact is a deterministic function of those.

> Last checked against the tree on 2026-09-21 (pairing
> `wasm64-c645477e817ac857`, series through 0033). The one-command form of
> sections 1 and 3 is `pipeline/release/bump-chain.sh stage` … pyramid …
> `pipeline/release/bump-chain.sh promote`.

## What is where

| Thing | Lives in | Committed? |
|---|---|---|
| The kernel commit to build | `pipeline/toolchain/KERNEL-PIN` (40-hex commit + the paired runtime id and raw snapshot sizes) | yes |
| Patch series | `pipeline/toolchain/patches/0001–0033` + `PATCHES.md` — **provenance only, never applied**; the branch is the truth | yes |
| Build environment (emsdk 6.0.5, cmake, ccache) | `docker-wasm64/` in the kernel tree | yes (in the kernel repo) |
| Source checkout | `pipeline/toolchain/work/lean4` (branch `qed64-wasm64` at the pin) | no — materialized by `setup-source.sh` |
| Built compiler | `pipeline/toolchain/work/build/stage1/bin/lean.{js,wasm}` | no — build output |
| Served artifacts | `public/runtime`, `public/profiles`, `public/snapshots` | no — content-addressed; manifests (the digest roots) ARE committed |

## Prerequisites

- Docker with **≥ 10 GB memory for its VM** (the final `wasm-metadce` link
  pass is OOM-killed below ~7 GB free — HARDENING has the war story).
- Node **24+** (Memory64 on by default), ~25 GB free disk.
- ~1.5–3 h wall clock on a modern 8–14-core machine for the compiler;
  add several hours if you also rebuild the Mathlib packs from source.

## 1. The compiler (lean.js + lean.wasm)

```sh
pipeline/toolchain/setup-source.sh   # clone FawadHa1der/lean4 qed64-wasm64 at KERNEL-PIN (refuses a pin not on origin)
pipeline/toolchain/build.sh          # docker build env + stage1 libraries + stdlib compile + generated exports + link
pipeline/toolchain/finish.sh         # githash reconfigure, leaninitialize, final link
node --stack-size=8192 pipeline/toolchain/gate.mjs --artifact pipeline/toolchain/work/build/stage1
```

Docker Desktop must be running (`open -a Docker`). The gate must print
`GATE PASSED` (kernel-checked proof, positioned errors, resident-environment
reuse, and THE PARSE GATE). Its two one-shot CLI checks are judged by their
OUTPUT and each ends in a bounded 4-minute timeout: since the keepalive guard
the CLI never exits, which is what the product relies on (HARDENING #47).
The exported-symbol list is generated at build time as
seed ∪ (wanted ∩ defined) by `pipeline/toolchain/gen-exports.py`; run it with
`--check` after any large source change to see how many `wanted` names went
stale. Then chunk it for serving:

```sh
node pipeline/toolchain/chunk-runtime.mjs --bin pipeline/toolchain/work/build/stage1/bin \
  --lean-version <the Lean version of the pin> \
  --revision $(git -C pipeline/toolchain/work/lean4 rev-parse --short HEAD)
```

The default `--out` is `work/staging/<buildId>/runtime`; keep it. NEVER pass
`--out public/runtime` (it destroyed the served chunks once — only
`promote-staging.mjs` writes there, additively). `--lean-version` defaults to
`4.33.0-pre`: pass the real one after a version import.

The resulting `buildId` (`wasm64-<sha256(lean.wasm)[:16]>`) names the
runtime; snapshots are only valid against the exact binary that baked them.

## 2. The library packs (Lean core + Mathlib oleans)

The wasm runtime consumes `.olean`s that must come from a **64-bit build of
this exact fork revision** (olean regions are pointer-width- and
serialization-compatible; the githash gate is compiled off, compatibility
is enforced by the SHA-256 manifests instead). Two options:

- **Trusted artifacts**: obtain the packs whose digests match the committed
  manifests (`public/profiles/*.manifest.json`) from an existing deployment
  or release, and `npm run verify:release`. This is what `sync:artifacts`
  automates. The manifests in git are the trust anchor — bytes from
  anywhere are fine if the digests match.
- **Full rebuild**: build the same fork **natively** (`make -C build/release`
  inside `work/lean4`, standard Lean build), then build Mathlib at the
  pinned revision in `docs/PROVENANCE.md` with that toolchain
  (`lake build`), collect the `.olean`/`.ir` facets, and pack them with
  `pipeline/artifacts/pack.mjs`. Budget several hours and ~40 GB of disk;
  the resulting manifests will differ from the committed ones only if you
  change the Mathlib revision or fork tree.

## 3. The snapshots (init + the Mathlib umbrella)

README.md § "Baking snapshots" explains the pieces (unpack the packs into
`work/lib-tree`, compile the `QED64.Essential` umbrella with the wasm runtime
under Node). The served pairings are baked from the **slim** trees — the same
oleans without `*.olean.private` (docs/SERVER-SLIM-REBAKE.md) — regenerated
from the new stage1 on every bump:

```sh
rsync -a --delete --exclude='*.olean.private' --link-dest=$PWD/work/lib-tree work/lib-tree/ work/lib-tree-slim/
rsync -a --delete --exclude='*.olean.private' --link-dest=$PWD/pipeline/toolchain/work/build/stage1/lib/lean \
  pipeline/toolchain/work/build/stage1/lib/lean/ work/core-lib-slim/
npm run bake:snapshot -- --name init    --lib work/core-lib-slim --reserve 1073741824 --artifact pipeline/toolchain/work/build/stage1
npm run bake:snapshot -- --name mathlib --lib work/lib-tree-slim --reserve 3221225472 --probe 'import QED64.Essential' --artifact pipeline/toolchain/work/build/stage1
```

Both land in `work/staging/<buildId>/snapshots` (the bake refuses foreign
siblings). The raw sizes recorded in KERNEL-PIN are the check: for an
unchanged library a bake within a few percent of them is the right bake; a
full-tree bake is 2.5x larger (HARDENING #48). Snapshots MUST be re-baked
after every compiler rebuild.

**Test before promoting.** Copy the staged runtime manifest
(`runtime-manifest.<buildId>.json`) and its chunks additively into
`public/runtime/`, point the `public/snapshots-0031` symlink at
`../work/staging/<buildId>/snapshots`, restart the dev server, and run
`tests/adversarial/resident-gate.sh` (preflight, e2e, latency, compiler
battery) plus the two crash gauntlets against
`tests/adversarial/resident-url.sh`. One gate at a time: two concurrent runs
kill each other's browsers. Then write KERNEL-PIN and
`pipeline/release/bump-chain.sh promote` (promote-staging + verify:release).
The user uploads artifacts (`scripts/upload-artifacts.sh`) and pushes; the
kernel commit must be on `origin/qed64-wasm64` first.

## 3b. Importing a new upstream Lean version

A version import is a pairing bump plus everything the library version
touches, in this order:

1. Kernel: merge the upstream tag on an import branch, build, gate; after the
   merge run `gen-exports.py --check` — `emscripten-exports.wanted.txt` is a
   historical list that can only shrink, so renamed specializations drop out
   silently and new ones are never added; decide deliberately whether the
   list needs regenerating for the new tree.
2. Packs (section 2, full rebuild): `lean-core` from a native 64-bit build of
   the SAME fork commit, and `mathlib-essential` from Mathlib at the tag that
   matches the new Lean version, with the compat patch re-examined. New pack
   digests mean new committed manifests under `public/profiles/`, a new
   `work/lib-tree`, and a regenerated + recompiled `QED64/Essential` umbrella
   (its module list is the essential manifest's).
3. Snapshots: both bakes as above; the KERNEL-PIN sizes will legitimately
   change — record the new ones.
4. Page: the import-completion list and the covered-module set read the
   manifests, so they follow; the compiler battery's golden messages and the
   e2e corpus may need re-goldening where upstream changed message text.
5. Records: `docs/PROVENANCE.md` (toolchain identity, Mathlib revision, pack
   digests), `PATCHES.md`, KERNEL-PIN, `--lean-version` at chunk time.
   A runtime built in its own directory is staged with
   `pipeline/release/bump-chain.sh stage-artifact` and the environment
   `QED64_ARTIFACT` (dir with `bin/` and `lib/lean`), `QED64_LIB_TREE` (the
   new unpacked olean tree), `QED64_SLIM`, `QED64_LEAN_VERSION`, and —
   mandatory for a foreign runtime, the script refuses without it —
   `QED64_SNAP_WORK`: the bake's raw `.snap` files default to `work/snapshot`,
   which is the set the compiler battery and the Node probes load against the
   SERVED binary; overwriting it unpairs them. Only at promotion time do the
   new raw snapshots replace `work/snapshot/{init,mathlib}.snap`.
6. lean4game vendors qed64 at its own pin and has its own kernel pin and
   build lane (`wasm/build-from-source.sh` there); it is a separate bump.

## 4. Serve

`npm run dev` locally (Vite sets COOP/COEP), or `docs/DEPLOY.md` for the
Cloudflare Workers + R2 deployment. Restart the dev server whenever files
under `public/` change (Vite indexes it at startup).
