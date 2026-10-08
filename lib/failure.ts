// Structured boot progress and failure causes (docs/EMBEDDING.md §7.1, §7.2).
//
// Labels stay prose for humans; an embedder reads `stage` / `subject` / `step`
// and, on a failure, a `FailureCause` instead of parsing label text. A session
// dies "snapshot 'x' failed to load" for a cut connection, a corrupt region,
// an unpaired snapshot and an OOM alike — the cause tells them apart.
//
// Pure: unit-tested under node.

/** The step of a session boot, from a closed set. */
export type BootStage = "manifests" | "profile" | "runtime" | "memory" | "snapshot" | "modules" | "warm" | "files" | "done" | "failed";
export type BootStep = "check" | "download" | "inflate" | "commit" | "verify" | "read" | "load" | "init" | "write";

/** network: the fetch was rejected, the stream was cut, the body ended
 * before the bytes it announced arrived ("the transfer of … ended early"), or
 * the server answered 5xx/429 (retrying can help); missing: the server says it does not
 * have it — 404/410, an HTML page where a binary or script belongs, a
 * snapshot the index does not list (a deploy problem: retrying cannot help);
 * corrupt: it arrived IN FULL but is wrong (length, SHA-256, gzip, magic, a
 * region the loader refuses); unpaired: a snapshot of another runtime build; oom: an
 * allocation or memory reservation failed; storage: OPFS/quota; stale: the
 * site was updated under this page (its worker scripts are of another
 * revision than each other: WORKER_DEP_MISMATCH) — reload the page; other: the
 * checker's own failure. A death with NO cause is "no evidence" (a bare worker
 * error event) — see docs/EMBEDDING.md §7.2. */
export type FailureKind = "network" | "missing" | "corrupt" | "unpaired" | "oom" | "storage" | "stale" | "other";
export interface FailureCause {
  kind: FailureKind;
  /** The HTTP status that decided it, when there was one. */
  httpStatus?: number;
  /** The boot stage that failed; absent for a death while serving. */
  stage?: BootStage;
  /** Profile id, snapshot name or runtime file. */
  subject?: string;
  /** The worker's error code (`SNAPSHOT_FAILED`, …) when there was one. */
  code?: string;
  message: string;
}

/** Classify a failure by the worker's error code and its message text (the
 * fallback a page uses against a worker that reports no `cause`, and the
 * classifier for page-side errors). Order matters: an allocation failure
 * inside a fetch path is OOM, and a chunk that arrived but fails its SHA-256
 * or length check is corrupt, though its code says RUNTIME_FETCH_FAILED. */
export function failureKindOf(code: string | undefined, message: string): FailureKind {
  if (code === WORKER_DEP_MISMATCH || STALE_MESSAGE.test(message)) return "stale";
  if (code === "SNAPSHOT_UNPAIRED" || /was baked for runtime/.test(message)) return "unpaired";
  if (code === "SNAPSHOT_URL_REFUSED" || /SNAPSHOT_URL_REFUSED/.test(message)) return "other";
  if (code === "SNAPSHOT_NOT_IN_INDEX") return "missing";
  if (code === "RUNTIME_MANIFEST_MISMATCH") return "corrupt"; // a manifest whose buildId is not the id of its own lean.wasm
  const status = httpStatusOf(message);
  // The server does not have it (or will not give it): 404/410 and every other
  // 4xx but the retryable ones; an HTML page where a binary, script or JSON belongs.
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429) return "missing";
  if (/answered HTML|Unexpected token '?<|<!doctype|text\/html/i.test(message)) return "missing";
  if (code === "MEMORY_FAILED" || /could not allocate|out of memory|Cannot enlarge memory|Array buffer allocation failed|RangeError: .*memory/i.test(message)) return "oom";
  // A body that ended before the bytes it announced (Content-Length, or the
  // index's transfer size) is a transfer failure, whatever the decoder then
  // said about the short input ("Compressed input was truncated."): the
  // snapshot workers name it so (HARDENING #63). Before the corrupt rule, whose
  // "truncated" and "expected N bytes" would otherwise claim it.
  if (TRANSFER_ENDED_EARLY.test(message)) return "network";
  if (/SHA-256 verification|sha256|digest mismatch|checksum|integrity|bad magic|magic|not a compacted-region|index declares|raw size mismatch|compressed data was not valid|Junk found|truncated|short (?:read|region)|unexpected end|incorrect header check|invalid (?:block|stored|distance|code|literal)|gzip|inflate|corrupt|expected \d+ bytes|bytes, expected|empty (?:body|snapshot source)/i.test(message)) return "corrupt";
  if (code === "RUNTIME_FETCH_FAILED" || /\bHTTP \d{3}\b|Failed to fetch|NetworkError|network error|fetch failed|net::ERR_|ERR_NETWORK|ERR_CONNECTION|connection (?:reset|closed|refused)|socket hang up|terminated|The operation was aborted|body stream/i.test(message)) return "network";
  if (/QuotaExceeded|quota|NoModificationAllowed|NotReadableError|getDirectory|createWritable|createSyncAccessHandle|OPFS/i.test(message)) return "storage";
  return "other";
}

