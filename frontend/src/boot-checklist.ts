// The boot card's checklist (main.ts; HARDENING #54): which step is active
// while the first boot runs. Pure: main.ts renders `stage` into the <li>s and
// owns the bar, label and speed window; unit-tested under node.
//
//   * A progress report moves the active step forward, never back, with one
//     exception: snapshots load one after another (init, then mathlib), so the
//     next one's download follows the previous one's load and must show as the
//     active step, not as done.
//   * A deliberate replacement while the card is up (the relay rebooting for
//     reason "user": the self-widen, api.restart, "Load exact imports", a
//     re-arm) downloads and loads its own environment, and the check fallback
//     keeps the card up for it (check-fallback.ts). So its first status
//     rewinds the checklist to the runtime step, once per replacement session:
//     the relay emits that status synchronously, before the new session
//     reports any progress (lsp-relay.ts reboot), so later statuses of the same
//     session never undo the progress the replacement has made since.
//   * Crash reboots do not rewind: the check fallback stays armed through
//     them, and the card is gone 30 s after the first serve.

export const STAGES = ["manifests", "core", "runtime", "env", "load", "check"] as const;
export type Stage = (typeof STAGES)[number];

/** The checklist step a progress report belongs to, or null (a report that moves nothing). */
export function stageOf(label: string, info?: { phase?: string }): Stage | null {
  const phase = info?.phase ?? "";
  if (/^fetching manifests/.test(label)) return "manifests";
  if (phase.startsWith("core-") || /core library/.test(label)) return "core";
  if (/^(runtime|filesystem|initialize|memory|import)$/.test(phase) || /^(Starting|Mounting|Initializing)/.test(label)) return "runtime";
  if (phase === "snapshot" || phase === "snapshot-cache" || /environment \(|environment snapshot/i.test(label)) return "env";
  if (phase === "snapshot-load" || phase === "snapshot-init" || /into Lean/.test(label)) return "load";
  if (/elaborating|checking/.test(label)) return "check";
  return null;
}

export interface BootChecklist {
  /** The active step's index into STAGES; STAGES.length once finished (every step done). */
  readonly stage: number;
  /** A progress report. `moved`: re-render the steps. `fresh`: a new step began (a new download: reset the speed window). */
  progress(label: string, info?: { phase?: string }): { moved: boolean; fresh: boolean };
  /** A relay status (see the rules above). True when the steps changed (re-render). */
  observe(s: { relay: string; rebootReason?: string | null; session: string }): boolean;
  /** The boot finished: every step done. */
  finish(): void;
}

export function createBootChecklist(): BootChecklist {
  let stage = 0;
  let rewoundFor: string | null = null;
  const runtime = STAGES.indexOf("runtime");
  return {
    get stage() { return stage; },
    progress(label, info) {
      const s = stageOf(label, info);
      if (!s || stage >= STAGES.length) return { moved: false, fresh: false };
      const i = STAGES.indexOf(s);
      const next = s === "env" && STAGES[stage] === "load";
      const fresh = i > stage || next;
      const moved = i >= stage || next;
      if (moved) stage = i;
      return { moved, fresh };
    },
    observe(s) {
      if (stage >= STAGES.length || s.relay !== "rebooting" || s.rebootReason !== "user" || s.session === rewoundFor) return false;
      rewoundFor = s.session;
      if (stage <= runtime) return false;
      stage = runtime;
      return true;
    },
    finish() { stage = STAGES.length; },
  };
}
