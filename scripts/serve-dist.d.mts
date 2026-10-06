// Types for scripts/serve-dist.mjs, so tests/unit/serve-dist.test.ts (root
// tsconfig, strict) can import it without allowJs.
import type { Server } from "node:http";
import type { ArtifactBucket, AssetsFetcher } from "../infra/edge-worker.js";

export type EdgeMode = "legacy" | "hardened";

export const DEFAULT_PORT: number;
export const DEFAULT_DIST: string;
export const DEFAULT_PUBLIC: string;
export const USAGE: string;
/** The release id infra/worker.js routes /runtime/* and /profiles/<not index.json> to (toolchain/lean4-wasm64-release.json). */
export const RELEASE_ID: string;
export const EDGE_MODES: Readonly<Record<EdgeMode, () => { fetch(request: Request, env: unknown, ctx?: unknown): Promise<Response> }>>;
/** Content-Type by extension for dist/ files, as Workers static assets send them. */
export const ASSET_MIME: Readonly<Record<string, string>>;
/** Content-Type by extension for public/ artifacts, as rclone stores them in R2 (else application/octet-stream). */
export const ARTIFACT_MIME: Readonly<Record<string, string>>;

/** The ASSETS binding (Workers static assets subset) over `dist`. */
export function createAssetsBinding(dist: string): AssetsFetcher;
/** Why `dir` is not a served-layout release directory of release `id` (default RELEASE_ID), or null. */
export function releaseDirProblem(dir: string, id?: string): string | null;
/** The ARTIFACTS binding (an R2 bucket, structurally) over `publicDir`; `lean4-wasm64/<releaseId>/<rest>`
 * keys read `releaseDir/<rest>` when given, else `publicDir/<rest>`. Read-only. */
export function createArtifactsBinding(publicDir: string, options?: { releaseDir?: string | null; releaseId?: string }): ArtifactBucket;

/** An http.Server, not listening, that answers through infra/worker.js (legacy) or createWorker({}) (hardened).
 * A `releaseDir` that is not a served-layout release dir of RELEASE_ID throws. */
export function createDistServer(options?: { dist?: string; publicDir?: string; edge?: EdgeMode; releaseDir?: string | null }): Server;

/** `prod preview: http://localhost:<port> (<dist> + public artifacts) edge=<mode> release=<id>[ releaseDir=<dir>]` */
export function startupLine(port: number, dist: string, edge: EdgeMode, releaseDir?: string | null, releaseId?: string): string;
