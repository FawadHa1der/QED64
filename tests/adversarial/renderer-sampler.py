#!/usr/bin/env python3
"""Per-process sampler for one Chromium (macOS), used by reload-storm.mjs --sample-ms.

  renderer-sampler.py --marker <switch> --out <file.tsv> [--interval-ms 100] [--max-s 1800]

Finds the browser process whose argv contains <marker> (a switch the harness adds to the launch, which
Chromium ignores and does not pass to its children), then every interval writes one row per child
process: epoch ms, pid, process type (from --type=, read once per pid), resident MB, physical footprint
MB (what Activity Monitor shows), virtual GB, thread count (each dedicated Worker has its own thread),
and the host's memory-pressure level (kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical).
It uses libproc through ctypes, so a tick costs microseconds and never blocks the harness's event loop.
It exits when the browser process is gone, or after --max-s.
"""
import argparse
import ctypes
import ctypes.util
import os
import re
import subprocess
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument("--marker", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--interval-ms", type=int, default=100)
ap.add_argument("--max-s", type=int, default=1800)
a = ap.parse_args()

libproc = ctypes.CDLL(ctypes.util.find_library("proc"))
libc = ctypes.CDLL(ctypes.util.find_library("c"))


class TaskInfo(ctypes.Structure):  # struct proc_taskinfo
    _fields_ = [("virtual_size", ctypes.c_uint64), ("resident_size", ctypes.c_uint64),
                ("total_user", ctypes.c_uint64), ("total_system", ctypes.c_uint64),
                ("threads_user", ctypes.c_uint64), ("threads_system", ctypes.c_uint64),
                ("policy", ctypes.c_int32), ("faults", ctypes.c_int32), ("pageins", ctypes.c_int32),
                ("cow_faults", ctypes.c_int32), ("messages_sent", ctypes.c_int32),
                ("messages_received", ctypes.c_int32), ("syscalls_mach", ctypes.c_int32),
                ("syscalls_unix", ctypes.c_int32), ("csw", ctypes.c_int32), ("threadnum", ctypes.c_int32),
                ("numrunning", ctypes.c_int32), ("priority", ctypes.c_int32)]


class RusageV2(ctypes.Structure):  # struct rusage_info_v2 (the prefix up to ri_phys_footprint)
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size",
        "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime", "child_user_time",
        "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups", "child_pageins",
        "child_elapsed_abstime", "diskio_bytesread", "diskio_byteswritten")]


def taskinfo(pid):
    ti = TaskInfo()
    n = libproc.proc_pidinfo(pid, 4, 0, ctypes.byref(ti), ctypes.sizeof(ti))  # PROC_PIDTASKINFO
    return ti if n == ctypes.sizeof(ti) else None


def footprint(pid):
    ru = RusageV2()
    return ru.phys_footprint if libproc.proc_pid_rusage(pid, 2, ctypes.byref(ru)) == 0 else 0


def pressure():
    v = ctypes.c_int(0)
    sz = ctypes.c_size_t(ctypes.sizeof(v))
    ok = libc.sysctlbyname(b"kern.memorystatus_vm_pressure_level", ctypes.byref(v), ctypes.byref(sz), None, 0)
    return v.value if ok == 0 else -1


def children(pid):
    buf = (ctypes.c_int * 2048)()
    n = libproc.proc_listchildpids(pid, buf, ctypes.sizeof(buf))
    return [buf[i] for i in range(max(0, n))]


def ptype(pid):
    try:
        cmd = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return "?"
    m = re.search(r"--type=([\w-]+)", cmd)
    t = m.group(1) if m else "?"
    if t == "utility":
        s = re.search(r"--utility-sub-type=([\w.]+)", cmd)
        t = f"utility:{s.group(1).split('.')[-1]}" if s else t
    return t


t_end = time.time() + a.max_s
browser = None
while browser is None and time.time() < t_end:
    out = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if a.marker in line and "--type=" not in line and "renderer-sampler" not in line:
            browser = int(line.split(None, 1)[0])
            break
    if browser is None:
        time.sleep(0.2)
if browser is None:
    sys.exit(2)

types = {}
step = a.interval_ms / 1000.0
with open(a.out, "w", buffering=1) as f:
    f.write("epoch_ms\tpid\ttype\trss_mb\tfootprint_mb\tvsize_gb\tthreads\tpressure\n")
    while time.time() < t_end:
        if taskinfo(browser) is None:
            try:
                os.kill(browser, 0)
            except OSError:
                break
        now = int(time.time() * 1000)
        lvl = pressure()
        rows = []
        for pid in children(browser):
            if pid not in types:
                types[pid] = ptype(pid)
            ti = taskinfo(pid)
            if ti is None:
                continue
            rows.append(f"{now}\t{pid}\t{types[pid]}\t{ti.resident_size / 1048576:.0f}\t{footprint(pid) / 1048576:.0f}\t"
                        f"{ti.virtual_size / 1073741824:.1f}\t{ti.threadnum}\t{lvl}\n")
        f.write("".join(rows))
        time.sleep(max(0.0, step - (time.time() * 1000 - now) / 1000.0))
