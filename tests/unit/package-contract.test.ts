// The qed64 npm package (docs/EMBEDDING.md §6): lean4game installs QED64 as a
// git dependency ("qed64": "github:FawadHa1der/QED64#<sha>"), so what npm
// packs from this repository IS the library. Pinned here:
//   * no install-time scripts (npm would install devDependencies and build),
//     no runtime dependencies;
//   * embedding/closure.json lists tracked files only, and each closure is
//     self-contained: the embed TypeScript imports relative paths only, the
//     pipeline relative paths and node: built-ins only, every import resolves
//     inside its own list; lean.worker.js's importScripts targets ship beside it;
//   * `exports` targets exist, and `npm pack` ships the closure and nothing
//     beyond the `files` allowlist (plus npm's own README/LICENSE/package.json).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const closure = JSON.parse(fs.readFileSync(path.join(root, "embedding/closure.json"), "utf8")) as {
  schema: string; entry: string; embed: string[]; workers: { path: string; serveAs: string }[]; pipeline: string[]; pipelineData: string[];
};
const tracked = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

/** Every module specifier of a JS/TS source: static and type imports, re-exports, dynamic imports. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const re of [/(?:^|[;\s])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/g, /(?:^|[;\s])import\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of code.matchAll(re)) out.push(m[1]!);
  }
  return out;
}
/** Resolve a relative specifier the way a bundler does for this repo's sources. */
function resolveRel(from: string, spec: string): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (tracked.has(c)) return c;
  return null;
}

describe("package.json", () => {
  it("has no install-time scripts and no runtime dependencies", () => {
    for (const s of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"]) expect(pkg.scripts?.[s], s).toBeUndefined();
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual([]);
  });

  it("exports the documented entries, each pointing at shipped files", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(["./embed", "./embedding/closure.json", "./package.json", "./pipeline/*", "./workers/*"]);
    expect(pkg.exports["./embed"]).toEqual({ types: `./${closure.entry}`, default: `./${closure.entry}` });
    expect(pkg.exports["./workers/*"]).toBe("./public/workers/*");
    expect(pkg.exports["./pipeline/*"]).toBe("./pipeline/*");
    for (const w of closure.workers) expect(w.path.startsWith("public/workers/") && w.serveAs === `/workers/${path.posix.basename(w.path)}`, w.path).toBe(true);
    for (const p of closure.pipeline) expect(p.startsWith("pipeline/"), p).toBe(true);
  });
});

describe("embedding/closure.json", () => {
  const all = [...closure.embed, ...closure.workers.map((w) => w.path), ...closure.pipeline, ...closure.pipelineData];

  it("names tracked files only, once each", () => {
    expect(closure.schema).toBe("qed64.closure/v1");
    expect(closure.embed).toContain(closure.entry);
    for (const f of all) expect(tracked.has(f), f).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  it("the embed closure imports relative paths only and is self-contained", () => {
    const listed = new Set(closure.embed);
    const reached = new Set<string>();
    const queue = [closure.entry];
    while (queue.length) {
      const f = queue.pop()!;
      if (reached.has(f)) continue;
      reached.add(f);
      for (const s of specifiers(read(f))) {
        expect(s.startsWith("./") || s.startsWith("../"), `${f} imports ${s}`).toBe(true);
        const r = resolveRel(f, s);
        expect(r, `${f}: ${s} does not resolve`).not.toBeNull();
        expect(listed.has(r!), `${f} reaches ${r}, which closure.embed does not list`).toBe(true);
        queue.push(r!);
      }
    }
    // Everything listed is reachable from the entry (no dead weight), and the
    // embed directory has no module outside the list.
    expect([...reached].sort()).toEqual([...listed].sort());
    for (const f of tracked) if (f.startsWith("frontend/src/embed/") && f.endsWith(".ts")) expect(listed.has(f), `${f} ships (frontend/src/embed/ is in files) but is not in closure.embed`).toBe(true);
  });

  it("no unguarded Vite-only globals in the embed closure", () => {
    for (const f of closure.embed) {
      const src = read(f);
      expect(/import\.meta\.env/.test(src), `${f} uses import.meta.env`).toBe(false);
      for (const m of src.matchAll(/\b(__QED64_[A-Z_]+__)\b/g)) {
        expect(new RegExp(`typeof ${m[1]}`).test(src), `${f} reads ${m[1]} without a typeof guard`).toBe(true);
      }
    }
  });

  it("the pipeline imports only relative paths (inside the list) and node: built-ins", () => {
    const listed = new Set(closure.pipeline);
    for (const f of closure.pipeline.filter((p) => /\.m?js$/.test(p))) {
      for (const s of specifiers(read(f))) {
        if (s.startsWith("node:")) continue;
        expect(s.startsWith("./") || s.startsWith("../"), `${f} imports ${s}`).toBe(true);
        const r = resolveRel(f, s);
        expect(r !== null && listed.has(r), `${f}: ${s} → ${r}`).toBe(true);
      }
    }
    // gate.mjs reads the kernel probes by name and spawns two pipeline scripts.
    const gate = read("pipeline/toolchain/gate.mjs");
    for (const m of gate.matchAll(/PROBES,\s*"([\w-]+\.lean)"/g)) expect(closure.pipelineData, m[1]).toContain(`tests/adversarial/kernel-probes/${m[1]}`);
    for (const m of gate.matchAll(/"(pipeline\/[\w/.-]+\.mjs)"/g)) expect(listed.has(m[1]!), m[1]).toBe(true);
  });

  it("every script a shipped worker importScripts by name ships beside it", () => {
    const names = new Set(closure.workers.map((w) => path.posix.basename(w.path)));
    for (const w of closure.workers) {
      for (const m of read(w.path).matchAll(/importScripts\(\s*"([^"]+)"\s*\)/g)) expect(names.has(m[1]!), `${w.path} importScripts ${m[1]}`).toBe(true);
    }
    const prefetch = read("frontend/src/qed64-boot.ts").match(/new Worker\("\/workers\/([^"]+)"\)/g) ?? [];
    for (const m of prefetch) expect(names.has(m.match(/workers\/([^"]+)/)![1]!), m).toBe(true);
    const lean = read("src/runtime/client.ts").match(/workerUrl = "\/workers\/([^"]+)"/);
    expect(lean && names.has(lean[1]!), "LeanSession's default worker URL").toBe(true);
  });
});

describe("npm pack", () => {
  it("ships the closure and nothing outside the files allowlist", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 });
    const packed = new Set<string>((JSON.parse(out)[0].files as { path: string }[]).map((f) => f.path));
    const allowed = (f: string) =>
      f === "package.json" || /(^|\/)(README|LICENSE|LICENCE)(\.[a-z]+)?$/i.test(f)
      || (pkg.files as string[]).some((e) => (e.endsWith("/") ? f.startsWith(e) : f === e));
    for (const f of packed) expect(allowed(f), `${f} is packed but not allowlisted`).toBe(true);
    for (const f of [...closure.embed, ...closure.workers.map((w) => w.path), ...closure.pipeline, ...closure.pipelineData, "embedding/closure.json"]) {
      expect(packed.has(f), `${f} is in the closure but not packed`).toBe(true);
    }
  });
});
