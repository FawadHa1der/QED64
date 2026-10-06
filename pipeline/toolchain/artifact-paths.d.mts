// Types for artifact-paths.mjs so the unit tests (root tsconfig, strict) can
// import the real helper without allowJs.
export function runtimeBuildId(wasmBytes: Uint8Array): string;
export function buildIdOfArtifact(dir: string): string | null;
export function stagingDir(root: string, buildId: string, kind: string): string;
export function isInsidePublic(root: string, target: string): boolean;
export function refuseInsidePublic(root: string, target: string, who: string): void;

export type ToolPathSource = "flag" | "env" | "default";
export interface ToolPathOptions {
  /** The flag's value as parsed (empty or absent = not given). */
  value?: string | null;
  /** The environment variable consulted when the flag is absent. */
  env?: string;
  /** Maps the variable's value to the path (default: the value itself). */
  envTo?: ((value: string) => string) | null;
  /** The deprecated repo-relative default (one re-pin cycle), or null for none. */
  legacy?: string | null;
  /** When given, the deprecated default resolves only if this holds for it. */
  holds?: ((p: string) => boolean) | null;
  /** What a relative flag value resolves against (default: the cwd). */
  base?: string;
  environment?: Record<string, string | undefined>;
}
export function toolPath(o: ToolPathOptions): { path: string; source: ToolPathSource } | null;
export interface ResolveToolPathOptions extends ToolPathOptions {
  tool: string;
  flag: string;
  placeholder: string;
  legacyLabel?: string;
  needs?: string;
  usage: string;
}
export function resolveToolPath(
  o: ResolveToolPathOptions,
  io?: { err: (s: string) => void; exit: (code: number) => void; environment?: Record<string, string | undefined> },
): { path: string; source: ToolPathSource } | null;
export function ensureStackSize(tool: string, kib?: number, proc?: NodeJS.Process): "present" | "absent";
