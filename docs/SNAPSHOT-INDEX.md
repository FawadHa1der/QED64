# The snapshot index (qed64.snapshot-index/v1)

A snapshot is the memory image of one Lean environment: the runtime saves it
(`--incr-header-save`, the compactor) after importing a probe file's header,
and a worker loads it in seconds instead of importing the modules for
minutes. It is paired with one runtime binary, because its closures point
into that binary's function table. The index lists a site's snapshots: what
each serves, where its bytes are and which runtime baked it.

- **Writer:** `pipeline/snapshot/bake-snapshot.mjs`
  ([CLI-CONTRACT.md](CLI-CONTRACT.md#bake-snapshot), its flags, lines and
  exits). This document is its writer rules.
- **Readers:** `lib/snapshots.ts` `loadSnapshotIndex` (the page,
  [EMBEDDING.md](EMBEDDING.md) §4 and §8), lean4game's game boot, and
  QED64's `promote-staging.mjs`, `fetch-artifacts.mjs`, `preflight.mjs`,
  `release-manifest.mjs`, `scripts/upload-artifacts.sh` and
  `scripts/deploy-guard.mjs`.
- **Owner:** QED64 (architecture review D4, option a; 2026-11-01). The rules
  moved here from the fork's `formats/snapshot-index.md`, which points here.
  Snapshots and their index are a site's product, never part of a toolchain
  release.

QED64's served index (`public/snapshots/index.json`, runtime
`wasm64-36d7f415704473d9`, Lean 4.35):

```json
{
  "schema": "qed64.snapshot-index/v1",
  "snapshots": [
    {
      "name": "init",
      "url": "/snapshots/init.81276a747b990f32.snapz",
      "digest": "sha256:81276a747b990f320b76afa182192d188aeb0cec6b50b63d19bbda812e9168ba",
      "bytes": 116893325,
      "transfer": 31719003,
      "imports": [],
      "runtime": "wasm64-36d7f415704473d9"
    },
    {
      "name": "mathlib",
      "url": "/snapshots/mathlib.79936198cd60caf2.snapz",
      "digest": "sha256:79936198cd60caf2d5ab88ad15772a1412edd1bf03aec9b96109dfb540456d26",
      "bytes": 1114335677,
      "transfer": 319645483,
      "imports": [
        "QED64.Essential"
      ],
      "runtime": "wasm64-36d7f415704473d9"
    }
  ]
}
```

## Rules

- `schema` is exactly `qed64.snapshot-index/v1`, a wire name: every deployed
  reader tests it literally and treats any other string as a corrupt index.
- The file is `JSON.stringify(index, null, 2)` with no trailing newline. A
  writer keeps any other top-level key in place and rewrites only `snapshots`.
- `snapshots` is in upsert order: an upsert removes the entry of the new
  entry's name and appends the new one, so a rebake moves its entry to the end.
- **The core keys,** in this order, in every entry:

  | Key | Value |
  |---|---|
  | `name` | `^[A-Za-z0-9][A-Za-z0-9._-]*$` (the bake refuses any other `--name`), unique in the index |
  | `url` | where its `.snapz` is served: `/snapshots/<file>` (below) |
  | `digest` | `sha256:` + 64 lowercase hex, the SHA-256 of the served `.snapz` bytes |
  | `bytes` | the size of the raw `.snap`: what a loader allocates |
  | `transfer` | the size of the `.snapz`: what a reader expects to download |
  | `imports` | the modules of the header the environment was baked for (below) |
  | `runtime` | the build id of the `lean.wasm` that baked it: `wasm64-` + the first 16 hex of its SHA-256 |

- **The page fields,** after the core keys, in this order, each only when the
  bake was given it: `roots` (`--roots A,B`: the module roots the entry
  serves, EMBEDDING.md §8), `label` (`--label`) and `initialBytes`
  (`--initial-bytes`, a positive whole number of bytes). They are written only
  through those validating flags, because `loadSnapshotIndex` refuses the
  whole index for one malformed entry.
