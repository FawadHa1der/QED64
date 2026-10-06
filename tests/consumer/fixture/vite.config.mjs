// Built by tests/consumer/check-consumer.mjs from a COPY of this directory, beside node_modules/qed64 → the
// extracted `npm pack` tarball. A plain object (no `vite` import): the consumer has no node_modules of its own.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// The two settings docs/EMBEDDING.md §6.1 asks of a consumer's Vite config (the build below never serves).
const crossOriginIsolation = {
  name: "cross-origin-isolation",
  configureServer(server) { server.middlewares.use(isolate); },
  configurePreviewServer(server) { server.middlewares.use(isolate); },
};
function isolate(_req, res, next) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
}
export default {
  root: here,
  plugins: [crossOriginIsolation],
  optimizeDeps: { exclude: ["qed64"] },
  cacheDir: path.join(here, ".vite-cache"),
  logLevel: "warn",
  build: {
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: { index: path.join(here, "index.html"), headless: path.join(here, "headless.ts"), worker: path.join(here, "worker.ts") },
      preserveEntrySignatures: "strict",
      output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
    },
  },
};
