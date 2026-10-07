<!-- Written by the lean4game session on 2026-10-05 from a four-researcher study and three judges (its full study lives in the owner's work/arch-strategy/, gitignored); reviewed by the QED64 and widgets sessions; owned by the QED64 session from 2026-10-05 17:00. Decisions in §8 are the owner's; decision 1 was taken on 2026-10-05 (A); decisions 3 and 10 on 2026-10-06 (the recommendations); the rest are open. -->

# Lean 4 on wasm64: one toolchain, one library, three sites

Strategy proposal, 2026-10-05. For the owner and the kernel, QED64, lean4game and widgets sessions. No implementation yet.

> **Retired 2026-10 (plan B2c):** `pipeline/toolchain/KERNEL-PIN`, which this document cites, is deleted; the kernel pin is the pinned release record's `kernel.commit` (`toolchain/lean4-wasm64-release.json`, and `toolchain.kernel.commit` in `qed64.release/v1`, docs/RELEASE-BUNDLE.md).
>
> **Executed on QED64's side, 2026-10-06 (docs/ARCHITECTURE-PLAN-QED64.md):** the toolchain lane this document describes in the present tense is deleted: `pipeline/toolchain/{build.sh,finish.sh,setup-source.sh,README.md}` and the patch copies in plan B1, `pipeline/release/import-packs.sh` and `bump-chain.sh` in plan B2a (replaced by `pipeline/release/adopt-release.sh`). Its `4.33.0-pre` mentions are that removed lane's defaults and lean4game's runtime of the day, not a served runtime. The pairing QED64 serves is in docs/PROVENANCE.md.

How it was made: four read-only researchers mapped the kernel fork, QED64, lean4game and the widgets showcase; three candidate layerings were worked out and scored by three judges (a long-term maintainer, an outside Lean developer, a release engineer); twelve load-bearing claims of the winner were each checked adversarially against the repositories (six were corrected; the corrections are folded in below); the QED64 and widgets sessions answered a fact-and-view questionnaire (`peer-qed64.md`, `peer-widgets.md`). The full study (42 k words of evidence with file:line citations) is in `workflow-proposal.md`, `research.md`, `judgements.json` and `verified-claims.json` next to this file.

## 1. The decision in one paragraph

Three layers, three owners, no new repo. **The Lean fork** (`FawadHa1der/lean4`, branch `qed64-wasm64`) owns the whole wasm64 toolchain: the compiler, the Docker build, the gate, the export contract, the native compiler, the Mathlib tree, the library packs and the runtime chunks, and it **publishes a versioned, checksummed release per gated build**. **QED64** owns everything that is about running Lean in a page: the worker protocol, the library (`qed64/embed`), the snapshot format and bake, the page, and it publishes an npm package plus a per-promote release. **Sites** (lean4game, widgets, anyone else) pin two lines, one per layer, and build and publish only their own content (game snapshots, widget overlays). A project that wants only Lean 4 on wasm64 pins the first layer and never sees QED64. All three judges chose this shape over "QED64 owns the toolchain" (worst outsider story, a `git merge` of the compiler driven from the editor's repo) and over a fourth "toolchain" repo (same de-duplication, one more repo and pin, a gate that no longer runs from the compiler checkout). Both peer sessions agree with the layering.

## 2. Today, and what exists twice

```
leanprover/lean4 tags ──merge──► FawadHa1der/lean4 @ qed64-wasm64 (a8817d0, patches 0001–0035b)
                                   wasm64-build/: build, gate, gen-exports, native64, mathlib-tree, import-release
                                   publishes NOTHING (no tag, no CI on the branch); output = local build dirs (12–18 GB)
        ┌───────────────────────────┴──────────────────────────┐
QED64 main                                              lean4game (submodule wasm/kernel @ 992dc94, older pin)
  pipeline/toolchain = stale copy of the kernel lane       builds a SECOND runtime (4.33.0-pre) for the same lineage,
  chunk → pack → bake → promote → R2 root                  repairs the link with QED64's gen-exports, skips the gate,
  publishes: npm git dep, the page; no release record     re-packs lean-core, 805 lines of compat Lean; R2 lean4game/
        │ submodule + the owner's untracked work/ trees
widgets showcase: rebuilds QED64's page from source; fetches 81 binaries from QED64's live site (no retention
  promise); re-uploads 2.4 GB to R2 qed64-showcase/; its lock re-derives kernel + native64 + Docker + Mathlib identity
```

| Exists twice (or three times) | Where | Cost |
|---|---|---|
| `build.sh`, `gate.mjs`, `gen-exports.py`, `node-runner.mjs`, `persistent-probe.mjs`, 4 probe files | kernel fork and QED64, diverged | QED64's `gen-exports.py` needs a file deleted on 2026-09-21; its gate lacks the 0035 gates; the served binary was built by the kernel's lane, not QED64's |
| The patch series | kernel git history + `PATCHES.md`; QED64 `patches/` (35 files, never applied) | stale provenance copy |
| The runtime binary | QED64 `wasm64-3ab1c6a9…` (4.34.0); lean4game `wasm64-d77d34b9…` (4.33.0-pre) | two runtimes, two snapshot sets, two kernel pins for one lineage |
| Artifact bytes in R2 | QED64 root 1.3 GB; widgets `qed64-showcase/` 1.3 GB (same bytes) + stock snapshots; lean4game 0.26 GB | three prefixes, one bucket |
| The kernel pin | QED64 `KERNEL-PIN` prose; lean4game `KERNEL-PIN` + patch line; widgets lock JSON | three formats for one fact |
| Release records | QED64 five tracked manifests (no release); lean4game `BUNDLE.json` tarballs on GitHub; widgets lock with 145 hashes | each site reconstructs the record QED64 never publishes |

## 3. The layering

```
L1  FawadHa1der/lean4 @ qed64-wasm64            "the toolchain"            owner: the kernel session + the owner's push
    src/ + patch history · docker-wasm64/ · wasm64-build/{build,native64,mathlib-tree,import-release}.sh · gen-exports.py
    wasm64-build/js/  (npm package `lean4-wasm64`; node: built-ins only, no node_modules in the fork):
       gate.mjs node-runner.mjs persistent-probe.mjs probes/     (already here)
       artifact-id.mjs chunk-runtime.mjs pack/unpack/olean-imports/inspect.mjs verify-release.mjs   (moved from QED64)
       release.mjs fetch-release.mjs cli.mjs formats/ (the manifest schemas)                         (new, ~400 lines, ported)
    PUBLISHES per gated build: GitHub Release `lean-v4.34.0-a8817d0` + the same bytes under R2 `lean4-wasm64/<id>/`
       release.json · SHA256SUMS · tools tgz · runtime pair (lean.js+lean.wasm) · chunks + manifest · packs · native64.tar.gz
         │ one package.json line (tgz URL; the lockfile records its integrity)
L2  QED64                                        "the library and the page"   owner: the QED64 session
    embed · public/workers · frontend · pipeline/snapshot (bake, probes, supervised-run) · gen-umbrella
    pipeline/release (stage-profiles, promote-staging, adopt-release) · infra/worker.js · embedding/closure.json
    PUBLISHES: the npm git dependency (./embed, ./workers/*, ./pipeline/snapshot/*, closure.json)
               per promote: qed64.release/v1 (references the L1 release id) · qed64-shell.tar.gz · manifests · umbrella pair
         │ `"qed64": "github:FawadHa1der/QED64#<sha>"` (+ the L1 line)
L3  lean4game (catalog, game patches, game bakes, R2 lean4game/)   widgets (overlays, gallery, R2 qed64-showcase/)
    toolchain-only projects: pin L1 only
```

**L1, the toolchain.** Keeps everything it has (compiler source, patch history, Docker recipe, build/gate/exports/native64/Mathlib scripts, the import driver and its Monday watcher) and gains `wasm64-build/js/`: the chunker, packer, olean reader, verifier, release writer and fetcher. All of them import only Node built-ins and each other (checked file by file), so the fork never acquires `node_modules`; `wasm64-build/` is fork-only and no upstream merge has ever touched it, so this is merge-safe. The kernel session stages a release at the end of its existing lane (`import-release.sh run` gains `pack`, `chunk`, `release`); the owner publishes it (tag push, `gh release create`, `rclone copy --immutable`), which is the ship-gate rule already in force.

**L2, QED64.** Keeps what is QED64-specific and deletes its copy of the kernel lane. It stops building or chunking a runtime: it pins an L1 release like everyone else, and its own site serves the release's bytes from the shared R2 prefix. It publishes what lean4game already consumes (the npm git dependency) and, applying QED64's own unapplied `RELEASE-BUNDLE.md` proposal, a per-promote release: a release record that references the L1 release id, a reproducible page build (determinism proven 58/58 across macOS and Linux by widgets), the tracked manifests, and the small umbrella pair every bake against the stock page needs.

**L3, sites.** lean4game keeps its catalog, game patches, game compiles, game bakes and its edge worker; widgets keeps its overlays, gallery and lock. Each pins two lines, uploads only its own snapshots or overlays, and routes `/runtime/*` and `/profiles/*` to the shared release prefix in the same bucket.

### Who maintains the kernel toolchain: the kernel fork, through the kernel session. Not QED64.

1. The served binary was built by the kernel's lane (QED64's own `KERNEL-PIN:9-11` and `PROVENANCE.md:20` say so). QED64's copies are the ones that drifted, per the research (not QED64's own finding): its `gen-exports.py:72` reads `emscripten-exports.wanted.txt`, a file that exists at lean4game's pin 992dc94 but not at the current pin a8817d0, so it cannot run against the served kernel; its `gate.mjs` (103 lines) lacks the task-storm, stream-leak and parking gates the kernel's (138 lines, 13 gates) has; its README and PATCHES.md describe 4.33. Keeping toolchain code away from the compiler it drives is the arrangement that failed.
2. The kernel lane already produces every release input (`BUILT-COMMIT`, `GATE-PASSED`, `NATIVE-COMMIT`, `MATHLIB-COMMIT`, the trees) and already runs the import driver and the weekly watcher. Adding pack, chunk and release is ~700 moved and ~400 new lines inside one existing lane, not a new boundary.
3. A toolchain-only project expects the compiler repo to publish its binaries, as upstream `leanprover/lean4` does.
4. One hand-off per Lean bump instead of three: the kernel session cuts `lean-v4.35.0-<k7>`, the owner publishes, each app bumps one line and rebakes its own snapshots.

