// Types for page-ux.mjs so tests/unit/page-ux.test.ts (root tsconfig, strict) can
// pin its scenario selection without allowJs.
export const SCENARIOS: string[];
export function selectScenarios(only: string): string[];
export function exitCodeFor(total: number, failed: number): 0 | 1 | 3;
