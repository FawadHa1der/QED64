// tests/adversarial/infoview-actions.mjs runs only against a real page in
// Chromium; its decisions are pinned here (docs/HARDENING.md #56):
//   * every scenario runs alone, and a selection of none is a refusal (exit 3),
//     never "0/0 pass" — `--only foreign-show` used to run nothing;
//   * capability-flag judges `qed64.api` as it was AT DOMContentLoaded, not
//     only at load;
//   * foreign-show sends showDocument from inside the InfoView iframe and fails
//     a page that moves the selection or the focus for a foreign file — it used
//     to check only the text, which showDocument never touches.
// The page half is the real one: lean4monaco's vscode-lean4 Rpc registering
// wrapEditorRpcApi, as the patched infowebview.js does, over a postMessage
// model with the browser's semantics (a structured-cloned string delivered as
// a later task, `event.source` = the sender, and at the target the capture
// listeners before the others). The probes are revived from their source text
// and called with one argument, as Playwright does.
import { describe, expect, test } from "vitest";
import { Rpc } from "../../frontend/node_modules/lean4monaco/dist/vscode-lean4/vscode-lean4/src/rpc.js";
import { wrapEditorRpcApi, type EditsEditor } from "../../frontend/src/editor/infoview-edits";
import { SCENARIOS, apiAtLoad, capabilityVerdict, exitCodeFor, foreignShow, foreignShowFailures, recordApiAtDomContentLoaded, selectScenarios } from "../adversarial/infoview-actions.mjs";

type Probe = (arg: unknown, g: unknown) => unknown;
/** Playwright: `(${fn.toString()})(arg)` in the target's global scope. */
const revive = (fn: Probe): Probe => (0, eval)(`(${fn.toString()})`);
const evaluateIn = (g: unknown) => async (fn: Probe, arg?: unknown) => structuredClone(await revive(fn)(arg, g));

describe("scenario selection", () => {
  test("every scenario runs alone (foreign-show used to ride on conv-generate's page)", () => {
    expect(SCENARIOS).toEqual(["capability-flag", "try-this-apply", "conv-generate", "foreign-show"]);
    for (const name of SCENARIOS) expect(selectScenarios(name)).toEqual([name]);
    expect(selectScenarios("")).toEqual(SCENARIOS);
    expect(selectScenarios("conv-generate|foreign-show")).toEqual(["conv-generate", "foreign-show"]);
  });
  test("a selection of none, or a run that judged nothing, is a refusal (exit 3), never a pass", () => {
    expect(selectScenarios("foreign_show")).toEqual([]);
    expect(exitCodeFor(0, 0)).toBe(3);
    expect(exitCodeFor(2, 0)).toBe(0);
    expect(exitCodeFor(2, 1)).toBe(1);
  });
});

describe("capability-flag", () => {
  /** What the init script and the load-time read see: the init script runs
   * before the page's scripts, the page publishes `qed64.api` at module start
   * (or, regressed, after an await), then DOMContentLoaded, then load. */
  function lifecycle(publish: "module start" | "after DOMContentLoaded", api: object = Object.freeze({ version: 1, capabilities: Object.freeze({ editorRpc: true }), setDocument() {} })) {
    const document = new EventTarget();
    const g: Record<string, unknown> = { document };
    revive(recordApiAtDomContentLoaded)(undefined, g);
    if (publish === "module start") g.qed64 = { api };
    document.dispatchEvent(new Event("DOMContentLoaded"));
    if (publish === "after DOMContentLoaded") g.qed64 = { api };
    return structuredClone(revive(apiAtLoad)(undefined, g)) as { atDcl: unknown; atLoad: unknown; frozen: boolean };
  }

  test("an api published at module start passes", () => {
    const seen = lifecycle("module start");
    expect(seen.atDcl).toEqual({ version: 1, capabilities: { editorRpc: true } });
    expect(capabilityVerdict(seen)).toBe(true);
  });
  test("an api published after DOMContentLoaded fails, though at load it is flagged and frozen", () => {
    const seen = lifecycle("after DOMContentLoaded");
    expect(seen.atDcl).toBeNull();
    // All the old check asked:
    expect(seen.atLoad).toEqual({ version: 1, capabilities: { editorRpc: true } });
    expect(seen.frozen).toBe(true);
    expect(capabilityVerdict(seen)).toBe(false);
  });
  test("no DOMContentLoaded record, or an unfrozen api, fails", () => {
    expect(capabilityVerdict({ atDcl: "not recorded", atLoad: { version: 1, capabilities: { editorRpc: true } }, frozen: true })).toBe(false);
    expect(capabilityVerdict(lifecycle("module start", { version: 1, capabilities: { editorRpc: true } }))).toBe(false);
  });
});

