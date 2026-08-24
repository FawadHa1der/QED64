#!/usr/bin/env python3
"""Dimensions 2-4: extern-with-no-definition sweep, dual-section stub-parity
check, EM_ASM/truncation sweep, and app-layer JS pointer-width audit."""
import os, re, sys, json
from collections import defaultdict

SRC = sys.argv[1]          # lean4 src tree (fixed worktree)
QED = sys.argv[2]          # qed64 root
report = {}

def read(p):
    try: return open(p, encoding="utf-8", errors="replace").read()
    except OSError: return ""

# ---------- collect @[extern "sym"] from Lean sources ----------
extern_syms = defaultdict(list)   # sym -> [lean file]
for root, dirs, files in os.walk(SRC):
    dirs[:] = [d for d in dirs if d not in (".git","stage0","tests")]
    for fn in files:
        if not fn.endswith(".lean"): continue
        p = os.path.join(root, fn)
        for m in re.finditer(r'@\[extern\s+"([^"]+)"', read(p)):
            extern_syms[m.group(1)].append(os.path.relpath(p, SRC))
print(f"@[extern] symbols in Lean sources: {len(extern_syms)}", file=sys.stderr)

# ---------- collect C/C++-side symbol occurrences ----------
c_defs = defaultdict(list)        # sym -> [(file, count_of_extern_defs)]
c_mentions = defaultdict(int)
c_files = {}
for root, dirs, files in os.walk(SRC):
    dirs[:] = [d for d in dirs if d not in (".git","stage0","tests")]
    for fn in files:
        if not fn.endswith((".cpp",".c",".h",".hpp")): continue
        p = os.path.join(root, fn)
        text = read(p)
        c_files[os.path.relpath(p, SRC)] = text

for rel, text in c_files.items():
    for sym in extern_syms:
        if sym in text:
            c_mentions[sym] += text.count(sym)
            n_defs = len(re.findall(r'extern\s+"C"[^;{]*\b' + re.escape(sym) + r'\s*\([^;{]*\)\s*\{', text))
            n_defs += len(re.findall(r'^\s*(?:static\s+inline|LEAN_EXPORT)[^;{]*\b' + re.escape(sym) + r'\s*\([^;{]*\)\s*\{', text, re.M))
            if n_defs: c_defs[sym].append((rel, n_defs))

LIBC = {"memcpy","memmove","memcmp","memset","strlen","strcmp","strncmp","malloc","free","calloc","realloc",
        "isatty","exit","abort","getenv","fopen","fclose","fread","fwrite","printf","fprintf","sin","cos",
        "tan","asin","acos","atan","atan2","sinh","cosh","tanh","exp","log","log2","log10","sqrt","cbrt",
        "pow","fmod","ceil","floor","round","fabs","atof","strtod","frexp","modf","fma","expm1","log1p",
        "erf","erfc","tgamma","lgamma","trunc","rint","nearbyint","remainder","copysign","nan","fmax","fmin"}
missing = []
for sym, leanfiles in sorted(extern_syms.items()):
    if sym in LIBC or sym.split("_")[0] in ("mpz","gmp"): continue
    if not c_defs.get(sym):
        missing.append({"sym": sym, "lean": leanfiles[:2], "c_mentions": c_mentions.get(sym, 0)})
report["extern_no_definition"] = missing
print(f"@[extern] with no C definition found: {len(missing)}", file=sys.stderr)
for e in missing[:40]:
    print(f"  {e['sym']}  (lean: {e['lean'][0]}; C mentions: {e['c_mentions']})", file=sys.stderr)

