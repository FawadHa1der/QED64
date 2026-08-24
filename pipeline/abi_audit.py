#!/usr/bin/env python3
"""Extended Lean C-ABI audit.

Compares hand-written `extern "C"` declarations/definitions in Lean's C++
sources against the prototypes the Lean compiler emits in generated C, under
BOTH wasm64 and wasm32 lowerings, and enumerates spelling-level drift.
"""
import os, re, sys, json, subprocess
from collections import defaultdict

HAND_SRC = sys.argv[1]            # e.g. .../experiments/lean4-wasm64/src  (fixed) or sources/lean4/src (unfixed)
GEN_DIR  = sys.argv[2]            # .../lean4-wasm64-build/stage1/lib/temp
OUT      = sys.argv[3]

# ---------------- type categorization ----------------
PTR_TYPEDEFS = {
    "lean_obj_arg","b_lean_obj_arg","u_lean_obj_arg","lean_obj_res",
    "obj_arg","b_obj_arg","u_obj_arg","obj_res",
}
USIZE = {"size_t","usize","uintptr_t","intptr_t","ptrdiff_t","ssize_t"}
I64   = {"uint64_t","int64_t","uint64","int64","longlong","unsignedlonglong"}
I32   = {"bool","uint8_t","int8_t","uint16_t","int16_t","uint32_t","int32_t",
         "uint8","int8","uint16","int16","uint32","int32","int","unsigned",
         "char","short","unsignedchar","unsignedshort","unsignedint","signedchar"}
WIDTH_DEP = {"long","unsignedlong"}  # ILP32 vs LP64: i32 on wasm32, i64 on wasm64

OBJPTR_SPELLINGS = {"object*","lean_object*","object**","lean_object**"}
FINE = {
    "bool":"BOOL","uint8_t":"U8","uint8":"U8","int8_t":"I8","int8":"I8",
    "uint16_t":"U16","uint16":"U16","int16_t":"I16","int16":"I16",
    "uint32_t":"U32","uint32":"U32","unsigned":"U32","unsignedint":"U32",
    "int32_t":"I32","int32":"I32","int":"I32",
    "uint64_t":"U64","uint64":"U64","int64_t":"I64","int64":"I64",
    "longlong":"I64","unsignedlonglong":"U64",
    "char":"CHAR","short":"I16","unsignedshort":"U16","unsignedchar":"U8","signedchar":"I8",
    "double":"F64","float":"F32",
}
def categorize(tok: str) -> str:
    t = tok.strip()
    t = re.sub(r"\bconst\b|\bstruct\b|\brestrict\b|\bvolatile\b", "", t)
    t = re.sub(r"\s+", "", t)
    if not t or t == "void": return "VOID"
    if t in OBJPTR_SPELLINGS or t in PTR_TYPEDEFS: return "OBJPTR"
    if t.endswith("*") or t.endswith("&"): return "PTR"
    if t in USIZE: return "USIZE"
    if t in WIDTH_DEP: return "WDEP"
    if t in FINE: return FINE[t]
    if t.startswith("lean_") or t.startswith("b_lean"): return "OBJPTR"
    return f"UNK({t})"

def lower(cat: str, wasm64: bool) -> str:
    if cat in ("PTR","OBJPTR","USIZE","WDEP"): return "i64" if wasm64 else "i32"
    if cat in ("U64","I64"): return "i64"
    if cat in ("BOOL","U8","I8","U16","I16","U32","I32","CHAR"): return "i32"
    if cat in ("F32","F64","VOID"): return cat
    return cat

def split_args(argstr: str):
    args, depth, cur = [], 0, ""
    for ch in argstr:
        if ch == "(": depth += 1
        if ch == ")": depth -= 1
        if ch == "," and depth == 0:
            args.append(cur); cur = ""
        else:
            cur += ch
    if cur.strip(): args.append(cur)
    out = []
    for a in args:
        a = a.strip()
        if a in ("void",""): continue
        if "(*" in a or "(&" in a: out.append("PTR"); continue   # function pointer param
        # drop trailing parameter name if present
        m = re.match(r"^(.*?)([A-Za-z_]\w*)?$", a.replace("[]","*"))
        ty = m.group(1).strip() if m and m.group(1).strip() else a
        # if the "type" lost its star to the name split, recover
        if not ty: ty = a
        out.append(categorize(ty))
    return out

PROTO = re.compile(
    r'(?:LEAN_EXPORT\s+|LEAN_SHARED\s+|static\s+|inline\s+|__attribute__\s*\(\([^)]*\)\)\s*)*'
    r'((?:[A-Za-z_][\w:]*\s+)*[A-Za-z_][\w:]*\s*\**)\s*'
    r'\b(lean_\w+|llvm_\w+|initialize_\w+|lean\w*_\w+)\s*\(([^;{]*?)\)\s*(;|\{)',
    re.S)

def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", " ", text)
    return text

