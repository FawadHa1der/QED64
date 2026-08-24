#!/usr/bin/env node
// Reconstruct an on-disk olean tree from a profile's verified transport parts.
//
// Streams the gzip parts (verifying each SHA-256), inflates to the raw pack in
// memory, then writes every WORKERFS entry as a real file. Used by the
// snapshot-baking pipeline, which needs Lean's library as a filesystem.
//
// Usage: node pipeline/artifacts/unpack.mjs --manifest <file> --out <dir>

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const manifestPath = path.resolve(arg("manifest", ""));
const outDir = path.resolve(arg("out", ""));
if (!manifestPath || !outDir) {
  console.error("usage: unpack.mjs --manifest <file> --out <dir>");
  process.exit(2);
}
const sha256 = (b) => {
  const h = createHash("sha256");
  const STEP = 1 << 30;
  for (let at = 0; at < b.length; at += STEP) h.update(b.subarray(at, Math.min(at + STEP, b.length)));
  return h.digest("hex");
};
const strip = (d) => (d.startsWith("sha256:") ? d.slice(7) : d);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const { pack, workerfs, release } = manifest.content;
const dir = path.dirname(manifestPath);

const pieces = [];
for (const part of pack.transport.parts) {
  const file = path.join(dir, path.basename(new URL(part.url, "https://x/").pathname));
  const bytes = fs.readFileSync(file);
  if (bytes.length !== part.byteLength || sha256(bytes) !== strip(part.digest)) {
    console.error(`FAIL: transport part ${part.url} failed verification`);
    process.exit(1);
  }
  pieces.push(bytes);
}
const raw = gunzipSync(Buffer.concat(pieces));
if (raw.length !== pack.byteLength || sha256(raw) !== strip(pack.digest)) {
  console.error("FAIL: raw pack failed verification");
  process.exit(1);
}

let files = 0;
let bytes = 0;
for (const entry of workerfs.metadata.files) {
  const rel = entry.filename.replace(/^\//, "");
  const target = path.join(outDir, rel);
  if (!target.startsWith(outDir + path.sep)) {
    console.error(`FAIL: path escape in ${entry.filename}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, raw.subarray(entry.start, entry.end));
  files += 1;
  bytes += entry.end - entry.start;
}
console.log(`${release}: unpacked ${files} files, ${(bytes / 1e9).toFixed(2)} GB → ${outDir}`);
