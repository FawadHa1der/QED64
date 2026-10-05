// Types for infoview-actions.mjs so unit tests (root tsconfig, strict) can pin
// its scenario selection, in-browser probes and verdicts without allowJs.
/** A probe: called with one argument; `g` is the browser global by default. */
export type Probe = (arg: any, g?: any) => unknown;
export type Evaluate = (fn: Probe, arg?: unknown) => Promise<unknown>;
export type EditorView = { uri: string; text: string; selection: number[] | null; focus: string | null; editorFocus: boolean };
export type RpcAnswer = { answered: boolean; exception?: string | null };
export type ForeignShowSeen = { before: EditorView; foreign: RpcAnswer; afterForeign: EditorView; own: RpcAnswer; afterOwn: EditorView };
export type ApiSeen = { atDcl: unknown; atLoad: unknown; frozen: boolean };
export const SCENARIOS: string[];
export function selectScenarios(only: string): string[];
export function exitCodeFor(total: number, failed: number): 0 | 1 | 3;
export function recordApiAtDomContentLoaded(arg?: unknown, g?: any): void;
export function apiAtLoad(arg?: unknown, g?: any): ApiSeen;
export function focusInfoview(frameSelector: string, g?: any): void;
export function editorView(arg?: unknown, g?: any): EditorView;
export function rpcFromInfoview(call: { name: string; args: unknown[]; seqNum: number; timeoutMs: number }, win?: any): Promise<RpcAnswer>;
export function capabilityVerdict(seen: ApiSeen): boolean;
export function foreignShow(inPage: Evaluate, inFrame: Evaluate, timeoutMs?: number): Promise<ForeignShowSeen>;
export function foreignShowFailures(seen: ForeignShowSeen): string[];
