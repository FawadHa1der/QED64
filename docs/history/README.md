# Historical documents

These are the reasoning trail behind QED64. None describes the current
system, and none is updated any more: line numbers, file paths and runtime ids
inside them are as they were on the day each was written. What is true now is
in [README.md](../../README.md), [ARCHITECTURE.md](../ARCHITECTURE.md),
[HARDENING.md](../HARDENING.md) and the contracts the README links to. They
moved here from `docs/` (and `e2e/`) in plan step A5 (2026-10-06); git history
has them at their old paths.

**[ARCHITECTURE-REEVALUATION-2026-09-02.md](ARCHITECTURE-REEVALUATION-2026-09-02.md)**:
the first architecture review (2026-09-02, a 12-agent read-only review), which
diagnosed why the page was bug-prone: the client shim
(`frontend/src/watchdog-shim.ts`, removed 2026-09) made decisions only the
worker could make. It proposed one resident Lean process per page,
worker-owned header resolution and full-text document sync. Superseded the same
evening by the second pass below, and then by the resident transport as built
([ARCHITECTURE.md](../ARCHITECTURE.md) "Transport",
[RESIDENT-WORKER-PLAN.md](../RESIDENT-WORKER-PLAN.md)).

**[ARCHITECTURE-REEVALUATION-2-2026-09-02.md](ARCHITECTURE-REEVALUATION-2-2026-09-02.md)**:
the second pass (2026-09-02, evening), a synthesis over five candidate designs
and two red-team rounds. It moved the single header resolver into
`FileWorker.setupImports`, replaced the stdout ring with a host-side byte
device, and specified the front door, the page relay and the session adapter
(§2.2 to §2.4). Those designs shipped as `public/workers/lsp-front-door.js`,
`lib/lsp-relay.ts` and `lib/resident-session.ts`, whose header comments still
cite its sections as their design record. Superseded by that implementation;
the living description is [ARCHITECTURE.md](../ARCHITECTURE.md) "Transport".

**[PUMP-REMOVAL-ASSESSMENT-2026-09-04.md](PUMP-REMOVAL-ASSESSMENT-2026-09-04.md)**:
a 24-agent inventory (2026-09-04) answering whether the older "pump" transport
(a header-probe shim with in-place restarts) could be removed. The answer was
yes, in three steps. The page-side deletion landed the same day; the kernel
retired its pump entry points at the next pairing bump, patch 0033
(2026-09-07, runtime `wasm64-c645477e817ac857`, still Lean 4.33.0-pre).
Superseded by
[RESIDENT-WORKER-PLAN.md](../RESIDENT-WORKER-PLAN.md), which records both
removals.

**[LEAN4WEB-FEASIBILITY.md](LEAN4WEB-FEASIBILITY.md)**: the research dossier
(2026-08-25) on whether live.lean-lang.org's front end (lean4web, lean4monaco
and the vscode-lean4 InfoView) could run over QED64's in-browser wasm64
language server, with the Stage-1 probes that proved the LSP conversation.
The verdict was feasible. Superseded by the lean4monaco page that shipped
(`frontend/`) and, for its pump-era transport, by the resident transport.

**[EMSDK-BUG-REPORT.md](EMSDK-BUG-REPORT.md)**: an Emscripten 6.0.5 bug
report with a validated fix (2026-08-25). When exported functions are used
without `main()` under `EXIT_RUNTIME=1`, a pthread's first sync-proxied call
tears down the runtime. It was written for the owner to file upstream. The
build that carries the workaround is the Lean fork's since plan B1 (2026-10:
FawadHa1der/lean4 `qed64-wasm64`, `wasm64-build/`, [REBUILD.md](../REBUILD.md)
§1). The Node probes the report cites (`pipeline/lsp/`) were removed in 2026-10.

**[UPSTREAM-NOTES.md](UPSTREAM-NOTES.md)**: a consolidated list of upstream
Lean, Emscripten, Chrome and Mathlib bugs and platform limits (2026-08-26),
from QED64's own campaign and a read of the sibling browser64 implementation,
at the Lean 5732b84 / Mathlib de3a9cf pin of that time. It has not been
updated since. Superseded by [HARDENING.md](../HARDENING.md), which holds the
living list of environment pathologies, and by the fork, which owns
toolchain-side fixes. `tests/unit/tool-paths.test.ts` names it as one of two
files allowed to mention the sibling checkout, as provenance.

**[PATCH-BACKLOG.md](PATCH-BACKLOG.md)**: the toolchain patch backlog for the
next Docker rebuild and rebake (2026-08-26, last updated 2026-09-07). Items
#1 and #3 became obsolete with the resident transport; #4 (the resident
FileWorker) and #7 (the server-slim rebake) are done. The first architecture
review reports #5 and #6 as landed in patch 0024, and #2 (the library-search
bake) stayed open. Superseded by the fork's patch series (`wasm64-build/PATCHES.md`,
plan B1, 2026-10). QED64 no longer builds the compiler.

**[LIBRARY-SEARCH-BAKE.md](LIBRARY-SEARCH-BAKE.md)**: a measured design
(2026-08-26) for baking the library-search index into the Mathlib snapshot,
so that the first `exact?` of a session takes about 2 s instead of about 2 min.
Only its frontend half shipped (the honest status-pill hint). The bake itself
needs a toolchain patch, which now belongs to the fork; PATCH-BACKLOG #2
tracked it.

**[live-verification.md](live-verification.md)**: the pointer left in place
of the manual ten-step browser checklist against the 2026-08 CodeMirror shell,
which was last executed on 2026-08-25. It moved here from `e2e/`. Superseded by the
adversarial suite (`tests/adversarial/`, [TESTING.md](../TESTING.md)).
