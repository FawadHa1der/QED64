// The front door's `initialize` answer (public/workers/lsp-front-door.js SERVER_CAPABILITIES)
// against a hand transcription of the pinned Lean tag's Watchdog.mkLeanServerCapabilities
// (tests/fixtures/lean-server-capabilities.json; architecture review R8). Every difference is
// named here, so a Lean bump that changes upstream's table fails this test instead of drifting
// the front door's copy silently:
//   * `change: 1` (full text) instead of 2: the wire has no range type (front-door.test.ts pins it);
//   * references, call hierarchy, rename and workspace symbols: stock Lean answers them only in the
//     watchdog (Watchdog.lean handleRequest), so the resident FileWorker replies -32603 to each;
//   * color; and in `experimental`, moduleHierarchyProvider (watchdog-only) and
//     rpcProvider.rpcWireFormat (InfoView 0.11.1 does not negotiate it).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import "../../public/workers/lsp-front-door.js";

type Json = Record<string, unknown>;
interface Fixture { tag: string; source: string; capabilities: Json }
interface Legend { tokenTypes: string[]; tokenModifiers: string[] }

const root = path.resolve(__dirname, "../..");
const fixture = JSON.parse(readFileSync(path.join(root, "tests/fixtures/lean-server-capabilities.json"), "utf8")) as Fixture;
const record = JSON.parse(readFileSync(path.join(root, "toolchain/lean4-wasm64-release.json"), "utf8")) as { lean: { upstreamTag: string } };
const FD = (globalThis as unknown as { Qed64LspFrontDoor: { SERVER_CAPABILITIES: Json } }).Qed64LspFrontDoor;

/** The upstream members the front door leaves out, each with its reason; a dotted key names a nested member. */
const REMOVED: Record<string, string> = {
  referencesProvider: "watchdog-only (the stock page answers from documentHighlight)",
  callHierarchyProvider: "watchdog-only",
  renameProvider: "watchdog-only (the stock page answers from documentHighlight)",
  workspaceSymbolProvider: "watchdog-only",
  colorProvider: "nothing on the page uses it",
  "experimental.moduleHierarchyProvider": "watchdog-only; lean4monaco would send $/lean/moduleHierarchy/*",
  "experimental.rpcProvider.rpcWireFormat": "InfoView 0.11.1 does not negotiate it; decide at an InfoView bump",
};

describe("front door capabilities against upstream's mkLeanServerCapabilities (R8)", () => {
  it("the transcription is of the pinned Lean tag", () => {
    expect(fixture.tag).toBe(record.lean.upstreamTag);
  });

  it("equals upstream with change: 1 and the named removals", () => {
    const want = structuredClone(fixture.capabilities);
    (want.textDocumentSync as Json).change = 1;
    for (const [key, reason] of Object.entries(REMOVED)) {
      const keys = key.split(".");
      const leaf = keys.pop()!;
      const parent = keys.reduce<Json>((o, k) => o[k] as Json, want);
      // A removal must name something upstream has: a stale entry here fails.
      expect(parent, `${key} (${reason})`).toHaveProperty(leaf);
      delete parent[leaf];
    }
    expect(FD.SERVER_CAPABILITIES).toEqual(want);
  });

  it("advertises signature help and the InfoView's trace search (UX parity E3.6, I4.13; HARDENING #91)", () => {
    expect(FD.SERVER_CAPABILITIES.signatureHelpProvider).toEqual({ workDoneProgress: false, triggerCharacters: [" "] });
    expect(FD.SERVER_CAPABILITIES.experimental).toEqual({ rpcProvider: { highlightMatchesProvider: {} } });
  });

  it("the legend is upstream's order: leanSorryLike is token type 23", () => {
    const legend = (FD.SERVER_CAPABILITIES.semanticTokensProvider as { legend: Legend }).legend;
    expect(legend.tokenTypes.indexOf("leanSorryLike")).toBe(23);
  });
});
