export interface OleanImportEntry { module: string; importAll: boolean; isExported: boolean; isMeta: boolean }
export function oleanImportEntries(bytes: Uint8Array): OleanImportEntry[] | null;
export function oleanImports(bytes: Uint8Array): string[] | null;