QED64's session agrees, and adds two conditions I adopt: the patch series stays git history (the `patches/` directory is provenance only); and QED64 keeps a small **acceptance test** of its own (the module-semantics probes it needs for its page), run in `adopt-release` on top of the package's runner, while the kernel's gate answers "the build is right". The two stop being diverged copies of one script.

**If the owner prefers QED64 to own the toolchain** (candidate B): QED64 keeps `pipeline/toolchain/` as the home of the import driver, Mathlib tree, chunking and packing, deletes only its stale build/gate/exports copies, and publishes `qed64.release/v2` with toolchain fields; the fork publishes nothing. It is the cheapest migration (most of it exists at 90aef68) and the worst outsider story: the import driver runs `git merge` in a repo it does not live in, Node runners stay duplicated, and a toolchain-only user must install an editor's package to unpack a library. All three judges ranked it last.

## 4. The three consumer paths after migration

**A. Lean 4 on wasm64 only (no editor, no QED64).**
1. `npm i https://github.com/FawadHa1der/lean4/releases/download/lean-v4.34.0-a8817d0/lean4-wasm64-….tgz`, or without Node: `gh release download … -p release.json -p SHA256SUMS -p runtime-pair.tar` and `sha256sum -c`.
2. `npx lean4-wasm64 fetch --only runtime --out ./lean64`: `lean.js`, `lean.wasm`, checksums verified, build id recomputed.
3. Run under Node: `node --stack-size=8192 node_modules/lean4-wasm64/node-runner.mjs --artifact ./lean64 Foo.lean`; prove the build with `npx lean4-wasm64 gate --minimal`.
4. Serve in a browser: follow `EMBED-RUNTIME.md` (the full worker ABI, which today is documented only in two names in `PATCHES.md`) and `formats/HOSTING.md` (COOP/COEP, Memory64, 25 MiB per file on Pages); `fetch --only runtime-chunks` gives the served layout.
5. Libraries: `fetch --only lean-core[,mathlib-essential]` then `unpack --slim`.
6. Own oleans: `fetch --only native64`, build the Docker image from `docker-wasm64/` at the release's recipe commit, compile inside it (Linux aarch64 only, as today).
7. Change the compiler: clone the branch at `release.json.kernel.commit`, `wasm64-build/build.sh`, gate. Unchanged and self-proving from the checkout.

