// Types for scripts/deploy-guard.mjs, so tests/unit/deploy-guard.test.ts (root
// tsconfig, strict) can import it without allowJs.

/** fetch-artifacts' DEFAULT_ORIGIN, the live site: the one place it is written. */
export const DEFAULT_ORIGIN: string;
/** <repo>/public/snapshots/index.json, the tracked snapshot index. */
export const DEFAULT_INDEX: string;
/** `usage: [QED64_DEPLOY_ORIGIN=<url>|none] node scripts/deploy-guard.mjs [--index <file>] [--origin <url>]` */
export const USAGE: string;

/** The index or the origin cannot be checked as given. */
export class Refusal extends Error {}

export interface SnapshotEntry {
  name: string;
  /** `/snapshots/<name>.snapz`, directly under /snapshots/. */
  url: string;
  /** transfer ?? bytes: the stored object's size. */
  size: number;
}

/** The .snapz entries of a qed64.snapshot-index/v1 file, in index order. Throws a Refusal. */
export function entriesOf(indexFile: string): SnapshotEntry[];

export interface CheckOptions {
  index?: string;
  origin?: string;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<unknown>;
}

/** HEAD every entry on the origin, stopping at the first refusal; each line starts `deploy-guard: `. Never rejects. */
export function checkLiveSnapshots(options?: CheckOptions): Promise<{ ok: boolean; lines: string[] }>;

export interface GuardIo {
  out?: (line: string) => void;
  err?: (line: string) => void;
  fetchImpl?: CheckOptions["fetchImpl"];
  sleep?: CheckOptions["sleep"];
}

/** The CLI: 0 live (or skipped), 1 refused, 2 a bad argument. */
export function main(argv?: string[], env?: Record<string, string | undefined>, io?: GuardIo): Promise<0 | 1 | 2>;
