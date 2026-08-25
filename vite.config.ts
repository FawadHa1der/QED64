import { defineConfig } from "vite";

// COOP/COEP are mandatory: the Lean runtime is an Emscripten pthread build over
// a shared WebAssembly Memory64 memory, and SharedArrayBuffer requires a
// cross-origin-isolated page. Every response (dev and preview) carries them.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: {
    // Honor a harness-assigned port (e.g. Claude Code preview) when present.
    ...(process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : {}),
    headers: isolationHeaders,
    // The profile packs are ~1.1 GB of static parts; keep watch away from them.
    watch: { ignored: ["**/public/profiles/**", "**/public/runtime/**"] },
  },
  preview: { headers: isolationHeaders },
  build: {
    target: "es2022",
    // Large static payloads live in public/; the app bundle itself is small.
    chunkSizeWarningLimit: 1500,
  },
  // Workers under public/ are plain scripts fetched at runtime — never bundled,
  // because the Emscripten glue must be importScripts-able at global scope.
});
