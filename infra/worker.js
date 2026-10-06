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
 * releaseFallback (one deprecation cycle): a release-mapped miss retries the
 * bucket root once, where older shells' per-build manifests and the
 * pre-decision-3 uploads live. Release-mapped errors are never cached.
 *
 * The logic lives in ./edge-worker.js (a dependency-free library other
 * projects vendor). Every other switch is QED64_LEGACY's, the pre-library
 * worker's behaviour (tests/unit/edge-worker.test.ts pins site-owned paths
 * and assets against tests/fixtures/edge-worker/); moving to the hardened
 * defaults is a separate decision: docs/DEPLOY.md, "Reusing the edge worker".
 */
import { createWorker, isImmutable, QED64_LEGACY } from "./edge-worker.js";
import release from "../toolchain/lean4-wasm64-release.json" with { type: "json" };

export { isImmutable };

export default createWorker({ ...QED64_LEGACY, release, releaseFallback: true });
