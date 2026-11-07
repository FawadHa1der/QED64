// QED64 × lean4monaco: the live.lean-lang.org editing experience (Monaco +
// the real vscode-lean4 InfoView) with zero servers — the Lean file worker
// runs in this browser tab on the wasm64 runtime.
import { LeanMonaco, LeanMonacoEditor, type LeanMonacoOptions } from "lean4monaco";
// The library surface, through the same barrel an embedder imports (`qed64/embed`):
// the stock page is its first consumer. The imports below it are page-internal
// modules (or names) the barrel does not export.
import {
  ENGINE_STACK_OVERFLOW, LspRelay, ResidentSession, entryLabel, failureCauseOf, installArtifacts, makeEditorPolicy,
  type FailureCause, type ProgressInfo, type RelayStatus, type ResidentPolicy, type StatusSink,
} from "../../lib";
import { registerImportCompletion } from "./import-completion";
import { selfWiden } from "./self-widen";
import { installInfoviewEditorApi, type EditsEditor } from "./editor/infoview-edits";
import { codeFromHash, createPageApi, pageStatusSink, sharedLinkFlags, type EditorLike } from "./page-api";
import { normalizeMemoryBytes, parseEditHoldParam, parseMemoryParam } from "../../lib/params";
import { tapRelay } from "./relay-taps";
import { installWidgetSourceCache } from "./widget-source-cache";
import { createTestHatch } from "./test-hatch";
import { createCheckFallback } from "./check-fallback";
import { STAGES, createBootChecklist } from "./boot-checklist";
import { CAPABILITY_BOOT_NOTICE, NETWORK_HALT_LABEL, STALE_NOTICE, bootFailLabel, createStaleWatch, isNetworkCause } from "./stale-notice";
import { installFileActions, installShareButton } from "./file-io";
import { MATHLIB_GAPS, coverageHint } from "./mathlib-coverage";

// The embedder-facing surface (docs/EMBEDDING.md §2), published synchronously
// at module start — before any of the page's own listeners matter — so an
// embedder can feature-detect and call it before boot: `capabilities.editorRpc`
// = the InfoView's editor RPC works natively here (HARDENING #56), so an
// embedder's own bridge for it must stand down. The rest of `globalThis.qed64`
// (relay, ui, artifacts, editor, status()) joins this same object once the
// relay exists; it is internal (docs/EMBEDDING.md §9).
const pageApi = createPageApi({
  editorRpc: true, documents: true, events: true, restart: true, embedMode: true, snapshotRoots: true, postMessage: false,
  // offers: false since D1 (2026-11): the page offers no action; status().offer stays null, acceptOffer() false.
  liveness: true, memory: true, widgetSourceCache: true, offers: false,
});
const qed64Global = ((globalThis as unknown as { qed64?: Record<string, unknown> }).qed64 ??= {});
qed64Global.api = pageApi.api;
// Embed mode (docs/EMBEDDING.md §3): the embedder owns persistence and the
// boot document; it gets up to 5 s from module start to call setDocument.
const EMBED = new URLSearchParams(location.search).get("embed") === "1";
// A boot document in the URL (`#code=`) is CODE: Lean source can define a
// widget module whose JS runs in the same-origin InfoView iframe with no
// click. So it is honoured only from a same-origin parent frame (which could
// script this page anyway) — never from a top-level link, which anyone can
// send (HARDENING #57). A cross-origin frame cannot boot (no isolation).
const FRAMED_SAME_ORIGIN = (() => { try { return window.parent !== window && window.parent.location.origin === location.origin; } catch { return false; } })();
const embedDeadline = new Promise<void>((r) => window.setTimeout(r, EMBED ? 5000 : 0));
window.dispatchEvent(new CustomEvent("qed64:api", { detail: pageApi.api }));
try {
  const parent = window.parent as Window & typeof globalThis;
  if (parent !== window && parent.location.origin === location.origin) {
    parent.dispatchEvent(new parent.CustomEvent("qed64:frame-api", { detail: { api: pageApi.api, frame: window } }));
  }
} catch { /* a cross-origin parent: v1.1 (docs/EMBEDDING.md §5) */ }

const editorEl = document.getElementById("editor")! as HTMLElement;
const infoviewEl = document.getElementById("infoview")! as HTMLElement;
// The InfoView frame's accessible name (UX A1.4): lean4monaco appends a bare <iframe> to #infoview (a new one if the
// InfoView is made again), so each is named as it arrives. aria-label, not title: no native tooltip over the pane.
new MutationObserver(() => {
  for (const f of infoviewEl.querySelectorAll("iframe:not([aria-label])")) f.setAttribute("aria-label", "Lean InfoView");
}).observe(infoviewEl, { childList: true });
const pill = document.getElementById("pill")!;
const ptext = document.getElementById("ptext")!;
const pillEl = document.getElementById("pill")!;
// The stale-page prompt (stale-notice.ts; docs/EMBEDDING.md §7.2 `stale`):
// the site was deployed under this page. The relay heals by itself, so the
// prompt is a standing Reload button beside the pill, never a card over the
// editor; a halt before any session served already gets the failure card's.
const staleWatch = createStaleWatch((d) => {
  console.warn(`[qed64] ${STALE_NOTICE} (${d.message})`);
  const btn = document.createElement("button");
  btn.id = "stalereload";
  btn.type = "button";
  btn.textContent = "Updated — reload";
  btn.title = STALE_NOTICE;
  btn.style.cssText = "margin-left:.6em;padding:.15em .6em;font:inherit;font-size:.9em;cursor:pointer;border-radius:.4em;border:1px solid #4664ee;background:#4664ee;color:#fff";
  btn.onclick = () => window.location.reload();
  pillEl.insertAdjacentElement("afterend", btn);
});
const ptime = document.getElementById("ptime")!;
const examplesEl = document.getElementById("examples")! as HTMLSelectElement;
if (EMBED) examplesEl.style.display = "none";

