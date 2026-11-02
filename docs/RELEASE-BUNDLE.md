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
Nothing publishes it: downstreams pin QED64 by commit
(`github:FawadHa1der/QED64#<sha>`, docs/EMBEDDING.md §6) and derive the
manifest from that commit. The release bundle that was to carry it with the
shell and the umbrella (`write-bundle.mjs`, plan B2c) was retired unpublished
on 2026-11-01 (architecture review D11, decision 7; git keeps d4f67e0 and
c24cee7). The umbrella's bytes are committed at `embedding/umbrella/QED64/`
beside `embedding/base-tree.json`.

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
| `baseTree` | `{path, sha256, gitBlob, schema, releaseId, releaseDigest, runtime, packs [{id, release, rawSha256}], slim, umbrella [{path, sha256, bytes}], umbrellaSource, initLib, digestRule, trees {<name>: {slim, packs, umbrella, files, bytes, digest}}, umbrellaFiles [{path, sha256, bytes}]}`: `embedding/base-tree.json` (`qed64.base-tree/v1`, written by `adopt-helper.mjs base-tree`), built field by field, plus `umbrellaFiles`, the union of the umbrella files the trees carry (the files committed at `embedding/umbrella/<path>`). `releaseDigest` and `runtime` are the record's `digest` and `runtime.buildId` when `releaseId` is the record's `id` (anything else is refused), and `null` when it names another release |
| `runtime` | `{buildId, manifest {path, sha256, gitBlob, pinnedPath}, files [{name, bytes, sha256, encoding?, chunks [{path, bytes, sha256, decodedBytes?}]}]}` |
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
  fetches it first (`lib/qed64-boot.ts`), and it must be
  byte-identical to `runtime.manifest`.
- A runtime file's `encoding` and its chunks' `decodedBytes` appear only for
  a v2 runtime (`org.lean-browser64.runtime/v2`: gzip runtime parts). A
  file's `bytes`/`sha256` are the decoded file's and a chunk's are the part
  as served. A v1 runtime's section, and so `artifactSetId`, is unchanged.
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
| `baseTree.sha256`, `baseTree.umbrellaFiles[]`, `baseTree.digestRule` | hex; `{path, sha256, bytes}`; string | the identity of `embedding/base-tree.json`, the umbrella files the trees carry (the union over the trees; committed at `embedding/umbrella/<path>`), and the rule the tree digests follow |
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
| The record's `runtime.buildId` is not the served `buildId`, or its `runtime.schema` (additive in `lean4-wasm64.release/v1`; absent = `org.lean-browser64.runtime/v1`) is not the served runtime manifest's `schema` | The pinned release and the served runtime are different builds (land the adoption's runtime manifest with its record); a buildId is never re-chunked in another format |
| The commit prefix in the runtime manifest's `sourceRevision` (`qed64-wasm64@<commit>`) is not a prefix of the record's `kernel.commit`, or there is no commit in it | The record and the served binary disagree, so a rebuild from the pin will not reproduce what is served (REBUILD.md) |
| A file the hosting rule stores under the toolchain prefix (the runtime manifest and its per-build copy `runtime/runtime-manifest.<buildId>.json`, always, whether or not the record lists it; every profile manifest except `profiles/index.json`; every chunk and part) is not in the record's `files` with that sha256 and size | The Worker serves that path from `lean4-wasm64/<id>/`, where the release's bytes are, not QED64's. The pinned shell fetches the per-build copy first |
| `base-tree.json` lists a pack, at the top or in any `trees.<name>.packs`, that the record does not carry, or with another raw digest (or another `release`, when given) than the record's, whatever release it names; it names the record's own release id with another `releaseDigest` or `runtime` than the record's; its top-level `packs` are not exactly the served packs (matched by the record's pack `manifest` path); the top-level `umbrella` lacks `QED64/Essential.olean` or lists `.olean.private`; a tree other than `core-lib-slim` does not carry exactly the top's umbrella files (a fat tree may add `.olean.private`, a slim one may not); or it lists one umbrella file with two contents | The snapshots were baked from trees the served packs do not make, and `baseTree` would hand a downstream wrong rebuild facts. When it names another release (a runtime-only successor that kept the trees, its packs the record's raw bytes), `baseTree.releaseDigest` and `baseTree.runtime` are `null`: the record cannot vouch for that release's digest or runtime |
| A snapshot entry's `runtime`, or `profiles/index.json` `runtime.buildId`, is not the `buildId` (or `runtime.leanVersion` is not the runtime's Lean) | Snapshots are binary-paired to the runtime. The index's runtime is the commit record of a promote (promote-staging.mjs) |
| A pack's `content.lean.version` is not the runtime's Lean version | The runtime does not reject oleans from another Lean version; it misreads them (the githash gate is off) |
| `public/runtime/runtime-manifest.<buildId>.json` is tracked (in `--commit` mode) or present (in `--worktree` mode) and is not byte-identical to the default manifest | The pinned shell would boot different chunk digests than the unpinned path |
| With `--dist`: `dist/workers/*` is not exactly the source's `public/workers/*` (in `--commit` mode, `git show <commit>:public/workers/*`) | The shell was not built from this tree |
| With `--dist`: the main bundle (the module script `index.html` loads) pins anything other than exactly `{buildId}`, or any other shell file embeds another `wasm64-<16 hex>` | The shell was built against a different `runtime-manifest.json` |
| With `--dist`: `dist/` contains a file under `runtime/`, `profiles/` or `snapshots/` other than `profiles/index.json` and `snapshots/index.json`, or one of those two differs from the tracked index | The deploy serves those two from the shell; everything else is served from R2 and never bundled (deploy-app.sh prunes it) |

