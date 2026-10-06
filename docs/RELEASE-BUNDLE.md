# The release manifest (`qed64.release/v1`)

A QED64 release is deployed through two channels that never meet: the app
shell goes out via `git push` (`.github/workflows/deploy.yml`), and the runtime,
snapshots and library packs via `scripts/upload-artifacts.sh` into R2. The facts
that pair them live in five tracked files: `pipeline/toolchain/KERNEL-PIN`,
`public/runtime/runtime-manifest.json`, `public/snapshots/index.json`,
`public/profiles/index.json` and the profile manifests. Before this manifest a
downstream that wanted to pin "the QED64 it tested against" had to pin a git
commit and then re-derive everything from those files. Downstreams include
lean4game, which vendors qed64 at its own pin, and the widgets showcase, which
vendors `pipeline/snapshot/` and three pipeline modules. Re-deriving also
meant trusting that the five files agree with each other.

`pipeline/release/release-manifest.mjs` writes one document per release. It
names every served object by sha256 and gives the release three identities. It
refuses to write anything while the pairing facts disagree. Generating and
checking the manifest are implemented. **Publishing it (CI, GitHub releases) is
proposed below and has not been applied.**

## What it is

```sh
node pipeline/release/release-manifest.mjs --commit HEAD --out release.json         # from git objects only
node pipeline/release/release-manifest.mjs --worktree                               # public/ as on disk (after a promote, before the commit)
node pipeline/release/release-manifest.mjs --commit HEAD --dist dist --out release.json   # + the app shell (after npm run build:site)
node pipeline/release/release-manifest.mjs --check release.json [--dist dist]        # regenerate and compare byte for byte
node pipeline/release/release-manifest.mjs --help                                   # reads and writes nothing
```

`--commit <rev>` reads every input with `git cat-file blob <rev>:<path>`, which
returns the same raw blob `git show <rev>:<path>` prints. It never reads the
working tree, so the output is a pure function of the commit: the same bytes on
any machine, with no network access and no artifact downloads. A shallow CI
checkout is enough. Every digest and size comes from the tracked manifests,
which are the same digest roots the browser verifies against. The current
HEAD's manifest is about 23 KB, or 34 KB with the shell section. It describes
87 origin objects and 1.65 GB on the wire.

| Key | Content |
|---|---|
| `schema` | `"qed64.release/v1"` |
| `digest` | `"sha256:" + sha256(JSON.stringify(manifest without digest))`: the manifest's own identity |
| `releaseId` | `"qed64-" + qed64.commit[:7]` |
| `artifactSetId` | `"set-" + sha256(JSON.stringify({runtime, snapshots, profiles}))[:16]` (see below) |
| `qed64` | `{repo, commit, committedAt (UTC, from the commit object), source: "commit"\|"worktree", dirty}`. `dirty` is true only for `--worktree` when an input differs from HEAD. With `--dist` the inputs include `public/workers/*`, so an edited worker, or one HEAD has and the tree lacks, makes it dirty |
| `lean` | `{version, target}` of the runtime manifest |
| `kernel` | `{repo: "FawadHa1der/lean4", branch: "qed64-wasm64", commit (KERNEL-PIN), sourceRevision (runtime manifest)}` |
| `runtime` | `{buildId, manifest {path, sha256, gitBlob, pinnedPath}, files [{name, bytes, sha256, chunks [{path, bytes, sha256}]}]}` |
| `snapshots` | `{index {path, sha256, gitBlob}, entries [{name, path, sha256, transferBytes, rawBytes, imports, runtime}]}` |
| `profiles` | `{index {…}, packs [{id, release, modules, manifest {path, sha256, gitBlob, contentDigest}, lean {version, gitRevision}, pack {sha256, bytes}, transport {sha256, bytes, parts [{path, sha256, bytes}]}}]}` |
| `shell` | `null`, or with `--dist`: `{shellId, listingSha256, bytes, bundle {entries, buildIds}, files [{path, sha256, bytes}]}` |

Conventions:

- **Key order is fixed by the generator.** Every object is built literally.
  The file is `JSON.stringify(m, null, 2) + "\n"`. `JSON.parse` keeps key
  order, so a reader can recompute both digests from the parsed object.
- **Every `path` is relative to the origin root.** The origin root is also the
  R2 bucket root and `public/` in git. For example, `runtime/chunks/lean.wasm.5500c87f….part-000`
  is served at `/runtime/chunks/…`, stored under the R2 key `runtime/chunks/…`,
  and `gitBlob` is git's blob id of `public/<path>`.
