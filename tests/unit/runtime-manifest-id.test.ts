// The runtime/v1 invariant (docs/EMBEDDING.md §7.2): a runtime manifest's
// buildId IS "wasm64-" + sha256(lean.wasm)[:16]. The toolchain writes it from
// the bytes; the page and the worker compare strings and refuse a manifest
// that breaks it (RUNTIME_MANIFEST_MISMATCH, kind "corrupt"), so the id
// snapshots are paired by (SNAPSHOT_UNPAIRED) is tied to the hash the worker
// verifies the bytes against. Agreed with the kernel session on 2026-10-05.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL, runtimeIdOf, runtimeManifestIdFault, type RuntimeManifest } from "../../lib/client";
import { failureCauseOf } from "../../lib/failure";
import { resolveRuntimeManifest } from "../../lib/qed64-boot";
import { NO_OVERRIDES } from "../../lib/params";

const sha = "3ab1c6a9da03bc29" + "f".repeat(48);
const file = (bytes: number, sha256: string) => ({ bytes, sha256, chunks: [{ url: `/runtime/chunks/${sha256}.0`, bytes, sha256 }] });
const good = (): RuntimeManifest => ({ buildId: `wasm64-${sha.slice(0, 16)}`, leanVersion: "4.34.0", files: { "lean.js": file(10, "a".repeat(64)), "lean.wasm": file(20, sha) } });

describe("runtimeIdOf / runtimeManifestIdFault", () => {
  it("the id is the first 16 hex digits of lean.wasm's sha256; a matching manifest has no fault", () => {
    expect(runtimeIdOf(good())).toBe("wasm64-3ab1c6a9da03bc29");
    expect(runtimeManifestIdFault(good())).toBeNull();
  });
  it("a renamed, truncated or edited manifest is a fault that names both ids", () => {
    const m = good();
    m.buildId = "wasm64-0000000000000000";
    expect(runtimeManifestIdFault(m)).toMatch(/'wasm64-0000000000000000' is not the id of its own lean\.wasm \(wasm64-3ab1c6a9da03bc29\)/);
    m.files["lean.wasm"].sha256 = "not-a-hash";
    expect(runtimeIdOf(m)).toBeNull();
    expect(runtimeManifestIdFault(m)).toMatch(/no valid sha256/);
    expect(runtimeManifestIdFault({ buildId: "x", leanVersion: "4.34.0", files: {} as never })).toMatch(/no valid sha256/);
  });
});

describe("resolveRuntimeManifest (page side)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const serving = (m: unknown) => vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => m }));
  it("returns a manifest that honours the invariant", async () => {
    serving(good());
    await expect(resolveRuntimeManifest(NO_OVERRIDES, { pinnedBuildId: null })).resolves.toMatchObject({ buildId: "wasm64-3ab1c6a9da03bc29" });
  });
  it("refuses one that breaks it before any chunk is fetched, with a corrupt cause", async () => {
    serving({ ...good(), buildId: "wasm64-deadbeefdeadbeef" });
    const err = await resolveRuntimeManifest(NO_OVERRIDES, { pinnedBuildId: null }).catch((e: unknown) => e) as Error & { code?: string };
    expect(err.code).toBe("RUNTIME_MANIFEST_MISMATCH");
    expect(err.message).toMatch(/^runtime manifest: .*is not the id of its own lean\.wasm/);
    expect(failureCauseOf(err, { stage: "manifests" })).toMatchObject({ kind: "corrupt", stage: "manifests" });
  });
});

