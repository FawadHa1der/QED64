/* QED64 Memory64 probe: the one source of the probe bytes (docs/EMBEDDING.md §7.0).
 *
 * Two consumers load this same file: the classic Lean worker
 * (`importScripts("memory64-probe.js")`, for its capabilities report) and the
 * page library (`lib/client.ts`, `import "…/memory64-probe.js"`, a
 * side-effect import that `qed64/embed` re-exports as MEMORY64_PROBE and
 * probeMemory64). Like lsp-frames.js it therefore uses no `export` and no
 * `require`: it publishes itself as `globalThis.Qed64Memory64`, valid in a
 * classic worker script AND as an ES module (package.json "type": "module";
 * package.json `sideEffects` names this file so a bundler keeps the import).
 *
 * The module: the wasm header and one memory section whose limits flags are
 * 0x04 (memory64), minimum 0. `WebAssembly.validate` accepts it exactly when
 * the engine speaks Memory64. Fixed shape: non-extensible and of fixed length
 * (a typed array with elements cannot be frozen), so treat the bytes as
 * read-only and `.slice()` a copy before changing anything.
 */
"use strict";

(function (root) {
  const MEMORY64_PROBE = Object.preventExtensions(Uint8Array.of(
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x05, 0x03, 0x01, 0x04, 0x00, // memory section: flags 0x04 (memory64), min 0
  ));

  /** Fast local probe, callable before any Worker spawn: validates MEMORY64_PROBE. */
  function probeMemory64() {
    try {
      return typeof WebAssembly === "object" && WebAssembly.validate(MEMORY64_PROBE);
    } catch {
      return false;
    }
  }

  // REVISION: see lsp-frames.js (the worker scripts move together; lean.worker.js
  // refuses a sibling of another revision, WORKER_DEP_MISMATCH).
  root.Qed64Memory64 = Object.freeze({ MEMORY64_PROBE, probeMemory64, REVISION: "1" });
})(globalThis);
