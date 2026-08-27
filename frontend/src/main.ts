// QED64 × lean4monaco: the live.lean-lang.org editing experience (Monaco +
// the real vscode-lean4 InfoView) with zero servers — the Lean file worker
// runs in this browser tab on the wasm64 runtime.
import { LeanMonaco, LeanMonacoEditor, type LeanMonacoOptions } from "lean4monaco";
import { installArtifacts, newSession, type ProgressInfo, type Qed64Session, type StatusSink } from "./qed64-boot";
import { WatchdogShim } from "./watchdog-shim";

const editorEl = document.getElementById("editor")! as HTMLElement;
const infoviewEl = document.getElementById("infoview")! as HTMLElement;
const pill = document.getElementById("pill")!;
const ptext = document.getElementById("ptext")!;
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
    // The editor-ready idle precedes the first elaboration; if that final
    // "ready" never lands (nothing to elaborate, a missed transition), the
    // overlay must still get out of the way eventually.
    else if (/^ready/.test(label)) window.setTimeout(bootFinish, 120000);
    console.log(`[qed64] ${label}`);
  },
};

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
  let shim: WatchdogShim | null = null;
  const makeSession = (opts?: { mathlib?: boolean }): Promise<Qed64Session> =>
    newSession(artifacts, ui, () => void shim?.handleWorkerDeath(), opts);
  // The default example is a Mathlib one — commit the umbrella-sized heap.
  const qs = await makeSession({ mathlib: true });
  shim = new WatchdogShim(artifacts, qs, ui, makeSession);
  window.addEventListener("pagehide", () => shim?.disposeForUnload());
  (globalThis as unknown as Record<string, unknown>).qed64 = { artifacts, shim, ui, get editor() { return editor.editor; } };

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
      messagePort: shim.clientPort,
    } as unknown as { url: string },
    vscode: {
      "workbench.colorTheme": "Visual Studio Light",
      "lean4.input.leader": "\\",
    },
  };
  await leanMonaco.start(options);
  // Chrome's form-state restore can reset the picker (and fire `change`)
  // long after load — pin it to the content we actually open.
  examplesEl.value = "mathlib";
  // Crash insurance: the buffer persists locally on every edit, so a killed
  // tab (runaway elaboration can still take the renderer down) costs a
  // reload, not the user's proof.
  let restored: string | null = null;
  try { restored = window.localStorage.getItem("qed64.buffer"); } catch { /* storage unavailable */ }
  await editor.start(editorEl, "/project/Probe.lean", restored ?? EXAMPLES.mathlib);
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

  // Example switching = a document edit; if it changes the header, the
  // worker restarts itself through the shim's death-replay path.
  examplesEl.addEventListener("change", () => {
    const src = EXAMPLES[examplesEl.value];
    const model = editor.editor?.getModel();
    if (src && model) {
      model.setValue(src);
      ui.busy("checking the example");
    }
  });
}

void main().catch((err) => {
  ui.idle(`FAILED: ${(err as Error)?.message ?? err}`);
  bootFail(`${(err as Error)?.message ?? err}`);
  console.error(err);
});
