# Kernel probes: the environment's own facts for a user file

Probes for the defect in docs/HARDENING.md #51 (found 2026-09-30): on the
served 4.34 pairing a LEGACY buffer is elaborated with module semantics
because the fork imports at `OLeanLevel.exported` on Emscripten and lets
`importModules` default `isModule := level != .private` (true). Expected
behaviour is stock Lean's. Run each with the one-shot CLI (node-runner) or
in the browser (`work/widget-probe2.cjs <url> <file> <line> <regex>`); three of them become compiler-battery cases with the fixing pairing bump
(`module-file.lean` stays a gate + browser probe: the battery cannot express
a `module` header). `browser-check.sh <url>` runs all four through the real
resident FileWorker (the prebuilt-environment branch, which the compile path
of the battery does not exercise).

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
python3 - <<'EOF'
import json
p='tests/adversarial/corpus.json'; c=json.load(open(p)); items=c['items'] if isinstance(c,dict) else c
have={x['name'] for x in items}
items+=[x for x in json.load(open('tests/adversarial/kernel-probes/corpus-cases.json')) if x['name'] not in have]
json.dump(c, open(p,'w'), indent=2, ensure_ascii=False); open(p,'a').write('\n')
EOF
```

`module-file.lean` needs the compile path to accept a `module` header
(one-shot CLI: yes); if the battery's alias rewrite or the umbrella-served
header cannot express it, keep that one as a kernel-gate probe only.