**B. Library embedder (the lean4game shape).** Two `package.json` lines (L1 tgz, QED64 sha); a preflight compares `release.json.kernel.patch` with QED64's `closure.json.runtime.minKernelPatch`; `fetch` the runtime and packs; compile your Lean with the release's native compiler in the image; bake with `node_modules/qed64/pipeline/snapshot/bake-snapshot.mjs --artifact <release>/runtime --lib … --work … --out …` (no path defaults into any repo any more, so nothing is copied out of `node_modules`); build the page on `qed64/embed`; the edge worker maps `/runtime/*` and `/profiles/*` to the shared prefix; upload snapshots only. Disk ≈ 12 GB instead of ≈ 40; no kernel clone, no Docker for linking.

**C. Page embedder (the widgets shape).** Light path: download `qed64-shell.tar.gz`, the manifests and `release.json` for the pinned QED64 release, verify the shell id, `fetch` the toolchain release it references, serve shell + stock snapshots + your overlays behind one worker. The lock becomes `{toolchain release id, qed64 release id, shell id, overlays}` instead of 145 hashes; no submodule, no source build, no `git show` of manifests. Heavy path: `fetch --only runtime,native64,lean-core,mathlib-essential,mathlib-workspace`. The base tree is `unpack --slim` of core + essential plus QED64's umbrella pair, which reproduces the served base tree exactly (verified: 5,004 oleans, zero private facets, byte-identical); its two gate inputs are also in the release: the native core library (`native64.tar.gz` ships `lib/lean`) for the facet byte-identity check, and the essential module list for the disjointness check. Widgets' native compile runs `lake build` inside the image in a clone of the kernel build's Mathlib workspace, and Lake reuses the 3,500 already-built Mathlib modules only because their `.trace`/`.hash` files are there; pack oleans carry no traces, so the release also publishes the Mathlib workspace tree (`mathlib-workspace.tar.zst`, ~6.4 GB, R2 only, split into ≤2 GiB parts if mirrored to GitHub; §5). No reach into anyone's untracked `work/` directories remains. Widgets' session confirms this is exactly their model and that, given the pairing record and the workspace asset, nothing breaks for them.