// ---- Boot overlay: staged first-visit progress with speed and ETA ---------
// The heavy startup (a ~460 MB first-visit download, then the environment
// load) gets a full card over the workspace: a progress bar with real byte
// counts, download speed, a time-left estimate, and a stage checklist — the
// status pill alone reads as "stuck" at this scale. The card stays for the
// WHOLE boot: on a slow link the downloads alone take many minutes, and the
// card is the only place their progress is shown (HARDENING #54). It goes
// when the checker is actionable (`renderStatus`), when the boot fails (it
// turns into the failure card), or by the check fallback below. The visitor
// may hide it sooner ("Show the editor while Lean loads", main(); never a
// timer): the pill keeps the boot's labels, and a failure brings it back.
const bootEl = document.getElementById("boot")!;
const bootCard = document.getElementById("bootcard")!;
const bootBar = document.getElementById("bootbar")!;
const bootFill = document.getElementById("bootfill")!;
const bootLabel = document.getElementById("bootlabel")!;
const bootNums = document.getElementById("bootnums")!;
const bootReload = document.getElementById("bootreload")! as HTMLButtonElement;
const bootShow = document.getElementById("bootshow")! as HTMLButtonElement;
const checklist = createBootChecklist(); // boot-checklist.ts: the active step and its rules
let bootDone = false;
// Downloads report cumulative bytes; a short moving window gives a stable
// speed and time-left estimate that still tracks real throughput changes.
const speedWindow: Array<{ t: number; loaded: number }> = [];
let speedKey = "";

function renderStages() {
  document.querySelectorAll<HTMLElement>("#bootstages li").forEach((li) => {
    const i = STAGES.indexOf(li.dataset.stage as (typeof STAGES)[number]);
    li.classList.toggle("done", i < checklist.stage);
    li.classList.toggle("active", i === checklist.stage);
  });
}

function fmtMB(n: number) {
  return n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576) | 0} MB`;
}

function bootProgress(label: string, info?: ProgressInfo) {
  if (bootDone) return;
  const step = checklist.progress(label, info);
  if (step.fresh) speedWindow.length = 0;
  if (step.moved) renderStages();
  bootLabel.textContent = label;
  const { loaded, total, unit } = info ?? {};
  if (unit === "bytes" && typeof loaded === "number" && typeof total === "number" && total > 0) {
    bootBar.classList.remove("busy");
    bootFill.style.width = `${Math.min(100, (loaded / total) * 100).toFixed(1)}%`;
    // Reset the speed window when the byte counter belongs to a new download.
    const key = `${info?.phase}:${total}`;
    if (key !== speedKey) { speedKey = key; speedWindow.length = 0; }
    const now = performance.now();
    speedWindow.push({ t: now, loaded });
    while (speedWindow.length > 2 && now - speedWindow[0].t > 8000) speedWindow.shift();
    let rate = "";
    const first = speedWindow[0];
    if (now - first.t > 1500 && loaded > first.loaded) {
      const bps = ((loaded - first.loaded) / (now - first.t)) * 1000;
      const left = Math.max(0, total - loaded) / bps;
      const eta = left >= 90 ? `~${Math.round(left / 60)} min left` : `~${Math.round(left)} s left`;
      rate = ` · ${(bps / 1048576).toFixed(1)} MB/s · ${eta}`;
    }
    bootNums.textContent = `${fmtMB(loaded)} / ${fmtMB(total)}${rate}`;
  } else if (unit === "modules" && typeof loaded === "number" && typeof total === "number" && total > 0) {
    bootBar.classList.remove("busy");
    bootFill.style.width = `${Math.min(100, (loaded / total) * 100).toFixed(1)}%`;
    bootNums.textContent = `${loaded} / ${total} modules`;
  } else {
    bootBar.classList.add("busy");
    bootNums.textContent = "";
  }
}

// The check fallback (check-fallback.ts): once the relay SERVES, what is left
// is Lean checking the document, and the editor must not stay hidden behind
// the card while it does; the pill keeps the phase and its elapsed time.
// It sees every status renderStatus does (check-fallback.ts decides): armed by
// the first serving status, never earlier; disarmed by a final verdict or a
// deliberate replacement (self-widen, api.restart), whose own
// serve re-arms it; left armed by crash reboots and a halt.
const CHECK_FALLBACK_MS = 30000;
const checkFallback = createCheckFallback(() => bootFinish(), CHECK_FALLBACK_MS);

function bootFinish() {
  if (bootDone) return;
  bootDone = true;
  pageApi.bootFinished();
  checkFallback.cancel();
  checklist.finish();
  renderStages();
  bootEl.classList.add("done");
  window.setTimeout(() => bootEl.remove(), 600);
}

// The first failure with a cause is the one the card keeps: main()'s catch reports the cause, then
// `ui.idle("FAILED: …")` re-enters here without one (HARDENING #74).
let bootFailShown = false;
function bootFail(message: string, cause?: FailureCause) {
  if (bootDone || (bootFailShown && !cause)) return;
  bootFailShown ||= cause !== undefined;
  pageApi.bootFailed(message, cause);
  bootEl.classList.remove("away"); // a card the visitor hid comes back to say so (UX P1.1)
  bootShow.hidden = true;
  bootCard.classList.add("failed");
  bootCard.querySelector("h1")!.textContent = "QED64 could not start";
  // A stale cause (HARDENING #74), a browser that cannot run QED64 (#77) or a cut download (#88) gets words that say
  // what to do; the browser's own stay as the title.
  const label = bootFailLabel(message, cause);
  bootLabel.textContent = label;
  bootLabel.title = message;
  // UX B1.1 (#88): for a browser that cannot run QED64 the card keeps only that advice (index.html `.unsupported`).
  bootCard.classList.toggle("unsupported", label === CAPABILITY_BOOT_NOTICE);
  bootNums.textContent = "";
  bootBar.classList.remove("busy");
  bootReload.hidden = false;
  // A failed boot drops the share-link gate (HARDENING #77); the fragment stays, so Reload offers it again.
  document.getElementById("sharedlink")?.remove();
}
bootReload.addEventListener("click", () => window.location.reload());

// ---- Status pill: spinner + label + elapsed ticker ------------------------
let busySince: number | null = null;
let ticker: number | undefined;
function renderTime() {
  if (busySince === null) {
    ptime.textContent = "";
    return;
  }
  const s = Math.round((performance.now() - busySince) / 1000);
  ptime.textContent = s >= 3 ? (s < 60 ? `· ${s}s` : `· ${(s / 60) | 0}m ${s % 60}s`) : "";
}
// The pill's screen-reader echo (UX A1.3): `#pstatus` (role="status", visually hidden; index.html) hears what the pill
// says at busy and idle, and the page's own notes (a `progress` without `info`). Never the boot's telemetry (a
// `progress` with `info`: every module name of the environment load, every download tick), never `elaborating` (every
// edit flips to it), never the same label twice (the relay repeats `ready` several times a second). Not `#ptext` itself:
// that would announce all three. Silent under ?embed=1: the embedder announces from the status events in its own words.
const pstatus = EMBED ? null : document.getElementById("pstatus");
function announce(label: string): void {
  if (!pstatus || label === PHASE_LABEL.elaborating || pstatus.textContent === label) return;
  pstatus.textContent = label;
}
const ui: StatusSink = {
  busy(label, info) {
    if (busySince === null) busySince = performance.now();
    pill.classList.add("busy");
    ptext.textContent = label;
    ptext.title = label;
    announce(label);
    if (ticker === undefined) ticker = window.setInterval(renderTime, 1000);
    renderTime();
    bootProgress(label, info);
    if (info?.stage) pageApi.bootStep(label, info);
    console.log(`[qed64] ${label}`);
  },
  progress(label, info) {
    ptext.textContent = label;
    ptext.title = label;
    if (!info) announce(label); // the page's own note; the library's progress always carries info (EMBEDDING §7.1)
    bootProgress(label, info);
    if (info?.stage) pageApi.bootStep(label, info);
  },
  idle(label) {
    busySince = null;
    pill.classList.remove("busy");
    ptext.textContent = label;
    ptext.title = label;
    announce(label);
    renderTime();
    if (/^FAILED|failed — reload|restart failed/.test(label)) bootFail(label);
    else if (/^ready$/.test(label)) bootFinish();
    // A restored buffer can boot straight into an actionable state (a refused
    // import that needs editing) — the workspace must be visible for the user
    // to act, so this dismisses the overlay too (renderStatus also does, by phase).
    else if (label === PHASE_LABEL.headerRefused) bootFinish();
    console.log(`[qed64] ${label}`);
  },
};

