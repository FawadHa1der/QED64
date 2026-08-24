# Live browser verification script

Until Playwright wiring lands, this is the manual gate (all steps were
executed and passed on 2026-08-20, in-app Chromium 148):

1. `npm run dev` → open http://localhost:5173 (COOP/COEP verified in Setup).
2. Cold visit: core installs (119.7 MB → OPFS or memory), runtime verifies,
   status reaches **Ready**; Setup log shows capability ✓✓✓ line.
3. Welcome example auto-checks: with `public/snapshots/init.snap` present the
   verdict arrives < 1 s ("Init snapshot loaded … first check is instant").
4. `#check`/`#eval` results appear as INFORMATION cards with locations;
   clicking a card moves the cursor.
5. Type a broken proof (`example : (1+1:Nat) = 3 := by rfl`): red squiggle at
   `rfl`, ERROR card with goal state, recheck < 1 s, Goals tab shows `⊢`.
6. Setup → Install Mathlib (~993 MB): progress bar, then Ready again. On
   quota-limited engines expect the "in memory for this session" note.
7. Mathlib example: first check minutes (import), verdict ✓; add
   `example … := (mul_assoc a b c).symm` → recheck ~100 ms.
8. Reload the page: core comes "from OPFS cache"; no re-download.
9. Kill the dev server mid-install: the app reports a failed install, no
   stuck progress bar, and a reload recovers.