## 5. Releases and pinning

**L1 release id:** `lean-<leanTag>-<kernel7>`, e.g. `lean-v4.34.0-a8817d0`; a tools-only re-cut of the same pair appends `-r2`. The release record `wasm64-build/releases/<id>.json` is committed first and the tag placed on that commit, so the pinned tree contains its own digest root.

`release.json` (`lean4-wasm64.release/v1`), every field from an existing file, written by a port of QED64's `release-manifest.mjs` (pure function of a commit, fixed key order, `digest = sha256(json without digest)`, a refusal list):

| Field | Source |
|---|---|
| `lean {version, upstreamTag}` | runtime manifest, import target |
| `kernel {repo, branch, commit, patch}` | `BUILT-COMMIT`, `PATCHES.md` |
| `gate {passed, wasmSha256}` | `GATE-PASSED` |
| `runtime {buildId, pair, files, chunked{manifest, chunks[]}}` | the existing `org.lean-browser64.runtime/v1` manifest, unchanged |
| `packs[] {id, manifest, digests, modules, lean{version, compiler}, mathlib?}` | the existing `browser64.artifact-manifest/v1`, unchanged; `compiler` = the commit whose native build wrote the oleans |
| `native64 {commit, os, arch, tar}` | `NATIVE-COMMIT`, `native/stage1` |
| `docker {tag, recipeCommit, imageId?}` | the Dockerfile's last change; rebuild-and-compare is the proven identity check |
| `mathlib {commit}`, `modules {essential, extra}` | `MATHLIB-COMMIT`, the module lists |
| `hosting {base, cacheRule, crossOriginIsolation}` | today's worker and `DEPLOY.md` facts |

