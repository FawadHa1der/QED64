// The EMPTY console.error of a boot that reaches elaborating (HARDENING #63,
// follow-up 2), for the lanes that judge a healthy boot's console
// (snapshot-network-cut.mjs, unpaired-snapshot.mjs --scenario rescued).
//
// monaco-vscode-api's StandaloneNotificationService.notify console.errors the
// message of every Error-severity notification, and an LSP RequestCancelled
// (-32800) reply that Lean itself sends with an EMPTY message (the boot-time
// codeAction the header processing cancels) reaches it, so Chromium records
// console.error(""). Third-party, Lean's own reply, not QED64 output; the
// showcase allowlists that line (tests/ux/selectors.json
// consoleAllowlist.consoleError[0]: text ^$, the main page bundle at a pinned
// line, pairWith -32800 within -3 s / +0.5 s, fail-closed without its LSP
// tap; tests/ux/bringup/console.mjs pairs one-to-one). The tracker taps the
// relay's toClient (an init script wrapping qed64.relay.toClient, reporting
// every LSP error reply through an exposed binding that survives a reload)
// and pairs the same way: each empty console.error, in time order, from the
// page's main bundle (the module script index.html loads; not a worker or
// the InfoView), is explained only by its OWN unused -32800 reply from the
// 3 s before it or the 0.5 s after. One reply explains one line; an unpaired
// one, or one from elsewhere, stays unexplained. The bundle's line is not
// pinned (it changes per build; the showcase pins it per QED64 pin).

/** The empty NotificationService line pairs with an LSP RequestCancelled reply this close (ms, before / after). */
export const PAIR_BEFORE_MS = 3000, PAIR_AFTER_MS = 500;

// Wraps the page's relay.toClient (frontend/src/relay-taps.ts already shadows it; the relay calls this.toClient
// dynamically) and reports every LSP error reply to Node. Top frame only (the InfoView iframe has no relay).
const LSP_TAP = `(() => {
  try { if (window.top !== window || window.__qed64LaneTap) return; } catch (e) { return; }
  window.__qed64LaneTap = true;
  let wrapped = null;
  setInterval(() => {
    let r = null; try { r = window.qed64 && window.qed64.relay; } catch (e) { r = null; }
    if (!r || r === wrapped || typeof r.toClient !== 'function') return;
    const tc = r.toClient;
    r.toClient = function (m) {
      try { if (m && m.id !== undefined && m.error && typeof window.__qed64LaneLspError === 'function') window.__qed64LaneLspError({ id: m.id, code: m.error.code, message: String(m.error.message || '').slice(0, 200) }); } catch (e) {}
      return tc.apply(this, arguments);
    };
    wrapped = r;
  }, 5);
})();`;

/** Installs the tap on `context` before its first page opens; `at()` is the lane's clock (ms). */
export async function trackEmptyConsole(context, at) {
  const lspErrors = [], pending = [], mainBundles = new Set();
  await context.exposeBinding("__qed64LaneLspError", (_source, e) => { lspErrors.push({ t: at(), ...e }); });
  await context.addInitScript(LSP_TAP);
  return {
    lspErrors,
    mainBundles,
    /** msg.text() of a console call whose arguments render empty says nothing: record what was passed, and where. */
    describe(m, line) {
      if (line.text !== "") return;
      const loc = m.location?.() ?? {};
      line.where = loc.url ? `${loc.url.replace(/^https?:\/\/[^/]+/, "")}:${loc.lineNumber}:${loc.columnNumber}` : "?";
      pending.push(Promise.all(m.args().map((a) => a.jsonValue().then((v) => JSON.stringify(v) ?? String(v), () => a.toString())))
        .then((args) => { line.args = args; }, (e) => { line.args = [`<unreadable: ${String(e?.message ?? e).slice(0, 80)}>`]; }));
    },
    /** The page's main bundle by path; call after each load (a served build's name is content-hashed). */
    async noteMainBundle(page, url) {
      const src = await page.evaluate(() => document.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null).catch(() => null);
      if (src) mainBundles.add(new URL(src, url).pathname);
    },
    /** The argument reads die with the context: await this before closing it. */
    settle: () => Promise.allSettled(pending),
    /** The judged lines this explains, one-to-one in time order, only from the main bundle. */
    paired(judged) {
      const replies = lspErrors.filter((e) => e.code === -32800).map((e) => ({ t: e.t, used: false })).sort((a, b) => a.t - b.t);
      const fromMainBundle = (l) => typeof l.where === "string" && mainBundles.has(l.where.replace(/:\d+:\d+$/, ""));
      const paired = new Set();
      for (const l of judged.filter((x) => x.type === "error" && x.text === "").sort((a, b) => a.t - b.t)) {
        if (!fromMainBundle(l)) continue;
        const k = replies.find((e) => !e.used && e.t >= l.t - PAIR_BEFORE_MS && e.t <= l.t + PAIR_AFTER_MS);
        if (k) { k.used = true; paired.add(l); }
      }
      return paired;
    },
  };
}

/** One console line for the log: an empty one with its arguments and source location. */
export const shownLine = (l) => `${l.text.split("\n")[0].slice(0, 300)}${l.text === "" ? `(empty text; args ${JSON.stringify(l.args ?? null)} at ${l.where ?? "?"})` : ""}`;

/** The LSP error replies the tap saw, for the log. */
export const shownLspErrors = (lspErrors) => lspErrors.map((e) => `${(e.t / 1000).toFixed(1)}s ${e.code}${e.message ? ` ${JSON.stringify(e.message.slice(0, 60))}` : " (empty message)"}`).join(", ") || "none";
