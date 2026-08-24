// Profile installer: verified transport → OPFS raw pack → WORKERFS mount data.
//
// A profile (lean-core, mathlib-essential) is described by a
// `browser64.artifact-manifest/v1` document: content-addressed gzip transport
// parts that concatenate into one gzip stream, which inflates into a
// deterministic raw pack. The manifest also carries a ready-made WORKERFS
// byte-range table (`content.workerfs`) into that raw pack.
//
// Integrity model: every transport part is SHA-256-verified against the
// manifest before its bytes enter the gunzip stream, and the inflated pack's
// byte length must match the manifest exactly. The raw-pack digest is NOT
// re-computed in the browser: WebCrypto cannot stream, and the transport is
// already cryptographically pinned part-by-part (gzip's CRC additionally
// covers the inflate). The pipeline's `verify-release` recomputes the raw
// digest out-of-band.
//
// Storage: OPFS under /qed64/packs/<digest-prefix>. A `.meta.json` marker
// records the manifest pack digest + byte length; a cached pack is reused only
// when both match. Installs are transactional: written to `<name>.staging`,
// then renamed (move) into place; a failed install removes its staging file.

export interface ProfileIndexEntry {
  id: string;
  manifest: string;
  release: string;
  modules: number;
}

export interface ProfileIndex {
  schema: string;
  runtime: { buildId: string; leanVersion: string };
  profiles: ProfileIndexEntry[];
}

export interface WorkerfsFileEntry {
  filename: string;
  start: number;
  end: number;
}

export interface PackSegment {
  /** OPFS-backed segment, mounted via WORKERFS byte ranges. */
  blob?: Blob;
  /** In-memory segment, transferred to the worker and written into MEMFS.
   * Used when the embedder cannot back multi-GB Blob storage. */
  bytes?: Uint8Array;
  metadata: { files: WorkerfsFileEntry[] };
}

export interface SegmentPlan {
  startByte: number;
  endByte: number;
  files: WorkerfsFileEntry[];
}

/** Partition a pack's file table into segments of at most `maxBytes`, cutting
 * only at file boundaries. Files must be non-overlapping and ascending (the
 * manifest invariant); each plan's files are rebased to the segment origin. */
export function planSegments(files: WorkerfsFileEntry[], maxBytes: number): SegmentPlan[] {
  const ordered = [...files].sort((a, b) => a.start - b.start);
  const plans: SegmentPlan[] = [];
  let current: SegmentPlan | null = null;
  for (const file of ordered) {
    const size = file.end - file.start;
    if (!current || file.end - current.startByte > maxBytes) {
      if (size > maxBytes) {
        // A single file larger than a segment gets a dedicated segment.
        plans.push({ startByte: file.start, endByte: file.end, files: [
          { filename: file.filename, start: 0, end: size },
        ] });
        current = null;
        continue;
      }
      current = { startByte: file.start, endByte: file.end, files: [] };
      plans.push(current);
    }
    current.endByte = file.end;
    current.files.push({
      filename: file.filename,
      start: file.start - current.startByte,
      end: file.end - current.startByte,
    });
  }
  return plans;
}

/** Assemble segment Blobs from sequential stream pieces without ever
 * materializing the whole pack as one Blob. */
export function buildSegments(pieces: Uint8Array[], plans: SegmentPlan[]): PackSegment[] {
  const segments: PackSegment[] = [];
  let pieceIndex = 0;
  let pieceOffset = 0; // absolute offset of pieces[pieceIndex][0]
  for (const plan of plans) {
    // Advance to the piece containing plan.startByte.
    while (pieceIndex < pieces.length && pieceOffset + pieces[pieceIndex]!.byteLength <= plan.startByte) {
      pieceOffset += pieces[pieceIndex]!.byteLength;
      pieceIndex += 1;
    }
    const parts: Uint8Array[] = [];
    let cursorIndex = pieceIndex;
    let cursorOffset = pieceOffset;
    let position = plan.startByte;
    while (position < plan.endByte && cursorIndex < pieces.length) {
      const piece = pieces[cursorIndex]!;
      const pieceStart = cursorOffset;
      const from = position - pieceStart;
      const take = Math.min(piece.byteLength - from, plan.endByte - position);
      parts.push(from === 0 && take === piece.byteLength ? piece : piece.subarray(from, from + take));
      position += take;
      if (from + take >= piece.byteLength) {
        cursorOffset += piece.byteLength;
        cursorIndex += 1;
      }
    }
    if (position !== plan.endByte) {
      throw new Error(`Segment [${plan.startByte}, ${plan.endByte}) exceeds the streamed data.`);
    }
    // One contiguous buffer per segment: transferable to the worker with no
    // dependence on the embedder's Blob storage.
    const bytes = new Uint8Array(plan.endByte - plan.startByte);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    segments.push({ bytes, metadata: { files: plan.files } });
  }
  return segments;
}

