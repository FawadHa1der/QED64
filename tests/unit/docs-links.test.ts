// The docs' links resolve (plan step A5). Two checks, both against the files
// in this checkout:
// - every relative Markdown link `[text](target)` in README.md and in
//   docs/**/*.md (docs/history/ included) names a file or directory that exists,
//   resolved against the linking file's directory (an `#anchor` is dropped;
//   link syntax inside a fenced code block, column 0 or indented up to three
//   spaces under a list item, or inside an inline code span is an example,
//   not a link);
// - every `docs/….md` path cited in the source under lib/, frontend/src/,
//   pipeline/, scripts/, infra/ and public/workers/ exists, resolved against
//   the repository root. A `docs/` that follows another path segment
//   (`qed64-showcase/docs/…`, the fork's `wasm64-build/…`) is another
//   repository's and is not checked.
// A moved or deleted document therefore fails here, not in a reader's browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel, keep));
    else if (e.isFile() && keep(rel)) out.push(rel);
  }
  return out;
}

const markdownFiles = ["README.md", ...walk("docs", (f) => f.endsWith(".md"))].sort();
const CODE_DIRS = ["lib", "frontend/src", "pipeline", "scripts", "infra", "public/workers"];
const codeFiles = CODE_DIRS.flatMap((d) => walk(d, (f) => /\.(?:ts|mts|cts|js|mjs|cjs|sh|py)$/.test(f))).sort();

/** Relative Markdown link targets of one file, outside fenced code blocks and inline code spans. */
function relativeLinks(text: string): string[] {
  // A fence opens with up to three spaces, then ``` or ~~~ (or longer); it closes at a line of the same
  // fence character, at least as long, with up to three spaces of indent (CommonMark's rule).
  const prose = text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm, "")
    .replace(/(`+)(?:[^`\n]|\n(?![ \t]*\n))*?\1/g, ""); // an inline code span, never across a blank line
  const targets: string[] = [];
  for (const m of prose.matchAll(/\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = m[1]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue; // https:, mailto:, an anchor here
    targets.push(target);
  }
  return targets;
}

describe("the docs' links resolve", () => {
  test("README.md and docs/ (history included) are found", () => {
    expect(markdownFiles).toContain("README.md");
    expect(markdownFiles).toContain("docs/EMBEDDING.md");
    expect(markdownFiles).toContain("docs/history/README.md");
  });

  test("link syntax in fences (column 0 or indented under a list item) and in code spans is not a link", () => {
    const fence = "```";
    const sample = [
      "Write `[x](NOPE-SPAN.md)` to link, or ``[y](NOPE-SPAN2.md)``.",
      `${fence}md`, "[x](NOPE-COL0.md)", fence,
      "1. A step:", `   ${fence}md`, "   [x](NOPE-IND.md)", `   ${fence}`,
      "~~~", "[x](NOPE-TILDE.md)", "~~~",
      "A real one: [doc](REAL.md), and [after a span](`x`) `y` [two](REAL2.md).",
    ].join("\n");
    expect(relativeLinks(sample)).toEqual(["REAL.md", "REAL2.md"]);
  });

  test("every relative Markdown link in README.md and docs/**/*.md names an existing file", () => {
    const broken: string[] = [];
    let checked = 0;
    for (const f of markdownFiles) {
      for (const target of relativeLinks(fs.readFileSync(path.join(root, f), "utf8"))) {
        const file = decodeURIComponent(target.split("#")[0]!);
        if (file === "") continue;
        checked++;
        const resolved = path.normalize(path.join(root, path.dirname(f), file));
        if ((resolved !== root && !resolved.startsWith(root + path.sep)) || !fs.existsSync(resolved)) broken.push(`${f}: (${target})`);
      }
    }
    expect(broken).toEqual([]);
    expect(checked).toBeGreaterThan(20); // README and docs/history/README.md alone carry more
  });

  test("every docs/….md path cited in lib/, frontend/src, pipeline/, scripts/, infra/ and public/workers/ exists", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const f of codeFiles) {
      const text = fs.readFileSync(path.join(root, f), "utf8");
      for (const m of text.matchAll(/(?<![\w./-])docs\/[\w./-]*[\w-]\.md/g)) {
        checked++;
        if (!fs.existsSync(path.join(root, m[0]))) missing.push(`${f}: ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(50);
  });
});
