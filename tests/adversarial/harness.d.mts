// Types for harness.mjs so unit tests (root tsconfig, strict) can pin the
// pure helpers without allowJs.
export const root: string;
export function arg(name: string, fallback: string): string;
export function has(flag: string): boolean;
export const MODE: "resident";
export function resolveTarget(url: string): {
  url: string; origin: string; mode: "resident"; runtimeOverride: string | null;
  snapshotsDir: string; profilesDir: string; manifestUrl: string; indexUrl: string; profilesUrl: string;
};
export function fetchJson(url: string, timeoutMs?: number): Promise<unknown>;
export function onlyMatches(name: string, pattern: string): boolean;
export function settleClass(pill: string): "ready" | "headerUnresolvable" | "halted" | null;
export function settleClassFromPhase(phase: string | null): "ready" | "headerUnresolvable" | "halted" | null;
export function stamp(): string;
export function runDir(buildId: string, mode: string, explicit?: string): string;
export function teeLog(dir: string, name: string): string;
export function reclaimableBytes(): number;
export function strayBrowsers(): string[];
export function coolDown(opts?: { minFreeGB?: number; maxWaitS?: number; killStrays?: boolean; log?: (s: string) => void }): Promise<boolean>;