// ---- Status: the relay's datum rendered, nothing regexed -------------------
// The pill is `render(status)` — one enum from the worker (§2.2(e)), no label
// strings to regex over (C10). The overlay goes at the first phase in which
// the workspace is actionable: `ready`, or `headerRefused` (a restored buffer
// with a refused import needs editing, so it must be visible).
const PHASE_LABEL: Record<RelayStatus["phase"], string> = {
  booting: "starting Lean",
  starting: "starting the Lean checker",
  elaborating: "elaborating",
  ready: "ready",
  headerRefused: "this import is not available here — check the module name (this playground serves a curated Mathlib)",
  dead: "the checker crashed — restarting (~15 s)",
  halted: "the checker keeps crashing on this content — edit the file to retry",
};
const WEDGED_LABEL = "the checker stopped responding — restarting (~15 s)";
const STACK_PAUSED_LABEL = "paused — Lean ran out of the browser's stack; edit the file to check again";
/** The relay's status as this page consumes it. `lastDeath` is the relay's
 * memory of the death that halted it (`onDied(code, reason, message)`, or
 * the boot rejection), null once a session reaches `ready`; optional here so
 * the page compiles against a relay that does not carry it yet. */
type PageStatus = RelayStatus; // lastDeath is on RelayStatus since the relay contract (2026-09-07)

// GAP 2 (page side): a halt BEFORE any session ever served is a boot that
// never worked — a Memory64 reservation refused, a capability missing, a
// runtime fetch or snapshot pairing failure, a cut download — and gets the
// first-boot failure card with its Reload button. A halt after a session
// served is the crash-loop breaker on the content, explained by the pill and
// the relay's in-document note (UX FILL-A6, HARDENING #88: an out-of-memory
// `#eval` in a restored buffer got "could not start" and a Reload that crashed
// again, because the rule was "before the first ready").
let everServed = false;

// GAP 4: the first library search of a Lean session (`exact?`/`apply?`/`rw?`)
// indexes Mathlib for about a minute, and an edit inside the proof meanwhile
// drops the partial index and starts over (126 s measured instead of 62 s,
// UX FILL-A2, HARDENING #88). Past 3 s of elaborating on such a document the
// pill says both instead of a bare elapsed ticker. UI-only: the timer lives
// here, never in the relay.
const SEARCH_RE = /\b(exact\?|apply\?|rw\?)/;
const SEARCH_HINT = "first library search in this Lean session — about a minute; editing this proof restarts it";
const SEARCH_HINT_AFTER_MS = 3000;
let docText: () => string = () => "";
let searchSession = ""; // the session the warm-index fact belongs to (a reboot loses the index)
let searchIndexWarm = false;
let elaboratingSince: number | null = null;
let searchSeen = false; // the document matched SEARCH_RE during this elaborating stretch
let hintShown = false;
function trackSearch(s: PageStatus): void {
  if (s.session !== searchSession) { searchSession = s.session; searchIndexWarm = false; elaboratingSince = null; searchSeen = false; hintShown = false; }
  if (s.phase === "elaborating") {
    if (elaboratingSince === null) elaboratingSince = performance.now();
    return;
  }
  if (elaboratingSince !== null && (searchSeen || SEARCH_RE.test(docText()))) searchIndexWarm = true; // a search completed: the index is warm
  elaboratingSince = null; searchSeen = false; hintShown = false;
}
function tickSearchHint(): void {
  if (elaboratingSince === null || searchIndexWarm || hintShown) return;
  if (!SEARCH_RE.test(docText())) return;
  searchSeen = true;
  if (performance.now() - elaboratingSince < SEARCH_HINT_AFTER_MS) return;
  hintShown = true;
  ui.progress(SEARCH_HINT);
}

