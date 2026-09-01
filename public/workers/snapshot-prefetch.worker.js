/* QED64 snapshot prefetch worker.
 *
 * Fills the OPFS snapshot cache (`qed64-snapshots/<cacheKey>`) in the
 * background so the Lean worker's first Mathlib load reads from storage
 * instead of the network. Download-only: loading into Lean stays on the Lean
 * worker. Writes stream into `<cacheKey>.partial` through an exclusive sync
 * access handle and commit by rename, exactly like the Lean worker's own
 * cache writer — whichever of the two opens the partial first wins, the
 * other backs off (sync access handles are exclusive per file).
 */

"use strict";

self.onmessage = async (e) => {
  const { url, cacheKey, rawBytes } = e.data || {};
  const report = (msg) => self.postMessage(msg);
  if (!url || !cacheKey) {
    report({ status: "error", error: "missing url/cacheKey" });
    return;
  }
  // Raw mode: produce the INFLATED region cache entry (`<cacheKey>.raw`) the
  // Lean worker's fast path sync-reads straight into its heap. Doing the
  // download AND the gunzip here — in a worker that terminates when done —
  // confines the multi-GB stream/inflate allocations to a disposable heap:
  // a Lean worker that did this itself measured ~4.6 GB heavier for its
  // whole lifetime. Prefers an already-cached compressed entry as the
  // source; the raw entry supersedes it (quota reclaimed on commit).
  if (typeof rawBytes === "number" && rawBytes > 0) {
    return rawPrefetch(url, cacheKey, rawBytes, report);
  }
  let dir;
  try {
    const root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle("qed64-snapshots", { create: true });
  } catch (error) {
    report({ status: "unavailable", error: String(error && error.message) });
    return;
  }
  try {
    const existing = await dir.getFileHandle(cacheKey);
    const f = await existing.getFile();
    if (f.size > 0) {
      report({ status: "already-cached", bytes: f.size });
      return;
    }
  } catch {
    /* not cached yet */
  }
  const partial = `${cacheKey}.partial`;
  let handle = null;
  let fh = null;
  try {
    try { await dir.removeEntry(partial); } catch { /* absent */ }
    fh = await dir.getFileHandle(partial, { create: true });
    handle = await fh.createSyncAccessHandle();
  } catch (error) {
    // The Lean worker is writing this cache entry right now — its copy wins.
    report({ status: "busy", error: String(error && error.message) });
    return;
  }
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    let at = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handle.write(value, { at });
      at += value.length;
      if ((at & 0x3ffffff) < value.length) report({ status: "progress", bytes: at });
    }
    handle.flush();
    handle.close();
    handle = null;
    try { await dir.removeEntry(cacheKey); } catch { /* absent */ }
    if (typeof fh.move === "function") {
      await fh.move(cacheKey);
    } else {
      throw new Error("FileSystemFileHandle.move unavailable");
    }
    report({ status: "done", bytes: at });
  } catch (error) {
    try { if (handle) handle.close(); } catch { /* closed */ }
    dir.removeEntry(partial).catch(() => {});
    report({ status: "error", error: String(error && error.message) });
  }
};

async function rawPrefetch(url, cacheKey, rawBytes, report) {
  let dir;
  try {
    const root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle("qed64-snapshots", { create: true });
  } catch (error) {
    report({ status: "unavailable", error: String(error && error.message) });
    return;
  }
  const rawKey = `${cacheKey}.raw`;
  try {
    const f = await (await dir.getFileHandle(rawKey)).getFile();
    if (f.size === rawBytes) { report({ status: "already-cached", bytes: f.size }); return; }
    await dir.removeEntry(rawKey); // stale bake — different region size
  } catch { /* not cached yet */ }
  const partial = `${rawKey}.partial`;
  let handle = null;
  let fh = null;
  try {
    try { await dir.removeEntry(partial); } catch { /* absent */ }
    fh = await dir.getFileHandle(partial, { create: true });
    handle = await fh.createSyncAccessHandle();
  } catch (error) {
    report({ status: "busy", error: String(error && error.message) });
    return;
  }
  try {
    // Source: the cached compressed entry when present (a warm-compressed
    // browser converting to raw), else the network.
    let source = null;
    let sourceTotal = 0;
    try {
      const cf = await (await dir.getFileHandle(cacheKey)).getFile();
      if (cf.size > 0) { source = cf.stream(); sourceTotal = cf.size; }
    } catch { /* no compressed cache */ }
    let downloadedTotal = 0;
    if (!source) {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      downloadedTotal = Number(response.headers.get("content-length")) || 0;
      source = response.body;
    }
    // Sniff gzip on the first chunk (dev servers sometimes pre-inflate).
    const reader = source.getReader();
    const head = await reader.read();
    if (head.done || !head.value) throw new Error("empty snapshot source");
    const isGzip = head.value.length >= 2 && head.value[0] === 0x1f && head.value[1] === 0x8b;
    const replay = new ReadableStream({
      start(c) { c.enqueue(head.value); },
      async pull(c) {
        const { done, value } = await reader.read();
        if (done) c.close(); else c.enqueue(value);
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    const body = isGzip ? replay.pipeThrough(new DecompressionStream("gzip")) : replay;
    const out = body.getReader();
    let at = 0;
    for (;;) {
      const { done, value } = await out.read();
      if (done) break;
      if (at === 0) {
        const magic = [0x6f, 0x6c, 0x65, 0x61, 0x6e]; // "olean"
        if (value.length < 5 || magic.some((b, i) => value[i] !== b)) throw new Error("not a compacted-region snapshot");
      }
      handle.write(value, { at });
      at += value.length;
      if ((at & 0x3ffffff) < value.length) report({ status: "progress", bytes: at, total: rawBytes, phase: sourceTotal ? "inflate" : "download", sourceTotal: sourceTotal || downloadedTotal });
    }
    if (at !== rawBytes) throw new Error(`raw size mismatch: got ${at}, expected ${rawBytes}`);
    handle.flush();
    handle.close();
    handle = null;
    try { await dir.removeEntry(rawKey); } catch { /* absent */ }
    if (typeof fh.move !== "function") throw new Error("FileSystemFileHandle.move unavailable");
    await fh.move(rawKey);
    // The raw entry supersedes the compressed one — reclaim its quota.
    dir.removeEntry(cacheKey).catch(() => {});
    report({ status: "done", bytes: at });
  } catch (error) {
    try { if (handle) handle.close(); } catch { /* closed */ }
    dir.removeEntry(partial).catch(() => {});
    report({ status: "error", error: String(error && error.message) });
  }
}
