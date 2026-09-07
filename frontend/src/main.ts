// QED64 × lean4monaco: the live.lean-lang.org editing experience (Monaco +
// the real vscode-lean4 InfoView) with zero servers — the Lean file worker
// runs in this browser tab on the wasm64 runtime.
import { LeanMonaco, LeanMonacoEditor, type LeanMonacoOptions } from "lean4monaco";
import { installArtifacts, type ProgressInfo, type StatusSink } from "./qed64-boot";
import { registerImportCompletion } from "./import-completion";
import { LspRelay, type RelayStatus } from "./lsp-relay";
import { EDITOR_POLICY, ResidentSession, isUmbrellaModule } from "./resident-session";

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

// ---- Boot overlay: staged first-visit progress with speed and ETA ---------
// The heavy startup (a ~1 GB first-visit download, then a minutes-class
// environment load) gets a full card over the workspace: a progress bar with
// real byte counts, download speed, a time-left estimate, and a stage
// checklist — the status pill alone reads as "stuck" at this scale.
const bootEl = document.getElementById("boot")!;
const bootCard = document.getElementById("bootcard")!;
const bootBar = document.getElementById("bootbar")!;
const bootFill = document.getElementById("bootfill")!;
const bootLabel = document.getElementById("bootlabel")!;
const bootNums = document.getElementById("bootnums")!;
const bootReload = document.getElementById("bootreload")! as HTMLButtonElement;
const STAGES = ["manifests", "core", "runtime", "env", "load", "check"];
let bootStage = 0;
let bootDone = false;
// Downloads report cumulative bytes; a short moving window gives a stable
// speed and time-left estimate that still tracks real throughput changes.
const speedWindow: Array<{ t: number; loaded: number }> = [];
let speedKey = "";

function stageOf(label: string, info?: ProgressInfo): string | null {
  const phase = info?.phase ?? "";
  if (/^fetching manifests/.test(label)) return "manifests";
  if (phase.startsWith("core-") || /core library/.test(label)) return "core";
  if (/^(runtime|filesystem|initialize|memory|import)$/.test(phase) || /^(Starting|Mounting|Initializing)/.test(label)) return "runtime";
  if (phase === "snapshot" || phase === "snapshot-cache" || /environment \(|environment snapshot/i.test(label)) return "env";
  if (phase === "snapshot-load" || phase === "snapshot-init" || /into Lean/.test(label)) return "load";
  if (/elaborating|checking/.test(label)) return "check";
  return null;
}

function renderStages() {
  document.querySelectorAll<HTMLElement>("#bootstages li").forEach((li) => {
    const i = STAGES.indexOf(li.dataset.stage!);
    li.classList.toggle("done", i < bootStage);
    li.classList.toggle("active", i === bootStage);
  });
}

function fmtMB(n: number) {
  return n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576) | 0} MB`;
}

function bootProgress(label: string, info?: ProgressInfo) {
  if (bootDone) return;
  const stage = stageOf(label, info);
  if (stage) {
    const i = STAGES.indexOf(stage);
    if (i > bootStage) speedWindow.length = 0;
    if (i >= bootStage) { bootStage = i; renderStages(); }
  }
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

function bootFinish() {
  if (bootDone) return;
  bootDone = true;
  bootStage = STAGES.length;
  renderStages();
  bootEl.classList.add("done");
  window.setTimeout(() => bootEl.remove(), 600);
}

function bootFail(message: string) {
  if (bootDone) return;
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
  busy(label) {
    if (busySince === null) busySince = performance.now();
    pill.classList.add("busy");
    ptext.textContent = label;
    ptext.title = label;
    if (ticker === undefined) ticker = window.setInterval(renderTime, 1000);
    renderTime();
    bootProgress(label);
    console.log(`[qed64] ${label}`);
  },
  progress(label, info) {
    ptext.textContent = label;
    ptext.title = label;
    bootProgress(label, info);
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
    // The editor-ready idle precedes the first elaboration; if that final
    // "ready" never lands (nothing to elaborate, a missed transition), the
    // overlay must still get out of the way eventually.
    else if (/^ready/.test(label)) window.setTimeout(bootFinish, 120000);
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
// with the umbrella) and says "loading Mathlib…" while the replacement boots.
let widening = false;

function renderStatus(s: PageStatus) {
  if (s.phase === "ready") everReady = true;
  trackSearch(s);
  if (s.phase === "halted") {
    const d = s.lastDeath ?? null;
    // Not gated on the overlay: once it is gone (the 120 s fallback, or a
    // first boot that settled in headerRefused) `bootFail` is a no-op and the
    // pill alone must carry the message, not a bare "halted — bootFailed".
    if (d && !everReady) {
      ui.idle(`could not start — ${d.message || d.reason}`);
      bootFail(d.message || d.reason);
      return;
    }
    ui.idle(d ? `halted — ${d.reason}` : PHASE_LABEL.halted);
    return;
  }
  if (s.phase !== "booting" && s.phase !== "starting") widening = false;
  const label = widening ? "loading Mathlib…" : s.phase === "elaborating" && hintShown ? SEARCH_HINT : PHASE_LABEL[s.phase];
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
  mathlib: `import Mathlib.Data.Real.Basic

