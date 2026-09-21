#!/usr/bin/env node
// Stage a version import's library packs next to its runtime and snapshots.
//
//   work/staging/<buildId>/profiles/
//     index.json                        schema qed64.profile-index/v1, runtime { buildId, leanVersion }
//     lean-core.manifest.json           as pack.mjs wrote it (part URLs are the SERVED ones, /profiles/…)
//     mathlib-essential.manifest.json
//     <every transport part those manifests reference, by basename>
//
// The profile ids and manifest URLs are taken from the served
// public/profiles/index.json (read-only), so the staged index is the served
// one with the new runtime, releases and module counts. Nothing here writes
// under public/ — promotion is a separate step.
//
// Before anything is copied the two manifests are checked as a PAIR, because
// they are unpacked into one tree and imported as one library:
//   - every part file exists in --packs with the manifest's length and SHA-256;
//   - every part URL is /profiles/<basename> (the browser fetches it verbatim);
//   - both manifests carry --lean-version;
//   - no module is in both packs; every root is present; every import of every
//     module resolves inside the two packs (the union is import-closed);
//   - with --expect-modules <file> (one module per line; Init/Init.* and `#`
//     lines ignored): every listed module is in the essential pack.
//
// Usage: node pipeline/release/stage-profiles.mjs --packs <dir> --build-id wasm64-<16 hex> --lean-version <v>
//          [--expect-modules <file>] [--served-index public/profiles/index.json]
//          [--out work/staging/<buildId>/profiles] [--check-only]

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refuseInsidePublic, stagingDir } from "../toolchain/artifact-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const checkOnly = process.argv.includes("--check-only");
const packs = arg("packs", null) && path.resolve(arg("packs", null));
const buildId = arg("build-id", "");
const leanVersion = arg("lean-version", "");
const expectModules = arg("expect-modules", null);
const servedIndexPath = path.resolve(root, arg("served-index", "public/profiles/index.json"));
const fail = (why) => { console.error(`stage-profiles: ${why}`); process.exit(1); };
if (!packs || !/^wasm64-[0-9a-f]{16}$/.test(buildId) || !leanVersion) {
  console.error("usage: stage-profiles.mjs --packs <dir> --build-id wasm64-<16 hex> --lean-version <v> [--expect-modules <file>] [--out <dir>] [--check-only]");
  process.exit(2);
}
const out = path.resolve(root, arg("out", stagingDir(root, buildId, "profiles")));
refuseInsidePublic(root, out, "stage-profiles");

const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { return fail(`cannot read ${file}: ${error.message}`); }
};

const served = readJson(servedIndexPath);
if (served.schema !== "qed64.profile-index/v1" || !Array.isArray(served.profiles) || served.profiles.length === 0) {
  fail(`${servedIndexPath} is not a qed64.profile-index/v1 with profiles`);
}

const profiles = served.profiles.map((entry) => {
  const manifestName = path.basename(entry.manifest);
  const manifestPath = path.join(packs, manifestName);
  if (!fs.existsSync(manifestPath)) fail(`the served index lists ${entry.manifest} (profile ${entry.id}) but ${manifestPath} is absent — pack it first`);
  const manifest = readJson(manifestPath);
  const content = manifest.content;
  if (manifest.format !== "browser64.artifact-manifest" || !content?.pack?.transport?.parts?.length) fail(`${manifestName}: not a browser64.artifact-manifest with transport parts`);
  if (content.lean?.version !== leanVersion) fail(`${manifestName}: packed for Lean ${content.lean?.version}, this import is ${leanVersion}`);
  const parts = content.pack.transport.parts.map((part) => {
    const base = path.basename(part.url);
    if (part.url !== `/profiles/${base}`) fail(`${manifestName}: part URL ${part.url} is not /profiles/<file> — pack with --url-prefix /profiles/`);
    const file = path.join(packs, base);
    if (!fs.existsSync(file)) fail(`${manifestName}: part ${base} is absent from ${packs}`);
    if (fs.statSync(file).size !== part.byteLength) fail(`${manifestName}: part ${base} is ${fs.statSync(file).size} bytes, manifest says ${part.byteLength}`);
    if (`sha256:${sha256File(file)}` !== part.digest) fail(`${manifestName}: part ${base} does not match its digest — repack`);
    return { base, file };
  });
  const total = content.pack.transport.parts.reduce((sum, part) => sum + part.byteLength, 0);
  if (total !== content.pack.transport.byteLength) fail(`${manifestName}: parts sum to ${total}, transport says ${content.pack.transport.byteLength}`);
  return { entry, manifestName, manifestPath, manifest, parts, modules: content.modules, roots: content.roots ?? [] };
});

