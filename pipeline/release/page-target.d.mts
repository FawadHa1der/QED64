// Types for page-target.mjs (root tsconfig, strict, no allowJs).
export const MODE: "resident";
export interface PageTarget {
  url: string; origin: string; mode: "resident"; runtimeOverride: string | null;
  snapshotsDir: string; profilesDir: string; manifestUrl: string; indexUrl: string; profilesUrl: string;
}
export function resolveTarget(url: string): PageTarget;
export function fetchJson(url: string, timeoutMs?: number): Promise<unknown>;