- **Field names tell you the digest format.** Fields named `sha256` hold bare
  hex. `digest` and `contentDigest` keep the `sha256:` prefix, which matches
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

## What it refuses

Every refusal exits 1 with one line on stderr
(`release-manifest: REFUSED: <reason>`) and writes nothing. Usage errors exit
2. The first group covers pairing facts the browser cannot check, so they are
checked here instead:

| Refusal | Why it matters |
|---|---|
| The commit prefix in the runtime manifest's `sourceRevision` (`qed64-wasm64@<commit>`) is not a prefix of the KERNEL-PIN commit, or there is no commit in it | The pin and the served binary disagree, so a rebuild from the pin will not reproduce what is served (REBUILD.md) |
| KERNEL-PIN does not contain the runtime `buildId` | The pin does not record the pairing it claims (REBUILD.md §3: "write KERNEL-PIN") |
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
   tool, compare each `gitBlob` with `git rev-parse <commit>:public/<path>`.
3. **The bytes are the ones it names.** With the artifacts laid out like
   `public/` (origin-relative paths), this is enough:

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
   line above, and compare the result with `listingSha256`.
5. **Pin by identity.** Record `releaseId` and `digest`. When you bump, an
   unchanged `artifactSetId` means no artifact moved, so the artifacts do not
   need re-verifying, and an unchanged `shellId` means the shell did not move.
   A downstream that vendors qed64 sources (lean4game, the widgets showcase)
   can record `qed64.commit` next to its vendored copy.

## PROPOSED: publishing from CI (not applied)

This section is a proposal for review. Neither `.github/workflows/deploy.yml`
nor the adoption lane (`pipeline/release/adopt-release.sh`, which replaced
`bump-chain.sh` in plan B2a) has been changed for it. The proposal adds three steps to
`deploy.yml`, between `npm run build:site` and `wrangler deploy`, plus a
release step after the deploy. Together they:

- generate the manifest from the CI-built `dist/`, which refuses an
  inconsistent pairing before anything deploys;
- HEAD-gate every artifact on the origin, which catches a forgotten or partial
  `upload-artifacts.sh`. Today the shell deploys anyway: its pinned manifest
  404s, and `qed64-boot.ts` silently falls back to whatever
  `runtime-manifest.json` R2 still serves, which may be the previous runtime;
- publish reproducible tarballs and the manifest as a GitHub release, once
  per artifact set.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write          # gh release create (tags + release assets); nothing else
    steps:
      # … existing checkout / setup-node / npm ci / tests / build:site / prune …
      - name: Release manifest (refuses an inconsistent pairing before anything deploys)
        run: mkdir -p release && node pipeline/release/release-manifest.mjs --commit "$GITHUB_SHA" --dist dist --out release/release.json
      - name: Gate every artifact on the origin (R2 holds what this commit names)
        env:
          QED64_ORIGIN: ${{ vars.QED64_ORIGIN }}   # e.g. https://qed64.<account>.workers.dev
        run: node pipeline/release/gate-origin.mjs release/release.json   # sketched below; not in the tree
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
      - name: Reproducible tarballs
        run: |
          EPOCH=$(git show -s --format=%ct "$GITHUB_SHA")
          tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner \
              --mode='u+rwX,go+rX,go-w' --format=gnu -C dist -cf - . | gzip -n -9 > release/qed64-shell.tar.gz
          # the digest roots, for downstreams without a git clone (git archive is reproducible by construction)
          git archive --format=tar "$GITHUB_SHA" pipeline/toolchain/KERNEL-PIN public/runtime/runtime-manifest.json \
              public/snapshots/index.json public/profiles | gzip -n -9 > release/qed64-manifests.tar.gz
          (cd release && sha256sum release.json qed64-shell.tar.gz qed64-manifests.tar.gz > SHA256SUMS)
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
          gh release create "$ID" release/* --target "$GITHUB_SHA" --title "QED64 $ID ($SET)" \
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
- **What CI tarballs are reproducible against.** The tarball is reproducible
  for a given `dist/`: name-sorted, mtime set to the commit time, numeric
  owner 0, normalized modes, `gzip -n`. Whether `vite build` itself is
  byte-reproducible across runners is not established. The `shellId` recorded
  is that of the build that was deployed, which is the one that matters.
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