# ---------- dual-section stub parity (the libuv-stub class) ----------
parity = []
for rel, text in c_files.items():
    if "/uv/" not in rel and not rel.endswith(("libuv.cpp","openssl.cpp")): continue
    has_guard = "LEAN_EMSCRIPTEN" in text or "LEAN_LIBUV" in text or "LEAN_SSL" in text or "#else" in text
    if not has_guard: continue
    counts = defaultdict(int)
    for m in re.finditer(r'extern\s+"C"[^;{]*\b(lean_\w+)\s*\([^;{]*\)\s*\{', text):
        counts[m.group(1)] += 1
    singles = [s for s, n in counts.items() if n == 1]
    doubles = [s for s, n in counts.items() if n >= 2]
    if singles and doubles:   # file follows the two-section pattern but some symbols exist once
        parity.append({"file": rel, "single_def": sorted(singles), "dual_def_count": len(doubles)})
report["stub_parity"] = parity
print(f"dual-section files with parity gaps: {len(parity)}", file=sys.stderr)
for e in parity:
    print(f"  {e['file']}: singletons {e['single_def'][:10]} (dual: {e['dual_def_count']})", file=sys.stderr)

# ---------- EM_ASM / truncation sweep ----------
patterns = {
    "EM_ASM_INT": re.compile(r'EM_ASM_INT'),
    "EM_ASM_DOUBLE": re.compile(r'EM_ASM_DOUBLE'),
    "EM_JS": re.compile(r'\bEM_JS\b'),
    "ptr_to_int_cast": re.compile(r'\((?:int|unsigned|uint32_t|int32_t)\)\s*\(?\s*(?:\w+\s*\*|uintptr_t|intptr_t|size_t)'),
    "reinterpret_to_i32": re.compile(r'(?:int|uint32_t|unsigned)\s*\)\s*reinterpret_cast'),
    "HEAP32_in_cpp": re.compile(r'HEAPU?32'),
}
sweep = []
for rel, text in c_files.items():
    for name, pat in patterns.items():
        for m in pat.finditer(text):
            line_no = text[:m.start()].count("\n") + 1
            line = text.splitlines()[line_no-1].strip()[:160]
            sweep.append({"file": rel, "line": line_no, "kind": name, "text": line})
report["truncation_sweep"] = sweep
print(f"truncation-sweep hits: {len(sweep)}", file=sys.stderr)
for e in sweep[:30]:
    print(f"  [{e['kind']}] {e['file']}:{e['line']}  {e['text']}", file=sys.stderr)

# ---------- QED64 JS/TS pointer-width audit ----------
js_pat = {
    "getValue_i32": re.compile(r"getValue\([^)]*['\"]i32['\"]"),
    "setValue_i32": re.compile(r"setValue\([^)]*['\"]i32['\"]"),
    "HEAP32": re.compile(r"\bHEAPU?32\b"),
    "Number_on_bigint": re.compile(r"Number\(\s*\w*(ptr|addr|Ptr|Addr|obj|res)\w*"),
    "hard_2gb": re.compile(r"\b32768\b"),
    "plus4_stride": re.compile(r"\+\s*4\s*\*"),
    "i64_read": re.compile(r"getValue\([^)]*['\"](i64|\*)['\"]"),
    "bigint_mem": re.compile(r"address:\s*['\"]i64['\"]"),
}
qhits = []
for root, dirs, files in os.walk(QED):
    dirs[:] = [d for d in dirs if d not in ("node_modules",".git","dist","work")]
    for fn in files:
        if not fn.endswith((".js",".ts",".mjs",".cjs",".worker.js")): continue
        p = os.path.join(root, fn)
        text = read(p)
        rel = os.path.relpath(p, QED)
        for name, pat in js_pat.items():
            for m in pat.finditer(text):
                line_no = text[:m.start()].count("\n") + 1
                line = text.splitlines()[line_no-1].strip()[:200]
                qhits.append({"file": rel, "line": line_no, "kind": name, "text": line})
report["qed64_js"] = qhits
print(f"qed64 JS hits: {len(qhits)}", file=sys.stderr)
for e in qhits[:40]:
    print(f"  [{e['kind']}] {e['file']}:{e['line']}  {e['text']}", file=sys.stderr)

json.dump(report, open(sys.argv[3], "w"), indent=1)
