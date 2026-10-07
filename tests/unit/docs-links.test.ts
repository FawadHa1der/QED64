// The docs' links resolve (plan step A5). Two checks, both against the files
// in this checkout:
// - every relative Markdown link `[text](target)` in README.md and in
//   docs/**/*.md (docs/history/ included) names a file or directory that exists,
//   resolved against the linking file's directory (an `#anchor` is dropped;
//   links inside fenced code blocks are examples, not links);
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

/** Relative Markdown link targets of one file, outside fenced code blocks. */
function relativeLinks(text: string): string[] {
  const prose = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
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

  test("every relative Markdown link in README.md and docs/**/*.md names an existing file", () => {
    const broken: string[] = [];
    let checked = 0;
    for (const f of markdownFiles) {
      for (const target of relativeLinks(fs.readFileSync(path.join(root, f), "utf8"))) {
        const file = decodeURIComponent(target.split("#")[0]!);
        if (file === "") continue;
        checked++;
        const resolved = path.normalize(path.join(root, path.dirname(f), file));
        if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) broken.push(`${f}: (${target})`);
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
