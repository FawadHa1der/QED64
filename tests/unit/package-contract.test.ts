// The qed64 npm package (docs/EMBEDDING.md §6): lean4game installs QED64 as a
// git dependency ("qed64": "github:FawadHa1der/QED64#<sha>"), so what npm
// packs from this repository IS the library. Pinned here:
//   * no install-time scripts (npm would install devDependencies and build),
//     no runtime dependencies;
//   * embedding/closure.json lists tracked files only, and each closure is
//     self-contained: the embed TypeScript imports relative paths only, the
//     pipeline relative paths and node: built-ins only, every import resolves
//     inside its own list; lean.worker.js's importScripts targets and the
//     workers the page spawns ship beside it, and WORKER_URLS is that list;
//   * the edge-worker library (`qed64/edge`, closure.infra) imports nothing;
//   * `exports` targets exist, and `npm pack` ships the closure and nothing
//     beyond the `files` allowlist (plus npm's own README/LICENSE/package.json).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKER_URLS } from "../../frontend/src/embed/urls";

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const closure = JSON.parse(fs.readFileSync(path.join(root, "embedding/closure.json"), "utf8")) as {
  schema: string; entry: string; embed: string[]; workers: { path: string; serveAs: string }[]; infra: string[]; pipeline: string[]; pipelineData: string[];
};
/** Every file the closure names, embedding/closure.json itself excluded. */
const closureFiles = () => [...closure.embed, ...closure.workers.map((w) => w.path), ...closure.infra, ...closure.pipeline, ...closure.pipelineData];
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
  it("is MIT-licensed and ships the license text", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.files).toContain("LICENSE");
    expect(read("LICENSE")).toMatch(/^MIT License\n/);
  });

  it("gives npm no reason to prepare it as a git dependency, and has no runtime dependencies", () => {
    // pacote (lib/git.js) runs `npm install --include=dev` in a temporary clone
    // of a git dependency whose root package.json has workspaces or any of
    // these scripts — QED64's devDependencies are ~300 MB.
    for (const s of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]) expect(pkg.scripts?.[s], `scripts.${s}`).toBeUndefined();
    expect(pkg.workspaces).toBeUndefined();
    expect(pkg.sideEffects).toBe(false);
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([]);
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual([]);
  });

  it("exports the documented entries, each pointing at shipped files", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(["./edge", "./embed", "./embedding/closure.json", "./package.json", "./pipeline/*", "./workers/*"]);
    expect(pkg.exports["./embed"]).toEqual({ types: `./${closure.entry}`, default: `./${closure.entry}` });
    expect(pkg.exports["./edge"]).toEqual({ types: "./infra/edge-worker.d.ts", default: "./infra/edge-worker.js" });
    for (const t of Object.values(pkg.exports["./edge"]) as string[]) expect(closure.infra, t).toContain(t.slice(2));
    expect(pkg.exports["./workers/*"]).toBe("./public/workers/*");
    expect(pkg.exports["./pipeline/*"]).toBe("./pipeline/*");
    for (const w of closure.workers) expect(w.path.startsWith("public/workers/") && w.serveAs === `/workers/${path.posix.basename(w.path)}`, w.path).toBe(true);
    for (const p of closure.pipeline) expect(p.startsWith("pipeline/"), p).toBe(true);
  });
});

describe("embedding/closure.json", () => {
  const all = closureFiles();

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

  it("the edge-worker library (qed64/edge) imports nothing: one dependency-free ES module plus its types", () => {
    expect([...closure.infra].sort()).toEqual(["infra/edge-worker.d.ts", "infra/edge-worker.js"]);
    for (const f of closure.infra) {
      expect(specifiers(read(f)), f).toEqual([]);
      expect(read(f), f).not.toMatch(/\brequire\s*\(|["']node:/);
    }
  });

  it("every script a shipped worker importScripts by name, or the page spawns, ships beside it", () => {
    const names = new Set(closure.workers.map((w) => path.posix.basename(w.path)));
    for (const w of closure.workers) {
      for (const m of read(w.path).matchAll(/importScripts\(\s*"([^"]+)"\s*\)/g)) expect(names.has(m[1]!), `${w.path} importScripts ${m[1]}`).toBe(true);
    }
    // The embed closure's spawn sites, all of them: one that moves or is added
    // fails here instead of leaving a pattern that matches nothing.
    const served = closure.workers.map((w) => w.serveAs);
    const sites = closure.embed.flatMap((f) => (read(f).match(/new Worker\(/g) ?? []).map(() => f));
    expect(sites.sort()).toEqual(["frontend/src/embed/raw-cache.ts", "src/runtime/client.ts"]);
    const prefetch = read("frontend/src/embed/raw-cache.ts").match(/new Worker\(opts\.workerUrl \?\? "(\/workers\/[^"]+)"\)/);
    expect(prefetch && served.includes(prefetch[1]!), "prefetchRaw's default worker URL").toBe(true);
    const lean = read("src/runtime/client.ts").match(/workerUrl = "(\/workers\/[^"]+)"/);
    expect(lean && served.includes(lean[1]!), "LeanSession's default worker URL").toBe(true);
    // What an offline cache warms (embed/urls.ts, docs/EMBEDDING.md §7.5) is exactly what ships.
    expect([...WORKER_URLS].sort()).toEqual([...served].sort());
  });
});

describe("the worker protocol ledger (docs/EMBEDDING.md §7.7)", () => {
  const c = closure as unknown as { runtime: { minKernelPatch: string }; workerProtocol: { revision: string; protocol: number; requests: string[]; deprecated: unknown[] } };
  it("the three worker scripts carry the ledger's revision", () => {
    expect(read("public/workers/lean.worker.js")).toContain(`const WORKER_REVISION = "${c.workerProtocol.revision}";`);
    for (const f of ["public/workers/lsp-frames.js", "public/workers/lsp-front-door.js"]) expect(read(f), f).toContain(`REVISION: "${c.workerProtocol.revision}"`);
  });
  it("lists exactly the requests the worker answers, and the page protocol number", () => {
    const src = read("public/workers/lean.worker.js");
    expect(src).toContain(`const WORKER_REQUESTS = Object.freeze(${JSON.stringify(c.workerProtocol.requests).replace(/,/g, ", ")});`);
    expect(read("src/runtime/client.ts")).toContain(`export const PROTOCOL = ${c.workerProtocol.protocol};`);
    expect(Array.isArray(c.workerProtocol.deprecated)).toBe(true);
  });
  it("declares a runtime floor that is a patch the toolchain carries", () => {
    expect(tracked.has(`pipeline/toolchain/patches/${c.runtime.minKernelPatch}`) || [...tracked].some((f) => f.startsWith(`pipeline/toolchain/patches/${c.runtime.minKernelPatch}-`))).toBe(true);
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
    for (const f of [...closureFiles(), "embedding/closure.json"]) {
      expect(packed.has(f), `${f} is in the closure but not packed`).toBe(true);
    }
  });
});