# ---------------- pass 1: hand-written C++ ----------------
hand = defaultdict(list)   # sym -> list of dicts
for root, dirs, files in os.walk(HAND_SRC):
    dirs[:] = [d for d in dirs if d not in ("stage0",".git","tests","lake-packages")]
    for fn in files:
        if not fn.endswith((".cpp",".h",".c",".hpp")): continue
        path = os.path.join(root, fn)
        try: text = strip_comments(open(path, encoding="utf-8", errors="replace").read())
        except OSError: continue
        rel = os.path.relpath(path, HAND_SRC)
        is_lean_h = rel.endswith("include/lean/lean.h")
        # scan windows that follow extern "C" (individual or block); lean.h is all C ABI
        spans = []  # (span_text, is_window)
        if is_lean_h:
            spans = [(text, False)]
        else:
            for m in re.finditer(r'extern\s+"C"\s*(\{?)', text):
                if m.group(1) == "{":
                    spans.append((text[m.end():], False))
                else:
                    spans.append((text[m.end(): m.end()+2000], True))
        for span, is_window in spans:
            for pm in PROTO.finditer(span):
                ret_raw, sym, args_raw, term = pm.groups()
                # a single-decl window must match right at its start
                if is_window and pm.start() > 40:
                    continue
                cats = split_args(args_raw)
                hand[sym].append({
                    "file": rel, "ret_raw": " ".join(ret_raw.split()), "args_raw": " ".join(args_raw.split()),
                    "ret": categorize(ret_raw), "args": cats, "kind": "def" if term == "{" else "decl",
                    "lean_h": is_lean_h,
                })

hand_syms = sorted(hand.keys())
print(f"hand-written symbols: {len(hand_syms)}", file=sys.stderr)

# ---------------- pass 2: generated C prototypes (pure-python streaming scan) ----------------
gen = defaultdict(list)
hand_set = set(hand_syms)
proto_line = re.compile(r'^[A-Za-z_][\w \t\*]*?\b([A-Za-z_]\w*)\(([^;{]*)\)\s*(?:;|\{)\s*$')
seen_lines = set()
nfiles = 0
for root, dirs, files in os.walk(GEN_DIR):
    for fn in files:
        if not fn.endswith(".c"): continue
        nfiles += 1
        try:
            fh = open(os.path.join(root, fn), encoding="utf-8", errors="replace")
        except OSError: continue
        with fh:
            for line in fh:
                if "(" not in line or (";" not in line and "{" not in line): continue
                c0 = line[0]
                if not (c0.isalpha() or c0 == "_"): continue
                if line in seen_lines: continue
                m = proto_line.match(line)
                if not m: continue
                sym = m.group(1)
                if sym not in hand_set: continue
                head = line[:m.start(1)].strip()
                if head in ("return", "goto", "else return") or head.endswith(" return"): continue
                seen_lines.add(line)
                ret_raw = line[:m.start(1)].replace("LEAN_EXPORT"," ").replace("extern"," ")
                args_raw = m.group(2)
                gen[sym].append({"ret_raw": " ".join(ret_raw.split()), "args_raw": args_raw.strip(),
                                 "ret": categorize(ret_raw), "args": split_args(args_raw)})
        if nfiles % 500 == 0:
            print(f"  scanned {nfiles} generated files...", file=sys.stderr)

print(f"generated decls found for {len(gen)} symbols", file=sys.stderr)

# ---------------- pass 3: compare ----------------
def sigkey(d): return (d["ret"], tuple(d["args"]))
def lowkey(d, w64): return (lower(d["ret"], w64), tuple(lower(a, w64) for a in d["args"]))

findings = {"LOWER64": [], "LOWER32": [], "ARITY": [], "SPELL": [], "GEN_INTERNAL": []}
for sym in sorted(gen.keys()):
    gsigs = {sigkey(d): d for d in gen[sym]}
    hsigs = {sigkey(d): d for d in hand[sym]}
    # generated-internal disagreement
    if len({lowkey(d, True) for d in gen[sym]}) > 1:
        findings["GEN_INTERNAL"].append({"sym": sym, "gen": [dict(g) for g in gsigs.values()]})
    g = gen[sym][0]
    # pick the hand-written DEF if present else first decl (skip lean.h-only: compiler-checked)
    hs = [h for h in hand[sym] if not h["lean_h"]]
    if not hs: continue
    h = next((x for x in hs if x["kind"] == "def"), hs[0])
    entry = {"sym": sym, "hand": {k: h[k] for k in ("file","ret_raw","args_raw","kind")},
             "gen": {"ret_raw": g["ret_raw"], "args_raw": g["args_raw"]},
             "hand_cats": [h["ret"]] + h["args"], "gen_cats": [g["ret"]] + g["args"]}
    if len(h["args"]) != len(g["args"]):
        findings["ARITY"].append(entry); continue
    if lowkey(h, True) != lowkey(g, True):
        findings["LOWER64"].append(entry); continue
    if lowkey(h, False) != lowkey(g, False):
        findings["LOWER32"].append(entry); continue
    if sigkey(h) != sigkey(g):
        findings["SPELL"].append(entry)

with open(OUT, "w") as f:
    json.dump({"hand_count": len(hand_syms), "gen_count": len(gen), "findings": findings}, f, indent=1)
for k, v in findings.items():
    print(f"{k}: {len(v)}", file=sys.stderr)
    for e in v[:40]:
        if k == "GEN_INTERNAL":
            print(f"  {e['sym']}: {[g['ret_raw']+' ('+g['args_raw']+')' for g in e['gen']]}"[:300], file=sys.stderr)
        else:
            print(f"  {e['sym']}: hand[{e['hand']['ret_raw']} ({e['hand']['args_raw']})] vs gen[{e['gen']['ret_raw']} ({e['gen']['args_raw']})] @ {e['hand']['file']}"[:400], file=sys.stderr)
