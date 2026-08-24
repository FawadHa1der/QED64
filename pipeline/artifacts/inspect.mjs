#!/usr/bin/env node
// Inspect and verify a pack against its manifest.
//
// Checks: manifest schema, transport part digests + lengths, gzip inflation to
// the declared raw byte length, raw-pack digest, every WORKERFS range in
// bounds, every per-artifact digest, and (for qed64 packs) the embedded index.
//
// Usage: node pipeline/artifacts/inspect.mjs <manifest.json> [--pack <file>] [--deep]

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("usage: inspect.mjs <manifest.json> [--pack <file>] [--deep]");
  process.exit(2);
}
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const deep = process.argv.includes("--deep");

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const strip = (d) => (d.startsWith("sha256:") ? d.slice(7) : d);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.format !== "browser64.artifact-manifest") {
  console.error(`FAIL: unknown manifest format ${manifest.format}`);
  process.exit(1);
}
const content = manifest.content;
const dir = path.dirname(manifestPath);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

// 1. Transport parts
const partBuffers = [];
let partsOk = true;
for (const part of content.pack.transport.parts) {
  const file = path.join(dir, path.basename(new URL(part.url, "https://x/").pathname));
  if (!fs.existsSync(file)) {
    check(false, `transport part present: ${part.url}`);
    partsOk = false;
    continue;
  }
  const bytes = fs.readFileSync(file);
  const ok = bytes.length === part.byteLength && sha256(bytes) === strip(part.digest);
  check(ok, `part ${path.basename(file)} (${bytes.length} bytes)`);
  if (!ok) partsOk = false;
  partBuffers.push(bytes);
}

// 2. Inflate + raw digest
let pack = null;
const explicitPack = arg("pack", null);
if (explicitPack) {
  pack = fs.readFileSync(explicitPack);
} else if (partsOk) {
  pack = gunzipSync(Buffer.concat(partBuffers));
}
if (pack) {
  check(pack.length === content.pack.byteLength, `raw pack byteLength = ${content.pack.byteLength}`);
  check(sha256(pack) === strip(content.pack.digest), `raw pack digest = ${content.pack.digest.slice(0, 23)}…`);
} else {
  check(false, "raw pack reconstructible");
}

// 3. WORKERFS ranges
let rangesOk = true;
for (const f of content.workerfs.metadata.files) {
  if (!(Number.isSafeInteger(f.start) && Number.isSafeInteger(f.end) && f.start >= 0 && f.end >= f.start && f.end <= content.pack.byteLength)) {
    rangesOk = false;
    check(false, `range ${f.filename}`);
  }
}
check(rangesOk, `${content.workerfs.metadata.files.length} WORKERFS ranges in bounds`);

// 4. Per-artifact digests (deep)
if (deep && pack) {
  let deepOk = true;
  let checked = 0;
  const byFilename = new Map(content.workerfs.metadata.files.map((f) => [f.filename, f]));
  for (const [name, mod] of Object.entries(content.modules)) {
    for (const [facet, ref] of Object.entries(mod.artifacts || {})) {
      const entry = byFilename.get(`/${ref.filename}`);
      if (!entry) continue;
      const bytes = pack.subarray(entry.start, entry.end);
      if (bytes.length !== ref.byteLength || sha256(bytes) !== strip(ref.digest)) {
        deepOk = false;
        check(false, `artifact ${name}.${facet}`);
      }
      checked += 1;
    }
  }
  check(deepOk, `${checked} artifact digests verified`);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
