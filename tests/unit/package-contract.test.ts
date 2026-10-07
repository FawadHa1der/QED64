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
//   * every Tier 1/2 pipeline tool (pipeline/snapshot/cli.mjs SPECS) ships;
//   * `exports` targets exist, and `npm pack` ships the closure and nothing
//     beyond the `files` allowlist (plus npm's own README/LICENSE/package.json).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKER_URLS } from "../../frontend/src/embed/urls";
import { SPECS } from "../../pipeline/snapshot/cli.mjs";

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
    // Side-effect free except the one module the embed closure imports for its side effect (the
    // embed closure test below pins that list); with `false` a bundler drops that import.
    expect(pkg.sideEffects).toEqual(["./public/workers/memory64-probe.js"]);
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
    const workerFiles = new Set(closure.workers.map((w) => w.path));
    const reached = new Set<string>();
    const sideEffectImports = new Set<string>();
    const queue = [closure.entry];
    while (queue.length) {
      const f = queue.pop()!;
      if (reached.has(f)) continue;
      reached.add(f);
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const bare = new Set([...code.matchAll(/(?:^|[;\s])import\s*["']([^"']+)["']/g)].map((m) => m[1]!));
      for (const s of specifiers(read(f))) {
        expect(s.startsWith("./") || s.startsWith("../"), `${f} imports ${s}`).toBe(true);
        const r = resolveRel(f, s);
        expect(r, `${f}: ${s} does not resolve`).not.toBeNull();
        if (bare.has(s)) sideEffectImports.add(r!);
        // A worker script the library imports for its side effect (memory64-probe.js publishes
        // globalThis.Qed64Memory64): shipped as a worker, imports nothing itself.
        if (workerFiles.has(r!)) {
          expect(bare.has(s), `${f} imports bindings from the classic script ${r}`).toBe(true);
          expect(specifiers(read(r!)), r!).toEqual([]);
          continue;
        }
        expect(listed.has(r!), `${f} reaches ${r}, which closure.embed does not list`).toBe(true);
        queue.push(r!);
      }
    }
    // Every side-effect-only import targets a module package.json `sideEffects` names: under a
    // side-effect-free package a bundler (Vite/Rollup, webpack) drops such an import.
    expect([...sideEffectImports].sort()).toEqual(["public/workers/memory64-probe.js"]);
    expect([...sideEffectImports].map((f) => `./${f}`).sort()).toEqual([...(pkg.sideEffects as string[])].sort());
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
    // The one bare specifier: preflight's boot smoke imports the CALLER's
    // playwright, dynamically and only when it runs (not with --no-boot).
    const OPTIONAL_PEERS: Record<string, string[]> = { "pipeline/release/preflight.mjs": ["playwright"] };
    for (const f of closure.pipeline.filter((p) => /\.m?js$/.test(p))) {
      const source = read(f);
      for (const peer of OPTIONAL_PEERS[f] ?? []) {
        expect(source.match(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g), `${f} imports ${peer} dynamically, once`).toEqual([`import("${peer}")`]);
        expect(source, `${f} imports ${peer} statically`).not.toMatch(new RegExp(`from\\s*["']${peer}["']`));
      }
      for (const s of specifiers(source)) {
        if (s.startsWith("node:") || (OPTIONAL_PEERS[f] ?? []).includes(s)) continue;
        expect(s.startsWith("./") || s.startsWith("../"), `${f} imports ${s}`).toBe(true);
        const r = resolveRel(f, s);
        expect(r !== null && listed.has(r), `${f}: ${s} → ${r}`).toBe(true);
      }
    }
    // gate.mjs forwards to lean4-wasm64's gate (its own probes and runner, plan B1a): it spawns no
    // pipeline script and reads no probe; the probes stay in pipelineData for browser-check.sh.
    const gate = read("pipeline/toolchain/gate.mjs");
    expect(gate).toContain('forwardToLean4Wasm64("gate", "gate.mjs", ["--artifact", artifact])');
    expect(gate).not.toMatch(/node:child_process|"pipeline\/[\w/.-]+\.mjs"|kernel-probes/);
  });

  it("every export of a shipped pipeline .mjs with a .d.mts beside it is declared there", () => {
    // Exported for the module's own tests only, not yet type surface: declare one before a caller needs it.
    const UNDECLARED: Record<string, string[]> = { "pipeline/release/fetch-artifacts.mjs": ["openSource", "releaseResolver"] };
    const exported = (source: string) => new Set([
      ...[...source.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!),
      ...[...source.matchAll(/^export\s*\{([^}]*)\}/gm)].flatMap((m) => m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean)),
    ]);
    const pairs = closure.pipeline.filter((p) => p.endsWith(".d.mts")).map((d) => [d.replace(/\.d\.mts$/, ".mjs"), d] as const);
    expect(pairs.map(([m]) => m)).toContain("pipeline/release/release-manifest.mjs");
    for (const [m, d] of pairs) {
      expect(closure.pipeline, `${d} ships without ${m}`).toContain(m);
      const declared = exported(read(d));
      const missing = [...exported(read(m))].filter((n) => !declared.has(n) && !(UNDECLARED[m] ?? []).includes(n));
      expect(missing, `${m} exports what ${d} does not declare`).toEqual([]);
    }
  });

  it("the edge-worker library (qed64/edge) imports nothing: one dependency-free ES module plus its types", () => {
    expect([...closure.infra].sort()).toEqual(["infra/edge-worker.d.ts", "infra/edge-worker.js"]);
    for (const f of closure.infra) {
      expect(specifiers(read(f)), f).toEqual([]);
      expect(read(f), f).not.toMatch(/\brequire\s*\(|["']node:/);
    }
  });

  it("every Tier 1/2 pipeline tool ships with what it imports (cli.mjs SPECS)", () => {
    const listed = new Set(closure.pipeline);
    const files = new Set(pkg.files as string[]);
    const tools = Object.entries(SPECS).filter(([, s]) => s.tier === 1 || s.tier === 2);
    expect(tools.length).toBeGreaterThanOrEqual(10);
    for (const f of [...tools.map(([, s]) => s.script), "pipeline/snapshot/cli.mjs", "pipeline/snapshot/cli.d.mts", "pipeline/snapshot/supervised-run.mjs", "pipeline/snapshot/snapshot-probe.mjs"]) {
      expect(listed.has(f), `${f} is not in closure.pipeline`).toBe(true);
      expect(files.has(f), `${f} is not in package.json files`).toBe(true);
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

/** lean4-wasm64 artifact-id.mjs comparePatchIds: NNNN by number, then an optional lowercase suffix ("" first). */
function comparePatchIds(a: string, b: string): number {
  const parse = (id: string) => { const m = /^(\d{4})([a-z]?)$/.exec(id); if (!m) throw new Error(`not a patch id: ${id}`); return [Number(m[1]), m[2]!] as const; };
  const [na, sa] = parse(a), [nb, sb] = parse(b);
  if (na !== nb) return na - nb;
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}
const record = JSON.parse(read("toolchain/lean4-wasm64-release.json"));
const lean4Wasm64Pkg = path.join(root, "node_modules/lean4-wasm64/package.json");
const lean4Wasm64Index = fs.existsSync(lean4Wasm64Pkg) && JSON.parse(fs.readFileSync(lean4Wasm64Pkg, "utf8")).name === "lean4-wasm64" ? path.join(root, "node_modules/lean4-wasm64/index.mjs") : null;

describe("the worker protocol ledger (docs/EMBEDDING.md §7.7)", () => {
  const c = closure as unknown as { runtime: { minKernelPatch: string }; workerProtocol: { revision: string; protocol: number; requests: string[]; deprecated: unknown[] } };
  it("the four worker scripts carry the ledger's revision", () => {
    expect(read("public/workers/lean.worker.js")).toContain(`const WORKER_REVISION = "${c.workerProtocol.revision}";`);
    const siblings = ["public/workers/lsp-frames.js", "public/workers/lsp-front-door.js", "public/workers/memory64-probe.js"];
    for (const f of siblings) expect(read(f), f).toContain(`REVISION: "${c.workerProtocol.revision}"`);
    // ...and those are every shipped worker but lean.worker.js and the prefetch worker (a page-spawned
    // worker of its own, which lean.worker.js never loads).
    expect(closure.workers.map((w) => w.path).filter((p) => !siblings.includes(p)).sort()).toEqual(["public/workers/lean.worker.js", "public/workers/snapshot-prefetch.worker.js"]);
  });
  it("lists exactly the requests the worker answers, and the page protocol number", () => {
    const src = read("public/workers/lean.worker.js");
    expect(src).toContain(`const WORKER_REQUESTS = Object.freeze(${JSON.stringify(c.workerProtocol.requests).replace(/,/g, ", ")});`);
    expect(read("src/runtime/client.ts")).toContain(`export const PROTOCOL = ${c.workerProtocol.protocol};`);
    expect(Array.isArray(c.workerProtocol.deprecated)).toBe(true);
  });
  // The floor is checked against the pinned release record (toolchain/lean4-wasm64-release.json, a
  // byte copy of the fork's release.json), never against the lean4-wasm64 package: it is a
  // devDependency this host's shared node_modules does not carry (decision 10).
  it("declares a runtime floor that the pinned toolchain release carries", () => {
    expect(record.schema).toBe("lean4-wasm64.release/v1");
    const { digest, ...rest } = record;
    expect(digest, "release.json self-digest (lean4-wasm64 release-record.mjs releaseDigest)").toBe(`sha256:${createHash("sha256").update(JSON.stringify(rest, null, 2)).digest("hex")}`);
    // Plain NNNN: lean4game's qed64-dep (scripts/stage-workers.sh) accepts only ^[0-9]{4}$.
    expect(c.runtime.minKernelPatch).toMatch(/^\d{4}$/);
    expect(comparePatchIds(record.kernel.patch, c.runtime.minKernelPatch), `kernel.patch ${record.kernel.patch} < floor ${c.runtime.minKernelPatch}`).toBeGreaterThanOrEqual(0);
    const url = pkg.devDependencies?.["lean4-wasm64"] as string;
    expect(url.endsWith(`/${record.id}/lean4-wasm64-${record.tools.version}.tgz`), url).toBe(true);
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.packages["node_modules/lean4-wasm64"]?.resolved).toBe(url);
  });
  it.skipIf(!lean4Wasm64Index)("agrees with the installed lean4-wasm64 package (runs where npm ci installed devDependencies)", async () => {
    const lib = await import(pathToFileURL(lean4Wasm64Index!).href);
    for (const [a, b] of [["0035b", "0032"], ["0032", "0035b"], ["0035", "0035b"], ["0035b", "0035"], ["0035b", "0035b"], ["0036", "0035z"], [record.kernel.patch, c.runtime.minKernelPatch]]) {
      expect(Math.sign(lib.comparePatchIds(a, b)), `${a} vs ${b}`).toBe(Math.sign(comparePatchIds(a!, b!)));
    }
    expect(lib.checkReleaseRecord(record)).toEqual([]);
    expect(lib.releaseDigest(record)).toBe(record.digest);
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