/** The snapshot workers' words for a body that ended short of the bytes it
 * announced (snapshot-prefetch.worker.js and lean.worker.js loadSnapshot):
 * "the transfer of <file> ended early: received <n> of <expected> bytes". */
export const TRANSFER_ENDED_EARLY = /\bthe transfer of .+ ended early\b/;

/** lean.worker.js refused a sibling script of another revision (docs/EMBEDDING.md
 * §7.7): the deployed worker scripts changed under this page. Its cause is
 * `stale`: the relay's replacement worker loads the new scripts and usually
 * serves again, but under this page's older bundle — reload the page. */
export const WORKER_DEP_MISMATCH = "WORKER_DEP_MISMATCH";
/** The refusal's own words (lean.worker.js checkSibling), for the same throw's
 * uncaught error event, which carries the message but no code. */
const STALE_MESSAGE = /\ba deploy mixed versions\b/;

/** The HTTP status a worker or page message names ("HTTP 404"), if any. */
export function httpStatusOf(message: string): number | undefined {
  const m = /\bHTTP (\d{3})\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/** A FailureCause from a thrown value: its own `cause` when a page step
 * already classified it, else classified from its worker error `code` and
 * message (the worker's messages name the HTTP status, the allocation, the
 * runtime pairing and the chunk verification, so the page classifies — the
 * same table for every worker version). A `stale` cause's code is always
 * WORKER_DEP_MISMATCH, whatever code the thrown value carried. */
export function failureCauseOf(err: unknown, at: { stage?: BootStage; subject?: string } = {}): FailureCause {
  const e = err as { message?: unknown; code?: unknown; cause?: unknown } | null;
  const own = (e?.cause ?? null) as Partial<FailureCause> | null;
  if (own && typeof own === "object" && typeof own.kind === "string") {
    return { ...at, ...own, kind: own.kind as FailureKind, ...(own.kind === "stale" ? { code: WORKER_DEP_MISMATCH } : {}), message: String(own.message ?? e?.message ?? err) };
  }
  const message = String(e?.message ?? err);
  const code = typeof e?.code === "string" ? e.code : undefined;
  const httpStatus = httpStatusOf(message);
  const kind = failureKindOf(code, message);
  // A stale cause always carries WORKER_DEP_MISMATCH (§7.2), as deathCause's
  // does: the refusal's words can reach the page under WORKER_CRASHED or no code.
  const causeCode = kind === "stale" ? WORKER_DEP_MISMATCH : code;
  return { kind, ...at, ...(causeCode ? { code: causeCode } : {}), ...(httpStatus ? { httpStatus } : {}), message };
}

/** The script-load code: the worker (or a script it imports) never ran. It
 * looks the same offline as on a 404, so it means "probe the link", not "our
 * own crash" — the one `other` an embedder should not read as the checker's. */
export const WORKER_SCRIPT_LOAD_FAILED = "WORKER_SCRIPT_LOAD_FAILED";

/** The cause of a session death (LeanSession.onDied's facts, docs/EMBEDDING.md
 * §7.2): null only for a bare worker error event (no evidence); a sibling
 * script of another revision is `stale` (WORKER_DEP_MISMATCH, by its code or,
 * on the uncaught error event of the same refusal, by its words); a worker
 * that never said hello, or could not import a script, is
 * WORKER_SCRIPT_LOAD_FAILED; an error code is classified by the table; every
 * other death is the checker's own (`other`, or `oom` when its message says so). */
export function deathCause(reason: string, message: string, facts: { beforeHello?: boolean; bare?: boolean; errorCode?: string } = {}, at: { stage?: BootStage; subject?: string } = {}): FailureCause | null {
  if (reason === "crash" && facts.bare && !facts.beforeHello) return null;
  if (facts.errorCode === WORKER_DEP_MISMATCH || STALE_MESSAGE.test(message)) return { kind: "stale", ...at, code: WORKER_DEP_MISMATCH, message };
  if ((reason === "crash" && facts.beforeHello) || facts.errorCode === "WORKER_DEP_MISSING") {
    return { kind: "other", ...at, code: WORKER_SCRIPT_LOAD_FAILED, message: message || "the worker script did not load" };
  }
  if (facts.errorCode) return failureCauseOf(Object.assign(new Error(message), { code: facts.errorCode }), at);
  const kind = failureKindOf(undefined, message) === "oom" ? "oom" : "other";
  return { kind, ...at, code: reason, message };
}

/** The worker's own progress phases (lean.worker.js `progress(…)`) as stages. */
export function stageOfWorkerPhase(phase: string): { stage: BootStage; step?: BootStep } {
  switch (phase) {
    case "runtime": case "initialize": case "filesystem": return { stage: "runtime", step: phase === "runtime" ? "verify" : "init" };
    case "memory": return { stage: "memory" };
    case "snapshot-cache": return { stage: "snapshot", step: "read" };
    case "snapshot": return { stage: "snapshot", step: "download" };
    case "snapshot-load": return { stage: "snapshot", step: "load" };
    case "snapshot-init": case "import": return { stage: "modules", step: "init" };
    default: return { stage: "runtime" };
  }
}

/** profiles.ts install phases as steps. */
export const stepOfInstallPhase = (phase: string): BootStep =>
  phase === "cached" ? "check" : phase === "download" ? "download" : phase === "inflate" ? "inflate" : "commit";
