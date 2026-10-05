// lean4monaco 1.1.x InfoView wiring fixes (frontend/build/lean4monaco-fixes.mjs,
// docs/HARDENING.md #56), checked against the INSTALLED lean4monaco files: each
// patch finds its anchor exactly once, the patched iframe script still
// compiles, and the extracted editorApiOfRpc keeps an AbortSignal on the
// iframe side — only request ids and serialisable options cross the RPC.
//
// The files come from frontend/node_modules, which `npm ci` at the root does
// not install. A fresh clone's `npm test` skips these suites with a notice
// (as pretest skips typecheck:site); under CI they never skip, and CI must
// install the frontend before its unit step (pinned below).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
// @ts-expect-error — a plain .mjs build module without type declarations
import { LEAN4MONACO_DIR, extractEditorApiOfRpc, lean4monacoFixesEsbuild, patchInfowebviewJs, patchWebviewJs } from "../../frontend/build/lean4monaco-fixes.mjs";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(LEAN4MONACO_DIR as string, rel), "utf8");
const RPC_JS = "vscode-lean4/vscode-lean4/src/rpc.js";
const skip = !existsSync(LEAN4MONACO_DIR as string) && !process.env.CI;
if (skip) console.warn("lean4monaco-fixes.test.ts: frontend/node_modules absent — skipping the installed-file checks (run: npm --prefix frontend ci)");

describe("CI runs these checks against installed files", () => {
  it("installs frontend/node_modules before the unit step (.github/workflows/ci.yml)", () => {
    const steps = [...readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8").matchAll(/^\s*- run: (.+)$/gm)].map((m) => m[1]!);
    const install = steps.findIndex((s) => s.includes("npm ci --prefix frontend"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(steps.findIndex((s) => s.includes("vitest run tests/unit"))).toBeGreaterThan(install);
  });
});

describe.skipIf(skip)("page half (lean4monaco/dist/infowebview.js)", () => {
  it("registers the raw EditorRpcApi through the page hook, once", () => {
    const out = patchInfowebviewJs(read("infowebview.js")) as string;
    expect(out).not.toContain("rpc.register(editorApiOfRpc(editorRpcApi));");
    expect(out.match(/__qed64InfoviewEditorApi/g)?.length).toBe(2); // the typeof guard and the call
    expect(() => patchInfowebviewJs(out)).toThrow(/anchor not found/); // never applied twice silently
  });
  it("fails loudly when lean4monaco moves the anchor", () => {
    expect(() => patchInfowebviewJs("rpc.register(api);")).toThrow(/lean4monaco changed/);
  });
});

describe.skipIf(skip)("iframe half (lean4monaco/dist/webview/webview.js)", () => {
  it("wraps the RPC proxy with lean4monaco's own editorApiOfRpc, and still compiles", () => {
    const out = patchWebviewJs(read("webview/webview.js"), read(RPC_JS)) as string;
    expect(out).toContain("const a=__qed64EditorApiOfRpc(s.getApi()),");
    expect(out).toMatch(/^\/\*[^\n]*\*\/\nfunction __qed64EditorApiOfRpc\(api\) \{/);
    expect(() => new vm.Script(out)).not.toThrow();
  });

  it("editorApiOfRpc: an AbortSignal stays local; aborting cancels the request by id", async () => {
    const calls: { name: string; args: unknown[] }[] = [];
    let resolveAwait: (v: unknown) => void = () => {};
    // A stand-in for the iframe's Rpc proxy: every call is recorded and must be JSON-serialisable.
    const proxy = new Proxy({}, {
      get: (_t, name: string) => (...args: unknown[]) => {
        calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
        if (name === "startClientRequest") return Promise.resolve(17);
        if (name === "awaitClientRequest") return new Promise((r) => { resolveAwait = r; });
        return Promise.resolve(undefined);
      },
    });
    const editorApiOfRpc = vm.runInNewContext(`(${extractEditorApiOfRpc(read(RPC_JS), "f")})`);
    const api = editorApiOfRpc(proxy);
    const ac = new AbortController();
    const result = api.sendClientRequest("file:///project/Probe.lean", "$/lean/rpc/call", { x: 1 }, { abortSignal: ac.signal, autoCancel: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[0]).toEqual({ name: "startClientRequest", args: ["file:///project/Probe.lean", "$/lean/rpc/call", { x: 1 }, { autoCancel: true }] });
    expect(calls[1]).toEqual({ name: "awaitClientRequest", args: [17] });
    ac.abort();
    expect(calls.at(-1)).toEqual({ name: "cancelClientRequest", args: [17] });
    resolveAwait({ ok: true });
    await expect(result).resolves.toEqual({ ok: true });
    // The other EditorApi members are the proxy's own (forwarded by name).
    await api.applyEdit({ changes: {} });
    expect(calls.at(-1)?.name).toBe("applyEdit");
  });
});

describe.skipIf(skip)("dev pre-bundling: the page half composed with the import.meta.url loader", () => {
  // The real @codingame plugin: a catch-all `.js` onLoad that always returns
  // contents — first loader wins in esbuild, so the patch must run INSIDE it.
  const pluginPath = path.join(LEAN4MONACO_DIR as string, "../../@codingame/esbuild-import-meta-url-plugin/dist/esbuildImportMetaUrlPlugin.js");
  async function composedLoader() {
    const importMetaUrlPlugin = (await import(pluginPath)).default;
    let registered: { filter: RegExp; cb: (a: { path: string; namespace: string }) => Promise<{ contents: string }> } | null = null;
    const build = { onLoad: (opts: { filter: RegExp }, cb: never) => { registered = { filter: opts.filter, cb }; }, onResolve: () => {} };
    (lean4monacoFixesEsbuild(importMetaUrlPlugin) as { setup(b: unknown): void }).setup(build);
    return registered!;
  }
  it("patches infowebview.js AND keeps the import.meta.url asset rewrite", async () => {
    const loader = await composedLoader();
    const file = path.join(LEAN4MONACO_DIR as string, "infowebview.js");
    expect(loader.filter.test(file)).toBe(true);
    const out = (await loader.cb({ path: file, namespace: "file" })).contents;
    expect(out).toContain("__qed64InfoviewEditorApi");
    expect(out).not.toContain("rpc.register(editorApiOfRpc(editorRpcApi));");
    // The rewrite turned relative asset URLs into absolute file paths (the plugin's own effect).
    const original = readFileSync(file, "utf8");
    const rel = original.match(/new\s+URL\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url/);
    expect(rel).not.toBeNull();
    expect(out).not.toContain(`new URL('${rel![1]}', import.meta.url)`);
  });
  it("passes every other module through the wrapped loader unchanged", async () => {
    const loader = await composedLoader();
    const file = path.join(LEAN4MONACO_DIR as string, "leanmonaco.js");
    const out = (await loader.cb({ path: file, namespace: "file" })).contents;
    expect(out).not.toContain("__qed64");
  });
});
