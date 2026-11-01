// Types for fs-reads.mjs so unit tests (root tsconfig, strict) can pin the
// in-worker wrapper and the pure summary without allowJs.
/** One lean.worker's record: `paths` maps `<op>-hit|miss <path>` (op: open, write, stat, readdir) to a call count. */
export type FsReadsRecord = {
  id: string; installedAt: number | null; leanPath: string | null;
  paths: Record<string, number>; distinct: number; overflow: number; errors: number;
};
export type FsReadsSample = { op: string; path: string; n: number };
export type FsReadsSession = {
  workers: number; overflow: number;
  library: { hits: number; misses: number; writes: number; distinct: number; sample: FsReadsSample[] };
  libOther: { total: number; sample: FsReadsSample[] };
  outside: { total: number; sample: FsReadsSample[] };
};
export type FsReadsSummary = {
  workers: number; blind: number; sessions: Record<string, FsReadsSession>;
  overflow: number; errors: number; installFailures: number;
};
export type FsReads = {
  attach(page: unknown): void;
  poll(): Promise<void>;
  finish(): Promise<FsReadsSummary>;
  stop(): void;
};
export const LEAN_WORKER_RE: RegExp;
export const LIBRARY_FILE_RE: RegExp;
export function normalizeFsPath(p: string): string;
/** Classifies the normalized path: `/bin/../lib/lean/Init.olean` is a library file. */
export function classifyFsPath(p: string): "library" | "lib-other" | "outside";
/** Runs inside a lean.worker (serialized by Playwright); the record's id, or null if it could not install. */
export function installInWorker(): string | null;
export function summarizeFsReads(records: FsReadsRecord[], opts?: { installFailures?: number }): FsReadsSummary;
export function createFsReads(opts?: { pollMs?: number; evalTimeoutMs?: number }): FsReads;
