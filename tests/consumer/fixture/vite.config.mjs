// Built by tests/consumer/check-consumer.mjs from a COPY of this directory, beside node_modules/qed64 → the
// extracted `npm pack` tarball. A plain object (no `vite` import): the consumer has no node_modules of its own.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export default {
  root: here,
  cacheDir: path.join(here, ".vite-cache"),
  logLevel: "warn",
  build: {
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: { index: path.join(here, "index.html"), worker: path.join(here, "worker.ts") },
      preserveEntrySignatures: "strict",
      output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
    },
  },
};
