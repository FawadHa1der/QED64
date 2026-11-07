// The page's look (docs/HARDENING.md #87), read as source: the element ids that lanes, the widgets showcase and
// embedders read; no `color-scheme` on the page; and two copies frontend/src/main.ts keeps of lean4monaco's own
// values, checked against the INSTALLED dist/leanmonaco.js (frontend/node_modules; skipped on a fresh clone without
// it, never under CI, as lean4monaco-fixes.test.ts), so a lean4monaco bump that changes them fails here. The layout
// and folding themselves are checked in a browser (tests/adversarial/page-ux.mjs `look` and `layout`).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
// @ts-expect-error — a plain .mjs build module without type declarations
import { LEAN4MONACO_DIR } from "../../frontend/build/lean4monaco-fixes.mjs";

const root = path.resolve(__dirname, "../..");
const main = readFileSync(path.join(root, "frontend/src/main.ts"), "utf8");
const html = readFileSync(path.join(root, "frontend/index.html"), "utf8");
const fontOf = (src: string) => /"editor\.fontFamily":\s*"([^"]+)"/.exec(src)?.[1];
const dist = path.join(LEAN4MONACO_DIR as string, "leanmonaco.js");
const skip = !existsSync(dist) && !process.env.CI;
if (skip) console.warn("page-look.test.ts: frontend/node_modules absent — skipping the lean4monaco checks (run: npm --prefix frontend ci)");

describe("frontend/index.html", () => {
  it("keeps every id the lanes, the showcase and embedders read", () => {
    for (const id of ["bar", "buildinfo", "examples", "pageactions", "fileopen", "filesave", "sharebtn", "pill", "ptext",
      "ptime", "mathlibnote", "repolinks", "split", "editor", "splitter", "infoview", "boot", "bootcard", "bootnote", "bootbar",
      "bootfill", "bootstat", "bootlabel", "bootnums", "bootstages", "bootshow", "bootreload", "pstatus"]) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });
  it("declares no color-scheme (a frame whose scheme differs from its document's gets an opaque canvas)", () => {
    expect(html).not.toMatch(/color-scheme\s*:|name="color-scheme"/); // neither the CSS property nor the meta
  });
});

describe.skipIf(skip)("main.ts against the installed lean4monaco (dist/leanmonaco.js)", () => {
  const src = skip ? "" : readFileSync(dist, "utf8");
  it("passes lean4monaco's own editor font at start (UX I3.6: the InfoView copies the font when it is made)", () => {
    expect(fontOf(src)).toBeTruthy();
    expect(fontOf(main)).toBe(fontOf(src));
  });
  it("follows an OS change with lean4monaco's own two themes, and keeps a frame on its light one (UX S1.2)", () => {
    const pair = /isBrowserDefaultDark\(\)\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/.exec(src);
    expect(pair).not.toBeNull();
    expect(main).toContain(`darkOs.matches ? "${pair![1]}" : "${pair![2]}"`);
    expect(main).toContain(`EMBED ? { "workbench.colorTheme": "${pair![2]}" }`); // a ?embed=1 frame stays light
  });
});
