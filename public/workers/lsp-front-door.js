/* QED64 resident LSP front door — the worker-side state machine of
 * docs/ARCHITECTURE-REEVALUATION-2-2026-09-02.md §2.4 (design: §2.2 "L1 (b)").
 *
 *   Loading(script) → Booting → Ready(loop closed, queue) → Open → Dead
 *
 * One PURE reducer: `step(state, frame) → {state, ringWrites, replies,
 * startLoop, statusDelta}`. It owns no Worker, no ring and no timer, so the
 * whole machine runs under vitest (tests/unit/front-door.test.ts) exactly as
 * it runs inside lean.worker.js, which only performs the effects it returns.
 * Like lsp-frames.js it publishes itself on `globalThis` (no `export`, no
 * `require`) so `importScripts` in the classic worker and a side-effect
 * `import` under Node load the same file.
 *
 * Why a front door at all (§1, bug classes 3/6/8, C1/C5): the page used to
 * mirror the worker's document and decide from booleans when the worker could
 * accept an edit. Here the worker itself queues every frame from script load
 * until its loop is open (§6 amendment 20), starts the loop on the first
 * didOpen, and turns a later didOpen into a full-text didChange with version
 * rebasing (§6 second pass 1) — the page never holds an edit and never
 * inspects text.
 */
"use strict";

