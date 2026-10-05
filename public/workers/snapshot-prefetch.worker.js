/* QED64 snapshot prefetch worker.
 *
 * Fills the OPFS snapshot cache (`qed64-snapshots/<cacheKey>.raw`) in the
 * background so the Lean worker's first Mathlib load reads from storage
 * instead of the network. Download-only: loading into Lean stays on the Lean
 * worker. Writes stream into `<cacheKey>.raw.partial` through an exclusive
 * sync access handle and commit by rename; a second writer of the same
 * partial backs off (sync access handles are exclusive per file).
 */

"use strict";

self.onmessage = async (e) => {
  const { url, cacheKey, rawBytes } = e.data || {};
  const report = (msg) => self.postMessage(msg);
  if (!url || !cacheKey) {
    report({ status: "error", error: "missing url/cacheKey" });
    return;
  }
  // Same origin only (docs/EMBEDDING.md §4; HARDENING #57): what lands here is
  // committed under a key the index names, and every later visit loads it
  // into Lean — a region from another origin would persist in this site's
  // storage under a genuine key.
  let target = null;
  try { target = new URL(url, self.location.href); } catch { /* not a URL */ }
  if (!target || target.origin !== self.location.origin) {
    report({ status: "error", code: "SNAPSHOT_URL_REFUSED", error: `SNAPSHOT_URL_REFUSED: ${target ? target.origin : String(url).slice(0, 80)} is not this site` });
    return;
  }
  // Produce the INFLATED region cache entry (`<cacheKey>.raw`) the Lean
  // worker's fast path sync-reads straight into its heap. Doing the download
  // AND the gunzip here — in a worker that terminates when done — confines
  // the multi-GB stream/inflate allocations to a disposable heap: a Lean
  // worker that did this itself measured ~4.6 GB heavier for its whole
  // lifetime. Prefers an already-cached compressed entry as the source; the
  // raw entry supersedes it (quota reclaimed on commit).
  //
  // The raw size is required: the compressed-only mode it used to select
  // (writing `<cacheKey>` from the network) lost its last reader in W5, and
  // it committed whatever a redirect or an HTML page answered, which raw
  // mode then inflated from with no network check at all.
  if (!(typeof rawBytes === "number" && rawBytes > 0)) {
    report({ status: "error", error: `the snapshot index declares no raw size (bytes) for ${cacheKey}; nothing fetched` });
    return;
  }
  return rawPrefetch(url, cacheKey, rawBytes, report);
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
      if (response.redirected && new URL(response.url).origin !== self.location.origin) throw new Error(`SNAPSHOT_URL_REFUSED: redirected to ${new URL(response.url).origin}, not this site`);
      if (/text\/html/i.test(response.headers.get("content-type") || "")) throw new Error("the server answered HTML, not a snapshot");
      downloadedTotal = Number(response.headers.get("content-length")) || 0;
      source = response.body;
    }
    // Sniff gzip on the first chunk (dev servers sometimes pre-inflate).
    const reader = source.getReader();
    const head = await reader.read();
    if (head.done || !head.value) throw new Error("empty snapshot source");
    if (head.value[0] === 0x3c) throw new Error("the server answered HTML, not a snapshot");
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
    // Report every 500 ms while bytes arrive: the page's boot card shows
    // them, and the page gives up on this worker only after a long SILENCE
    // (HARDENING #54) — on a 100 KB/s link, one report per 64 MiB of output
    // would be one every few minutes.
    let reportedAt = 0;
    for (;;) {
      const { done, value } = await out.read();
      if (done) break;
      if (at === 0) {
        const magic = [0x6f, 0x6c, 0x65, 0x61, 0x6e]; // "olean"
        if (value.length < 5 || magic.some((b, i) => value[i] !== b)) throw new Error("not a compacted-region snapshot");
      }
      handle.write(value, { at });
      at += value.length;
      const now = Date.now();
      if (now - reportedAt >= 500) {
        reportedAt = now;
        report({ status: "progress", bytes: at, total: rawBytes, phase: sourceTotal ? "inflate" : "download", sourceTotal: sourceTotal || downloadedTotal });
      }
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
