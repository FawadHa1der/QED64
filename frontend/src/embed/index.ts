// `qed64/embed` — the library entry point for embedders that build their own
// page on the QED64 runtime (docs/EMBEDDING.md §6–§7). Everything an embedder
// may import is re-exported here, so the internal file layout can move without
// breaking anyone; a path not reachable from this module (or listed in
// embedding/closure.json) is internal.
//
// Closure rule (tests/unit/package-contract.test.ts): this module and
// everything it reaches import only relative paths — no bare specifiers, no
// `node:` — so a consumer's bundler needs nothing but the files listed in the
// closure.
//
// `@internal` re-exports stay exported (the stock page's own modules and the
// unit tests reach them through their files; an embedder that imported one
// keeps building) but are not part of the contract: no consumer uses them,
// and they may change or leave in any revision (docs/EMBEDDING.md §7.0, §9).

/** Semver of the library contract (docs/EMBEDDING.md §7): minor = additive.
 * "-pre" until the contract's review is settled. */
export const EMBED_API_REVISION = "1.0.0-pre.6";

// runtime
export { LeanSession, PROTOCOL, MEMORY64_PROBE, probeMemory64 } from "../../../src/runtime/client";
/** @internal */
export { memoryCandidates } from "../../../src/runtime/client";
export type {
  BootConfig, Capabilities, CompileResult, DeathFacts, Diagnostic, HeaderStatus, JsonRpcMessage, LibraryPack, MemoryTelemetry,
  ProgressEvent, ReadyInfo, RuntimeManifest, WorkerError, WorkerPhase, WorkerStatus,
} from "../../../src/runtime/client";

// snapshots
export {
  fetchSnapshotIndex, loadSnapshotIndex, snapshotCacheKey,
  BASE_SNAPSHOTS, LEGACY_UMBRELLA_ROOTS, chooseSnapshots, coversModule, entryLabel, entryRoots, initialBytesForEntries, widenTarget,
} from "../../../src/runtime/snapshots";
export type { IndexOptions, SnapshotEntry, SnapshotIndex } from "../../../src/runtime/snapshots";

// profiles (library packs)
/** @internal */
export { fetchProfileIndex, installProfile } from "../../../src/install/profiles";
export type { InstallProgress, InstalledProfile, ProfileIndex, ProfileIndexEntry, ProfileManifest } from "../../../src/install/profiles";

// boot
export { installArtifacts, loadSnapshotByName, resolveRuntimeManifest, fetchSnapshotIndexFor } from "../qed64-boot";
/** @internal */
export { ensureProfile, overridesOf } from "../qed64-boot";
export type { InstallOptions, LoadSnapshotOptions, ProgressInfo, Qed64Artifacts, Qed64Session, StatusSink } from "../qed64-boot";

// the raw snapshot region cache (docs/EMBEDDING.md §7.4)
export { PREFETCH_SILENCE_MS, SNAPSHOT_CACHE_DIR, isCacheKeyOf, isRawCached, prefetchRaw, removeRawRegion } from "./raw-cache";
/** @internal */
export { rawRegionName } from "./raw-cache";
export type { PrefetchRawOptions, PrefetchRawResult } from "./raw-cache";

// structured progress and failure causes (docs/EMBEDDING.md §7.1, §7.2)
export { deathCause, failureCauseOf, WORKER_DEP_MISMATCH, WORKER_SCRIPT_LOAD_FAILED } from "./failure";
/** @internal */
export { failureKindOf, httpStatusOf } from "./failure";
export type { BootStage, BootStep, FailureCause, FailureKind } from "./failure";

// offline URL list (docs/EMBEDDING.md §7.5)
export { runtimeUrls, WORKER_URLS } from "./urls";

// boot parameters (docs/EMBEDDING.md §4, §7.6)
export { BootParamError, validateBootOverrides } from "./params";
/** @internal */
export { NO_OVERRIDES, parseBootParams } from "./params";
export type { BootOverrides } from "./params";

// session
export {
  DEFAULT_MAXIMUM_BYTES, EDITOR_POLICY, ResidentSession, makeEditorPolicy,
  importLinesOf, importedModulesOf, initialBytesForHeader, initialBytesForSnapshots, isUmbrellaModule, needsMathlib, snapshotsForHeader,
} from "../resident-session";
export type { ResidentHost, ResidentPolicy, SessionFile } from "../resident-session";

// relay
export { LspRelay } from "../lsp-relay";
/** @internal */
export { isImport } from "../lsp-relay";
export type { Death, RelaySession, RelayState, RelayStatus, RestartOptions } from "../lsp-relay";
