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
  const { url, cacheKey } = e.data || {};
  const report = (msg) => self.postMessage(msg);
  if (!url || !cacheKey) {
    report({ status: "error", error: "missing url/cacheKey" });
    return;
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
