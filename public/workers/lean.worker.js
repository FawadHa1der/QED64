/* QED64 Lean worker — runs the real wasm64 Lean 4 compiler in this Worker.
 *
 * Two execution modes over one Emscripten runtime:
 *
 *  - persistent: boot once (runtime init + WORKERFS pack mounts), then serve
 *    repeated `compile` requests through the fork's `lean_wasm_compile`
 *    export. The first compile for an import set pays the import; later
 *    compiles reuse the resident environment and take milliseconds.
 *
 *  - oneshot: a full CLI run (argv → main → exit) for batch checking. The
 *    runtime tears itself down afterwards (EXIT_RUNTIME=1), so the host must
 *    discard this Worker after a oneshot completes.
 *
 * Pointer discipline (wasm64): every i64-typed wasm export parameter MUST be
 * a BigInt, and i64 returns come back as BigInt. JS-side helpers normalize at
 * the boundary; addresses are < 2^53 (16 GiB cap), so Number is safe for
 * arithmetic once converted. Verified-materialization and WORKERFS patterns
 * follow the Browser64 evidence (wasm64-lean-codex, Apache-2.0).
 */

"use strict";

const PROTOCOL = 1;
const PAGE = 65536;

const MEMORY64_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x05, 0x03, 0x01, 0x04, 0x00, // memory section: flags 0x04 (memory64), min 0
]);

let state = "idle"; // idle → booting → ready → compiling | exhausted | dead
let M = null; // the live Emscripten module (window.Module is the glue's)
// Emscripten reads print/printErr ONCE at startup; route through this sink so
// each compile can claim the output stream.
let sink = null;
let bootConfig = null;
let bootMemory = null; // the shared Memory64 this worker created; heap writes re-read .buffer after growth
let currentRequest = null;
let compileSeq = 0;

// ---------------------------------------------------------------------------
// RPC plumbing
// ---------------------------------------------------------------------------

function post(msg) {
  self.postMessage({ protocol: PROTOCOL, ...msg });
}
function event(requestId, kind, payload) {
  post({ type: "event", requestId, kind, ...payload });
}
function progress(requestId, phase, label, loaded, total, unit) {
  event(requestId, "progress", { phase, label, loaded, total, unit });
}
function fail(requestId, error, code, recoverable) {
  post({
    type: "error",
    requestId,
    error: {
      code: code || "UNKNOWN",
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack,
      recoverable: Boolean(recoverable),
    },
  });
}

// A rejection nobody awaits (e.g. an allocation failure inside Emscripten's
// async materialization) must not strand the host mid-phase with no signal:
// observed live as a boot hung forever at "Mounting verified library packs"
// after "RangeError: Array buffer allocation failed" went uncaught. Fail the
// in-flight request so the app can show a real error instead of a spinner.
// `inFlightBootFail` routes through boot's settled-once guard while a boot
// is pending; a compile in flight fails per-request; anything else is logged.
let inFlightBootFail = null;
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  const error = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
  if (inFlightBootFail) {
    inFlightBootFail(error);
    return;
  }
  if (currentRequest !== null && state === "compiling") {
    const inFlight = currentRequest;
    currentRequest = null;
    state = "ready";
    fail(inFlight, error, "UNHANDLED_REJECTION", true);
  } else {
    event(null, "log", { stream: "stderr", text: `unhandled rejection: ${error.message}` });
  }
});

// ---------------------------------------------------------------------------
// wasm64 pointer helpers
// ---------------------------------------------------------------------------

/** Coerce any pointer-like value to BigInt for an i64 wasm parameter. */
function asPtr(v) {
  return typeof v === "bigint" ? v : BigInt(Math.trunc(v));
}
/** Coerce any pointer-like value to a JS Number address (< 2^53 by cap). */
function asNum(v) {
  if (typeof v === "bigint") {
    if (v > 9007199254740991n) throw new RangeError(`Address ${v} exceeds 2^53-1.`);
    return Number(v);
  }
  return v;
}
/** Call a wasm export whose parameters are all i64 pointers. */
function callP(fn, ...args) {
  return fn(...args.map(asPtr));
}

/** Read one byte of a Lean object header/payload. The build exports getValue
 * (not the HEAP views), so all memory reads go through it. */
function peekU8(addr) {
  return Number(M.getValue(asNum(addr), "i8")) & 0xff;
}
/** Read a pointer-sized field (8 bytes, little-endian) as BigInt. */
function peekU64(addr) {
  return BigInt(M.getValue(asNum(addr), "i64"));
}

