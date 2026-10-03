#!/usr/bin/env python3
"""Line up a reload-storm report with its renderer samples (HARDENING #55).

  reload-storm-timeline.py <reload-storm-<tag>.json> [--run N] [--window-ms 3000] [--step-ms 100]

For every reload of every run (or of run N): the renderer(s) alive around it (pid, threads, footprint
GB) every --step-ms from 300 ms before the reload to --window-ms after it, and the worker events in that
window: the old instance's workers closing, the new instance's lean.worker and pthread (blob) Workers
being created. The crash and the V8 OOM lines are marked where they fall. Needs the run's procs.tsv
(reload-storm.mjs --sample-ms).
"""
import argparse
import collections
import json
import os
import sys

ap = argparse.ArgumentParser()
ap.add_argument("report")
ap.add_argument("--run", type=int, default=None)
ap.add_argument("--window-ms", type=int, default=3000)
ap.add_argument("--step-ms", type=int, default=100)
a = ap.parse_args()
rep = json.load(open(a.report))
root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."))


def load_procs(rel):
    rows = collections.defaultdict(list)  # epoch -> [(pid, type, rss, fp, vs, threads, pressure)]
    try:
        with open(os.path.join(root, rel)) as f:
            next(f)
            for line in f:
                e, pid, t, rss, fp, vs, th, pr = line.rstrip("\n").split("\t")
                rows[int(e)].append((int(pid), t, int(rss), int(fp), float(vs), int(th), int(pr)))
    except FileNotFoundError:
        return None
    return sorted(rows.items())


for run in rep["runs"]:
    if a.run is not None and run["n"] != a.run:
        continue
    t0 = run.get("t0Epoch")
    print(f"=== run {run['n']} {rep.get('mode')} {'embedded' if rep.get('embed') else 'stock'}: {run['verdict']}"
          f" crash@{run.get('crashedAtMs')} {run.get('crashAfterReload')} oom={run.get('oomKind')} host={run.get('host')}")
    procs = load_procs(run["procs"]) if run.get("procs") else None
    workers = run.get("workers", [])
    crash = run.get("crashedAtMs")
    for r in run.get("reloads", []):
        R = r["t"]
        print(f"--- reload {r['i']} at t={R} ms (commit +{r.get('commitMs')} ms), alive before {r['aliveBefore']}")
        ev = []
        for w in workers:
            if R - 300 <= w["t"] <= R + a.window_ms:
                ev.append((w["t"] - R, f"+{w['kind']}"))
            if w["closed"] is not None and R - 300 <= w["closed"] <= R + a.window_ms:
                ev.append((w["closed"] - R, f"-{w['kind']}"))
        if crash is not None and R <= crash <= R + a.window_ms:
            ev.append((crash - R, "CRASH"))
        for o in run.get("oom", []):
            if o.get("tRun") is not None and R - 300 <= o["tRun"] <= R + a.window_ms:
                ev.append((o["tRun"] - R, f"OOM {o['kind']} pid {o['pid']}"))
        ev.sort()
        # compress worker events into 100 ms bins: "+blob×12 -blob×20"
        bins = collections.OrderedDict()
        for dt, what in ev:
            b = (dt // a.step_ms) * a.step_ms
            bins.setdefault(b, collections.Counter())[what] += 1
        if procs:
            for b in range(-300, a.window_ms + 1, a.step_ms):
                ep = t0 + R + b
                near = [x for x in procs if ep <= x[0] < ep + a.step_ms]
                rend = [p for p in near[0][1] if p[1] == "renderer"] if near else []
                rs = " ".join(f"{p[0]}:{p[5]}th/{p[3] / 1024:.1f}G" for p in sorted(rend, key=lambda p: -p[3]) if p[3] > 200)
                evs = " ".join(f"{k}×{v}" if v > 1 else k for k, v in bins.get(b, {}).items())
                pr = near[0][1][0][6] if near and near[0][1] else "?"
                print(f"  {b:+6d} ms  {rs:<48s} p{pr} {evs}")
        else:
            for b, c in bins.items():
                print(f"  {b:+6d} ms  " + " ".join(f"{k}×{v}" if v > 1 else k for k, v in c.items()))