// GAP 3: a session that booted light (init only) and whose header now names
// Mathlib is refused by the kernel; the page widens it once (a user restart
// with the umbrella, or the overlay entry whose roots cover the header) and
// says "loading <label>…" while the replacement boots.
let widening: string | null = null;

function renderStatus(s: PageStatus) {
  staleWatch(s);
  if (!bootDone) {
    checkFallback.observe(s);
    if (checklist.observe(s)) renderStages(); // a deliberate replacement's first status: back to the runtime step
  }
  if (s.relay === "serving") everServed = true;
  // The memory meter samples on the TRANSITION into ready (HARDENING #76), not
  // on every ready-phase status the relay forwards (several a second).
  if (s.phase === "ready" && !wasReady) sampleMemoryNow?.();
  wasReady = s.phase === "ready";
  trackSearch(s);
  if (s.phase === "halted") {
    const d = s.lastDeath ?? null;
    // HARDENING #72: a stack pause is not a failed boot, even before the first
    // ready: the editor and the relay's note on the line stay visible.
    if (d?.cause?.code === ENGINE_STACK_OVERFLOW) {
      bootFinish();
      ui.idle(STACK_PAUSED_LABEL);
      return;
    }
    // A boot that never served: the failure card, and the pill says the same
    // words. Not gated on the overlay: once it is gone `bootFail` is a no-op
    // and the pill alone must carry the message.
    if (d && !everServed) {
      ui.idle(`could not start — ${bootFailLabel(d.message || d.reason, d.cause)}`);
      bootFail(d.message || d.reason, d.cause);
      return;
    }
    // The boot works here, so the content (or a reboot's download) stopped
    // the checker (FILL-A6): the editor, the phase's words instead of
    // "halted — <reason>" (the death goes in the tooltip), the relay's note.
    bootFinish();
    const label = isNetworkCause(d?.cause) ? NETWORK_HALT_LABEL : PHASE_LABEL.halted;
    ui.idle(label);
    if (d) ptext.title = `${label}\n(last death: ${d.reason}${d.message ? ` — ${d.message}` : ""})`;
    return;
  }
  if (s.phase !== "booting" && s.phase !== "starting") widening = null;
  // A liveness death (HARDENING #52: the Lean side stopped answering) is not
  // a crash; say what happened while the relay reboots for it (keyed on why
  // THIS reboot happens, not on the sticky lastDeath a later user restart
  // would inherit).
  const wedged = s.relay === "rebooting" && s.rebootReason === "wedged";
  const label = widening ? `loading ${widening}…` : wedged ? WEDGED_LABEL : s.phase === "elaborating" && hintShown ? SEARCH_HINT : PHASE_LABEL[s.phase];
  if (s.phase === "booting" || s.phase === "starting" || s.phase === "elaborating" || s.phase === "dead") ui.busy(label);
  else ui.idle(label);
  if (s.phase === "ready" || s.phase === "headerRefused") bootFinish();
}

// ---- Examples -------------------------------------------------------------
const EXAMPLES: Record<string, string> = {
  mathlib: `import Mathlib.Basic.Real.Basic

example (a b c : ℝ) : c * b * a = b * (a * c) := by
  rw [mul_comm c b]
  rw [mul_assoc b c a]
  rw [mul_comm c a]

example (x y : ℝ) (h1 : x < y) (h2 : 0 < x) : x * 2 < y * 2 := by
  linarith

example : False := sorry
`,
  mil: `import MIL.Common
import Mathlib.Basic.Real.Basic

example (a b c : ℝ) : a * (b * c) = b * (a * c) := by
  rw [← mul_assoc]
  rw [mul_comm a]
  rw [mul_assoc]

example (a b c d : ℝ) (hyp : c = b * a - d) (hyp' : d = a * b) : c = 0 := by
  rw [hyp]
  rw [hyp']
  rw [mul_comm]
  rw [sub_self]
`,
  init: `inductive Tree (α : Type) where
  | leaf : Tree α
  | node : Tree α → α → Tree α → Tree α

def Tree.size : Tree α → Nat
  | .leaf => 0
  | .node l _ r => l.size + r.size + 1

def Tree.mirror : Tree α → Tree α
  | .leaf => .leaf
  | .node l x r => .node r.mirror x l.mirror

theorem Tree.mirror_size (t : Tree α) : t.mirror.size = t.size := by
  induction t with
  | leaf => rfl
  | node l x r ihl ihr => simp [mirror, size, ihl, ihr]; omega
`,
};

