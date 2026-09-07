// The resident session adapter (docs/ARCHITECTURE-REEVALUATION-2-2026-09-02.md
// §2.2 L4; §7 day 5): one `LeanSession` behind the relay's `RelaySession`
// contract. A Worker exists from construction — the relay always has a
// target and a booting worker queues every frame (§6 amendment 20) — and
// `start()` runs the boot on the page's artifacts and leaves the worker's
// loop CLOSED: the relay arms it (`arm()`) only after its BootOk replay
// (§2.3), so the machine's `booted` fact can never precede the snapshot loads
// below (§2.4 Booting → Ready is the page's fact, not the wasm boot's).
//
// The boot inputs a host decides are behind `ResidentPolicy` (§6 amendment
// 15: an Init-only document boots light — the init snapshot and a 256 MiB
// initial commit — and a Mathlib one boots the umbrella at 2 GiB; a game
// environment passes its own snapshot map and a tighter memory cap). The
// header text the policy reads is the document this session will serve:
// the initial text at first boot, the relay's last full text on a reboot.
import { ensureProfile, loadSnapshotByName, type Qed64Artifacts, type Qed64Session, type StatusSink } from "./qed64-boot";
import type { RelaySession, RestartOptions } from "./lsp-relay";
import { LeanSession, memoryCandidates, type JsonRpcMessage, type LibraryPack, type WorkerStatus } from "../../src/runtime/client";
import { installProfile } from "../../src/install/profiles";

const MiB = 1048576;
const GiB = 1073741824;

/** Per-host boot policy: every hook is optional, so a consumer that only
 * wants the editor's defaults passes `{}`. `headerText` is the document text
 * (the leading import lines are what a policy reads). */
export interface ResidentPolicy {
  /** Boot-only snapshot names, loaded in order before the loop opens. */
  snapshotsFor?(headerText: string): string[];
  /** Initial commit of the shared Memory64 (bytes). `snapshots` is the list
   * this session WILL load — explicit restart options win over
   * `snapshotsFor` — so a policy sizes the commit for what is streamed, not
   * for what the header alone suggests (an umbrella boot on an Init-only
   * header, e.g. a remembered "Load exact imports", must not commit small
   * and then grow by gigabytes through the repeated-grow path). */
  initialBytesFor?(headerText: string, snapshots: readonly string[]): number;
  /** Ceiling for the reservation ladder (bytes): the address space a dead-
   * but-not-yet-reclaimed page keeps holding across reloads. */
  maximumBytes?: number;
}

/** What a session needs from its host besides the policy. */
export interface ResidentHost {
  artifacts: Qed64Artifacts;
  ui: StatusSink;
  policy?: ResidentPolicy;
  /** The document this session will serve (see the module note). */
  headerText: string;
}

/** Only the import lines of a header — the warm compile is built the same way
 * (the body must not be elaborated on the main thread; the FileWorker does
 * that once the loop opens). */
const IMPORT_LINE = /^\s*(?:public\s+|private\s+)?(?:meta\s+)?import\s+/;
export const importLinesOf = (text: string): string[] => text.split("\n").filter((l) => IMPORT_LINE.test(l));

/** The module name each import line names (`import Mathlib.Data.Real.Basic`
 * → `Mathlib.Data.Real.Basic`); a line with nothing after `import` yields
 * nothing. Comment-only lines are not import lines. */
