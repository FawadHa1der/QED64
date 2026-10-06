#!/usr/bin/env node
// G2, the consumer check (docs/ARCHITECTURE-PLAN-QED64.md): the files `npm pack`
// ships are ALL a consumer gets, so prove they suffice, outside this repo:
//   1. `npm pack --pack-destination <work>` (no scripts), extract the tarball;
//   2. a temp consumer package whose node_modules/qed64 is a symlink to the
//      extracted package (created under <work>, never in this repo);
//   3. every `exports` key resolved with Node's own resolver from that
//      consumer (import and require conditions; a wildcard key for every file
//      closure.json lists under it), each target inside the extracted
//      package; a path outside `exports` must be refused; qed64/edge,
//      the olean reader, artifact-paths (buildIdOfArtifact on a stand-in
//      lean.wasm), closure.json and the two classic worker scripts the
//      library and Node tools import for their side effect (lsp-frames.js →
//      globalThis.Qed64LspFrames, memory64-probe.js → globalThis.Qed64Memory64)
//      are loaded for real; every path closure.json lists is in the tarball;
//      the shipped CLIs (preflight, olean-imports, fetch-artifacts, cli.mjs) run --help
//      through the symlink and print their usage line, release-manifest --repo <this
//      checkout> prints the repo's own manifest bytes, and fetch-artifacts
//      without --manifests refuses (the package ships no tracked manifests);
//   4. tests/consumer/fixture/ (index.html + main.ts on qed64/embed,
//      headless.ts = docs/EMBEDDING.md §6.1's headless boot on qed64/embed,
//      worker.ts on qed64/edge) copied into the consumer, plus snippet.ts =
//      the §6.1 (a) code block verbatim from the packed EMBEDDING.md (top-level
//      await, so built under §6.1 step 2's build.target), type-checked with the repo's
//      tsc and built with the repo's vite (`vite build --config`), the built
//      page still carries the probe script (package.json `sideEffects` keeps
//      client.ts's side-effect import), and the built worker answered one
//      request; §6.1 step 3's staging script, also verbatim from the packed
//      document, re-staged a stale workers dir to exactly the closure's set.
// Nothing is written under this repo (git status is compared before and
// after) or under any node_modules of it (checked: no qed64 entry, no new
// .vite-temp file).
//
// Usage: node tests/consumer/check-consumer.mjs [--work <dir>] [--keep]
//   --work <dir>  parent of the run directory (default: the OS temp dir);
//                 must be outside the repository
//   --keep        keep the run directory (default: removed on success)
// Exit 0 on `CONSUMER CHECK PASS`, 1 on `CONSUMER CHECK FAIL: <reason>`,
// 2 on usage.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const usage = "usage: check-consumer.mjs [--work <dir>] [--keep]";
if (args.includes("--help") || args.includes("-h")) { console.log(usage); process.exit(0); }
const wi = args.indexOf("--work");
if (wi >= 0 && !args[wi + 1]) { console.error(usage); process.exit(2); }
const workParent = path.resolve(wi >= 0 ? args[wi + 1] : os.tmpdir());
const inside = (dir, base) => { const rel = path.relative(base, dir); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
const refuseInside = (dir) => {
  if (inside(dir, root) || inside(dir, fs.realpathSync.native(root))) {
    console.error(`check-consumer: --work ${workParent} is inside the repository; pass a directory outside it`);
    process.exit(2);
  }
};
refuseInside(workParent);
fs.mkdirSync(workParent, { recursive: true });
refuseInside(fs.realpathSync.native(workParent)); // through a symlink
const run = fs.mkdtempSync(path.join(workParent, "qed64-consumer-"));

const fail = (reason) => { console.log(`FAIL  ${reason}`); console.log(`CONSUMER CHECK FAIL: ${reason}`); console.log(`run dir kept: ${run}`); process.exit(1); };
const ok = (what) => console.log(`ok    ${what}`);
const sh = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { encoding: "utf8", timeout: 300_000, ...opts });
  if (r.status !== 0) fail(`${path.basename(cmd)} ${argv.join(" ")} exited ${r.status ?? r.signal}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-8).join(" | ")}`);
  return r.stdout;
};

