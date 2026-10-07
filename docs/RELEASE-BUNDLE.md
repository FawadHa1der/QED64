# The release manifest (`qed64.release/v1`)

A QED64 release is deployed through two channels that never meet: the app
shell goes out via `git push` (`.github/workflows/deploy.yml`), and the runtime,
snapshots and library packs via `scripts/upload-artifacts.sh` into R2 (since
decision 3 the runtime and packs are the toolchain release's own upload,
under `lean4-wasm64/<release id>/`). The facts that pair them live in the
tracked files: the pinned toolchain record `toolchain/lean4-wasm64-release.json`,
`embedding/base-tree.json`, `public/runtime/runtime-manifest.json`,
`public/snapshots/index.json`, `public/profiles/index.json` and the profile
manifests (`pipeline/toolchain/KERNEL-PIN` was one of them until it was
retired in 2026-10, plan B2c). Before this manifest a
downstream that wanted to pin "the QED64 it tested against" had to pin a git
commit and then re-derive everything from those files. Downstreams include
lean4game, which vendors qed64 at its own pin, and the widgets showcase, which
vendors `pipeline/snapshot/` and three pipeline modules. Re-deriving also
meant trusting that those files agree with each other.

`pipeline/release/release-manifest.mjs` writes one document per release. It
names every served object by sha256 and gives the release three identities. It
refuses to write anything while the pairing facts disagree.
`pipeline/release/write-bundle.mjs` writes the manifest with the files that go
with it, the bundle ([below](#the-bundle)). Generating and checking the
manifest and writing the bundle are implemented. **Publishing them (CI,
GitHub releases, a public URL) is proposed below and has not been applied**
(decision 7, the user's).

## What it is

```sh
node pipeline/release/release-manifest.mjs --commit HEAD --out release.json         # from git objects only
node pipeline/release/release-manifest.mjs --worktree                               # public/ as on disk (after a promote, before the commit)
node pipeline/release/release-manifest.mjs --commit HEAD --dist dist --out release.json   # + the app shell (after npm run build:site)
node pipeline/release/release-manifest.mjs --check release.json [--dist dist]        # regenerate and compare byte for byte
node pipeline/release/release-manifest.mjs --repo <QED64 clone> --commit <rev>     # the shipped copy (node_modules/qed64/pipeline/release/) reads a clone
node pipeline/release/release-manifest.mjs --help                                   # reads and writes nothing
```

`--worktree` reads `public/`, the record and `base-tree.json` from disk
(`--public`, `--toolchain-record`, `--base-tree` name other copies); it is
the check right after an adoption's landing steps, before the commit.

`--commit <rev>` reads every input with `git cat-file blob <rev>:<path>`, which
returns the same raw blob `git show <rev>:<path>` prints. It never reads the
working tree, so the output is a pure function of the commit: the same bytes on
any machine, with no network access and no artifact downloads. A shallow CI
checkout is enough. Every digest and size comes from the tracked manifests,
which are the same digest roots the browser verifies against. The current
HEAD's manifest is about 30 KB, or 41 KB with the shell section (59 files,
18 MB). It describes 87 origin objects and 1.65 GB on the wire.

| Key | Content |
|---|---|
| `schema` | `"qed64.release/v1"` |
| `digest` | `"sha256:" + sha256(JSON.stringify(manifest without digest))`: the manifest's own identity |
| `releaseId` | `"qed64-" + qed64.commit[:7]` |
| `artifactSetId` | `"set-" + sha256(JSON.stringify({runtime, snapshots, profiles}))[:16]` (see below) |
| `qed64` | `{repo, commit, committedAt (UTC, from the commit object), source: "commit"\|"worktree", dirty}`. `dirty` is true only for `--worktree` when an input differs from HEAD. With `--dist` the inputs include `public/workers/*`, so an edited worker, or one HEAD has and the tree lacks, makes it dirty |
| `lean` | `{version, target}` of the runtime manifest |
| `kernel` | `{repo: "FawadHa1der/lean4", branch: "qed64-wasm64", commit (the record's `kernel.commit`; KERNEL-PIN's until 2026-10), sourceRevision (runtime manifest)}` |
| `toolchain` | `{releaseId, digest, record {path, sha256, gitBlob}, kernel {commit, patch}, runtimeBuildId, packs [{id, rawSha256}], tools {package, version, tgz}}`: the pinned lean4-wasm64 release (`toolchain/lean4-wasm64-release.json`): its `id`, its self-digest, the file's identity, `kernel.commit`/`kernel.patch`, `runtime.buildId`, every pack's raw (gunzipped) sha256, and the tools package it ships |
| `hosting` | `{toolchainPrefix: "lean4-wasm64/<releaseId>/", siteOwned (the record's hosting.siteOwned, URL paths), rule}`: where each path is stored in R2 (below) |
| `baseTree` | `{path, sha256, gitBlob, schema, releaseId, releaseDigest, runtime, packs [{id, release, rawSha256}], slim, umbrella [{path, sha256, bytes}], umbrellaSource, initLib, digestRule, trees {<name>: {slim, packs, umbrella, files, bytes, digest}}, umbrellaFiles [{path, sha256, bytes}]}`: `embedding/base-tree.json` (`qed64.base-tree/v1`, written by `adopt-helper.mjs base-tree`), built field by field, plus `umbrellaFiles`, the union of the umbrella files the trees carry (what the bundle ships at `umbrella/<path>`). `releaseDigest` and `runtime` are the record's `digest` and `runtime.buildId` when `releaseId` is the record's `id` (anything else is refused), and `null` when it names another release |
| `runtime` | `{buildId, manifest {path, sha256, gitBlob, pinnedPath}, files [{name, bytes, sha256, chunks [{path, bytes, sha256}]}]}` |
| `snapshots` | `{index {path, sha256, gitBlob}, entries [{name, path, sha256, transferBytes, rawBytes, imports, runtime}]}` |
| `profiles` | `{index {…}, packs [{id, release, modules, manifest {path, sha256, gitBlob, contentDigest}, lean {version, gitRevision}, pack {sha256, bytes}, transport {sha256, bytes, parts [{path, sha256, bytes}]}}]}` |
| `shell` | `null`, or with `--dist`: `{shellId, listingSha256, bytes, apiRevision, embedApiRevision, bundle {entries, buildIds}, files [{path, sha256, bytes}]}`. `apiRevision` (the page API, `globalThis.qed64.api.revision`) and `embedApiRevision` (the `qed64/embed` barrel's `EMBED_API_REVISION`) come from `dist/qed64-build.json`; `null` when the build wrote none |

Conventions:

- **Key order is fixed by the generator.** Every object is built literally.
  The file is `JSON.stringify(m, null, 2) + "\n"`. `JSON.parse` keeps key
  order, so a reader can recompute both digests from the parsed object.
- **Every `path` is relative to the origin root**, and that stays true for
  browsers: `runtime/chunks/lean.wasm.5500c87f….part-000` is served at
  `/runtime/chunks/…` and `gitBlob` is git's blob id of `public/<path>`.
  The exceptions are not served: `toolchain.record.path` and
  `baseTree.path` are repo paths, and the umbrella paths in `baseTree`
  (`QED64/Essential.olean`, …) are relative to a base tree's root.
- **R2 keys follow `hosting.rule`** (decision 3, docs/DEPLOY.md "The
  toolchain release prefix"): a path under `runtime/` or `profiles/` that is
  not site-owned is stored at `<toolchainPrefix><path>`, so
  `lean4-wasm64/lean-v4.34.0-a8817d0/runtime/chunks/…`; every other path
  (the snapshots and `profiles/index.json`, `siteOwned` today) at `<path>`
  under the site's prefix (the bucket root for QED64). A path is site-owned
  when `"/" + path` equals a `siteOwned` entry, or starts with one that ends
  in `/`. The generator refuses a record whose mounts are not the identity
  mounts `/runtime/` → `runtime/`, `/profiles/` → `profiles/` that the rule
  describes.
- **Field names tell you the digest format.** Fields named `sha256` or
  `<x>Sha256` (`rawSha256`, `listingSha256`) hold bare hex, also where
  `base-tree.json` spells `rawSha256` with the prefix. `digest` and
  `contentDigest` keep the `sha256:` prefix, which matches
  `pack.mjs` and the indexes. `contentDigest` is the profile manifest's own
  `digest`, re-derived as `sha256(JSON.stringify(content))` before it is
  recorded.
- `runtime.manifest.pinnedPath` is the immutable per-build copy. The shell
  fetches it first (`frontend/src/qed64-boot.ts`), and it must be
  byte-identical to `runtime.manifest`.
- A snapshot's `sha256`/`transferBytes` describe the served `.snapz`;
  `rawBytes` is the inflated size. A pack's `transport` describes the served
  gzip parts; `pack` describes the raw stream after gunzip.

### The three identities

- **`releaseId`** identifies the qed64 commit. Every commit is a release
  candidate.
- **`artifactSetId`** identifies the bytes in R2. It covers only `runtime`,
  `snapshots` and `profiles`, so it is independent of the qed64 commit and of
  the shell. Two commits with the same set serve exactly the same artifacts. A
  shell-only change keeps the set; a promote changes it. This is the "per
  promote" identity, and it is what a downstream compares to decide whether a
  qed64 bump means re-downloading and re-verifying gigabytes. It does change
  when a tracked manifest's bytes change, including a whitespace-only change,
  because the manifests' `sha256` and `gitBlob` are inside the set.
- **`shellId`** identifies the deployed shell:
  `"shell-" + listingSha256[:16]`. `listingSha256` is the sha256 of the
  byte-sorted listing of `<sha256>  <relpath>` lines, which is exactly what
  this command prints:

  ```sh
  (cd dist && find . -type f ! -name qed64-build.json | sed 's|^\./||' | LC_ALL=C sort | xargs shasum -a 256) | shasum -a 256
  ```

  The listing in the manifest's `shell.files` lets you find which file
  differs.
  `dist/qed64-build.json` (written by the build, docs/EMBEDDING.md §4) names
  the same id, so it is left out of the listing. A build file that names
  another shell, or another runtime, is refused. The build writes it only
  after it has written every other file, and never for a failed build.

### Stable field paths (a contract)

A downstream pin tool may read these paths of any `qed64.release/v1`
manifest. Within `v1` each keeps its name, type and meaning; keys are only
added. A change to one of them is a new schema (`qed64.release/v2`).

| Path | Type | Meaning |
|---|---|---|
| `toolchain.releaseId` | string, `lean-v<x.y.z>-<7 hex>…` | the lean4-wasm64 release the runtime, packs and tools come from; with `toolchain.digest` it pins that release |
| `toolchain.kernel.commit` | 40 lowercase hex | the kernel commit that built the served `lean.wasm` (the record's `kernel.commit`; the runtime manifest's `sourceRevision` names a prefix of it) |
| `toolchain.kernel.patch` | `NNNN` + optional lowercase suffix | the record's patch level (compare with lean4-wasm64's `comparePatchIds`) |
| `toolchain.digest` | `sha256:<64 hex>` | the record's self-digest |
| `kernel.commit` | 40 lowercase hex | the same commit as `toolchain.kernel.commit` |
| `runtime.buildId` | `wasm64-<16 hex>` | the served runtime |
| `qed64.commit`, `releaseId`, `artifactSetId`, `digest` | as above | the three identities and the manifest's own |
| `shell.shellId`, `shell.apiRevision`, `shell.embedApiRevision` | string; revisions may be `null` | the shell (with `--dist`) |
| `baseTree.sha256`, `baseTree.umbrellaFiles[]`, `baseTree.digestRule` | hex; `{path, sha256, bytes}`; string | the identity of `embedding/base-tree.json`, the umbrella files the bundle ships (the union over the trees), and the rule the tree digests follow |
| `baseTree.trees.<name>.slim`, `.packs[]`, `.umbrella[]`, `.files`, `.digest` | boolean; `{id, release, rawSha256}` (`release` may be `null`, `rawSha256` is `sha256:<hex>`); `{path, sha256, bytes}`; integer; `sha256:<hex>` | one base tree the snapshots were baked from, and how to rebuild it (see "Rebuilding a base tree" below). The trees are `core-lib-slim` (no umbrella) and `lib-tree-slim`, always present, and `lib-tree`, the fat tree, present only when the adoption ran with `--fat-tree` |
| `hosting.toolchainPrefix`, `hosting.siteOwned`, `hosting.rule` | strings | where each path is stored |

**`toolchain.releaseId` replaces KERNEL-PIN's role** (proposal:132, step 3):
the one check KERNEL-PIN carried, that the served manifest's
`sourceRevision` names the pinned kernel commit, is now the refusal against
the record's `kernel.commit`, and the pin itself is the record a release id
and digest name. `pipeline/toolchain/KERNEL-PIN` left the tree in the commit
that first ships these keys (plan B2c, 2026-10). A pin tool reads
`toolchain.kernel.commit` (and `toolchain.releaseId`) from the manifest of a
commit that has them, and falls back to `git show <commit>:pipeline/toolchain/KERNEL-PIN`
(first token) only for older pins.

## What it refuses

Every refusal exits 1 with one line on stderr
(`release-manifest: REFUSED: <reason>`) and writes nothing. Usage errors exit
2. The first group covers pairing facts the browser cannot check, so they are
checked here instead:

| Refusal | Why it matters |
|---|---|
| The toolchain record is not `lean4-wasm64.release/v1`, its `digest` is not `"sha256:" + sha256(JSON.stringify(record without digest, null, 2))` (recomputed with `node:crypto`; lean4-wasm64 is never imported, decision 10), or a field the manifest reads is malformed (`id`, `kernel.commit`/`patch`/`repo`/`branch`, `runtime.buildId`, the packs' raw digests, `tools`, `hosting`, `files`) | The record was edited after the release cut it, or is not the kind this generator describes |
| The record's `runtime.buildId` is not the served `buildId` | The pinned release and the served runtime are different builds (land the adoption's runtime manifest with its record) |
| The commit prefix in the runtime manifest's `sourceRevision` (`qed64-wasm64@<commit>`) is not a prefix of the record's `kernel.commit`, or there is no commit in it | The record and the served binary disagree, so a rebuild from the pin will not reproduce what is served (REBUILD.md) |
| A file the hosting rule stores under the toolchain prefix (the runtime manifest and its per-build copy `runtime/runtime-manifest.<buildId>.json`, always, whether or not the record lists it; every profile manifest except `profiles/index.json`; every chunk and part) is not in the record's `files` with that sha256 and size | The Worker serves that path from `lean4-wasm64/<id>/`, where the release's bytes are, not QED64's. The pinned shell fetches the per-build copy first |
| `base-tree.json` lists a pack, at the top or in any `trees.<name>.packs`, that the record does not carry, or with another raw digest (or another `release`, when given) than the record's, whatever release it names; it names the record's own release id with another `releaseDigest` or `runtime` than the record's; its top-level `packs` are not exactly the served packs (matched by the record's pack `manifest` path); a tree other than `core-lib-slim`, or the top-level `umbrella`, lacks the umbrella pair; or it lists one umbrella file with two contents | The snapshots were baked from trees the served packs do not make, and `baseTree` would hand a downstream wrong rebuild facts. When it names another release (a runtime-only successor that kept the trees, its packs the record's raw bytes), `baseTree.releaseDigest` and `baseTree.runtime` are `null`: the record cannot vouch for that release's digest or runtime |
| A snapshot entry's `runtime`, or `profiles/index.json` `runtime.buildId`, is not the `buildId` (or `runtime.leanVersion` is not the runtime's Lean) | Snapshots are binary-paired to the runtime. The index's runtime is the commit record of a promote (promote-staging.mjs) |
| A pack's `content.lean.version` is not the runtime's Lean version | The runtime does not reject oleans from another Lean version; it misreads them (the githash gate is off) |
| `public/runtime/runtime-manifest.<buildId>.json` is tracked (in `--commit` mode) or present (in `--worktree` mode) and is not byte-identical to the default manifest | The pinned shell would boot different chunk digests than the unpinned path |
| With `--dist`: `dist/workers/*` is not exactly the source's `public/workers/*` (in `--commit` mode, `git show <commit>:public/workers/*`) | The shell was not built from this tree |
| With `--dist`: the main bundle (the module script `index.html` loads) pins anything other than exactly `{buildId}`, or any other shell file embeds another `wasm64-<16 hex>` | The shell was built against a different `runtime-manifest.json` |
| With `--dist`: `dist/` contains `runtime/`, `profiles/` or `snapshots/` | Artifacts are served from R2 and must never be bundled (deploy-app.sh prunes them) |

The second group is structural. A manifest has to pass these before it can be
described at all: known schemas; served URLs spelled `/runtime/chunks/<file>`,
`/snapshots/<file>` or `/profiles/<file>`; content-addressed names (the file
name carries the first 16 hex digits of its sha256, which is what makes
`rclone copy` and the year-long immutable cache sound); chunk and part sizes
that add up to the whole; index entries that describe their manifests
(release, module count); and each profile manifest's `digest` equal to
`sha256(JSON.stringify(content))`.

Nothing in this tool reads artifact bytes. It checks the facts the tracked
files state about each other. `npm run verify:release` remains the job that
re-derives digests from the bytes themselves.

## The bundle

```sh
npm run -s build:site
node pipeline/release/write-bundle.mjs --commit HEAD --dist dist --umbrella <dir with QED64/Essential.olean*> --out <empty dir>
```

`write-bundle.mjs` (Node built-ins and `./release-manifest.mjs` only; not in
the package, it needs a checkout) writes into `--out`, which must be absent
or empty (else exit 2, before any work), through a sibling temp directory
renamed into place:

| File | Content |
|---|---|
| `release.json` | the manifest of `--commit` with the shell section of `--dist` |
| `qed64-shell.tar.gz` | every file of `dist/`, `qed64-build.json` included (5.8 MB today) |
| `qed64-manifests.tar.gz` | the tracked digest roots from the commit's git objects: `toolchain/lean4-wasm64-release.json`, `embedding/base-tree.json`, `public/runtime/runtime-manifest.json`, `public/snapshots/index.json`, `public/profiles/*.json` (1.7 MB) |
| `umbrella/QED64/Essential.olean`, `.olean.server`, `.olean.private` | `baseTree.umbrellaFiles`, each checked against its sha256 and size (396,664 + 96 + 96 bytes today; `.olean.private` because the fat tree carries it). These bytes are not in git. A downstream that rebuilds a base tree copies only that tree's `baseTree.trees.<name>.umbrella` files from here (see "Rebuilding a base tree") |
| `SHA256SUMS` | `<sha256>  <path>` of every other file, byte-ordered (`shasum -a 256 -c SHA256SUMS` checks it) |

It refuses (exit 1, one line) whatever `release-manifest.mjs` refuses, a
`dist/` whose `qed64-build.json` is missing or does not say it was built from
exactly `--commit` with `dirty: false` (`--dist was built from <c> (dirty) —
rebuild at <commit>`: a bundle is a function of its commit, so it never ships
a shell another commit or uncommitted edits made; build at the landing commit,
from a clean checkout), a shell file that changed under it, and an umbrella
file that is missing or is not the bytes `base-tree.json` names. The operator's source of the umbrella
is the adoption's `$W/lib-tree` (or `$W/lib-tree-slim` without the fat
tree): adopt-release prints the command as landing step 7.

**Reproducible.** The same commit, `dist/` and umbrella give the same bytes
on any machine: written twice, every output compares equal with `cmp`. The
tars are written in Node, not by a tar binary (macOS bsdtar has no
`--sort=name`; the GNU tar line this section used to propose is gone):
ustar; entries byte-ordered by name, with an entry for each directory;
mtime = the commit time (`git show -s --format=%ct`); uid/gid 0 and empty
uname/gname; mode 0644, 0755 for directories; names over 100 bytes split
into the ustar prefix. gzip is `node:zlib` level 9 with the header pinned
(mtime 0, OS byte 0x03), as the fork's `pack.mjs` pins it, so macOS and
Linux agree. Deflate output is a function of the zlib build, so across Node
builds compare the gunzipped tar streams; the tar stream is the identity.
Whether `vite build` itself is byte-reproducible across runners is not
established, so the shell tarball reproduces from a given `dist/`.

**PROPOSED: where it is hosted (decision 7, not applied).** Nothing here
publishes. The proposed public URL is a QED64 GitHub release asset per
release id, never a site-owned R2 path:

```
https://github.com/FawadHa1der/QED64/releases/download/<releaseId>/<file>
  release.json  qed64-shell.tar.gz  qed64-manifests.tar.gz  SHA256SUMS
  umbrella-QED64-Essential.olean  umbrella-QED64-Essential.olean.server  umbrella-QED64-Essential.olean.private
```

(GitHub release assets are flat, so `umbrella/QED64/<f>` would be uploaded as
`umbrella-QED64-<f>`; a downstream verifies each against
`baseTree.umbrellaFiles` and lays it out as `QED64/<f>`.)

## How a downstream verifies a bundle

A bundle is `release.json` plus whatever copy of the artifacts or shell you
hold: an R2 mirror, a vendored subset, or the shell tarball. Do these steps
in order. Each one trusts only the previous one.

1. **The manifest is intact.** Recompute `digest` and `artifactSetId` as
   described above. If there is a shell section, check that
   `shell.shellId === "shell-" + shell.listingSha256[:16]` and that
   `listingSha256` is the sha256 of the listing built from `shell.files`.
2. **The manifest describes the commit it names.** You need a qed64 clone that
   contains `qed64.commit`. Run
   `node pipeline/release/release-manifest.mjs --check release.json`. It
   re-derives everything from git objects and must print `matches`; add
   `--dist <extracted shell>` if the manifest has a shell section. Without the
   tool, compare each `gitBlob` with `git rev-parse <commit>:public/<path>`
   (`<commit>:<path>` for `toolchain.record` and `baseTree`, which are repo
   paths). The shipped copy (`node_modules/qed64/pipeline/release/`) takes
   `--repo <clone>`. A bundle's `qed64-manifests.tar.gz` holds those
   tracked files for a downstream without a clone.
3. **The bytes are the ones it names.** With the artifacts laid out like
   `public/` (origin-relative paths), this is enough. The directory you
   verify may be assembled from two sources: since decision 3 its
   `runtime/` and `profiles/` files (all but `profiles/index.json`) come
   from the toolchain release, `lean4-wasm64 fetch` of
   `toolchain.releaseId` pinned by `toolchain.digest` (or the R2 keys under
   `hosting.toolchainPrefix`), and its snapshots and `profiles/index.json`
   from QED64's origin; laid out side by side they are one `public/` tree:

   ```js
   // node verify-bundle.mjs release.json <dir>
   import { createHash } from "node:crypto";
   import fs from "node:fs";
   import path from "node:path";
   const [file, dir] = process.argv.slice(2);
   const m = JSON.parse(fs.readFileSync(file, "utf8"));
   const sha = (b) => createHash("sha256").update(b).digest("hex");
   const fail = (why) => { console.error(`FAIL ${why}`); process.exit(1); };
   const { digest, ...body } = m;
   if (m.schema !== "qed64.release/v1" || digest !== `sha256:${sha(JSON.stringify(body))}`) fail("manifest digest");
   const { runtime, snapshots, profiles } = m;
   if (m.artifactSetId !== `set-${sha(JSON.stringify({ runtime, snapshots, profiles })).slice(0, 16)}`) fail("artifactSetId");
   const one = (p, bytes, want) => { // stream the 320 MB snapshot in real code
     const b = fs.readFileSync(path.join(dir, p));
     if ((bytes !== null && b.length !== bytes) || sha(b) !== want) fail(p);
     return b;
   };
   for (const t of [runtime.manifest, snapshots.index, profiles.index, ...profiles.packs.map((p) => p.manifest)]) one(t.path, null, t.sha256);
   for (const f of runtime.files) {
     const whole = createHash("sha256");
     for (const c of f.chunks) whole.update(one(c.path, c.bytes, c.sha256));
     if (whole.digest("hex") !== f.sha256) fail(f.name);
   }
   for (const s of snapshots.entries) one(s.path, s.transferBytes, s.sha256);
   for (const p of profiles.packs) {
     const wire = createHash("sha256");
     for (const part of p.transport.parts) wire.update(one(part.path, part.bytes, part.sha256));
     if (wire.digest("hex") !== p.transport.sha256) fail(`${p.id} transport`);
   }
   console.log(`verified ${m.releaseId} ${m.artifactSetId}`);
   ```

   The raw pack digest (`pack.sha256`, computed over the gunzipped stream) is
   what `npm run verify:release -- --public <dir>` adds. It inflates every
   pack.
4. **The shell is the one it names.** Extract the tarball, run the `shasum`
   line above, and compare the result with `listingSha256`. The umbrella
   files: compare each `umbrella/<path>` with `baseTree.umbrellaFiles`. To
   check a base tree too, rebuild it as below and compare it with
   `baseTree.trees.<name>.files` and `.digest`.
5. **Pin by identity.** Record `releaseId` and `digest`. When you bump, an
   unchanged `artifactSetId` means no artifact moved, so the artifacts do not
   need re-verifying, and an unchanged `shellId` means the shell did not move.
   A downstream that vendors qed64 sources (lean4game, the widgets showcase)
   can record `qed64.commit` next to its vendored copy.

### Rebuilding a base tree

Each tree is rebuilt on its own, from its own entry in `baseTree.trees`;
the umbrella files are per tree, not the bundle's whole `umbrella/` set:

1. For `<name>` in `baseTree.trees` (`core-lib-slim`, `lib-tree-slim`, and
   `lib-tree` only when the release was adopted with the fat tree), start
   from one empty directory.
2. For each `trees.<name>.packs[]` entry, in order, run
   `lean4-wasm64 unpack --manifest <that pack's manifest> --out <dir>`, with
   `--slim` exactly when `trees.<name>.slim` is true. The pack's manifest is
   the toolchain release's `profiles/<id>.manifest.json` (the record's
   `packs[].manifest` for that `id`); its raw digest must be the entry's
   `rawSha256`.