export interface ProfileManifest {
  format: string;
  version: number | string;
  digest: string;
  content: {
    release: string;
    lean: { version: string; target: string; gitRevision: string };
    pack: {
      url: string;
      digest: string;
      byteLength: number;
      transport: {
        encoding: string;
        digest: string;
        byteLength: number;
        parts: { url: string; digest: string; byteLength: number }[];
      };
    };
    modules: Record<string, { imports: string[] }>;
    roots: string[];
    workerfs: { mountPoint: string; metadata: { files: WorkerfsFileEntry[] } };
  };
}

export interface InstallProgress {
  phase: "download" | "inflate" | "commit" | "cached";
  loaded: number;
  total: number;
}

export interface InstalledProfile {
  id: string;
  release: string;
  /** One or more WORKERFS packages jointly covering the pack's file table.
   * OPFS installs use a single File-backed segment; memory installs split
   * into bounded Blobs (huge single Blobs break FileReaderSync in some
   * embedders). */
  segments: PackSegment[];
  totalBytes: number;
  mountPoint: string;
  fromCache: boolean;
  /** False when the pack lives only in session memory (no OPFS). */
  persistent: boolean;
  moduleNames: string[];
  /** Module → direct imports, straight from the manifest (for closure
   * estimates and import resolution in the app). */
  modules: Record<string, { imports: string[] }>;
}

const STORE_DIR = "qed64-packs";
const OPFS_CEILING_KEY = "qed64.opfs.byteCeiling";
const WRITE_STALL_MS = 20_000;

/** Some embedded browsers hang (not reject) large OPFS writes. Remember the
 * observed ceiling so later installs skip the stall entirely. */
function opfsByteCeiling(): number {
  try {
    const v = Number(localStorage.getItem(OPFS_CEILING_KEY));
    return Number.isFinite(v) && v > 0 ? v : Infinity;
  } catch {
    return Infinity;
  }
}
function recordOpfsCeiling(bytes: number): void {
  try {
    const current = opfsByteCeiling();
    if (bytes < current) localStorage.setItem(OPFS_CEILING_KEY, String(bytes));
  } catch {
    /* storage-less context */
  }
}

class OpfsStallError extends Error {
  override name = "OpfsStallError";
}

/** A write that neither resolves nor rejects within the stall budget aborts
 * the whole OPFS attempt (the memory fallback takes over). */
async function stallGuard<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OpfsStallError(`${label} stalled for ${WRITE_STALL_MS} ms`)),
      WRITE_STALL_MS,
    );
  });
  try {
    return await Promise.race([promise, stall]);
  } finally {
    clearTimeout(timer);
  }
}

function stripSha(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice(7) : digest;
}

function hex(buffer: ArrayBuffer): string {
  let out = "";
  for (const b of new Uint8Array(buffer)) out += b.toString(16).padStart(2, "0");
  return out;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
  return hex(await crypto.subtle.digest("SHA-256", copy as unknown as BufferSource));
}

