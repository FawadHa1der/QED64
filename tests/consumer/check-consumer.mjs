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
//      the olean reader and closure.json are loaded for real;
//      the shipped CLIs (preflight, olean-imports, fetch-artifacts, cli.mjs) run --help
//      through the symlink and print their usage line, and fetch-artifacts
//      without --manifests refuses (the package ships no tracked manifests);
//   4. tests/consumer/fixture/ (index.html + main.ts on qed64/embed,
//      headless.ts = docs/EMBEDDING.md §6.1's headless boot on qed64/embed,
//      worker.ts on qed64/edge) copied into the consumer, plus snippet.ts =
//      the §6.1 (a) code block verbatim from the packed EMBEDDING.md (top-level
//      await, so built under §6.1 step 2's build.target), type-checked with the repo's
//      tsc and built with the repo's vite (`vite build --config`), and the
//      built worker answered one request.
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
const closure = (await import("qed64/embedding/closure.json", { with: { type: "json" } })).default;
const worker = edge.createWorker({ rootRedirect: "/showcase/" });
const redirect = await worker.fetch(new Request("https://consumer.example/"), {});
console.log(JSON.stringify({ out, loaded: {
  edge: Object.keys(edge).sort(), olean: Object.keys(olean).sort(), closureSchema: closure.schema,
  redirect: [redirect.status, redirect.headers.get("location"), redirect.headers.get("cross-origin-embedder-policy")],
} }));
`);
const outsideExports = ["qed64/src/runtime/client.ts", "qed64/infra/worker.js", "qed64/tests/adversarial/preflight.mjs"];
const resolved = JSON.parse(sh(process.execPath, [probe, JSON.stringify([...specs.map((s) => s.spec), ...outsideExports])], { cwd: consumer }));
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
ok(`loaded from the tarball: qed64/edge (${loaded.edge.length} exports, a worker answered 302 with COEP), olean-imports, closure.json`);
// The shipped CLIs run through the symlink (Node loads the main module by its realpath while
// argv[1] keeps the symlink path; a main guard that compares plain paths prints nothing, exit 0).
for (const cli of ["pipeline/release/preflight.mjs", "pipeline/artifacts/olean-imports.mjs", "pipeline/release/fetch-artifacts.mjs", "pipeline/snapshot/cli.mjs"]) {
  const via = `node_modules/qed64/${cli}`;
  const help = sh(process.execPath, [via, "--help"], { cwd: consumer });
  if (!help.startsWith(`usage: ${path.basename(cli)} `)) fail(`node ${via} --help (through the symlink) printed ${JSON.stringify(help.slice(0, 120))}, not its usage line`);
}
ok("the shipped CLIs run through the node_modules/qed64 symlink: preflight, olean-imports, fetch-artifacts, cli.mjs --help print their usage, exit 0");
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
// Every module vite bundled came from the extracted package, never from this repo.
for (const f of built.filter((f) => f.endsWith(".js"))) if (text(f).includes(root)) fail(`${f} names a path inside the repository`);
const builtWorker = (await import(pathToFileURL(path.join(dist, "worker.js")).href)).default;
const answer = await builtWorker.fetch(new Request("https://consumer.example/"), { ROOT_REDIRECT: "/showcase/" });
if (answer.status !== 302 || answer.headers.get("location") !== "https://consumer.example/showcase/") fail(`the built worker answered ${answer.status} ${answer.headers.get("location")}`);
ok(`vite build: ${built.join(", ")}; the built worker.js answered / with 302 → /showcase/`);

// Nothing moved in the repo or its node_modules.
const after = { git: gitStatus(), modules: JSON.stringify(guard()) };
if (after.git !== before.git) fail(`git status changed during the check:\n${after.git}`);
if (after.modules !== before.modules) fail(`a node_modules tree of the repo changed: ${after.modules}`);
ok("the repository and its node_modules are untouched (git status, no qed64 entry, no new .vite-temp file)");

if (!args.includes("--keep")) fs.rmSync(run, { recursive: true, force: true });
console.log(`CONSUMER CHECK PASS${args.includes("--keep") ? ` (kept ${run})` : ""}`);