// The pair as one library.
const owner = new Map();
for (const p of profiles) {
  for (const name of Object.keys(p.modules)) {
    if (owner.has(name)) fail(`module ${name} is in both ${owner.get(name)} and ${p.manifestName} — unpacking them into one tree would let one overwrite the other`);
    owner.set(name, p.manifestName);
  }
}
for (const p of profiles) {
  if (p.roots.length === 0) fail(`${p.manifestName}: no roots recorded (pack with --roots)`);
  const absentRoots = p.roots.filter((r) => !(r in p.modules));
  if (absentRoots.length) fail(`${p.manifestName}: root module(s) not in the pack: ${absentRoots.join(", ")} — renamed or dropped upstream?`);
  const dangling = [];
  let edges = 0;
  for (const [name, mod] of Object.entries(p.modules)) {
    for (const dep of mod.imports ?? []) {
      edges += 1;
      if (!owner.has(dep)) dangling.push(`${name} → ${dep}`);
    }
  }
  if (edges === 0) fail(`${p.manifestName}: no import edges at all — packed with --no-imports, or the .olean reader understood nothing`);
  if (dangling.length) fail(`${p.manifestName}: ${dangling.length} import(s) resolve in neither pack, e.g. ${dangling.slice(0, 8).join("; ")}`);
  // Reachability is informational: an unreachable module is still imported by
  // the umbrella, it just is not what the roots asked for.
  const seen = new Set();
  const stack = [...p.roots];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name) || !(name in p.modules)) continue;
    seen.add(name);
    for (const dep of p.modules[name].imports ?? []) stack.push(dep);
  }
  p.unreachable = Object.keys(p.modules).length - seen.size;
}
if (expectModules) {
  const essential = profiles.find((p) => p.entry.id === "essential") ?? profiles[profiles.length - 1];
  const listed = fs.readFileSync(expectModules, "utf8").split("\n").map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l !== "Init" && !l.startsWith("Init."));
  const absent = listed.filter((name) => !(name in essential.modules));
  if (absent.length) fail(`${path.basename(expectModules)} lists ${absent.length} module(s) the ${essential.manifestName} pack lacks, e.g. ${absent.slice(0, 8).join(", ")}`);
  const extra = Object.keys(essential.modules).length - new Set(listed).size;
  console.log(`expect-modules: all ${new Set(listed).size} listed modules are packed${extra > 0 ? ` (+${extra} packed but not listed)` : ""}`);
}

for (const p of profiles) {
  console.log(`${p.entry.id}: ${p.manifest.content.release} — ${Object.keys(p.modules).length} modules, ${p.parts.length} parts verified, roots [${p.roots.join(", ")}]` +
    (p.unreachable ? `, ${p.unreachable} module(s) not reachable from the roots` : ""));
}
if (checkOnly) {
  console.log("stage-profiles: pair check passed (nothing staged: --check-only)");
  process.exit(0);
}

// Build beside the target and swap, so a reader of the staging dir (promote)
// never sees a half-assembled set, and stale parts of an earlier pack of the
// same build do not linger next to the manifests that no longer name them.
const tmp = `${out}.tmp-${process.pid}`;
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const place = (from, to) => {
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
};
for (const p of profiles) {
  for (const { base, file } of p.parts) place(file, path.join(tmp, base));
  fs.copyFileSync(p.manifestPath, path.join(tmp, p.manifestName));
}
const index = {
  schema: "qed64.profile-index/v1",
  runtime: { buildId, leanVersion },
  profiles: profiles.map((p) => ({
    id: p.entry.id,
    manifest: p.entry.manifest,
    release: p.manifest.content.release,
    modules: Object.keys(p.modules).length,
  })),
};
fs.writeFileSync(path.join(tmp, "index.json"), JSON.stringify(index, null, 2));
fs.rmSync(out, { recursive: true, force: true });
fs.renameSync(tmp, out);
console.log(`staged ${profiles.reduce((n, p) => n + p.parts.length, 0)} parts + ${profiles.length} manifests + index.json → ${path.relative(root, out) || out}`);