describe("resolveRuntimeManifest: the pinned copy first; any miss of it leaves the choice to the mutable path (HARDENING #65)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const PINNED = "/runtime/runtime-manifest.wasm64-3ab1c6a9da03bc29.json";
  const MUTABLE = "/runtime/runtime-manifest.json";
  const json = (m: unknown) => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => m });
  const failedToFetch = () => Promise.reject(new TypeError("Failed to fetch"));
  /** fetch answered per URL; returns the URLs asked, in order. */
  const serve = (answers: Record<string, () => unknown>) => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      const a = answers[url];
      if (!a) throw new Error(`unexpected fetch ${url}`);
      return a();
    });
    return asked;
  };
  const resolve = (overrides = NO_OVERRIDES) => resolveRuntimeManifest(overrides, { pinnedBuildId: "wasm64-3ab1c6a9da03bc29" });

  it("a pinned copy that answers JSON is used; the mutable path is never asked", async () => {
    const asked = serve({ [PINNED]: () => json(good()) });
    await expect(resolve()).resolves.toMatchObject({ buildId: "wasm64-3ab1c6a9da03bc29" });
    expect(asked).toEqual([PINNED]);
  });

  it("a REJECTED pinned fetch (a dead link while online, a refusing proxy) is a miss: the mutable manifest is used", async () => {
    const asked = serve({ [PINNED]: failedToFetch, [MUTABLE]: () => json(good()) });
    await expect(resolve()).resolves.toMatchObject({ buildId: "wasm64-3ab1c6a9da03bc29" });
    expect(asked).toEqual([PINNED, MUTABLE]);
  });

  it("so is a pinned body read that rejects, a 404 and a non-JSON answer", async () => {
    for (const pinned of [
      () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: failedToFetch }),
      () => ({ ok: false, status: 404, headers: new Headers({ "content-type": "application/json" }), json: async () => ({}) }),
      () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }), json: async () => good() }),
    ]) {
      const asked = serve({ [PINNED]: pinned, [MUTABLE]: () => json(good()) });
      await expect(resolve()).resolves.toMatchObject({ buildId: "wasm64-3ab1c6a9da03bc29" });
      expect(asked).toEqual([PINNED, MUTABLE]);
      vi.unstubAllGlobals();
    }
  });

  it("when the mutable fetch rejects too, the boot fails with the mutable fetch's error: a network cause", async () => {
    serve({ [PINNED]: failedToFetch, [MUTABLE]: failedToFetch });
    const err = await resolve().catch((e: unknown) => e) as Error;
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("Failed to fetch");
    expect(failureCauseOf(err, { stage: "manifests" })).toMatchObject({ kind: "network", stage: "manifests" });
  });

  it("a pinned copy that breaks the invariant is still refused (corrupt), not replaced", async () => {
    serve({ [PINNED]: () => json({ ...good(), buildId: "wasm64-deadbeefdeadbeef" }) });
    const err = await resolve().catch((e: unknown) => e) as Error & { code?: string };
    expect(err.code).toBe("RUNTIME_MANIFEST_MISMATCH");
  });

  it("?runtime= still wins over the pinned copy", async () => {
    const other = { ...good(), buildId: "wasm64-3ab1c6a9da03bc29" };
    const asked = serve({ [PINNED]: () => json(good()), "/runtime/runtime-manifest.wasm64-1111111111111111.json": () => json(other) });
    await expect(resolve({ ...NO_OVERRIDES, runtime: "wasm64-1111111111111111" })).resolves.toBe(other);
    expect(asked).toEqual([PINNED, "/runtime/runtime-manifest.wasm64-1111111111111111.json"]);
  });
});

describe("lean.worker.js boot (the real worker source in a VM)", () => {
  type Posted = { type: string; requestId?: string; error?: { code: string; message: string; recoverable: boolean } };
  function worker() {
    const posted: Posted[] = [];
    const handlers: Array<(e: { data: unknown }) => void> = [];
    const workers = path.resolve(__dirname, "../../public/workers");
    const sandbox: Record<string, unknown> = {
      crypto, Blob, URL, WebAssembly, SharedArrayBuffer, Atomics, TextEncoder, TextDecoder, BigInt, console, performance,
      setTimeout, clearTimeout, setInterval: (fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref(); return t; }, clearInterval,
      fetch: async () => ({ ok: false, status: 404, headers: new Headers() }), // never reached by the refusal; a 404 for the control
      navigator: { locks: { request: async () => undefined, query: async () => ({ held: [], pending: [] }) } },
      crossOriginIsolated: true,
    };
    sandbox.self = sandbox;
    sandbox.postMessage = (m: unknown) => posted.push(m as Posted);
    sandbox.addEventListener = (type: string, fn: (e: { data: unknown }) => void) => { if (type === "message") handlers.push(fn); };
    sandbox.importScripts = (name: string) => vm.runInContext(readFileSync(path.join(workers, name), "utf8"), sandbox, { filename: name });
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(path.join(workers, "lean.worker.js"), "utf8"), sandbox, { filename: "lean.worker.js" });
    posted.length = 0; // drop the worker's hello ({type: "boot"}, posted at script load)
    return { posted, dispatch: (data: unknown) => { for (const h of handlers) h({ data }); } };
  }
  const boot = (runtime: RuntimeManifest) => ({ protocol: PROTOCOL, type: "boot", requestId: "r1", config: { runtime, memory: { initialBytes: 256 * 1048576, maximumCandidates: [1073741824] }, leanPath: "/lib/lean" } });

  it("refuses a manifest whose buildId is not its lean.wasm's id, before fetching anything, unrecoverably", () => {
    const w = worker();
    w.dispatch(boot({ ...good(), buildId: "wasm64-deadbeefdeadbeef" }));
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]).toMatchObject({ type: "error", requestId: "r1", error: { code: "RUNTIME_MANIFEST_MISMATCH", recoverable: false } });
    expect(w.posted[0]!.error!.message).toMatch(/'wasm64-deadbeefdeadbeef' is not the id of its own lean\.wasm \(wasm64-3ab1c6a9da03bc29\)/);
    w.dispatch(boot(good())); // dead: a second boot is refused as such, the manifest check never runs again
    expect(w.posted[1]).toMatchObject({ type: "error", error: { code: "BAD_STATE" } });
  });
  it("lets a manifest that honours the invariant through to the capability and fetch stages", async () => {
    const w = worker();
    w.dispatch(boot(good()));
    await new Promise((r) => setTimeout(r, 20));
    expect(w.posted.map((m) => m.error?.code)).not.toContain("RUNTIME_MANIFEST_MISMATCH");
    expect(w.posted.map((m) => m.error?.code)).not.toContain("INVALID_MESSAGE");
  });
});
