// tests/adversarial/empty-console.mjs pairs the boot's EMPTY console.error
// (Lean's own empty RequestCancelled reply through monaco-vscode-api's
// notification service) with its own -32800 reply, as the showcase's
// classifyConsole does. The lanes judge a real page; this pins the rule
// over a fake context, with no browser.
import { describe, expect, test } from "vitest";
import { PAIR_AFTER_MS, PAIR_BEFORE_MS, trackEmptyConsole, type ConsoleLine } from "../adversarial/empty-console.mjs";

const BUNDLE = "/assets/index-abc123.js";

async function tracker() {
  let now = 0;
  let report: ((source: unknown, e: unknown) => void) | null = null;
  const scripts: string[] = [];
  const t = await trackEmptyConsole({
    exposeBinding: async (_name, cb) => { report = cb; },
    addInitScript: async (s) => { scripts.push(s); },
  }, () => now);
  t.mainBundles.add(BUNDLE);
  /** The tap reporting an LSP error reply at `at` ms. */
  const reply = (at: number, code = -32800) => { now = at; report!(null, { id: 1, code, message: "" }); };
  const empty = (at: number, where = `${BUNDLE}:1:2345`): ConsoleLine => ({ t: at, type: "error", text: "", where });
  return { t, reply, empty, scripts };
}

describe("empty-console: one -32800 reply explains one empty console.error from the main bundle", () => {
  test("the tap is installed before any page: one init script that wraps the relay's toClient", async () => {
    const { scripts } = await tracker();
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("r.toClient = function");
    expect(scripts[0]).toContain("__qed64LaneLspError");
  });

  test("paired inside the window, before or after; not outside it", async () => {
    const { t, reply, empty } = await tracker();
    reply(10_000);
    const inBefore = empty(10_000 + PAIR_BEFORE_MS); // the reply 3 s before the line
    const { t: t2, reply: reply2, empty: empty2 } = await tracker();
    reply2(10_000);
    const tooLate = empty2(10_000 + PAIR_BEFORE_MS + 1);
    const { t: t3, reply: reply3, empty: empty3 } = await tracker();
    reply3(10_000);
    const after = empty3(10_000 - PAIR_AFTER_MS); // the reply 0.5 s after the line
    const { t: t4, reply: reply4, empty: empty4 } = await tracker();
    reply4(10_000);
    const tooEarly = empty4(10_000 - PAIR_AFTER_MS - 1);
    expect(t.paired([inBefore]).has(inBefore)).toBe(true);
    expect(t2.paired([tooLate]).size).toBe(0);
    expect(t3.paired([after]).has(after)).toBe(true);
    expect(t4.paired([tooEarly]).size).toBe(0);
  });

  test("one reply explains one line, in time order; another error code explains none", async () => {
    const { t, reply, empty } = await tracker();
    reply(5_000);
    reply(5_100, -32601);
    const first = empty(5_200), second = empty(5_300);
    const paired = t.paired([second, first]);
    expect([...paired]).toEqual([first]);
  });

  test("a line from a worker, the InfoView or an unknown place is never explained; a non-empty or warning line neither", async () => {
    const { t, reply, empty } = await tracker();
    for (const at of [1_000, 1_001, 1_002, 1_003, 1_004]) reply(at);
    const lines = [
      empty(1_100, "/workers/lsp-front-door.js:3:4"),
      empty(1_100, "/infoview/webview.js:46:39141"),
      { t: 1_100, type: "error", text: "" } as ConsoleLine,
      { t: 1_100, type: "error", text: "boom", where: `${BUNDLE}:1:1` } as ConsoleLine,
      { t: 1_100, type: "warning", text: "", where: `${BUNDLE}:1:1` } as ConsoleLine,
    ];
    expect(t.paired(lines).size).toBe(0);
  });
});
