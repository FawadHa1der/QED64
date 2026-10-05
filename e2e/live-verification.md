# Live browser verification

The manual checklist that lived here (ten steps against the 2026-08 CodeMirror
shell, last executed 2026-08-25) is retired. The live product loop is verified
by the adversarial suite instead:

- `tests/adversarial/e2e.mjs` — the end-to-end scenario battery over the served
  page (boot, examples, diagnostics, header switches, reload, the boot-race
  regression of HARDENING #26), run by `npm run test:adversarial` after
  `preflight.mjs` and the compiler battery;
- `docs/TESTING.md` "Adversarial suite" — every lane, its flags and what it
  proves.