export async function fetchProfileIndex(url = "/profiles/index.json"): Promise<ProfileIndex> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Profile index: HTTP ${response.status}`);
  const index = (await response.json()) as ProfileIndex;
  if (index.schema !== "qed64.profile-index/v1") {
    throw new Error(`Unknown profile index schema: ${index.schema}`);
  }
  return index;
}

export function validateManifest(manifest: ProfileManifest): void {
  if (manifest.format !== "browser64.artifact-manifest") {
    throw new Error(`Unknown manifest format: ${manifest.format}`);
  }
  const { pack, workerfs, modules } = manifest.content;
  if (!Number.isSafeInteger(pack.byteLength) || pack.byteLength <= 0) {
    throw new Error("Manifest pack byteLength is invalid.");
  }
  if (pack.transport.encoding !== "gzip") {
    throw new Error(`Unsupported transport encoding: ${pack.transport.encoding}`);
  }
  const partsTotal = pack.transport.parts.reduce((sum, part) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(part.digest)) throw new Error("Transport part digest malformed.");
    if (!Number.isSafeInteger(part.byteLength) || part.byteLength <= 0 || part.byteLength > 64 * 1024 * 1024) {
      throw new Error("Transport part byteLength out of bounds.");
    }
    return sum + part.byteLength;
  }, 0);
  if (partsTotal !== pack.transport.byteLength) {
    throw new Error(`Transport parts sum to ${partsTotal}, expected ${pack.transport.byteLength}.`);
  }
  if (!workerfs || !Array.isArray(workerfs.metadata.files) || workerfs.metadata.files.length === 0) {
    throw new Error("Manifest has no WORKERFS table.");
  }
  let previousEnd = -1;
  const sorted = [...workerfs.metadata.files].sort((x, y) => x.start - y.start);
  for (const file of sorted) {
    if (typeof file.filename !== "string" || !file.filename.startsWith("/") || file.filename.includes("..")) {
      throw new Error(`WORKERFS filename invalid: ${file.filename}`);
    }
    if (
      !Number.isSafeInteger(file.start) ||
      !Number.isSafeInteger(file.end) ||
      file.start < 0 ||
      file.end < file.start ||
      file.end > pack.byteLength
    ) {
      throw new Error(`WORKERFS range invalid for ${file.filename}.`);
    }
    if (file.start < previousEnd) {
      throw new Error(`WORKERFS ranges overlap at ${file.filename}.`);
    }
    previousEnd = file.end;
  }
  if (!modules || Object.keys(modules).length === 0) throw new Error("Manifest has no modules.");
}

export async function fetchManifest(url: string): Promise<ProfileManifest> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Manifest ${url}: HTTP ${response.status}`);
  const manifest = (await response.json()) as ProfileManifest;
  validateManifest(manifest);
  return manifest;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!("storage" in navigator) || !navigator.storage.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(STORE_DIR, { create: true });
  } catch {
    return null;
  }
}

export interface PackMeta {
  digest: string;
  byteLength: number;
  release: string;
}

/** Exported for tests; app code uses installProfile. */
export async function readCached(
  dir: FileSystemDirectoryHandle,
  name: string,
  expected: PackMeta,
): Promise<File | null> {
  try {
    const metaHandle = await dir.getFileHandle(`${name}.meta.json`);
    const meta = JSON.parse(await (await metaHandle.getFile()).text()) as PackMeta;
    if (meta.digest !== expected.digest || meta.byteLength !== expected.byteLength) return null;
    const packHandle = await dir.getFileHandle(name);
    const file = await packHandle.getFile();
    if (file.size !== expected.byteLength) return null;
    // Probe both ends: an OPFS entry can survive in the directory while its
    // backing data is gone (observed after a quota event) — every later read
    // then fails. A dead cache must miss here so the installer re-downloads.
    await file.slice(0, 1).arrayBuffer();
    if (file.size > 1) await file.slice(file.size - 1, file.size).arrayBuffer();
    return file;
  } catch {
    return null;
  }
}

async function removeIfPresent(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {
    /* absent */
  }
}

/** Stream verified gzip parts through DecompressionStream into a sink.
 * Exported for tests; app code uses installProfile. */
