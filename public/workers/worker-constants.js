/* QED64 worker constants: the Lean policy every Lean runner in this repository shares (docs/EMBEDDING.md §7.7).
 *
 * One source for the resident FileWorker's command line and the thread budget (architecture review R3). The
 * classic Lean worker loads it (`importScripts("worker-constants.js")`, eagerly, beside lsp-frames.js and
 * memory64-probe.js), and so do its Node twins (`import "…/public/workers/worker-constants.js"`:
 * pipeline/snapshot/resident-probe.mjs and thread-storm-probe.mjs), so the page and every headless lane run one
 * argv and one thread setup. Like lsp-frames.js it has no `export` and no `require`: it publishes
 * `globalThis.Qed64WorkerConstants`, valid as a classic script and as an ES module.
 *
 * Values only. The environment assignment (LEAN_WASM_PARKED_DEDICATED at preRun) stays in lean.worker.js.
 *
 * A changed VALUE is a semantics change that embedders re-gate (lean4game's sweep, the proof sheets'
 * chrome-check), listed in docs/EMBEDDING.md §12. It keeps REVISION: either mix of scripts runs one deploy's whole
 * policy. A new or renamed export bumps REVISION with the other worker scripts.
 */
"use strict";

(function (root) {
  // The thread budget (HARDENING #69): the pool preallocates 24 Workers and every live pthread holds one;
  // 1 main + the task manager's workers + parked dedicated threads + a burst (~10) must stay within it. Lean's
  // task manager would otherwise take the host's hardware concurrency, and on a 24-32-thread desktop the main
  // pthread and its workers alone outgrow the pool, growing it into the renderer's cage (#55).
  const LEAN_WORKERS_MAX = 8;
  /** Parked dedicated threads (kernel 0035, LEAN_WASM_PARKED_DEDICATED; read once at the task manager's
   * construction): a finished dedicated task's thread waits for the next instead of exiting, cutting thread churn
   * ~13x and a reload storm's renderer peak by ~1.2 GB (the widgets showcase's measurement). Digits only, never
   * computed. */
  const PARKED_DEDICATED = "4";
  /** The task manager's worker count for a host of `hc` hardware threads: at most LEAN_WORKERS_MAX, 4 when the
   * host does not say, never 0 (0 means no task manager at all). */
  function leanWorkers(hc) {
    const n = Number.isInteger(hc) && hc > 0 ? hc : 4;
    return Math.max(1, Math.min(n, LEAN_WORKERS_MAX));
  }
  // The resident FileWorker's command line; every -D with its reason:
  //  - server.reportDelayMs=0: diagnostics go out without the server's reporting delay (latency). Its first
  //    reason, "a task pthread's IO.sleep never wakes under this emsdk", was a frame-parser artifact
  //    (docs/RESIDENT-WORKER-PLAN.md, phase 1). lean4game's Q8 proposes trying 200 for Runner documents.
  //  - Elab.async=false (HARDENING #70): the FileWorker turns asynchronous elaboration on only when the command
  //    line leaves it unset. Under it, a task that blocks in Task.get/IO.wait makes the task manager start another
  //    standard worker, which never exits; a file of 20 Mathlib theorems then held ~46 pthreads, grew the pool
  //    into the renderer's cage (#55) and crashed the tab. A file can still opt in with set_option, and an
  //    embedder with leanOptions ["Elab.async=true"] (a gated exception: record peak pthreads and pool growth on
  //    your heaviest content first).
  const RESIDENT_ARGV = Object.freeze(["--worker", "-Dserver.reportDelayMs=0", "-DElab.async=false"]);
  /** One Lean option: a dotted name, `=`, a value without line breaks or NUL. Lean parses the value by the
   * option's type; an unknown name that is not `weak.`-prefixed is Lean's own header error. */
  const LEAN_OPTION = /^([A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*)=([^\0\r\n]*)$/;
  /** RESIDENT_ARGV with `leanOptions` (["autoImplicit=false", …]) merged by name: the embedder's value replaces a
   * default in place and a new name is appended in order, so each -D appears once. Throws a TypeError naming the
   * first entry that is not "name=value", or a name given twice. Frozen. */
  function residentArgv(leanOptions) {
    const extra = leanOptions === undefined || leanOptions === null ? [] : leanOptions;
    if (!Array.isArray(extra)) throw new TypeError(`leanOptions must be an array of "name=value" strings, got ${typeof extra}`);
    const byName = new Map();
    for (const flag of RESIDENT_ARGV.slice(1)) {
      const m = LEAN_OPTION.exec(flag.slice(2));
      byName.set(m[1], m[2]);
    }
    const named = new Set();
    for (const opt of extra) {
      const m = typeof opt === "string" ? LEAN_OPTION.exec(opt) : null;
      if (!m) throw new TypeError(`leanOptions entry ${JSON.stringify(opt)} is not "name=value" (e.g. "autoImplicit=false")`);
      if (named.has(m[1])) throw new TypeError(`leanOptions names ${m[1]} twice`);
      named.add(m[1]);
      byName.set(m[1], m[2]);
    }
    return Object.freeze([RESIDENT_ARGV[0], ...[...byName].map(([name, value]) => `-D${name}=${value}`)]);
  }

  // REVISION: see lsp-frames.js (the worker scripts move together; lean.worker.js refuses a sibling of another
  // revision, WORKER_DEP_MISMATCH).
  root.Qed64WorkerConstants = Object.freeze({ LEAN_WORKERS_MAX, PARKED_DEDICATED, leanWorkers, RESIDENT_ARGV, residentArgv, REVISION: "1" });
})(globalThis);
