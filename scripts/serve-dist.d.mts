// Types for scripts/serve-dist.mjs, so tests/unit/serve-dist.test.ts (root
// tsconfig, strict) can import it without allowJs.
import type { Server } from "node:http";
import type { ArtifactBucket, AssetsFetcher } from "../infra/edge-worker.js";

export type EdgeMode = "legacy" | "hardened";

export const DEFAULT_PORT: number;
export const DEFAULT_DIST: string;
export const DEFAULT_PUBLIC: string;
export const USAGE: string;
export const EDGE_MODES: Readonly<Record<EdgeMode, () => { fetch(request: Request, env: unknown, ctx?: unknown): Promise<Response> }>>;
/** Content-Type by extension for dist/ files, as Workers static assets send them. */
export const ASSET_MIME: Readonly<Record<string, string>>;
/** Content-Type by extension for public/ artifacts, as rclone stores them in R2 (else application/octet-stream). */
export const ARTIFACT_MIME: Readonly<Record<string, string>>;

/** The ASSETS binding (Workers static assets subset) over `dist`. */
export function createAssetsBinding(dist: string): AssetsFetcher;
/** The ARTIFACTS binding (an R2 bucket, structurally) over `publicDir`. */
export function createArtifactsBinding(publicDir: string): ArtifactBucket;

/** An http.Server, not listening, that answers through infra/worker.js (legacy) or createWorker({}) (hardened). */
export function createDistServer(options?: { dist?: string; publicDir?: string; edge?: EdgeMode }): Server;

/** `prod preview: http://localhost:<port> (<dist> + public artifacts) edge=<mode>` */
export function startupLine(port: number, dist: string, edge: EdgeMode): string;
