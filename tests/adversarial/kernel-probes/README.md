# Kernel probes: the environment's own facts for a user file

Probes for the defect in docs/HARDENING.md #51 (found 2026-09-30): on the
served 4.34 pairing a LEGACY buffer is elaborated with module semantics
because the fork imports at `OLeanLevel.exported` on Emscripten and lets
`importModules` default `isModule := level != .private` (true). Expected
behaviour is stock Lean's. Run each with the one-shot CLI (node-runner) or
in the browser (`work/widget-probe2.cjs <url> <file> <line> <regex>`); the
same four become compiler-battery cases with the fixing pairing bump.

| file | expected (stock Lean) | served wasm64-36a96239e08fd2e0 |
|---|---|---|
| `is-module.lean` | `isModule=false` | `isModule=true` |
| `private-default.lean` | `plainDef` public, `pubDef` public (no `_private` prefix) | `plainDef`, `plainThm` are `_private.«…».0.*`; only `pubDef` public |
| `rpc-attr.lean` | compiles, no error | `Cannot add attribute [server_rpc_method]: Declaration askServer must be marked as meta` |
| `module-file.lean` | `isModule=true` | (must stay true after the fix) |
