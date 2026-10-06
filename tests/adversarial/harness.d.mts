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
export function parseVmStat(text: string): number | null;
export function parseMeminfo(text: string): number | null;
export type MemoryReading = { bytes: number; source: string } | { bytes: null; reason: string };
export function memoryReading(probes?: {
  platform?: string;
  vmStat?: () => { stdout?: string | null; status?: number | null; error?: (Error & { code?: string }) | undefined };
  meminfo?: () => string;
  freemem?: () => number;
}): MemoryReading;
export function reclaimableBytes(): number;
export function strayBrowsers(): string[];
export function coolDown(opts?: { minFreeGB?: number; maxWaitS?: number; killStrays?: boolean; log?: (s: string) => void; reading?: () => MemoryReading; strays?: () => string[] }): Promise<boolean>;
export function batteryArgv(dir: string, get?: (flag: string, fallback: string) => string): string[];
export function suiteExitCode(compilerCode: number, e2eCode: number): 0 | 1 | 3;
export interface LaneReport {
  lane: string; total: number; refused?: string;
  results: { name: string; category?: string; outcome?: string; pass?: boolean; failures?: string[]; detail?: string; screenshot?: string }[];
}
export function laneSections(lanes: { name: string; report: LaneReport | null; code: number | null; log: string }[]): string[];