const URI = "file:///project/Probe.lean";
const DOC_A = "example (n : Nat) : n + 0 = n := by simp?\n";
type Range = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
interface El { tagName: string; focus(): void; blur(): void }

/** The page: Monaco's editor (its selection; focus() focuses its textarea,
 * inside its container node) and the document's active element. */
function fakePage(text = DOC_A) {
  const body: El = { tagName: "BODY", focus() {}, blur() {} };
  const doc = { activeElement: body, querySelectorAll: (sel: string) => (sel === "#infoview iframe" ? [iframeEl] : []) };
  const element = (tagName: string): El => {
    const el: El = { tagName, focus: () => { doc.activeElement = el; }, blur: () => { if (doc.activeElement === el) doc.activeElement = body; } };
    return el;
  };
  const textarea = element("TEXTAREA");
  const iframeEl = element("IFRAME");
  let selection: Range = { startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 5 };
  const editor = {
    getModel: () => ({ uri: { toString: () => URI }, getValue: () => text, getLineContent: (n: number) => text.split("\n")[n - 1] ?? "", getLineCount: () => text.split("\n").length }),
    getPosition: () => ({ lineNumber: selection.endLineNumber, column: selection.endColumn }),
    getSelection: () => ({ ...selection }),
    setPosition: (p: { lineNumber: number; column: number }) => { selection = { startLineNumber: p.lineNumber, startColumn: p.column, endLineNumber: p.lineNumber, endColumn: p.column }; },
    setSelection: (r: Range) => { selection = { ...r }; },
    revealRangeInCenterIfOutsideViewport: () => {},
    executeEdits: () => true,
    pushUndoStop: () => true,
    focus: () => textarea.focus(),
    getContainerDomNode: () => ({ contains: (n: unknown) => n === textarea }),
  };
  textarea.focus(); // the cursor was put in the editor last
  return { editor, globals: { qed64: { editor }, document: doc } };
}

type MessageEventLike = { data: unknown; source: unknown; stopImmediatePropagation(): void };
type Listener = { fn: (e: MessageEventLike) => void; capture: boolean };
/** A window's `message` events as the browser dispatches them. */
class FakeWindow {
  parent?: { postMessage(data: unknown): void };
  uncaught: unknown[] = [];
  private listeners: Listener[] = [];
  addEventListener(type: string, fn: (e: MessageEventLike) => void, capture?: boolean) {
    if (type === "message" && !this.listeners.some((l) => l.fn === fn && l.capture === !!capture)) this.listeners.push({ fn, capture: !!capture });
  }
  removeEventListener(type: string, fn: (e: MessageEventLike) => void, capture?: boolean) {
    this.listeners = this.listeners.filter((l) => !(type === "message" && l.fn === fn && l.capture === !!capture));
  }
  /** `postMessage` to this window from `source`: a structured clone, dispatched
   * as a later task; at the target the capture listeners run first (DOM, Chrome
   * 89+), a removed listener does not run, a throwing one does not stop the rest. */
  deliver(data: unknown, source: FakeWindow) {
    const clone = structuredClone(data);
    setTimeout(() => {
      let stopped = false;
      const event = { data: clone, source, stopImmediatePropagation: () => { stopped = true; } };
      for (const l of [...this.listeners.filter((x) => x.capture), ...this.listeners.filter((x) => !x.capture)]) {
        if (stopped) break;
        if (!this.listeners.includes(l)) continue;
        try { l.fn(event); } catch (e) { this.uncaught.push(e); }
      }
    }, 0);
  }
}

/** lean4monaco's two halves of the InfoView RPC: the page's (infowebview.js
 * make(), registering through the QED64 hook as the patched module does) and
 * the iframe's (webview.js: its own Rpc and listener; the InfoView registers
 * its InfoviewApi). */
