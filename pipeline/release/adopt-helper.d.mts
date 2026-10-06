// Types for adopt-helper.mjs (adopt-release.sh's JSON and tree work), so the
// unit tests (root tsconfig, strict) can import it.
export const RELEASE_SCHEMA: "lean4-wasm64.release/v1";
export const BASE_TREE_SCHEMA: "qed64.base-tree/v1";
/** How treeDigest is computed, in words (recorded in base-tree.json). */
export const TREE_DIGEST_RULE: string;
/** lean4-wasm64 releaseDigest: "sha256:" + sha256(JSON.stringify(record without digest, null, 2)). */
export function releaseDigest(record: Record<string, unknown>): string;
/** Streamed sha256 (hex) of one file. */
export function sha256File(file: string): string;
/** sha256 over the sorted "<relpath>\0<sha256>\n" lines of every file under `dir`; throws on a symlink. */
export function treeDigest(dir: string): { digest: string; files: number; bytes: number };
