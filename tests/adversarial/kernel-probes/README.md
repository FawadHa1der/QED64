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

## Adding them to the battery (with the fixing pairing bump, not before)

They are RED on the served pairing by definition, so they are kept beside the
corpus until the fixed runtime is staged; then merge and run the battery
against the staged pairing:

```sh
python3 -c "import json; c=json.load(open('tests/adversarial/corpus.json')); n={x['name'] for x in c}; c+=[x for x in json.load(open('tests/adversarial/kernel-probes/corpus-cases.json')) if x['name'] not in n]; json.dump(c, open('tests/adversarial/corpus.json','w'), indent=2, ensure_ascii=False)"
```

`module-file.lean` needs the compile path to accept a `module` header
(one-shot CLI: yes); if the battery's alias rewrite or the umbrella-served
header cannot express it, keep that one as a kernel-gate probe only.
