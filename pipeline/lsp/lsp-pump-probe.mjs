#!/usr/bin/env node
// Stage-1 evidence for the lean4web-frontend plan: drive the wasm64 Lean
// FILE WORKER through the host-pumped exports (`lean_wasm_lsp_init` /
// `lean_wasm_lsp_send`, toolchain patch 0018) and verify a real LSP
// conversation end to end — didOpen elaboration, publishDiagnostics,
// waitForDiagnostics, and an interactive $/lean/rpc goals request (the call
// the vscode-lean4 InfoView lives on).
//
// Unlike `lsp-probe.mjs` (callMain --worker, blocking stdin), the pump keeps
// the host event loop live between messages, so elaboration tasks on
// pthreads get their proxied FS reads and stdout writes serviced.
//
// Usage:
//   node --stack-size=8192 pipeline/lsp/lsp-pump-probe.mjs [--artifact <dir>] [--lib <dir>] [--source <file.lean>] [--budget-ms 180000]

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
const budgetMs = Number(arg("budget-ms", "180000"));
const sourcePath = arg("source", null);
const source = sourcePath
  ? fs.readFileSync(sourcePath, "utf8")
  : "theorem probe (n : Nat) : n + 0 = n := by\n  simp\nexample : False := sorry\n";
const leanJs = path.join(artifactDir, "bin/lean.js");
if (!fs.existsSync(leanJs) || !fs.existsSync(libLean)) {
  console.error(`error: need ${leanJs} and ${libLean}`);
  process.exit(2);
}

const uri = "untitled:/probe.lean";
const t0 = Date.now();
const log = (s) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

// ---- Outbound (server→client) frame capture over stdout bytes -------------
let outBuf = Buffer.alloc(0);
const messages = [];
let M;
const milestones = { diags: false, waitDone: false, rpcSession: null, goals: false };