This names all four things that must match (runtime, packs/base tree, compiler, image), which is the condition widgets asked for. Pairing rules stay exactly as coded today: snapshot `entry.runtime == buildId`, pack `lean.version == runtime leanVersion`; the kernel commit is recorded, never compared.

`fetch --only runtime` writes the `bin/{lean.js,lean.wasm}` layout every bake and headless tool takes as `--artifact <dir>` (the build id is recomputed from `<dir>/bin/lean.wasm`).

**Where the bytes live:** the complete set on the GitHub Release (every asset under 2 GiB; ~100 assets; lean4game already hosts 154 MB–1 GB assets this way) and the same bytes under one immutable R2 prefix in the served layout (Range requests work there). One asset is R2-first: the Mathlib workspace tree with its Lake traces (~6.4 GB) that overlay builders need; it goes to GitHub only split into ≤2 GiB parts. `rclone copy --immutable` refuses to overwrite; the retention rule "a key named by any tracked release record is never deleted" is enforced by one `gc` script that is the only tool allowed to delete. Rollback = revert the one dependency line; bytes are immutable and retained; snapshots keyed by build id stay valid.

**L2 release:** the npm git dependency at a commit, plus per promote `qed64.release/v1` referencing `toolchain.releaseId`, the reproducible shell tarball, the manifests and the umbrella pair.

**One reconciliation with QED64's view.** QED64 would keep the build-id rule and manifest schema in its `artifact-paths.mjs`, since every worker checks it. The rule is one line (`wasm64-` + sha256(lean.wasm)[:16]) and must exist in the worker (QED64) regardless; the writer must exist where the manifest is written (the fork). So: the schemas and the rule are *documented* once, in `wasm64-build/js/formats/`; `artifact-id.mjs` in the fork writes them; QED64's worker checks them per the documented rule; QED64 keeps no chunker, since the fork publishes the chunks. Two implementations of a one-line rule, one specification. To be exact about who computes what: the browser worker only compares two recorded ids (the snapshot entry's `runtime` against the manifest's `buildId`); the one place that recomputes `sha256(lean.wasm)` is `verify-release`, which moves to the fork, so QED64 keeps no recomputation at all. Because the fork writes `org.lean-browser64.runtime/v1` and QED64's worker reads it, the schema is versioned like the worker protocol: `closure.json` lists the schema versions the worker accepts next to `workerProtocol`, under the same two-release rule.