// What must not move: this worktree's files, and the shared node_modules trees.
const gitStatus = () => sh("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root });
const moduleTrees = [path.join(root, "node_modules"), path.join(root, "frontend/node_modules")].filter((d) => fs.existsSync(d));
const guard = () => moduleTrees.map((d) => {
  const temp = path.join(d, ".vite-temp");
  return { d, qed64: fs.existsSync(path.join(d, "qed64")), temp: fs.existsSync(temp) ? fs.readdirSync(temp).filter((f) => f.startsWith("vite.config.mjs")).sort() : [] };
});
const before = { git: gitStatus(), modules: JSON.stringify(guard()) };

console.log(`check-consumer: run dir ${run}`);

// 1. pack and extract
const packDir = path.join(run, "pack");
fs.mkdirSync(packDir);
const packed = JSON.parse(sh("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { cwd: root }))[0];
const tarball = path.join(packDir, packed.filename);
if (!fs.existsSync(tarball)) fail(`npm pack wrote no ${tarball}`);
ok(`npm pack: ${packed.filename}, ${packed.entryCount} files, ${packed.size} bytes`);
const extractDir = path.join(run, "extract");
fs.mkdirSync(extractDir);
sh("tar", ["-xzf", tarball, "-C", extractDir]);
const pkgDir = fs.realpathSync.native(path.join(extractDir, "package"));
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const closure = JSON.parse(fs.readFileSync(path.join(pkgDir, "embedding/closure.json"), "utf8"));
ok(`extracted to ${pkgDir}`);
// Every path closure.json lists (what a consumer copies or maps by name) is in the tarball.
{
  const tarred = new Set(packed.files.map((f) => f.path));
  const listed = [...closure.embed, ...closure.workers.map((w) => w.path), ...closure.infra, ...closure.pipeline, ...closure.pipelineData];
  if (listed.length < 40) fail(`closure.json lists only ${listed.length} paths`);
  for (const f of [...listed, "embedding/closure.json"]) {
    if (!tarred.has(f)) fail(`closure.json lists ${f}, which npm pack did not ship`);
    if (!fs.existsSync(path.join(pkgDir, f))) fail(`closure.json lists ${f}, which the extracted tarball lacks`);
  }
  ok(`every path closure.json lists is in the tarball: ${listed.length} (${closure.workers.length} workers)`);
}

// 2. the consumer package
const consumer = path.join(run, "consumer");
fs.mkdirSync(path.join(consumer, "node_modules"), { recursive: true });
fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "qed64-consumer-fixture", private: true, type: "module" }, null, 2) + "\n");
fs.symlinkSync(pkgDir, path.join(consumer, "node_modules/qed64"), "dir");

