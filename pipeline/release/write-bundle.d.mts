// Types for write-bundle.mjs so the unit tests (root tsconfig, strict) can
// import the real writer without allowJs.
import type { ReleaseManifest, ReleaseSource } from "./release-manifest.mjs";

export const USAGE: string;
export const BUNDLE_FILES: Readonly<{ release: string; shell: string; manifests: string; umbrellaDir: string; sums: string }>;
/** A ustar archive: entries byte-ordered by name, directories included, mtime `mtime`, uid/gid 0, modes 0644/0755. */
export function tarOf(files: Map<string, Buffer>, mtime: number): Buffer;
/** node:zlib gzip, level 9, with the header's mtime 0 and OS byte 0x03. */
export function gzipPinned(bytes: Uint8Array): Buffer;
/** The bundle in memory (bundle path → bytes, SHA256SUMS included); throws ReleaseRefusal. */
export function buildBundle(source: ReleaseSource, options: { dist: string; umbrella: string }): { manifest: ReleaseManifest; files: Map<string, Buffer> };
/** Write `files` atomically into `out` (absent or an empty directory); returns the absolute path. */
export function writeBundleDir(files: Map<string, Buffer>, out: string): string;
export function parseArgs(argv: string[]): Record<string, string>;
export function main(argv: string[]): number;
