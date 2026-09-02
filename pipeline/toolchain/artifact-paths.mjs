// Artifact discipline shared by every producer (chunk-runtime, bake-snapshot)
// and the promote step — review C6 / migration phase 1:
//   - ONE runtime identity function (`wasm64-<sha256(lean.wasm)[:16]>`), so a
//     bake stamps the same `runtime` into its index entries that the chunker
//     writes into the manifest, and the worker can refuse an unpaired load;
//   - producers stage under work/staging/<buildId>/ and hard-error on any
//     --out that resolves inside public/ (HARDENING #32: the chunker once
//     destroyed the served chunks); only promote writes public/, additively.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The runtime buildId as chunk-runtime.mjs has always computed it. */
export function runtimeBuildId(wasmBytes) {
  return `wasm64-${createHash("sha256").update(wasmBytes).digest("hex").slice(0, 16)}`;
}

/** Read lean.wasm from a stage1-style artifact dir (`<dir>/bin/lean.wasm`) or a
 * bin dir (`<dir>/lean.wasm`) and return its buildId; null when absent. */
export function buildIdOfArtifact(dir) {
  for (const candidate of [path.join(dir, "bin/lean.wasm"), path.join(dir, "lean.wasm")]) {
    if (fs.existsSync(candidate)) return runtimeBuildId(fs.readFileSync(candidate));
  }
  return null;
}

/** work/staging/<buildId>/<kind> — the producers' default output. */
export function stagingDir(root, buildId, kind) {
  return path.join(root, "work/staging", buildId, kind);
}

/** True when `target` is public/ itself or anything beneath it. Symlinks are
 * resolved as far as they exist so `public/snapshots-0031 -> ../work/...` and
 * a symlink INTO public/ are both judged by where the bytes would land. */
export function isInsidePublic(root, target) {
  const publicDir = realpathAsFar(path.resolve(root, "public"));
  const resolved = realpathAsFar(path.resolve(target));
  return resolved === publicDir || resolved.startsWith(publicDir + path.sep);
}

function realpathAsFar(p) {
  // realpath of the deepest existing ancestor + the remaining segments, so a
  // not-yet-created output dir is still resolved through existing symlinks.
  let head = p;
  const tail = [];
  while (!fs.existsSync(head)) {
    tail.unshift(path.basename(head));
    const parent = path.dirname(head);
    if (parent === head) return p;
    head = parent;
  }
  return path.join(fs.realpathSync(head), ...tail);
}

/** Exit 2 with a one-line reason when a producer would write into public/. */
export function refuseInsidePublic(root, target, who) {
  if (!isInsidePublic(root, target)) return;
  console.error(`${who}: refusing --out ${target}: it resolves inside public/. ` +
    "Producers stage under work/staging/<buildId>/; use `npm run promote:staging` to publish (HARDENING #32).");
  process.exit(2);
}
