#!/usr/bin/env python3
"""Generate src/emscripten-exports.txt at build time (patch 0032, K4).

Exports are a PERFORMANCE list (which compiled Lean functions the interpreter
may dispatch to natively via dlsym) plus a small set of runtime/glue symbols
JS calls. Two facts drive the rule:
  * a name the C does not define fails the LINK (four stale-specialization
    incidents, HARDENING #31) - so the list is filtered against the compiled
    C on every build;
  * exporting every LEAN_EXPORT definition defeats dead-code stripping
    (+18 MB wasm, more compiled-code memory) - so the list must not grow.
Rule: final = seed + (wanted & defined). `wanted` is the committed historical
list (src/emscripten-exports.wanted.txt) that can only shrink and is never
hand-edited for renames; `seed` (src/emscripten-exports.seed.txt) holds the
runtime C API and glue names. A renamed specialization simply drops out (the
interpreter interprets it) instead of breaking the build.

Usage: gen-exports.py <stage1/lib/temp> <lean4/src> [--check]
  --check: do not write; report how many wanted names are stale.
"""
import os
import re
import sys

temp, src = sys.argv[1], sys.argv[2]
check = "--check" in sys.argv
ROOTS = ("Init", "Std", "Lean")
pat = re.compile(r'^LEAN_EXPORT\s+[A-Za-z_][A-Za-z0-9_ \*]*?\b((?:l_|initialize_|runtime_initialize_|meta_initialize_)[A-Za-z0-9_]+)\s*(?:\(|;|=)', re.M)
defined = set()

def scan(path):
    with open(path, errors="ignore") as fh:
        for m in pat.finditer(fh.read()):
            defined.add("_" + m.group(1))

for root in ROOTS:
    for r, _, files in os.walk(os.path.join(temp, root)):
        for f in files:
            if f.endswith(".c"):
                scan(os.path.join(r, f))
    top = os.path.join(temp, root + ".c")
    if os.path.exists(top):
        scan(top)

def read_list(name):
    p = os.path.join(src, name)
    return [l.strip() for l in open(p) if l.strip() and not l.startswith("#")]

seed = read_list("emscripten-exports.seed.txt")
wanted = read_list("emscripten-exports.wanted.txt")
kept = [w for w in wanted if w in defined]
stale = [w for w in wanted if w not in defined]
seedset = set(seed)
final = seed + [k for k in kept if k not in seedset]
print(f"defined {len(defined)}; wanted {len(wanted)} -> kept {len(kept)}, stale dropped {len(stale)}; seed {len(seed)}; final {len(final)}")
for d in stale[:12]:
    print("  stale:", d)
if check:
    sys.exit(0)
target = os.path.join(src, "emscripten-exports.txt")
with open(target, "w") as fh:
    fh.write("\n".join(final) + "\n")
print(f"wrote {target}")
