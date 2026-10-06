// What a page URL boots, and a JSON fetch that refuses an SPA fallback: the
// two helpers preflight.mjs shares with the adversarial harness
// (tests/adversarial/harness.mjs re-exports them), so preflight ships in the
// package without the test tree. Node built-ins and Fetch API globals only.

/** The one transport the page speaks (the pump was removed at the page level
 * on 2026-09-04); kept as a field so run directories and reports stay shaped. */
export const MODE = "resident";

/** What a page at `url` will boot: manifest and snapshot-index URLs, mode
 * (the same ?runtime= / ?snapshots= / ?profiles= rules as qed64-boot.ts). */
export function resolveTarget(url) {
  const u = new URL(url);
  const runtimeOverride = u.searchParams.get("runtime");
  const snapshotsDir = u.searchParams.get("snapshots") || "snapshots";
  const profilesDir = u.searchParams.get("profiles") || "profiles";
  const mode = MODE;
  return {
    url: u.toString(),
    origin: u.origin,
    mode,
    runtimeOverride,
    snapshotsDir,
    profilesDir,
    manifestUrl: `${u.origin}/runtime/runtime-manifest${runtimeOverride ? `.${runtimeOverride}` : ""}.json`,
    indexUrl: `${u.origin}/${snapshotsDir}/index.json`,
    profilesUrl: `${u.origin}/${profilesDir}/index.json`,
  };
}

/** GET a JSON document; throws with a one-line reason on any failure
 * (status, content type, parse) so callers can classify it as infra. */
export async function fetchJson(url, timeoutMs = 15000) {
  const r = await fetch(url, { cache: "no-cache", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const ct = r.headers.get("content-type") ?? "";
  const text = await r.text();
  // Vite's SPA fallback answers every unknown path with index.html (200,
  // text/html) — the exact shape that let a whole gate run unbootable.
  if (/text\/html/i.test(ct) || /^\s*<!doctype html/i.test(text)) throw new Error(`${url}: served HTML (SPA fallback), not JSON`);
  try { return JSON.parse(text); } catch (e) { throw new Error(`${url}: not JSON (${String(e).slice(0, 60)})`); }
}
