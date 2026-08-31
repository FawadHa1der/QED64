// Import-path completion, client-side (live.lean-lang.org parity).
//
// The Lean server's own import completion needs a filesystem inventory the
// wasm worker doesn't have, and our header-probe flow deliberately holds the
// session while an import line is being composed — exactly when completions
// help most. So this is a plain Monaco provider over data every client
// already downloads: the pack manifests list one `.olean` per module, and
// module names are just those paths with dots. No worker, no toolchain, no
// new artifacts; Monaco merges these with the LSP's identifier completions.
import * as monaco from "monaco-editor";

/** Umbrella aliases the header rewrite accepts (kept in sync by the tests). */
const ALIASES = ["Mathlib", "Mathlib.Tactic", "Batteries", "MIL.Common"];
const MANIFESTS = ["/profiles/lean-core.manifest.json", "/profiles/mathlib-essential.manifest.json"];

let namesPromise: Promise<string[]> | null = null;

function collectModuleNames(manifest: unknown, into: Set<string>): void {
  const stack: unknown[] = [manifest];
  while (stack.length) {
    const o = stack.pop();
    if (Array.isArray(o)) {
      for (const f of o) {
        const filename = (f as { filename?: unknown })?.filename;
        if (typeof filename === "string") {
          // "/Mathlib/Data/Real/Basic.olean" -> "Mathlib.Data.Real.Basic";
          // companion facets (.olean.server, .ir, ...) are skipped.
          if (filename.endsWith(".olean") && !/\.olean\./.test(filename) && !filename.includes(".ir")) {
            into.add(filename.slice(1, -".olean".length).replaceAll("/", "."));
          }
        } else {
          stack.push(f);
        }
      }
    } else if (o && typeof o === "object") {
      stack.push(...Object.values(o));
    }
  }
}

/** Lazy, fetched once per page: ~5k names from manifests the browser caches. */
function moduleNames(): Promise<string[]> {
  namesPromise ??= (async () => {
    const names = new Set<string>(ALIASES);
    for (const url of MANIFESTS) {
      try {
        collectModuleNames(await (await fetch(url)).json(), names);
      } catch {
        // A missing profile just narrows the list — never break completion.
      }
    }
    return [...names].sort();
  })();
  return namesPromise;
}

export function registerImportCompletion(): void {
  monaco.languages.registerCompletionItemProvider("lean4", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const m = /^(\s*)import\s+([\w.]*)$/.exec(before);
      if (!m) return { suggestions: [] };
      const typed = m[2];
      const names = await moduleNames();
      // Segment-suffix items, exactly like live.lean-lang.org: for
      // "import Mathlib.Data.Re" the items are "Real.Basic", "Rel.Cover", …
      // This is not a style choice — Monaco scores items against the word at
      // the cursor (dots excluded), so suffix-shaped items are what its
      // filtering, selection, and Enter-to-accept machinery understand.
      const lastDot = typed.lastIndexOf(".");
      const base = lastDot >= 0 ? typed.slice(0, lastDot + 1) : "";
      const segStartColumn = m[1].length + "import ".length + base.length + 1;
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: segStartColumn,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };
      // No cap: Monaco's suggest list is virtualized and filters per keystroke,
      // and a cap here would hide alphabetically-late modules (Tactic, Topology)
      // until another dot is typed. ~4.8k items is well within its comfort zone.
      const suffixes = names.filter((n) => n.startsWith(base) && n.length > base.length)
        .map((n) => n.slice(base.length));
      return {
        suggestions: suffixes.map((suffix) => ({
          label: suffix,
          kind: monaco.languages.CompletionItemKind.Module,
          insertText: suffix,
          range,
        })),
      };
    },
  });
}