export function importedModulesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of importLinesOf(text)) {
    const m = /import\s+([A-Za-z_«][\w.«»']*)/.exec(line);
    if (m && m[1]) out.push(m[1]);
  }
  return out;
}

/** The roots the umbrella snapshot serves (patch 0032 K1: `QED64.Essential`
 * covers every Mathlib/Batteries module in the essential profile, and the
 * four tutorial aliases Mathlib, Mathlib.Tactic, Batteries, MIL.Common). A
 * near-miss root (`Mathlib2`) is NOT one of these: the kernel refuses it and
 * no snapshot would change that. */
export const UMBRELLA_ROOTS: ReadonlySet<string> = new Set(["Mathlib", "Batteries", "MIL", "QED64"]);
export const isUmbrellaModule = (name: string): boolean => UMBRELLA_ROOTS.has(name.split(".")[0] ?? "");

/** True when any import line names a module the umbrella serves. */
export const needsMathlib = (headerText: string): boolean => importedModulesOf(headerText).some(isUmbrellaModule);

/** The editor's default policy (§6 amendment 15): an Init-only document
 * boots light — the init snapshot only — and anything naming Mathlib boots
 * the umbrella too. A header that later grows a Mathlib import on a light
 * session is refused by the kernel (nothing loaded covers it); the page then
 * restarts with the umbrella (main.ts, `widenForMathlib`). */
export const snapshotsForHeader = (headerText: string): string[] => (needsMathlib(headerText) ? ["init", "mathlib"] : ["init"]);

/** The umbrella-sized initial commit (2 GiB) whenever the umbrella snapshot
 * is among the boot loads; 256 MiB otherwise. Growing a shared Memory64 by
 * gigabytes in many steps while streaming the snapshot is where
 * nondeterministic renderer crashes were observed; one large initial commit
 * sidesteps the repeated-grow path. Keyed on the snapshot list, not the
 * header: an explicit umbrella boot over an Init-only header (a remembered
 * exact-imports restart) streams the same ~1.5 GB region. */
export const initialBytesForSnapshots = (snapshots: readonly string[]): number => (snapshots.includes("mathlib") ? 2048 * MiB : 256 * MiB);
/** The header form: what the editor's policy commits for a document it boots by its own snapshot choice. */
export const initialBytesForHeader = (headerText: string): number => initialBytesForSnapshots(snapshotsForHeader(headerText));

/** 6 GiB: 2.5x headroom over the heaviest legitimate editor session measured
 * (2.5 GiB after a full library search). Growth past the cap is a clean
 * worker abort the relay reboots from, which beats the renderer dying first. */
export const DEFAULT_MAXIMUM_BYTES = 6 * GiB;

/** The editor's policy as one object: the page passes it, the unit tests pin
 * it. The commit is sized by what the session WILL load (explicit restart
 * options included), not by the header alone. */
export const EDITOR_POLICY: ResidentPolicy = {
  snapshotsFor: snapshotsForHeader,
  initialBytesFor: (_header, snapshots) => initialBytesForSnapshots(snapshots),
  maximumBytes: DEFAULT_MAXIMUM_BYTES,
};

export class ResidentSession implements RelaySession {
  readonly lean = new LeanSession();
  readonly id: string;
  /** The boot-only snapshot list this session loads (the page reads it to
   * know whether a session booted light). */
  readonly snapshots: string[];
  readonly initialBytes: number;
  readonly maximumBytes: number;
  private readonly artifacts: Qed64Artifacts;
  private readonly ui: StatusSink;

  constructor(host: ResidentHost, private readonly opts: RestartOptions = {}) {
    this.artifacts = host.artifacts;
    this.ui = host.ui;
    const policy = host.policy ?? {};
    this.snapshots = opts.snapshots ?? policy.snapshotsFor?.(host.headerText) ?? ["init", "mathlib"];
    this.initialBytes = policy.initialBytesFor?.(host.headerText, this.snapshots) ?? 2048 * MiB;
    this.maximumBytes = policy.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
    this.id = this.lean.id;
    this.lean.onLog = (stream, text) => console.debug(`[lean:${stream}] ${text}`);
    this.lean.onProgress = (p) => this.ui.progress(p.label ?? p.phase, { phase: p.phase, loaded: p.loaded, total: p.total, unit: p.unit });
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
  /** The synchronous kill (Unload only): the relay's `unload()` calls
   * `dispose()` then `terminate()` inside the pagehide handler's own turn.
   * `LeanSession.dispose()` alone hard-terminates 250 ms later behind a timer
   * a closing document never runs — reload storms stacked dead multi-GiB
   * heaps until the OS jetsammed the renderer (the pump shim's
   * `disposeForUnload`); `LeanSession.terminate()` kills the Worker NOW. */
  terminate(): void { this.lean.terminate(); }

  async start(): Promise<void> {
    const a = this.artifacts;
    const ui = this.ui;
    // "Load exact imports" (§3 row 8; HARDENING #43): the header is imported
    // from oleans below, so the ~1 GB olean pack must be installed BEFORE
    // boot — LEAN_PATH and the mounts are boot inputs, and a running worker
    // cannot retro-mount a pack; nothing has booted yet, so the one user
    // restart is the only restart. A pack missing from the index is not a
    // death: the warm compile then fails its imports and the session serves
    // the header covered, with the offer back.
    if (this.opts.packs?.includes("essential") && !(await ensureProfile(a, "essential", ui))) {
      ui.progress("the Mathlib library pack is unavailable — exact imports may fail");
    }
    // Memory-backed segments were TRANSFERRED to the worker that booted them
    // and are detached page-side; a reboot reinstalls them (an OPFS install
    // revalidates in ms; memory mode re-downloads). Skipping them silently
    // booted a worker with the pack's mount on LEAN_PATH but none of its
    // bytes; one not in the index any more is dropped from LEAN_PATH and said
    // so, never mounted empty.
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
    // The device-derived reservation ladder under the cap; a cap below every
    // rung becomes the sole candidate, so a small cap never yields an empty
    // ladder (which would make boot fail instead of reserving less).
    const under = memoryCandidates().filter((b) => b <= this.maximumBytes);
    ui.busy("starting Lean");
    await this.lean.boot({
      runtime: a.runtime,
      memory: { initialBytes: this.initialBytes, maximumCandidates: under.length ? under : [this.maximumBytes] },
      leanPath: [...a.installed.keys()].map((id) => `/lib/packs/${id}`).join(":"),
      packs,
    });
    const qs: Qed64Session = { session: this.lean, loadedSnapshots: new Set() };
    for (const name of this.snapshots) {
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
    const ui = this.ui;
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
