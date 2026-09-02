// Types for the edge worker's cache rule so tests/unit/artifact-discipline.test.ts
// (root tsconfig, strict) can pin it without allowJs.
export function isImmutable(pathname: string): boolean;
declare const worker: { fetch(request: Request, env: unknown): Promise<Response> };
export default worker;
