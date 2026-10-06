import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import { readFileSync, realpathSync } from "node:fs";
// lean4monaco 1.1.x InfoView wiring fixes (HARDENING #56): page half (transform + dev pre-bundle) and iframe half (copy transform).
import { lean4monacoFixesEsbuild, lean4monacoFixesVite, webviewCopyTransform } from "./build/lean4monaco-fixes.mjs";
// dist/qed64-build.json: the shell's identity (docs/EMBEDDING.md §4; embedApiRevision: §7).
import { buildInfoPlugin } from "./build/build-info.mjs";

// The runtime this shell is PAIRED with (see docs/DEPLOY.md, "Atomic
// promotes"): the shell first asks for the immutable, digest-named manifest
// of this exact build and only falls back to the mutable path, so deploying
// a new shell never races the mutable manifest switch in R2.
// The dev server may serve only the repository, but Vite resolves a module to
// its REAL path: when node_modules is a symlink (a git worktree sharing one
// install, a pnpm store), lean4monaco's extension files live outside the root
// and came back 403, so the editor never started and every boot stalled at
// "starting". Allow where each install really is.
const realInstalls = ["./node_modules", "../node_modules"].flatMap((rel) => {
  try { return [realpathSync(new URL(rel, import.meta.url))]; } catch { return []; }
});

const pairedBuildId = JSON.parse(
  readFileSync(new URL("../public/runtime/runtime-manifest.json", import.meta.url), "utf8"),
).buildId as string;

// The lean4web-style front end for QED64: lean4monaco (Monaco + vscode-lean4
// InfoView) speaking LSP to the in-browser wasm64 Lean file worker instead of
// a WebSocket server.
//
// Dev: artifacts (runtime chunks, profile packs, snapshots) are served from
// the repo's public/ directory via publicDir.
// Build: this IS the deployed app shell — it builds into the repo-root dist/
// that `wrangler deploy` ships as Workers assets. Artifacts must NOT be in
// the bundle (they stream from R2, same-origin, via infra/worker.js), so
// publicDir is off and only the worker scripts are copied in. All runtime
// paths are root-absolute (/infoview/*, /workers/*, /runtime/* …), so the
// shell must stay mounted at the origin root.
export default defineConfig(({ command }) => ({
  publicDir: command === "serve" ? "../public" : false,
  define: { __QED64_BUILD_ID__: JSON.stringify(pairedBuildId) },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.PORT) || 5184,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: { allow: ["..", ...realInstalls] },
    watch: { ignored: ["**/public/profiles/**", "**/public/runtime/**", "**/public/snapshots/**"] },
  },
  optimizeDeps: {
    // One composed loader: the import.meta.url rewrite, then the page-half patch (see lean4monaco-fixes.mjs).
    esbuildOptions: { plugins: [lean4monacoFixesEsbuild(importMetaUrlPlugin)] },
  },
  plugins: [
    lean4monacoFixesVite(),
    buildInfoPlugin({
      manifestUrl: new URL("../public/runtime/runtime-manifest.json", import.meta.url),
      pageApiUrl: new URL("./src/page-api.ts", import.meta.url),
      embedApiUrl: new URL("./src/embed/index.ts", import.meta.url),
      repoDir: new URL("..", import.meta.url), // a URL, as above: .pathname is percent-encoded ("Lean%20Projects")
    }),
    nodePolyfills({ overrides: { fs: "memfs" } }),
    viteStaticCopy({
      targets: [
        // The InfoView iframe loads /infoview/index.css + /infoview/webview.js
        // from the server root (see lean4monaco's infowebview.ts).
        { src: "node_modules/@leanprover/infoview/dist/*", dest: "infoview" },
        { src: "node_modules/lean4monaco/dist/webview/webview.js", dest: "infoview", transform: webviewCopyTransform },
        { src: "node_modules/@leanprover/infoview/dist/codicon.ttf", dest: "assets" },
        // The Lean session worker (and its snapshot prefetch helper) load from
        // /workers/* — served by publicDir in dev, so copy them only for the
        // production bundle.
        { src: "../public/workers/*", dest: "workers" },
      ],
    }),
  ],
}));