function pumpFrames() {
  for (;;) {
    const headerEnd = outBuf.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const m = /Content-Length: (\d+)/i.exec(outBuf.slice(0, headerEnd).toString("ascii"));
    if (!m) {
      outBuf = outBuf.slice(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (outBuf.length < start + len) return;
    const body = outBuf.slice(start, start + len).toString("utf8");
    outBuf = outBuf.slice(start + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      log(`<= unparseable frame (${len} bytes)`);
      continue;
    }
    messages.push(msg);
    onServerMessage(msg);
  }
}

// Lean ABI helpers: @[export] String params are Lean string OBJECTS, and IO
// results are objects whose tag lives at +7 (0 = ok).
const ioTag = (res) => Number(M.getValue(Number(res) + 7, "i8")) & 0xff;
const mkLeanStr = (js) => {
  const c = BigInt(M.stringToNewUTF8(js));
  const obj = M._lean_mk_string(c);
  if (typeof M._free === "function") M._free(c);
  return obj;
};

const send = (obj) => {
  const json = JSON.stringify(obj);
  log(`=> ${obj.method || `response#${obj.id}`}`);
  const rc = M._lean_wasm_lsp_send(mkLeanStr(json));
  if (ioTag(rc) !== 0) log(`   (send IO tag ${ioTag(rc)})`);
};

function onServerMessage(msg) {
  const kind = msg.method || (msg.id !== undefined ? `response#${msg.id}` : "?");
  let detail = "";
  if (msg.method === "textDocument/publishDiagnostics") {
    const ds = msg.params.diagnostics;
    detail = ` (${ds.length})`;
    for (const d of ds) detail += `\n    [sev${d.severity}] ${d.range.start.line}:${d.range.start.character} ${String(d.message).slice(0, 80).replace(/\n/g, " ⏎ ")}`;
    if (ds.length > 0) milestones.diags = true;
  }
  log(`<= ${kind}${detail}`);

  if (msg.id === 2 && !msg.method) {
    // waitForDiagnostics answered: elaboration is done. Open an RPC session.
    milestones.waitDone = true;
    send({ jsonrpc: "2.0", id: 3, method: "$/lean/rpc/connect", params: { uri } });
  } else if (msg.id === 3 && msg.result?.sessionId) {
    milestones.rpcSession = msg.result.sessionId;
    // The InfoView's bread and butter: interactive goals at a position
    // inside the tactic proof (line 1 = "  simp").
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "$/lean/rpc/call",
      params: {
        method: "Lean.Widget.getInteractiveGoals",
        sessionId: milestones.rpcSession,
        uri,
        textDocument: { uri },
        position: { line: 1, character: 2 },
        params: { textDocument: { uri }, position: { line: 1, character: 2 } },
      },
    });
  } else if (msg.id === 4 && !msg.method) {
    if (msg.result !== undefined) {
      milestones.goals = true;
      const rendered = JSON.stringify(msg.result).slice(0, 300);
      log(`   interactive goals payload: ${rendered}`);
    } else {
      log(`   rpc/call error: ${JSON.stringify(msg.error).slice(0, 200)}`);
    }
    finish();
  }
}

function finish() {
  const ok = milestones.diags && milestones.waitDone && milestones.rpcSession && milestones.goals;
  log(ok ? "LSP PUMP PROBE PASS: elaboration + diagnostics + RPC goals all served" : `LSP PUMP PROBE PARTIAL: ${JSON.stringify(milestones)}`);
  process.exit(ok ? 0 : 4);
}

setTimeout(() => {
  log(`TIMEOUT: ${JSON.stringify(milestones)}; ${messages.length} messages`);
  process.exit(5);
}, budgetMs);

// Thread-state introspection while we wait.
setInterval(() => {
  const PT = globalThis.Module && globalThis.Module.PThread;
  const threads = PT ? `running=${PT.runningWorkers?.length} unused=${PT.unusedWorkers?.length}` : "PThread-not-exposed";
  log(`state: ${threads} stdoutBytes=${outBuf.length} msgs=${messages.length}`);
}, 6000).unref();

// ---- Boot the persistent runtime (same shape as snapshot-probe) -----------
process.chdir("/");
process.argv[1] = "/bin/lean";

globalThis.Module = {
  locateFile: (file) => path.join(path.dirname(leanJs), file),
  mainScriptUrlOrBlob: leanJs,
  noInitialRun: true,
  preRun: [
    function mountAndHookStdio() {
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
      FS.init(
        () => null, // stdin unused: messages arrive via the pump export
        (code) => {
          if (code === null || code === undefined) return;
          outBuf = Buffer.concat([outBuf, Buffer.from([code])]);
          pumpFrames();
        },
        (code) => {
          if (code === null || code === undefined) return;
          process.stderr.write(Buffer.from([code]));
        },
      );
    },
  ],
  onRuntimeInitialized() {
    M = globalThis.Module;
    try {
      M._lean_initialize_runtime_module();
      M._lean_initialize();
      M._lean_io_mark_end_initialization();
      if (M._lean_init_task_manager) M._lean_init_task_manager();
      if (M._lean_enable_initializer_execution) M._lean_enable_initializer_execution();
      const sp = M._lean_init_search_path();
      void sp;
      if (typeof M._lean_wasm_lsp_init !== "function") throw new Error("lean_wasm_lsp_init export missing — rebuild with patch 0018");

      // Node-harness quirk: the main runtime thread's proxy mailbox is only
      // drained inside wasm futex waits; while we idle in the event loop,
      // pthread-side stdout writes and FS calls queue forever. The glue's
      // checkMailbox is module-global under vm.runInThisContext — poll it.
      // (Browsers arm this via Atomics.waitAsync on thread init; verify in
      // Stage 2 and keep the poll as a belt-and-suspenders fallback.)
      if (typeof globalThis.checkMailbox === "function") {
        setInterval(() => globalThis.checkMailbox(), 25);
        log("mailbox poll armed (25 ms)");
      } else {
        log("WARNING: checkMailbox not found in glue scope");
      }
      log("runtime up; starting LSP session");
      const initParams = JSON.stringify({
        processId: null,
        rootUri: null,
        capabilities: {},
        initializationOptions: { hasWidgets: false },
      });
      const didOpen = JSON.stringify({
        textDocument: { uri, languageId: "lean4", version: 1, text: source },
      });
      const rc = M._lean_wasm_lsp_init(mkLeanStr(initParams), mkLeanStr(didOpen));
      if (ioTag(rc) !== 0) throw new Error(`lean_wasm_lsp_init IO error (tag ${ioTag(rc)})`);
      log("worker session initialized; elaboration running in background tasks");
      send({ jsonrpc: "2.0", id: 2, method: "textDocument/waitForDiagnostics", params: { uri, version: 1 } });
      // Now idle: the event loop services pthread FS reads / stdout writes;
      // responses arrive through pumpFrames.
    } catch (err) {
      log(`BOOT FAIL: ${err.message}`);
      process.exit(3);
    }
  },
  onAbort: (what) => {
    log(`ABORT: ${what}`);
    process.exit(3);
  },
};

globalThis.require = createRequire(leanJs);
globalThis.__filename = "/bin/lean.js";
globalThis.__dirname = "/bin";
log(`booting runtime (source: ${sourcePath || "inline"}, ${source.length} bytes)`);
vm.runInThisContext(fs.readFileSync(leanJs, "utf8"), { filename: leanJs });