**Two more rules QED64 asked for, adopted:**
- *Same origin stays absolute.* "Route `/runtime/*` and `/profiles/*` to the shared prefix" means each site's own edge worker proxies the shared R2 prefix under its own origin. The browser is never pointed at another origin (QED64 HARDENING #57, COEP `require-corp`, the per-origin OPFS cache all depend on it). This sentence goes into `formats/HOSTING.md`.
- *The dev loop never waits for a publish.* `adopt-release` and the bake accept a local staged release directory (the kernel session's unpublished build, in the same record format) as well as a published id, so a kernel fix under test is consumable before the owner publishes.

## 6. Migration, in order

| Step | Who | What | Deletes / adds |
|---|---|---|---|
| 0a | kernel | Write the contract: `RELEASE.md`, `EMBED-RUNTIME.md` (the ABI table), `formats/HOSTING.md`; fix the README lines that point at QED64's chunker | +4 docs |
| 0b | QED64 | Merge `feature/embedding-api` and the MIT license; export the four things widgets still take from the submodule (`isImmutable`, `supervised-run`, `preflight`, `release-manifest`); delete the stale `build/finish/setup-source` scripts and the 35 patch files, and in the same commit re-express the kernel floor check (`package-contract.test.ts` today requires `minKernelPatch` to name a patch file) against the fork's `PATCHES.md` and, from step 3, the release record's `kernel.patch` | −35 files, −3 scripts, −300 doc lines |
| 1 | kernel (2 sessions) | `wasm64-build/js/`: move the nine scripts, reconcile `node-runner.mjs` (the fork's copy is NOT a superset, corrected 2026-10-06: it lacks QED64's ensureStackSize re-exec, the A3 path rule and the unknown-flag warnings, and creates the work dir before checking lean.js), replace every repo-relative path default with explicit flags, replace reads of QED64's served state with a committed pack config, add `release/fetch/cli`, `formats/`, unit tests, a branch-scoped minutes-long CI workflow | ~700 moved, ~400 new |
| 2 | kernel + owner | Cut `lean-v4.34.0-a8817d0` from the bytes already on disk and in R2 (no rebuild, no rebake: same build id). Record honestly that this first release's packs were compiled at 8d91aad and its runtime at a8817d0 (legal under the coded pairing rules; collapses at the next import) | first release |
| 3 | QED64 (2 sessions) | Pin the release; delete `pipeline/toolchain` (gate, exports, chunker, artifact-paths, `KERNEL-PIN`), `pipeline/artifacts`, `import-packs.sh`, the duplicated runners and probes; `import-packs.sh` → `adopt-release.sh` (~50 lines; also takes a local staged release dir); the acceptance probes run on the package runner; the worker proxies `/runtime/*` and `/profiles/*` from the shared prefix under QED64's origin. **Ordering:** lean4game and widgets still consume `qed64/pipeline/*` (a tier-1 surface in `CLI-CONTRACT.md`, pinned by `package-contract.test.ts`) until steps 4 and 5 land, so step 3 leaves one-line re-export shims under `pipeline/` for those entries and documents the transition in `CLI-CONTRACT.md`; the shims go in step 6. The one check `KERNEL-PIN` carries today (the served manifest's `sourceRevision` equals the pinned kernel commit, refused by `release-manifest.mjs`) survives as `qed64.release/v1.toolchain.releaseId` plus its test | −600 lines, +80 |
| 4 | lean4game (2–3 sessions, ~3.5 h of background compiles and bakes) | The v4.34 port *is* adopting the release: pin it; delete the `wasm/kernel` submodule, `KERNEL-PIN`, `wasm/compat` (805 Lean lines, all covered by the `mathlib-game-extra` pack), the runtime/core/compat lanes and the link repair; compile the games with the release's native compiler; per-game edits (Knights option, three outdated imports in Knights/RAG/Robo/LAG/STG4, LAG's `NormNum.Prime`, `server/lean-toolchain`); rebake all ten against `wasm64-3ab1c6a9…`; keep the bundle tooling for snapshots only; route runtime/profiles to the shared prefix. The game then serves the same runtime bytes as QED64 | −150 lane lines, −969 compat lines, −700 MB submodule, +60 |
| 5 | widgets (1 session) | Heavy path from one fetched release instead of the owner's checkout and `QED64_KERNEL_BUILD`: base tree from `unpack --slim` + umbrella pair, native core and module list from the release, the Mathlib workspace asset for `lake build`; a second prefix in the worker (`RELEASE_PREFIX` for `/runtime/*`, `/profiles/*` and the stock snapshots, the site's own prefix for overlays); lock v3 = `{toolchain release id, qed64 release id, shell id, overlays, widgets commit + source hash, the native build record used}` | fewer env vars, one pin format, one small worker change |
| 6 | QED64 + widgets | Apply `RELEASE-BUNDLE.md`: CI writes `qed64.release/v1` + the shell tarball with a per-file sha256 manifest + the tracked manifests and indexes per promote; widgets drop the submodule and the source build and keep verifying every file against that manifest | −submodule, −build-shell |
| 7 | everyone | The next Lean import is the acceptance test: `import-release.sh run v4.35.0` ends with `pack`, `chunk`, `release`; owner publishes; QED64 adopts and rebakes two snapshots; lean4game and widgets bump two lines and rebake | measure: no app built a kernel |

Net: ~700 lines moved, ~400 new; ~9 k lines, 35 patch files, a submodule and three pin formats deleted; the watcher, `native64.sh`, `mathlib-tree.sh`, the gate semantics and the bake pipeline untouched; nothing in `lean.worker.js`, `embed` or the page changes.

## 7. What stays duplicated or app-owned, on purpose

