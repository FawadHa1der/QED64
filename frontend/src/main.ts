// QED64 × lean4monaco: the live.lean-lang.org editing experience (Monaco +
// the real vscode-lean4 InfoView) with zero servers — the Lean file worker
// runs in this browser tab on the wasm64 runtime.
import { LeanMonaco, LeanMonacoEditor, type LeanMonacoOptions } from "lean4monaco";
import { installArtifacts, type ProgressInfo, type StatusSink } from "./qed64-boot";
import { registerImportCompletion } from "./import-completion";
import { LspRelay, type RelayStatus } from "./lsp-relay";
import { ResidentSession, makeEditorPolicy, type ResidentPolicy } from "./resident-session";
import { entryLabel } from "../../src/runtime/snapshots";
import { selfWiden } from "./self-widen";
import { installInfoviewEditorApi, type EditsEditor } from "./editor/infoview-edits";
import { codeFromHash, createPageApi, pageStatusSink, type EditorLike } from "./page-api";
import { normalizeMemoryBytes, parseEditHoldParam, parseMemoryParam } from "./embed/params";
import { failureCauseOf, type FailureCause } from "./embed/failure";
import { tapRelay } from "./relay-taps";
import { installWidgetSourceCache } from "./widget-source-cache";
import { createTestHatch } from "./test-hatch";
import { createCheckFallback } from "./check-fallback";
import { STAGES, createBootChecklist } from "./boot-checklist";

