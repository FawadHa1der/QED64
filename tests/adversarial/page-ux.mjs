#!/usr/bin/env node
// The plain page's own UX (the UX parity batch of 2026-11-06) in REAL headless
// Chromium, or Firefox with `--browser firefox`. Every scenario runs on a page
// of its own and boots an Init-only document: no Mathlib download.
//
//   a11y-status   (UX A1.3) the pill's screen-reader echo: `#pstatus` has
//                 role="status" and is clipped, not hidden; #pill, #ptext and
//                 #ptime are not live. It announces the boot (the restored
//                 buffer, then "ready" last) but never the worker's streamed
//                 progress or `elaborating`, and three edits after ready
//                 announce nothing while the pill visibly flips. Its embed
//                 half (silent under ?embed=1) is page-api.mjs embed-code.
//   share-link    (UX F1.8, F1.9) the bar's Copy link: shown on the plain
//                 page without raising the bar; a click puts
//                 `<page>#codez=<raw base64>` on a stubbed clipboard (no run
//                 touches the OS clipboard) and says "Copied", then goes back;
//                 a refused clipboard gets window.prompt with the link; typing
//                 never changes the page's URL (HARDENING #77). In a fresh
//                 visit with its own buffer the link opens behind the gate,
//                 and the opener's stored buffer stays untouched. Chromium.
//   example-undo  (UX F1.2, HARDENING #86) picking an example is one undoable
//                 edit, the cursor at 1:1, and the autosave stores it;
//                 Ctrl/Cmd+Z brings the visitor's text back and the autosave
//                 stores that again; a re-pick of the loaded example edits
//                 nothing and leaves no busy pill. Chromium and Firefox.
//   buffer-flush  (UX FILL-A13, HARDENING #86) an edit still inside the 400 ms
//                 save debounce is stored at once when the tab goes hidden,
//                 and across a reload scheduled right after the edit (the
//                 opener's once-per-tab seed keeps what the page saved).
//                 Chromium and Firefox.
//   look          (UX S1.2, I3.6, E8.3, HARDENING #87) one boot in a dark OS:
//                 the goal is in the editor's JuliaMono (not Menlo); the
//                 editor is dark (in Chromium from the start; Playwright's
//                 Firefox shows the page the scheme only through a change
//                 after load), the InfoView pane and its frame paint the
//                 editor's background, the InfoView's text reads at 4.5:1 or
//                 more on it, the page declares no color-scheme. An OS
//                 change to light follows in the same session. Fold All
//                 hides lines and no textDocument/foldingRange request
//                 reaches Lean (folding is by indentation). Chromium;
//                 Firefox once per change.
//   layout        (UX L1.4, L1.6, L1.7) at 1400, 768, 721 and 375 px
//                 wide, the bar with Copy link shown: no scroll either way,
//                 the split fills from the bar to the window's bottom,
//                 Monaco fills its pane; side by side down to 721 px,
//                 stacked at 375; a long pill label ends in an ellipsis with
//                 its tooltip and never widens the bar. Chromium; Firefox
//                 once per change.
//
// Usage: node tests/adversarial/page-ux.mjs [--url http://localhost:5199/] [--only <scenario>] [--browser chromium|firefox] [--run-dir <dir>]
// Run it through the host browser lock. Exit 0 all pass, 1 a scenario failed,
// 3 infrastructure refusal (an --only that selects no scenario included).
// Embed-mode checks live in page-api.mjs embed-code, which already frames the
// page. Verdicts are inline check maps; only the selection is exported, for
// tests/unit/page-ux.test.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, browserName, fetchJson, launchBrowser, onlyMatches, resolveTarget, root, runDir, teeLog } from "./harness.mjs";

export const SCENARIOS = ["a11y-status", "share-link", "example-undo", "buffer-flush", "look", "layout"];
/** The scenarios `--only` selects, in run order. An empty selection is refused (exit 3), never "0/0 pass". */
export const selectScenarios = (only) => SCENARIOS.filter((name) => !only || onlyMatches(name, only));
/** 0 all pass, 1 a scenario failed, 3 nothing was judged. */
export const exitCodeFor = (total, failed) => (total === 0 ? 3 : failed ? 1 : 0);

