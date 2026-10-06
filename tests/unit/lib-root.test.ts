// One library root (plan A7, docs/EMBEDDING.md §6 and §12): the `qed64/embed`
// library lives in lib/, and each of its 12 files' old paths is, for one pin
// cycle, a one-line re-export of the file that moved. Pinned here so the shims
// cannot drift from their targets:
//   * the old paths are exactly the 12 shims below, each tracked, shipped in
//     package.json `files` and absent from closure.json `embed` (the closure
//     is the library's own files);
//   * each shim's text is its comment plus `export * from "<lib/x>"` and
//     nothing else, and at run time it exports exactly its target's names,
//     bound to the same values.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as { files: string[] };
const closure = JSON.parse(read("embedding/closure.json")) as { entry: string; embed: string[] };
const tracked = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));

/** old path → the lib/ file it moved to (plan A7, 2026-10). Removed together after one pin cycle. */
const SHIMS: Record<string, string> = {
  "frontend/src/embed/index.ts": "lib/index.ts",
  "frontend/src/embed/params.ts": "lib/params.ts",
  "frontend/src/embed/failure.ts": "lib/failure.ts",
  "frontend/src/embed/raw-cache.ts": "lib/raw-cache.ts",
  "frontend/src/embed/urls.ts": "lib/urls.ts",
  "frontend/src/embed/edit-coalescer.ts": "lib/edit-coalescer.ts",
  "frontend/src/qed64-boot.ts": "lib/qed64-boot.ts",
  "frontend/src/resident-session.ts": "lib/resident-session.ts",
  "frontend/src/lsp-relay.ts": "lib/lsp-relay.ts",
  "src/install/profiles.ts": "lib/profiles.ts",
  "src/runtime/client.ts": "lib/client.ts",
  "src/runtime/snapshots.ts": "lib/snapshots.ts",
};
const shims = Object.entries(SHIMS);

/** The exact text of the shim at `from` for the moved file `to`. */
function shimText(from: string, to: string): string {
  const spec = path.posix.relative(path.posix.dirname(from), to).replace(/\.ts$/, "");
  return `// moved to ${to} in plan A7 (2026-10); this shim goes after one pin cycle (docs/EMBEDDING.md §12)\nexport * from "${spec.startsWith(".") ? spec : `./${spec}`}";\n`;
}

describe("the one-cycle path shims (plan A7)", () => {
  it("one shim per closure file: the targets are exactly closure.json `embed`", () => {
    expect(shims.map(([, to]) => to).sort()).toEqual([...closure.embed].sort());
    expect(closure.entry).toBe("lib/index.ts");
    for (const f of closure.embed) expect(f.startsWith("lib/") && !f.slice(4).includes("/"), f).toBe(true);
  });

  it("each shim is tracked, shipped in package.json files, and not part of the closure", () => {
    for (const [from] of shims) {
      expect(tracked.has(from), `${from} is not tracked`).toBe(true);
      expect(pkg.files, `${from} is not in package.json files`).toContain(from);
      expect(closure.embed, `${from} is a shim, not a closure file`).not.toContain(from);
    }
    expect(pkg.files).toContain("lib/");
    // Nothing else is left at the old library homes: the embed directory and src/ hold only shims.
    const homes = [...tracked].filter((f) => f.startsWith("frontend/src/embed/") || f.startsWith("src/"));
    expect(homes.sort()).toEqual(shims.map(([from]) => from).filter((f) => f.startsWith("frontend/src/embed/") || f.startsWith("src/")).sort());
  });

  it("each shim's source is its comment and one `export *` of its target, nothing else", () => {
    for (const [from, to] of shims) expect(read(from), from).toBe(shimText(from, to));
  });

  it("each shim exports exactly its target's names, bound to the same values", async () => {
    for (const [from, to] of shims) {
      const shim = await import(pathToFileURL(path.join(root, from)).href);
      const target = await import(pathToFileURL(path.join(root, to)).href);
      expect(Object.keys(shim).sort(), from).toEqual(Object.keys(target).sort());
      expect(Object.keys(target).length, `${to} exports nothing`).toBeGreaterThan(0);
      for (const name of Object.keys(target)) expect(shim[name], `${from}: ${name}`).toBe(target[name]);
    }
  });

  it("no lib/ module has a default export (an `export *` shim would drop it)", () => {
    for (const [, to] of shims) expect(read(to), to).not.toMatch(/\bexport\s+default\b|\bas\s+default\b/);
  });
});
