// QED64 application: wires editor ⇄ session ⇄ installer ⇄ panels.

import { createEditor, type EditorHandle } from "./editor/setup";
import {
  LeanSession,
  probeMemory64,
  memoryCandidates,
  type CompileResult,
  type Diagnostic,
  type LibraryPack,
  type ReadyInfo,
  type RuntimeManifest,
} from "./runtime/client";
import {
  fetchProfileIndex,
  importClosure,
  importLineOf,
  installProfile,
  parseImports,
  storageEstimate,
  type InstalledProfile,
  type ProfileIndex,
} from "./install/profiles";
import { EXAMPLES } from "./examples";
import { parseCoverageLints } from "./editor/coverage";
import { fetchSnapshotIndex, matchSnapshot, snapshotCacheKey, type SnapshotIndex } from "./runtime/snapshots";
import { isStaleStorageError } from "./runtime/errors";
import {
  UMBRELLA_ALIAS_MODULES,
  UMBRELLA_MODULE,
  rewriteHeaderToUmbrella,
  shouldUseUmbrella,
} from "./runtime/umbrella";

const AUTOCHECK_DEBOUNCE_MS = 900;
const PROFILE_PREF_KEY = "qed64.profile";
const GiB = 1024 ** 3;

type AppPhase =
  | "probing"
  | "unsupported"
  | "installing"
  | "booting"
  | "ready"
  | "checking"
  | "failed";

