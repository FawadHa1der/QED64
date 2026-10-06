// Types for preflight.mjs (root tsconfig, strict, no allowJs). The CLI's flags,
// markers and exit codes: docs/CLI-CONTRACT.md "preflight".
import type { PageTarget } from "./page-target.mjs";

/** One check line: `ok`, `warn` (ok with `warn: true`) or `FAIL`. */
export interface PreflightCheck {
  ok: boolean;
  warn?: true;
  what: string;
}

export interface PreflightResult {
  ok: boolean;
  /** The refusal (the `PREFLIGHT REFUSED: <reason>` text); null when ok. */
  reason: string | null;
  /** The served runtime's buildId, once the manifest named one. */
  buildId: string | null;
  mode: PageTarget["mode"];
  checks: PreflightCheck[];
}

/** What bootSmoke needs of the playwright module. */
export interface PlaywrightLike {
  chromium: { launch(options?: { args?: string[] }): Promise<unknown> };
}

export interface BootSmokeOptions {
  /** Replaces `import("playwright")`, which resolves from preflight.mjs's own
   * location (the caller's install). A rejection with code
   * `ERR_MODULE_NOT_FOUND` (or `MODULE_NOT_FOUND`) whose message names
   * `'playwright'` itself is the reason `playwright not resolvable from the
   * caller (<code>)`; any other rejection, a missing `playwright-core`
   * included, is `playwright could not be imported (<code>): <its first
   * message line>`. Every reason is one line. */
  importPlaywright?: () => Promise<PlaywrightLike>;
}

export type BootSmokeResult = { ok: true; ms: number } | { ok: false; reason: string };

export interface PreflightOptions extends BootSmokeOptions {
  /** Run the headless boot smoke (default true; the CLI's `--no-boot` sets false). */
  boot?: boolean;
  /** The boot smoke's budget to reach the ready pill (default 180000). */
  bootBudgetMs?: number;
  /** Each check line (default console.log). */
  log?: (line: string) => void;
}

/** Run the checks against `target` (resolveTarget in page-target.mjs). Never throws. */
export function runPreflight(target: PageTarget, opts?: PreflightOptions): Promise<PreflightResult>;

/** One headless page must reach the ready pill within `budgetMs`. Never
 * throws: an unresolvable playwright or a Chromium that does not launch is
 * `{ ok: false, reason }`. */
export function bootSmoke(url: string, budgetMs: number, opts?: BootSmokeOptions): Promise<BootSmokeResult>;

/** The CLI on process.argv: exit 0 (PREFLIGHT OK), 3 (PREFLIGHT REFUSED), 1 (a crash). */
export function main(): Promise<void>;
