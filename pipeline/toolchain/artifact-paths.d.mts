// Types for artifact-paths.mjs so the unit tests (root tsconfig, strict) can
// import the real helper without allowJs.
export function runtimeBuildId(wasmBytes: Uint8Array): string;
export function buildIdOfArtifact(dir: string): string | null;
export function stagingDir(root: string, buildId: string, kind: string): string;
export function isInsidePublic(root: string, target: string): boolean;
export function refuseInsidePublic(root: string, target: string, who: string): void;
