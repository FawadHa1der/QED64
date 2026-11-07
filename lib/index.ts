// `qed64/embed` — the library entry point for embedders that build their own
// page on the QED64 runtime (docs/EMBEDDING.md §6–§8). The contract is every
// value export of this module that docs/EMBEDDING.md §7.0 names and every type
// those exports' signatures use; a re-export marked `@internal` is outside
// it, and a path not reachable from this module (or listed in
// embedding/closure.json) is internal (§9).
// tests/unit/embed-barrel.test.ts checks that §7 names every other value
// export.
//
// Closure rule (tests/unit/package-contract.test.ts): this module and
// everything it reaches import only relative paths — no bare specifiers, no
// `node:` — so a consumer's bundler needs nothing but the files listed in the
// closure.
//
// A re-export marked `@internal` stays exported but is not part of the
// contract: it may change or leave in any revision (docs/EMBEDDING.md §7.0, §9).

/** Semver of the library contract (docs/EMBEDDING.md §1, §7), final since 1.0.0:
 * minor = additive; a break is the next major, with a migration note in §12. */
export const EMBED_API_REVISION = "1.2.0";

// runtime
export { LeanSession, MEMORY64_PROBE, probeMemory64 } from "./client";
export type {
  BootConfig, Capabilities, DeathFacts, HeaderStatus, JsonRpcMessage, LibraryPack, MemoryTelemetry,
  ProgressEvent, ReadyInfo, RuntimeManifest, WorkerError, WorkerPhase, WorkerStatus,
} from "./client";

// snapshots
export {
  loadSnapshotIndex, snapshotCacheKey,
  BASE_SNAPSHOTS, chooseSnapshots, coversModule, entryLabel, initialBytesForEntries, widenTarget,
} from "./snapshots";
/** @internal */
export { LEGACY_UMBRELLA_ROOTS } from "./snapshots";
export type { IndexOptions, SnapshotEntry, SnapshotIndex } from "./snapshots";

// boot
export { installArtifacts, loadSnapshotByName, resolveRuntimeManifest, fetchSnapshotIndexFor } from "./qed64-boot";
export type { InstallOptions, LoadSnapshotOptions, ProgressInfo, Qed64Artifacts, Qed64Session, StatusSink } from "./qed64-boot";

// the raw snapshot region cache (docs/EMBEDDING.md §7.4)
export { PREFETCH_SILENCE_MS, SNAPSHOT_CACHE_DIR, isCacheKeyOf, isRawCached, prefetchRaw, removeRawRegion } from "./raw-cache";
export type { PrefetchRawOptions, PrefetchRawResult } from "./raw-cache";

// structured progress and failure causes (docs/EMBEDDING.md §7.1, §7.2)
export { deathCause, failureCauseOf, ENGINE_STACK_OVERFLOW, WORKER_SCRIPT_LOAD_FAILED } from "./failure";
export type { BootStage, BootStep, FailureCause, FailureKind } from "./failure";

// offline URL list (docs/EMBEDDING.md §7.5)
export { runtimeUrls, WORKER_URLS } from "./urls";

// boot parameters (docs/EMBEDDING.md §4, §7.6)
export { BootParamError, validateBootOverrides } from "./params";
export type { BootOverrides } from "./params";

// session
export { DEFAULT_MAXIMUM_BYTES, ResidentSession, importedModulesOf, makeEditorPolicy } from "./resident-session";
export type { ResidentHost, ResidentPolicy, SessionFile } from "./resident-session";

// relay
export { LspRelay } from "./lsp-relay";
export type { Death, RelaySession, RelayState, RelayStatus, RestartOptions } from "./lsp-relay";

// Lean's engine-stack guard errors: recognise them and append QED64's note (docs/EMBEDDING.md §7.10)
export { STACK_LIMIT_NOTE, annotateStackLimit, isStackLimitDiagnostic } from "./stack-limit";
export type { StackLimitDiagnostic } from "./stack-limit";
