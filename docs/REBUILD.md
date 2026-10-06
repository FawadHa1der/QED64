# Rebuilding the entire toolchain from source

Everything a stranger with a fresh clone needs to reproduce the served
runtime, library packs, and snapshots. Nothing lives only in a Docker
image or on the original author's machine: the patched compiler is the
commit named in `pipeline/toolchain/KERNEL-PIN` on branch `qed64-wasm64` of
`github.com/FawadHa1der/lean4` (real git history on top of
`cauli/lean4@5732b84`; local checkout `~/code/wasm64-lean-kernel`), the
build environment is the Dockerfile under `docker-wasm64/` in that tree, and
every downstream artifact is a deterministic function of those.

> Last checked against the tree on 2026-09-22 (pairing
> `wasm64-36a96239e08fd2e0`, Lean 4.34.0 — the first version import,
> done with `pipeline/release/import-packs.sh`, §3b). The one-command form of
> section 3 is `QED64_ARTIFACT=<fetched runtime> pipeline/release/bump-chain.sh stage-artifact` … pyramid …
> `pipeline/release/bump-chain.sh promote`.

## What is where

| Thing | Lives in | Committed? |
|---|---|---|
| The toolchain release QED64 serves and tests against | `toolchain/lean4-wasm64-release.json` (a byte copy of that release's `release.json`, schema `lean4-wasm64.release/v1`) | yes |
| The kernel commit to build | `pipeline/toolchain/KERNEL-PIN` (40-hex commit + the paired runtime id and raw snapshot sizes) | yes |
| Patch series | the fork: `wasm64-build/PATCHES.md` on branch `qed64-wasm64` (a release names its level in `release.json` `kernel.patch`). QED64's old copy (`pipeline/toolchain/patches/` + `PATCHES.md`) is provenance only, never applied, and retired (plan B1) | in the fork |
| Build environment (emsdk 6.0.5, cmake, ccache) | `docker-wasm64/` in the kernel tree | yes (in the kernel repo) |
| Source checkout | your clone of the fork at `release.json` `kernel.commit` | no |
| Built compiler | the release's `runtime/` (fetched), or `wasm64-build/` output in your fork clone | no — build output |
| Served artifacts | `public/runtime`, `public/profiles`, `public/snapshots` | no — content-addressed; manifests (the digest roots) ARE committed |

## Prerequisites

- Docker with **≥ 10 GB memory for its VM** (the final `wasm-metadce` link
  pass is OOM-killed below ~7 GB free — HARDENING has the war story).
- Node **24+** (Memory64 on by default), ~25 GB free disk.
- ~1.5–3 h wall clock on a modern 8–14-core machine for the compiler;
  add several hours if you also rebuild the Mathlib packs from source.

## 1. The compiler (lean.js + lean.wasm)

The compiler build moved to the fork (plan B1, 2026-10): FawadHa1der/lean4,
branch `qed64-wasm64`, directory `wasm64-build/` (`build.sh`, the generated
export list `gen-exports.py`, the gate, `PATCHES.md`), and it is published as
releases (`release.json`, schema `lean4-wasm64.release/v1`) plus the npm
package `lean4-wasm64` (its CLI: fetch, verify, gate, chunk, pack, unpack,
inspect). QED64 pins the release it serves and tests against in
`toolchain/lean4-wasm64-release.json` and the package as a devDependency by
that release's tgz URL; nothing in QED64 imports the package.

To rebuild the runtime, clone the fork at the record's `kernel.commit` and
follow `wasm64-build/` there; the gate it runs must print `GATE PASSED`. To
use the published one, fetch the release (`npm run fetch:artifacts -- --release
<dir|url>`, or `lean4-wasm64 fetch`); its `runtime/` is already chunked and
its `buildId` (`wasm64-<sha256(lean.wasm)[:16]>`) is `release.json`
`runtime.buildId`. QED64's own `pipeline/toolchain/gate.mjs` forwards to the
package's gate, and `pipeline/release/bump-chain.sh stage` refuses: stage a
fetched runtime with `QED64_ARTIFACT=<its dir> bump-chain.sh stage-artifact`.
(`setup-source.sh`, `build.sh`, `finish.sh` and the patch copies under
`pipeline/toolchain/` are retired; `gen-exports.py` is a stub that exits 2.)

The resulting `buildId` names the runtime; snapshots are only valid against
the exact binary that baked them.

## 2. The library packs (Lean core + Mathlib oleans)

The wasm runtime consumes `.olean`s that must come from a **64-bit build of
this exact fork revision** (olean regions are pointer-width- and
serialization-compatible; the githash gate is compiled off, compatibility
is enforced by the SHA-256 manifests instead). Two options:

- **Trusted artifacts**: obtain the packs whose digests match the committed
  manifests (`public/profiles/*.manifest.json`) from an existing deployment
  or release, and `npm run verify:release`. `npm run fetch:artifacts` does
  this (from the live site, `--origin <url>` for another deployment, or
  `--release <dir|url>` for a Lean fork release; docs/CLI-CONTRACT.md
  "fetch-artifacts"). (Until 2026-10 `npm run sync:artifacts` copied them
  from the owner's sibling checkout; it was removed with that dependency.) The manifests in git are the
  trust anchor — bytes from anywhere are fine if the digests match.
- **Full rebuild**: build the same fork **natively** (`make -C build/release`
  inside your fork clone, standard Lean build), then build Mathlib at the
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
npm run bake:snapshot -- --name init    --lib work/core-lib-slim --reserve 1073741824 --artifact pipeline/toolchain/work/build/stage1 \
  --work work/snapshot --out work/staging/$ID/snapshots
npm run bake:snapshot -- --name mathlib --lib work/lib-tree-slim --reserve 3221225472 --probe 'import QED64.Essential' --artifact pipeline/toolchain/work/build/stage1 \
  --work work/snapshot --out work/staging/$ID/snapshots
```

`$ID` is the buildId of § 1. Both land in `work/staging/<buildId>/snapshots`
(the bake refuses foreign siblings); the raw `.snap` files go to `--work`,
here `work/snapshot`, the set paired to the served runtime, so only a bake of
the served runtime may name it (bump-chain.sh's `QED64_SNAP_WORK`, below).
Both paths are explicit, as in bump-chain.sh: without `--work`/`--out` (or
`QED64_WORK`/`QED64_STAGING`) the bake falls back to the same places with one
deprecation WARNING each, and exits 2 from the next contract on. The raw sizes recorded in KERNEL-PIN are the check: for an
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

**What one promote moves.** `promote-staging.mjs --staging work/staging/<buildId>`
verifies everything staged before it touches `public/` (sizes, SHA-256,
snapshot ↔ runtime pairing), copies the content-addressed files additively
(chunks, snapshots, pack parts — each via a temp name, so a crash never
leaves a short file under a final name), and only then switches the mutable
files by atomic rename, all written beside their targets first and renamed
back to back: per-build runtime manifest, profile manifests, snapshot index,
default runtime manifest, and `profiles/index.json` last. No mutable file is
ever switched in before every file it names is in place, and the profile
index is the commit record. If `work/staging/<buildId>/profiles/index.json`
exists (a version import: `index.json` with `runtime.buildId` = the staged
runtime, the two manifests, and every part file by basename; part and
manifest URLs must read `/profiles/<file>` and each manifest's `digest` must
be `sha256(JSON.stringify(content))` re-derived after the last edit), the
packs are promoted in the same step; without a staged `profiles/` directory
it is a kernel-only bump and the served packs stay. Either way the promote
owns `public/profiles/index.json` `runtime`: it means "the runtime these
profiles are served with", is re-pointed at the promoted `{buildId,
leanVersion}` on every promote, and a pack whose `content.lean.version` is
not the promoted runtime's is refused (oleans of another Lean version are
not rejected by the runtime, they are misread). `verify:release` checks the
same pairing, so an interrupted promote shows up there; rerun it, it is
idempotent. `--dry-run` prints the exact plan and writes nothing.

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
   After the promote, either point the battery and the Node probes at the
   served pairing explicitly (`--artifact/--snap/--lib`, or
   `QED64_LEAN_ARTIFACT`, `QED64_MATHLIB_SNAP`, `QED64_LIB_TREE`: docs/TESTING.md
   "Environment"), or make the toolchain working directory mirror what is
   served, so their deprecated defaults (`pipeline/toolchain/work/build/stage1`,
   `work/snapshot`, `work/lib-tree-slim`; one WARNING each, gone next cycle)
   test the served pairing: install the artifact's `bin/`, `lib/lean` and
   `lib/temp` into `pipeline/toolchain/work/build/stage1` **with
   `bin/package.json` = `{ "type": "commonjs" }`** (the glue's pthread workers
   `require` it; under this repo's `"type": "module"` a bare `.js` is ESM and
   every probe dies with "require is not defined"), check out `work/lean4` at
   the pin, and move the new `work/{lib-tree,lib-tree-slim,core-lib-slim,umbrella}`
   and `work/snapshot/{init,mathlib}.snap` into place (keep the previous
   sets aside as `*-<old version>`).
6. lean4game vendors qed64 at its own pin and has its own kernel pin and
   build lane (`wasm/build-from-source.sh` there); it is a separate bump.

## 4. Serve

`npm run dev` locally (Vite sets COOP/COEP), or `docs/DEPLOY.md` for the
Cloudflare Workers + R2 deployment. Restart the dev server whenever files
under `public/` change (Vite indexes it at startup).
