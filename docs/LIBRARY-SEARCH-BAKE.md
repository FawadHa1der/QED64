# Baking the library-search index into the snapshot

## The problem, measured

`exact?`/`apply?`/`rw?` on QED64 cost ~65–110 s on FIRST use in a session, vs
~3 s on live.lean-lang.org. Measured discriminator (2026-08-26, warm session):

| call | goal | wall time |
|---|---|---|
| first `exact?` in session | `a + b = b + a` | ~110 s |
| second `exact?`, different goal | `a * b = b * a` | **~2 s** |

So >98 % of the cost is the ONE-TIME `LazyDiscrTree` index build; the
per-query cost is already at parity with live's server. The build is slow
because it multiplies three factors:

1. **Environment size**: the covering/umbrella env indexes ~4,821 modules'
   constants; live's `import Mathlib.Data.Real.Basic` session indexes only
   its 684-module closure (~7× fewer constants).
2. **wasm single-core speed**: no native codegen, and Memory64 pays explicit
   bounds checks (the 4 GiB guard-page trick doesn't apply), ~1.3–3× on
   pointer-chasing workloads like `forallTelescope` over 200k+ constants.
3. **Per-process cache**: our own patch moved the cache OUT of the
   environment (see the comment at `Lean/Meta/Tactic/LibrarySearch.lean:157`)
   because a mutable `IO.Ref` compacted into the snapshot's read-only region
   is unsound. Correct — but it means every session rebuilds from scratch.

## Why the "obvious" frontend fixes regress

- **Background warm compile after boot**: `wasmCompile` elaborates
  synchronously ON THE CALLING (pump) THREAD (deliberate — see the
  `Frontend.processCommands` comment in `Shell.lean` ~line 124). A ~100 s
  main-thread stint starves the mailbox pump; the live LSP session freezes
  or deadlocks. Rejected.
- **Warm during boot (pre-lsp-init)**: safe (nothing else runs) but adds
  ~100 s to every Mathlib boot. Rejected.
- **Idle-triggered warm**: bounded but real risk that a returning user's
  keystroke queues behind a ~100 s stint they never asked for. Rejected as
  default (acceptable only as an explicit user-initiated button).

## The fix: eager DiscrTree in the compacted snapshot (this doc's ask)

The soundness objection is to MUTABLE state in the read-only region.
An eager, fully-evaluated `DiscrTree` is plain persistent data — queries
are pure reads. That is exactly the shape Mathlib used to ship as
`MathlibExtras.LibrarySearch` before it was dropped for olean size.
Our snapshot already carries 2.6 GiB; a few hundred MB of prebuilt index
is proportionally cheap and compresses.

Plan (small Lean-side patch, next Docker rebuild — bundle with the parked
alias-coverage Shell.lean change; ONE rebuild + rebake covers both):

1. **Bake step** (Shell.lean, snapshot bake path): after the umbrella env
   is resident, run the same entry generation `libSearchFindDecls` uses
   (`addImport` over every constant, `droppedKeys` filter) but insert into
   an EAGER `DiscrTree (Name × DeclMod)`; also materialize the
   `starLemmasExt` array. Store both in a structure reachable from the
   compacted env (e.g. a dedicated persistent env extension entry or a
   named constant the wasm loader knows), so they land in the snapshot's
   read-only region.
2. **Lookup patch** (`Lean/Meta/Tactic/LibrarySearch.lean`): in
   `libSearchFindDecls`, before the lazy path, consult the prebuilt tree if
   the environment carries one AND the env is exactly the baked env (guard
   on a marker/module name, e.g. `QED64.Essential` presence + a version
   stamp). Hit → pure `DiscrTree.getMatch` (read-only, sound). Miss (native
   builds, non-umbrella envs, stale stamp) → existing lazy path, unchanged.
3. **Fallback intact**: the patch is additive; deleting the baked tree
   reverts behavior to today. Native/live behavior untouched.
4. **Rebake both snapshots** (init + mathlib) — binary-paired with the
   toolchain as always.

Expected result: first `exact?` ≈ 2 s (at parity with live), zero
background CPU burn, no UX change elsewhere.

## Shipped meanwhile (frontend, commit-ref in git log)

- Status-pill honesty: when a search tactic is in the buffer and the first
  long elaboration runs, the pill says
  "first library search — indexing Mathlib (about 2 min, once per session)"
  instead of a bare "elaborating". After one long search completes the
  session is marked warm and the hint never re-fires (reset on worker
  restart — a new process is cold again).