const INIT_DOC = "theorem two : 1 + 1 = 2 := rfl\n";
// a11y-status: the first edit sleeps, so the pill reads `elaborating` long enough to be seen.
const EDITS = ["theorem two : 1 + 1 = 2 := rfl\n#eval IO.sleep 500\n", "theorem three : 1 + 2 = 3 := rfl\n", "theorem four : 2 + 2 = 4 := rfl\n"];
// The worker's streamed progress labels (public/workers/lean.worker.js), which must never be announced.
const WORKER_PROGRESS = /^(Verifying |Importing modules|Loading environment snapshot|Loading the environment into Lean|Mounting |Initializing |Starting the Emscripten|Shared Memory64)/;
// share-link: the shared text, and its compressToBase64 without padding (raw: it has a `+` and a `/`; pinned in
// tests/unit/page-api.test.ts).
const SHARE_TEXT = "example (p q : Prop) (hp : p) (hq : q) : p ∧ q := ⟨hp, hq⟩\n";
const SHARE_CODEZ = "KYDwhgtgDgNsAEAKK8CO8Bc8AKAnA9lAJRIAWKWxZ6WqJl8g5ERqYC88gF+TkA08pqgS/IAUEA";
// example-undo: the visitor's own text, stored before the page loads. The lane picks only the Init example ("init"),
// never one that imports Mathlib: a fresh context would download the Mathlib environment.
const OWN = "-- my work\ntheorem mine : 2 + 2 = 4 := rfl\n";
// look, layout: an indented proof (one fold), the cursor at 2:3 shows its goal.
const LOOK_DOC = "example (p q : Prop) (hp : p) (hq : q) : p ∧ q := by\n  constructor\n  · exact hp\n  · exact hq\n";
// layout: main.ts PHASE_LABEL.headerRefused, the longest label the pill shows.
const LONG_LABEL = "this import is not available here — check the module name (this playground serves a curated Mathlib)";

// ---------- helpers, copied from infoview-actions.mjs (lanes do not import each other's internals; `text` and
// `cursorAt` are for the scenarios that follow) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, every = 200) {
  const t0 = Date.now();
  for (;;) { const v = await pred(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(every); }
}
const text = (page) => page.evaluate(() => globalThis.qed64.editor.getModel().getValue());
const cursorAt = (page, lineNumber, column) => page.evaluate(([l, c]) => { const e = globalThis.qed64.editor; e.setPosition({ lineNumber: l, column: c }); e.focus(); }, [lineNumber, column]);
/** WCAG relative luminance of a computed "rgb(…)" colour; NaN when unreadable (so every comparison fails). */
function luminance(css) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(String(css ?? ""));
  if (!m) return NaN;
  const lin = (v) => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
}
const contrast = (fg, bg) => { const a = luminance(fg), b = luminance(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };

// ---------- in-page probes (Playwright sends each as source text: self-contained) ----------
/** look: the editor's background, the InfoView pane's and its frame's, the InfoView's text colour, the goal's font
 * (found by its `⊢`, not by the InfoView's class names), the font variable lean4monaco gives the frame, and the
 * session. */
function lookProbe() {
  const bg = (e) => (e ? getComputedStyle(e).backgroundColor : null);
  const frame = [...document.querySelectorAll("#infoview iframe")].pop() ?? null;
  const fd = frame?.contentDocument ?? null;
  let goal = null;
  if (fd?.body) { const w = fd.createTreeWalker(fd.body, 4 /* SHOW_TEXT */); for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes("⊢")) { goal = n.parentElement; break; } }
  const st = globalThis.qed64.status();
  return {
    editorBg: bg(document.querySelector("#editor .monaco-editor-background")),
    paneBg: bg(document.getElementById("infoview")), frameBg: bg(frame),
    textFg: fd?.body ? fd.defaultView.getComputedStyle(fd.body).color : null,
    goalFont: goal ? fd.defaultView.getComputedStyle(goal).fontFamily : null,
    frameFont: fd?.documentElement.style.getPropertyValue("--vscode-editor-font-family") ?? null,
    frameClass: fd?.documentElement.className ?? null,
    colorScheme: getComputedStyle(document.documentElement).colorScheme || "normal",
    session: st.session, phase: st.phase,
  };
}
/** layout: the page's boxes. A string label goes to the pill through the page's own status sink first, in the same
 * turn, so no status render replaces it before the measurement. */
