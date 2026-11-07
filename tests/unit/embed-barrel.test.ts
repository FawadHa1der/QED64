// The `qed64/embed` barrel's shape (docs/EMBEDDING.md §7.0): what the library
// consumers (lean4game, the proof sheets) and the stock page import through it
// stays exported; every other export is named in EMBEDDING §7 (the contract,
// final since 1.0.0); the re-exports with no consumer are gone (REMOVED); the
// `@internal` block is exactly INTERNAL, names no consumer imports (still
// exported, outside the contract).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as embed from "../../lib/index";

const root = path.resolve(__dirname, "../..");
const barrelSource = fs.readFileSync(path.join(root, "lib/index.ts"), "utf8");

/** Runtime names lean4game imports through `qed64/embed` (branch wasm64-port, app code and tests). */
const LEAN4GAME = [
  "LspRelay", "ResidentSession", "WORKER_URLS", "installArtifacts", "isRawCached", "PREFETCH_SILENCE_MS", "SNAPSHOT_CACHE_DIR",
  "isCacheKeyOf", "prefetchRaw", "removeRawRegion", "runtimeUrls", "snapshotCacheKey", "fetchSnapshotIndexFor", "loadSnapshotIndex",
  "resolveRuntimeManifest", "BootParamError", "validateBootOverrides", "WORKER_SCRIPT_LOAD_FAILED",
  "LeanSession", "deathCause", "failureCauseOf", "loadSnapshotByName",
];
/** Runtime names the proof sheets import through `qed64/embed` (website-v4.35 website/site/src/qed64.ts:21-41). */
const PROOF_SHEETS = ["DEFAULT_MAXIMUM_BYTES", "LspRelay", "MEMORY64_PROBE", "ResidentSession", "chooseSnapshots", "importedModulesOf",
  "initialBytesForEntries", "installArtifacts", "prefetchRaw", "removeRawRegion", "isCacheKeyOf", "SNAPSHOT_CACHE_DIR"];
/** Runtime names frontend/src/main.ts (the stock page) imports from the barrel ("../../lib"). */
const STOCK_PAGE = ["ENGINE_STACK_OVERFLOW", "LspRelay", "ResidentSession", "STACK_LIMIT_NOTE", "entryLabel", "failureCauseOf", "installArtifacts", "isStackLimitDiagnostic", "makeEditorPolicy"];
/** The umbrella-root list: policy data that follows the served umbrella (R1), so outside the v1 contract (D13). */
const INTERNAL = ["LEGACY_UMBRELLA_ROOTS"];
/** Names the barrel exported once and no longer does. The R9a ones still live in their lib/ files, where the page and the tests import them. */
const REMOVED = [
  // plan step A2c (1.0.0-pre.5)
  "storageEstimate", "UMBRELLA_ROOTS",
  // the 11 `@internal` re-exports: the library-pack installer left with D1 (1.0.0-pre.10), the rest with R9a (1.0.0-pre.11)
  "installProfile", "ensureProfile", "fetchProfileIndex",
  "memoryCandidates", "overridesOf", "rawRegionName", "failureKindOf", "httpStatusOf", "NO_OVERRIDES", "parseBootParams", "isImport",
  // 11 values no consumer imports through the barrel (R9a, 1.0.0-pre.11)
  "PROTOCOL", "fetchSnapshotIndex", "entryRoots", "WORKER_DEP_MISMATCH", "EDITOR_POLICY", "importLinesOf",
  "initialBytesForHeader", "initialBytesForSnapshots", "isUmbrellaModule", "needsMathlib", "snapshotsForHeader",
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
  it("exports every name lean4game, the proof sheets and the stock page import through it", () => {
    for (const name of [...LEAN4GAME, ...PROOF_SHEETS, ...STOCK_PAGE]) expect(embed, name).toHaveProperty(name);
  });

  it("no longer re-exports the 24 removed names, none of which a consumer or the stock page imports through it", () => {
    expect(REMOVED).toHaveLength(24);
    expect(new Set(REMOVED).size).toBe(REMOVED.length);
    for (const name of REMOVED) {
      expect(embed, name).not.toHaveProperty(name);
      expect(LEAN4GAME, name).not.toContain(name);
      expect(PROOF_SHEETS, name).not.toContain(name);
      expect(STOCK_PAGE, name).not.toContain(name);
    }
  });

  it("the @internal block is exactly INTERNAL, names neither a consumer nor the stock page imports, and each is still exported", () => {
    const marked = internalExports(barrelSource);
    expect([...marked].sort()).toEqual([...INTERNAL].sort());
    for (const name of INTERNAL) {
      expect(embed, name).toHaveProperty(name);
      expect(LEAN4GAME, name).not.toContain(name);
      expect(PROOF_SHEETS, name).not.toContain(name);
      expect(STOCK_PAGE, name).not.toContain(name);
    }
  });

  it("every value export the barrel carries is named in docs/EMBEDDING.md §7, unless marked @internal (§7.0)", () => {
    const doc = fs.readFileSync(path.join(root, "docs/EMBEDDING.md"), "utf8");
    const s7 = doc.slice(doc.indexOf("\n## 7. "), doc.indexOf("\n### 7.1 "));
    expect(s7.length, "the §7 intro and §7.0").toBeGreaterThan(1000);
    const internal = new Set(internalExports(barrelSource));
    for (const name of Object.keys(embed)) if (!internal.has(name)) expect(s7, name).toMatch(new RegExp("`" + name + "\\b"));
  });

  it("main.ts imports the barrel's names from the barrel, not from their deep paths", () => {
    const main = fs.readFileSync(path.join(root, "frontend/src/main.ts"), "utf8");
    expect(main).toMatch(/\} from "\.\.\/\.\.\/lib";/);
    // ...nor through the library's pre-A7 paths (deleted, R9a).
    for (const deep of ["../../lib/qed64-boot", "../../lib/lsp-relay", "../../lib/resident-session", "../../lib/snapshots", "../../lib/failure",
      "./embed", "./qed64-boot", "./lsp-relay", "./resident-session", "../../src/runtime/snapshots", "./embed/failure"]) {
      expect(main, deep).not.toContain(`from "${deep}"`);
    }
  });

  it("EMBED_API_REVISION is a final semver: no \"-pre\" since 1.0.0 (D13; a break is the next major, §1)", () => {
    expect(embed.EMBED_API_REVISION).toMatch(/^[1-9]\d*\.\d+\.\d+$/);
  });

  it("docs/EMBEDDING.md §12 records the bump to the current EMBED_API_REVISION (§7: an additive change bumps it, with a row)", () => {
    const doc = fs.readFileSync(path.join(root, "docs/EMBEDDING.md"), "utf8");
    const changes = doc.slice(doc.indexOf("\n## 12. "));
    expect(changes).toContain(`\`EMBED_API_REVISION\` → \`${embed.EMBED_API_REVISION}\``);
  });
});
