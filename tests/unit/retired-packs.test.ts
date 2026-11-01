// D1 (2026-11): library packs left the browser. Releases before it installed
// them into OPFS `qed64-packs/` and kept an OPFS write ceiling in
// localStorage["qed64.opfs.byteCeiling"]; installArtifacts removes both, best
// effort and off the boot's path (removeRetiredPackStore), and reads no profile
// index whatever `profiles` or `?profiles=` say (the override is still
// validated).
import { afterEach, describe, expect, it, vi } from "vitest";
import { installArtifacts, removeRetiredPackStore, type StatusSink } from "../../lib/qed64-boot";
import { BootParamError } from "../../lib/params";
import type { RuntimeManifest } from "../../lib/client";

const ORIGIN = "http://localhost:5199";
const runtime = { buildId: "wasm64-3ab1c6a9da03bc29" } as RuntimeManifest;
const sink = (): StatusSink => ({ busy: vi.fn(), progress: vi.fn(), idle: vi.fn() });

/** An OPFS root whose removeEntry is `removeEntry`, and a localStorage whose removeItem is `removeItem`. */
function stub({ removeEntry = vi.fn(async () => {}), removeItem = vi.fn() }: { removeEntry?: ReturnType<typeof vi.fn>; removeItem?: ReturnType<typeof vi.fn> } = {}) {
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ removeEntry }) } });
  vi.stubGlobal("localStorage", { removeItem });
  return { removeEntry, removeItem };
}

afterEach(() => vi.unstubAllGlobals());

describe("removeRetiredPackStore", () => {
  it("removes the OPFS pack store and the ceiling key, and resolves true", async () => {
    const { removeEntry, removeItem } = stub();
    await expect(removeRetiredPackStore()).resolves.toBe(true);
    expect(removeEntry).toHaveBeenCalledWith("qed64-packs", { recursive: true });
    expect(removeItem).toHaveBeenCalledWith("qed64.opfs.byteCeiling");
  });

  it("never throws: an absent directory, no navigator.storage, or a throwing localStorage", async () => {
    const gone = stub({ removeEntry: vi.fn(async () => { throw new DOMException("not found", "NotFoundError"); }) });
    await expect(removeRetiredPackStore()).resolves.toBe(false);
    expect(gone.removeItem).toHaveBeenCalledWith("qed64.opfs.byteCeiling");
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("localStorage", { removeItem: vi.fn() });
    await expect(removeRetiredPackStore()).resolves.toBe(false);
    vi.unstubAllGlobals();
    const { removeEntry } = stub({ removeItem: vi.fn(() => { throw new DOMException("denied", "SecurityError"); }) });
    await expect(removeRetiredPackStore()).resolves.toBe(true);
    expect(removeEntry).toHaveBeenCalledWith("qed64-packs", { recursive: true });
  });
});

describe("installArtifacts: no pack, no profile index (D1)", () => {
  it("resolves while the clean-up never settles, and fetches no /profiles path whatever ?profiles= says", async () => {
    const { removeEntry } = stub({ removeEntry: vi.fn(() => new Promise<void>(() => {})) });
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { search: "?profiles=profiles-staged", origin: ORIGIN });
    const ui = sink();
    await expect(installArtifacts(ui, { overrides: { profiles: "profiles-staged" }, runtime, snapshots: null })).resolves.toEqual({ runtime, snapshots: null });
    await expect(installArtifacts(ui, { overrides: "url", profiles: "core", runtime, snapshots: null })).resolves.toEqual({ runtime, snapshots: null });
    expect(removeEntry).toHaveBeenCalledWith("qed64-packs", { recursive: true });
    expect(fetch.mock.calls.map((c) => String((c as unknown[])[0])).filter((u) => u.includes("/profiles"))).toEqual([]);
    expect(ui.busy).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stage: "profile" }));
  });

  it("a refused ?profiles= is still a BootParamError, before any fetch", async () => {
    stub();
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { search: "", origin: ORIGIN });
    const err = await installArtifacts(sink(), { overrides: { profiles: "../evil" } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BootParamError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