export async function inflateTransport(
  manifest: ProfileManifest,
  write: (chunk: Uint8Array) => Promise<void>,
  onProgress: (p: InstallProgress) => void,
): Promise<number> {
  const { transport, byteLength } = manifest.content.pack;
  let downloaded = 0;
  let inflated = 0;

  const gunzip = new DecompressionStream("gzip");
  let sinkError: unknown = null;
  const writerDone = (async () => {
    const reader = gunzip.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        inflated += value.byteLength;
        if (inflated > byteLength) {
          throw new Error(`Pack inflated past its declared ${byteLength} bytes.`);
        }
        await write(value);
        onProgress({ phase: "inflate", loaded: inflated, total: byteLength });
      }
    } catch (error) {
      // Unwedge the transform: without this cancel its queued chunks keep the
      // pending ingress write()/close()/abort() unsettled forever, which turns
      // a clean failure (e.g. QuotaExceededError) into a silent hang.
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  })().catch((error) => {
    sinkError = error;
    throw error;
  });
  writerDone.catch(() => {}); // observed below; never an unhandled rejection

  const writer = gunzip.writable.getWriter();
  // Every ingress await races against the sink task: if the sink fails (quota,
  // stall), its rejection surfaces HERE instead of leaving close()/write()
  // deadlocked on a queue nobody will ever drain.
  const orSink = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([p, writerDone]) as Promise<T>;
  try {
    for (let i = 0; i < transport.parts.length; i += 1) {
      if (sinkError) break;
      const part = transport.parts[i]!;
      const fetchPart = async (cacheMode: RequestCache): Promise<Uint8Array<ArrayBuffer>> => {
        const response = await fetch(part.url, { cache: cacheMode });
        if (!response.ok) throw new Error(`Part ${i}: HTTP ${response.status}`);
        const partBytes = new Uint8Array(await response.arrayBuffer()) as Uint8Array<ArrayBuffer>;
        if (partBytes.byteLength !== part.byteLength) {
          throw new Error(`Part ${i}: ${partBytes.byteLength} bytes, expected ${part.byteLength}.`);
        }
        if ((await sha256(partBytes)) !== stripSha(part.digest)) {
          throw new Error(`Part ${i} failed SHA-256 verification.`);
        }
        return partBytes;
      };
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await fetchPart("force-cache");
      } catch (firstError) {
        if (sinkError) throw firstError;
        // Two distinct failure classes end up here. A poisoned HTTP-cache
        // entry (an SPA fallback cached before the parts were deployed)
        // fails verification and one cache-bypassing retry fixes it forever.
        // A transient network drop ("Failed to fetch") mid-way through a
        // ~1 GB, 60-part download is routine on real connections and killed
        // installs on the deployed site — retry with backoff before giving
        // up, and always bypass the cache on retries.
        let lastError: unknown = firstError;
        let recovered: Uint8Array<ArrayBuffer> | null = null;
        for (const delayMs of [0, 2000, 8000]) {
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
          if (sinkError) throw lastError;
          try {
            recovered = await fetchPart("reload");
            break;
          } catch (retryError) {
            lastError = retryError;
          }
        }
        if (recovered === null) throw lastError;
        bytes = recovered;
      }
      downloaded += bytes.byteLength;
      onProgress({ phase: "download", loaded: downloaded, total: transport.byteLength });
      await orSink(writer.write(bytes));
    }
    if (sinkError) throw sinkError;
    await orSink(writer.close());
  } catch (error) {
    // Fire-and-forget: aborting a wedged transform can itself never settle.
    void writer.abort(error).catch(() => {});
    if (sinkError && sinkError !== error) throw sinkError;
    throw error;
  }
  await writerDone;
  if (inflated !== byteLength) {
    throw new Error(`Pack inflated to ${inflated} bytes; manifest says ${byteLength}.`);
  }
  return inflated;
}