3. Copy exactly the files `trees.<name>.umbrella` lists, each from the
   bundle's `umbrella/<path>` to `<dir>/<path>`, and nothing else.
   `core-lib-slim` lists none; `lib-tree-slim` lists the pair
   (`QED64/Essential.olean`, `.olean.server`); `lib-tree` adds
   `QED64/Essential.olean.private`.
4. Count the files (`trees.<name>.files`) and compute the digest by
   `baseTree.digestRule`: sha256 over the lines `<relpath>\0<sha256 hex>\n`
   of every file, relpath `/`-separated, sorted by byte order, compared with
   `trees.<name>.digest`.

This is what `adopt-release.sh` does (its `core-lib-slim`, `lib-tree-slim`,
`lib-tree` and `umbrella` steps), and the order `release-manifest.mjs`
checks: every listed pack is the record's, and every tree but
`core-lib-slim` carries the pair.

## PROPOSED: publishing from CI (not applied)

This section is a proposal for review. Neither `.github/workflows/deploy.yml`
nor the adoption lane (`pipeline/release/adopt-release.sh`, which replaced
`bump-chain.sh` in plan B2a) has been changed for it. The proposal adds three steps to
`deploy.yml`, between `npm run build:site` and `wrangler deploy`, plus a
release step after the deploy. Since plan step A4 the build, the prune and
`wrangler deploy` run inside `scripts/deploy-app.sh` (docs/DEPLOY.md, "The
deploy script"), so applying it means putting the two gates in that script
between its size check and `npx wrangler deploy`, or splitting the script;
the YAML below shows the steps in the workflow's older shape. Together they:

- generate the manifest from the CI-built `dist/`, which refuses an
  inconsistent pairing before anything deploys;
- HEAD-gate every artifact on the origin, which catches a forgotten or partial
  `upload-artifacts.sh`. Today the shell deploys anyway: its pinned manifest
  404s, and `qed64-boot.ts` silently falls back to whatever
  `runtime-manifest.json` R2 still serves, which may be the previous runtime;
- publish the bundle (`write-bundle.mjs`) as a GitHub release, once per
  artifact set.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write          # gh release create (tags + release assets); nothing else
    steps:
      # … existing checkout / setup-node / npm ci / tests / build:site / prune …
      - name: Release manifest (refuses an inconsistent pairing before anything deploys)
        run: node pipeline/release/release-manifest.mjs --commit "$GITHUB_SHA" --dist dist --out manifest-check.json
      - name: Gate every artifact on the origin (R2 holds what this commit names)
        env:
          QED64_ORIGIN: ${{ vars.QED64_ORIGIN }}   # e.g. https://qed64.<account>.workers.dev
        run: node pipeline/release/gate-origin.mjs manifest-check.json   # sketched below; not in the tree
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: The bundle (write-bundle.mjs; the umbrella bytes are not in git)
        run: |
          # The umbrella comes from the previous release's assets while baseTree.umbrellaFiles is unchanged
          # (write-bundle refuses any other bytes); an adoption that rebuilds it uploads the new files first.
          mkdir -p umbrella/QED64
          LAST=$(gh release list --limit 1 --json tagName --jq '.[0].tagName')
          for f in Essential.olean Essential.olean.server Essential.olean.private; do
            gh release download "$LAST" -p "umbrella-QED64-$f" -O "umbrella/QED64/$f"
          done
          node pipeline/release/write-bundle.mjs --commit "$GITHUB_SHA" --dist dist --umbrella umbrella --out release
        env:
          GH_TOKEN: ${{ github.token }}
      - name: GitHub release, once per artifact set
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          SET=$(node -p 'require("./release/release.json").artifactSetId')
          ID=$(node -p 'require("./release/release.json").releaseId')
          LAST=$(gh release list --limit 1 --json tagName --jq '.[0].tagName' || true)
          if [ -n "$LAST" ] && gh release download "$LAST" -p release.json -O - | grep -q "\"artifactSetId\": \"$SET\""; then
            echo "artifact set $SET already released as $LAST"; exit 0
          fi
          for f in release/umbrella/QED64/*; do cp "$f" "release/umbrella-QED64-$(basename "$f")"; done
          gh release create "$ID" release/*.json release/*.tar.gz release/SHA256SUMS release/umbrella-QED64-* --target "$GITHUB_SHA" --title "QED64 $ID ($SET)" \
            --notes "runtime $(node -p 'require("./release/release.json").runtime.buildId'), verify: docs/RELEASE-BUNDLE.md"
```

The gate script (`gate-origin.mjs`) would be about 30 lines. It collects every
path in the manifest: the runtime manifest and its `pinnedPath`, every chunk,
the snapshot index and snapshots, the profile index, the manifests and every
part. 87 paths today.

- For each content-addressed path it sends a `HEAD` request through a small
  pool and requires a 200 with `content-length` equal to the recorded size.
- The mutable files cannot be gated by name: the default and pinned runtime
  manifests, the snapshot and profile indexes, and the profile manifests,
  12 MB in total. It fetches them and requires each sha256 to match the
  manifest; the pinned copy must match `runtime.manifest.sha256`. That is the
  real check that R2 already serves the promote this commit names, following
  the order in DEPLOY.md "Atomic promotes".

Notes on the proposal:

- **HEAD requests through `infra/worker.js`.** The worker has no HEAD branch,
  so a HEAD request does a full `ARTIFACTS.get` and the runtime discards the
  body. That works, and costs one R2 read per object (about 87 per deploy,
  well inside the free tier). An explicit
  `if (request.method === "HEAD") env.ARTIFACTS.head(key)` branch that sets
  `content-length` from `object.size` would make the gate cheap and exact.
  That would change the worker, so it is left for decision.
- **Credentials stay as they are.** The gate uses only the public origin. The
  CI token keeps its "Workers Scripts: Edit only, no R2" scope (DEPLOY.md
  security model). `contents: write` is new, and it means anyone who can push
  to `main` can mint releases. Protect the branch first.
- **What CI tarballs are reproducible against.** The bundle is reproducible
  for a given `dist/` (["The bundle"](#the-bundle)); a runner and a laptop
  write the same tar streams. Whether `vite build` itself is
  byte-reproducible across runners is not established. The `shellId`
  recorded is that of the build that was deployed, which is the one that
  matters.
- **When to release.** The step above releases once per artifact set, which is
  once per promote. Shell-only pushes are deployed but not released.
  Releasing every push, or only on `workflow_dispatch`, are alternatives.

## Garbage collection (not decided)

`upload-artifacts.sh` uses `rclone copy`, never `sync`, so R2 only grows. Every
promote leaves the previous runtime's chunks behind, and a version import also
leaves its packs, about 1.6 GB per artifact set against the 10 GB free tier.
With release manifests the live set has a definition: the union of all paths in
the manifests of the releases that are still deployable. Any object in the
bucket outside that union is garbage. The policy itself still has to be
decided: how many artifact sets to keep, or for how long; whether a downstream
pin (lean4game, the widgets showcase) keeps a set alive; and who runs the
delete with which token, given that the R2 token is local-only by design. None
of that is implemented here.
