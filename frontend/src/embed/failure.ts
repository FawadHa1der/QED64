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

export type FailureKind = "network" | "corrupt" | "unpaired" | "oom" | "storage" | "other";
export interface FailureCause {
  kind: FailureKind;
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
  if (code === "SNAPSHOT_UNPAIRED" || /was baked for runtime/.test(message)) return "unpaired";
  if (code === "MEMORY_FAILED" || /could not allocate|out of memory|Cannot enlarge memory|Array buffer allocation failed|RangeError: .*memory/i.test(message)) return "oom";
  if (/SHA-256 verification|sha256|digest mismatch|checksum|integrity|bad magic|magic|truncated|short (?:read|region)|unexpected end|incorrect header check|invalid (?:block|stored|distance|code|literal)|gzip|inflate|corrupt|expected \d+ bytes|bytes, expected/i.test(message)) return "corrupt";
  if (code === "RUNTIME_FETCH_FAILED" || /\bHTTP \d{3}\b|Failed to fetch|NetworkError|network error|fetch failed|net::ERR_|ERR_NETWORK|ERR_CONNECTION|connection (?:reset|closed|refused)|socket hang up|terminated|The operation was aborted|body stream/i.test(message)) return "network";
  if (/QuotaExceeded|quota|NoModificationAllowed|NotReadableError|getDirectory|createWritable|OPFS|storage/i.test(message)) return "storage";
  return "other";
}

/** A FailureCause from a thrown value: its own `cause` when a page step
 * already classified it, else classified from its worker error `code` and
 * message (the worker's messages name the HTTP status, the allocation, the
 * runtime pairing and the chunk verification, so the page classifies — the
 * same table for every worker version). */
export function failureCauseOf(err: unknown, at: { stage?: BootStage; subject?: string } = {}): FailureCause {
  const e = err as { message?: unknown; code?: unknown; cause?: unknown } | null;
  const own = (e?.cause ?? null) as Partial<FailureCause> | null;
  if (own && typeof own === "object" && typeof own.kind === "string") {
    return { ...at, ...own, kind: own.kind as FailureKind, message: String(own.message ?? e?.message ?? err) };
  }
  const message = String(e?.message ?? err);
  const code = typeof e?.code === "string" ? e.code : undefined;
  return { kind: failureKindOf(code, message), ...at, ...(code ? { code } : {}), message };
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
