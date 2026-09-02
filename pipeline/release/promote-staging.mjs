#!/usr/bin/env node
// Promote a staged runtime + snapshot set into public/ in one step.
//
// Snapshots are binary-paired, so a runtime and its snapshots must never be
// served in a mixed state: stage both (chunk-runtime, bake-snapshot — their
// default --out is work/staging/<buildId>/{runtime,snapshots}), then promote
// together. The promote is ADDITIVE (review C6, HARDENING #32): chunks and
// snapshot files are content-addressed, so they are copied in next to
// whatever is already there and nothing referenced by any manifest under
// public/runtime is ever deleted; the two mutable files (the default
// manifest and the snapshot index) are switched by atomic rename, so a
// reader sees either the old pairing or the new one, never a torn tree.
//
// Usage: node pipeline/release/promote-staging.mjs --staging work/staging/<buildId>
//        [--public public] [--dry-run]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const dryRun = process.argv.includes("--dry-run");
const staging = path.resolve(root, arg("staging", "work/staging"));
const publicDir = path.resolve(root, arg("public", "public"));
const stagedRuntime = path.join(staging, "runtime");
const stagedSnapshots = path.join(staging, "snapshots");
const fail = (why) => { console.error(`promote: ${why}`); process.exit(2); };
for (const required of [
  path.join(stagedRuntime, "runtime-manifest.json"),
  path.join(stagedSnapshots, "index.json"),
]) {
  if (!fs.existsSync(required)) fail(`missing ${required}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(stagedRuntime, "runtime-manifest.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(stagedSnapshots, "index.json"), "utf8"));
if (typeof manifest.buildId !== "string" || !/^wasm64-[0-9a-f]{16}$/.test(manifest.buildId)) fail("staged manifest has no buildId");
const chunkFiles = [];
for (const [name, file] of Object.entries(manifest.files ?? {})) {
  for (const chunk of file.chunks ?? []) {
    const base = path.basename(chunk.url);
    const staged = path.join(stagedRuntime, "chunks", base);
    if (!fs.existsSync(staged)) fail(`manifest lists ${chunk.url} (${name}) but ${staged} is absent`);
    chunkFiles.push({ base, from: staged });
  }
}
if (chunkFiles.length === 0) fail("staged manifest lists no chunks");
const snapshotFiles = [];
for (const entry of index.snapshots ?? []) {
  const base = path.basename(entry.url);
  const file = path.join(stagedSnapshots, base);
  if (!fs.existsSync(file)) fail(`index lists ${entry.url} but ${file} is absent`);
  // The pairing is checked here, not assumed: an index entry must name the
  // runtime that baked it, and it must be the runtime being promoted.
  if (entry.runtime !== manifest.buildId) {
    fail(`snapshot ${entry.name} is paired with runtime ${entry.runtime ?? "(none recorded)"}, not ${manifest.buildId} — rebake it against this runtime`);
  }
  snapshotFiles.push({ base, from: file });
}

const publicRuntime = path.join(publicDir, "runtime");
const publicSnapshots = path.join(publicDir, "snapshots");
const plan = [];
const copyAdditive = (from, toDir, base) => {
  const to = path.join(toDir, base);
  if (fs.existsSync(to)) { plan.push(`keep  ${path.relative(root, to)}`); return; }
  plan.push(`copy  ${path.relative(root, to)}`);
  if (!dryRun) { fs.mkdirSync(toDir, { recursive: true }); fs.copyFileSync(from, to); }
};
// Atomic switch: write beside the target, then rename over it (POSIX rename
// replaces in one step, so no reader ever sees a partial or missing file).
const switchFile = (to, text) => {
  plan.push(`swap  ${path.relative(root, to)}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, to);
};

for (const { base, from } of chunkFiles) copyAdditive(from, path.join(publicRuntime, "chunks"), base);
for (const { base, from } of snapshotFiles) copyAdditive(from, publicSnapshots, base);
const manifestText = JSON.stringify(manifest, null, 2);
// The per-build (immutable) name first, so `?runtime=<buildId>` and the
// pinned shell can find it before the default flips.
switchFile(path.join(publicRuntime, `runtime-manifest.${manifest.buildId}.json`), manifestText);
switchFile(path.join(publicRuntime, "runtime-manifest.json"), manifestText);
switchFile(path.join(publicSnapshots, "index.json"), JSON.stringify(index, null, 2));

// Inventory, not deletion: report chunks under public/runtime that no
// manifest there references any more. Garbage collection is a deliberate,
// separate act (docs/DEPLOY.md), never a side effect of a promote.
if (!dryRun && fs.existsSync(path.join(publicRuntime, "chunks"))) {
  const referenced = new Set();
  for (const f of fs.readdirSync(publicRuntime)) {
    if (!/^runtime-manifest.*\.json$/.test(f)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(publicRuntime, f), "utf8"));
      for (const file of Object.values(m.files ?? {})) for (const c of file.chunks ?? []) referenced.add(path.basename(c.url));
    } catch { /* not a manifest */ }
  }
  const orphans = fs.readdirSync(path.join(publicRuntime, "chunks")).filter((f) => !referenced.has(f));
  if (orphans.length) console.log(`note: ${orphans.length} chunk file(s) under public/runtime/chunks are referenced by no manifest (left in place)`);
}

console.log(plan.join("\n"));
console.log(`${dryRun ? "DRY RUN — would promote" : "promoted"} runtime ${manifest.buildId} + ${index.snapshots.length} snapshot(s): ` +
  index.snapshots.map((s) => `${s.name} (${(s.transfer ?? s.bytes) / 1e6 | 0} MB wire)`).join(", "));
if (!dryRun) console.log("restart the dev server so Vite indexes the new public/ files (HARDENING #13)");
