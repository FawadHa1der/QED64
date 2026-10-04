// The boot parameters an embedder or a developer may set (docs/EMBEDDING.md §4,
// §7.6), parsed and VALIDATED in one place.
//
// `?snapshots=<dir>` / `?profiles=<dir>` re-root artifact fetches under
// `/<dir>/` and `?runtime=<buildId>` picks an unpromoted runtime manifest.
// Spliced into a URL unchecked, `?snapshots=/attacker.example/x` is
// protocol-relative (`//attacker.example/x/index.json`): the page would boot an
// environment from another origin, and Lean widget modules in it run in the
// same-origin InfoView iframe with the page's storage. So a directory must be
// one plain path segment (optionally under the promoted dir's own name), it
// must resolve on this origin, and a refused value is a boot failure that
// names the parameter — never a silent fallback to the served set.
//
// Pure (no `location`, no DOM): the page passes its own search string and
// origin; unit-tested under node.

/** Validated overrides; `null` = not set. */
export interface BootOverrides {
  snapshots: string | null;
  profiles: string | null;
  runtime: string | null;
}

export class BootParamError extends Error {
  readonly code = "BOOT_PARAM_REFUSED";
  constructor(readonly param: keyof BootOverrides, readonly value: string, why: string) {
    super(`refused ?${param}=${JSON.stringify(value).slice(1, -1).slice(0, 80)}: ${why}`);
    this.name = "BootParamError";
  }
}

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const DIR_RULES: Record<"snapshots" | "profiles", RegExp> = {
  snapshots: new RegExp(`^(?:snapshots/)?${SEGMENT}$`),
  profiles: new RegExp(`^(?:profiles/)?${SEGMENT}$`),
};
const RUNTIME_RULE = /^wasm64-[0-9a-f]{16}$/;

function dir(param: "snapshots" | "profiles", value: string, origin: string): string {
  if (!DIR_RULES[param].test(value)) {
    throw new BootParamError(param, value, `expected a directory name on this site (${DIR_RULES[param].source})`);
  }
  // Belt and braces: the rule above already excludes every spelling that
  // leaves the origin; the resolved URL is checked anyway.
  let resolved: URL;
  try { resolved = new URL(`/${value}/index.json`, origin); } catch { throw new BootParamError(param, value, "not a URL path"); }
  if (resolved.origin !== new URL(origin).origin) throw new BootParamError(param, value, `resolves to ${resolved.origin}, not this site`);
  return value;
}

/** Validate overrides given programmatically or parsed from a URL. Empty strings count as unset. */
export function validateBootOverrides(given: Partial<Record<keyof BootOverrides, string | null | undefined>>, origin: string): BootOverrides {
  const s = given.snapshots || null;
  const p = given.profiles || null;
  const r = given.runtime || null;
  if (r !== null && !RUNTIME_RULE.test(r)) throw new BootParamError("runtime", r, `expected a runtime build id (${RUNTIME_RULE.source})`);
  return {
    snapshots: s === null ? null : dir("snapshots", s, origin),
    profiles: p === null ? null : dir("profiles", p, origin),
    runtime: r,
  };
}

/** `?snapshots=`, `?profiles=`, `?runtime=` from a location search string, validated. */
export function parseBootParams(search: string, origin: string): BootOverrides {
  const q = new URLSearchParams(search);
  return validateBootOverrides({ snapshots: q.get("snapshots"), profiles: q.get("profiles"), runtime: q.get("runtime") }, origin);
}

export const NO_OVERRIDES: BootOverrides = Object.freeze({ snapshots: null, profiles: null, runtime: null });