// ---- The plain page's own controls ------------------------------------------
// Page-only elements start `hidden` in the markup; this one block shows and installs them, and only outside
// ?embed=1 (docs/EMBEDDING.md §3), so an embedder's frame never renders them and none of their listeners exists there.
if (!EMBED) {
  const pageActions = document.getElementById("pageactions")!;
  // "Copy link" (file-io.ts): a link to the editor's text, never this page's own URL (HARDENING #77). Before the
  // editor is mounted there is no text, and the button says "nothing to share".
  installShareButton(document.getElementById("sharebtn") as HTMLButtonElement, () => pageApi.api.getDocument()?.text ?? "");
  // Open… and Download (file-io.ts; HARDENING #89), with Ctrl/Cmd+O and Ctrl/Cmd+S: installed at module start, so the
  // keys never reach the browser's Open File and Save Page As, during the boot either. A file opens as one undoable
  // edit (the #86 rule: setDocument, never setValue); before the editor exists it becomes the boot document or waits.
  // A refusal is said on the button and to the screen reader (#pstatus), not on the pill (render(status)).
  installFileActions({
    getText: () => pageApi.api.getDocument()?.text ?? null,
    setText: (text) => pageApi.api.setDocument(text, { cursor: { lineNumber: 1, column: 1 }, focus: true }),
    announce,
  }, { open: document.getElementById("fileopen") as HTMLButtonElement, save: document.getElementById("filesave") as HTMLButtonElement });
  pageActions.hidden = false;
  // The curated-Mathlib note beside the pill (mathlib-coverage.ts; UX M1.5, HARDENING #89): while Lean reports an
  // unknown name under `import Mathlib` or `import Mathlib.Tactic`, the name may be from an area the umbrella leaves
  // out. Each Lean publish is the whole current set, so the note follows the document; the relay's own notes (origin
  // "qed64") leave it as it is. The pill itself stays render(status): lanes read its `ready`.
  const coverNote = document.getElementById("mathlibnote")!;
  coverNote.title = `import Mathlib here is a curated part of Mathlib: ${MATHLIB_GAPS}. An "Unknown identifier" for a name from those areas means it is not served here.`;
  pageApi.api.on("diagnostics", (d) => { if (d.origin === "lean") coverNote.hidden = !coverageHint(docText(), d.diagnostics); });
}

