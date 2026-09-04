// QED64 × lean4monaco: the live.lean-lang.org editing experience (Monaco +
// the real vscode-lean4 InfoView) with zero servers — the Lean file worker
// runs in this browser tab on the wasm64 runtime.
import { LeanMonaco, LeanMonacoEditor, type LeanMonacoOptions } from "lean4monaco";
import { ensureProfile, installArtifacts, loadSnapshotByName, newSession, type ProgressInfo, type Qed64Artifacts, type Qed64Session, type StatusSink } from "./qed64-boot";
import { registerImportCompletion } from "./import-completion";
import { WatchdogShim } from "./watchdog-shim";
import { LspRelay, type RelaySession, type RelayStatus, type RestartOptions } from "./lsp-relay";
import { LeanSession, memoryCandidates, type JsonRpcMessage, type LibraryPack, type WorkerStatus } from "../../src/runtime/client";
import { installProfile } from "../../src/install/profiles";

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

// ---- Resident preview (?resident=1): relay instead of shim -----------------
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
function renderStatus(s: RelayStatus) {
  const label = PHASE_LABEL[s.phase];
  if (s.phase === "booting" || s.phase === "starting" || s.phase === "elaborating" || s.phase === "dead") ui.busy(label);
  else ui.idle(label);
  if (s.phase === "ready" || s.phase === "headerRefused") bootFinish();
}

/** The worker's collision fact (front door `statusOf().collision`; §3 row 8):
 * set while its last publish reported names already declared under a
 * COVERED header, null after a clean burst. Typed here until WorkerStatus
 * carries it. */
type Collision = { names: string[]; version: number | null };
const collisionOf = (s: RelayStatus): Collision | null => (s as { collision?: Collision | null }).collision ?? null;

/** Only the import lines of a header — the pump shim's prepareHeader builds
 * its warm-compile input the same way (the body must not be elaborated on
 * the main thread; the FileWorker does that once the loop opens). */
const IMPORT_LINE = /^\s*(?:public\s+|private\s+)?(?:meta\s+)?import\s+/;
const importLinesOf = (header: string): string[] => header.split("\n").filter((l) => IMPORT_LINE.test(l));

/** Day-5 session adapter (§2.2 L4; §7 day 5). A Worker exists from
 * construction — the relay always has a target and a booting worker queues
 * every frame (§6 amendment 20) — and `start()` runs the boot that
 * qed64-boot.ts's `newSession` performs for the pump path, on the same
 * artifacts, and leaves the worker's loop CLOSED: the relay arms it
 * (`arm()`) only after its BootOk replay (§2.3), so the machine's `booted`
 * fact can never precede the snapshot loads below (§2.4 Booting → Ready is
 * the page's fact, not the wasm boot's). The sync-create/async-boot split
 * moves INTO qed64-boot.ts at S3b (week 2); until then the boot inputs live
 * here: the umbrella-sized initial commit and the boot-only snapshot list —
 * a default session is covered by init + mathlib, and K1 serves exact keys
 * first, so no page-side header reading chooses them. */
class ResidentSession implements RelaySession {
  readonly lean = new LeanSession();
  readonly id: string;
  constructor(private readonly artifacts: Qed64Artifacts, private readonly opts: RestartOptions) {
    this.id = this.lean.id;
    this.lean.onLog = (stream, text) => console.debug(`[lean:${stream}] ${text}`);
    this.lean.onProgress = (p) => ui.progress(p.label ?? p.phase, { phase: p.phase, loaded: p.loaded, total: p.total, unit: p.unit });
  }
  get onLsp() { return this.lean.onLsp; }
  set onLsp(f: (msg: JsonRpcMessage) => void) { this.lean.onLsp = f; }
  get onStatus() { return this.lean.onStatus; }
  set onStatus(f: (s: WorkerStatus) => void) { this.lean.onStatus = f; }
  get onDied() { return this.lean.onDied; }
  set onDied(f: (code: number | null, reason: string, message: string) => void) { this.lean.onDied = f; }
  lsp(msg: JsonRpcMessage, replay?: boolean) { this.lean.lsp(msg, replay); }
  arm() { return this.lean.arm(); }
  dispose() { this.lean.dispose(); }
  async start(): Promise<void> {
    const a = this.artifacts;
    // "Load exact imports" (§3 row 8; HARDENING #43): the header is imported
    // from oleans below, so the ~1 GB olean pack must be installed BEFORE
    // boot — LEAN_PATH and the mounts are boot inputs, and a running worker
    // cannot retro-mount a pack (the pump path's prepareHeader has to throw
    // `__qed64_remount__` and boot again for that; here nothing has booted
    // yet, so the one user restart is the only restart). A pack missing from
    // the index is not a death: the warm compile then fails its imports and
    // the session serves the header covered, with the offer back.
    if (this.opts.packs?.includes("essential") && !(await ensureProfile(a, "essential", ui))) {
      ui.progress("the Mathlib library pack is unavailable — exact imports may fail");
    }
    // Memory-backed segments were TRANSFERRED to the worker that booted them
    // and are detached page-side; a reboot reinstalls them exactly as
    // newSession does (an OPFS install revalidates in ms; memory mode
    // re-downloads). Skipping them silently booted a worker with the pack's
    // mount on LEAN_PATH but none of its bytes; one not in the index any
    // more is dropped from LEAN_PATH and said so, never mounted empty.
    for (const [id, profile] of [...a.installed]) {
      if (!profile.segments.some((seg) => seg.bytes && seg.bytes.buffer.byteLength === 0)) continue;
      const entry = a.index.profiles.find((p) => p.id === id);
      if (!entry) { a.installed.delete(id); console.warn(`[qed64] pack ${id} was consumed by the previous worker and is not in the index; dropped from LEAN_PATH`); continue; }
      ui.busy(`re-preparing the ${id} library for the new session`);
      a.installed.set(id, await installProfile(entry, (p) => ui.progress(`${p.phase} ${id}`, { phase: `pack-${p.phase}`, loaded: p.loaded, total: p.total ?? 0, unit: "bytes" })));
    }
    const packs: LibraryPack[] = [...a.installed.values()].flatMap((p) =>
      p.segments.map((segment, i) => ({ id: `${p.id}#${i}`, ...(segment.blob ? { blob: segment.blob } : {}), ...(segment.bytes ? { bytes: segment.bytes } : {}), metadata: segment.metadata, mountPoint: `/lib/packs/${p.id}` })),
    );
    const cap = 6 * 1073741824;
    const under = memoryCandidates().filter((b) => b <= cap);
    ui.busy("starting Lean");
    await this.lean.boot({
      runtime: a.runtime,
      memory: { initialBytes: 2048 * 1048576, maximumCandidates: under.length ? under : [cap] },
      leanPath: [...a.installed.keys()].map((id) => `/lib/packs/${id}`).join(":"),
      packs,
    });
    const qs: Qed64Session = { session: this.lean, loadedSnapshots: new Set() };
    for (const name of this.opts.snapshots ?? ["init", "mathlib"]) {
      if (!(await loadSnapshotByName(a, qs, name, ui))) throw new Error(`snapshot '${name}' failed to load`);
    }
    if (this.opts.warmHeader) await this.warm(this.opts.warmHeader);
    // Deliberately no arm() here: the relay arms after its replay (§2.3 BootOk).
  }

