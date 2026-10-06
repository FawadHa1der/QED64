// Types for fetch-artifacts.mjs (docs/CLI-CONTRACT.md "fetch-artifacts"), so
// the unit tests (root tsconfig, strict) and TypeScript callers can import it.
export type ArtifactGroup = "runtime" | "profiles" | "snapshots";
export const DEFAULT_ORIGIN: string;
export const GROUPS: ArtifactGroup[];
export const RELEASE_SCHEMA: "lean4-wasm64.release/v1";

/** A failure with its exit code: 1 = the job ran and failed, 2 = refused before any write, 130/143 = interrupted (SIGINT/SIGTERM). */
export class FetchFailure extends Error {
  constructor(message: string, code?: 1 | 2 | 130 | 143);
  code: 1 | 2 | 130 | 143;
}

/** A failure reason on one line (newlines and the space around them become one space). */
export function oneLine(message: unknown): string;
/** Delete the temp files (`.<name>.<pid>-<8 hex>.tmp`) a dead process left in `dir` for the target basenames `names`. */
export function sweepStaleTemps(dir: string, names: Set<string>): Promise<{ file: string; pid: number }[]>;

export interface PlannedFile { group: ArtifactGroup; rel: string; bytes: number; sha256: string }
export interface ArtifactPlan {
  items: PlannedFile[];
  wholes: { label: string; rels: string[]; bytes: number; sha256: string }[];
  copies: { group: ArtifactGroup; rel: string; data: Uint8Array; from: string }[];
  manifests: { group: ArtifactGroup; rel: string; data: Uint8Array }[];
  buildId: string | null;
}

export function sitePath(group: ArtifactGroup, url: unknown, where: string): string;
export function planFromManifests(manifests: string, groups: ArtifactGroup[]): Promise<ArtifactPlan>;
export function parseOnly(value: string | undefined): ArtifactGroup[] | null;

export interface FetchOptions {
  out: string;
  manifests: string;
  only?: ArtifactGroup[];
  release?: string;
  origin?: string;
  withManifests?: boolean;
  concurrency?: number;
  log?: (line: string) => void;
  /** Aborting stops the run (its temp files deleted); it rejects with the reason when that is a FetchFailure. */
  signal?: AbortSignal;
}
export interface FetchStats { files: number; bytes: number; fetched: number; present: number }
export function fetchArtifacts(opts: FetchOptions): Promise<FetchStats>;

/**
 * The CLI: resolves to the exit code; `io` captures its stdout and stderr lines.
 * `repoRoot` is the checkout whose public/ the defaults name; `handleSignals`
 * (the process entry point) turns SIGINT/SIGTERM into a clean stop: temp
 * files deleted, `FETCH FAILED interrupted (<signal>)`, 130/143.
 */
export function main(
  argv?: string[],
  io?: { out(s: string): void; err(s: string): void },
  opts?: { repoRoot?: string; handleSignals?: boolean },
): Promise<number>;
