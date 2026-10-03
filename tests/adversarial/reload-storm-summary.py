#!/usr/bin/env python3
"""Summarize interleaved reload-storm arms (HARDENING #55).

  reload-storm-summary.py <run-dir> [--pairs a:b,c:d] [--md out.md]

Every reload-storm-<arm>-r<rep>.json in <run-dir> is one run of arm <arm>. Per arm: runs, crashes by OOM kind,
where they hit (reload index, ms after it), first-ready and ready-after-storm medians, the predecessor waits the
worker logged (#55), and per-reload process facts from the sampler (procs.tsv): whether the reload kept the
renderer process, its footprint before the reload, how far its thread count fell after it and when (the old
runtime's Worker threads exiting), and the highest memory-pressure level seen. --pairs: two-sided Fisher exact
tests on crashed runs between arms (default: every pair).
"""
import argparse
import collections
import glob
import json
import math
import os
import re
import statistics as st

ap = argparse.ArgumentParser()
ap.add_argument("dir")
ap.add_argument("--pairs", default="")
ap.add_argument("--md", default="")
a = ap.parse_args()
root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))


def fisher(a1, n1, a2, n2):
    """Two-sided Fisher exact p for crashed a1/n1 vs a2/n2."""
    K, N = a1 + a2, n1 + n2
    def pmf(k):
        return math.comb(n1, k) * math.comb(n2, K - k) / math.comb(N, K)
    p0 = pmf(a1)
    return min(1.0, sum(pmf(k) for k in range(max(0, K - n2), min(K, n1) + 1) if pmf(k) <= p0 * (1 + 1e-9)))


def procs_of(rel):
    if not rel:
        return None
    try:
        rows = collections.defaultdict(list)
        with open(os.path.join(root, rel)) as f:
            next(f)
            for line in f:
                e, pid, t, rss, fp, vs, th, pr = line.rstrip("\n").split("\t")
                if t == "renderer":
                    rows[int(e)].append((int(pid), int(fp), int(th), int(pr)))
        return sorted(rows.items())
    except FileNotFoundError:
        return None


def main_renderer(sample):
    return max(sample, key=lambda p: p[1]) if sample else None


def reload_facts(run, procs):
    """Per reload: kept process?, footprint MB before, thread drop and when."""
    out = []
    t0 = run["t0Epoch"]
    for r in run.get("reloads", []):
        R = t0 + r["t"]
        before = [s for e, s in procs if R - 400 <= e < R]
        after = [(e, s) for e, s in procs if R <= e < R + 2900]
        if not before or not after:
            continue
        mb = main_renderer(before[-1])
        later = [main_renderer(s) for e, s in after if main_renderer(s)]
        kept = all(p[0] == mb[0] for p in later[-3:]) if later else None
        same = [(e, p) for e, s in after for p in s if p[0] == mb[0]]
        if same:
            emin, pmin = min(same, key=lambda x: x[1][2])
            drop, tmin = mb[2] - pmin[2], emin - R
        else:
            drop, tmin = None, None
        pr = max([p[3] for e, s in procs if R - 400 <= e < R + 2900 for p in s] or [-1])
        out.append({"i": r["i"], "kept": kept, "fpBeforeMB": mb[1], "threadsBefore": mb[2], "threadDrop": drop, "minAtMs": tmin, "pressure": pr})
    return out


arms = collections.OrderedDict()
for f in sorted(glob.glob(os.path.join(a.dir, "reload-storm-*.json"))):
    m = re.match(r"reload-storm-(.+)-r(\d+)\.json$", os.path.basename(f))
    if not m:
        continue
    j = json.load(open(f))
    for run in j["runs"]:
        run["_rep"] = int(m.group(2))
        run["_procs"] = procs_of(run.get("procs"))
        arms.setdefault(m.group(1), []).append(run)

lines = []
def p(s=""):
    print(s)
    lines.append(s)

p(f"# reload-storm summary: {a.dir}")
p()
p("| arm | runs | crashed | kinds | crash at (reload, ms after) | first ready (median ms) | ready after storm (median ms) | predecessor waits (median ms, n) |")
p("|---|---|---|---|---|---|---|---|")
crash = {}
for arm, runs in arms.items():
    c = [r for r in runs if r["verdict"] in ("crashed", "crashed-before-ready")]
    crash[arm] = (len(c), len(runs))
    kinds = collections.Counter(r.get("oomKind") or "no OOM line" for r in c)
    where = ", ".join(f"r{r['_rep']}:{(r.get('crashAfterReload') or {}).get('reload')}/{(r.get('crashAfterReload') or {}).get('ms')}" for r in c)
    fr = [r["firstReadyMs"] for r in runs if r.get("firstReadyMs")]
    ra = [r["readyAfterMs"] for r in runs if r.get("readyAfterMs")]
    waits = [int(x) for r in runs for w in r.get("predecessorWaits", []) for x in re.findall(r"waited (\d+) ms", w["text"])]
    other = collections.Counter(r["verdict"] for r in runs if r["verdict"] not in ("crashed", "crashed-before-ready", "survived"))
    p(f"| {arm} | {len(runs)} | **{len(c)}/{len(runs)}**{(' + ' + str(dict(other))) if other else ''} | {dict(kinds) if kinds else '-'} | {where or '-'} | "
      f"{st.median(fr) if fr else '-'} | {st.median(ra) if ra else '-'} | {(str(st.median(waits)) + ', ' + str(len(waits))) if waits else '-'} |")
p()
names = list(arms)
pairs = [tuple(x.split(":")) for x in a.pairs.split(",") if ":" in x] or [(x, y) for i, x in enumerate(names) for y in names[i + 1:]]
p("Fisher exact (two-sided) on crashed runs:")
for x, y in pairs:
    if x in crash and y in crash:
        p(f"- {x} {crash[x][0]}/{crash[x][1]} vs {y} {crash[y][0]}/{crash[y][1]}: p = {fisher(crash[x][0], crash[x][1], crash[y][0], crash[y][1]):.3f}")
p()
p("Per-reload process facts (sampler; reloads 1–4 = the previous runtime was still booting):")
p("| arm | reloads | renderer kept | footprint before (median GB) | thread drop after reload (median) | lowest thread count at (median ms after reload) | max pressure level |")
p("|---|---|---|---|---|---|---|")
for arm, runs in arms.items():
    facts = [f for r in runs if r["_procs"] for f in reload_facts(r, r["_procs"])]
    if not facts:
        continue
    for label, sel in (("0", [f for f in facts if f["i"] == 0]), ("1–4", [f for f in facts if f["i"] > 0])):
        if not sel:
            continue
        kept = sum(1 for f in sel if f["kept"])
        drops = [f["threadDrop"] for f in sel if f["threadDrop"] is not None]
        tmins = [f["minAtMs"] for f in sel if f["minAtMs"] is not None]
        p(f"| {arm} | {label} ({len(sel)}) | {kept}/{len(sel)} | {st.median(f['fpBeforeMB'] for f in sel) / 1024:.1f} | "
          f"{st.median(drops) if drops else '-'} | {st.median(tmins) if tmins else '-'} | {max(f['pressure'] for f in sel)} |")
if a.md:
    open(a.md, "w").write("\n".join(lines) + "\n")
