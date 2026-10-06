// Types for cli.mjs so the unit tests (root tsconfig, strict) can import the
// real contract without allowJs.
export interface CliFlag { name: string; value?: string; default?: string; doc: string }
export interface CliMarker {
  id: string;
  stream: "stdout" | "stderr";
  template: string[];
  source?: string;
  /** The template is the lean4-wasm64 package's: the script (relative to the package dir) a forward runs. */
  forwarded?: string;
  prefix?: boolean;
  regex: RegExp;
  example: string;
}
export interface CliSpec {
  script: string;
  npm: string | null;
  tier: 1 | 2;
  binding: "inline" | "import";
  node: string;
  synopsis: string;
  summary: string;
  flags: CliFlag[];
  required?: string[][];
  passthrough?: { mode: "separator" | "implicit"; required: boolean; doc: string };
  env: string[];
  exits: Record<string, string>;
  classifier?: { template: string; doc: string };
  markers: CliMarker[];
}
export interface CompactSpec {
  tool: string;
  usage: string;
  flags: Record<string, 0 | 1>;
  required: string[][];
  passthrough: "separator" | "implicit" | null;
  passthroughRequired: boolean;
  help: string;
}
export interface CliIo { out(s: string): void; err(s: string): void; exit(code: number): void }
export interface CliParse { values: Record<string, string | true>; passthrough: string[]; args: string[] }

export const CONTRACT_VERSION: number;
export const RESERVED_OUTPUT: { text: string; where: "anywhere" | "line-initial" }[];
export function reservedHit(text: string): { line: string; reserved: string } | null;
export const EXIT_CLASSES: Record<string, string>;
export const ENV: Record<string, { doc: string; readBy: string[]; setBy?: string[] }>;
export const SPECS: Record<string, CliSpec>;
export const DIAGNOSTIC: string[];
export function cliContract(spec: Omit<CompactSpec, "help"> & { help?: string }, args: string[], io?: CliIo): CliParse | null;
export function compactSpec(tool: string): CompactSpec;
export function parseCli(tool: string, args?: string[], io?: CliIo): CliParse | null;
export function formatHelp(tool: string): string;
export const PRELUDE_BEGIN: string;
export const PRELUDE_END: string;
export function renderPrelude(tool: string): string;
export function findPrelude(source: string): { start: number; end: number; indent: string; lines: string[] } | null;
export function withPrelude(source: string, tool: string): string;
export function specsJson(): unknown;
