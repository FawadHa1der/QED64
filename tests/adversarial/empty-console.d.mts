// Types for empty-console.mjs so unit tests (root tsconfig, strict) can pin
// its pairing rule without allowJs.
export type ConsoleLine = { t: number; type: string; text: string; where?: string; args?: string[] };
export type LspError = { t: number; id: unknown; code: number; message: string };
export type EmptyConsoleTracker = {
  lspErrors: LspError[];
  mainBundles: Set<string>;
  describe(m: unknown, line: ConsoleLine): void;
  noteMainBundle(page: unknown, url: string): Promise<void>;
  settle(): Promise<unknown>;
  paired(judged: ConsoleLine[]): Set<ConsoleLine>;
};
export const PAIR_BEFORE_MS: number;
export const PAIR_AFTER_MS: number;
export function trackEmptyConsole(context: { exposeBinding(name: string, cb: (source: unknown, e: any) => void): Promise<unknown>; addInitScript(script: string): Promise<unknown> }, at: () => number): Promise<EmptyConsoleTracker>;
export function shownLine(l: ConsoleLine): string;
export function shownLspErrors(lspErrors: LspError[]): string;