- **Reserved keys:** `raw`, `lib` and `bakedBy` (`raw` is meant for the
  `.snap`'s digest). No writer uses them until this document defines them.
- **Extra keys:** any other key, written by `bake-snapshot --entry-fields
  '<json object>'` after the page fields in the object's order, and kept
  verbatim by later upserts of other entries. Its meaning is the reader's;
  `loadSnapshotIndex` ignores unknown keys. The bake refuses a value that is
  not a JSON object, any core key, a page field and the reserved keys.

## `imports` and the environment cache

The runtime keys its environment cache by a header's modules, `Init` first and
duplicates dropped (`qed64HeaderKey` and `qed64NormalizeKey`;
[ARCHITECTURE.md](ARCHITECTURE.md), "The kernel resolver"). The entry states
the same key from the page's side, so the rule is
`qed64NormalizeKey(entry.imports) == qed64HeaderKey(header of the snapshot's environment)`.
`imports` lists the header's modules in source order without the implicit
`Init`; `[]` is the environment of a file with no header.

QED64's bake reads `imports` from its probe line by line: a line that, with
its leading spaces trimmed, matches
`^(?:public\s+|private\s+)?(?:meta\s+)?import\s+<module>` gives one module.
It does not port the fork's full header lexer, so write bake probes plainly:
the imports first, one per line, no `import all` (it would record `all`), no
comment or second import on an import line. A header Lean rejects saves no
snapshot, so it never gets an entry: the bake ends with `no-snap` (exit 1)
once its runner has exited (the runtime's exit can wedge, patch 0031; stop
such a bake with SIGTERM).

## Identity and transport

- **The raw `.snap` is the snapshot's identity.** The same `lean.js` and
  `lean.wasm`, library tree, probe text (`probe.lean` is the probe plus
  `\n`), runner and runner environment give the same bytes. The runner is
  spawned as CLI-CONTRACT.md's bake side effect 5 says, with `/work/probe.lean`
  and `--incr-header-save=/work/<name>.snap`; QED64's `node-runner` mounts
  `--work` at `/work` (Lean's cwd) and the tree at `/lib/lean`. Its
  environment is exactly `PATH`, `HOME`, `TMPDIR`, `LEAN_COMPACTOR_RESERVE`,
  and `QED64_ALLOW_LEGACY_IMPORTS=1` and `QED64_PROFILE_INIT` when asked for:
  an inherited `LEAN_PATH` would replace the tree.
- **The `.snapz` is transport only:** the `.snap` gzipped by Node's zlib at
  level 6. Deflate output depends on the zlib build, so the same `.snap`
  baked on another host can get another digest: a new transport of the same
  snapshot, which costs a reader a download, never a wrong load (its cache is
  keyed by the digest). Record a `.snapz` digest together with the bake's
  `build environment: node …, zlib …, shared zlib …` line.
- **The file name** is `<name>.<first 16 hex of digest>.snapz`, written in
  the index's directory through a temporary file and a rename. Content-addressed
  names never collide, so a bake never removes an older `.snapz`.
- **The `url`** is `/snapshots/<file>`, site-absolute and on the page's own
  origin. Under `?snapshots=<dir>` the page re-roots the `/snapshots/` prefix.
- `.snapz` files are served as `application/octet-stream`, without
  `Content-Encoding` (a `.gz` name would make servers add it), `immutable`
  ([DEPLOY.md](DEPLOY.md)).

## Pairing: one runtime per index

Every entry of an index names the same `runtime`. A writer adding an entry
baked by runtime R refuses an index whose entries of other names name another
runtime (foreign) or none (unpaired); the entry of the same name is replaced
whatever its runtime. A reader never loads an entry whose `runtime` is not the
build id it booted (`SNAPSHOT_UNPAIRED`).

## The per-build copy

Beside `index.json` the bake writes `index.<buildId>.json`, where `<buildId>`
is the runtime the index is paired with: the same bytes
([HARDENING.md](HARDENING.md) #64). A page built for that runtime reads it
(`loadSnapshotIndex`'s `pairedBuildId`) when the mutable `index.json` already
names the next runtime (an upload ran ahead of its deploy). Another runtime's
copy in the directory is never touched.

- The bake's copy is its `--out`'s index, so it suits only a site that serves
  that directory as baked. A site that merges baked entries into a served
  index derives its copy from the merged index, with the same writing order.
- QED64's own site publishes no copy since 2026-11 (D2): its indexes ship in
  each deploy with the shell that reads them (DEPLOY.md, "Atomic deploys").

## Writing

1. **Read.** A missing `index.json` (ENOENT, and only that) is a new index,
   `{"schema": "qed64.snapshot-index/v1", "snapshots": []}`. Any other read
   error, text that is not JSON or not an object, another `schema`, no
   `snapshots` array or an entry without a string `name` is refused: a
   corrupt index is never replaced, since that would drop every sibling. The
   bake reads and checks the pairing before its runner starts.
2. **Lock.** `index.json.lock` beside the index, created by an exclusive open
   (`O_CREAT|O_EXCL`, which works where `link(2)` may not: exFAT/FAT, FUSE or
   SMB), holding `<pid>\n`, and held only around steps 3 and 4. It is never
   taken over, whatever its holder or its age. The bake waits for it at most
   120 s, then exits 1 naming the lock and its holder (`pid N (running on this
   host)`, `(not running on this host)`, or `a holder it cannot read (…)`: its
   first 200 characters, `a symlink`, `a directory`, `not a regular file` or
   `unreadable: <code>`) and printing `unindexed entry <json>`; its `.snapz` is
   in place. Once no writer uses the directory, removing the lock and
   rerunning finishes the upsert.
3. **Re-read and re-check** under the lock, with step 1's rules and the
   pairing: a sibling bake may have upserted meanwhile. A refusal here writes
   nothing.
4. **Write.** Both temporary files first (`index.<buildId>.json.<pid>.tmp`,
   `index.json.<pid>.tmp`: a full disk fails before either switches), then
   the copy is renamed first and `index.json` last, then the lock is released
   (only while it still reads `<pid>\n`). `index.json` is the commit record;
   copy-first keeps the copy never older than it (a failure between the
   renames leaves the copy one version ahead, and the next bake rewrites
   both).

## Producing and checking one

```sh
npm run bake:snapshot -- --artifact <stage1 dir> --lib <olean tree> --work <dir> --out <dir> \
  [--name init] [--probe '#check (2 + 2 : Nat)'] [--reserve <bytes>] \
  [--roots A,B] [--label <text>] [--initial-bytes <n>] [--entry-fields '<json object>']
node pipeline/snapshot/snapshot-probe.mjs --via-mem --snap <work>/<name>.snap \
  --artifact <stage1 dir> --lib <olean tree> --probe '…'
```

The bake keeps the raw `<work>/<name>.snap` (the probes load it) and writes
`<out>/<name>.<digest16>.snapz`, `<out>/index.json` and
`<out>/index.<buildId>.json`. One bake per `--work` runs at a time
(`<work>/.bake.lock`, CLI-CONTRACT.md bake side effect 3). `snapshot-probe
--via-mem` loads the `.snap` the way the browser worker does
(`lean_wasm_load_snapshot_mem`) and compiles the probe on it.