example (a b c : ℝ) : c * b * a = b * (a * c) := by
  rw [mul_comm c b]
  rw [mul_assoc b c a]
  rw [mul_comm c a]

example (x y : ℝ) (h1 : x < y) (h2 : 0 < x) : x * 2 < y * 2 := by
  linarith

example : False := sorry
`,
  mil: `import MIL.Common
import Mathlib.Data.Real.Basic

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
  // light, a Mathlib one boots the umbrella.
  let restored: string | null = null;
  try { restored = window.localStorage.getItem("qed64.buffer"); } catch { /* storage unavailable */ }
  const initialText = restored ?? EXAMPLES.mathlib;
  // The editor's boot policy (resident-session.ts); an embedder passes its own.
  const policy = EDITOR_POLICY;
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
      ui.action?.("Load exact imports (about 1 min; first time downloads 1 GB)", () => {
        relay.restart({ snapshots: ["init", "mathlib"], warmHeader: relay.lastText, packs: ["essential"] });
      });
    } else if (!c && offered) {
      offered = false;
      ui.clearAction?.();
    }
  };
  // GAP 3, the other half of the light boot: the kernel refuses a header a
  // light session cannot cover (K1: nothing loaded contains the modules) and
  // reports which modules are missing. When every one of them is under a
  // root the umbrella serves, the fix is the umbrella itself — restart ONCE
  // with it (a user restart, never a death; the relay remembers these
  // options across a crash reboot while the header stays the same). A
  // session that already has the umbrella is never widened again: whatever
  // it refuses, no snapshot would change the verdict.
  let widened: string | null = null;
  const widenForMathlib = (s: RelayStatus) => {
    if (s.phase !== "headerRefused" || !s.header || s.header.mode !== "refused" || relay.state.kind !== "serving") return;
    const session = relay.session as ResidentSession;
    if (session.id !== s.session || session.snapshots.includes("mathlib") || widened === s.session) return;
    const missing = s.header.missing;
    if (missing.length === 0 || !missing.every(isUmbrellaModule)) return;
    widened = s.session;
    widening = true;
    ui.busy("loading Mathlib…");
    relay.restart({ snapshots: ["init", "mathlib"] });
  };
  // The session adapter reads the document it will serve: the initial text
  // at first boot (the relay constructs its first session before `relay` is
  // assigned, so the factory sees `undefined`) AND on a reboot that precedes
  // the editor's first didOpen (`lastText` is still "" — `||`, not `??`: a
  // Mathlib document must not boot light there and pay a widen reboot once
  // the didOpen lands), the relay's last full text on every later reboot —
  // a header change between sessions changes the boot inputs with it.
  relay = new LspRelay(
    (opts) => new ResidentSession({ artifacts, ui, policy, headerText: relay?.lastText || initialText }, opts ?? {}),
    { status: (s) => { renderStatus(s); offerExactImports(s); widenForMathlib(s); } },
    () => new Promise((r) => window.setTimeout(r, 1500)),
  );
  const clientPort: MessagePort = relay.clientPort;
  window.addEventListener("pagehide", () => relay.unload());
  // `qed64.status()` is the harness's one oracle (C7): the relay's own datum.
  // `relay.session.lean` is the LeanSession (telemetry: `relay.session.lean.request('telemetry')`).
  (globalThis as unknown as Record<string, unknown>).qed64 = {
    artifacts,
    relay,
    ui,
    status: () => relay.status(),
    get editor() { return editor.editor; },
  };
  // `request` is LeanSession-private; the meter is a trusted internal peer.
  startMemoryMeter(() => (relay.session as ResidentSession).lean as unknown as Tel);
  window.setInterval(tickSearchHint, 1000);

  ui.busy("starting the editor");
  const leanMonaco = new LeanMonaco();
  const editor = new LeanMonacoEditor();
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
  if (restored) ui.progress("restored your last buffer");
  let saveTimer: number | undefined;
  editor.editor?.getModel()?.onDidChangeContent(() => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      try {
        const text = editor.editor?.getModel()?.getValue();
        if (typeof text === "string") window.localStorage.setItem("qed64.buffer", text);
      } catch { /* quota or private mode — persistence is best-effort */ }
    }, 400);
  });
  ui.idle("ready — put the cursor inside a proof");

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
      ui.busy("checking the example");
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
  ui.idle(`FAILED: ${(err as Error)?.message ?? err}`);
  bootFail(`${(err as Error)?.message ?? err}`);
  console.error(err);
});