- One edge worker, one upload script and one deploy script per site (same bucket, own prefix); the cache rule is imported from QED64, the hosting facts live once in `formats/HOSTING.md`.
- Per-site snapshot bakes on every runtime release: inherent to the function-table pairing, not an architecture cost. Batch kernel-only fixes to keep the cadence low.
- Docker for native compiles in lean4game and widgets: they stop *building* the compiler, not running it (Linux aarch64).
- App data: `wasm/catalog.json` and game patches; each site's `snapshots/index.json`; QED64's `closure.json`; widgets' overlays and lock.
- Two Lean versions until step 4: lean4game stays on its own runtime, and its current branch keeps working because it pins QED64 by commit.
- Widgets' submodule until step 6, and the gallery's page-tier internals until QED64's page API v1.

## 8. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| 1 | Toolchain home: the fork (A), QED64 (B), a separate repo (C) | **DECIDED 2026-10-05: A**, with C's grafts (explicit paths, `formats/`, release naming with the kernel commit). The kernel session's steps 0a → 1 → 2 are green-lit. |
| 2 | GitHub Release completeness | Full set on GitHub *and* R2; GitHub is the durable copy, R2 is owner-only |
| 3 | Shared R2 prefix vs per-site mirrors | **DECIDED 2026-10-06: the recommendation.** Each worker proxies `lean4-wasm64/<id>/` from the same bucket under its own origin; collapses the duplicate 1.3 GB sets |
| 4 | Docker image identity | `recipeCommit` + rebuild-and-compare (proven byte-identical once); push to a registry only if an x86 builder appears |
| 5 | First release: copy served pack bytes or regenerate | Copy; pack bytes are only same-host reproducible (gzip OS byte); first regenerated set at v4.35 |
| 6 | When lean4game ports to 4.34 | With step 4, after step 3; nothing blocks it staying on 4.33 meanwhile |
| 7 | QED64 for outsiders without SSH keys | Keep `github:#sha` now; add a tgz asset at step 6 |
| 8 | Who runs `gc` | The owner only, no deletes until the script exists |
| 9 | A page-free "core" of QED64's library for toolchain-only browser projects (widgets' suggestion) | Not now: the documented ABI + `node-runner` covers toolchain-only; revisit if a third browser embedder appears |
| 10 | Where QED64 declares `lean4-wasm64`: a regular dependency (every embedder installs the toolchain tgz; QED64's "no runtime dependencies" rule is dropped on purpose) or a devDependency (QED64's library and workers import nothing from it; the bake spawns the runner by an explicit `--runner` path, defaulting to the consumer's own `lean4-wasm64` install) | **DECIDED 2026-10-06: the recommendation: devDependency; QED64's library stays dependency-free; no script under qed64/pipeline/* imports lean4-wasm64.** devDependency. The library stays dependency-free, and every bake consumer already pins `lean4-wasm64` itself (the two lines of §3). Rule: no script exported through `qed64/pipeline/*` may import `lean4-wasm64`; it receives paths |

## 9. Risks

1. Hosting is owner-only (R2 credentials); the full GitHub set and rebuild-from-tag are the mitigation.
2. The first release carries two kernel commits (runtime a8817d0, packs at 8d91aad); recorded honestly, collapses at v4.35.
3. Pack bytes are only same-host reproducible; compare on content digests, never on gzip bytes (or fix the gzip header fields in step 1).
4. A Node package inside a C++ fork: merge-safe, but the fork's upstream CI never runs it; the branch-scoped workflow is its only test run.
5. Every runtime release still forces every site to rebake; the design removes duplicate runtime *builds*, not rebakes.
6. The export ABI is prose; a tracked `embed-abi.txt ⊆ generated exports` check is cheap and recommended.
7. lean4game inherits QED64's binary and cadence: re-validate the 0035 parking rule with the game's reload storm before setting `LEAN_WASM_PARKED_DEDICATED`.
8. Step 3 removes tier-1 CLI surface from QED64; without the shims and the documented transition, lean4game's and widgets' pinned builds break the moment they bump QED64. The shims are the migration's only compatibility layer and must not be dropped early.
9. One machine and one maintainer for the hours-long stages: unchanged by any candidate; the published release is what makes everything downstream reproducible elsewhere.
