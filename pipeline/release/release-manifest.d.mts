// Types for release-manifest.mjs so the unit tests (root tsconfig, strict)
// can import the real generator without allowJs.
export const SCHEMA: "qed64.release/v1";
export const QED64_REPO: string;
export const KERNEL_REPO: string;
export const KERNEL_BRANCH: string;
export const RECORD_SCHEMA: "lean4-wasm64.release/v1";
export const BASE_TREE_SCHEMA: "qed64.base-tree/v1";
export const HOSTING_RULE: string;
/** The shell's identity file in a built dist/ (frontend/build/build-info.mjs). */
export const BUILD_INFO_FILE: "qed64-build.json";
export const INPUTS: Readonly<{
  toolchainRecord: string;
  baseTree: string;
  runtimeManifest: string;
  snapshotIndex: string;
  profileIndex: string;
  workers: string;
}>;

export class ReleaseRefusal extends Error {}

export interface ReleaseSource {
  kind: "commit" | "worktree";
  label: string;
  /** Bytes of a repo-relative path, or null when absent. */
  read(repoPath: string): Buffer | null;
  /** Files under a repo-relative directory, relative to it, byte-ordered. */
  list(repoDir: string): string[];
  /** `inputs`: every repo path read as an input, with its bytes; `listed`: the directories read as a whole. */
  describe(inputs: Map<string, Buffer>, listed?: ReadonlySet<string>): { commit: string; committedAt: string; dirty: boolean };
}

export interface TrackedFile { path: string; sha256: string; gitBlob: string }
export interface BaseTreePack { id: string; release: string | null; rawSha256: string }
export interface UmbrellaFile { path: string; sha256: string; bytes: number }
export interface BaseTreeSection extends TrackedFile {
  schema: "qed64.base-tree/v1";
  releaseId: string;
  /** The record's digest and runtime when releaseId is the record's id; null for another release (the record cannot vouch for them). */
  releaseDigest: string | null;
  runtime: string | null;
  packs: BaseTreePack[];
  slim: boolean;
  umbrella: UmbrellaFile[];
  umbrellaSource: string | null;
  initLib: string | null;
  digestRule: string | null;
  trees: Record<string, { slim: boolean; packs: BaseTreePack[]; umbrella: UmbrellaFile[]; files: number; bytes: number; digest: string }>;
  /** The union of every umbrella file the trees carry: what a bundle ships at umbrella/<path>. */
  umbrellaFiles: UmbrellaFile[];
}
export interface ReleaseManifest {
  schema: "qed64.release/v1";
  digest: string;
  releaseId: string;
  artifactSetId: string;
  qed64: { repo: string; commit: string; committedAt: string; source: "commit" | "worktree"; dirty: boolean };
  lean: { version: string; target: string };
  kernel: { repo: string; branch: string; commit: string; sourceRevision: string };
  toolchain: {
    releaseId: string;
    digest: string;
    record: TrackedFile;
    kernel: { commit: string; patch: string };
    runtimeBuildId: string;
    packs: { id: string; rawSha256: string }[];
    tools: { package: string; version: string; tgz: string };
  };
  hosting: { toolchainPrefix: string; siteOwned: string[]; rule: string };
  baseTree: BaseTreeSection;
  runtime: {
    buildId: string;
    manifest: TrackedFile & { pinnedPath: string };
    files: { name: string; bytes: number; sha256: string; chunks: { path: string; bytes: number; sha256: string }[] }[];
  };
  snapshots: {
    index: TrackedFile;
    entries: { name: string; path: string; sha256: string; transferBytes: number; rawBytes: number; imports: string[]; runtime: string }[];
  };
  profiles: {
    index: TrackedFile;
    packs: {
      id: string;
      release: string;
      modules: number;
      manifest: TrackedFile & { contentDigest: string };
      lean: { version: string; gitRevision: string | null };
      pack: { sha256: string; bytes: number };
      transport: { sha256: string; bytes: number; parts: { path: string; sha256: string; bytes: number }[] };
    }[];
  };
  shell: null | {
    shellId: string;
    listingSha256: string;
    bytes: number;
    apiRevision: string | null;
    embedApiRevision: string | null;
    bundle: { entries: string[]; buildIds: string[] };
    files: { path: string; sha256: string; bytes: number }[];
  };
}

export function sha256Hex(bytes: Uint8Array | string): string;
export function gitBlobId(bytes: Uint8Array): string;
export function commitSource(rev: string, options?: { repo?: string }): ReleaseSource;
export function treeSource(options?: { publicDir?: string; toolchainRecord?: string; baseTree?: string; repo?: string }): ReleaseSource;
/** lean4-wasm64's releaseDigest: "sha256:" + sha256(JSON.stringify(record without digest, null, 2)). */
export function recordDigest(record: Record<string, unknown>): string;
/** The validated record plus `siteOwned(path)` / `toolchainHosted(path)` for origin-relative paths; throws ReleaseRefusal. */
export function toolchainRecordOf(record: unknown): Record<string, any> & { siteOwned(path: string): boolean; toolchainHosted(path: string): boolean };
export function baseTreeOf(baseTree: unknown, context: { record: ReturnType<typeof toolchainRecordOf>; packs: ReleaseManifest["profiles"]["packs"]; tracked: TrackedFile }): BaseTreeSection;
export function buildReleaseManifest(source: ReleaseSource, options?: { dist?: string | null }): ReleaseManifest;
export function shellSection(distDir: string, options: { source: ReleaseSource; buildId: string; inputs?: Map<string, Buffer>; listed?: Set<string> }): NonNullable<ReleaseManifest["shell"]>;
export function listingOf(files: { path: string; sha256: string }[]): string;
export function manifestDigest(manifest: object): string;
export function artifactSetIdOf(manifest: Pick<ReleaseManifest, "runtime" | "snapshots" | "profiles">): string;
export function serializeManifest(manifest: ReleaseManifest): string;
export function parseArgs(argv: string[]): Record<string, string | boolean>;
export function main(argv: string[]): number;
