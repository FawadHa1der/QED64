/* QED64 edge worker: static app assets + R2-backed artifacts, one origin.
 *
 * Everything is served from the same origin so COEP needs no CORP/CORS
 * gymnastics: the app shell ships as Workers static assets (small files),
 * and the multi-hundred-MB artifacts stream from the R2 bucket bound as
 * ARTIFACTS. Cross-origin isolation headers go on every response;
 * digest-named artifacts are immutable, indexes/manifests revalidate.
 *
 * Two owners, two prefixes (decision 3, docs/DEPLOY.md "The toolchain
 * release prefix"): the Lean runtime and the library packs are the
 * lean4-wasm64 release's, uploaded once by its owner under
 * `lean4-wasm64/<release id>/` and read from there for `/runtime/*` and
 * `/profiles/*`; QED64's own pointers and products (`/profiles/index.json`,
 * `/snapshots/*`, the record's hosting.siteOwned) stay at the bucket root.
 * The browser only ever sees this origin.
 *
 * The release id and the mapping come from toolchain/lean4-wasm64-release.json,
 * the pinned record: adopting a release is committing a new record together
 * with the tracked manifests it pairs with (tests/unit/toolchain-pin.test.ts
 * pins the pairing). No wrangler var names the id, so nothing can drift; the
 * record is bundled into the Worker and checked when this module loads.
 *
 * No fallback to the bucket root (releaseFallback, the library's option, is
 * off since 2026-10-25; it was on for one deprecation cycle after decision 3):
 * every /runtime/* and /profiles/<not index.json> file a shell pinned to this
 * record asks for is in the release prefix, and the bucket root's runtime/
 * and profiles/ copies (all but profiles/index.json) were deleted the same week. A release-mapped miss is a
 * 404; every error is no-store.
 *
 * QED64's two site indexes are static assets of this deploy (D2 of the
 * 2026-10-28 architecture review, docs/DEPLOY.md "Atomic deploys"): the build
 * copies the tracked public/snapshots/index.json and public/profiles/index.json
 * into dist/, and the route below answers a GET or HEAD of exactly those paths
 * from ASSETS. A deploy, a `wrangler rollback` and a revert-and-push therefore
 * switch the shell, the release record and the indexes together, and R2 holds
 * only digest-named QED64 objects (the frozen pre-change indexes aside). Every
 * other switch is qed64/edge's hardened default (ranges, metadata HEAD, 405,
 * unsafe-key refusal, explicit lengths, asset HEAD length, no-store errors);
 * QED64_LEGACY, which this file ran until 2026-11, stays in the library,
 * frozen. The logic lives in ./edge-worker.js (a dependency-free library other
 * projects vendor; tests/unit/edge-worker.test.ts pins this file as
 * createWorker({ release }) plus its index route).
 */
import { createWorker, isImmutable } from "./edge-worker.js";
import release from "../toolchain/lean4-wasm64-release.json" with { type: "json" };

export { isImmutable };

// Exact paths, GET and HEAD only: an overlay's /snapshots/<dir>/index.json, the frozen per-build
// copies and any other method fall through to the artifact route (R2; 405 for other methods).
const DEPLOYED_INDEXES = new Set(["/snapshots/index.json", "/profiles/index.json"]);

export default createWorker({
  release,
  extraRoutes: [{
    match: (url, request) => DEPLOYED_INDEXES.has(url.pathname) && (request.method === "GET" || request.method === "HEAD"),
    handle: (request, env, ctx, kit) => kit.serveAsset(request),
  }],
});
