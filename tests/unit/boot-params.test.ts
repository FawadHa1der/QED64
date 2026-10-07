// Boot parameters (lib/params.ts; docs/EMBEDDING.md §4): the
// `?snapshots=` / `?profiles=` / `?runtime=` overrides are spliced into
// artifact URLs, so every spelling that leaves the origin must be refused —
// `/attacker.example/x` is protocol-relative once prefixed with "/" — and a
// refusal must fail the boot BEFORE any fetch, naming the parameter.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BootParamError, EDIT_HOLD_MAX_FREE_WORKERS, parseBootParams, parseEditHoldParam, validateBootOverrides } from "../../lib/params";
import { installArtifacts, type StatusSink } from "../../lib/qed64-boot";

const ORIGIN = "http://localhost:5199";

describe("parseBootParams", () => {
  it("accepts the spellings in use (harness, showcase, staged profiles)", () => {
    expect(parseBootParams("?runtime=wasm64-464463c696d9aa2d&snapshots=snapshots-0031&profiles=profiles-staged", ORIGIN)).toEqual({
      runtime: "wasm64-464463c696d9aa2d", snapshots: "snapshots-0031", profiles: "profiles-staged",
    });
    expect(parseBootParams("?snapshots=snapshots/widgets8", ORIGIN).snapshots).toBe("snapshots/widgets8");
    expect(parseBootParams("?profiles=profiles/next", ORIGIN).profiles).toBe("profiles/next");
    expect(parseBootParams("", ORIGIN)).toEqual({ runtime: null, snapshots: null, profiles: null });
    expect(parseBootParams("?snapshots=&runtime=", ORIGIN)).toEqual({ runtime: null, snapshots: null, profiles: null });
  });

  it.each([
    ["/attacker.example/x", "protocol-relative once prefixed"],
    ["//attacker.example/x", "protocol-relative"],
    ["https://attacker.example/x", "absolute URL"],
    ["%2F%2Fattacker.example", "decoded to //attacker.example"],
    ["\\\\attacker.example\\x", "backslashes (URL parsers treat them as slashes)"],
    ["..", "parent directory"],
    ["../profiles", "traversal"],
    ["snapshots/../x", "traversal under the prefix"],
    ["snapshots/a/b", "two segments under the prefix"],
    ["a/b", "foreign prefix"],
    [".hidden", "leading dot"],
    ["x".repeat(65), "too long"],
    ["a b", "whitespace"],
    ["snapshots/", "empty segment"],
  ])("refuses ?snapshots=%s (%s)", (value) => {
    const search = `?snapshots=${encodeURIComponent(value).replace(/%25/g, "%")}`;
    expect(() => parseBootParams(search, ORIGIN)).toThrow(BootParamError);
    try { parseBootParams(search, ORIGIN); } catch (e) {
      expect((e as BootParamError).param).toBe("snapshots");
      expect((e as BootParamError).code).toBe("BOOT_PARAM_REFUSED");
      expect((e as Error).message).toMatch(/^refused \?snapshots=/);
    }
  });

  it("applies the same rule to ?profiles= (its own prefix only)", () => {
    expect(() => parseBootParams("?profiles=/attacker.example/p", ORIGIN)).toThrow(/refused \?profiles=/);
    expect(() => parseBootParams("?profiles=snapshots/x", ORIGIN)).toThrow(/refused \?profiles=/);
  });

  it("refuses a ?runtime= that is not a build id", () => {
    for (const bad of ["../x", "wasm64-XYZ", "wasm64-464463c696d9aa2", "wasm64-464463c696d9aa2d0", "/evil/x", "wasm64-464463c696d9aa2d/../../x"]) {
      expect(() => parseBootParams(`?runtime=${encodeURIComponent(bad)}`, ORIGIN), bad).toThrow(/refused \?runtime=/);
    }
  });

  it("validates programmatic overrides by the same rules", () => {
    expect(validateBootOverrides({ snapshots: "snapshots/widgets8" }, ORIGIN)).toEqual({ snapshots: "snapshots/widgets8", profiles: null, runtime: null });
    expect(() => validateBootOverrides({ snapshots: "//evil.example/x" }, ORIGIN)).toThrow(BootParamError);
  });
});

describe("parseEditHoldParam (?edithold=, docs/EMBEDDING.md §4, §7.8)", () => {
  it("accepts a whole number of free Workers from 0 (the hold off) to 24, unset or empty as null, and refuses everything else by name", () => {
    expect(parseEditHoldParam("")).toBeNull();
    expect(parseEditHoldParam("?memory=2")).toBeNull();
    expect(parseEditHoldParam("?edithold=")).toBeNull();
    expect(parseEditHoldParam("?edithold=0")).toBe(0);
    expect(parseEditHoldParam("?edithold=6")).toBe(6);
    expect(parseEditHoldParam("?edithold=24")).toBe(24);
    expect(EDIT_HOLD_MAX_FREE_WORKERS).toBe(24);
    for (const bad of ["25", "-1", "6.5", "06", "1e1", "6;DROP TABLE", "0x6", "six", " 6", "99999999999999999999", "../x", "6\n", "true"]) {
      expect(() => parseEditHoldParam(`?edithold=${encodeURIComponent(bad)}`), bad).toThrow(/^refused \?edithold=/);
      expect(() => parseEditHoldParam(`?edithold=${encodeURIComponent(bad)}`), bad).toThrow(BootParamError);
    }
  });
});

describe("installArtifacts refuses before fetching", () => {
  afterEach(() => vi.unstubAllGlobals());
  const sink = (): StatusSink => ({ busy: vi.fn(), progress: vi.fn(), idle: vi.fn() });

  it("a foreign ?snapshots= fails the boot with no request sent", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { search: "?snapshots=/attacker.example/x", origin: ORIGIN });
    await expect(installArtifacts(sink())).rejects.toThrow(/refused \?snapshots=/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("overrides: \"none\" ignores the URL entirely", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(String(u)); return new Response("not found", { status: 404 }); }));
    vi.stubGlobal("location", { search: "?snapshots=/attacker.example/x&profiles=//evil", origin: ORIGIN });
    await expect(installArtifacts(sink(), { overrides: "none" })).rejects.toThrow(); // the 404 profile index, not the parameters
    expect(urls[0]).toBe("/profiles/index.json");
  });

  it("a programmatic override re-roots the profile index on this origin", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(String(u)); return new Response("not found", { status: 404 }); }));
    vi.stubGlobal("location", { search: "", origin: ORIGIN });
    await expect(installArtifacts(sink(), { overrides: { profiles: "profiles-staged" } })).rejects.toThrow();
    expect(urls[0]).toBe("/profiles-staged/index.json");
  });
});
