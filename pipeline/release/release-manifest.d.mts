// Types for release-manifest.mjs so the unit tests (root tsconfig, strict)
// can import the real generator without allowJs.
export const SCHEMA: "qed64.release/v1";
export const QED64_REPO: string;
export const KERNEL_REPO: string;
export const KERNEL_BRANCH: string;
export const INPUTS: Readonly<{
  kernelPin: string;
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
export interface ReleaseManifest {
  schema: "qed64.release/v1";
  digest: string;
  releaseId: string;
  artifactSetId: string;
  qed64: { repo: string; commit: string; committedAt: string; source: "commit" | "worktree"; dirty: boolean };
  lean: { version: string; target: string };
  kernel: { repo: string; branch: string; commit: string; sourceRevision: string };
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
    bundle: { entries: string[]; buildIds: string[] };
    files: { path: string; sha256: string; bytes: number }[];
  };
}

export function sha256Hex(bytes: Uint8Array | string): string;
export function gitBlobId(bytes: Uint8Array): string;
export function commitSource(rev: string, options?: { repo?: string }): ReleaseSource;
export function treeSource(options?: { publicDir?: string; kernelPin?: string; repo?: string }): ReleaseSource;
export function buildReleaseManifest(source: ReleaseSource, options?: { dist?: string | null }): ReleaseManifest;
export function shellSection(distDir: string, options: { source: ReleaseSource; buildId: string; inputs?: Map<string, Buffer>; listed?: Set<string> }): NonNullable<ReleaseManifest["shell"]>;
export function listingOf(files: { path: string; sha256: string }[]): string;
export function manifestDigest(manifest: object): string;
export function artifactSetIdOf(manifest: Pick<ReleaseManifest, "runtime" | "snapshots" | "profiles">): string;
export function serializeManifest(manifest: ReleaseManifest): string;
export function parseArgs(argv: string[]): Record<string, string | boolean>;
export function main(argv: string[]): number;
