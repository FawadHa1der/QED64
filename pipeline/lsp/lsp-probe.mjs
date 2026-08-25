#!/usr/bin/env node
// Feasibility probe: drive the wasm64 Lean binary in `--worker` (LSP file
// worker) mode under Node with a scripted JSON-RPC conversation on stdin,
// capturing framed LSP output from stdout byte callbacks.
//
// This answers the decisive question for reusing the lean4web front end with
// our toolchain: does Lean's own language-server code (FileWorker: header
// processing, incremental elaboration, publishDiagnostics) execute under
// wasm64 at all? Interactive transports come later; here the whole client
// side of the conversation is precomputed.
//
// Usage:
//   node --stack-size=8192 pipeline/lsp/lsp-probe.mjs [--artifact <dir>] [--lib <dir>] [--source <file.lean>] [--budget-ms 120000]

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const builtHere = path.join(repoRoot, "pipeline/toolchain/work/build/stage1");
const artifactDir = path.resolve(arg("artifact", process.env.QED64_LEAN_ARTIFACT || builtHere));
const libLean = arg("lib", null) ? path.resolve(arg("lib")) : path.join(artifactDir, "lib/lean");
const budgetMs = Number(arg("budget-ms", "120000"));
const sourcePath = arg("source", null);
const source = sourcePath
  ? fs.readFileSync(sourcePath, "utf8")
  : "theorem probe (n : Nat) : n + 0 = n := by simp\n#check probe\nexample : False := sorry\n";

const leanJs = path.join(artifactDir, "bin/lean.js");
if (!fs.existsSync(leanJs) || !fs.existsSync(libLean)) {
  console.error(`error: need ${leanJs} and ${libLean}`);
  process.exit(2);
}

// ---- The scripted client side of the conversation -------------------------
const frame = (obj) => {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
};

const uri = "untitled:/probe.lean"; // untitled ⇒ setupFile takes the noLakefile path, no lake spawn
const script = Buffer.concat([
  frame({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      processId: null,
      rootUri: null,
      capabilities: {},
      initializationOptions: { hasWidgets: false },
    },
  }),
  frame({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "lean4", version: 1, text: source },
    },
  }),
  frame({
    jsonrpc: "2.0",
    id: 2,
    method: "textDocument/waitForDiagnostics",
    params: { uri, version: 1 },
  }),
]);
let scriptPos = 0;
let holdOpen = true; // after the script, stall stdin (no EOF) until we've seen enough

// ---- Output capture: parse Content-Length frames from stdout bytes --------
let outBuf = Buffer.alloc(0);
const messages = [];
const t0 = Date.now();
const log = (s) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

function pumpFrames() {
  for (;;) {
    const headerEnd = outBuf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = outBuf.slice(0, headerEnd).toString("ascii");
    const m = /Content-Length: (\d+)/i.exec(header);
    if (!m) {
      outBuf = outBuf.slice(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (outBuf.length < start + len) return;
    const body = outBuf.slice(start, start + len).toString("utf8");
    outBuf = outBuf.slice(start + len);
    try {
      const msg = JSON.parse(body);
      messages.push(msg);
      const kind = msg.method || (msg.id !== undefined ? `response#${msg.id}` : "?");
      let detail = "";
      if (msg.method === "textDocument/publishDiagnostics") {
        detail = ` (${msg.params.diagnostics.length} diagnostics)`;
        for (const d of msg.params.diagnostics) {
          detail += `\n    [${d.severity}] ${d.range.start.line}:${d.range.start.character} ${String(d.message).slice(0, 90).replace(/\n/g, " ⏎ ")}`;
        }
      }
      log(`<= ${kind}${detail}`);
      maybeFinish();
    } catch {
      log(`<= unparseable frame (${len} bytes)`);
    }
  }
}

// Success = the wait-for-diagnostics response arrived (elaboration finished)
// AND we saw a publishDiagnostics carrying the expected sorry warning.
function maybeFinish() {
  const gotWaitResponse = messages.some((m) => m.id === 2 && !("method" in m));
  const gotSorry = messages.some(
    (m) =>
      m.method === "textDocument/publishDiagnostics" &&
      m.params.diagnostics.some((d) => /sorry/.test(String(d.message))),
  );
  if (gotWaitResponse && gotSorry) {
    log("LSP PROBE PASS: worker elaborated the document and answered waitForDiagnostics");
    process.exit(0);
  }
}

setTimeout(() => {
  log(`LSP PROBE TIMEOUT after ${budgetMs} ms — ${messages.length} messages received`);
  process.exit(messages.length > 0 ? 4 : 5);
}, budgetMs).unref?.() ?? undefined;

// ---- Emscripten module setup ---------------------------------------------
process.chdir("/");
process.argv[1] = "/bin/lean";

globalThis.Module = {
  arguments: ["--worker"],
  locateFile: (file) => path.join(path.dirname(leanJs), file),
  mainScriptUrlOrBlob: leanJs,
  preRun: [
    function hookStdio() {
      const FS = globalThis.Module.FS;
      const NODEFS = FS.filesystems.NODEFS;
      const mkdirTree = (p) => {
        let cur = "";
        for (const part of p.split("/").filter(Boolean)) {
          cur += `/${part}`;
          try {
            FS.mkdir(cur);
          } catch {}
        }
      };
      for (const dir of ["/lib/lean", "/bin", "/workspace"]) mkdirTree(dir);
      FS.mount(NODEFS, { root: libLean }, "/lib/lean");
      globalThis.Module.ENV.LEAN_PATH = "/lib/lean";

      // Byte-level stdio: input feeds the precomputed script; when it runs
      // dry we spin briefly (returning bytes one at a time as available)
      // and finally EOF only after the budget forces us to. Output/error
      // callbacks receive single charcodes.
      FS.init(
        function stdin() {
          if (scriptPos < script.length) return script[scriptPos++];
          if (holdOpen) {
            // No more scripted input. Returning null means EOF; the worker
            // would exit before elaboration finishes. There is no EAGAIN in
            // FS.init, so this is the experiment: hold the read by busy
            // yielding — if Emscripten re-polls the callback, elaboration
            // tasks may still progress on pthreads.
            return null; // (observed behavior recorded by the probe output)
          }
          return null;
        },
        function stdout(code) {
          if (code === null || code === undefined) return;
          outBuf = Buffer.concat([outBuf, Buffer.from([code])]);
          pumpFrames();
        },
        function stderr(code) {
          if (code === null || code === undefined) return;
          process.stderr.write(Buffer.from([code]));
        },
      );
    },
  ],
  onExit: (code) => {
    log(`worker exited with code ${code}; ${messages.length} LSP messages received`);
  },
  onAbort: (what) => {
    log(`ABORT: ${what}`);
    process.exit(3);
  },
};

globalThis.require = createRequire(leanJs);
globalThis.__filename = "/bin/lean.js";
globalThis.__dirname = "/bin";

log(`starting lean --worker (source: ${sourcePath || "inline probe"}, ${source.length} bytes)`);
vm.runInThisContext(fs.readFileSync(leanJs, "utf8"), { filename: leanJs });
