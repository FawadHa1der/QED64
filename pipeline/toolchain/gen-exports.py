#!/usr/bin/env python3
"""Generate src/emscripten-exports.txt at build time (patch 0032, K4).

The list is a CORRECTNESS contract with the IR interpreter, not a performance
list (cauli/lean4 62b6a22913, 2ac4cf3cae, 72f7b022d7; re-derived by the kernel
session on 2026-09-21 from the compiled C): the committed historical list
(src/emscripten-exports.wanted.txt) is exactly three categories of the tree
it was made from, and no plain function at all -
  * every `l_*___boxed` wrapper  (missing: deep interpreted recursion, the
    ~1 MB worker stack overflows),
  * every initialize_/runtime_initialize_/meta_initialize_<Module>  (missing:
    the module's init attributes are re-run interpreted - "Option already
    exists"),
  * every LEAN_EXPORT constant cell  (missing: the initializer is re-run
    interpreted and diverges from the native state, e.g. a second IO.Ref).
Plain functions stay out: exporting them defeats dead-code stripping (+18 MB).
A name the C does not define fails the LINK (HARDENING #31), so everything is
derived from, or filtered against, the compiled C of THIS build.

Two rules:
  historical (default until the next pairing bump): seed + (wanted & defined).
    Reproduces the served binary of the current KERNEL-PIN. It can only
    shrink, so it silently omits anything new: measured on the 0033 tree it
    lacks 67 boxed wrappers and 3 cells introduced by our own patches
    (Shell, Language/Lean, Environment, FileWorker - including the 0032
    registry cell `prebuiltEnvSource`), and on a version import it would
    omit thousands.
  generated (--rule generated; the default from the next bump on):
    seed + all boxed + all module initializers + all cells. Changing rule
    changes lean.wasm, i.e. the build id and the snapshot pairing - flip it
    only together with a pairing bump.

Usage: gen-exports.py <stage1/lib/temp> <lean4/src> [--rule historical|generated] [--check]
  --check: do not write; report stale wanted names and what the historical
           rule omits relative to the generated one.
"""
import os
import re
import sys

temp, src = sys.argv[1], sys.argv[2]
check = "--check" in sys.argv
rule = sys.argv[sys.argv.index("--rule") + 1] if "--rule" in sys.argv else "historical"
assert rule in ("historical", "generated"), rule
ROOTS = ("Init", "Std", "Lean")
pat = re.compile(r'^LEAN_EXPORT\s+[A-Za-z_][A-Za-z0-9_ \*]*?\b((?:l_|initialize_|runtime_initialize_|meta_initialize_)[A-Za-z0-9_]+)\s*(\(|;|=)', re.M)
defined = set()
kind = {}  # name -> "fn" | "cell" (by the character after the name; "fn" wins over a forward declaration)

def scan(path):
    with open(path, errors="ignore") as fh:
        for m in pat.finditer(fh.read()):
            n = "_" + m.group(1)
            defined.add(n)
            if kind.get(n) != "fn":
                kind[n] = "fn" if m.group(2) == "(" else "cell"

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
INIT = ("_initialize_", "_runtime_initialize_", "_meta_initialize_")
category = lambda n: "cell" if kind[n] == "cell" else "init" if n.startswith(INIT) else "boxed" if n.endswith("___boxed") else None
generated = sorted(n for n in defined if category(n))
keptset = set(kept)
omitted = [n for n in generated if n not in keptset]
body = generated if rule == "generated" else kept
final = seed + [k for k in body if k not in seedset]
print(f"rule {rule}: defined {len(defined)}; wanted {len(wanted)} -> kept {len(kept)}, stale dropped {len(stale)}; seed {len(seed)}; final {len(final)}")
for d in stale[:12]:
    print("  stale:", d)
if omitted:
    by = {}
    for n in omitted:
        by[category(n)] = by.get(category(n), 0) + 1
    print(f"  the historical rule omits {len(omitted)} contract names of this build: {by}" + ("" if rule == "generated" else " - flip to --rule generated at the next pairing bump"))
if check:
    sys.exit(0)
target = os.path.join(src, "emscripten-exports.txt")
with open(target, "w") as fh:
    fh.write("\n".join(final) + "\n")
print(f"wrote {target}")
