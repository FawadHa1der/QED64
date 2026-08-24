// The umbrella header rewrite: one snapshot for EVERY Mathlib import set.
//
// Exact-import-set snapshots cannot be pre-baked for arbitrary user headers —
// one added import line drops the session back to a minutes-long closure
// import. Instead, the pipeline bakes a single environment for the umbrella
// module `QED64.Essential` (which imports the whole mathlib-essential
// profile), and the app compiles Mathlib-using buffers against it by
// rewriting their header to exactly `import QED64.Essential`: the runtime's
// environment cache is keyed by the precise ordered header, so every rewrite
// is a cache hit after the umbrella is resident.
//
// The rewrite is position-preserving: line and column numbers in diagnostics
// need no remapping. Semantics caveat (playground mode): everything in the
// essential profile is in scope regardless of which subset the header names.
// The app still validates every named import against the installed profile,
// so nonexistent modules are reported, not masked.

export const UMBRELLA_MODULE = "QED64.Essential";

// Modules users paste constantly that do not exist in the installed profile,
// but whose *intent* the umbrella environment serves: whole-library
// aggregators the curation drops, and tutorial preludes that are themselves
// just Mathlib re-exports (MIL.Common = Mathlib.Tactic + Util.Delaborators +
// a set_option). Under the rewrite they are satisfied by the umbrella like
// any in-closure import; in strict-headers mode they fail honestly.
export const UMBRELLA_ALIAS_MODULES: ReadonlyMap<string, string> = new Map([
  ["Mathlib", "the whole-Mathlib aggregator"],
  ["Mathlib.Tactic", "the all-tactics aggregator"],
  ["Batteries", "the whole-Batteries aggregator"],
  ["MIL.Common", "the Mathematics in Lean tutorial prelude (Mathlib re-exports)"],
]);

const IMPORT_LINE = /^(?:public\s+|private\s+)?(?:meta\s+)?import\s+[A-Za-z_][\w.«»]*/;

/** Rewrite the header import lines to the umbrella module, preserving the
 * line count and every non-import line byte-for-byte. The first import line
 * becomes `import QED64.Essential`; the rest become comments. */
export function rewriteHeaderToUmbrella(source: string): string {
  const lines = source.split("\n");
  let first = true;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i]!.trim();
    if (t.startsWith("--")) continue;
    if (!IMPORT_LINE.test(t)) continue;
    if (first) {
      lines[i] = `import ${UMBRELLA_MODULE}`;
      first = false;
    } else {
      lines[i] = `-- ${lines[i]}`;
    }
  }
  return lines.join("\n");
}

/** True when this import set should compile against the umbrella environment:
 * at least one Mathlib module (or alias), and every named module inside the
 * umbrella's own import closure or the alias table — an import outside both
 * (a core module Mathlib never touches, or a module that doesn't exist)
 * would silently lose its declarations under the rewrite, so those sets
 * compile as written. */
export function shouldUseUmbrella(
  orderedImports: string[],
  umbrellaClosure: { has(name: string): boolean },
): boolean {
  return (
    orderedImports.length > 0 &&
    orderedImports.some((m) => m.startsWith("Mathlib") || UMBRELLA_ALIAS_MODULES.has(m)) &&
    orderedImports.every((m) => umbrellaClosure.has(m) || UMBRELLA_ALIAS_MODULES.has(m))
  );
}
