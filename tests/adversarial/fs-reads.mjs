// R15's measurement (docs/TESTING.md, e2e `--fs-reads`): which library files the lean.worker's Emscripten FS opens
// or finds. installInWorker runs INSIDE each lean.worker (Playwright serializes it, so it is self-contained and never
// throws): once the glue publishes Module.FS it wraps FS.open, FS.stat and FS.readdir and records each call as
// `<op>-hit|miss <path>`, plus the session's LEAN_PATH. Pthread file syscalls are proxied to that thread and the
// glue's syscalls look FS.open and FS.stat up on every call (FS.lstat is FS.stat(path, true)), so the wrappers see
// every open. An open with write access (FS.writeFile, the memory-mode pack mount) is recorded as `write-…`, never
// as a read. A relative path is recorded against FS.cwd(); Lean's own paths are not normalized (its sysroot is
// `/bin/..`, so its library directory is `/bin/../lib/lean`), so classifyFsPath resolves `.` and `..` first.
// createFsReads attaches to pages, installs on each lean.worker, polls page.workers() and keeps the latest record
// per id; normalizeFsPath, classifyFsPath and summarizeFsReads are pure (tests/unit/fs-reads.test.ts).

export const LEAN_WORKER_RE = /\/workers\/lean\.worker\.js(?:[?#]|$)/;
export const LIBRARY_FILE_RE = /\.(?:olean|olean\.server|olean\.private|ir|ir\.sig|ilean)$/;

/** The absolute path with `.`, `..` and repeated slashes resolved, as the FS resolves it. */
export function normalizeFsPath(p) {
  const out = [];
  for (const seg of String(p).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** "library" (a module file under /lib), "lib-other" (directories, .lean sources under /lib) or "outside". */
export function classifyFsPath(p) {
  const s = normalizeFsPath(p);
  if (s !== "/lib" && !s.startsWith("/lib/")) return "outside";
  return LIBRARY_FILE_RE.test(s) ? "library" : "lib-other";
}

/** Runs in the lean.worker; returns the record's id. Idempotent: a second install returns the same id. */
export function installInWorker() {
  try {
    if (self.__qed64FsReads) return self.__qed64FsReads.id;
    const rec = (self.__qed64FsReads = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, installedAt: null, leanPath: null, paths: {}, distinct: 0, overflow: 0, errors: 0 });
    const note = (k, p) => {
      try {
        if (rec.leanPath === null && self.Module && self.Module.ENV && "LEAN_PATH" in self.Module.ENV) rec.leanPath = String(self.Module.ENV.LEAN_PATH);
        const key = `${k} ${p}`;
        if (key in rec.paths) rec.paths[key] += 1;
        else if (rec.distinct < 2000) { rec.paths[key] = 1; rec.distinct += 1; } else rec.overflow += 1;
      } catch { rec.errors += 1; }
    };
    // FS.open's flags are a number or a mode string ("r", "w+", …); O_WRONLY 1, O_RDWR 2, O_CREAT 64.
    const writes = (flags) => (typeof flags === "string" ? /[wa+]/.test(flags) : typeof flags === "number" && (flags & 67) !== 0);
    const absolute = (FS, p) => { try { return p.startsWith("/") ? p : `${FS.cwd()}/${p}`; } catch { return p; } };
    const wrap = (FS, op, fn) => function (p, ...rest) {
      let ok = false;
      try { const r = fn.call(this, p, ...rest); ok = true; return r; }
      finally { if (typeof p === "string") note(`${op === "open" && writes(rest[0]) ? "write" : op}-${ok ? "hit" : "miss"}`, absolute(FS, p)); }
    };
    const tryWrap = () => {
      try {
        const FS = self.Module && self.Module.FS;
        if (!FS || typeof FS.open !== "function" || typeof FS.stat !== "function" || FS.__qed64FsReads) return false;
        FS.open = wrap(FS, "open", FS.open);
        FS.stat = wrap(FS, "stat", FS.stat);
        if (typeof FS.readdir === "function") FS.readdir = wrap(FS, "readdir", FS.readdir);
        FS.__qed64FsReads = true;
        rec.installedAt = performance.now();
        return true;
      } catch { rec.errors += 1; return false; }
    };
    // Module.FS exists only after boot()'s importScripts(glue), and before its preRun mounts.
    if (!tryWrap()) { const t = setInterval(() => { if (tryWrap()) clearInterval(t); }, 2); }
    return rec.id;
  } catch {
    return null;
  }
}

/** Read in the lean.worker by every poll: a copy of the record, LEAN_PATH filled in if no call has noted it yet. */
function readRecord() {
  const r = self.__qed64FsReads;
  if (!r) return null;
  const env = self.Module && self.Module.ENV;
  return { ...JSON.parse(JSON.stringify(r)), leanPath: r.leanPath ?? (env && "LEAN_PATH" in env ? String(env.LEAN_PATH) : null) };
}

const top = (entries, n = 20) => entries.sort((a, b) => b.n - a.n || (a.op + a.path < b.op + b.path ? -1 : 1)).slice(0, n);

/** Groups worker records by LEAN_PATH. `hits` sums the open-hit and stat-hit calls on library paths, `misses` every
 * -miss call on them, `writes` the write opens (never reads); `distinct` counts the library paths read; `blind` the
 * records whose FS was never wrapped. */
export function summarizeFsReads(records, { installFailures = 0 } = {}) {
  const sessions = {};
  const merged = new Map();
  let blind = 0, overflow = 0, errors = 0;
  for (const r of records) {
    if (r.installedAt === null || r.installedAt === undefined) blind += 1;
    overflow += r.overflow || 0;
    errors += r.errors || 0;
    const lp = r.leanPath ?? "";
    const s = (sessions[lp] ??= { workers: 0, overflow: 0, library: { hits: 0, misses: 0, writes: 0, distinct: 0, sample: [] }, libOther: { total: 0, sample: [] }, outside: { total: 0, sample: [] } });
    s.workers += 1;
    s.overflow += r.overflow || 0;
    if (!merged.has(lp)) merged.set(lp, new Map());
    const m = merged.get(lp);
    for (const [key, n] of Object.entries(r.paths || {})) m.set(key, (m.get(key) || 0) + n);
  }
  for (const [lp, m] of merged) {
    const s = sessions[lp];
    const lib = [], other = [], outside = [], read = new Set();
    for (const [key, n] of m) {
      const at = key.indexOf(" ");
      const op = key.slice(0, at), p = key.slice(at + 1);
      const cls = classifyFsPath(p);
      if (cls === "outside") { s.outside.total += n; outside.push({ op, path: p, n }); continue; }
      if (cls === "lib-other") { s.libOther.total += n; other.push({ op, path: p, n }); continue; }
      if (op.startsWith("write-")) { s.library.writes += n; continue; }
      if (op === "open-hit" || op === "stat-hit") s.library.hits += n;
      else if (op.endsWith("-miss")) s.library.misses += n;
      read.add(normalizeFsPath(p));
      lib.push({ op, path: p, n });
    }
    s.library.distinct = read.size;
    s.library.sample = top(lib);
    s.libOther.sample = top(other);
    s.outside.sample = top(outside);
  }
  return { workers: records.length, blind, sessions, overflow, errors, installFailures };
}

/** Attach to pages; every lean.worker they spawn is instrumented, and polled every `pollMs`. */
export function createFsReads({ pollMs = 1000, evalTimeoutMs = 5000 } = {}) {
  const pages = new Set();
  const records = new Map();
  let installFailures = 0;
  let timer = null;
  let inflight = null;
  const isLean = (w) => LEAN_WORKER_RE.test(w.url());
  const install = (w) => {
    if (isLean(w)) w.evaluate(installInWorker).then((id) => { if (typeof id !== "string") installFailures += 1; }, () => { installFailures += 1; });
  };
  // An evaluate on a worker that is going away may never settle: each read races its own deadline.
  const read = (w) => Promise.race([w.evaluate(readRecord), new Promise((res) => setTimeout(() => res(null), evalTimeoutMs))])
    .then((r) => { if (r && typeof r.id === "string") records.set(r.id, r); })
    .catch(() => {});
  function poll() {
    if (inflight) return inflight;
    inflight = (async () => {
      const workers = [...pages].filter((p) => !p.isClosed()).flatMap((p) => p.workers()).filter(isLean);
      await Promise.all(workers.map(read));
    })().catch(() => {}).finally(() => { inflight = null; });
    return inflight;
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }
  return {
    attach(page) {
      if (pages.has(page)) return;
      pages.add(page);
      page.on("worker", install);
      for (const w of page.workers()) install(w);
      if (!timer) { timer = setInterval(() => { void poll(); }, pollMs); timer.unref?.(); }
    },
    poll,
    async finish() {
      if (inflight) await inflight;
      await poll();
      stop();
      return summarizeFsReads([...records.values()], { installFailures });
    },
    stop,
  };
}