function infoviewChannel(registered: object) {
  const page = new FakeWindow();
  const iframe = new FakeWindow();
  iframe.parent = { postMessage: (data) => page.deliver(data, iframe) };
  const rpc = new Rpc((m) => iframe.deliver(JSON.stringify(m), page));
  rpc.register(registered);
  page.addEventListener("message", (m) => {
    if (m.source !== iframe) return;
    try { rpc.messageReceived(JSON.parse(m.data as string)); } catch { /* lean4monaco ignores it */ }
  });
  const iframeRpc = new Rpc((e) => iframe.parent!.postMessage(JSON.stringify(e)));
  const iframeWarnings: unknown[] = [];
  iframe.addEventListener("message", (e) => {
    try { iframeRpc.messageReceived(JSON.parse(e.data as string)); } catch (t) { iframeWarnings.push(t); } // webview.js: console.warn("TODO: catch JSON.parse failure")
  });
  iframeRpc.register({});
  return { page, iframe, iframeWarnings };
}

describe("foreign-show", () => {
  type Show = { uri: string; selection?: { start: { line: number; character: number }; end: { line: number; character: number } } };
  // The InfoProvider's EditorRpcApi as lean4monaco hands it to the hook (the
  // three editor actions are replaced by wrapEditorRpcApi).
  const infoProviderApi = { copyToClipboard: async (_text: string) => {} };
  const shipped = (getEditor: () => EditsEditor) => wrapEditorRpcApi(infoProviderApi, getEditor);
  async function run(register: (getEditor: () => EditsEditor) => object, opts: { strayFrame?: boolean; timeoutMs?: number } = {}) {
    const p = fakePage();
    const ch = infoviewChannel(register(() => p.editor));
    let frame = ch.iframe;
    if (opts.strayFrame) { // a frame that is not the InfoView's: the page drops what it sends
      const stray = new FakeWindow();
      stray.parent = { postMessage: (data) => ch.page.deliver(data, stray) };
      frame = stray;
    }
    const seen = await foreignShow(evaluateIn(p.globals), evaluateIn(frame), opts.timeoutMs);
    return { seen, failures: foreignShowFailures(seen), ch };
  }

  test("the shipped page half passes: the foreign file is ignored, the own range selected and focused", async () => {
    const { seen, failures, ch } = await run(shipped);
    expect(failures).toEqual([]);
    expect(seen.before).toMatchObject({ uri: URI, selection: [1, 1, 1, 1], focus: "IFRAME", editorFocus: false });
    expect(seen.foreign).toEqual({ answered: true, exception: null });
    expect(seen.afterForeign).toEqual(seen.before);
    expect(seen.afterOwn).toMatchObject({ selection: [1, 21, 1, 30], focus: "TEXTAREA", editorFocus: true });
    // The answers went to the probe only: the iframe's Rpc, with no such call
    // pending, would have thrown on them.
    expect(ch.iframeWarnings).toEqual([]);
    expect([...ch.page.uncaught, ...ch.iframe.uncaught]).toEqual([]);
  });

  test("a showDocument that lost its URI check fails; the old text-only check passed it", async () => {
    const regressed = (getEditor: () => EditsEditor) => ({
      ...shipped(getEditor),
      showDocument: async (show: Show) => {
        const e = getEditor();
        if (show.selection) {
          const { start, end } = show.selection;
          const r = { startLineNumber: start.line + 1, startColumn: start.character + 1, endLineNumber: end.line + 1, endColumn: end.character + 1 };
          e.revealRangeInCenterIfOutsideViewport(r);
          e.setSelection(r);
        }
        e.focus();
      },
    });
    const { seen, failures } = await run(regressed);
    expect(seen.afterForeign.text).toBe(seen.before.text);
    expect(seen.afterForeign).toMatchObject({ selection: [1, 1, 1, 8], focus: "TEXTAREA", editorFocus: true });
    expect(failures).toEqual(["foreign leaves the selection", "foreign leaves the focus"]);
  });

  test("a page whose showDocument throws fails on the answers and the control", async () => {
    const { seen, failures } = await run(() => ({ showDocument: async () => { throw new Error("unsupported"); } }));
    expect(seen.foreign.exception).toMatch(/unsupported/);
    expect(failures).toEqual(["foreign answered without an exception", "own answered without an exception", "own selects its range", "own focuses the editor"]);
  });

  test("a call that never reaches the page fails, never passes", async () => {
    const { seen, failures } = await run(shipped, { strayFrame: true, timeoutMs: 100 });
    expect(seen.foreign).toEqual({ answered: false });
    expect(failures).toEqual(["foreign answered without an exception", "own answered without an exception", "own selects its range", "own focuses the editor"]);
  });
});