  /** Exact imports (§2.2 L1(a) "optional warmHeader → _lean_wasm_compile";
   * §6 second pass 14): compile ONLY the header's import lines while the loop
   * is still CLOSED — the worker allows `compile` pre-open only (K-i) — so the
   * real olean import pushes the exact environment into the main-thread
   * cache. K1's lookup is exact-first, so the FileWorker then serves this
   * header from that env (headerStatus mode "exact": no umbrella names, no
   * collision) while every other header stays covered. A failed import is
   * reported, not thrown: a throw here would be a BootFailed death and a
   * crash-loop candidate, whereas serving the header covered again is
   * honest — the collision note and the offer simply come back. */
  private async warm(header: string): Promise<void> {
    const imports = importLinesOf(header);
    if (imports.length === 0) return;
    ui.busy("importing exactly your header from the Mathlib library (about a minute; the checker starts afterwards)");
    try {
      const r = await this.lean.compile(`${imports.join("\n")}\n`, "/workspace/__warm.lean");
      if (r.success) return;
      const why = r.diagnostics.find((d) => d.severity === "error")?.message ?? `exit ${r.exitCode}`;
      console.warn(`[qed64] exact import failed (${why}); serving the header from the preloaded library`);
      ui.progress(`exact import failed: ${why.slice(0, 120)} — using the preloaded library`);
    } catch (err) {
      console.warn(`[qed64] exact import failed: ${(err as Error).message}; serving the header from the preloaded library`);
      ui.progress("exact import failed — using the preloaded library");
    }
  }
}

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
  let shim: WatchdogShim | null = null;
  let relay: LspRelay | null = null;
  let clientPort: MessagePort;
  // ?resident=1 (§7 day 5, S3a): the resident front door + relay, a flagged
  // preview on the R1 kernel. The pump path (WatchdogShim) stays the default
  // and is untouched.
  const resident = new URLSearchParams(location.search).get("resident") === "1";
  type Tel = { request(type: string, payload: Record<string, unknown>): Promise<unknown> };
  let telemetrySession: () => Tel | null;
  if (resident) {
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
          if (relay) relay.restart({ snapshots: ["init", "mathlib"], warmHeader: relay.lastText, packs: ["essential"] });
        });
      } else if (!c && offered) {
        offered = false;
        ui.clearAction?.();
      }
    };
    relay = new LspRelay(
      (opts) => new ResidentSession(artifacts, opts ?? {}),
      { status: (s) => { renderStatus(s); offerExactImports(s); } },
      () => new Promise((r) => window.setTimeout(r, 1500)),
    );
    clientPort = relay.clientPort;
    const r = relay;
    window.addEventListener("pagehide", () => r.unload());
    telemetrySession = () => (r.session as ResidentSession).lean as unknown as Tel;
  } else {
    const makeSession = (opts?: { mathlib?: boolean }): Promise<Qed64Session> =>
      newSession(artifacts, ui, () => void shim?.handleWorkerDeath(), opts);
    // The default example is a Mathlib one — commit the umbrella-sized heap.
    const qs = await makeSession({ mathlib: true });
    shim = new WatchdogShim(artifacts, qs, ui, makeSession, {}, {});
    clientPort = shim.clientPort;
    const s = shim;
    window.addEventListener("pagehide", () => s.disposeForUnload());
    // The getter re-reads shim.qs each tick, so the meter follows worker reboots.
    telemetrySession = () => (s as unknown as { qs?: { session?: Tel } }).qs?.session ?? null;
  }
  // `qed64.status()` is the harness's one oracle on both transports (C7):
  // the same enum from the relay's worker status or the shim's flag→enum getter.
  (globalThis as unknown as Record<string, unknown>).qed64 = {
    artifacts,
    shim,
    relay,
    ui,
    status: () => (relay ? relay.status() : shim!.status()),
    get editor() { return editor.editor; },
  };
  startMemoryMeter(telemetrySession);

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
      // Re-picking the already-loaded example is a no-op: setValue with
      // identical text emits no change event, so the shim never runs and
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
function startMemoryMeter(getSession: () => { request(type: string, payload: Record<string, unknown>): Promise<unknown> } | null) {
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
