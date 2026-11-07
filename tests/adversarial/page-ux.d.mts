// Types for page-ux.mjs so tests/unit/page-ux.test.ts (root tsconfig, strict) can
// pin its scenario selection, and stack-limit's words, without allowJs.
export const SCENARIOS: string[];
export function selectScenarios(only: string): string[];
export function exitCodeFor(total: number, failed: number): 0 | 1 | 3;
/** stack-limit: the pill's label for one guard error, and the first words of QED64's note. */
export const STACK_LABEL: string;
export const NOTE_START: string;
