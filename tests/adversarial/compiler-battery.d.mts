// Types for compiler-battery.mjs so unit tests (root tsconfig, strict) can
// pin the pure classifier against synthetic probe output without allowJs.
export type BatteryItem = { name: string; category: string; expect: Record<string, unknown> };
export type BatteryRow = {
  name: string; category: string; wallMs: number; outcome: "pass" | "fail" | "infra"; pass: boolean;
  failures: string[]; excerpt?: string; note?: string;
};
export function missingInputs(inputs: { snap: string; artifact: string }): string[];
export function classify(item: BatteryItem, run: { out: string; code: number | null; wallMs: number; budget: number; spawnError?: (Error & { code?: string }) | null }): BatteryRow;
export function rewriteAliases(src: string): string;
