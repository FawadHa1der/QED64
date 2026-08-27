# Server-slim snapshot rebake — experiment results (2026-08-27)

Branch: `experiment/server-slim-rebake`. The umbrella and init snapshots were
rebaked against library trees with every `.olean.private` facet removed
(Lean's importer opportunistically reads and retains them; elaboration never
needs them at this Mathlib pin — see docs/UPSTREAM-NOTES.md #2).

## Measured results (same runtime `wasm64-0fdfd698a0e97fac`, same probes)

| metric | fat (shipped) | slim | delta |
|---|---:|---:|---:|
| mathlib snapshot raw | 2,755 MB | 1,114 MB | **−60%** |
| mathlib download (gz) | 806 MB | 304 MB | **−62%** |
| init snapshot raw | 342 MB | 121 MB | **−64%** |
| init download (gz) | 107 MB | 33 MB | **−69%** |
| first-visit snapshot payload | 913 MB | 337 MB | **−63%** |
| wasm pre-commit (mathlib session) | 3584 MiB | 2048 MiB | −1.5 GiB |
| heap after full library search | 4.07 GiB | 2.48 GiB | **−39%** |
| first `exact?` (index build) | ~110–230 s | 58 s | ~2–4× faster |
| snapshot load (probe, via-mem) | 1799 ms | 1258 ms | −30% |
| example switch back to Mathlib | 18.9 s | 13.5 s | −29% |

## No-regression evidence

- **Bake = the strongest differential**: the slim bake itself imports all
  4,822 modules of the umbrella through the private-free tree — zero errors.
- **snapshot-probe** (via-mem, init-flags 1) on a 14-theorem stress file
  (rw chains, linarith, norm_num, decide, simp, field inverses, omega,
  `#check`/`#eval`): compiler messages **byte-identical** to the fat
  snapshot, including the one intentional failure (`Nat.Prime 37 by
  norm_num` is unprovable in this umbrella on BOTH — a closure limitation,
  not a slim effect).
- **In-browser battery** on slim: the 7-error catalogue byte-identical
  (positions, wording, error-code chrome); goals at cursor identical; hover
  identical (server facets are KEPT — docstring/signature metadata intact);
  completion rows identical; example switches both directions; `exact?`
  finds the same lemma (`add_comm'`).

## Honest downsides / residual risks

1. `import all M` (module-system syntax) cannot work without private
   facets. Zero Mathlib usage at pin de3a9cf; user-facing failure is loud.
2. Kernel reduction through private bodies of *module-ized* files would
   fail with "unknown constant". Effectively no module-ized files at this
   pin; **must be re-audited at every future Mathlib pin bump** (module
   adoption is growing upstream).
3. Every deployed user re-downloads once (content-addressed names change) —
   but the new payload is 63% smaller, so the re-download is cheaper than a
   single old cold visit.
4. Browser packs still CARRY private bytes (the worker hides them from
   mounts); repacking the packs (core 370→124 MiB raw) is a separate
   follow-up that only affects real-import users' downloads.

## How the slim trees are produced (reproduce for future bakes)

```sh
# Umbrella tree (from the profile lib tree):
rsync -a --exclude='*.olean.private' --link-dest=$PWD/work/lib-tree \
  work/lib-tree/ work/lib-tree-slim/
# Core tree (from the toolchain artifact):
rsync -a --exclude='*.olean.private' \
  --link-dest=$PWD/pipeline/toolchain/work/build/stage1/lib/lean \
  pipeline/toolchain/work/build/stage1/lib/lean/ work/core-lib-slim/

npm run bake:snapshot -- --name mathlib --lib work/lib-tree-slim \
  --out work/slim-snapshots --reserve 3221225472 \
  --probe 'import QED64.Essential' --artifact pipeline/toolchain/work/build/stage1
npm run bake:snapshot -- --name init --lib work/core-lib-slim \
  --out work/slim-snapshots --reserve 1073741824 \
  --artifact pipeline/toolchain/work/build/stage1
```

Add the `--exclude` steps to the ship chain before its bake steps. The
runtime worker's `HIDE_PRIVATE_FACETS` mount filter (already on main) keeps
runtime real-imports consistent with the bake.

## Promote checklist (when merging this branch)

1. Merge; the only code delta is the 2048 MiB pre-commit in
   `frontend/src/qed64-boot.ts` (sized to the 1.11 GiB region + headroom).
2. Copy `work/slim-snapshots/*.snapz` + merge index into `public/snapshots`.
3. `scripts/upload-artifacts.sh` (additive; old snapshots stay for the
   currently-deployed shell), then push — the pinned-manifest scheme keeps
   the window closed as usual.
