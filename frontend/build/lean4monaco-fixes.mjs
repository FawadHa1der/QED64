// Build-time fixes for lean4monaco 1.1.x's InfoView wiring (docs/HARDENING.md #56).
//
// lean4monaco wires vscode-lean4's `editorApiOfRpc` on the wrong side of the
// InfoView iframe. Upstream (vscode-lean4) the WEBVIEW wraps the remote
// `EditorRpcApi` (startClientRequest / awaitClientRequest / cancelClientRequest)
// into the `EditorApi` the InfoView calls, keeping an AbortSignal local and
// sending only request ids across; the HOST registers the raw `EditorRpcApi`.
// lean4monaco hands the raw RPC proxy to the InfoView and wraps on the page,
// and the messages are JSON.stringify'd, so an AbortSignal arrives on the page
// as `{}`: every ProofWidgets `mk_rpc_widget%` panel (Mathlib's `conv?`, the
// SelectionPanel family, user widgets) fails with
// "r.abortSignal.addEventListener is not a function" and cancellation is lost.
//
// The two halves move together (with one changed, `startClientRequest` has no
// receiver):
//   * the iframe script (lean4monaco/dist/webview/webview.js, copied to
//     /infoview/webview.js): `const a=s.getApi()` becomes
//     `const a=__qed64EditorApiOfRpc(s.getApi())`, with `editorApiOfRpc`
//     extracted from the INSTALLED lean4monaco's own rpc.js — always the
//     version that matches the host side;
//   * the page module (lean4monaco/dist/infowebview.js):
//     `rpc.register(editorApiOfRpc(editorRpcApi))` registers the raw API,
//     through the page's optional `globalThis.__qed64InfoviewEditorApi` hook
//     (frontend/src/editor/infoview-edits.ts: applyEdit / insertText /
//     showDocument against the Monaco model — lean4monaco's editor service
//     stub throws "unsupported" for them).
// Every patch asserts its anchor occurs exactly once; a lean4monaco upgrade
// that moves an anchor fails the build instead of shipping unpatched.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const LEAN4MONACO_DIR = path.resolve(here, "../node_modules/lean4monaco/dist");

/** Replace exactly one occurrence of `anchor`, or throw naming the patch. */
function replaceOnce(code, anchor, replacement, what) {
  const first = code.indexOf(anchor);
  if (first < 0) throw new Error(`lean4monaco-fixes: ${what}: anchor not found (lean4monaco changed?): ${anchor}`);
  if (code.indexOf(anchor, first + anchor.length) >= 0) throw new Error(`lean4monaco-fixes: ${what}: anchor occurs more than once: ${anchor}`);
  return code.slice(0, first) + replacement + code.slice(first + anchor.length);
}

/** The `editorApiOfRpc` function from lean4monaco's rpc.js, as a standalone
 * declaration named `name` (balanced-brace extraction of the exported
 * function body). */
export function extractEditorApiOfRpc(rpcJs, name = "__qed64EditorApiOfRpc") {
  const head = "export function editorApiOfRpc(api) {";
  const start = rpcJs.indexOf(head);
  if (start < 0) throw new Error("lean4monaco-fixes: editorApiOfRpc not found in rpc.js (lean4monaco changed?)");
  let depth = 0;
  for (let i = start + head.length - 1; i < rpcJs.length; i++) {
    const c = rpcJs[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return `function ${name}(api) ${rpcJs.slice(start + head.length - 1, i + 1)}`;
    }
  }
  throw new Error("lean4monaco-fixes: unbalanced editorApiOfRpc in rpc.js");
}

/** The iframe half: wrap the RPC proxy before the InfoView sees it. */
export function patchWebviewJs(webviewJs, rpcJs) {
  const wrapper = extractEditorApiOfRpc(rpcJs);
  const patched = replaceOnce(webviewJs, "const a=s.getApi(),", "const a=__qed64EditorApiOfRpc(s.getApi()),", "webview.js editor API");
  return `/* QED64 (HARDENING #56): the InfoView gets editorApiOfRpc(rpc proxy), as upstream vscode-lean4. */\n${wrapper}\n${patched}`;
}

/** The page half: register the raw EditorRpcApi (through the page's hook). */
export function patchInfowebviewJs(code) {
  return replaceOnce(
    code,
    "rpc.register(editorApiOfRpc(editorRpcApi));",
    "rpc.register(typeof globalThis.__qed64InfoviewEditorApi === \"function\" ? globalThis.__qed64InfoviewEditorApi(editorRpcApi) : editorRpcApi); /* QED64 (HARDENING #56) */",
    "infowebview.js register",
  );
}

const isInfowebview = (id) => /[\\/]lean4monaco[\\/]dist[\\/]infowebview\.js(\?.*)?$/.test(id);

/** Vite plugin: the page half when Rollup/Vite processes the module (build). */
export function lean4monacoFixesVite() {
  return {
    name: "qed64-lean4monaco-fixes",
    enforce: "pre",
    transform(code, id) {
      return isInfowebview(id) ? { code: patchInfowebviewJs(code), map: null } : null;
    },
  };
}

/** esbuild plugin for Vite's dependency pre-bundling (dev): the page half,
 * COMPOSED with an existing catch-all `.js` loader. `@codingame/esbuild-import-
 * meta-url-plugin` registers `onLoad({filter: /.*\.js$/})` and always returns
 * contents; in esbuild the first loader that returns contents wins, so a
 * separate fixes plugin listed after it never runs (and listed before it, the
 * file would miss its `new URL(…, import.meta.url)` rewrite — infowebview.js
 * has two). This captures that plugin's loader and patches its output for the
 * one module. */
export function lean4monacoFixesEsbuild(importMetaUrlPlugin) {
  return {
    name: "qed64-import-meta-url+lean4monaco-fixes",
    setup(build) {
      let innerFilter = null;
      let inner = null;
      importMetaUrlPlugin.setup({
        ...build,
        onLoad: (opts, cb) => {
          if (inner) throw new Error("lean4monaco-fixes: the wrapped esbuild plugin registers more than one onLoad");
          innerFilter = opts;
          inner = cb;
        },
      });
      if (!inner) throw new Error("lean4monaco-fixes: the wrapped esbuild plugin registers no onLoad");
      build.onLoad(innerFilter, async (args) => {
        const r = await inner(args);
        if (!isInfowebview(args.path)) return r;
        const contents = typeof r?.contents === "string" ? r.contents : readFileSync(args.path, "utf8");
        return { ...(r ?? {}), contents: patchInfowebviewJs(contents) };
      });
    },
  };
}

/** vite-plugin-static-copy transform for the copied iframe script. */
export const webviewCopyTransform = {
  encoding: "utf8",
  handler: (content) => patchWebviewJs(content, readFileSync(path.join(LEAN4MONACO_DIR, "vscode-lean4/vscode-lean4/src/rpc.js"), "utf8")),
};