interface AppElements {
  editorPane: HTMLElement;
  run: HTMLButtonElement;
  auto: HTMLInputElement;
  examples: HTMLSelectElement;
  share: HTMLButtonElement;
  themeToggle: HTMLButtonElement;
  installMathlib: HTMLButtonElement;
  strictHeaders: HTMLInputElement;
  tabs: NodeListOf<HTMLButtonElement>;
  panels: Record<"messages" | "goals" | "setup", HTMLElement>;
  statusState: HTMLElement;
  statusVersion: HTMLElement;
  statusMemory: HTMLElement;
  statusTiming: HTMLElement;
  progressRow: HTMLElement;
  progressLabel: HTMLElement;
  progressBar: HTMLElement;
  setupLog: HTMLElement;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

function esc(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function fmtBytes(n: number): string {
  if (n >= GiB) return `${(n / GiB).toFixed(2)} GiB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(0)} MiB`;
  return `${(n / 1024).toFixed(0)} KiB`;
}

function fmtSeconds(s: number): string {
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`;
}

export class App {
  private el: AppElements;
  private editor: EditorHandle;
  private session: LeanSession | null = null;
  private index: ProfileIndex | null = null;
  private runtime: RuntimeManifest | null = null;
  private installed = new Map<string, InstalledProfile>();
  private moduleSet = new Set<string>();
  private moduleGraph: Record<string, { imports: string[] }> = {};
  private snapshotIndex: SnapshotIndex | null = null;
  /** Import sets whose closure the resident environment has already paid
   * for this session (ordered-imports key, matching the runtime's cache). */
  private paidImportSets = new Set<string>();
  private phase: AppPhase = "probing";
  private ready: ReadyInfo | null = null;
  private autoTimer: number | undefined;
  private checkTicker: number | undefined;
  private checkStartedAt = 0;
  private compileQueued: false | "manual" | "auto" = false;
  private pendingStorageRecovery: "manual" | "auto" | null = null;
  private pendingRuntimeProbe: "manual" | "auto" | null = null;
  private runtimeRecoveryAttempted = false;
  /** A long preparation step in flight (snapshot download/load or a closure
   * import), rendered live by the checking ticker so the UI never looks stuck. */
  private prep: {
    title: string;
    stage: string;
    detail: string;
    startedAt: number;
    loaded?: number;
    total?: number;
    unit?: "bytes" | "modules";
    indeterminate: boolean;
  } | null = null;
  private storageRecoveryAttempted = false;
  /** One free retry when a compile bounces off a still-busy worker
   * (BAD_STATE, "Worker is 'compiling', not ready"): queue-and-rerun instead
   * of rendering it as a compile failure. The session serializes its own
   * RPCs, so this only fires if app and worker state ever disagree again —
   * a second consecutive bounce falls through to the normal error path. */
  private workerBusyRetried = false;
  private umbrellaFirstCheckDone = false;
  private snapshotPrefetchStarted = false;
  private lastDiagnostics: Diagnostic[] = [];
  private cursorLine = 1;
  private generation = 0;
  private checkSeq = 0;

  constructor() {
    this.el = {
      editorPane: $("editor-pane"),
      run: $("run") as HTMLButtonElement,
      auto: $("auto") as HTMLInputElement,
      examples: $("examples") as HTMLSelectElement,
      share: $("share") as HTMLButtonElement,
      themeToggle: $("theme-toggle") as HTMLButtonElement,
      installMathlib: $("install-mathlib") as HTMLButtonElement,
      strictHeaders: $("strict-headers") as HTMLInputElement,
      tabs: document.querySelectorAll<HTMLButtonElement>(".tab"),
      panels: {
        messages: $("panel-messages"),
        goals: $("panel-goals"),
        setup: $("panel-setup"),
      },
      statusState: $("status-state"),
      statusVersion: $("status-version"),
      statusMemory: $("status-memory"),
      statusTiming: $("status-timing"),
      progressRow: $("progress-row"),
      progressLabel: $("progress-label"),
      progressBar: $("progress-bar"),
      setupLog: $("setup-log"),
    };

    (window as unknown as { __qedApp?: App }).__qedApp = this;
    const fromHash = this.sourceFromHash();
    const saved = localStorage.getItem("qed64.buffer");
    this.editor = createEditor(this.el.editorPane, fromHash ?? saved ?? EXAMPLES[0]!.source);
    this.wireUi();
    void this.start();
  }

  // -- UI wiring ------------------------------------------------------------

  private wireUi() {
    for (const example of EXAMPLES) {
      const option = document.createElement("option");
      option.value = example.id;
      option.textContent = example.title;
      this.el.examples.append(option);
    }
    this.el.examples.addEventListener("change", () => {
      const example = EXAMPLES.find((e) => e.id === this.el.examples.value);
      if (!example) return;
      this.editor.setSource(example.source);
      this.scheduleAutoCheck();
    });
    this.el.run.addEventListener("click", () => void this.check("manual"));
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.check("manual");
      }
    });
    this.editor.onChange(() => {
      this.scheduleAutoCheck();
      try {
        localStorage.setItem("qed64.buffer", this.editor.getSource());
      } catch {
        /* storage full or unavailable — the buffer just won't survive reload */
      }
    });
    this.editor.onCursor((line) => {
      this.cursorLine = line;
      this.renderGoals();
    });
    for (const tab of this.el.tabs) {
      tab.addEventListener("click", () => {
        for (const other of this.el.tabs) other.classList.toggle("active", other === tab);
        for (const [name, panel] of Object.entries(this.el.panels)) {
          panel.classList.toggle("hidden", name !== tab.dataset.panel);
        }
      });
    }
    this.el.share.addEventListener("click", () => void this.copyShareLink());
    this.el.themeToggle.addEventListener("click", () => this.toggleTheme());
    this.el.installMathlib.addEventListener("click", () => void this.installEssential());
    this.el.strictHeaders.checked = localStorage.getItem("qed64.strictHeaders") === "1";
    this.el.strictHeaders.addEventListener("change", () => {
      localStorage.setItem("qed64.strictHeaders", this.el.strictHeaders.checked ? "1" : "0");
      this.scheduleAutoCheck();
    });
  }

  private toggleTheme() {
    const root = document.documentElement;
    const current = root.dataset.theme;
    const next =
      current === "dark" ? "light" : current === "light" ? "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark";
    root.dataset.theme = next;
    localStorage.setItem("qed64.theme", next);
  }

  private sourceFromHash(): string | null {
    const match = /#code=([A-Za-z0-9\-_]+)/.exec(location.hash);
    if (!match) return null;
    try {
      const b64 = match[1]!.replace(/-/g, "+").replace(/_/g, "/");
      return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }

  private async copyShareLink() {
    const bytes = new TextEncoder().encode(this.editor.getSource());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const url = `${location.origin}${location.pathname}#code=${b64}`;
    try {
      await navigator.clipboard.writeText(url);
      this.el.share.textContent = "Copied!";
    } catch {
      prompt("Share link:", url);
    }
    setTimeout(() => (this.el.share.textContent = "Share"), 1500);
  }

  // -- Lifecycle ------------------------------------------------------------

  private updateCheckingLabel() {
    if (this.phase !== "checking") return;
    const seconds = Math.round((performance.now() - this.checkStartedAt) / 1000);
    const queued = this.compileQueued ? " · latest edit queued" : "";
    if (this.prep) {
      const elapsed = Math.round((performance.now() - this.prep.startedAt) / 1000);
      this.el.statusState.textContent = `${this.prep.title}… ${elapsed}s${queued}`;
      const pct =
        this.prep.loaded !== undefined && this.prep.total
          ? this.prep.unit === "modules"
            ? ` — ${this.prep.loaded}/${this.prep.total} modules`
            : ` — ${fmtBytes(this.prep.loaded)} / ${fmtBytes(this.prep.total)}`
          : "";
      this.showProgress(
        `${this.prep.stage}${pct} · ${fmtSeconds(elapsed)} elapsed`,
        this.prep.indeterminate ? undefined : this.prep.loaded,
        this.prep.indeterminate ? undefined : this.prep.total,
      );
      this.renderStatusCard(this.prep.title, this.prep.stage, this.prep.detail, elapsed);
      return;
    }
    this.el.statusState.textContent =
      seconds >= 3 ? `Checking… ${seconds}s${queued}` : `Checking…${queued}`;
  }

  /** A live card in the Messages panel for operations long enough that a
   * static panel (or a stale warning from the previous check) reads as
   * "broken". Replaced by the real verdict when the check completes. */
  private renderStatusCard(title: string, stage: string, detail: string, elapsedSeconds: number) {
    const panel = this.el.panels.messages;
    let card = panel.querySelector<HTMLElement>(".status-card");
    if (!card) {
      panel.innerHTML = "";
      card = document.createElement("div");
      card.className = "status-card";
      panel.append(card);
    }
    card.innerHTML =
      `<div class="status-card-title"><span class="spinner"></span>${esc(title)} <span class="check-seq">${fmtSeconds(elapsedSeconds)}</span></div>` +
      `<div class="status-card-stage">${esc(stage)}</div>` +
      `<div class="status-card-detail">${esc(detail)}</div>`;
  }

  private setPhase(phase: AppPhase, detail?: string) {
    this.phase = phase;
    const labels: Record<AppPhase, string> = {
      probing: "Probing browser…",
      unsupported: "Unsupported browser",
      installing: detail ?? "Installing…",
      booting: detail ?? "Starting Lean…",
      ready: "Ready",
      checking: "Checking…",
      failed: detail ?? "Failed",
    };
    this.el.statusState.textContent = labels[phase];
    this.el.statusState.dataset.phase = phase;
    this.el.run.disabled = phase !== "ready" && phase !== "checking";
  }

  private setupLog(text: string) {
    const line = document.createElement("div");
    line.className = "setup-line";
    line.textContent = text;
    this.el.setupLog.append(line);
    this.el.setupLog.scrollTop = this.el.setupLog.scrollHeight;
  }

  private showProgress(label: string, loaded?: number, total?: number) {
    this.el.progressRow.classList.remove("hidden");
    this.el.progressLabel.textContent = label;
    if (loaded !== undefined && total) {
      this.el.progressBar.style.width = `${Math.min(100, (loaded / total) * 100)}%`;
      this.el.progressBar.classList.remove("indeterminate");
    } else {
      this.el.progressBar.style.width = "40%";
      this.el.progressBar.classList.add("indeterminate");
    }
  }

  private hideProgress() {
    this.el.progressRow.classList.add("hidden");
  }

  async start(): Promise<void> {
    this.setPhase("probing");
    const supported =
      probeMemory64() &&
      typeof SharedArrayBuffer === "function" &&
      crossOriginIsolated === true;
    if (!supported) {
      this.setPhase("unsupported");
      this.el.panels.setup.classList.remove("hidden");
      this.el.panels.messages.classList.add("hidden");
      this.setupLog("This editor needs WebAssembly Memory64, SharedArrayBuffer, and cross-origin isolation.");
      this.setupLog(`Memory64: ${probeMemory64() ? "yes" : "NO"} · SharedArrayBuffer: ${typeof SharedArrayBuffer === "function" ? "yes" : "NO"} · isolated: ${crossOriginIsolated ? "yes" : "NO"}`);
      this.setupLog("Use desktop Chrome/Edge 133+ or Firefox 134+. Safari does not support Memory64 yet.");
      return;
    }
    this.setupLog("Browser capabilities: Memory64 ✓ SharedArrayBuffer ✓ cross-origin isolated ✓");

    this.snapshotIndex = await fetchSnapshotIndex();
    try {
      this.index = await fetchProfileIndex();
      if (!this.index) throw new Error("profile index missing or invalid (/profiles/index.json)");
      const manifestResponse = await fetch("/runtime/runtime-manifest.json", { cache: "no-cache" });
      if (!manifestResponse.ok) throw new Error(`runtime manifest: HTTP ${manifestResponse.status}`);
      this.runtime = (await manifestResponse.json()) as RuntimeManifest;
      this.el.statusVersion.textContent = `Lean ${this.runtime.leanVersion} · ${this.runtime.buildId}`;
      this.setupLog(`Runtime ${this.runtime.buildId} (Lean ${this.runtime.leanVersion}), 154 MB verified on load.`);
    } catch (error) {
      this.setPhase("failed", "Artifacts missing");
      this.setupLog(`Could not load runtime/profile metadata: ${(error as Error).message}`);
      this.setupLog("Run `npm run sync:artifacts` to populate public/ from a verified source.");
      return;
    }

    const wantEssential = localStorage.getItem(PROFILE_PREF_KEY) === "essential";
    await this.installAndBoot(wantEssential ? ["core", "essential"] : ["core"]);
  }

  private installing = false;

  private async installAndBoot(profileIds: string[]): Promise<void> {
    if (this.installing) return; // a newer request must wait for the current one
    this.installing = true;
    const generation = (this.generation += 1);
    try {
      this.setPhase("installing", "Installing profiles…");
      // Memory-backed profiles are consumed by a boot (their buffers are
      // transferred to the worker); a reboot must reinstall them.
      for (const [id, profile] of [...this.installed]) {
        const consumed = profile.segments.some((s) => s.bytes && s.bytes.buffer.byteLength === 0);
        if (consumed) {
          this.installed.delete(id);
          for (const name of profile.moduleNames) {
            this.moduleSet.delete(name);
            delete this.moduleGraph[name];
          }
        }
      }
      for (const id of profileIds) {
        if (this.installed.has(id)) continue;
        const entry = this.index!.profiles.find((p) => p.id === id);
        if (!entry) {
          this.setupLog(`Profile '${id}' is not published in this deployment; skipping.`);
          continue;
        }
        const label = id === "core" ? "Lean core library" : "Mathlib (essential)";
        const installedProfile = await installProfile(entry, (p) => {
          if (generation !== this.generation) return;
          const verb = p.phase === "cached" ? "Cached" : p.phase === "download" ? "Downloading" : p.phase === "inflate" ? "Unpacking" : "Committing";
          this.showProgress(`${verb} ${label} — ${fmtBytes(p.loaded)} / ${fmtBytes(p.total)}`, p.loaded, p.total);
        });
        this.installed.set(id, installedProfile);
        for (const name of installedProfile.moduleNames) this.moduleSet.add(name);
        Object.assign(this.moduleGraph, installedProfile.modules);
        this.setupLog(
          `${label}: ${installedProfile.moduleNames.length} modules, ${fmtBytes(installedProfile.totalBytes)} ` +
            (installedProfile.fromCache
              ? "(from OPFS cache)"
              : installedProfile.persistent
                ? "(installed to OPFS)"
                : "(in memory for this session — OPFS quota was exceeded, so it re-downloads next visit)"),
        );
      }
      const estimate = await storageEstimate();
      if (estimate) {
        this.setupLog(`Origin storage: ${fmtBytes(estimate.usage)} used of ${fmtBytes(estimate.quota)} quota.`);
      }
      if (generation !== this.generation) return;
      await this.bootSession(generation);
    } catch (error) {
      if (generation !== this.generation) return;
      this.hideProgress();
      this.setPhase("failed", "Install failed");
      this.setupLog(`Install failed: ${(error as Error).message}`);
      // A failed install (usually a network drop mid-download) must be
      // retryable in place — verified parts are already cached, so a retry
      // resumes cheaply instead of forcing a full page reload.
      const panel = this.el.panels.messages;
      panel.innerHTML = "";
      const note = document.createElement("div");
      note.className = "empty-hint";
      note.textContent = `Install failed: ${(error as Error).message}. Already-downloaded parts are cached — retrying continues from there.`;
      panel.append(note);
      const retry = document.createElement("button");
      retry.className = "control primary inline-action";
      retry.textContent = "Retry install";
      retry.addEventListener("click", () => {
        this.setPhase("installing", "Retrying install…");
        void this.installAndBoot(profileIds);
      });
      panel.append(retry);
    } finally {
      this.installing = false;
    }
  }

  private async bootSession(generation: number): Promise<void> {
    this.session?.dispose();
    this.paidImportSets.clear();
    this.umbrellaClosure = null;
    this.umbrellaFirstCheckDone = false;
    this.setPhase("booting");
    const session = new LeanSession();
    this.session = session;
    session.onProgress = (p) => {
      if (generation !== this.generation) return;
      if (this.prep) {
        if (p.phase === "snapshot" || p.phase === "snapshot-cache") {
          this.prep.unit = "bytes";
          if (p.phase === "snapshot-cache" && !this.prep.stage.startsWith("Step 1 of 3 — reading")) {
            this.prep.stage = "Step 1 of 3 — reading the cached environment from browser storage (no download)";
          }
          this.prep.loaded = p.loaded;
          this.prep.total = p.total ?? this.prep.total;
          this.prep.indeterminate = false;
        } else if (p.phase === "snapshot-load") {
          this.prep.stage = "Step 2 of 3 — loading the environment into Lean (typically 1–2 minutes)";
          this.prep.indeterminate = true;
          this.prep.loaded = undefined;
        } else if (p.phase === "snapshot-init") {
          this.prep.stage =
            `Step 2 of 3 — initializing Mathlib's tactic frameworks (${p.label})`;
          this.prep.indeterminate = false;
          this.prep.loaded = p.loaded;
          this.prep.total = p.total;
          this.prep.unit = "modules";
        }
        this.updateCheckingLabel();
        return;
      }
      this.showProgress(p.label ?? p.phase, p.loaded, p.total ?? undefined);
    };
    session.onLog = (stream, text) => console.debug(`[lean:${stream}] ${text}`);
    session.onStateChange = (state) => {
      if (generation !== this.generation) return;
      if (state === "dead" && this.phase !== "failed") {
        this.setPhase("failed", "Runtime stopped");
        this.setupLog("The Lean worker stopped. Reload the page to restart it.");
      }
    };

    // One mount directory per profile: WORKERFS mounts shadow anything the
    // byte-pack path wrote beneath the same directory, so profiles must never
    // share a mount point. Lean searches all of them via a multi-entry
    // LEAN_PATH.
    const packs: LibraryPack[] = [...this.installed.values()].flatMap((p) =>
      p.segments.map((segment, i) => ({
        id: `${p.id}#${i}`,
        ...(segment.blob ? { blob: segment.blob } : {}),
        ...(segment.bytes ? { bytes: segment.bytes } : {}),
        metadata: segment.metadata,
        mountPoint: `/lib/packs/${p.id}`,
      })),
    );
    const searchPath = [...this.installed.keys()].map((id) => `/lib/packs/${id}`).join(":");

    try {
      const ready = await session.boot({
        runtime: this.runtime!,
        memory: { initialBytes: 256 * 1048576, maximumCandidates: memoryCandidates() },
        leanPath: searchPath || "/lib/lean/library",
        packs,
      });
      if (generation !== this.generation) return;
      this.ready = ready;
      this.hideProgress();
      this.setPhase("ready");
      this.updateMemoryStatus(ready.memory?.currentBytes, ready.memory?.maximumBytes);
      this.setupLog(`Lean is ready (${ready.mode}; heap max ${fmtBytes(ready.memory?.maximumBytes ?? 0)}).`);
      // A baked environment snapshot (produced by the exact same runtime under
      // Node) replaces the first no-import compile's Init import with a
      // seconds-long region load. Optional: absent snapshots are skipped.
      const bootSnap = matchSnapshot(this.snapshotIndex, []);
      if (bootSnap && generation === this.generation) {
        try {
          this.showProgress(`Loading the ${bootSnap.name} snapshot…`);
          const snap = await session.loadSnapshot(
            bootSnap.url,
            `${bootSnap.name}.snap`,
            bootSnap.bytes,
            snapshotCacheKey(bootSnap),
          );
          if (generation !== this.generation) return;
          this.hideProgress();
          if (snap.success) this.paidImportSets.add("");
          this.setupLog(
            snap.success
              ? `${bootSnap.name} snapshot loaded in ${fmtMs(snap.elapsedMs)} — first check is instant.`
              : `${bootSnap.name} snapshot did not load (mismatched build?); the first check will import normally.`,
          );
        } catch (error) {
          if (generation !== this.generation) return;
          this.hideProgress();
          this.setupLog(
            `${bootSnap.name} snapshot failed (${(error as Error).message}); the first check will import normally.`,
          );
        }
      }
      this.el.installMathlib.classList.toggle("hidden", this.installed.has("essential"));
      // ?lsp keeps the session pristine for language-server experiments:
      // LSP-mode sessions must be the runtime's first client (no prior
      // main-thread compiles), so the boot auto-check is suppressed.
      if (this.el.auto.checked && !new URLSearchParams(location.search).has("lsp")) {
        void this.check("auto");
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.hideProgress();
      this.setPhase("failed", "Boot failed");
      this.setupLog(`Boot failed: ${(error as Error).message}`);
    }
  }

  private async installEssential(): Promise<void> {
    localStorage.setItem(PROFILE_PREF_KEY, "essential");
    this.el.installMathlib.disabled = true;
    this.setupLog("Installing Mathlib (essential): ~993 MB download, ~3.5 GB on disk.");
    await this.installAndBoot(["core", "essential"]);
    this.el.installMathlib.disabled = false;
  }

  // -- Checking -------------------------------------------------------------

  private scheduleAutoCheck() {
    if (!this.el.auto.checked) return;
    if (this.autoTimer !== undefined) clearTimeout(this.autoTimer);
    this.autoTimer = window.setTimeout(() => void this.check("auto"), AUTOCHECK_DEBOUNCE_MS);
  }

  async check(origin: "manual" | "auto"): Promise<void> {
    if (!this.session || this.phase === "failed" || this.phase === "unsupported") return;
    if (this.phase === "checking") {
      if (this.compileQueued !== "manual") this.compileQueued = origin;
      this.updateCheckingLabel();
      return;
    }
    if (this.phase !== "ready") return;

    const source = this.editor.getSource();
    const orderedImports = parseImports(source);
    const missingProfile = [...new Set(this.missingImports(source))];
    // Aggregators and tutorial preludes (import Mathlib, Mathlib.Tactic,
    // MIL.Common, …) are absent from the curated profile but served by the
    // umbrella environment. They are excused from the missing-import warning
    // ONLY under the full umbrella condition — the same one the compile path
    // uses below — so the warning can never be suppressed for a header that
    // then compiles as written and hard-fails on the alias.
    const umbrellaEligible =
      !this.el.strictHeaders.checked &&
      this.installed.has("essential") &&
      shouldUseUmbrella(orderedImports, this.getUmbrellaClosure()) &&
      matchSnapshot(this.snapshotIndex, [UMBRELLA_MODULE]) !== null;
    const aliasMisses = umbrellaEligible
      ? missingProfile.filter((m) => UMBRELLA_ALIAS_MODULES.has(m))
      : [];
    const genuineMisses = missingProfile.filter((m) => !aliasMisses.includes(m));
    if (genuineMisses.length > 0) {
      // Aliases landing here mean the umbrella cannot stand in for them this
      // check (strict headers, an unknown module alongside, or no snapshot) —
      // explain which lever applies instead of lumping them in as maybe-typos.
      const aliasHints = this.installed.has("essential")
        ? genuineMisses.filter((m) => UMBRELLA_ALIAS_MODULES.has(m))
        : [];
      const trueMisses = genuineMisses.filter((m) => !aliasHints.includes(m));
      const aliasHintText =
        aliasHints.length === 0
          ? ""
          : this.el.strictHeaders.checked
            ? `${aliasHints.join(", ")}: served by the full Mathlib environment — turn off "Strict headers" in Setup to use it.`
            : trueMisses.length > 0
              ? `${aliasHints.join(", ")}: normally served by the full Mathlib environment, but not alongside unknown imports.`
              : `${aliasHints.join(", ")}: normally served by the full Mathlib environment, but its snapshot is unavailable this session.`;
      this.renderMessages([
        {
          fileName: "input.lean",
          line: 1,
          column: 0,
          severity: "warning",
          message:
            (trueMisses.length > 0
              ? `These imports are not in the installed profile: ${trueMisses.join(", ")}.\n` +
                (this.installed.has("essential")
                  ? "They may not exist in the Mathlib-essential closure."
                  : "Install Mathlib (essential) to use them — one click below, ~1 GB once.")
              : "") +
            (trueMisses.length > 0 && aliasHintText ? "\n" : "") +
            aliasHintText,
        },
      ]);
      if (!this.installed.has("essential") && this.index?.profiles.some((p) => p.id === "essential")) {
        const action = document.createElement("button");
        action.className = "control primary inline-action";
        action.textContent = "Install Mathlib · ~993 MB, once";
        action.addEventListener("click", () => void this.installEssential());
        this.el.panels.messages.append(action);
      }
      if (origin === "auto") return; // do not burn a compile that must fail
    }

    this.setPhase("checking");
    this.checkStartedAt = performance.now();
    if (this.checkTicker !== undefined) clearInterval(this.checkTicker);
    this.checkTicker = window.setInterval(() => this.updateCheckingLabel(), 1000);

    // First compile for a given ordered import set pays that set's whole
    // module-closure import into the resident environment — minutes for
    // Mathlib roots. Mathlib-using headers instead compile against the
    // umbrella environment (`import QED64.Essential`: ONE baked snapshot
    // covering every Mathlib import combination) via a position-preserving
    // header rewrite; missing modules were already surfaced above, so the
    // umbrella cannot mask a nonexistent import.
    let umbrella = umbrellaEligible;
    let compileImports = umbrella ? [UMBRELLA_MODULE] : orderedImports;
    let importKey = compileImports.join("\u0000");
    if (!this.paidImportSets.has(importKey) && compileImports.length > 0) {
      // A baked snapshot for this exact import sequence turns the first
      // compile's minutes-long closure import into a seconds-long region load.
      const snapshot = matchSnapshot(this.snapshotIndex, compileImports);
      if (snapshot && this.session) {
        const what = umbrella ? "Mathlib" : `the ${snapshot.name} environment`;
        this.prep = {
          title: `Preparing ${what}`,
          stage: `Step 1 of 3 — downloading and unpacking the environment (${fmtBytes(snapshot.transfer ?? snapshot.bytes)} download, cached for next time)`,
          detail:
            "This happens once per session. Afterwards every Mathlib check — any imports — takes milliseconds. " +
            "You can keep editing; the latest version of the buffer is checked automatically when this finishes.",
          startedAt: performance.now(),
          loaded: 0,
          total: snapshot.bytes,
          indeterminate: false,
        };
        this.updateCheckingLabel();
        try {
          const snap = await this.session.loadSnapshot(
            snapshot.url,
            `${snapshot.name}.snap`,
            snapshot.bytes,
            snapshotCacheKey(snapshot),
          );
          if (snap.success) {
            this.paidImportSets.add(importKey);
            this.setupLog(`${snapshot.name} snapshot loaded in ${fmtMs(snap.elapsedMs)}.`);
          } else {
            this.setupLog(`${snapshot.name} snapshot did not load; importing normally.`);
          }
        } catch (error) {
          this.setupLog(`${snapshot.name} snapshot failed (${(error as Error).message}); importing normally.`);
        }
        this.prep = null;
        this.hideProgress();
      }
      if (!this.paidImportSets.has(importKey)) {
        // No resident umbrella environment and no loadable snapshot: compile
        // the header as written — importing the umbrella's 4000+-module
        // closure from oleans would be strictly slower than the user's set.
        if (umbrella) {
          umbrella = false;
          compileImports = orderedImports;
          importKey = compileImports.join("\u0000");
        }
        if (!this.paidImportSets.has(importKey)) {
          const { closure } = importClosure(compileImports, this.moduleGraph);
          if (closure.length > 400) {
            this.prep = {
              title: "Importing modules",
              stage: `Loading ≈${closure.length.toLocaleString()} modules into the resident environment (typically 3–6 minutes, once per session)`,
              detail:
                "No pre-baked environment covers this header exactly, so Lean is importing its closure from the library packs. " +
                "Edits made meanwhile are re-checked automatically afterwards.",
              startedAt: performance.now(),
              indeterminate: true,
            };
            this.updateCheckingLabel();
          }
        }
      }
    }
    // Built from the FINAL umbrella state (a failed snapshot load demotes it
    // above), and merged with the compile's diagnostics so the explanation
    // survives the result overwriting the panel — a note must never claim the
    // Mathlib environment stands in when the compile ran the raw header.
    const aliasNotes: Diagnostic[] = umbrella
      ? aliasMisses.map((m) => ({
          fileName: "input.lean",
          line: importLineOf(source, m),
          column: 0,
          severity: "information" as const,
          message:
            `${m} — ${UMBRELLA_ALIAS_MODULES.get(m)} — is not a module in this playground; ` +
            `the Mathlib-essential environment (4,192 curated modules) stands in for it.`,
        }))
      : [];
    const compileSource = umbrella ? rewriteHeaderToUmbrella(source) : source;
    if (umbrella && !this.umbrellaFirstCheckDone) {
      // The first compile against a freshly loaded umbrella warms tactic and
      // instance caches; say so instead of letting 20–40 s look like a hang.
      this.prep = {
        title: "Checking",
        stage: "Step 3 of 3 — first check against the Mathlib environment (typically 20–40 s; later checks take milliseconds)",
        detail: "Elaborating and kernel-checking your buffer.",
        startedAt: performance.now(),
        indeterminate: true,
      };
      this.updateCheckingLabel();
    }

    const started = performance.now();
    try {
      const result = await this.session.compile(compileSource, "/workspace/input.lean");
      this.workerBusyRetried = false;
      if (umbrella) this.umbrellaFirstCheckDone = true;
      this.paidImportSets.add(importKey);
      // The runtime cannot report parse errors (known defect); the coverage
      // lint flags column-0 text the parser will have skipped silently.
      const lints = parseCoverageLints(source);
      const merged = [...result.diagnostics, ...lints, ...aliasNotes];
      this.lastDiagnostics = merged;
      this.editor.setLeanDiagnostics(merged);
      this.renderMessages(merged, result);
      this.renderGoals();
      this.updateMemoryStatus(result.memory?.currentBytes, result.memory?.maximumBytes);
      this.el.statusTiming.textContent = `checked in ${fmtMs(result.elapsedMs)}`;
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const workerBusy =
        (error as { code?: string }).code === "BAD_STATE" ||
        /Worker is '\w+', not ready/.test(message);
      if (!workerBusy) this.workerBusyRetried = false;
      if (workerBusy && !this.workerBusyRetried) {
        // Observed live (2026-08-25): a manual check right after boot raced
        // the boot snapshot load — phase read "ready" while the worker still
        // owned the runtime, and the rejection rendered as "Compile failed".
        // A collision is transient by definition: re-run this check when the
        // session frees instead of alarming the user.
        this.workerBusyRetried = true;
        if (this.compileQueued !== "manual") this.compileQueued = origin;
      } else if (isStaleStorageError(message) && !this.storageRecoveryAttempted) {
        // The storage behind a mounted pack died mid-session (observed: an
        // OPFS quota event can empty the pack directory while WORKERFS still
        // holds File objects over it — every read then throws NotFoundError).
        // Reinstall revalidates or re-downloads; reboot replaces the session
        // whose import machinery just took an exception mid-flight.
        this.pendingStorageRecovery = origin;
        this.renderMessages([
          {
            fileName: "input.lean",
            line: 1,
            column: 0,
            severity: "warning",
            message:
              "The browser invalidated the on-disk library storage mid-session. " +
              "Reinstalling the libraries and rebooting Lean — this check re-runs automatically.",
          },
        ]);
      } else {
        // A wasm trap ("memory access out of bounds", RuntimeError) poisons
        // the instance the same way an IO-errored runtime does — observed
        // when a stale HTTP-cached snapshot loads against a rebuilt binary —
        // so it earns the same probe-then-reboot recovery.
        const runtimePoisoned = /returned an IO error|memory access out of bounds|RuntimeError/.test(message);
        if (runtimePoisoned && !this.runtimeRecoveryAttempted) {
          this.pendingRuntimeProbe = origin;
        }
        this.renderMessages([
          {
            fileName: "input.lean",
            line: 1,
            column: 0,
            severity: "error",
            message:
              `Compile failed: ${message}` +
              (isStaleStorageError(message)
                ? "\nLibrary storage failed again after a reinstall — reload the page to start clean (cached data re-downloads)."
                : "") +
              (this.pendingRuntimeProbe
                ? "\nVerifying the runtime is still healthy…"
                : runtimePoisoned
                  ? "\nThe runtime failed again after a restart — reload the page to start clean."
                  : ""),
          },
        ]);
      }
    } finally {
      this.prep = null;
      if (this.checkTicker !== undefined) {
        clearInterval(this.checkTicker);
        this.checkTicker = undefined;
      }
      this.hideProgress();
      if ((this.phase as AppPhase) === "checking") this.setPhase("ready");
      this.el.statusTiming.textContent ||= `checked in ${fmtMs(performance.now() - started)}`;
      if (this.pendingStorageRecovery) {
        const recoveryOrigin = this.pendingStorageRecovery;
        this.pendingStorageRecovery = null;
        this.compileQueued = false; // recovery reboots; the recheck below covers it
        void this.recoverStaleStorage(recoveryOrigin);
      } else if (this.pendingRuntimeProbe) {
        const probeOrigin = this.pendingRuntimeProbe;
        this.pendingRuntimeProbe = null;
        const queued = this.compileQueued;
        this.compileQueued = false;
        void this.probeRuntimeAndMaybeReboot(probeOrigin, queued);
      } else if (this.compileQueued) {
        const queuedOrigin = this.compileQueued;
        this.compileQueued = false;
        void this.check(queuedOrigin);
      } else {
        this.maybePrefetchSnapshot();
      }
    }
  }

  /** Fill the OPFS snapshot cache in the background once the session is idle,
   * so the first Mathlib check of this session (or the next) skips the
   * download entirely. Download-only — the Lean worker stays free; exclusive
   * sync-access-handle locks arbitrate against the Lean worker's own cache
   * writer if both race for the same entry. */
  private maybePrefetchSnapshot(): void {
    if (this.snapshotPrefetchStarted) return;
    if (!this.installed.has("essential")) return;
    const entry = matchSnapshot(this.snapshotIndex, [UMBRELLA_MODULE]);
    if (!entry) return;
    if (this.paidImportSets.has(UMBRELLA_MODULE)) return; // already resident
    this.snapshotPrefetchStarted = true;
    const worker = new Worker("/workers/snapshot-prefetch.worker.js");
    const wire = entry.transfer ?? entry.bytes;
    worker.onmessage = (e) => {
      const msg = e.data as { status: string; bytes?: number; error?: string };
      if (msg.status === "progress") return;
      if (msg.status === "done") {
        this.setupLog(
          `Mathlib environment prefetched in the background (${fmtBytes(msg.bytes ?? wire)} cached) — ` +
            "the first Mathlib check will skip the download.",
        );
      } else if (msg.status === "error" || msg.status === "unavailable") {
        this.setupLog(
          `Background prefetch of the Mathlib environment did not complete (${msg.error ?? "unknown"}); ` +
            "the first Mathlib check will download it instead.",
        );
      }
      worker.terminate();
    };
    this.setupLog(
      `Prefetching the Mathlib environment in the background (${fmtBytes(wire)}) ` +
        "so your first Mathlib check skips the download…",
    );
    worker.postMessage({ url: entry.url, cacheKey: snapshotCacheKey(entry) });
  }

  /** A compile that ends in an IO error can leave the resident runtime in a
   * bad state (observed: a long-idle session returned IO errors for every
   * subsequent check, including buffers that were green minutes before).
   * Probe with a trivial compile; a healthy runtime keeps the session, a
   * broken one gets one automatic reboot with the same recovery machinery
   * the storage path uses. */
  private async probeRuntimeAndMaybeReboot(
    origin: "manual" | "auto",
    queued: false | "manual" | "auto",
  ): Promise<void> {
    if (!this.session) return;
    let healthy = false;
    try {
      const probe = await this.session.compile("example : True := trivial\n", "/workspace/__probe.lean");
      healthy = probe.success;
    } catch {
      healthy = false;
    }
    if (healthy) {
      this.setupLog("Runtime probe passed — the IO error above is specific to that buffer, not the session.");
      if (queued) void this.check(queued);
      return;
    }
    this.runtimeRecoveryAttempted = true;
    this.setupLog(
      "The Lean runtime is in a bad state after an internal error; restarting it — " +
        "libraries revalidate from cache and this check re-runs automatically.",
    );
    const ids = [...this.installed.keys()];
    this.installed.clear();
    this.moduleSet.clear();
    for (const name of Object.keys(this.moduleGraph)) delete this.moduleGraph[name];
    await this.installAndBoot(ids.length > 0 ? ids : ["core"]);
    if ((this.phase as AppPhase) === "ready" && !this.el.auto.checked) void this.check(origin);
  }

  /** One automatic reinstall + reboot when a compile fails because the
   * storage behind a mounted pack went stale. Cached packs revalidate with
   * fresh File handles (fast); vanished packs re-download. */
  private async recoverStaleStorage(origin: "manual" | "auto"): Promise<void> {
    this.storageRecoveryAttempted = true;
    this.setupLog(
      "Library storage went stale mid-session (the browser invalidated the on-disk packs); " +
        "reinstalling and rebooting Lean…",
    );
    const ids = [...this.installed.keys()];
    this.installed.clear();
    this.moduleSet.clear();
    for (const name of Object.keys(this.moduleGraph)) delete this.moduleGraph[name];
    await this.installAndBoot(ids.length > 0 ? ids : ["core"]);
    // With auto-check on, bootSession already re-checks; cover the manual case.
    if ((this.phase as AppPhase) === "ready" && !this.el.auto.checked) void this.check(origin);
  }

  // The umbrella's import closure (every module its environment contains),
  // computed lazily from the installed module graph and reset on reboot.
  private umbrellaClosure: Set<string> | null = null;

  private getUmbrellaClosure(): Set<string> {
    if (this.umbrellaClosure === null) {
      const roots = Object.keys(this.moduleGraph).filter((m) => m.startsWith("Mathlib"));
      const { closure } = importClosure(roots, this.moduleGraph);
      this.umbrellaClosure = new Set(closure);
    }
    return this.umbrellaClosure;
  }

  private missingImports(source: string): string[] {
    if (this.moduleSet.size === 0) return [];
    return parseImports(source).filter((name) => !this.moduleSet.has(name));
  }

  // -- Panels ---------------------------------------------------------------

  private renderMessages(diagnostics: Diagnostic[], result?: CompileResult) {
    const panel = this.el.panels.messages;
    panel.innerHTML = "";
    if (result) {
      this.checkSeq += 1;
      const summary = document.createElement("div");
      summary.className = `verdict ${result.success ? "ok" : "err"} flash`;
      const at = new Date().toLocaleTimeString();
      const skipped = diagnostics.filter((d) => d.severity === "warning" && d.message.includes("parser skips")).length;
      summary.innerHTML = result.success
        ? `<b>✓ No errors.</b> Kernel-checked in ${fmtMs(result.elapsedMs)} <span class="check-seq">· check #${this.checkSeq} at ${at}</span>` +
          (skipped > 0
            ? `<span class="verdict-caveat">⚠ ${skipped} line(s) were skipped by the parser — see the warnings below.</span>`
            : "")
        : `<b>✗ ${diagnostics.filter((d) => d.severity === "error").length} error(s).</b> ` +
          `<span class="check-seq">check #${this.checkSeq} at ${at}</span>`;
      panel.append(summary);
    }
    if (diagnostics.length === 0 && result) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "No messages. Try #check, #eval, or an incomplete proof to see output here.";
      panel.append(hint);
      return;
    }
    for (const d of diagnostics) {
      // Every field is attacker-influenced: a crafted #eval can print JSON
      // that parses as a diagnostic, so severity is whitelisted and positions
      // are numerically coerced before any of it approaches the DOM.
      const severity = d.severity === "error" || d.severity === "warning" ? d.severity : "information";
      const line = Number.isFinite(d.line) ? Math.max(1, Math.trunc(d.line)) : 1;
      const column = Number.isFinite(d.column) ? Math.max(0, Math.trunc(d.column)) : 0;
      const item = document.createElement("button");
      item.className = `diag ${severity}`;
      item.innerHTML =
        `<span class="loc">${line}:${column}</span>` +
        `<span class="sev">${esc(severity)}</span>` +
        `<pre class="msg">${esc(d.message)}</pre>`;
      item.addEventListener("click", () => this.jumpTo(line));
      panel.append(item);
    }
  }

  private jumpTo(line: number) {
    const doc = this.editor.view.state.doc;
    const pos = doc.line(Math.min(line, doc.lines)).from;
    this.editor.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    this.editor.view.focus();
  }

  private renderGoals() {
    const panel = this.el.panels.goals;
    const goalDiags = this.lastDiagnostics.filter(
      (d) => /unsolved goals|⊢/.test(d.message),
    );
    panel.innerHTML = "";
    if (goalDiags.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "No open goals. Make a proof incomplete (try `sorry` or delete a tactic) to inspect its goal state.";
      panel.append(hint);
      return;
    }
    let nearest: Diagnostic | null = null;
    for (const d of goalDiags) {
      if (d.line <= this.cursorLine && (!nearest || d.line > nearest.line)) nearest = d;
    }
    for (const d of goalDiags) {
      const block = document.createElement("div");
      block.className = `goal-block${d === nearest ? " nearest" : ""}`;
      const goalText = d.message.replace(/^.*unsolved goals\s*\n?/, "");
      const line = Number.isFinite(d.line) ? Math.max(1, Math.trunc(d.line)) : 1;
      block.innerHTML =
        `<div class="goal-head">line ${line}</div>` +
        `<pre class="goal-body">${esc(goalText)}</pre>`;
      panel.append(block);
    }
  }

  private updateMemoryStatus(current?: number, maximum?: number) {
    if (current === undefined) return;
    this.el.statusMemory.textContent = `heap ${fmtBytes(current)}${maximum ? ` / ${fmtBytes(maximum)}` : ""}`;
  }
}
