# Rebuilding the entire toolchain from source

Everything a stranger with a fresh clone needs to reproduce the served
runtime, library packs, and snapshots. Nothing lives only in a Docker
image or on the original author's machine: the patched compiler is the
commit named by the pinned release record `toolchain/lean4-wasm64-release.json`
(`kernel.commit`) on branch `qed64-wasm64` of
`github.com/FawadHa1der/lean4` (real git history on top of
`cauli/lean4@5732b84`; local checkout `~/code/wasm64-lean-kernel`), the
build environment is the Dockerfile under `docker-wasm64/` in that tree, and
every downstream artifact is a deterministic function of those.

> Last checked against the tree on 2026-10-06. The one-command form of
> sections 1-3 for a published (or staged) lean4-wasm64 release is
> `pipeline/release/adopt-release.sh` (§3), which replaced
> `pipeline/release/import-packs.sh` and `bump-chain.sh` in plan step B2a:
> the release already packs, checks the pair, gates, chunks and names the
> build.

## What is where

| Thing | Lives in | Committed? |
|---|---|---|
| The toolchain release QED64 serves and tests against | `toolchain/lean4-wasm64-release.json` (a byte copy of that release's `release.json`, schema `lean4-wasm64.release/v1`) | yes |
| The kernel commit to build | the record's `kernel.commit` (40 hex) and `kernel.patch`; `qed64.release/v1` `toolchain.kernel.commit` (docs/RELEASE-BUNDLE.md). `pipeline/toolchain/KERNEL-PIN` was retired in 2026-10 (plan B2c; it is in git history) | yes |
| The base trees the snapshots were baked from | `embedding/base-tree.json` (`qed64.base-tree/v1`, §3 step 6; the umbrella bytes ship in the release bundle, docs/RELEASE-BUNDLE.md) | yes |
| Patch series | the fork: `wasm64-build/PATCHES.md` on branch `qed64-wasm64` (a release names its level in `release.json` `kernel.patch`). QED64's old copy (`pipeline/toolchain/patches/`) was deleted in plan B1 (it is in git history); `pipeline/toolchain/PATCHES.md` is now a pointer to the fork | in the fork |
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
`runtime.buildId`. QED64's own `pipeline/toolchain/gate.mjs` and
`chunk-runtime.mjs` forward to the package's gate and chunker; a release's
runtime is staged by `adopt-release.sh` (§3) from the release's own chunks,
with no chunker and no restamp. (`setup-source.sh`, `build.sh`, `finish.sh`
and the patch copies under `pipeline/toolchain/` are deleted;
`gen-exports.py` is a stub that exits 2.)

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

## 3. The snapshots (init + the Mathlib umbrella): adopting a release

`pipeline/release/adopt-release.sh` adopts a lean4-wasm64 release end to
end into a STAGING tree and an ISOLATED served tree. It calls the package
only as a process (`node <tools>/cli.mjs …`; `<tools>` is `--tools`, else
`$LEAN4_WASM64_DIR`, else `node_modules/lean4-wasm64`) and writes only under
`work/adopt/<id>/` (`$W`), `work/staging/<buildId>/` and `--public`:

```sh
# fill an isolated served tree with the tracked manifests and their bytes first; the model is
# another worktree's own real (non-symlinked) public/, e.g. <qed64-wt-a3>/public: its checkout
# can then run the resident gate and the upload against exactly that tree
npm run -s fetch:artifacts -- --out <tree> --with-manifests --release <the SERVED release dir|url>
pipeline/release/adopt-release.sh --id <lean-vX.Y.Z-hash> --digest sha256:<hex> \
  (--from https://github.com/FawadHa1der/lean4/releases/download/<id>/ | --from-dir <release dir>) \
  --public <tree> [--tools <package dir>] (--umbrella <dir with QED64/Essential.olean{,.server}> | --rebuild-umbrella) \
  [--fat-tree] [--gate] [--init-lib lean-lib|lean-core] [--allow-served] [--dry-run] [--keep]
```

In order (`--dry-run` validates the inputs and prints exactly this plan,
fetching and writing nothing):

1. **fetch** `--only runtime-chunks,lean-lib,lean-core,mathlib-essential` into
   `$W/release` and `--only runtime` into `$W/artifact` (two calls: `bin/` is
   rebuilt from the verified chunks and the build id recomputed), both pinned
   by `--id` AND `--digest`; for a local dir also `lean4-wasm64 verify` of it
   (`--skip-packs` when the packs are the served ones).
2. **checks**: the record's self-digest and pin, `kernel.patch` ≥ closure.json
   `runtime.minKernelPatch` (NNNN, then an optional suffix), and the runtime
   is not the one `public/runtime/runtime-manifest.json` serves (a rehearsal
   passes `--allow-served`, into an isolated tree only). `--public` must not
   be (or lie in) this checkout's or the main checkout's `public/`, the
   release dir or `work/adopt`, `work/staging`; it must hold no symlink
   leaving it, and it must be filled: the three mutable manifests and every
   profile manifest its `profiles/index.json` lists (dry run too), and, in a
   real run before the fetch, a clean `verify-release.mjs --public` (the
   promote demands the same, hours later). `--umbrella` must not lie in
   `work/adopt` or `work/staging` (a rerun deletes the trees it reads). `$W`
   and the staging dir must be real directories with no symlink three
   levels down (a rerun's `rm -rf`, unpacks and copies would follow it).
   With `--from <URL>` the record is fetched first, and an id or digest
   mismatch is a one-line refusal before `$W/logs` exists.
3. **artifact-lib**: `lean-lib` (the runtime's own `lib/lean`, the tree the
   release gate passed on) unpacked to `$W/artifact/lib/lean`. It has no
   `.ilean` files, so the persistent-path test's patch-0010 check is skipped
   on that artifact, not failed (logged in `$W/logs/notes.log`).
4. **base-trees**, fresh: `$W/core-lib-slim` (`unpack --slim` of the init lib,
   `lean-lib` by default, the precedent; `--init-lib lean-core` is the
   alternative), `$W/lib-tree-slim` (`--slim` lean-core + mathlib-essential)
   and, with `--fat-tree`, `$W/lib-tree` (the same without `--slim`; the
   showcase's heavy path uses a fat tree).
5. **umbrella**: a runtime-only release (every served pack's raw digest is
   one of `release.packs`) REUSES the served pair (`--umbrella`): its header
   carries the packs' compiler githash, and a recompile would change the base
   tree's bytes. Otherwise `--rebuild-umbrella` regenerates and compiles it
   against the fat tree (`gen-umbrella.mjs`, `supervised-run.mjs`), runs the
   `olean-imports --audit`, and the packs are staged (`stage-profiles.mjs`).
   The pair is copied into each lib tree's `QED64/`, and into the fat tree
   also `Essential.olean.private` when the source has it (the slim served
   dir has only the pair; main's `work/lib-tree` has all three).
6. **base-tree**: `$W/base-tree.json` (`qed64.base-tree/v1`): the release id
   and digest, per tree the pack ids and raw digests it came from, the
   umbrella files it carries (sha256 and bytes; top-level `umbrella` is the
   pair), and a tree digest (sha256 over the sorted `"<relpath>\0<sha256>\n"`
   lines of every file) a downstream checks byte identity by.
7. **gate** (`--gate`, recommended for an unpublished release): the
   package's gate on `$W/artifact`, ` ok ` lines and `GATE PASSED`.
8. **bake-init / bake-mathlib** (QED64's runner):

   ```sh
   node --stack-size=8192 pipeline/snapshot/bake-snapshot.mjs --artifact $W/artifact --work $W/snapshot \
     --out work/staging/$BID/snapshots --name init --lib $W/core-lib-slim --reserve 1073741824
   node --stack-size=8192 pipeline/snapshot/bake-snapshot.mjs --artifact $W/artifact --work $W/snapshot \
     --out work/staging/$BID/snapshots --name mathlib --lib $W/lib-tree-slim --reserve 3221225472 --probe 'import QED64.Essential'
   ```

   The raw `.snap` files land in `$W/snapshot`, never `work/snapshot` (the
   set paired to the served runtime). The raw sizes in the served
   `public/snapshots/index.json` (`bytes`) are the check: for an unchanged
   library a bake within a few percent of them is the right bake; a full-tree bake is 2.5x larger (HARDENING #48).
9. **stage-runtime**: the release's `runtime-manifest.json` and `chunks/`
   copied to `work/staging/$BID/runtime` (no chunker, no restamp).
10. **pairing**: the staged runtime manifest and both snapshot entries name
    `$BID` and the release's Lean version.
11. **promote** into `--public` (dry run, then real), `verify-release.mjs
    --public`, and `cmp` of the promoted runtime manifest with the release's.
12. **next**: the operator's landing steps, printed and not performed. For a
    packs change it starts with step 0, the SLIM-BAKE AUDIT (required at
    every Mathlib pin: §3b step 3). Then: copy
    `$W/release/release.json` to `toolchain/lean4-wasm64-release.json`,
    `$W/base-tree.json` to `embedding/base-tree.json`, and the three tracked
    manifests from the isolated tree into `public/` (then
    `release-manifest.mjs --worktree` checks that the record names the
    served runtime and kernel, that it lists every runtime/profile file the
    hosting rule stores under its prefix, and that the base tree came from
    the served packs); `npm install
    --package-lock-only -D <release tgz URL>` once published; the wrangler
    variable (plan B2b); the user uploads, then pushes and deploys.
    `scripts/upload-artifacts.sh` takes no tree argument and reads only its
    own checkout's `public/`, so it runs either in the checkout whose own
    `public/` IS the isolated tree (`cd <that worktree> &&
    scripts/upload-artifacts.sh`; the script prints that when `--public` is
    `<checkout>/public`), or in a checkout whose real `public/` first got
    the same staging promoted into it (`promote-staging.mjs --staging
    work/staging/$BID --public <checkout>/public`: verified, additive).

Disk: the script refuses with less than 12 GB free under `work/` (16 GB with
the fat tree; `QED64_ADOPT_IGNORE_DISK=1` overrides; in a fresh clone
without `work/` it measures the checkout); the measured need is 6-9 GB. Without `--keep`, the release's chunks and pack parts under
`$W/release` are removed after a successful run (they are staged and
promoted by then); the trees, `$W/artifact` and `$W/snapshot` stay.

**Byte identity with the trees QED64 served from** (checked 2026-10-06
against lean-v4.34.0-a8817d0, file by file against the packs' per-artifact
digests, then by tree digest):

- `lib-tree-slim`: `unpack --slim` of lean-core + mathlib-essential gives
  every one of the 20,012 pack files of the served slim tree (main's
  `work/lib-tree-slim` = `work/bump-0035b/slim/lib-tree-slim`); with the
  reused pair the whole tree is identical: 20,014 files, tree digest
  `sha256:8c247f413e97e1b36341d9fa6774f19171dc89486ebd922bc98690e63ddd3d23`.
- `lib-tree` (fat): `unpack` of the same two packs gives all 25,015 pack
  files of main's `work/lib-tree`; with all three umbrella files
  (`--umbrella` naming main's `work/lib-tree`) the whole tree is identical:
  25,018 files, `sha256:57adeb5f0d3e82e3bd94fb70a583135cf8f018ea139c6b5d7c1cc80400e1302e`.
- `core-lib-slim`: `unpack --slim` of the release's `lean-lib` gives all
  10,074 facet files (`.olean`, `.olean.server`, `.ir`, `.ir.sig`) of the
  served `work/bump-0035b/slim/core-lib-slim` byte for byte, but that tree,
  an rsync of the build's `lib/lean`, also holds 20,206 build-side files no
  pack ships (`.ilean`, `*.hash`, `.trace`, static and shared libraries):
  identical on every file an import reads, NOT identical as a tree, so its
  tree digest differs. A runtime release changes this tree anyway (it is
  the new runtime's own library).

**Test before landing.** `tests/adversarial/resident-gate.sh` (preflight,
e2e, latency, compiler battery) takes no arguments and serves only its own
checkout's `public/` (vite's `publicDir` is `../public`). Run it from the
checkout whose own real (non-symlinked) `public/` IS the isolated tree
(`--public <qed64-wt-a3>/public`, the model above), and hand the battery the
new pairing by environment, with the absolute `$W` of the adoption:

```sh
cd <qed64-wt-a3> && QED64_BATTERY_ARGS="--artifact $W/artifact --snap $W/snapshot/mathlib.snap --lib $W/lib-tree-slim" \
  tests/adversarial/resident-gate.sh
```

(or `QED64_LEAN_ARTIFACT`, `QED64_MATHLIB_SNAP`, `QED64_LIB_TREE`). Without
them the battery falls back to the deprecated stage1 + `work/snapshot`,
the runtime being replaced, and passes against it. Then the two crash
gauntlets against `tests/adversarial/resident-url.sh` in that checkout. One gate at a time:
two concurrent runs kill each other's browsers. The kernel commit must be on
`origin/qed64-wasm64` first.

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
3. Snapshots: both bakes as above; the raw sizes (`bytes` in the snapshot
   index) will legitimately change. Both are baked from slim trees (no
   `*.olean.private`), proved harmless at one Mathlib pin only: the
   SLIM-BAKE AUDIT adopt-release prints as landing step 0 (the umbrella
   import log, the `import all` audit, and a fat-versus-slim differential
   bake compared with `snapshot-probe.mjs`) is required at every new pin and
   recorded in docs/SERVER-SLIM-REBAKE.md; if the messages differ, ship
   the fat bake.
4. Page: the import-completion list and the covered-module set read the
   manifests, so they follow; the compiler battery's golden messages and the
   e2e corpus may need re-goldening where upstream changed message text.
5. Records: `docs/PROVENANCE.md` (toolchain identity, Mathlib revision, pack
   digests), the pinned release record and `embedding/base-tree.json`. The
   release (the fork cuts it: packs, the pair checks, the gate, the chunks)
   is adopted with `pipeline/release/adopt-release.sh --rebuild-umbrella`
   (§3): it stages the new packs with the runtime and snapshots, bakes from
   `$W` trees, and writes the raw `.snap` files to `$W/snapshot`, never
   `work/snapshot` (the set the compiler battery and the Node probes load
   against the SERVED binary). After landing, either point the battery and
   the Node probes at the served pairing explicitly (`--artifact/--snap/--lib`, or
   `QED64_LEAN_ARTIFACT`, `QED64_MATHLIB_SNAP`, `QED64_LIB_TREE`: docs/TESTING.md
   "Environment"), or make the toolchain working directory mirror what is
   served, so their deprecated defaults (`pipeline/toolchain/work/build/stage1`,
   `work/snapshot`, `work/lib-tree-slim`; one WARNING each, gone next cycle)
   test the served pairing: install `$W/artifact`'s `bin/` and `lib/lean`
   into `pipeline/toolchain/work/build/stage1` **with `bin/package.json` =
   `{ "type": "commonjs" }`** (the fetch writes it into `$W/artifact/bin`; the
   glue's pthread workers `require` it, and under this repo's `"type":
   "module"` a bare `.js` is ESM and every probe dies with "require is not
   defined"), and move `$W/{lib-tree,lib-tree-slim,core-lib-slim}` and
   `$W/snapshot/{init,mathlib}.snap` into `work/` (keep the previous sets
   aside as `*-<old version>`).
6. lean4game vendors qed64 at its own pin and has its own kernel pin and
   build lane (`wasm/build-from-source.sh` there); it is a separate bump.

## 4. Serve

`npm run dev` locally (Vite sets COOP/COEP), or `docs/DEPLOY.md` for the
Cloudflare Workers + R2 deployment. Restart the dev server whenever files
under `public/` change (Vite indexes it at startup).