async function main() {
  // ?memory=<GiB> (docs/EMBEDDING.md §4): the initial commit of every session;
  // validated before anything is fetched, a refused value fails the boot.
  const memoryBytes = parseMemoryParam(location.search);
  // ?edithold=<n> (§4, §7.8): the edit back-pressure's free-Worker threshold for
  // every session (0 disables the hold); the ResidentHost option is the fact.
  const editHold = parseEditHoldParam(location.search);
  const artifacts = await installArtifacts(ui);
  // Identify the exact compiler in the product bar: Lean version + fork commit visible; the full provenance (the
  // runtime id, the Mathlib) in the tooltip, beside the memory meter's lines (renderBuildTitle).
  {
    const bi = document.getElementById("buildinfo");
    const rt = artifacts.runtime;
    if (bi && rt.leanVersion) {
      const fork = /@([0-9a-f]+)/.exec(rt.sourceRevision ?? "")?.[1];
      bi.textContent = `Lean ${rt.leanVersion} · wasm64${fork ? ` · qed64@${fork.slice(0, 7)}` : ""}`;
      provenance = [
        `Lean ${rt.leanVersion}`,
        rt.sourceRevision ?? "source revision unknown",
        ...(MATHLIB ? [`Mathlib ${MATHLIB.tag ? `${MATHLIB.tag} ` : ""}(${MATHLIB.commit.slice(0, 7)}), a curated part; see README "Which Mathlib"`] : []),
        `runtime ${rt.buildId}`,
        "no servers — everything runs in this tab",
      ];
      renderBuildTitle();
    }
  }
  // Crash insurance: the buffer persists locally on every edit, so a killed
  // tab (runaway elaboration can still take the renderer down) costs a
  // reload, not the user's proof. Read BEFORE the relay exists: the initial
  // text is a boot input (§6 amendment 15) — an Init-only document boots
  // light, a Mathlib one boots the umbrella. An embedder's `setDocument`
  // before this point wins; in embed mode (docs/EMBEDDING.md §3.1) the buffer
  // is neither read nor written: `#code=`, else `setDocument` (waited for up
  // to 5 s from module start), else the empty document.
  // `#code=` / `#codez=` (lean4web's spellings) are a boot document only in a
  // same-origin frame (FRAMED_SAME_ORIGIN above), and read ONCE: the fragment
  // is dropped from the URL so a reload does not resurrect stale text. On the
  // top-level plain page the same fragment is a share link: `sharedLinkGate`
  // (end of this module) shows it and opens it only on a click (HARDENING #77).
  let restored: string | null = null;
  let initialText: string;
  const hashCode = FRAMED_SAME_ORIGIN ? codeFromHash(location.hash) : null;
  if (!FRAMED_SAME_ORIGIN && EMBED && codeFromHash(location.hash) !== null) console.warn("[qed64] #code=/#codez= ignored: a boot document in the URL is honoured only from a same-origin embedding frame");
  if (hashCode !== null) {
    try { history.replaceState(history.state, "", `${location.pathname}${location.search}`); } catch { /* sandboxed */ }
  }
  if (hashCode !== null) initialText = hashCode;
  else if (EMBED) initialText = (await pageApi.waitBootDocument(embedDeadline)) ?? "";
  else {
    try { restored = window.localStorage.getItem("qed64.buffer"); } catch { /* storage unavailable */ }
    initialText = restored ?? EXAMPLES.mathlib;
  }
  // An embedder's setDocument before this point outranks everything.
  const given = pageApi.takeBootDocument();
  if (given !== null) { initialText = given; restored = null; }
  // The editor's boot policy (resident-session.ts); an embedder passes its own.
  // Over the served snapshot index (docs/EMBEDDING.md §8): an overlay whose
  // entries declare `roots` is booted and widened to by itself.
  const indexPolicy = makeEditorPolicy(artifacts.snapshots);
  // The commit: an api.restart({initialBytes}) sticks until the next explicit
  // restart (across crash reboots and header changes alike), then ?memory=,
  // then the index policy.
  let sessionMemory: number | null = null;
  const policy: ResidentPolicy = {
    ...indexPolicy,
    initialBytesFor: (header, snapshots) => sessionMemory ?? memoryBytes ?? indexPolicy.initialBytesFor!(header, snapshots),
  };
  let relay: LspRelay; // assigned below; the closures here run only from the relay's status sink or a click

  // A name collision under a covered header is explained by the worker's own note (lsp-front-door.js collisionNote);
  // the page offers nothing (D1, 2026-11: "Load exact imports" retired) and never reboots for it (HARDENING #43).

  // GAP 3, the other half of the light boot: a header the kernel refuses for
  // modules one index entry not yet loaded covers widens the session to that
  // entry, once (self-widen.ts; stateless, so a reboot that dropped the entry
  // widens again).
  const widenForRoots = selfWiden(() => relay, artifacts.snapshots, (target) => {
    widening = entryLabel(target);
    ui.busy(`loading ${widening}…`);
    // The replacement's rebooting status (reason "user") disarms the light
    // session's check fallback and rewinds the card's checklist to the runtime
    // step (renderStatus: check-fallback.ts, boot-checklist.ts).
  });
  // The session adapter reads the document it will serve: the initial text
  // at first boot (the relay constructs its first session before `relay` is
  // assigned, so the factory sees `undefined`) AND on a reboot that precedes
  // the editor's first didOpen (`lastText` is still "" — `||`, not `??`: a
  // Mathlib document must not boot light there and pay a widen reboot once
  // the didOpen lands), the relay's last full text on every later reboot —
  // a header change between sessions changes the boot inputs with it.
  relay = new LspRelay(
    (opts) => new ResidentSession({ artifacts, ui, policy, headerText: relay?.lastText || initialText, ...(editHold === null ? {} : { editBackPressure: { minFreeWorkers: editHold } }) }, opts ?? {}),
    { status: pageStatusSink(() => relay.session.id, widenForRoots, renderStatus, (s) => pageApi.relayStatus(s)) },
    () => new Promise((r) => window.setTimeout(r, 1500)),
  );
  const clientPort: MessagePort = relay.clientPort;
  window.addEventListener("pagehide", () => relay.unload());
  // `qed64.status()` is the harness's one oracle (C7): the relay's own datum.
  // `relay.session.lean` is the LeanSession (telemetry: `relay.session.lean.request('telemetry')`).
  Object.assign(qed64Global, {
    artifacts,
    relay,
    ui,
    status: () => relay.status(),
  });
  Object.defineProperty(qed64Global, "editor", { get: () => editor.editor, configurable: true, enumerable: true });
  // The page's taps on the relay (relay-taps.ts): the page API's events, the
  // getWidgetSource cache and the test hatch observe and answer LSP traffic
  // around the relay, never inside it.
  const taps = tapRelay(relay);
  installWidgetSourceCache(taps, () => relay.session.id);
  qed64Global.test = createTestHatch(relay, taps);
  pageApi.bind({
    relay,
    taps,
    memoryBytes: normalizeMemoryBytes,
    setSessionMemory: (bytes) => { sessionMemory = bytes; },
    editor: () => (editor.editor ?? undefined) as unknown as EditorLike | undefined,
    build: { buildId: artifacts.runtime.buildId, leanVersion: artifacts.runtime.leanVersion, sourceRevision: artifacts.runtime.sourceRevision ?? null, shell: null },
    snapshotNames: artifacts.snapshots?.snapshots.map((e) => e.name) ?? [],
  });
  // `request` is LeanSession-private; the meter is a trusted internal peer.
  startMemoryMeter(() => (relay.session as ResidentSession).lean as unknown as Tel);
  window.setInterval(tickSearchHint, 1000);

  // The editor starts while the session boots; it reports nothing to the
  // pill or the card — both belong to the boot (downloads, environment
  // load), and a mounted editor is not a working checker: on a slow first
  // visit the editor is up minutes before the checker is (HARDENING #54).
  // The pill turns idle and "ready" only from the relay's status.
  const leanMonaco = new LeanMonaco();
  const editor = new LeanMonacoEditor();
  // The InfoView's applyEdit / insertText / showDocument act on this editor's
  // model (HARDENING #56); installed before the InfoView registers its API.
  // Its Restart File restarts the Lean session (UX parity F1.13; HARDENING #56's F1.13 note).
  installInfoviewEditorApi(() => (editor.editor ?? undefined) as unknown as EditsEditor | undefined, () => { pageApi.api.restart(); });
  // Firefox: Monaco focuses its textarea with element.focus(), which there does not take the keyboard out of a
  // focused child frame, so after any click in the InfoView a click on the editor typed nowhere (UX parity
  // FILL-A1, HARDENING #85; Chromium moves it by itself). Before Monaco's handler (capture phase), focus this window.
  document.addEventListener("mousedown", (e) => {
    if (document.activeElement instanceof HTMLIFrameElement && !(e.target instanceof HTMLIFrameElement)) window.focus();
  }, true);
  leanMonaco.setInfoviewElement(infoviewEl);

  const options: LeanMonacoOptions = {
    // The undocumented-but-load-bearing seam: `websocket` spreads LAST into
    // monaco-editor-wrapper's connection config, so a WorkerDirect override
    // routes the LSP client at our MessagePort instead of a WebSocket.
    websocket: {
      $type: "WorkerDirect",
      worker: { postMessage() {} },
      messagePort: clientPort,
    } as unknown as { url: string },
    // Over lean4monaco's defaults (dist/leanmonaco.js start()). No colour theme: lean4monaco picks Visual Studio
    // Light or Dark from the OS at start, and the listener below follows a change (HARDENING #87).
    vscode: {
      "lean4.input.leader": "\\",
      // lean4monaco's own editor font, passed at start: its InfoView iframe copies the editor font only when it is
      // made (and on a theme change), and lean4monaco's later default landed after this page's editor (Menlo goals).
      "editor.fontFamily": "'Noto Color Emoji', 'JuliaMono'",
      // Folding by indentation, computed in the browser: Lean's foldingRange waits for the whole file, so each pause
      // in typing would hold one of the edit coalescer's request slots until the check ends (HARDENING #59, #87).
      "editor.folding": true,
      "editor.foldingStrategy": "indentation",
    },
  };
  await leanMonaco.start(options);
  // lean4monaco reads the OS colour scheme once, at start; follow a change to the other of the same two themes.
  const darkOs = window.matchMedia("(prefers-color-scheme: dark)");
  darkOs.addEventListener("change", () => leanMonaco.updateVSCodeOptions({ "workbench.colorTheme": darkOs.matches ? "Visual Studio Dark" : "Visual Studio Light" }));
  registerImportCompletion();
  // Chrome's form-state restore can reset the picker (and fire `change`)
  // long after load — pin it to the content we actually open.
  examplesEl.value = "mathlib";
  await editor.start(editorEl, "/project/Probe.lean", initialText);
  docText = () => editor.editor?.getModel()?.getValue() ?? relay.lastText;
  pageApi.editorReady();
  // UX P1.1, P1.15 (HARDENING #88): the visitor may read and type while Lean downloads and loads (a first visit is
  // about a minute on a fast link), or delete a runaway command from the restored buffer instead of waiting for the
  // check fallback. Shown once the editor exists; not after a failure; not in embed mode, where the embedder owns the
  // boot's UI. The card stays the boot's (#54): bootProgress keeps it current, bootFinish removes it.
  if (!EMBED && !bootDone && !bootCard.classList.contains("failed")) {
    bootShow.hidden = false;
    bootShow.addEventListener("click", () => { bootEl.classList.add("away"); editor.editor?.focus(); });
  }
  document.getElementById("sharedlink")?.focus(); // the editor's start took focus from a panel already up
  if (restored && persistBuffer) ui.progress("restored your last buffer"); // not when a shared snippet's Open replaced it (HARDENING #77)
  let saveTimer: number | undefined;
  if (!EMBED) editor.editor?.getModel()?.onDidChangeContent(() => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { saveTimer = undefined; saveNow(); }, 400);
  });
  function saveNow() {
    try {
      const text = editor.editor?.getModel()?.getValue();
      if (typeof text === "string" && persistBuffer) window.localStorage.setItem("qed64.buffer", text);
    } catch { /* quota or private mode — persistence is best-effort */ }
  }
  // Only a save the debounce still owes: with none pending the store already holds the visitor's text, and a first
  // visit has none to keep (flushing then stored the default example as their buffer; HARDENING #77, 2026-10-18).
  if (!EMBED) {
    flushBufferSave = () => { if (saveTimer === undefined) return; window.clearTimeout(saveTimer); saveTimer = undefined; saveNow(); };
    // Leaving inside the debounce lost the last words (a reload 150-300 ms after a keystroke; HARDENING #86): a reload,
    // a closed tab and a tab sent to the background write what it still owes. visibilitychange also covers the mobile
    // and discard cases in which pagehide may not fire; whichever comes second finds nothing owed.
    window.addEventListener("pagehide", () => flushBufferSave?.());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushBufferSave?.(); });
  }

  // Example switching = a document edit; a header change is resolved
  // in-kernel against the loaded environments (K1), a light session widens
  // itself above, and a halted relay takes the didChange as its re-arm.
  examplesEl.addEventListener("change", () => {
    const src = EXAMPLES[examplesEl.value];
    const model = editor.editor?.getModel();
    if (src && model) {
      // Re-picking the already-loaded example is a no-op: identical text (in
      // the model's line ending, as setDocument compares) is no edit, so no
      // status would follow and nothing would ever clear the busy label — the
      // pill wedged forever.
      if (model.getValue() === src.replace(/\r\n?|\n/g, model.getEOL())) return;
      // One undoable edit (HARDENING #86): model.setValue cleared the undo
      // stack, and the autosave then stored the example over the visitor's
      // work. Ctrl/Cmd+Z now brings it back. The cursor goes to the top, as
      // setValue put it; the focus stays on the menu.
      void pageApi.api.setDocument(src, { cursor: { lineNumber: 1, column: 1 }, focus: false });
      // During the boot the card and the pill keep the boot's own progress
      // (the edit waits for the checker); "checking" would jump the card's
      // checklist past a download that is still running.
      if (bootDone) ui.busy("checking the example");
    }
  });
}

