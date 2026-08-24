#!/usr/bin/env node
// Promote a staged runtime + snapshot set into public/ in one step.
//
// Snapshots are binary-paired, so a runtime and its snapshots must never be
// served in a mixed state: stage both (chunk-runtime --out, bake-snapshot
// --out), then promote together. Superseded snapshot files are removed so a
// stale index can never point at a region baked for another binary.
//
// Usage: node pipeline/release/promote-staging.mjs [--staging work/staging]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const staging = path.resolve(root, arg("staging", "work/staging"));
const stagedRuntime = path.join(staging, "runtime");
const stagedSnapshots = path.join(staging, "snapshots");
for (const required of [
  path.join(stagedRuntime, "runtime-manifest.json"),
  path.join(stagedSnapshots, "index.json"),
]) {
  if (!fs.existsSync(required)) {
    console.error(`promote: missing ${required}`);
    process.exit(2);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(stagedRuntime, "runtime-manifest.json"), "utf8"));
const index = JSON.parse(fs.readFileSync(path.join(stagedSnapshots, "index.json"), "utf8"));
for (const entry of index.snapshots) {
  const file = path.join(stagedSnapshots, path.basename(entry.url));
  if (!fs.existsSync(file)) {
    console.error(`promote: index lists ${entry.url} but ${file} is absent`);
    process.exit(2);
  }
}

const publicRuntime = path.join(root, "public/runtime");
const publicSnapshots = path.join(root, "public/snapshots");
fs.rmSync(publicRuntime, { recursive: true, force: true });
fs.cpSync(stagedRuntime, publicRuntime, { recursive: true });
fs.mkdirSync(publicSnapshots, { recursive: true });
for (const name of fs.readdirSync(publicSnapshots)) {
  if (/\.snap(\.gz|z)?$/.test(name) || name === "index.json") fs.rmSync(path.join(publicSnapshots, name));
}
fs.cpSync(stagedSnapshots, publicSnapshots, { recursive: true });

console.log(`promoted runtime ${manifest.buildId} + ${index.snapshots.length} snapshot(s): ` +
  index.snapshots.map((s) => `${s.name} (${(s.transfer ?? s.bytes) / 1e6 | 0} MB wire)`).join(", "));
console.log("restart the dev server so Vite indexes the new public/ files (HARDENING #13)");
