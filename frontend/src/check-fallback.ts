// The boot card's check fallback (main.ts; HARDENING #54): once the relay
// SERVES (environment loaded, document open, loop armed), what is left is Lean
// checking the document, which a restored buffer can make minutes long or
// endless — the editor must not stay hidden behind the card while it does. So
// the first serving status of a session that is still checking arms a timer
// that finishes the boot after `ms`.
//
// The timer belongs to the session that armed it: when the relay leaves
// `serving` (a crash reboot, a user restart, the page's self-widen from a light
// session to an umbrella or overlay environment) it is disarmed, and the
// replacement's own first serving status arms it again. A timer armed by a
// replaced light session would otherwise finish the boot while the widened
// session is still downloading or loading its environment.
//
// Pure (injected timers): unit-tested under node.

export interface CheckFallback {
  /** Feed every relay status the page renders. */
  observe(s: { relay: string; phase: string }): void;
  /** The boot finished some other way (a final verdict, a failure). */
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
      if (s.relay !== "serving") return cancel();
      if (timer !== undefined || s.phase === "ready" || s.phase === "headerRefused") return;
      timer = timers.setTimeout(() => { timer = undefined; fire(); }, ms);
    },
    cancel,
  };
}
