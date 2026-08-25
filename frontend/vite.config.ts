import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";

// The lean4web-style front end for QED64: lean4monaco (Monaco + vscode-lean4
// InfoView) speaking LSP to the in-browser wasm64 Lean file worker instead of
// a WebSocket server. Artifacts (runtime chunks, profile packs, workers) are
// served from the main app's public/ directory.
export default defineConfig({
  publicDir: "../public",
  server: {
    port: Number(process.env.PORT) || 5184,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: { allow: [".."] },
    watch: { ignored: ["**/public/profiles/**", "**/public/runtime/**", "**/public/snapshots/**"] },
  },
  optimizeDeps: {
    esbuildOptions: { plugins: [importMetaUrlPlugin] },
  },
  plugins: [
    nodePolyfills({ overrides: { fs: "memfs" } }),
    viteStaticCopy({
      targets: [
        // The InfoView iframe loads /infoview/index.css + /infoview/webview.js
        // from the server root (see lean4monaco's infowebview.ts).
        { src: "node_modules/@leanprover/infoview/dist/*", dest: "infoview" },
        { src: "node_modules/lean4monaco/dist/webview/webview.js", dest: "infoview" },
        { src: "node_modules/@leanprover/infoview/dist/codicon.ttf", dest: "assets" },
      ],
    }),
  ],
});