// 3. every exports key through Node's resolver, from inside the consumer
const specs = [];
for (const [key, target] of Object.entries(pkg.exports)) {
  const targets = typeof target === "string" ? { default: target } : target;
  if (!key.includes("*")) { specs.push({ key, spec: `qed64${key.slice(1)}`, want: targets.default, types: targets.types }); continue; }
  const [prefix] = key.split("*");
  const from = targets.default.split("*")[0];
  const listed = key === "./workers/*" ? closure.workers.map((w) => w.path) : key === "./pipeline/*" ? closure.pipeline : null;
  if (!listed) fail(`exports ${key}: no closure.json list to expand it with`);
  for (const file of listed) {
    if (!`./${file}`.startsWith(from)) fail(`closure.json lists ${file} under ${key}, outside ${from}`);
    specs.push({ key, spec: `qed64${prefix.slice(1)}${`./${file}`.slice(from.length)}`, want: `./${file}` });
  }
}
const probe = path.join(consumer, "resolve-probe.mjs");
fs.writeFileSync(probe, `import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const out = [];
for (const spec of JSON.parse(process.argv[2])) {
  const r = { spec };
  try { r.import = fileURLToPath(import.meta.resolve(spec)); } catch (e) { r.importError = e.code ?? String(e); }
  try { r.require = require.resolve(spec); } catch (e) { r.requireError = e.code ?? String(e); }
  out.push(r);
}
const edge = await import("qed64/edge");
const olean = await import("qed64/pipeline/artifacts/olean-imports.mjs");
const artifactPaths = await import("qed64/pipeline/toolchain/artifact-paths.mjs");
const closure = (await import("qed64/embedding/closure.json", { with: { type: "json" } })).default;
// The classic worker scripts publish themselves on globalThis when imported as modules.
await import("qed64/workers/lsp-frames.js");
await import("qed64/workers/memory64-probe.js");
const frames = globalThis.Qed64LspFrames, m64 = globalThis.Qed64Memory64;
const worker = edge.createWorker({ rootRedirect: "/showcase/" });
const redirect = await worker.fetch(new Request("https://consumer.example/"), {});
console.log(JSON.stringify({ out, loaded: {
  edge: Object.keys(edge).sort(), olean: Object.keys(olean).sort(), closureSchema: closure.schema,
  artifactPaths: Object.keys(artifactPaths).sort(), buildId: artifactPaths.buildIdOfArtifact(process.argv[3]),
  frames: frames ? { keys: Object.keys(frames).sort(), decoder: typeof frames.LspFrameDecoder, revision: frames.REVISION } : null,
  memory64: m64 ? { keys: Object.keys(m64).sort(), frozen: Object.isFrozen(m64), bytes: [...m64.MEMORY64_PROBE], probe: m64.probeMemory64(), revision: m64.REVISION } : null,
  redirect: [redirect.status, redirect.headers.get("location"), redirect.headers.get("cross-origin-embedder-policy")],
} }));
`);
const outsideExports = ["qed64/src/runtime/client.ts", "qed64/infra/worker.js", "qed64/tests/adversarial/preflight.mjs"];
// A stand-in lean.wasm for buildIdOfArtifact: its buildId is "wasm64-" + the first 16 hex of its sha256.
const standIn = path.join(run, "stand-in-bin");
fs.mkdirSync(standIn);
fs.writeFileSync(path.join(standIn, "lean.wasm"), "\0asm stand-in");
const standInId = `wasm64-${createHash("sha256").update("\0asm stand-in").digest("hex").slice(0, 16)}`;
const resolved = JSON.parse(sh(process.execPath, [probe, JSON.stringify([...specs.map((s) => s.spec), ...outsideExports]), standIn], { cwd: consumer }));
for (const s of specs) {
  const r = resolved.out.find((x) => x.spec === s.spec);
  const want = path.join(pkgDir, s.want);
  for (const how of ["import", "require"]) {
    if (!r[how]) fail(`${s.spec} (${how}): ${r[`${how}Error`]}`);
    const real = fs.realpathSync.native(r[how]);
    if (real !== want) fail(`${s.spec} (${how}) resolved to ${real}, exports says ${want}`);
  }
  if (s.types && !fs.existsSync(path.join(pkgDir, s.types))) fail(`${s.spec}: types target ${s.types} is not in the tarball`);
}
ok(`${specs.length} specifiers over ${Object.keys(pkg.exports).length} exports keys resolve (import and require) to packed files: ${Object.keys(pkg.exports).join(" ")}`);
for (const spec of outsideExports) {
  const r = resolved.out.find((x) => x.spec === spec);
  if (r.importError !== "ERR_PACKAGE_PATH_NOT_EXPORTED") fail(`${spec} is outside exports but resolved (${r.import ?? r.importError})`);
}
ok(`paths outside exports are refused (ERR_PACKAGE_PATH_NOT_EXPORTED): ${outsideExports.join(", ")}`);
const { loaded } = resolved;
for (const name of ["createWorker", "isImmutable", "artifactKey", "parseRange", "resolveRange", "withIsolationHeaders", "QED64_LEGACY"]) if (!loaded.edge.includes(name)) fail(`qed64/edge does not export ${name}`);
if (!loaded.olean.includes("oleanExtEntryCounts")) fail("qed64/pipeline/artifacts/olean-imports.mjs does not export oleanExtEntryCounts");
if (loaded.closureSchema !== "qed64.closure/v1") fail(`closure.json schema ${loaded.closureSchema}`);
if (JSON.stringify(loaded.redirect) !== JSON.stringify([302, "https://consumer.example/showcase/", "require-corp"])) fail(`qed64/edge worker answered ${JSON.stringify(loaded.redirect)}`);
if (!loaded.artifactPaths.includes("buildIdOfArtifact") || loaded.buildId !== standInId) fail(`artifact-paths.mjs: buildIdOfArtifact gave ${loaded.buildId} for a stand-in lean.wasm (want ${standInId}; exports ${loaded.artifactPaths.join(",")})`);
const revision = closure.workerProtocol.revision;
if (JSON.stringify(loaded.frames) !== JSON.stringify({ keys: ["LspFrameDecoder", "REVISION"], decoder: "function", revision })) fail(`qed64/workers/lsp-frames.js published globalThis.Qed64LspFrames = ${JSON.stringify(loaded.frames)}`);
const m64Want = { keys: ["MEMORY64_PROBE", "REVISION", "probeMemory64"], frozen: true, bytes: [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00], probe: true, revision };
if (JSON.stringify(loaded.memory64) !== JSON.stringify(m64Want)) fail(`qed64/workers/memory64-probe.js published globalThis.Qed64Memory64 = ${JSON.stringify(loaded.memory64)}`);
ok(`loaded from the tarball: qed64/edge (${loaded.edge.length} exports, a worker answered 302 with COEP), olean-imports, artifact-paths (buildIdOfArtifact → ${loaded.buildId}), closure.json, lsp-frames.js (globalThis.Qed64LspFrames) and memory64-probe.js (globalThis.Qed64Memory64, frozen, validates on this Node), revision ${revision}`);
// The shipped CLIs run through the symlink (Node loads the main module by its realpath while
// argv[1] keeps the symlink path; a main guard that compares plain paths prints nothing, exit 0).
for (const cli of ["pipeline/release/preflight.mjs", "pipeline/artifacts/olean-imports.mjs", "pipeline/release/fetch-artifacts.mjs", "pipeline/snapshot/cli.mjs"]) {
  const via = `node_modules/qed64/${cli}`;
  const help = sh(process.execPath, [via, "--help"], { cwd: consumer });
  if (!help.startsWith(`usage: ${path.basename(cli)} `)) fail(`node ${via} --help (through the symlink) printed ${JSON.stringify(help.slice(0, 120))}, not its usage line`);
}
ok("the shipped CLIs run through the node_modules/qed64 symlink: preflight, olean-imports, fetch-artifacts, cli.mjs --help print their usage, exit 0");
// release-manifest (plan B2c) ships too: the package holds no git objects, so it reads a QED64 clone named by --repo
// (this checkout, read only) and must print the same qed64.release/v1 bytes as the repo's own copy.
{
  const via = path.join("node_modules/qed64", "pipeline/release/release-manifest.mjs");
  const help = sh(process.execPath, [via, "--help"], { cwd: consumer });
  if (!help.startsWith("usage: node pipeline/release/release-manifest.mjs ")) fail(`node ${via} --help printed ${JSON.stringify(help.slice(0, 120))}, not its usage line`);
  const shipped = sh(process.execPath, [via, "--repo", root, "--commit", "HEAD"], { cwd: consumer });
  const own = sh(process.execPath, [path.join(root, "pipeline/release/release-manifest.mjs"), "--commit", "HEAD"], { cwd: root });
  if (shipped !== own) fail(`the shipped release-manifest.mjs --repo ${root} --commit HEAD differs from the repo's own (${shipped.length} vs ${own.length} bytes)`);
  if (JSON.parse(shipped).schema !== "qed64.release/v1") fail("the shipped release-manifest.mjs did not print a qed64.release/v1 manifest");
  ok(`the shipped release-manifest.mjs runs through the symlink: --help, and --repo <this checkout> --commit HEAD prints the repo's own ${own.length} bytes`);
}
// The package carries no tracked manifests: fetch-artifacts without --manifests refuses (2) before any write.
{
  const r = spawnSync(process.execPath, ["node_modules/qed64/pipeline/release/fetch-artifacts.mjs", "--out", path.join(consumer, "fetched"), "--origin", "http://127.0.0.1:9/"], { cwd: consumer, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 2 || !/^FETCH FAILED no tracked manifest .*--manifests <dir>/.test(r.stdout) || fs.existsSync(path.join(consumer, "fetched"))) {
    fail(`fetch-artifacts from the package without --manifests: exit ${r.status}, ${JSON.stringify((r.stdout + r.stderr).slice(0, 200))}`);
  }
  ok("fetch-artifacts from the package without --manifests refuses (exit 2: no tracked manifest) and writes nothing");
}

// 4. the fixture: typecheck and build against the tarball only
const fixture = path.join(root, "tests/consumer/fixture");
for (const f of fs.readdirSync(fixture)) fs.copyFileSync(path.join(fixture, f), path.join(consumer, f));
// The documented snippet itself, not only the fixture's paraphrase of it: the first ```ts block after
// §6.1's "(a) Without the editor" heading, from the PACKED EMBEDDING.md, becomes snippet.ts (the fixture's
// tsconfig and vite.config.mjs list it). Step 2's vite.config.js must carry the build target it needs.
const doc = fs.readFileSync(path.join(pkgDir, "docs/EMBEDDING.md"), "utf8");
const sec61 = doc.slice(doc.indexOf("### 6.1 Minimal Vite consumer"), doc.indexOf("\n## 7. "));
const snippet = /\*\*\(a\) Without the editor[\s\S]*?\n```ts\n([\s\S]*?)\n```\n/.exec(sec61)?.[1];
if (!snippet || !snippet.includes('from "qed64/embed"')) fail("docs/EMBEDDING.md §6.1 (a): no ```ts block importing qed64/embed");
if (!/^\s*build: \{ target: "es2022" \},/m.test(sec61)) fail('docs/EMBEDDING.md §6.1 step 2: the vite.config.js block does not set build: { target: "es2022" }');
fs.writeFileSync(path.join(consumer, "snippet.ts"), snippet + "\n");
ok(`docs/EMBEDDING.md §6.1 (a) extracted from the tarball: snippet.ts, ${snippet.split("\n").length} lines`);
sh(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(consumer, "tsconfig.json")], { cwd: consumer });
ok("tsc -p the fixture: main.ts, headless.ts and snippet.ts (qed64/embed, TypeScript source) and worker.ts (qed64/edge, edge-worker.d.ts) type-check");
sh(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build", "--config", path.join(consumer, "vite.config.mjs")], { cwd: consumer });
const dist = path.join(consumer, "dist");
const built = fs.readdirSync(dist, { recursive: true }).map(String).sort();
const text = (f) => fs.readFileSync(path.join(dist, f), "utf8");
if (!["index.html", "index.js", "headless.js", "snippet.js", "worker.js"].every((f) => built.includes(f))) fail(`vite build wrote ${built.join(", ")}`);
if (!text("index.js").includes("/workers/lean.worker.js") || !text("index.js").includes("qed64/embed ")) fail("the built page does not carry qed64/embed (WORKER_URLS missing from index.js)");
// client.ts imports memory64-probe.js for its side effect: a bundler that took the package as
// side-effect free would drop it, and MEMORY64_PROBE would be read from an undefined global.
{
  const pageJs = built.filter((f) => f.endsWith(".js") && f !== "worker.js");
  const sets = pageJs.filter((f) => /\.Qed64Memory64\s*=\s*Object\.freeze\(/.test(text(f)));
  const reads = pageJs.filter((f) => /globalThis\.Qed64Memory64\b(?!\s*=)/.test(text(f)));
  if (reads.length === 0 || sets.length === 0) fail(`the built page lost memory64-probe.js (package.json sideEffects): globalThis.Qed64Memory64 is read in [${reads.join(", ")}] and set in [${sets.join(", ")}]`);
}
// Every module vite bundled came from the extracted package, never from this repo.
for (const f of built.filter((f) => f.endsWith(".js"))) if (text(f).includes(root)) fail(`${f} names a path inside the repository`);
const builtWorker = (await import(pathToFileURL(path.join(dist, "worker.js")).href)).default;
const answer = await builtWorker.fetch(new Request("https://consumer.example/"), { ROOT_REDIRECT: "/showcase/" });
if (answer.status !== 302 || answer.headers.get("location") !== "https://consumer.example/showcase/") fail(`the built worker answered ${answer.status} ${answer.headers.get("location")}`);
ok(`vite build: ${built.join(", ")}; the built worker.js answered / with 302 → /showcase/`);

// §6.1 step 3: the staging script, verbatim from the packed EMBEDDING.md, run over a stale set (the
// previous pin's lean.worker.js and a worker the closure no longer lists) leaves exactly the closure's
// workers, byte for byte the package's; the package.json block wires it as prebuild and predev.
{
  const step3 = sec61.slice(sec61.indexOf("3. **The workers at `/workers/`"), sec61.indexOf("4. **The artifacts at"));
  const blocks = [...step3.matchAll(/\n {3}```(js|json)\n([\s\S]*?)\n {3}```\n/g)].map((m) => ({ lang: m[1], body: m[2].replace(/^ {3}/gm, "") }));
  const script = blocks.find((b) => b.lang === "js")?.body;
  const hooks = blocks.find((b) => b.lang === "json")?.body;
  if (!script || !script.startsWith("// scripts/stage-qed64-workers.mjs")) fail("docs/EMBEDDING.md §6.1 step 3: no ```js block for scripts/stage-qed64-workers.mjs");
  let scripts;
  try { scripts = JSON.parse(hooks).scripts; } catch { fail("docs/EMBEDDING.md §6.1 step 3: no ```json block with package.json scripts"); }
  if (scripts["stage:qed64"] !== "node scripts/stage-qed64-workers.mjs" || scripts.prebuild !== "npm run stage:qed64" || scripts.predev !== "npm run stage:qed64") fail(`docs/EMBEDDING.md §6.1 step 3: the scripts block does not stage before build and dev: ${JSON.stringify(scripts)}`);
  fs.mkdirSync(path.join(consumer, "scripts"));
  fs.writeFileSync(path.join(consumer, "scripts/stage-qed64-workers.mjs"), script + "\n");
  // Its own cwd (public/ there is not the fixture's Vite publicDir, which would copy it into dist).
  const site = path.join(run, "staged-site");
  fs.mkdirSync(path.join(site, "public/workers"), { recursive: true });
  fs.writeFileSync(path.join(site, "public/workers/lean.worker.js"), "// the previous pin's lean.worker.js\n");
  fs.writeFileSync(path.join(site, "public/workers/dropped.worker.js"), "// a worker the closure no longer lists\n");
  sh(process.execPath, [path.join(consumer, "scripts/stage-qed64-workers.mjs")], { cwd: site });
  const staged = fs.readdirSync(path.join(site, "public/workers")).sort();
  const want = closure.workers.map((w) => w.serveAs.slice("/workers/".length)).sort();
  if (JSON.stringify(staged) !== JSON.stringify(want)) fail(`§6.1 step 3's script staged ${staged.join(", ")}, closure.json workers are ${want.join(", ")}`);
  for (const w of closure.workers) {
    if (!fs.readFileSync(path.join(site, "public", w.serveAs)).equals(fs.readFileSync(path.join(pkgDir, w.path)))) fail(`§6.1 step 3's script staged a ${w.serveAs} that is not the package's ${w.path}`);
  }
  ok(`§6.1 step 3 (from the tarball's EMBEDDING.md) re-stages a stale set: exactly ${want.length} workers, each the package's bytes; prebuild and predev run it`);
}

// Nothing moved in the repo or its node_modules.
const after = { git: gitStatus(), modules: JSON.stringify(guard()) };
if (after.git !== before.git) fail(`git status changed during the check:\n${after.git}`);
if (after.modules !== before.modules) fail(`a node_modules tree of the repo changed: ${after.modules}`);
ok("the repository and its node_modules are untouched (git status, no qed64 entry, no new .vite-temp file)");

if (!args.includes("--keep")) fs.rmSync(run, { recursive: true, force: true });
console.log(`CONSUMER CHECK PASS${args.includes("--keep") ? ` (kept ${run})` : ""}`);
