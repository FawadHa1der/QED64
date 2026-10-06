export interface OleanImportEntry { module: string; importAll: boolean; isExported: boolean; isMeta: boolean }
export function oleanImportEntries(bytes: Uint8Array): OleanImportEntry[] | null;
export function oleanImports(bytes: Uint8Array): string[] | null;
/** ModuleData's constant-name count and, per environment extension, its entry count. */
export interface OleanEntryCounts { constNames: number; entries: Record<string, number> }
export function oleanExtEntryCounts(bytes: Uint8Array): OleanEntryCounts | null;
