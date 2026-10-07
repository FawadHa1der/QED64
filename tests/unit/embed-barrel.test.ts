// The `qed64/embed` barrel's shape (docs/EMBEDDING.md §7.0): what the two
// consumers and the stock page import through it stays exported; the
// re-exports with no consumer are gone; the `@internal` block is exactly the
// names neither consumer uses (still exported, outside the contract).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as embed from "../../lib/index";

const root = path.resolve(__dirname, "../..");
const barrelSource = fs.readFileSync(path.join(root, "lib/index.ts"), "utf8");

/** Runtime names lean4game imports through `qed64/embed` (its qed64-dep branch, app code and tests). */
const LEAN4GAME = [
  "LspRelay", "ResidentSession", "WORKER_URLS", "installArtifacts", "isRawCached", "PREFETCH_SILENCE_MS", "SNAPSHOT_CACHE_DIR",
  "isCacheKeyOf", "prefetchRaw", "removeRawRegion", "runtimeUrls", "snapshotCacheKey", "fetchSnapshotIndexFor", "loadSnapshotIndex",
  "resolveRuntimeManifest", "BootParamError", "validateBootOverrides", "WORKER_SCRIPT_LOAD_FAILED",
  "LeanSession", "deathCause", "failureCauseOf", "loadSnapshotByName",
];
/** Runtime names frontend/src/main.ts (the stock page) imports from the barrel ("../../lib"). */
const STOCK_PAGE = ["LspRelay", "ResidentSession", "entryLabel", "failureCauseOf", "installArtifacts", "makeEditorPolicy"];
const INTERNAL = [
  "installProfile", "ensureProfile", "fetchProfileIndex", "parseBootParams", "overridesOf", "NO_OVERRIDES",
  "memoryCandidates", "rawRegionName", "httpStatusOf", "failureKindOf", "isImport",
];

/** The names of every `export { … }` statement directly preceded by a `/** @internal *\/` line. */
function internalExports(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^\/\*\* @internal \*\/\nexport \{([^}]*)\} from "[^"]+";$/gm)) {
    names.push(...m[1]!.split(",").map((n) => n.trim()).filter(Boolean));
  }
  return names;
}

describe("qed64/embed barrel", () => {
  it("exports every name lean4game and the stock page import through it", () => {
    for (const name of [...LEAN4GAME, ...STOCK_PAGE]) expect(embed, name).toHaveProperty(name);
  });

  it("no longer re-exports storageEstimate or UMBRELLA_ROOTS (no consumer anywhere)", () => {
    expect(embed).not.toHaveProperty("storageEstimate");
    expect(embed).not.toHaveProperty("UMBRELLA_ROOTS");
    expect(embed.isUmbrellaModule("Mathlib.Tactic")).toBe(true); // the helper that reads the set stays
  });

  it("the @internal block is exactly the names neither consumer uses, and each is still exported", () => {
    const marked = internalExports(barrelSource);
    expect([...marked].sort()).toEqual([...INTERNAL].sort());
    for (const name of INTERNAL) {
      expect(embed, name).toHaveProperty(name);
      expect(LEAN4GAME, name).not.toContain(name);
      expect(STOCK_PAGE, name).not.toContain(name);
    }
  });

  it("main.ts imports the barrel's names from the barrel, not from their deep paths", () => {
    const main = fs.readFileSync(path.join(root, "frontend/src/main.ts"), "utf8");
    expect(main).toMatch(/\} from "\.\.\/\.\.\/lib";/);
    // ...nor through the one-cycle shims at the old paths (plan A7).
    for (const deep of ["../../lib/qed64-boot", "../../lib/lsp-relay", "../../lib/resident-session", "../../lib/snapshots", "../../lib/failure",
      "./embed", "./qed64-boot", "./lsp-relay", "./resident-session", "../../src/runtime/snapshots", "./embed/failure"]) {
      expect(main, deep).not.toContain(`from "${deep}"`);
    }
  });

  it("EMBED_API_REVISION is a semver", () => {
    expect(embed.EMBED_API_REVISION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });
});