/** Lean IO.Result inspection: constructor tag byte lives at offset 7. */
function ioResultTag(resPtr) {
  return peekU8(asNum(resPtr) + 7);
}
/** First object field (offset 8, pointer width). */
function ioResultValue(resPtr) {
  return peekU64(asNum(resPtr) + 8);
}
/** Decode a Lean tagged scalar (odd ⇒ boxed scalar n = v >> 1). */
function unboxScalar(v) {
  return (v & 1n) === 1n ? v >> 1n : null;
}

/** Build a Lean string object from a JS string; returns a BigInt pointer. */
function mkLeanString(text) {
  const cstr = M.stringToNewUTF8(text);
  const obj = callP(M._lean_mk_string, cstr);
  M._free(asPtr(cstr));
  return asPtr(obj);
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

function capabilities() {
  const memory64 =
    typeof WebAssembly === "object" &&
    typeof BigInt === "function" &&
    WebAssembly.validate(MEMORY64_PROBE);
  return {
    memory64,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    atomics: typeof Atomics === "object",
    crossOriginIsolated: self.crossOriginIsolated === true,
    ok:
      memory64 &&
      typeof SharedArrayBuffer === "function" &&
      typeof Atomics === "object" &&
      self.crossOriginIsolated === true,
  };
}

// ---------------------------------------------------------------------------
// Verified runtime materialization (chunks → SHA-256 → Blob URLs)
// ---------------------------------------------------------------------------

function hex(buffer) {
  let out = "";
  for (const b of new Uint8Array(buffer)) out += b.toString(16).padStart(2, "0");
  return out;
}
async function sha256(blobOrBytes) {
  const bytes = blobOrBytes instanceof Blob ? await blobOrBytes.arrayBuffer() : blobOrBytes;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function fetchChunkOnce(chunk, index, label, cacheMode) {
  const response = await fetch(chunk.url, { cache: cacheMode });
  if (!response.ok) throw new Error(`${label} chunk ${index}: HTTP ${response.status}`);
  const encoding = response.headers.get("Content-Encoding");
  if (encoding && encoding !== "identity") {
    throw new Error(`${label} chunk ${index} was transformed by Content-Encoding: ${encoding}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== chunk.bytes) {
    throw new Error(`${label} chunk ${index}: ${bytes.byteLength} bytes, expected ${chunk.bytes}.`);
  }
  if ((await sha256(bytes)) !== chunk.sha256) {
    throw new Error(`${label} chunk ${index} failed SHA-256 verification.`);
  }
  return bytes;
}

async function fetchChunk(chunk, index, label, requestId, running) {
  let bytes;
  try {
    bytes = await fetchChunkOnce(chunk, index, label, "force-cache");
  } catch {
    // The HTTP cache can hold a poisoned response for this URL (e.g. an SPA
    // fallback page cached before the artifact was deployed). Content
    // addressing makes the retry safe: bypass the cache once and re-verify.
    bytes = await fetchChunkOnce(chunk, index, label, "reload");
  }
  running.loaded += bytes.byteLength;
  progress(requestId, "runtime", `Verifying ${label}`, running.loaded, running.total, "bytes");
  return bytes;
}

async function materialize(file, label, mime, requestId, running) {
  const pieces = [];
  for (let i = 0; i < file.chunks.length; i += 1) {
    pieces.push(await fetchChunk(file.chunks[i], i, label, requestId, running));
  }
  const whole = new Blob(pieces, { type: mime });
  if (whole.size !== file.bytes) {
    throw new Error(`${label}: reconstructed ${whole.size} bytes, expected ${file.bytes}.`);
  }
  if ((await sha256(whole)) !== file.sha256) {
    throw new Error(`${label} failed whole-file SHA-256 verification.`);
  }
  return URL.createObjectURL(whole);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function createSharedMemory64(initialBytes, maxCandidatesBytes) {
  const initial = BigInt(Math.ceil(initialBytes / PAGE));
  for (const maxBytes of maxCandidatesBytes) {
    const maximum = BigInt(Math.floor(maxBytes / PAGE));
    try {
      const memory = new WebAssembly.Memory({
        initial,
        maximum,
        shared: true,
        address: "i64",
      });
      return { memory, initialBytes: Number(initial) * PAGE, maximumBytes: Number(maximum) * PAGE };
    } catch {
      // Try the next, smaller reservation.
    }
  }
  throw new Error("Could not allocate a shared Memory64 heap at any candidate size.");
}

function memoryTelemetry() {
  try {
    const buffer = M && M.wasmMemory ? M.wasmMemory.buffer : null;
    if (!buffer) return undefined;
    return {
      currentBytes: buffer.byteLength,
      maximumBytes: bootConfig ? bootConfig.memory.maximumBytes : undefined,
      shared: typeof SharedArrayBuffer === "function" && buffer instanceof SharedArrayBuffer,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

function mkdirp(FS, dirPath) {
  let current = "";
  for (const part of dirPath.split("/").filter(Boolean)) {
    current += `/${part}`;
    try {
      FS.mkdir(current);
    } catch {
      /* exists */
    }
  }
}

function validatePackEntry(file, blobSize, label) {
  if (typeof file.filename !== "string" || !file.filename.startsWith("/")) {
    throw new TypeError(`${label}: pack filename must be absolute: ${file.filename}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(file.filename) || file.filename.includes("..")) {
    throw new TypeError(`${label}: unsafe pack filename: ${file.filename}`);
  }
  if (
    !Number.isSafeInteger(file.start) ||
    !Number.isSafeInteger(file.end) ||
    file.start < 0 ||
    file.end < file.start ||
    file.end > blobSize
  ) {
    throw new RangeError(`${label}: invalid byte range for ${file.filename}`);
  }
}

function mountPacks(FS, packs, defaultMountPoint) {
  const grouped = new Map();
  for (const pack of packs) {
    const files = pack.metadata && pack.metadata.files;
    if (!Array.isArray(files) || files.length === 0) {
      throw new TypeError(`Pack ${pack.id}: missing pack metadata.`);
    }
    const mountPoint = pack.mountPoint || defaultMountPoint;
    if (pack.bytes) {
      // Byte-backed segment: write each file into MEMFS. Contents live in the
      // worker's JS heap (not wasm linear memory, not Blob storage); Lean's
      // region loader copies bytes into the wasm heap on open, exactly as it
      // would from a WORKERFS read.
      const bytes = pack.bytes instanceof Uint8Array ? pack.bytes : new Uint8Array(pack.bytes);
      for (const file of files) validatePackEntry(file, bytes.byteLength, pack.id);
      mkdirp(FS, mountPoint);
      for (const file of files) {
        const target = `${mountPoint}${file.filename}`;
        mkdirp(FS, target.slice(0, target.lastIndexOf("/")));
        FS.writeFile(target, bytes.subarray(file.start, file.end));
      }
      continue;
    }
    if (!(pack.blob instanceof Blob)) throw new TypeError(`Pack ${pack.id}: no payload.`);
    for (const file of files) validatePackEntry(file, pack.blob.size, pack.id);
    if (!grouped.has(mountPoint)) grouped.set(mountPoint, []);
    grouped.get(mountPoint).push({ metadata: pack.metadata, blob: pack.blob });
  }
  for (const [mountPoint, packages] of grouped) {
    mkdirp(FS, mountPoint);
    FS.mount(FS.filesystems.WORKERFS, { packages }, mountPoint);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

const DIAG_RE = /^(.*?):(\d+):(\d+):\s+(error|warning|information):\s?([\s\S]*)$/;

function parseDiagnostic(text, fallbackFile) {
  // The CLI's --json mode emits one JSON object per diagnostic; the persistent
  // shell prints classic `file:line:col: severity: message` lines.
  if (text.startsWith("{")) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && value.severity) {
        return {
          fileName: value.fileName || fallbackFile,
          line: value.pos ? value.pos.line : 1,
          column: value.pos ? value.pos.column : 0,
          endLine: value.endPos ? value.endPos.line : undefined,
          endColumn: value.endPos ? value.endPos.column : undefined,
          severity: value.severity,
          message: typeof value.data === "string" ? value.data : value.message || "",
        };
      }
    } catch {
      /* fall through to the plain form */
    }
  }
  const match = DIAG_RE.exec(text);
  if (!match) return null;
  return {
    fileName: match[1] || fallbackFile,
    line: Number(match[2]),
    column: Number(match[3]),
    severity: match[4],
    message: match[5] || "",
  };
}

/** Stream collector: groups multi-line diagnostics (continuation lines are
 * indented or lack the file:line:col prefix) under the last diagnostic. */
function makeOutputCollector(requestId, fallbackFile) {
  const diagnostics = [];
  const raw = [];
  let importProgressSeen = 0;
  function push(stream, value) {
    const text = String(value);
    const m = /\[DEBUG:PROGRESS\]\s*(\d+)\/(\d+)/.exec(text);
    if (m) {
      progress(requestId, "import", "Importing modules", Number(m[1]), Number(m[2]), "modules");
      return;
    }
    if (/^\s*-\s+\/.*\.olean\s*$/.test(text)) {
      importProgressSeen += 1;
      if (importProgressSeen % 25 === 0) {
        progress(requestId, "import", "Importing modules", importProgressSeen, undefined, "modules");
      }
      return;
    }
    if (/^\s*\[(WASM DEBUG|DEBUG|PROFILE|PWORKER|COMPILE)/.test(text)) return;
    const diagnostic = parseDiagnostic(text, fallbackFile);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    } else if (diagnostics.length > 0 && /^\s/.test(text)) {
      // Continuation of the previous message (goal states are multi-line).
      diagnostics[diagnostics.length - 1].message += `\n${text}`;
    } else {
      raw.push({ stream, text });
    }
    event(requestId, "log", { stream, text });
  }
  return { diagnostics, raw, push };
}

// ---------------------------------------------------------------------------
// Boot (persistent runtime)
// ---------------------------------------------------------------------------

async function boot(msg) {
  if (state !== "idle") {
    fail(msg.requestId, new Error(`Worker is '${state}'; boot requires a fresh Worker.`), "BAD_STATE", true);
    return;
  }
  // Validate the config shape before any state transition: a malformed boot
  // must produce exactly one error reply, never a silently wedged worker.
  const cfg = msg.config;
  const filesOk =
    cfg && cfg.runtime && cfg.runtime.files &&
    cfg.runtime.files["lean.js"] && Array.isArray(cfg.runtime.files["lean.js"].chunks) &&
    cfg.runtime.files["lean.wasm"] && Array.isArray(cfg.runtime.files["lean.wasm"].chunks) &&
    cfg.memory && Number.isFinite(cfg.memory.initialBytes) && Array.isArray(cfg.memory.maximumCandidates) &&
    typeof cfg.leanPath === "string";
  if (!filesOk) {
    fail(msg.requestId, new Error("Malformed boot config."), "INVALID_MESSAGE", false);
    state = "dead";
    return;
  }
  state = "booting";
  const caps = capabilities();
  if (!caps.ok) {
    state = "dead";
    fail(
      msg.requestId,
      new Error("Missing capability: Memory64, SharedArrayBuffer, Atomics, or cross-origin isolation."),
      "CAPABILITY_MISSING",
      false,
    );
    return;
  }

  bootConfig = msg.config;
  const requestId = msg.requestId;
  const files = bootConfig.runtime.files;
  const running = {
    loaded: 0,
    total: files["lean.js"].bytes + files["lean.wasm"].bytes,
  };

  let scriptUrl;
  let wasmUrl;
  try {
    scriptUrl = await materialize(files["lean.js"], "lean.js", "text/javascript", requestId, running);
    wasmUrl = await materialize(files["lean.wasm"], "lean.wasm", "application/wasm", requestId, running);
  } catch (error) {
    state = "dead";
    fail(requestId, error, "RUNTIME_FETCH_FAILED", false);
    return;
  }

  let mem;
  try {
    mem = createSharedMemory64(bootConfig.memory.initialBytes, bootConfig.memory.maximumCandidates);
  } catch (error) {
    state = "dead";
    fail(requestId, error, "MEMORY_FAILED", false);
    return;
  }
  bootConfig.memory.maximumBytes = mem.maximumBytes;
  bootMemory = mem.memory;
  progress(requestId, "memory", `Shared Memory64 heap: ${(mem.initialBytes / 1048576) | 0} MiB → ${(mem.maximumBytes / 1073741824)} GiB max`);

  const collector = makeOutputCollector(requestId, "<boot>");
  sink = collector;

  await new Promise((resolve) => {
    let settled = false;
    const finishBoot = (ok, error) => {
      if (settled) return;
      settled = true;
      inFlightBootFail = null;
      if (ok) {
        state = "ready";
        post({
          type: "ready",
          requestId,
          ready: {
            buildId: bootConfig.runtime.buildId,
            leanVersion: bootConfig.runtime.leanVersion,
            capabilities: caps,
            memory: memoryTelemetry(),
            mode: "persistent",
          },
        });
      } else {
        state = "dead";
        fail(requestId, error || new Error("Lean runtime failed to initialize."), "INIT_FAILED", false);
      }
      resolve();
    };
    inFlightBootFail = (error) => finishBoot(false, error);

    self.Module = {
      wasmMemory: mem.memory,
      INITIAL_MEMORY: mem.initialBytes,
      noInitialRun: true,
      locateFile(p) {
        return p.endsWith(".wasm") ? wasmUrl : new URL(p, scriptUrl).href;
      },
      mainScriptUrlOrBlob: scriptUrl,
      print: (v) => sink && sink.push("stdout", v),
      printErr: (v) => sink && sink.push("stderr", v),
      ENV: { LEAN_PATH: bootConfig.leanPath },
      preRun: [
        function mountEverything() {
          progress(requestId, "filesystem", "Mounting verified library packs");
          const FS = self.Module.FS;
          // /bin must exist: lean_init_search_path stats the executable's
          // virtual directory (IO.appPath reports /bin/lean).
          mkdirp(FS, "/bin");
          mkdirp(FS, "/workspace");
          mkdirp(FS, "/snapshots");
          for (const dir of String(bootConfig.leanPath).split(":")) mkdirp(FS, dir);
          mountPacks(FS, bootConfig.packs || [], String(bootConfig.leanPath).split(":")[0]);
          self.Module.ENV.LEAN_PATH = bootConfig.leanPath;
          try {
            FS.chdir("/workspace");
          } catch {
            /* mkdirp reported the real problem */
          }
        },
      ],
      onRuntimeInitialized() {
        try {
          progress(requestId, "initialize", "Initializing the Lean runtime");
          M = self.Module;
          M._lean_initialize_runtime_module();
          M._lean_initialize();
          M._lean_io_mark_end_initialization();
          if (M._lean_init_task_manager) M._lean_init_task_manager();
          if (M._lean_enable_initializer_execution) M._lean_enable_initializer_execution();
          const sp = M._lean_init_search_path();
          if (ioResultTag(sp) !== 0) {
            try {
              callP(M._lean_io_result_show_error, sp);
            } catch {
              /* diagnostics already flowed through printErr */
            }
            throw new Error("lean_init_search_path failed (see log).");
          }
          finishBoot(true);
        } catch (error) {
          finishBoot(false, error);
        }
      },
      onAbort(reason) {
        if (!settled) {
          finishBoot(false, new Error(`Lean aborted during boot: ${reason || "unknown"}`));
          return;
        }
        // A post-boot abort means the wasm runtime is gone for good: report
        // the in-flight request (if any) as unrecoverable and go dead.
        state = "dead";
        fail(currentRequest, new Error(`Lean runtime aborted: ${reason || "unknown"}`), "RUNTIME_ABORTED", false);
      },
    };

    try {
      progress(requestId, "runtime", "Starting the Emscripten runtime");
      importScripts(scriptUrl);
    } catch (error) {
      finishBoot(false, error);
    }
  });
}

// ---------------------------------------------------------------------------
// Persistent compile
// ---------------------------------------------------------------------------

function compile(msg) {
  if (state !== "ready") {
    fail(msg.requestId, new Error(`Worker is '${state}', not ready.`), "BAD_STATE", state === "compiling");
    return;
  }
  if (!msg.input || typeof msg.input.source !== "string") {
    fail(msg.requestId, new Error("Malformed compile input."), "INVALID_MESSAGE", true);
    return;
  }
  state = "compiling";
  currentRequest = msg.requestId;
  const started = performance.now();
  compileSeq += 1;
  const fileName = msg.input.fileName || `/workspace/input${compileSeq}.lean`;
  const collector = makeOutputCollector(msg.requestId, fileName);
  const savedSink = sink;
  sink = collector;

  let exitCode = 1;
  let runtimeError = null;
  try {
    const codeObj = mkLeanString(String(msg.input.source || ""));
    const nameObj = mkLeanString(fileName);
    const res = callP(M._lean_wasm_compile, codeObj, nameObj);
    const tag = ioResultTag(res);
    if (tag === 0) {
      const scalar = unboxScalar(ioResultValue(res));
      // The shell returns a UInt32: 0 = clean, otherwise the error count. A
      // 64-bit build boxes UInt32 as a tagged scalar; treat a non-scalar value
      // conservatively as success-with-diagnostics.
      exitCode = scalar === null ? 0 : Number(scalar);
    } else {
      try {
        callP(M._lean_io_result_show_error, res);
      } catch {
        /* already logged */
      }
      const tail = (collector.raw || [])
        .filter((l) => l.stream === "stderr" && l.text.trim() && !l.text.startsWith("[WASM"))
        .slice(-3)
        .map((l) => l.text.trim().slice(0, 220));
      runtimeError = new Error(
        "lean_wasm_compile returned an IO error" + (tail.length ? `: ${tail.join(" · ")}` : " (see log)."),
      );
    }
  } catch (error) {
    runtimeError = error;
  } finally {
    // Keep the sink on this compile's collector: Emscripten pthreads can
    // proxy output back after the call returns, and late lines belong to the
    // last compile rather than the boot log. (savedSink is only restored if
    // a newer collector never replaces it — i.e. never.)
    void savedSink;
    if (state === "compiling") state = "ready";
    currentRequest = null;
  }
  if (state === "dead") {
    // onAbort already reported the failure; do not also post a result.
    return;
  }

  if (runtimeError && collector.diagnostics.length === 0) {
    fail(msg.requestId, runtimeError, "COMPILE_CRASHED", true);
    return;
  }
  const hasErrors =
    exitCode !== 0 || collector.diagnostics.some((d) => d.severity === "error") || Boolean(runtimeError);
  post({
    type: "result",
    requestId: msg.requestId,
    result: {
      operation: "compile",
      success: !hasErrors,
      exitCode,
      elapsedMs: performance.now() - started,
      diagnostics: collector.diagnostics,
      raw: collector.raw,
      memory: memoryTelemetry(),
    },
  });
}

// ---------------------------------------------------------------------------
// Snapshot loading (optional fast boot)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Snapshot cache (OPFS, worker-side)
// ---------------------------------------------------------------------------
// An 806 MB umbrella snapshot must not be re-downloaded every session; the
// HTTP cache is not reliable at that size. Bytes are stored exactly as
// received (compressed — the served name never triggers Content-Encoding)
// and read back through a sync access handle in 8 MiB slices. Any cache
// failure (quota, API absent, embedder rot) is logged and the load proceeds
// from the network; caching never fails a load.

async function snapshotCacheDir() {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle("qed64-snapshots", { create: true });
  } catch {
    return null;
  }
}

/** A ReadableStream over a cached snapshot file, or null when absent. */
async function openCachedSnapshot(cacheKey) {
  const dir = await snapshotCacheDir();
  if (!dir || !cacheKey) return null;
  let handle;
  try {
    const fh = await dir.getFileHandle(cacheKey);
    handle = await fh.createSyncAccessHandle();
  } catch {
    return null;
  }
  const size = handle.getSize();
  if (size === 0) {
    handle.close();
    return null;
  }
  const SLICE = 8 * 1024 * 1024;
  let at = 0;
  return {
    size,
    stream: new ReadableStream({
      pull(controller) {
        if (at >= size) {
          handle.close();
          controller.close();
          return;
        }
        const buf = new Uint8Array(Math.min(SLICE, size - at));
        const n = handle.read(buf, { at });
        at += n;
        controller.enqueue(n === buf.length ? buf : buf.subarray(0, n));
      },
      cancel() {
        try { handle.close(); } catch { /* closed */ }
      },
    }),
  };
}

/** Incremental writer for a snapshot being downloaded; commits on finish. */
async function beginSnapshotCacheWrite(cacheKey) {
  const dir = await snapshotCacheDir();
  if (!dir || !cacheKey) return null;
  const partial = `${cacheKey}.partial`;
  let handle;
  let fh;
  try {
    try { await dir.removeEntry(partial); } catch { /* absent */ }
    fh = await dir.getFileHandle(partial, { create: true });
    handle = await fh.createSyncAccessHandle();
  } catch {
    return null;
  }
  let at = 0;
  let dead = false;
  return {
    write(bytes) {
      if (dead) return;
      try {
        handle.write(bytes, { at });
        at += bytes.length;
      } catch (error) {
        dead = true;
        try { handle.close(); } catch { /* ignore */ }
        dir.removeEntry(partial).catch(() => {});
        event(null, "log", { stream: "stderr", text: `snapshot cache write stopped: ${error && error.message}` });
      }
    },
    async finish() {
      if (dead) return false;
      try {
        handle.flush();
        handle.close();
        if (typeof fh.move === "function") {
          try { await dir.removeEntry(cacheKey); } catch { /* absent */ }
          await fh.move(cacheKey);
        } else {
          // No rename: leave the partial in place under its final name next time.
          const final = await dir.getFileHandle(cacheKey, { create: true });
          const w = await final.createSyncAccessHandle();
          const src = await fh.createSyncAccessHandle();
          const buf = new Uint8Array(8 * 1024 * 1024);
          let pos = 0;
          for (;;) {
            const n = src.read(buf, { at: pos });
            if (n === 0) break;
            w.write(buf.subarray(0, n), { at: pos });
            pos += n;
          }
          src.close();
          w.flush();
          w.close();
          await dir.removeEntry(partial);
        }
        // Prune superseded bakes of the same logical snapshot (keys embed a
        // digest or sizes, so every deploy leaves a differently-named
        // sibling; without this, dead multi-GB entries accumulate until the
        // origin hits its OPFS quota). Collect names BEFORE deleting —
        // removing entries mid-iteration invalidates the directory iterator.
        try {
          const stem = cacheKey.split(".")[0];
          const stale = [];
          for await (const entryName of dir.keys()) {
            if (entryName !== cacheKey && entryName.startsWith(`${stem}.`) && entryName.endsWith(".snapz")) {
              stale.push(entryName);
            }
          }
          for (const entryName of stale) {
            await dir.removeEntry(entryName).catch(() => {});
          }
          if (stale.length > 0) {
            event(null, "log", { stream: "stderr", text: `snapshot cache pruned: ${stale.join(", ")}` });
          }
        } catch { /* best effort */ }
        return true;
      } catch (error) {
        dead = true;
        dir.removeEntry(partial).catch(() => {});
        event(null, "log", { stream: "stderr", text: `snapshot cache commit failed: ${error && error.message}` });
        return false;
      }
    },
    abort() {
      if (dead) return;
      dead = true;
      try { handle.close(); } catch { /* ignore */ }
      dir.removeEntry(partial).catch(() => {});
    },
  };
}

async function loadSnapshot(msg) {
  if (state !== "ready") {
    fail(msg.requestId, new Error(`Worker is '${state}', not ready.`), "BAD_STATE", true);
    return;
  }
  if (!msg.input || typeof msg.input.url !== "string") {
    fail(msg.requestId, new Error("Malformed loadSnapshot input."), "INVALID_MESSAGE", true);
    return;
  }
  const { url, name, expectedBytes, cacheKey } = msg.input;
  const safeName = String(name || "boot.snap").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = `/snapshots/${compileSeq += 1}-${safeName}`;
  const started = performance.now();
  state = "compiling"; // snapshot loads own the runtime exactly like a compile
  const FS = M.FS;
  // Direct path: stream the region straight into a wasm-malloc'd buffer and
  // let the runtime read it from memory. Avoids staging a multi-GB file in
  // MEMFS (a second copy in this worker's JS heap — the allocation that
  // fails first on memory-tight renderers). Needs the raw size up front.
  const direct = typeof M._lean_wasm_load_snapshot_mem === "function" && bootMemory && Number(expectedBytes) > 0;
  let heapPtr = null;
  let stream = null;
  let reader = null;
  let cacheWriterRef = null;
  let prevSinkRef = null;
  try {
    const cached = await openCachedSnapshot(cacheKey);
    let sourceBody;
    let fromCache = false;
    let contentLength = 0;
    if (cached) {
      sourceBody = cached.stream;
      fromCache = true;
      contentLength = cached.size;
    } else {
      const response = await fetch(url);
      if (!response.ok || !response.body) throw new Error(`snapshot fetch: HTTP ${response.status}`);
      sourceBody = response.body;
      contentLength = Number(response.headers.get("content-length")) || 0;
    }
    // For gzip-served snapshots content-length is the transfer size; the
    // caller passes the RAW region size for pre-sizing and progress.
    const total = Number(expectedBytes) || contentLength || 0;
    const cacheWriter = fromCache ? null : await beginSnapshotCacheWrite(cacheKey);
    cacheWriterRef = cacheWriter;
    if (direct) {
      heapPtr = asPtr(M._malloc(asPtr(total)));
      if (heapPtr === 0n) throw new Error(`snapshot: could not allocate ${total} bytes in the wasm heap`);
    } else {
      stream = FS.open(path, "w");
      if (total > 0) {
        // Pre-size the MEMFS file: growth-by-doubling would transiently hold
        // ~2× the snapshot in the JS heap mid-copy, which is exactly what dies
        // first on a memory-tight session. One exact allocation instead.
        try { FS.ftruncate(stream.fd, total); } catch { /* fall back to growth */ }
      }
    }
    // Gzip-served snapshots inflate through DecompressionStream — but only if
    // the bytes that arrive are still gzip. Servers that recognise the .gz
    // extension add `Content-Encoding: gzip` and the browser inflates
    // transparently; trusting the URL would then gunzip plain olean bytes
    // ("incorrect header check"). Sniff the magic on the first chunk instead.
    const rawReader = sourceBody.getReader();
    const head = await rawReader.read();
    if (head.done || !head.value) throw new Error("snapshot fetch: empty body");
    const isGzip = head.value.length >= 2 && head.value[0] === 0x1f && head.value[1] === 0x8b;
    if (cacheWriter) cacheWriter.write(head.value);
    const replay = new ReadableStream({
      start(controller) {
        controller.enqueue(head.value);
      },
      async pull(controller) {
        const { done, value } = await rawReader.read();
        if (done) controller.close();
        else {
          if (cacheWriter) cacheWriter.write(value);
          controller.enqueue(value);
        }
      },
      cancel(reason) {
        return rawReader.cancel(reason);
      },
    });
    const body = isGzip ? replay.pipeThrough(new DecompressionStream("gzip")) : replay;
    reader = body.getReader();
    let received = 0;
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first) {
        first = false;
        const magic = [0x6f, 0x6c, 0x65, 0x61, 0x6e]; // "olean"
        if (value.length < 5 || magic.some((b, i) => value[i] !== b)) {
          throw new Error("snapshot is not a compacted-region file");
        }
      }
      if (direct) {
        if (received + value.length > total) throw new Error("snapshot: more bytes than the index declares");
        // Re-read .buffer each chunk (a shared memory's buffer object changes
        // on growth) and window the view: offsets past 2^32 are fine, a
        // whole-heap view of a multi-GiB buffer is not in every engine.
        new Uint8Array(bootMemory.buffer, Number(heapPtr) + received, value.length).set(value);
      } else {
        FS.write(stream, value, 0, value.length, received);
      }
      received += value.length;
      progress(msg.requestId, fromCache ? "snapshot-cache" : "snapshot", "Loading environment snapshot", received, total || undefined, "bytes");
    }
    if (cacheWriter) {
      const committed = await cacheWriter.finish();
      event(null, "log", { stream: "stderr", text: committed ? `snapshot cached as ${cacheKey}` : "snapshot not cached" });
    }
    // The region load below is one synchronous wasm call (1–2 min for a
    // whole-Mathlib environment); tell the host before blocking so it can
    // show an honest "loading into Lean" stage instead of a pegged bar. The
    // runtime streams "[WASM INIT] i/n Module" lines through printErr DURING
    // the call (JS callbacks run synchronously inside it), so a temporary
    // sink turns them into live per-module progress.
    progress(msg.requestId, "snapshot-load", "Loading the environment into Lean", undefined, undefined, "");
    const prevSink = sink;
    prevSinkRef = { sink: prevSink };
    sink = {
      push(stream, text) {
        const m = /^\[WASM INIT\] (\d+)\/(\d+) (.*)$/.exec(text);
        if (m) progress(msg.requestId, "snapshot-init", m[3], Number(m[1]), Number(m[2]), "modules");
        else if (prevSink) prevSink.push(stream, text);
      },
    };
    let res;
    if (direct) {
      if (received !== total) throw new Error(`snapshot: received ${received} bytes, index declares ${total}`);
      // The runtime takes ownership of the buffer as the region's backing store.
      const owned = heapPtr;
      heapPtr = null;
      // Third arg: replay-control flags — bit 0 runs the [init] attribute
      // replay, which the app always needs (compiles die without it).
      res = M._lean_wasm_load_snapshot_mem(owned, asPtr(received), 1n);
    } else {
      if (total > 0 && received !== total) {
        // The pre-size was a hint; trim (or extend) to what actually arrived so
        // the region loader never sees phantom trailing bytes.
        try { FS.ftruncate(stream.fd, received); } catch { /* best effort */ }
      }
      FS.close(stream);
      stream = null;
      FS.writeFile(`${path}.deps`, new Uint8Array([0x5b, 0x5d])); // "[]"
      res = callP(M._lean_wasm_load_snapshot, mkLeanString(path));
    }
    sink = prevSink;
    const tag = ioResultTag(res);
    const scalar = unboxScalar(ioResultValue(res));
    const ok = tag === 0 && (scalar === null || scalar === 0n);
    post({
      type: "result",
      requestId: msg.requestId,
      result: { operation: "loadSnapshot", success: ok, elapsedMs: performance.now() - started },
    });
  } catch (error) {
    // A mid-stream failure (allocation, network) must not strand a partial
    // multi-GB file in MEMFS: the fallback import that follows runs under
    // whatever heap this leak would have consumed.
    try { reader?.cancel(); } catch { /* stream already dead */ }
    try { if (stream !== null) FS.close(stream); } catch { /* already closed */ }
    if (heapPtr !== null) { try { M._free(heapPtr); } catch { /* best effort */ } }
    try { cacheWriterRef?.abort(); } catch { /* best effort */ }
    fail(msg.requestId, error, "SNAPSHOT_FAILED", true);
  } finally {
    if (prevSinkRef) sink = prevSinkRef.sink;
    try { FS.unlink(path); } catch { /* success path may run before a compile; absent is fine */ }
    try { FS.unlink(`${path}.deps`); } catch { /* ditto */ }
    if (state === "compiling") state = "ready";
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

self.addEventListener("message", (e) => {
  const msg = e.data;
  if (!msg || msg.protocol !== PROTOCOL || typeof msg.requestId !== "string") {
    fail(undefined, new Error("Malformed worker message."), "INVALID_MESSAGE", false);
    return;
  }
  switch (msg.type) {
    case "capabilities":
      post({ type: "result", requestId: msg.requestId, result: capabilities() });
      break;
    case "boot":
      void boot(msg);
      break;
    case "compile":
      compile(msg);
      break;
    case "loadSnapshot":
      void loadSnapshot(msg);
      break;
    case "telemetry":
      post({
        type: "result",
        requestId: msg.requestId,
        result: { operation: "telemetry", state, memory: memoryTelemetry() },
      });
      break;
    case "dispose":
      post({ type: "result", requestId: msg.requestId, result: { operation: "dispose" } });
      self.close();
      break;
    default:
      fail(msg.requestId, new Error(`Unknown request '${msg.type}'.`), "INVALID_MESSAGE", false);
  }
});

// Pure internals exposed for the unit-test harness (no effect in production).
self.__qed64TestExports = {
  parseDiagnostic,
  makeOutputCollector,
  validatePackEntry,
  unboxScalar,
  asPtr,
  asNum,
  capabilities,
  createSharedMemory64,
};

post({ type: "boot" });