export async function installProfile(
  entry: ProfileIndexEntry,
  onProgress: (p: InstallProgress) => void = () => {},
): Promise<InstalledProfile> {
  const manifest = await fetchManifest(entry.manifest);
  const { pack, workerfs, release, modules } = manifest.content;
  const expected: PackMeta = {
    digest: pack.digest,
    byteLength: pack.byteLength,
    release,
  };
  const packName = `${entry.id}.${stripSha(pack.digest).slice(0, 20)}.pack`;
  const dir = await opfsRoot();

  const finish = (segments: PackSegment[], fromCache: boolean, persistent: boolean): InstalledProfile => ({
    id: entry.id,
    release,
    segments,
    totalBytes: pack.byteLength,
    mountPoint: workerfs.mountPoint,
    fromCache,
    persistent,
    moduleNames: Object.keys(modules),
    modules,
  });

  const memoryInstall = async (): Promise<InstalledProfile> => {
    const pieces: Uint8Array[] = [];
    await inflateTransport(manifest, async (chunk) => {
      pieces.push(chunk);
    }, onProgress);
    const plans = planSegments(workerfs.metadata.files, 512 * 1024 * 1024);
    return finish(buildSegments(pieces, plans), false, false);
  };

  if (!dir) return memoryInstall();

  // A valid cached pack always wins — even when a recorded OPFS ceiling
  // would forbid a fresh write of this size (the cache may predate the
  // ceiling, or another browser profile wrote it).
  const cached = await readCached(dir, packName, expected);
  if (cached) {
    onProgress({ phase: "cached", loaded: pack.byteLength, total: pack.byteLength });
    return finish([{ blob: cached, metadata: workerfs.metadata }], true, true);
  }
  if (pack.byteLength >= opfsByteCeiling()) {
    // A previous visit hit this browser's real OPFS ceiling below this size;
    // skip the doomed attempt (and its stall) entirely.
    return memoryInstall();
  }

  // Ask for durable storage before a multi-hundred-MB write; a denied request
  // is fine (best-effort mode), but Firefox quotas want the ask.
  try {
    await navigator.storage.persist?.();
  } catch {
    /* best-effort */
  }

  const stagingName = `${packName}.staging`;
  try {
    await removeIfPresent(dir, stagingName);
    const staging = await dir.getFileHandle(stagingName, { create: true });
    const writable = await staging.createWritable();
    let written = 0;
    try {
      await inflateTransport(manifest, async (chunk) => {
        await stallGuard(writable.write(chunk as Uint8Array<ArrayBuffer>), "OPFS write");
        written += chunk.byteLength;
      }, onProgress);
      await stallGuard(writable.close(), "OPFS close");
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "QuotaExceededError" || name === "OpfsStallError") recordOpfsCeiling(written);
      await Promise.race([writable.abort().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      throw error;
    }
    onProgress({ phase: "commit", loaded: pack.byteLength, total: pack.byteLength });
    await removeIfPresent(dir, packName);
    const movable = staging as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
    if (typeof movable.move !== "function") {
      throw new DOMException("FileSystemFileHandle.move is unavailable", "NotSupportedError");
    }
    await movable.move(packName);
    try {
      const committed = await (await dir.getFileHandle(packName)).getFile();
      if (committed.size !== pack.byteLength) {
        throw new Error(`Committed pack is ${committed.size} bytes; expected ${pack.byteLength}.`);
      }
      const metaHandle = await dir.getFileHandle(`${packName}.meta.json`, { create: true });
      const metaWritable = await metaHandle.createWritable();
      await metaWritable.write(JSON.stringify(expected));
      await metaWritable.close();
      // Garbage-collect superseded releases of this profile (same id, other
      // digest): without this, every upgrade leaks a multi-GB pack.
      try {
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          if (name.startsWith(`${entry.id}.`) && !name.startsWith(packName)) {
            await removeIfPresent(dir, name);
          }
        }
      } catch {
        /* enumeration unsupported — leak rather than fail the install */
      }
      return finish([{ blob: committed, metadata: workerfs.metadata }], false, true);
    } catch (error) {
      // A pack without a valid meta marker must not survive: readCached would
      // ignore it, and it would silently occupy gigabytes forever.
      await removeIfPresent(dir, packName);
      await removeIfPresent(dir, `${packName}.meta.json`);
      throw error;
    }
  } catch (error) {
    // Transactional cleanup, then degrade: storage problems (quota, missing
    // move()) must never block the session — hold the pack in memory instead.
    await removeIfPresent(dir, stagingName);
    const name = (error as { name?: string }).name;
    if (name === "QuotaExceededError" || name === "NotSupportedError" || name === "OpfsStallError") {
      onProgress({ phase: "download", loaded: 0, total: manifest.content.pack.transport.byteLength });
      return memoryInstall();
    }
    throw error;
  }
}

/** Compute the transitive import closure of `roots` over installed modules. */
export function importClosure(
  roots: string[],
  modules: Record<string, { imports: string[] }>,
): { closure: string[]; missing: string[] } {
  const seen = new Set<string>();
  const missing = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    const entry = modules[name];
    if (!entry) {
      missing.add(name);
      continue;
    }
    seen.add(name);
    for (const dep of entry.imports) if (!seen.has(dep)) stack.push(dep);
  }
  return { closure: [...seen].sort(), missing: [...missing].sort() };
}

/** Parse `import` / `public import` / `meta import` headers from source. */
export function parseImports(source: string): string[] {
  const imports: string[] = [];
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (t.startsWith("--")) continue;
    const m = /^(?:public\s+|private\s+)?(?:meta\s+)?import\s+([A-Za-z_][\w.«»]*)/.exec(t);
    if (m && m[1]) imports.push(m[1]);
  }
  return imports;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return null;
  }
}