The second group is structural. A manifest has to pass these before it can be
described at all: known schemas (the runtime manifest's:
`RUNTIME_MANIFEST_SCHEMAS`, equal to closure.json `runtime.manifestSchemas`);
served URLs spelled `/runtime/chunks/<file>`,
`/snapshots/<file>` or `/profiles/<file>`; content-addressed names (the file
name carries the first 16 hex digits of its sha256, which is what makes
`rclone copy` and the year-long immutable cache sound); chunk and part sizes
that add up to the whole (a v2 runtime's chunks by their `decodedBytes`, with
the file's `encoding` one v2 allows, every chunk but the last exactly
16,777,216 bytes decoded, and no `encoding` in a v1 file); index entries
that describe their manifests (release, module count); and each profile
manifest's `digest` equal to `sha256(JSON.stringify(content))`.

Nothing in this tool reads artifact bytes. It checks the facts the tracked
files state about each other. `npm run verify:release` remains the job that
re-derives digests from the bytes themselves.

## How a downstream verifies a release

You hold `release.json` (`release-manifest.mjs --commit <sha>` in a clone, or
the shipped copy with `--repo`) plus whatever copy of the artifacts or shell
you hold: an R2 mirror, a vendored subset, or a built `dist/`. Do these steps
in order. Each one trusts only the previous one.

1. **The manifest is intact.** Recompute `digest` and `artifactSetId` as
   described above. If there is a shell section, check that
   `shell.shellId === "shell-" + shell.listingSha256[:16]` and that
   `listingSha256` is the sha256 of the listing built from `shell.files`.
2. **The manifest describes the commit it names.** You need a qed64 clone that
   contains `qed64.commit`. Run
   `node pipeline/release/release-manifest.mjs --check release.json`. It
   re-derives everything from git objects and must print `matches`; add
   `--dist <the built shell>` if the manifest has a shell section. Without the
   tool, compare each `gitBlob` with `git rev-parse <commit>:public/<path>`
   (`<commit>:<path>` for `toolchain.record` and `baseTree`, which are repo
   paths). The shipped copy (`node_modules/qed64/pipeline/release/`) takes
   `--repo <clone>`.
