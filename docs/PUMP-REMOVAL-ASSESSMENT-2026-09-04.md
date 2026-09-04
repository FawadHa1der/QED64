# Can the pump transport be removed? — assessment (2026-09-04)

Produced by a 24-agent inventory (page, worker + runtime client, kernel fork,
tests/scripts/docs, lean4game consumer) followed by three gap-finding lenses
and two skeptics per gap. Read-only; nothing was changed.

## Answer

Yes. Remove it in three ordered steps. Step 1 is page-side only and deletes
about 1,600 lines with no artifact change. Step 3 (the kernel) must wait for
the next pairing bump, because any kernel-side deletion changes `lean.wasm`,
the build id and therefore the snapshot pairing every visitor has cached.
The lean4game port is the only external dependency and it is frozen, not
broken, until its owners port.

## What the pump path is, by size

| where | pump-only lines | notes |
|---|---|---|
| `frontend/src/watchdog-shim.ts` | 1,253 (whole file) | ~140 of them are a dead in-shim resident experiment (`mode.resident`, `lsp-resident-init/send`) |
| `frontend/src/main.ts` | 24 + de-indent of the resident branch | `?resident` switch, shim construction, `status()` fallback |
| `src/runtime/umbrella.ts` + test, `src/app.ts` batch app | 70 + 73 + app | already scheduled by the second review (S6) |
| `public/workers/lean.worker.js` | ≈55 (+70 dead `lsp-resident-*` ops) | `lspInit`/`lspSend`, dispatch, `lsp-threads`; ring-writer tests reference the dead ops |
| `src/runtime/client.ts` | ≈25 | `onStateChange`/`SessionState` mirror; keep a `dead` boolean |
| kernel `Shell.lean` | ≈162 (lines 318–471) | pump entry points, covering loop that duplicates `lookupPrebuiltEnv` |
| kernel `FileWorker.lean` | 15 | `teardownForReplacement` |
| kernel exports seed | 2 lines | must go with the Shell block or the link fails |
| patches | 0018, 0023, 0027 whole; 0024(a); Shell hunks of 0021/0025 | 0021/0025 hooks are load-bearing for the resident resolver — split, don't drop |
| `pipeline/lsp/lsp-pump-probe.mjs` | 255 | not wired into the gate |
| tests | e2e 45, latency 35, harness `mode`, gate pump lanes | plus two e2e checks that are vacuous today (below) |
| docs | both architecture reviews, LEAN4WEB-FEASIBILITY, plan pump columns | become historical; ARCHITECTURE.md describes neither transport |

## Gaps the skeptics could not refute (fix these before or with step 1)

1. **Alias-only header gets a pointless collision offer.** `import Mathlib` resolves as *covered* (alias), so `inductive Tree` triggers the note and "Load exact imports" — whose exact environment is the same umbrella. The pump suppressed the note for the four aliases. Fix: gate the collision fact in the front door on the normalized `key` the header status already carries (a set of four names).
2. **Boot failure reason is invisible.** A first boot that fails (Memory64 reservation, capability missing, runtime fetch, snapshot pairing) reaches the page as a bare `halted`; the pump showed "could not start: reason" with Reload. Fix: carry the death message through the relay (`onDied(code, reason, message)`), map halt-before-first-ready to the existing failure card (~10 lines).
3. **Every boot commits 2 GiB and loads Mathlib.** The pump booted Init-only documents light (256 MiB, init snapshot only). The second review already accepted this as amendment 15 and it is unimplemented. Fix: hoist the buffer read above relay construction, pick `snapshots` and `initialBytes` from the header (~15 lines in main.ts).
4. **First library search hint.** `exact?`/`apply?`/`rw?` past 8 s showed "first library search — indexing Mathlib (about a minute, once per session)"; resident shows a bare elapsed ticker. Fix: ~12 UI lines in `renderStatus`.
5. **Halted checker leaves no in-document note** (split verdict). After the breaker trips the relay answers requests with a self-describing error and the pill says halted, but the dead session's markers stay. Fix: post one whole-document publish from the breaker branch.
6. **Full-text frames over 2 MiB are refused by the 4 MiB ring** (split verdict; an order of magnitude outside the product envelope). Fix: raise `RESIDENT_RING_CAP` to 64 MiB.

Refuted: olean fallback when a snapshot is missing (resident deliberately halts; the pack path is the offer), the halted explanation surface, header-refusal guidance (present; one wording clause to tidy), incremental sync for huge documents.

Unverified but worth a look during step 1: synchronous worker terminate on `pagehide` (the pump's fix for reload storms stacking dead 3.5 GiB heaps — confirm `relay.unload()` terminates inside the event); restart options forgotten across crash reboots after "Load exact imports" (the umbrella comes back with its collision note); body-position InfoView answers while an import line is half-typed (the pump kept the previous session alive; resident's refused header has no environment).

## The lean4game consumer

The game is entirely on the pump: it imports `WatchdogShim`, calls `lsp-init`/`lsp-send`, uses the `coveringSnapshotFor` per-header policy hook, a 3 GiB memory cap and `pagehide → disposeForUnload`. Its shipped build is a byte-verified vendored copy at pin `e5df87a`, so deleting the pump upstream breaks nothing that is deployed. What breaks is the bump path: `scripts/sync-qed64.sh` refuses any later commit because `watchdog-shim.ts` is missing. A resident port there needs: a kernel bump to ≥ 0032 (their pin `852d1b9` lacks the ring exports and the resolver, so the resident path cannot boot on it), a rebake of the game snapshots, a vendorable session adapter (today `ResidentSession` lives inside `main.ts`), the relay and front door in their sync list, and the Cypress suite as the gate. That is their campaign; qed64's step 1 should extract the adapter into a module with the two policy hooks (snapshots per header, memory cap) so the port is mostly wiring.

## Recommended order

1. **Page, worker, tests (now; no artifact change).** Close gaps 1–6, extract `ResidentSession` to `frontend/src/resident-session.ts` with policy hooks, delete the shim + umbrella + batch app + pump worker ops + the dead in-shim resident ops + the client mirror, collapse harness `mode`, drop the pump lanes, fix the two vacuous e2e taps (`final-memory` reads `shim.qs.session`, the kill drill reads `shim.stats` — both undefined on resident, both pass by accident today), keep the parity numbers in the plan as the historical A/B record, and write a living resident architecture section (front door, relay, in-kernel resolver) into ARCHITECTURE.md before archiving the two review docs.
2. **lean4game port (their repo).** Kernel bump + relay adapter; until then the game stays frozen at `e5df87a`.
3. **Kernel (at the next pairing bump, not on its own).** Delete Shell.lean 318–471 and `teardownForReplacement`, the two seed export lines, `lsp-pump-probe.mjs`; regroup patches 0018/0023/0027/0024(a) and the Shell hunks of 0021/0025; measure patch 0020 (keepalive) before dropping it, since resident still runs library-style calls before `main`; restate the promote rule for resident only.

## What is genuinely lost

The in-field fallback and the A/B control lane (the 2,571 ms vs 322 ms comparison cannot be re-measured afterwards); the Node probe that asserts InfoView goals over `$/lean/rpc/call` (port to `resident-probe.mjs` if wanted); and the in-process import of an uncovered header at session init without a reboot (resident's substitute is the exact-imports restart with a warm compile, about a minute, the same as today's offer).