(function (root) {
  // Transcribed from Lean.Server.Watchdog.mkLeanServerCapabilities (the table
  // watchdog-shim.ts answered with) — `change: 1` (full text) instead of 2:
  // the wire then has no range type, so the client cannot diverge from the
  // worker's document by construction (§4 row 3; vscode-languageclient
  // honours `resolvedTextDocumentSync.change`).
  const SERVER_CAPABILITIES = {
    textDocumentSync: { openClose: true, change: 1, willSave: false, willSaveWaitUntil: false, save: { includeText: true } },
    completionProvider: { triggerCharacters: ["."], resolveProvider: true },
    hoverProvider: true,
    declarationProvider: true,
    definitionProvider: true,
    typeDefinitionProvider: true,
    referencesProvider: true,
    callHierarchyProvider: true,
    renameProvider: { prepareProvider: true },
    workspaceSymbolProvider: true,
    documentHighlightProvider: true,
    documentSymbolProvider: true,
    foldingRangeProvider: true,
    semanticTokensProvider: {
      legend: {
        tokenTypes: ["keyword", "variable", "property", "function", "namespace", "type", "enumMember", "comment"],
        tokenModifiers: [],
      },
      full: true,
      range: true,
    },
    codeActionProvider: { resolveProvider: true, codeActionKinds: ["quickfix", "refactor", "source.organizeImports"] },
    inlayHintProvider: { resolveProvider: false },
  };

  // The ALLOWLIST (§5, Watchdog Parity graft; invariant K-iv): exactly the
  // notifications `FileWorker.handleNotification` dispatches
  // (FileWorker.lean:763-772). Any other notification is
  // `throwServerError` → `forceExit 1` — i.e. a new lean4monaco notification
  // must never be able to kill the worker, so everything else is dropped and
  // counted rather than forwarded. didOpen is handled by the machine itself.
  const FORWARDED_NOTIFICATIONS = new Set([
    "textDocument/didChange",
    "$/cancelRequest",
    "$/lean/staleDependency",
    "$/lean/rpc/release",
    "$/lean/rpc/keepAlive",
  ]);
  const DID_OPEN = "textDocument/didOpen";
  const DID_CHANGE = "textDocument/didChange";

  function initialState() {
    return {
      phase: "booting", // booting | ready (loop closed) | open | dead
      initialize: null, // the client's initialize request, cached for the loop start / a replay
      queue: [], // frames from script load until the loop is open
      backlog: [], // outbound frames held while the ring is parked (§2.4: didChange coalesces, newest wins)
      ringBusy: false,
      doc: null, // {uri, languageId, version} in CLIENT version space
      base: 0, // worker version = client version + base (§2.2(b) rebasing)
      lastVersion: -1, // last worker-space version written (didOpen / didChange)
      progress: null, // {version (client space), processing} from the last $/lean/fileProgress
      header: null, // the last $/qed64/headerStatus params (per header setup, not per version — §2.2(e))
      dropped: 0,
    };
  }

  function out(state) {
    return { state, ringWrites: [], replies: [], startLoop: false, statusDelta: null };
  }

  /** Same message with every numeric version field shifted by `delta` —
   * `params.textDocument.version` (didChange, fileProgress) and
   * `params.version` (publishDiagnostics, ileanInfo*, headerStatus,
   * waitForDiagnostics). `mkLspOutputChannel` drops notifications with
   * `version < maxDocVersion` (FileWorker.lean:602) and lean4game re-opens a
   * fresh model at version 1 per level, so without the shift every
   * diagnostic after a level switch would be filtered as stale. */
  function shiftVersions(msg, delta) {
    if (delta === 0 || !msg.params || typeof msg.params !== "object") return msg;
    const p = msg.params;
    let params = p;
    if (typeof p.version === "number") params = { ...params, version: p.version + delta };
    if (p.textDocument && typeof p.textDocument.version === "number") {
      params = { ...params, textDocument: { ...p.textDocument, version: p.textDocument.version + delta } };
    }
    return params === p ? msg : { ...msg, params };
  }

  /** Append a frame to a held list. While the worker cannot take an edit
   * right now (loop closed, ring parked) only the NEWEST document content
   * matters, at the arrival position of that newest frame (§6 first pass 8):
   * a didChange replaces any held didChange; a didOpen replaces any held
   * didOpen AND didChange (those described the previous document — replaying
   * them after the open would overwrite the new document with old text). */
  function enqueue(list, item) {
    const m = item.msg.method;
    const kept = m === DID_CHANGE
      ? list.filter((q) => q.msg.method !== DID_CHANGE)
      : m === DID_OPEN
        ? list.filter((q) => q.msg.method !== DID_CHANGE && q.msg.method !== DID_OPEN)
        : list.slice();
    kept.push(item);
    return kept;
  }

  /** Write one outbound frame: rebase its versions, remember the document
   * version it carries, and either hand it to the ring or park it. */
  function emit(s, r, msg) {
    if (msg.method === DID_CHANGE && msg.params && msg.params.textDocument) {
      const v = msg.params.textDocument.version;
      if (typeof v === "number") {
        if (s.doc) s.doc = { ...s.doc, version: v };
        s.lastVersion = v + s.base;
      }
    }
    const wire = shiftVersions(msg, s.base);
    if (s.ringBusy) s.backlog = enqueue(s.backlog, { msg: wire });
    else r.ringWrites.push(wire);
  }

  function initializeResponse(id) {
    return {
      jsonrpc: "2.0",
      id,
      result: { capabilities: SERVER_CAPABILITIES, serverInfo: { name: "QED64 wasm64 Lean Server", version: "0.1.0" } },
    };
  }

  /** One client frame through the machine (§2.4, per-frame rules). */
  function admit(s, r, msg, replay) {
    const isRequest = msg.id !== undefined && msg.method !== undefined;
    if (msg.method === "initialize" && isRequest) {
      // The FileWorker consumes `initialize` without ever answering it (that
      // is the watchdog's job in a native setup): answer here from the table,
      // cache it for the loop start. A replay (the relay re-sending after a
      // reboot) is cached only — the client already holds its answer.
      s.initialize = msg;
      if (!replay) r.replies.push(initializeResponse(msg.id));
      return;
    }
    if (msg.method === "shutdown" && isRequest) {
      r.replies.push({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    if (s.phase === "dead") {
      s.dropped += 1;
      return;
    }
    if (msg.method === DID_OPEN) {
      const td = msg.params && msg.params.textDocument;
      if (!td || typeof td.version !== "number") {
        s.dropped += 1;
        return;
      }
      if (s.phase === "open") {
        // Re-open on a live loop (lean4game's next level, the relay's replay
        // onto a loop a queued didOpen already started): the FileWorker owns
        // one document, so this becomes a full-text didChange; the version
        // continues the worker's sequence and later client versions are
        // rebased by the same offset both ways (§6 second pass 1).
        s.base = s.lastVersion + 1 - td.version;
        s.doc = { uri: td.uri, languageId: td.languageId, version: td.version };
        emit(s, r, { jsonrpc: "2.0", method: DID_CHANGE, params: { textDocument: { uri: td.uri, version: td.version }, contentChanges: [{ text: td.text }] } });
        return;
      }
      if (s.phase === "ready") {
        // The opening sequence: the FileWorker reads `initialize` then
        // `didOpen` DIRECTLY and nothing may come between them.
        const init = s.initialize;
        s.base = 0;
        s.doc = { uri: td.uri, languageId: td.languageId, version: td.version };
        s.lastVersion = td.version;
        s.phase = "open";
        r.startLoop = true;
        r.ringWrites.push({ jsonrpc: "2.0", id: init ? init.id : 0, method: "initialize", params: init && init.params ? init.params : {} });
        r.ringWrites.push(msg);
        drain(s, r);
        return;
      }
      s.queue = enqueue(s.queue, { msg, replay });
      return;
    }
    if (!isRequest && msg.method !== undefined && !FORWARDED_NOTIFICATIONS.has(msg.method)) {
      // exit, initialized, $/setTrace, workspace/*, didClose, didSave, …
      s.dropped += 1;
      return;
    }
    if (s.phase !== "open") {
      s.queue = enqueue(s.queue, { msg, replay });
      return;
    }
    if (msg.method === DID_CHANGE) {
      const v = msg.params && msg.params.textDocument ? msg.params.textDocument.version : undefined;
      // A change at or below the document's version is already in the text
      // the worker holds (the didOpen that opened the loop, or the relay's
      // replayed didOpen): replaying it would regress the worker's document
      // (bug class 6). Client versions are monotonic, so this only ever
      // fires for frames queued before an open.
      if (typeof v === "number" && s.doc && v <= s.doc.version) {
        s.dropped += 1;
        return;
      }
    }
    emit(s, r, msg);
  }

  /** Replay the held queue through the same rules, in order. Frames that
   * still cannot go (the runtime booted but no didOpen yet) re-queue; the
   * didOpen branch drains those before continuing with the frames behind it,
   * so a request queued ahead of the open lands after the opening sequence. */
  function drain(s, r) {
    const pending = s.queue;
    s.queue = [];
    for (const q of pending) admit(s, r, q.msg, q.replay);
  }

  function phaseOf(s) {
    if (s.phase === "dead") return "dead";
    if (s.phase === "booting") return "booting";
    if (s.phase === "ready" || !s.progress || !s.doc) return "starting";
    // `ready` iff fileProgress drained at the editor's version AND the last
    // header verdict for this setup is not a refusal (§2.2(e); §6 first
    // pass 12). A body keystroke takes Lean's `unchanged` path and emits no
    // headerStatus, so the verdict is per header setup, not per version.
    if (s.progress.version === s.doc.version && s.progress.processing === 0) {
      return s.header && s.header.mode === "refused" ? "headerRefused" : "ready";
    }
    return "elaborating";
  }

  function statusOf(s) {
    return { phase: phaseOf(s), version: s.doc ? s.doc.version : null, header: s.header, dropped: s.dropped };
  }

  /**
   * @param state the previous state (not mutated)
   * @param frame one of
   *   {kind:"client", msg, replay?}  a JSON-RPC message from the page
   *   {kind:"server", msg}           a frame decoded from the FileWorker's stdout
   *   {kind:"booted"}                the runtime finished booting (Booting → Ready)
   *   {kind:"ring", busy}            the host's stdin ring parked / drained
   *   {kind:"died"}                  the one death fact (W2)
   */
  function step(state, frame) {
    const s = { ...state, queue: state.queue, backlog: state.backlog };
    const r = out(s);
    switch (frame.kind) {
      case "client":
        admit(s, r, frame.msg, frame.replay === true);
        break;
      case "server": {
        const msg = shiftVersions(frame.msg, -s.base);
        const p = msg.params;
        if (msg.method === "$/lean/fileProgress" && p && p.textDocument && typeof p.textDocument.version === "number") {
          s.progress = { version: p.textDocument.version, processing: Array.isArray(p.processing) ? p.processing.length : 0 };
        } else if (msg.method === "$/qed64/headerStatus" && p) {
          s.header = p;
        }
        r.replies.push(msg);
        break;
      }
      case "booted":
        if (s.phase === "booting") {
          s.phase = "ready";
          drain(s, r);
        }
        break;
      case "ring":
        s.ringBusy = frame.busy === true;
        if (!s.ringBusy && s.backlog.length > 0) {
          for (const q of s.backlog) r.ringWrites.push(q.msg);
          s.backlog = [];
        }
        break;
      case "died":
        s.phase = "dead";
        break;
      default:
        break;
    }
    r.statusDelta = statusOf(s);
    return r;
  }

  root.Qed64LspFrontDoor = { initialState, step, statusOf, SERVER_CAPABILITIES, FORWARDED_NOTIFICATIONS };
})(globalThis);
