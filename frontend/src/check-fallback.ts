// The boot card's check fallback (main.ts; HARDENING #54): once the relay
// SERVES (environment loaded, document open, loop armed), what is left is Lean
// checking the document, which a restored buffer can make minutes long or
// endless — the editor must not stay hidden behind the card while it does. So
// the first serving status of a session that is still checking arms a timer
// that finishes the boot after `ms`.
//
// It is page-wide on purpose: a crash reboot or a halt does NOT disarm it. A
// restored buffer that kills the checker shortly after every serve must still
// surface the editor 30 s after the first serve (the user edits the offending
// line; the relay's halted note says so), never stay behind the card or turn
// into a "could not start" card a reload only repeats. The one exception is
// the page's self-widen from a light session to an umbrella or overlay
// environment: that replacement still has to download and load its
// environment, so the widen calls `cancel()` and the replacement's own first
// serving status arms the timer again.
//
// Pure (injected timers): unit-tested under node.

export interface CheckFallback {
  /** Feed every relay status the page renders: a serving one arms the timer if none is armed. */
  observe(s: { relay: string; phase: string }): void;
  /** The boot finished some other way (a final verdict), or the page's self-widen replaced the session. */
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
      if (s.relay !== "serving" || timer !== undefined || s.phase === "ready" || s.phase === "headerRefused") return;
      timer = timers.setTimeout(() => { timer = undefined; fire(); }, ms);
    },
    cancel,
  };
}
