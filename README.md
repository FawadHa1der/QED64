# QED64 — Lean 4 in your browser, 64-bit

QED64 is a Lean 4 web editor in the spirit of [live.lean-lang.org](https://live.lean-lang.org)
with one decisive difference: **no server checks your proofs**. The real Lean 4
compiler runs in a Web Worker as **WebAssembly Memory64** (LP64, shared memory,
pthreads), with the Lean core library and a 4,192-module **Mathlib** profile
mounted read-only from verified, content-addressed packs.

```
┌───────────────────────────── browser tab (COOP/COEP isolated) ─────────────────────────────┐
│  UI (CodeMirror 6, goals, messages)                                                        │
│    │ postMessage RPC                                                                       │
│  Lean worker ── verified chunk fetch ──► lean.js + lean.wasm (SHA-256, 154 MB)             │
│    │  shared WebAssembly.Memory({address:"i64"}) · 256 MiB → 8 GiB                         │
│    │  WORKERFS ◄── OPFS raw packs (SHA-256-verified transport, transactional install)      │
│    └─ persistent lean_wasm_compile: resident environment per import set                    │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Requirements

- Desktop **Chrome/Edge 133+** or **Firefox 134+** (Memory64 + SharedArrayBuffer).
  Safari has no Memory64 as of 2026 and is out of scope.
- Node **24+** for the pipeline and tests (Memory64 on by default).
- ~5 GB free disk in the browser profile for the Mathlib tier.

## Quick start

```sh
npm install
npm run sync:artifacts   # verified copy of runtime + profiles into public/
npm run verify:release   # recompute every digest the browser will trust
npm run dev              # http://localhost:5173 (COOP/COEP set by Vite)
```

First visit installs the Lean core profile (~120 MB download → 389 MB in OPFS)
and boots the runtime; the **Check** button (or Ctrl/⌘-Enter, or just typing
with *auto* on) elaborates and kernel-checks the buffer. The Setup tab installs
the Mathlib profile (~993 MB download → 3.5 GB in OPFS). The first compile for
a given import set pays that set's import once; the resident environment then
serves rechecks in milliseconds.

Live-verified performance (in-app Chromium, Apple Silicon): boot loads a
107 MB `init` snapshot in ~0.6 s, so the first Init-only check is ~300 ms.
The first Mathlib check of a session streams the **one** `mathlib` umbrella
snapshot (806 MB on the wire, 2.57 GiB region) straight into the wasm heap
in ~128 s and then checks in ~31 s; after that, **every** Mathlib buffer —
whatever its imports, including combinations nobody pre-baked — rechecks in
**37–67 ms**. Compiling the same header's closure in-browser instead takes
5–6 minutes (what "Strict headers" in the Setup tab opts into). Full
numbers in `docs/ARCHITECTURE.md`; the war-story list of environment
pathologies this survives is `docs/HARDENING.md`.

## Layout

| Path | What lives there |
|---|---|
| `src/` | the app: editor (`editor/`), worker RPC client (`runtime/`), OPFS installer (`install/`), UI (`app.ts`) |
| `public/workers/lean.worker.js` | the Lean worker: verified runtime materialization, Memory64 heap, WORKERFS mounts, persistent compile loop |
| `public/runtime`, `public/profiles` | content-addressed artifacts (synced, never committed) |
| `pipeline/release` | `sync-artifacts` (provenance-checked copy), `verify-release` (out-of-band digest audit) |
| `pipeline/artifacts` | deterministic packer + deep inspector for profile packs |
| `public/snapshots` | baked environment snapshots + `index.json` (baked per runtime, never committed) |
| `pipeline/snapshot` | Node runner for the wasm64 binary + `--incr-header-save` snapshot baking (`--lib` mounts an unpacked olean tree; upserts the snapshot index) |
| `pipeline/toolchain` | pinned toolchain build recipe and the wasm64 patch contract |
| `tests/` | unit suite (pure logic + real-manifest invariants) and integration suite (the real runtime under Node) |

## Testing

```sh
npm test                  # unit: abbreviations, manifests, pack format, worker internals, diagnostics
npm run test:integration  # real wasm64 Lean under Node: proofs, errors, sorry, exit codes
QED64_SLOW=1 npm run test:integration  # + import Lean closure and snapshot baking
```

The unit suite deliberately loads the *real* worker source in a VM sandbox and
the *real* published manifests, so refactors cannot silently diverge from what
ships. The integration suite runs the exact runtime bytes the browser executes.

## Baking snapshots

Snapshots are binary-paired (their relocations are keyed to the producing
binary's function table), so bake them with the exact runtime you ship. The
bake gzips to `public/snapshots/<name>.snapz` and upserts `index.json`
with the probe's ordered import list — which is what the app matches
against, exactly. Two snapshots ship: `init` (no imports, loaded at boot)
and `mathlib` (the `QED64.Essential` umbrella that serves every Mathlib
import combination via the header rewrite — see docs/ARCHITECTURE.md).

```sh
npm run bake:snapshot   # the init (no-import) snapshot
```

The mathlib umbrella: reconstruct the olean tree from the verified profile
parts, generate + compile the umbrella module, then bake its environment.
The probe body doubles as validation — the bake fails loudly if the
examples stop compiling against the umbrella.

```sh
node pipeline/artifacts/unpack.mjs --manifest public/profiles/lean-core.manifest.json --out work/lib-tree
node pipeline/artifacts/unpack.mjs --manifest public/profiles/mathlib-essential.manifest.json --out work/lib-tree
# Essential.lean = `import <M>` for every module in the essential manifest
node --stack-size=8192 pipeline/snapshot/node-runner.mjs --work work/umbrella --lib work/lib-tree -- -o /work/Essential.olean /work/Essential.lean
cp work/umbrella/Essential.olean* work/lib-tree/QED64/
npm run bake:snapshot -- --name mathlib --lib work/lib-tree --probe 'import QED64.Essential
<the bundled Mathlib examples>'
```

Validate the result with the snapshot probe, which loads the raw .snap
(kept in `work/snapshot/`) through `lean_wasm_load_snapshot` — the worker's
exact path — and asserts the follow-up compile is an env-cache hit rather
than a silent re-import:

```sh
node --stack-size=8192 pipeline/snapshot/snapshot-probe.mjs --snap work/snapshot/mathlib.snap --probe-file example.lean
```

## Provenance and trust

The runtime (`wasm64-2c197d38d7fbe922`, Lean `4.33.0-pre`, clean-room build of
`cauli/lean4@5732b84` + the 13-patch series in `pipeline/toolchain/patches/`)
and both profile packs are consumed here **by digest**: every chunk
and transport part is SHA-256-pinned in a manifest, `sync:artifacts` refuses
unverified bytes, `verify:release` re-derives the raw pack digests, and the
worker re-verifies every chunk before `importScripts`. See
`docs/PROVENANCE.md` for the full chain and `pipeline/toolchain/` for how to
rebuild the runtime from source.

Lean, Mathlib, Batteries: Apache-2.0. The wasm build derives from
[cauli/lean4](https://github.com/cauli/lean4) `reinstate-wasm` (Apache-2.0);
loader and delivery patterns follow the Browser64 workspace evidence.