// The embedder-facing surface (docs/EMBEDDING.md §2), published synchronously
// at module start — before any of the page's own listeners matter — so an
// embedder can feature-detect and call it before boot: `capabilities.editorRpc`
// = the InfoView's editor RPC works natively here (HARDENING #56), so an
// embedder's own bridge for it must stand down. The rest of `globalThis.qed64`
// (relay, ui, artifacts, editor, status()) joins this same object once the
// relay exists; it is internal (docs/EMBEDDING.md §9).
const pageApi = createPageApi({
  editorRpc: true, documents: true, events: true, restart: true, embedMode: true, snapshotRoots: true, postMessage: false,
  liveness: true, memory: true, widgetSourceCache: true, offers: true,
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
const pill = document.getElementById("pill")!;
const ptext = document.getElementById("ptext")!;
// One explicit action beside the pill (StatusSink.action): created lazily so
// the markup stays a plain pill when nothing is offered.
const pillEl = document.getElementById("pill")!;
let actionBtn: HTMLButtonElement | null = null;
function renderAction(label: string | null, run?: () => void): void {
  if (!label) { if (actionBtn) { actionBtn.remove(); actionBtn = null; } return; }
  if (!actionBtn) {
    actionBtn = document.createElement("button");
    actionBtn.id = "action";
    actionBtn.type = "button";
    actionBtn.style.cssText = "margin-left:.6em;padding:.15em .6em;font:inherit;font-size:.9em;cursor:pointer;border-radius:.4em;border:1px solid currentColor;background:transparent;color:inherit";
    pillEl.insertAdjacentElement("afterend", actionBtn);
  }
  actionBtn.textContent = label;
  actionBtn.title = label;
  actionBtn.onclick = () => { renderAction(null); run?.(); };
}
const ptime = document.getElementById("ptime")!;
const examplesEl = document.getElementById("examples")! as HTMLSelectElement;
if (EMBED) examplesEl.style.display = "none";

// ---- Boot overlay: staged first-visit progress with speed and ETA ---------
// The heavy startup (a ~600 MB first-visit download, then the environment
// load) gets a full card over the workspace: a progress bar with real byte
// counts, download speed, a time-left estimate, and a stage checklist — the
// status pill alone reads as "stuck" at this scale. The card stays for the
// WHOLE boot: on a slow link the downloads alone take many minutes, and the
// card is the only place their progress is shown (HARDENING #54). It goes
// when the checker is actionable (`renderStatus`), when the boot fails (it
// turns into the failure card), or by the check fallback below.
const bootEl = document.getElementById("boot")!;
const bootCard = document.getElementById("bootcard")!;
const bootBar = document.getElementById("bootbar")!;
const bootFill = document.getElementById("bootfill")!;
const bootLabel = document.getElementById("bootlabel")!;
const bootNums = document.getElementById("bootnums")!;
const bootReload = document.getElementById("bootreload")! as HTMLButtonElement;
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
// deliberate replacement (self-widen, restart, exact imports), whose own
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

function bootFail(message: string, cause?: FailureCause) {
  if (bootDone) return;
  pageApi.bootFailed(message, cause);
  bootCard.classList.add("failed");
  bootCard.querySelector("h1")!.textContent = "QED64 could not start";
  bootLabel.textContent = message;
  bootNums.textContent = "";
  bootBar.classList.remove("busy");
  bootReload.hidden = false;
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
const ui: StatusSink = {
  busy(label, info) {
    if (busySince === null) busySince = performance.now();
    pill.classList.add("busy");
    ptext.textContent = label;
    ptext.title = label;
    if (ticker === undefined) ticker = window.setInterval(renderTime, 1000);
    renderTime();
    bootProgress(label, info);
    if (info?.stage) pageApi.bootStep(label, info);
    console.log(`[qed64] ${label}`);
  },
  progress(label, info) {
    ptext.textContent = label;
    ptext.title = label;
    bootProgress(label, info);
    if (info?.stage) pageApi.bootStep(label, info);
  },
  idle(label) {
    busySince = null;
    pill.classList.remove("busy");
    ptext.textContent = label;
    ptext.title = label;
    renderTime();
    if (/^FAILED|failed — reload|restart failed/.test(label)) bootFail(label);
    else if (/^ready$/.test(label)) bootFinish();
    // A restored buffer can boot straight into an actionable state (e.g. a
    // half-typed import that needs editing) — the workspace must be visible
    // for the user to act, so these dismiss the overlay too.
    else if (/^imports (incomplete|failed)/.test(label)) bootFinish();
    console.log(`[qed64] ${label}`);
  },
  action(label, run) { renderAction(label, run); },
  clearAction() { renderAction(null); },
};

// ---- Status: the relay's datum rendered, nothing regexed -------------------
// The pill is `render(status)` — one enum from the worker (§2.2(e)), no label
// strings to regex over (C10). The overlay goes at the first phase in which
// the workspace is actionable: `ready`, or `headerRefused` (a restored buffer
// with a half-typed import needs editing, so it must be visible).
const PHASE_LABEL: Record<RelayStatus["phase"], string> = {
  booting: "starting Lean",
  starting: "starting the Lean checker",
  elaborating: "elaborating",
  ready: "ready",
  headerRefused: "imports incomplete — finish the import line to continue",
  dead: "the checker crashed — restarting (~15 s)",
  halted: "the checker keeps crashing on this content — edit the file to retry",
};
const WEDGED_LABEL = "the checker stopped responding — restarting (~15 s)";
/** The relay's status as this page consumes it. `lastDeath` is the relay's
 * memory of the death that halted it (`onDied(code, reason, message)`, or
 * the boot rejection), null once a session reaches `ready`; optional here so
 * the page compiles against a relay that does not carry it yet. */
type PageStatus = RelayStatus; // lastDeath is on RelayStatus since the relay contract (2026-09-07)

// GAP 2 (page side): a halt BEFORE any session ever reached `ready` is a boot
// that never worked — a Memory64 reservation refused, a capability missing,
// a runtime fetch or snapshot pairing failure — and gets the first-boot
// failure card with its Reload button; a halt after that is the crash-loop
// breaker, explained by the pill and the relay's in-document note.
let everReady = false;

// GAP 4: the first library search of a session (`exact?`/`apply?`/`rw?`)
// indexes Mathlib for about a minute; past 8 s of elaborating on such a
// document the pill says so instead of a bare elapsed ticker. UI-only: the
// timer lives here, never in the relay.
const SEARCH_RE = /\b(exact\?|apply\?|rw\?)/;
const SEARCH_HINT = "first library search — indexing Mathlib (about a minute, once per session)";
const SEARCH_HINT_AFTER_MS = 8000;
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
  if (!bootDone) {
    checkFallback.observe(s);
    if (checklist.observe(s)) renderStages(); // a deliberate replacement's first status: back to the runtime step
  }
  if (s.phase === "ready") everReady = true;
  trackSearch(s);
  if (s.phase === "halted") {
    const d = s.lastDeath ?? null;
    // Not gated on the overlay: once it is gone (the check fallback, or a
    // first boot that settled in headerRefused) `bootFail` is a no-op and the
    // pill alone must carry the message, not a bare "halted — bootFailed".
    if (d && !everReady) {
      ui.idle(`could not start — ${d.message || d.reason}`);
      bootFail(d.message || d.reason, d.cause);
      return;
    }
    ui.idle(d ? `halted — ${d.reason}` : PHASE_LABEL.halted);
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

/** The worker's collision fact (front door `statusOf().collision`, carried
 * on WorkerStatus; §3 row 8): set while its last publish reported names
 * already declared under a COVERED header, null after a clean burst. */
const collisionOf = (s: RelayStatus) => s.collision ?? null;

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

async function main() {
  // ?memory=<GiB> (docs/EMBEDDING.md §4): the initial commit of every session;
  // validated before anything is fetched, a refused value fails the boot.
  const memoryBytes = parseMemoryParam(location.search);
  // ?edithold=<n> (§4, §7.8): the edit back-pressure's free-Worker threshold for
  // every session (0 disables the hold); the ResidentHost option is the fact.
  const editHold = parseEditHoldParam(location.search);
  const artifacts = await installArtifacts(ui);
  // Identify the exact compiler in the product bar: Lean version + fork
  // commit visible, full provenance (incl. runtime id) in the tooltip.
  {
    const bi = document.getElementById("buildinfo");
    const rt = artifacts.runtime;
    if (bi && rt.leanVersion) {
      const fork = /@([0-9a-f]+)/.exec(rt.sourceRevision ?? "")?.[1];
      bi.textContent = `Lean ${rt.leanVersion} · wasm64${fork ? ` · qed64@${fork.slice(0, 7)}` : ""}`;
      bi.title = `Lean ${rt.leanVersion}\n${rt.sourceRevision ?? "source revision unknown"}\nruntime ${rt.buildId}\nno servers — everything runs in this tab`;
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
  // `#code=` (lean4web's spelling) is honoured only in a same-origin frame
  // (FRAMED_SAME_ORIGIN above), and read ONCE: it is dropped from the URL so a
  // reload does not resurrect stale text.
  let restored: string | null = null;
  let initialText: string;
  const hashCode = FRAMED_SAME_ORIGIN ? codeFromHash(location.hash) : null;
  if (!FRAMED_SAME_ORIGIN && codeFromHash(location.hash) !== null) console.warn("[qed64] #code= ignored: a boot document in the URL is honoured only from a same-origin embedding frame");
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

  // EXPLAIN AND OFFER, never reboot on the user's behalf (§3 row 8;
  // HARDENING #43): the worker's publish already carries the note; the page
  // only shows ONE action while the worker reports a collision and
  // withdraws it when the fact clears (a clean burst, a header edit, a
  // replacement session — its first status carries no collision). The
  // click is the deliberate restart: boot-only snapshots + the header's
  // exact imports from the olean pack (relay.restart, counted as a user
  // restart, never a death).
  let offered = false;
  const offerExactImports = (s: RelayStatus) => {
    const c = collisionOf(s);
    if (c && !offered) {
      offered = true;
      const label = "Load exact imports (about 1 min; first time downloads 1 GB)";
      const run = () => {
        ui.clearAction?.();
        // The collision happens under a covered header, so this session holds the
        // environment that covers it: keep its snapshot list (an overlay entry
        // need not be named "mathlib").
        relay.restart({ snapshots: [...(relay.session as ResidentSession).snapshots], warmHeader: relay.lastText, packs: ["essential"] });
      };
      ui.action?.(label, run);
      pageApi.setOffer({ kind: "exactImports", label }, run);
    } else if (!c && offered) {
      offered = false;
      ui.clearAction?.();
      pageApi.setOffer(null);
    }
  };
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
    { status: pageStatusSink(() => relay.session.id, widenForRoots, renderStatus, offerExactImports, (s) => pageApi.relayStatus(s)) },
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
  installInfoviewEditorApi(() => (editor.editor ?? undefined) as unknown as EditsEditor | undefined);
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
    vscode: {
      "workbench.colorTheme": "Visual Studio Light",
      "lean4.input.leader": "\\",
    },
  };
  await leanMonaco.start(options);
  registerImportCompletion();
  // Chrome's form-state restore can reset the picker (and fire `change`)
  // long after load — pin it to the content we actually open.
  examplesEl.value = "mathlib";
  await editor.start(editorEl, "/project/Probe.lean", initialText);
  docText = () => editor.editor?.getModel()?.getValue() ?? relay.lastText;
  pageApi.editorReady();
  if (restored) ui.progress("restored your last buffer");
  let saveTimer: number | undefined;
  if (!EMBED) editor.editor?.getModel()?.onDidChangeContent(() => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        const text = editor.editor?.getModel()?.getValue();
        if (typeof text === "string") window.localStorage.setItem("qed64.buffer", text);
      } catch { /* quota or private mode — persistence is best-effort */ }
    }, 400);
  });

  // Example switching = a document edit; a header change is resolved
  // in-kernel against the loaded environments (K1), a light session widens
  // itself above, and a halted relay takes the didChange as its re-arm.
  examplesEl.addEventListener("change", () => {
    const src = EXAMPLES[examplesEl.value];
    const model = editor.editor?.getModel();
    if (src && model) {
      // Re-picking the already-loaded example is a no-op: setValue with
      // identical text emits no change event, so no status would follow and
      // nothing would ever clear the busy label — the pill wedged forever.
      if (model.getValue() === src) return;
      model.setValue(src);
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
function startMemoryMeter(getSession: () => Tel | null) {
  const el = document.getElementById("buildinfo");
  if (!el) return;
  const base = el.textContent ?? "";
  let warned = false;
  const gib = (n: number) => (n / 1073741824).toFixed(1);
  window.setInterval(() => {
    const session = getSession();
    if (!session) return;
    void Promise.race([
      session.request("telemetry", {}),
      new Promise((r) => window.setTimeout(() => r(null), 800)),
    ]).then((t) => {
      const mem = (t as { memory?: { currentBytes?: number; maximumBytes?: number; regionBytes?: number; memfsPackBytes?: number } } | null)?.memory;
      if (!mem?.currentBytes || !mem.maximumBytes) return;
      pageApi.memory(mem.currentBytes, mem.maximumBytes);
      const frac = mem.currentBytes / mem.maximumBytes;
      el.textContent = `${base} · heap ${gib(mem.currentBytes)}/${gib(mem.maximumBytes)} GiB`;
      el.style.color = frac >= 0.95 ? "#e06c75" : frac >= 0.85 ? "#e2a63d" : "";
      el.title = [
        `Lean wasm heap: ${gib(mem.currentBytes)} of ${gib(mem.maximumBytes)} GiB cap`,
        `· environment snapshot regions inside the heap: ${gib(mem.regionBytes ?? 0)} GiB`,
        (mem.memfsPackBytes ?? 0) > 0 ? `· library packs copied into worker memory: ${gib(mem.memfsPackBytes ?? 0)} GiB (OPFS unavailable — storage-backed on healthy browsers)` : `· library packs: storage-backed (not in memory)`,
        `The browser adds compiled-code and UI overhead on top of this heap;`,
        `near the cap, heavy edits can abort the checker (it restarts itself).`,
      ].join("\n");
      if (frac >= 0.85 && !warned) {
        warned = true;
        console.warn(`[qed64] wasm heap at ${(frac * 100) | 0}% of its ${gib(mem.maximumBytes)} GiB cap — heavy elaboration may restart the checker`);
      }
      if (frac < 0.8) warned = false;
    });
  }, 12000);
}

void main().catch((err) => {
  bootFail(`${(err as Error)?.message ?? err}`, failureCauseOf(err, { stage: "failed" }));
  ui.idle(`FAILED: ${(err as Error)?.message ?? err}`);
  console.error(err);
});
