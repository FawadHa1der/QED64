/* QED64 edge worker: static app assets + R2-backed artifacts, one origin.
 *
 * Everything is served from the same origin so COEP needs no CORP/CORS
 * gymnastics: the app shell ships as Workers static assets (small files),
 * and the multi-hundred-MB artifacts (runtime chunks, profile packs,
 * snapshots) stream from an R2 bucket bound as ARTIFACTS. Cross-origin
 * isolation headers go on every response; digest-named artifacts are
 * immutable, indexes/manifests revalidate.
 *
 * The logic lives in ./edge-worker.js (a dependency-free library other
 * projects vendor); QED64 runs it with QED64_LEGACY, which reproduces this
 * worker's pre-library behaviour byte for byte (pinned by
 * tests/unit/edge-worker.test.ts against tests/fixtures/edge-worker/).
 * Moving to the hardened defaults is a separate decision: docs/DEPLOY.md,
 * "Reusing the edge worker".
 */
import { createWorker, isImmutable, QED64_LEGACY } from "./edge-worker.js";

export { isImmutable };

export default createWorker(QED64_LEGACY);