/** Honest memory line: the wasm heap is the page's biggest single block and
 * the only one we can measure; Chromium's compiled-code space and the
 * browser's own overhead sit on top (documented in the tooltip). Warn as the
 * heap nears its cap — growth past it is a recoverable worker abort, but the
 * OS may kill the whole tab first when other heavy tabs crowd the machine. */
type Tel = { request(type: string, payload: Record<string, unknown>): Promise<unknown> };
// The memory meter's sampler, also run when the relay enters `ready` (HARDENING
// #76): the interval alone left `status().memory` null until its first tick,
// 12 s in, which a runtime that is ready in 3 s exposed.
let sampleMemoryNow: (() => void) | null = null;
let wasReady = false;
// The version tooltip (#buildinfo's title) has two writers, main()'s provenance and the memory meter's heap reading,
// and one composer, so each keeps the other's lines (UX F1.11, HARDENING #89: the meter's first sample, at ready,
// replaced the whole title, so the provenance showed only during the boot).
declare const __QED64_MATHLIB__: { commit: string; tag: string | null } | null;
/** The Mathlib the served environment is built from (frontend/vite.config.ts, from the toolchain record), or null. */
const MATHLIB = typeof __QED64_MATHLIB__ === "undefined" ? null : __QED64_MATHLIB__;
let provenance: string[] = [];
let heapLines: string[] = [];
function renderBuildTitle(): void {
  const el = document.getElementById("buildinfo");
  if (el) el.title = [...provenance, ...(provenance.length > 0 && heapLines.length > 0 ? [""] : []), ...heapLines].join("\n");
}
function startMemoryMeter(getSession: () => Tel | null) {
  const el = document.getElementById("buildinfo");
  if (!el) return;
  const base = el.textContent ?? "";
  let warned = false;
  const gib = (n: number) => (n / 1073741824).toFixed(1);
  const sample = () => {
    const session = getSession();
    if (!session) return;
    void Promise.race([
      session.request("telemetry", {}),
      new Promise((r) => window.setTimeout(() => r(null), 800)),
    ]).then((t) => {
      const mem = (t as { memory?: { currentBytes?: number; maximumBytes?: number; regionBytes?: number } } | null)?.memory;
      if (!mem?.currentBytes || !mem.maximumBytes) return;
      pageApi.memory(mem.currentBytes, mem.maximumBytes);
      const frac = mem.currentBytes / mem.maximumBytes;
      el.textContent = `${base} · heap ${gib(mem.currentBytes)}/${gib(mem.maximumBytes)} GiB`;
      el.style.color = frac >= 0.95 ? "#e06c75" : frac >= 0.85 ? "#e2a63d" : "";
      heapLines = [
        `Lean wasm heap: ${gib(mem.currentBytes)} of ${gib(mem.maximumBytes)} GiB cap`,
        `· environment snapshot regions inside the heap: ${gib(mem.regionBytes ?? 0)} GiB`,
        `The browser adds compiled-code and UI overhead on top of this heap;`,
        `near the cap, heavy edits can abort the checker (it restarts itself).`,
      ];
      renderBuildTitle();
      if (frac >= 0.85 && !warned) {
        warned = true;
        console.warn(`[qed64] wasm heap at ${(frac * 100) | 0}% of its ${gib(mem.maximumBytes)} GiB cap — heavy elaboration may restart the checker`);
      }
      if (frac < 0.8) warned = false;
    }, () => { /* the session was disposed or died mid-request (a restart at ready): nothing to show */ });
  };
  sampleMemoryNow = sample;
  window.setInterval(sample, 12000);
}

