// One library root (plan A7, docs/EMBEDDING.md §6 and §12): the `qed64/embed`
// library lives in lib/, flat, and nowhere else. The one-line re-exports that
// stood at its old paths (frontend/src/embed/*, frontend/src/{qed64-boot,
// resident-session,lsp-relay}.ts, src/install/profiles.ts and
// src/runtime/{client,snapshots}.ts) were deleted after their pin cycle
// (architecture review R9a, 2026-11). Pinned here:
//   * closure.json `entry` is lib/index.ts, closure.json `embed` is exactly
//     the lib/ files, and package.json `files` ships lib/;
//   * nothing is tracked or shipped at the old paths;
// and the boundary: no tracked source outside lib/ imports through an old
// path, takes a `../../../src` hop, or reaches into src/; inside lib/ every
// import is a sibling, except client.ts's side-effect import of the Memory64
// probe.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as { files: string[] };
const closure = JSON.parse(read("embedding/closure.json")) as { entry: string; embed: string[] };
const tracked = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));

/** The library's homes before plan A7: two directories and three page-tier files (a specifier may omit the `.ts`). */
const OLD_HOMES = ["frontend/src/embed", "src"];
const OLD_FILES = ["frontend/src/qed64-boot.ts", "frontend/src/resident-session.ts", "frontend/src/lsp-relay.ts"];
const isOld = (p: string) => OLD_HOMES.some((h) => p === h || p.startsWith(`${h}/`)) || OLD_FILES.includes(p) || OLD_FILES.includes(`${p}.ts`);

/** Every module specifier of a JS/TS source (comments stripped): static and type imports,
 * re-exports, side-effect and dynamic imports, `typeof import(...)` and vi.mock targets. */
function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const re of [/(?:^|[;\s])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/g, /(?:^|[;\s])import\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g, /\bvi\.(?:mock|doMock|importActual)\(\s*["']([^"']+)["']/g]) {
    for (const m of code.matchAll(re)) out.push(m[1]!);
  }
  return out;
}
/** A relative specifier resolved the way the bundler (and vitest) resolve this repository's sources. */
function resolveRel(from: string, spec: string): string {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (tracked.has(c)) return c;
  return base;
}

describe("one library root: lib/ and nothing at the old paths (plan A7, R9a)", () => {
  const code = [...tracked].filter((f) => /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/.test(f));
  const lib = code.filter((f) => f.startsWith("lib/"));

  it("closure.json's entry is lib/index.ts, its embed files are flat lib/ files, and package.json files ships lib/", () => {
    expect(closure.entry).toBe("lib/index.ts");
    for (const f of closure.embed) expect(f.startsWith("lib/") && !f.slice(4).includes("/"), f).toBe(true);
    expect(pkg.files).toContain("lib/");
  });

  it("nothing is tracked or shipped at the library's old paths (the A7 shims are deleted)", () => {
    expect([...tracked].filter(isOld)).toEqual([]);
    expect(pkg.files.filter(isOld)).toEqual([]);
  });

  it("lib/ holds exactly the 12 closure files, and they import only each other (and the probe)", () => {
    expect(lib.sort()).toEqual([...closure.embed].sort());
    for (const f of lib) {
      for (const s of specifiers(read(f))) {
        if (f === "lib/client.ts" && s === "../public/workers/memory64-probe.js") continue;
        expect(/^\.\/[\w-]+$/.test(s), `${f} imports ${s}: a lib/ module imports its siblings only`).toBe(true);
        expect(closure.embed, `${f} imports ${s}`).toContain(resolveRel(f, s));
      }
    }
    expect(specifiers(read("lib/client.ts"))).toContain("../public/workers/memory64-probe.js");
  });

  it("no source imports through an old path, takes a ../../../src hop, or reaches into src/", () => {
    const outside = code.filter((f) => !f.startsWith("lib/"));
    expect(outside.length).toBeGreaterThan(100);
    const offences: string[] = [];
    for (const f of outside) {
      for (const s of specifiers(read(f))) {
        if (!s.startsWith(".")) continue;
        const r = resolveRel(f, s);
        if (s.includes("../../../src") || isOld(r)) offences.push(`${f} imports ${s} (${r})`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("the page imports the library from lib/, the barrel included", () => {
    const page = code.filter((f) => f.startsWith("frontend/src/"));
    const reached = new Set<string>();
    for (const f of page) for (const s of specifiers(read(f))) if (s.startsWith(".")) reached.add(resolveRel(f, s));
    expect([...reached].filter((r) => r.startsWith("lib/")).length).toBeGreaterThan(0);
    expect(reached.has("lib/index.ts"), "main.ts imports the barrel").toBe(true);
  });
});
