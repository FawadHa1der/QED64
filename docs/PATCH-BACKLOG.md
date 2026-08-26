# Toolchain patch backlog (next Docker rebuild + snapshot rebake)

Each of these is coded or fully designed but needs the Docker pipeline
(down at time of writing). One rebuild + one rebake of BOTH snapshots
(binary-paired) covers all of them.

## 1. Alias coverage in the covering-env check (coded, unbuilt)
`Shell.lean` `wasmLspInit`: `aliasOk` lets the umbrella env satisfy
`import Mathlib` / `Mathlib.Tactic` / `Batteries` / `MIL.Common`. The
shim's client-side header rewrite covers this meanwhile.

## 2. Bake the library-search index into the snapshot (designed)
See docs/LIBRARY-SEARCH-BAKE.md. First `exact?` drops from ~2 min to ~2 s.

## 3. Cancel the old session in wasmLspInit before replacing it (designed)
`wasmLspInit` already accepts being called on a live session ("init called
with a live session; replacing it") and swaps `wasmLspSession` — but the
REPLACED session's elaboration/reporter tasks are abandoned, not
cancelled, and the new session's elaboration then wedges silently (no
fileProgress completion, no diagnostics, didChange ignored; reproduced
2026-08-26 switching the examples dropdown). Fix: before replacing, run
the old session's shutdown path (cancel its CancelToken / request tasks,
wait for the reporter to drain) so the replacement elaborates cleanly.
Payoff: switching between examples/headers becomes a sub-second in-place
re-init — both snapshots stay resident in the instance's env cache — and
the frontend's `restartForHeaderChange` can retry the in-place path
(the reverted client half lived at commit-era `restartForHeaderChange`;
resurrect it from git history once this lands) instead of a ~30 s wasm
reboot that re-verifies the runtime and re-streams snapshots.