3. **The bytes are the ones it names.** With the artifacts laid out like
   `public/` (origin-relative paths), this is enough. The directory you
   verify may be assembled from two sources: since decision 3 its
   `runtime/` and `profiles/` files (all but `profiles/index.json`) come
   from the toolchain release, `lean4-wasm64 fetch` of
   `toolchain.releaseId` pinned by `toolchain.digest` (or the R2 keys under
   `hosting.toolchainPrefix`), and its snapshots and `profiles/index.json`
   from QED64's origin; laid out side by side they are one `public/` tree:

   ```js
   // node verify-artifacts.mjs release.json <dir>
   import { createHash } from "node:crypto";
   import fs from "node:fs";
   import path from "node:path";
   import { gunzipSync } from "node:zlib";
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
     for (const c of f.chunks) {
       const b = one(c.path, c.bytes, c.sha256); // as served; a v2 runtime's gzip part is hashed inflated
       whole.update(f.encoding === "gzip" ? gunzipSync(b) : b);
     }
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
4. **The shell is the one it names.** In the built shell (`dist/`), run the
   `shasum` line above and compare the result with `listingSha256`. The
   umbrella files: compare each `embedding/umbrella/<path>` of `qed64.commit`
   with `baseTree.umbrellaFiles`. To check a base tree too, rebuild it as
   below and compare it with `baseTree.trees.<name>.files` and `.digest`.
5. **Pin by identity.** Record `releaseId` and `digest`. When you bump, an
   unchanged `artifactSetId` means no artifact moved, so the artifacts do not
   need re-verifying, and an unchanged `shellId` means the shell did not move.
   A downstream that vendors qed64 sources (lean4game, the widgets showcase)
   can record `qed64.commit` next to its vendored copy.

### Rebuilding a base tree

Each tree is rebuilt on its own, from its own entry in `baseTree.trees`;
the umbrella files are per tree, not the whole `embedding/umbrella/` set:

1. For `<name>` in `baseTree.trees` (`core-lib-slim`, `lib-tree-slim`, and
   `lib-tree` only when the release was adopted with the fat tree), start
   from one empty directory.
2. For each `trees.<name>.packs[]` entry, in order, run
   `lean4-wasm64 unpack --manifest <that pack's manifest> --out <dir>`, with
   `--slim` exactly when `trees.<name>.slim` is true. The pack's manifest is
   the toolchain release's `profiles/<id>.manifest.json` (the record's
   `packs[].manifest` for that `id`); its raw digest must be the entry's
   `rawSha256`.
3. Copy exactly the files `trees.<name>.umbrella` lists, each from
   `embedding/umbrella/<path>` at the release's `qed64.commit` (`git show
   <commit>:embedding/umbrella/<path> > <dir>/<path>`; committed since
   2026-11-01, review D9; for an older commit, the adopting checkout's
   `work/adopt/<id>/umbrella/`) to `<dir>/<path>`, and nothing else.
   `core-lib-slim` lists none; `lib-tree-slim` lists the top-level
   `umbrella` (`QED64/Essential.olean`, and `.olean.server` for a split
   umbrella); `lib-tree` lists the same, plus `QED64/Essential.olean.private`
   when the umbrella has one.
4. Count the files (`trees.<name>.files`) and compute the digest by
   `baseTree.digestRule`: sha256 over the lines `<relpath>\0<sha256 hex>\n`
   of every file, relpath `/`-separated, sorted by byte order, compared with
   `trees.<name>.digest`.

This is what `adopt-release.sh` does (its `core-lib-slim`, `lib-tree-slim`,
`lib-tree` and `umbrella` steps), and the order `release-manifest.mjs`
checks: every listed pack is the record's, and every tree but
`core-lib-slim` carries exactly the umbrella files the top lists (a fat tree
also `.olean.private`).

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