function layoutProbe(label) {
  if (typeof label === "string") globalThis.qed64.ui.idle(label);
  const box = (sel) => { const e = document.querySelector(sel); if (!e || e.getClientRects().length === 0) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const bar = document.getElementById("bar"), se = document.scrollingElement;
  return {
    innerWidth, innerHeight, scrollW: se.scrollWidth, scrollH: se.scrollHeight, barScrollW: bar.scrollWidth, barClientW: bar.clientWidth,
    bar: box("#bar"), pageactions: box("#pageactions"), pill: box("#pill"), title: document.getElementById("ptext").title,
    split: box("#split"), editor: box("#editor"), infoview: box("#infoview"), monacoW: globalThis.qed64.editor.getLayoutInfo().width,
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
  };
}
/** The InfoView frame's text. */
const frameText = (page) => page.evaluate(() => [...document.querySelectorAll("#infoview iframe")].pop()?.contentDocument?.body?.innerText ?? "");

// ---------- init scripts (Playwright sends each as source text: self-contained) ----------
/** a11y-status: every text #pstatus (the announcer) and #ptext (the pill) take, from the end of parsing:
 * readyState "interactive" comes before the module script runs, so the page's first label is caught. */
function recordStatusText() {
  globalThis.__said = [];
  globalThis.__shown = [];
  document.addEventListener("readystatechange", () => {
    if (document.readyState !== "interactive") return;
    for (const [id, into] of [["pstatus", globalThis.__said], ["ptext", globalThis.__shown]]) {
      const el = document.getElementById(id);
      if (el) new MutationObserver(() => into.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    }
  });
}
/** share-link: `navigator.clipboard` replaced (top frame), so no run writes the developer's OS clipboard. writeText
 * keeps the text in `__copied`, or rejects as a refused permission does while `__clipboardRefuses` is set. */
function stubClipboard() {
  if (window !== window.top) return;
  globalThis.__copied = [];
  globalThis.__clipboardRefuses = false;
  const writeText = async (t) => {
    if (globalThis.__clipboardRefuses) throw new DOMException("refused by the lane", "NotAllowedError");
    globalThis.__copied.push(t);
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

async function main() {
  try { browserName(); } catch (e) { console.error(`page-ux: refused — ${e.message}`); process.exit(3); }
  const firefox = browserName() === "firefox";
  const BOOT_MS = firefox ? 600000 : 300000; // Playwright's Firefox runs wasm several times slower
  const url = arg("url", "http://localhost:5199/");
  const only = arg("only", "");
  const scenarios = selectScenarios(only);
  if (scenarios.length === 0) { console.error(`page-ux: refused — --only ${JSON.stringify(only)} selects none of ${SCENARIOS.join(", ")}`); process.exit(3); }
  const target = resolveTarget(url);
  const manifest = await fetchJson(target.manifestUrl).catch((e) => { console.error(`page-ux: refused — ${e.message}`); process.exit(3); });
  const dir = runDir(manifest.buildId ?? "unknown", firefox ? `${target.mode}-firefox` : target.mode);
  teeLog(dir, "page-ux.log");
  console.log(`page-ux: ${url} → ${manifest.buildId} (${browserName()}); ${scenarios.join(", ")}; reports in ${path.relative(root, dir)}`);
  // Playwright makes its temporary browser profiles in os.tmpdir(): put them under the run dir, so a run that dies
  // leaves them beside its report (a Firefox profile holds the cached runtime) instead of in the system temp dir.
  const profiles = path.join(dir, "profiles");
  fs.mkdirSync(profiles, { recursive: true });
  process.env.TMPDIR = profiles;

  const results = [];
  let failed = 0;
  function record(name, ok, detail) {
    results.push({ name, outcome: ok ? "pass" : "fail", detail });
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
    fs.writeFileSync(path.join(dir, "page-ux-report.json"), JSON.stringify({ url, buildId: manifest.buildId, browser: browserName(), total: results.length, failed, results }, null, 2));
  }

  const browser = await launchBrowser().catch((e) => { console.error(`page-ux: refused — ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}`); process.exit(3); });
  const withQuery = (q, hash = "") => { const u = new URL(url); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v); u.hash = hash; return u.toString(); };
  /** A fresh context and page on `url` with `query` and `hash`. `doc` (null: none) is seeded as the stored buffer
   * once per tab, in the top frame only (a sessionStorage guard, so a reload keeps what the page itself saved).
   * `init` (called with `initArg`) is one more init script; `context` goes to browser.newContext (viewport,
   * colorScheme, …). `wait: "ready"` polls until the phase is ready within `budgetMs`; "none" returns at
   * domcontentloaded. `errors`: page errors except the shapes every load carries, and the console lines
   * infoview-actions.mjs counts. */
  async function open(doc, { init = null, initArg = undefined, context: contextOptions = {}, query = {}, hash = "", wait = "ready", budgetMs = BOOT_MS } = {}) {
    const context = await browser.newContext(contextOptions);
    await context.addInitScript((seed) => {
      if (seed === null || window !== window.top) return;
      try {
        if (sessionStorage.getItem("pageux.seeded")) return;
        localStorage.setItem("qed64.buffer", seed);
        sessionStorage.setItem("pageux.seeded", "1");
      } catch { /* storage off */ }
    }, doc);
    if (init) await context.addInitScript(init, initArg);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => { const m = String(e); if (!/unsupported|Session disposed\.|Outdated RPC session/.test(m) || /abortSignal/.test(m)) errors.push(m.slice(0, 200)); });
    page.on("console", (m) => { const t = m.text(); if (/abortSignal|is not a function|Unrecognised error|unsupported/.test(t)) errors.push(`console: ${t.slice(0, 200)}`); });
    await page.goto(withQuery(query, hash), { waitUntil: "domcontentloaded" });
    if (wait === "ready") {
      const t0 = Date.now();
      for (;;) {
        const ph = await page.evaluate(() => globalThis.qed64?.status?.()?.phase ?? null).catch(() => null);
        if (ph === "ready") break;
        if (Date.now() - t0 > budgetMs) throw new Error(`not ready within ${budgetMs} ms (phase ${ph})`);
        await sleep(250);
      }
    }
    return { page, context, errors };
  }

  const lanes = {
    "a11y-status": async () => {
      // UX A1.3: on the base build there is no #pstatus, so every announcement check fails.
      const { page, context, errors } = await open(INIT_DOC, { init: recordStatusText });
      const said = () => page.evaluate(() => globalThis.__said.slice());
      const aria = await page.evaluate(() => {
        const a = (id) => { const e = document.getElementById(id); return e ? { role: e.getAttribute("role"), live: e.getAttribute("aria-live") } : null; };
        const p = document.getElementById("pstatus");
        const cs = p ? getComputedStyle(p) : null;
        const r = p?.getBoundingClientRect();
        return { pstatus: a("pstatus"), pill: a("pill"), ptext: a("ptext"), ptime: a("ptime"), clipped: !!p && cs.display !== "none" && cs.visibility !== "hidden" && r.width <= 1 && r.height <= 1 };
      });
      // The region reads "ready" once the restored-buffer note and the first check are done.
      const atReady = (await waitFor(async () => { const s = await said(); return s.at(-1) === "ready" ? s : null; }, 10000)) ?? (await said());
      const s0 = await page.evaluate(() => globalThis.__shown.length);
      for (const doc of EDITS) {
        const r = await page.evaluate((t) => globalThis.qed64.api.setDocument(t), doc);
        await page.evaluate((v) => globalThis.qed64.api.settled({ version: v, timeoutMs: 60000 }), r.version);
      }
      await sleep(1500); // the relay repeats `ready` several times a second: a missing same-label guard shows here
      const afterEdits = await said();
      const editShown = await page.evaluate((s) => globalThis.__shown.slice(s), s0);
      const checks = {
        "#pstatus is role=status": aria.pstatus?.role === "status",
        "#pill, #ptext, #ptime are not live": [aria.pill, aria.ptext, aria.ptime].every((x) => x && !x.role && !x.live),
        "#pstatus is clipped, not hidden": aria.clipped,
        "the boot ends on ready": atReady.at(-1) === "ready",
        "the boot announced the restored buffer": atReady.includes("restored your last buffer"),
        "no worker progress announced": !afterEdits.some((t) => WORKER_PROGRESS.test(t ?? "")),
        "never elaborating": !afterEdits.includes("elaborating"),
        "the pill flipped during the edits": editShown.includes("elaborating"), // else the next check is vacuous
        "the edits announced nothing": afterEdits.length === atReady.length,
        "no page errors": errors.length === 0,
      };
      const failures = Object.keys(checks).filter((k) => !checks[k]);
      record("a11y-status", failures.length === 0, `failed ${JSON.stringify(failures)}; aria ${JSON.stringify(aria)}; boot said ${JSON.stringify(atReady)}; edits said ${JSON.stringify(afterEdits.slice(atReady.length))}; pill during the edits ${JSON.stringify(editShown.slice(0, 8))}; page errors ${JSON.stringify(errors)}`);
      await context.close();
    },
    "share-link": async () => {
      // UX F1.8 (and F1.9's writer): on the base build there is no #sharebtn, so the first click throws.
      const { page, context, errors } = await open(SHARE_TEXT, { init: stubClipboard });
      const href0 = await page.evaluate(() => location.href);
      const base = await page.evaluate(() => location.origin + location.pathname);
      const bar = await page.evaluate(() => {
        const b = document.getElementById("bar"), actions = document.getElementById("pageactions"), btn = document.getElementById("sharebtn");
        const shown = !!btn && btn.getClientRects().length > 0;
        const h1 = b.offsetHeight;
        if (actions) { actions.hidden = true; }
        const h0 = b.offsetHeight;
        if (actions) { actions.hidden = false; }
        return { shown, h0, h1, label: btn?.textContent ?? null };
      });
      await page.click("#sharebtn", { timeout: 5000 });
      const copied = await waitFor(() => page.evaluate(() => globalThis.__copied[0] ?? null), 3000);
      const labelAfter = await page.textContent("#sharebtn");
      // A refused clipboard: the link comes up in a prompt instead (Playwright dismisses it).
      let prompted = null;
      page.once("dialog", (d) => { prompted = { type: d.type(), message: d.message(), value: d.defaultValue() }; void d.dismiss(); });
      await page.evaluate(() => { globalThis.__clipboardRefuses = true; });
      await page.click("#sharebtn");
      await waitFor(() => prompted, 3000);
      // Typing never moves the URL: the page does not write its own fragment (HARDENING #77).
      await page.evaluate(() => { const m = globalThis.qed64.editor.getModel(); m.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "-- x\n" }]); });
      await sleep(2500); // past the 400 ms save and the label's 2 s
      const href1 = await page.evaluate(() => location.href);
      const labelLater = await page.textContent("#sharebtn");
      await context.close();
      // The round trip: a visitor with a buffer of their own opens the link.
      const other = "theorem other : True := trivial\n";
      const v = await open(other, { hash: copied ? new URL(copied).hash : "#codez=missing" });
      const gate = await waitFor(() => v.page.evaluate(() => document.getElementById("sharedlink-text")?.textContent ?? null), 20000);
      await v.page.click("#sharedlink-open", { timeout: 5000 }).catch(() => {});
      const opened = await waitFor(async () => ((await text(v.page)) === SHARE_TEXT ? true : null), 10000);
      await sleep(1000);
      const storedOther = await v.page.evaluate(() => localStorage.getItem("qed64.buffer"));
      const link = `${base}#codez=${SHARE_CODEZ}`;
      const checks = {
        "Copy link shows on the plain page": bar.shown && bar.label === "Copy link",
        "it keeps the bar's height": bar.h1 === bar.h0,
        "the link is raw #codez= on the page without its query": copied === link,
        "the button says Copied": labelAfter === "Copied",
        "and goes back": labelLater === "Copy link",
        "a refused clipboard prompts with the link": prompted?.type === "prompt" && prompted.value === link,
        "the page's URL never changes": href1 === href0,
        "the link opens behind the gate": gate === SHARE_TEXT,
        "Open puts it in the editor": !!opened,
        "the opener's buffer is untouched": storedOther === other,
        "no page errors": errors.length === 0 && v.errors.length === 0,
      };
      const failures = Object.keys(checks).filter((k) => !checks[k]);
      record("share-link", failures.length === 0, `failed ${JSON.stringify(failures)}; bar ${JSON.stringify(bar)}; copied ${JSON.stringify(copied)}; prompt ${JSON.stringify(prompted)}; page errors ${JSON.stringify([...errors, ...v.errors])}`);
      await v.context.close();
    },
    "example-undo": async () => {
      // UX F1.2: on the base build the pick is model.setValue, which clears the undo stack: Ctrl/Cmd+Z does nothing
      // and the autosave keeps the example.
      const { page, context, errors } = await open(OWN);
      const stored = () => page.evaluate(() => localStorage.getItem("qed64.buffer"));
      const settledPhase = () => page.evaluate(() => globalThis.qed64.api.settled({ timeoutMs: 120000 }).then((s) => s.phase, (e) => `threw ${e}`));
      await page.selectOption("#examples", "init");
      const switched = await waitFor(async () => { const t = await text(page); return t !== OWN && t.includes("Tree.mirror_size") ? t : null; }, 10000);
      const afterSwitch = await page.evaluate(() => {
        const e = globalThis.qed64.editor, m = e.getModel(), p = e.getPosition();
        return { canUndo: m.canUndo(), cursor: `${p.lineNumber}:${p.column}`, version: m.getVersionId() };
      });
      await sleep(1000); // past the 400 ms save debounce
      const storedSwitched = await stored();
      const phaseSwitched = await settledPhase();
      // A re-pick of the loaded example (as Chrome's form-state restore or a keyboard user can fire it).
      await page.evaluate(() => document.getElementById("examples").dispatchEvent(new Event("change")));
      await sleep(2000);
      const guard = await page.evaluate(() => ({ version: globalThis.qed64.editor.getModel().getVersionId(), busy: document.getElementById("pill").classList.contains("busy") }));
      // Undo with the real keys, in the editor.
      await page.evaluate(() => globalThis.qed64.api.focus());
      await page.keyboard.press("ControlOrMeta+KeyZ");
      const undone = await waitFor(async () => ((await text(page)) === OWN ? true : null), 5000);
      await sleep(1000);
      const storedUndone = await stored();
      const phaseUndone = await settledPhase();
      const checks = {
        "the pick replaced the text": !!switched,
        "the pick is undoable": afterSwitch.canUndo === true,
        "the cursor is at 1:1": afterSwitch.cursor === "1:1",
        "the autosave stored the example": !!switched && storedSwitched === switched,
        "ready after the pick": phaseSwitched === "ready",
        "a re-pick edits nothing": guard.version === afterSwitch.version,
        "a re-pick leaves no busy pill": guard.busy === false,
        "Ctrl/Cmd+Z brings the text back": !!undone,
        "the autosave stores it again": storedUndone === OWN,
        "ready after the undo": phaseUndone === "ready",
        "no page errors": errors.length === 0,
      };
      const failures = Object.keys(checks).filter((k) => !checks[k]);
      record("example-undo", failures.length === 0, `failed ${JSON.stringify(failures)}; after the pick ${JSON.stringify(afterSwitch)}; re-pick ${JSON.stringify(guard)}; phases ${phaseSwitched}/${phaseUndone}; page errors ${JSON.stringify(errors)}`);
      await context.close();
    },
    "buffer-flush": async () => {
      // UX FILL-A13: on the base build the pagehide listener only unloads the relay, so both edits are lost.
      const { page, context, errors } = await open(OWN);
      // Hidden: an edit, then (well inside the debounce) the tab goes to the background.
      const hidden = await page.evaluate(() => {
        const m = globalThis.qed64.editor.getModel(), ln = m.getLineCount();
        m.applyEdits([{ range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: 1 }, text: "-- hidden\n" }]);
        const before = localStorage.getItem("qed64.buffer");
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        delete document.visibilityState;
        return { before, after: localStorage.getItem("qed64.buffer"), text: m.getValue() };
      });
      // Reload: an edit and, in the next task, a reload. Scheduled in the page, so this evaluate returns before the
      // navigation (an evaluate on a reloading page can hang; e2e.mjs notes it).
      const origin0 = await page.evaluate(() => performance.timeOrigin);
      const { reloadText, reloadBefore } = await page.evaluate(() => {
        const m = globalThis.qed64.editor.getModel(), ln = m.getLineCount();
        m.applyEdits([{ range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: 1 }, text: "-- reload\n" }]);
        setTimeout(() => location.reload(), 0);
        return { reloadText: m.getValue(), reloadBefore: localStorage.getItem("qed64.buffer") };
      });
      const reloaded = await waitFor(async () => { const o = await page.evaluate(() => performance.timeOrigin).catch(() => null); return o !== null && o !== origin0 ? o : null; }, 30000);
      const storedAfterReload = reloaded ? await page.evaluate(() => localStorage.getItem("qed64.buffer")).catch(() => null) : null;
      const mounted = reloaded ? await waitFor(() => page.evaluate(() => globalThis.qed64?.api?.getDocument?.() != null || null).catch(() => null), BOOT_MS) : null;
      const textAfterReload = mounted ? await text(page) : null;
      const checks = {
        "the debounce still owed the hidden edit": hidden.before === OWN, // the control: the edit was inside the window
        "going hidden stores it at once": hidden.after === hidden.text,
        "the debounce still owed the reload edit": reloadBefore === hidden.text,
        "the page reloaded": !!reloaded,
        "a reload keeps the last edit": storedAfterReload === reloadText,
        "the reloaded editor shows it": textAfterReload === reloadText,
        "no page errors": errors.length === 0,
      };
      const failures = Object.keys(checks).filter((k) => !checks[k]);
      record("buffer-flush", failures.length === 0, `failed ${JSON.stringify(failures)}; hidden ${JSON.stringify(hidden)}; before the reload ${JSON.stringify(reloadBefore)}; stored after ${JSON.stringify(storedAfterReload)}; page errors ${JSON.stringify(errors)}`);
      await context.close();
    },
    "look": async () => {
      // UX S1.2, I3.6, E8.3. On the base build the editor is forced light in a dark OS, the InfoView's code font is
      // Menlo, and nothing folds (lean4monaco's "editor.folding": false).
      const { page, context, errors } = await open(LOOK_DOC, { context: { colorScheme: "dark", viewport: { width: 1400, height: 900 } } });
      await cursorAt(page, 2, 3);
      const goal = await waitFor(async () => (await frameText(page)).includes("⊢") || null, 30000);
      const atLoad = await page.evaluate(lookProbe); // before any theme change: lean4monaco re-reads the font on one
      // Playwright's Firefox does not show the context's colorScheme to this cross-origin-isolated page (matchMedia
      // reads light at load; impl/N3/probe), but page.emulateMedia reaches it, through the page's listener. Chromium
      // sees it at load (lean4monaco's own pick at start), and there this changes nothing.
      await page.emulateMedia({ colorScheme: "dark" });
      const dark = (await waitFor(async () => { const c = await page.evaluate(lookProbe); return luminance(c.editorBg) < 0.05 && c.paneBg === c.editorBg ? c : null; }, 5000)) ?? (await page.evaluate(lookProbe));
      await sleep(600); // the boot overlay's fade, for the screenshot
      await page.screenshot({ path: path.join(dir, `look-dark${firefox ? "-firefox" : ""}.png`) }).catch(() => {});
      await page.emulateMedia({ colorScheme: "light" });
      const light = (await waitFor(async () => { const c = await page.evaluate(lookProbe); return luminance(c.editorBg) > 0.8 && c.paneBg === c.editorBg ? c : null; }, 5000)) ?? (await page.evaluate(lookProbe));
      await page.screenshot({ path: path.join(dir, `look-light${firefox ? "-firefox" : ""}.png`) }).catch(() => {});
      // Folding after an edit, counting what the client sends: an LSP folding strategy asks again after each change.
      const fold = await page.evaluate(async (doc) => {
        let folding = 0, changes = 0;
        const off = globalThis.qed64.test.lsp.on("in", (m) => { if (m.method === "textDocument/foldingRange") folding += 1; if (m.method === "textDocument/didChange") changes += 1; });
        const r = await globalThis.qed64.api.setDocument(doc);
        await globalThis.qed64.api.settled({ version: r.version, timeoutMs: 60000 });
        await new Promise((res) => setTimeout(res, 1500)); // past Monaco's folding debounce
        const e = globalThis.qed64.editor;
        const lines = () => e.getVisibleRanges().reduce((n, x) => n + x.endLineNumber - x.startLineNumber + 1, 0);
        const before = lines(), text = e.getModel().getValue();
        e.trigger("page-ux", "editor.foldAll", null);
        await new Promise((res) => setTimeout(res, 300));
        const after = lines(), same = e.getModel().getValue() === text;
        e.trigger("page-ux", "editor.unfoldAll", null);
        off();
        return { before, after, same, folding, changes };
      }, `${LOOK_DOC}-- edited\n`);
      const paints = (c) => !!c.editorBg && c.paneBg === c.editorBg && c.frameBg === c.editorBg;
      const checks = {
        "the goal shows": !!goal,
        ...(firefox ? {} : { "dark from the start (Chromium)": luminance(atLoad.editorBg) < 0.05 }),
        "dark: the editor is dark": luminance(dark.editorBg) < 0.05,
        "dark: the InfoView pane and frame paint the editor's background": paints(dark),
        "dark: the InfoView's text reads on the pane (4.5:1)": contrast(dark.textFg, dark.paneBg) >= 4.5,
        "the InfoView's code font is the editor's JuliaMono": /JuliaMono/.test(atLoad.frameFont ?? "") && !/Menlo/.test(atLoad.frameFont ?? "") && /JuliaMono/.test(atLoad.goalFont ?? ""),
        "the page declares no color-scheme": dark.colorScheme === "normal",
        "an OS change to light: the editor is light": luminance(light.editorBg) > 0.8,
        "light: the InfoView pane and frame paint the editor's background": paints(light),
        "light: the InfoView's text reads on the pane (4.5:1)": contrast(light.textFg, light.paneBg) >= 4.5,
        "the change restarted nothing": light.session === dark.session && light.phase === "ready",
        "Fold All hides lines": fold.after < fold.before,
        "folding leaves the text alone": fold.same,
        "the tap saw the edit": fold.changes > 0, // else the next check is vacuous
        "no foldingRange request reaches Lean": fold.folding === 0,
        "no page errors": errors.length === 0,
      };
      const failures = Object.keys(checks).filter((k) => !checks[k]);
      record("look", failures.length === 0, `failed ${JSON.stringify(failures)}; at load ${JSON.stringify(atLoad)}; dark ${JSON.stringify(dark)}; light ${JSON.stringify(light)}; fold ${JSON.stringify(fold)}; page errors ${JSON.stringify(errors)}`);
      await context.close();
    },
    "layout": async () => {
      // UX L1.4, L1.6, L1.7. On the base build #split subtracts 33 px for a 38 px bar (every page scrolls), a long
      // label widens the bar past the window, and at 375 px the page scrolls sideways with the panes side by side.
      const { page, context, errors } = await open(LOOK_DOC, { context: { viewport: { width: 1400, height: 900 } } });
      await cursorAt(page, 2, 3);
      await waitFor(async () => (await frameText(page)).includes("⊢") || null, 30000);
      await sleep(600); // the boot overlay's fade
      const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
      const steps = [];
      let m375 = null;
      for (const [width, height] of [[1400, 900], [768, 900], [721, 900], [375, 812], [1400, 900]]) {
        await page.setViewportSize({ width, height });
        await sleep(400); // Monaco's automaticLayout (a ResizeObserver)
        const stacked = width <= 720;
        const m = await page.evaluate(layoutProbe);
        const { bar, split, editor, infoview } = m;
        const checks = {
          "no sideways scroll": m.scrollW <= m.innerWidth,
          "no vertical scroll": m.scrollH <= m.innerHeight,
          "the bar fits": m.barScrollW <= m.barClientW,
          "Copy link shows in the bar": !!m.pageactions && m.pageactions.x + m.pageactions.w <= m.innerWidth,
          "the split runs from the bar to the window's bottom": !!split && near(split.y, bar.y + bar.h) && near(split.y + split.h, m.innerHeight),
          ...(stacked
            ? {
              "the InfoView is below the editor, both full width": infoview.y >= editor.y + editor.h - 1.5 && near(editor.w, m.innerWidth) && near(infoview.w, m.innerWidth),
              "both panes have room": editor.h >= 150 && infoview.h >= 150,
              "the stacked InfoView shows the goal": (await frameText(page)).includes("⊢"),
              "a viewport meta": /^width=device-width/.test(m.viewport ?? ""),
            }
            : { "side by side": near(infoview.y, editor.y) && infoview.x >= editor.x + editor.w - 1.5 }),
          "Monaco fills its pane": near(m.monacoW, editor.w, 2),
        };
        const long = await page.evaluate(layoutProbe, LONG_LABEL);
        Object.assign(checks, {
          "a long label: no sideways scroll": long.scrollW <= long.innerWidth,
          "a long label: the bar fits": long.barScrollW <= long.barClientW,
          "a long label: the tooltip carries it whole": long.title === LONG_LABEL,
        });
        if (width === 1400 && steps.length === 0) await page.screenshot({ path: path.join(dir, `layout-1400-long${firefox ? "-firefox" : ""}.png`) }).catch(() => {});
        if (stacked) { m375 = m; await page.screenshot({ path: path.join(dir, `layout-375${firefox ? "-firefox" : ""}.png`) }).catch(() => {}); }
        await page.evaluate(() => globalThis.qed64.ui.idle("ready"));
        steps.push({ width, failures: Object.keys(checks).filter((k) => !checks[k]), bar: m.bar, pill: long.pill });
      }
      const failed = steps.filter((s) => s.failures.length > 0);
      record("layout", failed.length === 0 && errors.length === 0, `failed ${JSON.stringify(failed.map((s) => [s.width, s.failures]))}; bars ${JSON.stringify(steps.map((s) => [s.width, s.bar?.h, s.pill?.w]))}; 375: ${JSON.stringify(m375)}; page errors ${JSON.stringify(errors)}`);
      await context.close();
    },
  };

  try {
    for (const name of scenarios) {
      try { await lanes[name](); } catch (e) { record(name, false, `threw: ${String(e?.stack ?? e).slice(0, 400)}`); }
    }
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(profiles, { recursive: true, force: true }); // Playwright removed its own; this drops the empty dir
  }
  console.log(`page-ux: ${results.length - failed}/${results.length} pass; report ${path.relative(root, path.join(dir, "page-ux-report.json"))}`);
  process.exitCode = exitCodeFor(results.length, failed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
