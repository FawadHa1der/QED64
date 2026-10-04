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

/** Semver of the library contract (docs/EMBEDDING.md §7): minor = additive.
 * "-pre" until the contract's review is settled. */
export const EMBED_API_REVISION = "1.0.0-pre.2";

// runtime
export { LeanSession, PROTOCOL, probeMemory64, memoryCandidates } from "../../../src/runtime/client";
export type {
  BootConfig, Capabilities, CompileResult, Diagnostic, HeaderStatus, JsonRpcMessage, LibraryPack, MemoryTelemetry,
  ProgressEvent, ReadyInfo, RuntimeManifest, WorkerError, WorkerPhase, WorkerStatus,
} from "../../../src/runtime/client";

// snapshots
export { fetchSnapshotIndex, loadSnapshotIndex, snapshotCacheKey } from "../../../src/runtime/snapshots";
export type { SnapshotEntry, SnapshotIndex } from "../../../src/runtime/snapshots";

// profiles (library packs)
export { fetchProfileIndex, installProfile, storageEstimate } from "../../../src/install/profiles";
export type { InstallProgress, InstalledProfile, ProfileIndex, ProfileIndexEntry, ProfileManifest } from "../../../src/install/profiles";

// boot
export { installArtifacts, ensureProfile, loadSnapshotByName, prefetchRaw, PREFETCH_SILENCE_MS } from "../qed64-boot";
export type { InstallOptions, PrefetchRawOptions, PrefetchRawResult, ProgressInfo, Qed64Artifacts, Qed64Session, StatusSink } from "../qed64-boot";

// structured progress and failure causes (docs/EMBEDDING.md §7.1, §7.2)
export { failureCauseOf, failureKindOf } from "./failure";
export type { BootStage, BootStep, FailureCause, FailureKind } from "./failure";

// offline URL list (docs/EMBEDDING.md §7.5)
export { runtimeUrls, WORKER_URLS } from "./urls";

// boot parameters (docs/EMBEDDING.md §4, §7.6)
export { BootParamError, NO_OVERRIDES, parseBootParams, validateBootOverrides } from "./params";
export type { BootOverrides } from "./params";

// session
export {
  DEFAULT_MAXIMUM_BYTES, EDITOR_POLICY, ResidentSession, UMBRELLA_ROOTS,
  importLinesOf, importedModulesOf, initialBytesForHeader, initialBytesForSnapshots, isUmbrellaModule, needsMathlib, snapshotsForHeader,
} from "../resident-session";
export type { ResidentHost, ResidentPolicy, SessionFile } from "../resident-session";

// relay
export { LspRelay, isImport } from "../lsp-relay";
export type { Death, RelaySession, RelayState, RelayStatus, RestartOptions } from "../lsp-relay";
