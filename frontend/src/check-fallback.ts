// The boot card's check fallback (main.ts; HARDENING #54): once the relay
// SERVES (environment loaded, document open, loop armed), what is left is Lean
// checking the document, which a restored buffer can make minutes long or
// endless — the editor must not stay hidden behind the card while it does. So
// the first serving status of a session that is still checking arms a timer
// that finishes the boot after `ms`.
//
// The whole decision is `observe(status)`, fed every status the page renders:
//   * a final verdict (ready, headerRefused) cancels it — the boot finishes by
//     the verdict;
//   * a DELIBERATE replacement (the relay rebooting for reason "user": the
//     page's self-widen, api.restart, "Load exact imports") cancels it — the
//     replacement still downloads and loads its environment, and its own first
//     serving status arms the timer again;
//   * a crash reboot (crash, heartbeat, wedged, bootFailed) and a halt leave it
//     armed — a restored buffer that kills the checker shortly after every
//     serve must still surface the editor 30 s after the first serve (the user
//     edits the offending line; the relay's halted note says so), never stay
//     behind the card or turn into a "could not start" card a reload repeats;
//   * a serving status arms it when none is armed.
//
// Pure (injected timers): unit-tested under node.

export interface CheckFallback {
  /** Feed every relay status the page renders (see the rules above). */
  observe(s: { relay: string; phase: string; rebootReason?: string | null }): void;
  /** The boot finished some other way. */
  cancel(): void;
}

export function createCheckFallback(
  fire: () => void,
  ms: number,
  timers: { setTimeout(f: () => void, ms: number): unknown; clearTimeout(t: unknown): void } = {
    setTimeout: (f, t) => setTimeout(f, t),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): CheckFallback {
  let timer: unknown;
  const cancel = () => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };
  return {
    observe(s) {
      if (s.phase === "ready" || s.phase === "headerRefused") return cancel();
      if (s.relay === "rebooting" && s.rebootReason === "user") return cancel();
      if (s.relay !== "serving" || timer !== undefined) return;
      timer = timers.setTimeout(() => { timer = undefined; fire(); }, ms);
    },
    cancel,
  };
}