// ---- Share links on the plain page: the consent gate (HARDENING #77) -------
// A top-level `#code=` / `#codez=` link (lean4web's spellings; the Zulip bot's
// links) is not the boot document: a Lean file can carry a widget module whose
// JS runs in the same-origin InfoView with no click. So the page boots as it
// would without the fragment, and a panel shows the decoded text instead. Open
// hands the text to the page API (it queues until the editor is ready) and
// turns this load's persistence off, so the visitor's own saved buffer is never
// overwritten by a snippet somebody sent them; Dismiss only drops the fragment.
// Built with createElement/textContent: the snippet is never markup. A page
// without such a fragment builds no panel until one arrives (`hashchange`).
let persistBuffer = true;
// main() installs this once the editor persists: Open flushes the visitor's own pending edit before turning persistence off.
let flushBufferSave: (() => void) | null = null;
function sharedLinkGate(text: string): void {
  document.getElementById("sharedlink")?.remove(); // one panel: a newer link replaces it
  const PREVIEW_LINES = 12;
  const lines = text.split("\n");
  const lineCount = text.endsWith("\n") ? lines.length - 1 : lines.length;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, id: string, content?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    e.id = id;
    if (content !== undefined) e.textContent = content;
    return e;
  };
  const button = (id: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = el("button", id, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  };
  const panel = el("div", "sharedlink");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "sharedlink-title");
  const pre = el("pre", "sharedlink-text", lines.slice(0, PREVIEW_LINES).join("\n"));
  const close = () => {
    panel.remove();
    try { history.replaceState(history.state, "", `${location.pathname}${location.search}`); } catch { /* sandboxed */ }
  };
  panel.append(
    el("h2", "sharedlink-title", "This link carries Lean code"),
    el("p", "sharedlink-size", `${lineCount} lines, ${text.length} characters`),
    pre,
  );
  if (lineCount > PREVIEW_LINES) {
    const more = button("sharedlink-more", `show all ${lineCount} lines`, () => { pre.textContent = text; more.remove(); });
    panel.append(more);
  }
  panel.append(el("p", "sharedlink-note", "Opening it runs Lean on it in your browser, as any text you type would."));
  if (sharedLinkFlags(text).length > 0) {
    panel.append(el("p", "sharedlink-flag", "This snippet contains code that runs when checked (evaluation or widgets): open it only if you trust the sender."));
  }
  const actions = el("div", "sharedlink-actions");
  actions.append(
    button("sharedlink-open", "Open in editor", () => {
      close();
      flushBufferSave?.();
      persistBuffer = false;
      void pageApi.api.setDocument(text).catch((e: unknown) => console.warn("[qed64] shared snippet not opened:", e));
      ui.progress("shared snippet opened; your saved buffer is untouched");
    }),
    button("sharedlink-dismiss", "Dismiss", close),
  );
  panel.append(actions);
  document.body.append(panel);
  // Focus the panel (not Open: no accidental Enter), so Tab reaches its buttons; the editor keeps Tab for itself.
  panel.tabIndex = -1;
  panel.focus();
}
if (!FRAMED_SAME_ORIGIN && !EMBED) {
  const shared = codeFromHash(location.hash);
  if (shared) sharedLinkGate(shared); // an empty document is nothing to open
  // A link pasted into a tab already on QED64 changes only the fragment: the browser does not reload, so the
  // panel follows the fragment (HARDENING #77). Not after a failed boot: nothing could open it.
  window.addEventListener("hashchange", () => {
    const next = codeFromHash(location.hash);
    if (next && (bootDone || !bootCard.classList.contains("failed"))) sharedLinkGate(next); // a failed boot that recovered counts as up
  });
}

void main().catch((err) => {
  bootFail(`${(err as Error)?.message ?? err}`, failureCauseOf(err, { stage: "failed" }));
  ui.idle(`FAILED: ${(err as Error)?.message ?? err}`);
  console.error(err);
});
