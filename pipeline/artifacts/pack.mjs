#!/usr/bin/env node
// Deterministic artifact packer.
//
// Builds a raw pack + manifest in the `browser64.artifact-manifest` format the
// app loader consumes: concatenated artifact bytes (8-byte aligned), a JSON
// index appended at the end, gzip transport split into content-addressed
// ≤16 MiB parts, and a WORKERFS byte-range table.
//
// This packer is format-compatible with the loader, not byte-identical to the
// Browser64 producer (padding and JSON canonicalization may differ); packs it
// emits carry their own digests, so interop is by manifest, never by assumed
// bytes.
//
// Usage:
//   node pipeline/artifacts/pack.mjs --lib <dir> --id <name> --out <dir> \
//        [--mount /lib/lean/library] [--lean-version 4.33.0-pre] \
//        [--revision <githash>] [--roots Mod1,Mod2]
//
// Every *.olean / *.olean.server / *.olean.private / *.ir / *.ir.sig under
// <dir> is packed; module names derive from relative paths; imports are read
// from each module's .olean header dependencies when present (best-effort:
// module graphs for test fixtures may pass --no-imports).

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const FACETS = [".olean.server", ".olean.private", ".olean", ".ir.sig", ".ir"];
const PART_BYTES = 16 * 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const libDir = path.resolve(arg("lib", ""));
const packId = arg("id", "");
const outDir = path.resolve(arg("out", "work/packs"));
const mountPoint = arg("mount", "/lib/lean/library");
const leanVersion = arg("lean-version", "4.33.0-pre");
const revision = arg("revision", "unpinned");
if (!libDir || !packId) {
  console.error("usage: pack.mjs --lib <dir> --id <name> --out <dir> [...]");
  process.exit(2);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function facetOf(file) {
  for (const facet of FACETS) if (file.endsWith(facet)) return facet.slice(1);
  return null;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (facetOf(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(libDir).sort();
if (files.length === 0) {
  console.error(`no artifacts found under ${libDir}`);
  process.exit(2);
}

// Layout: [header 80 bytes][file bytes, each 8-aligned][index JSON]
const header = Buffer.alloc(80);
header.write("qed64-pack/v1\0", 0, "ascii");

const segments = [header];
let offset = header.length;
const workerfsFiles = [];
const modules = {};
const indexEntries = [];

for (const file of files) {
  const rel = path.relative(libDir, file).split(path.sep).join("/");
  const facet = facetOf(file);
  const bytes = fs.readFileSync(file);
  const aligned = offset % 8 === 0 ? 0 : 8 - (offset % 8);
  if (aligned > 0) {
    segments.push(Buffer.alloc(aligned));
    offset += aligned;
  }
  const start = offset;
  segments.push(bytes);
  offset += bytes.length;

  const moduleName = rel
    .replace(/\.(olean\.server|olean\.private|olean|ir\.sig|ir)$/, "")
    .split("/")
    .join(".");
  workerfsFiles.push({ filename: `/${rel}`, start, end: offset });
  indexEntries.push({ path: rel, facet, start, byteLength: bytes.length, digest: `sha256:${sha256(bytes)}` });
  if (!modules[moduleName]) modules[moduleName] = { imports: [], artifacts: {} };
  modules[moduleName].artifacts[facet] = {
    digest: `sha256:${sha256(bytes)}`,
    byteLength: bytes.length,
    encoding: "identity",
    filename: rel,
  };
}

const indexJson = Buffer.from(JSON.stringify({ format: "qed64-pack-index/v1", entries: indexEntries }));
const indexOffset = offset;
segments.push(indexJson);
offset += indexJson.length;

const pack = Buffer.concat(segments, offset);
const packDigest = sha256(pack);

fs.mkdirSync(outDir, { recursive: true });
const packPath = path.join(outDir, `${packId}.pack`);
fs.writeFileSync(packPath, pack);

// Transport: one gzip stream of the whole pack, split into ≤16 MiB parts.
const gz = gzipSync(pack, { level: 9 });
const parts = [];
for (let i = 0; i < gz.length; i += PART_BYTES) {
  const piece = gz.subarray(i, Math.min(i + PART_BYTES, gz.length));
  const digest = sha256(piece);
  const name = `${packId}.pack.gzip.${digest.slice(0, 20)}.part-${String(parts.length).padStart(3, "0")}`;
  fs.writeFileSync(path.join(outDir, name), piece);
  parts.push({ url: name, digest: `sha256:${digest}`, byteLength: piece.length });
}

const roots = arg("roots", "").split(",").map((r) => r.trim()).filter(Boolean);
const manifest = {
  format: "browser64.artifact-manifest",
  version: 1,
  digest: "sha256:unsigned-local-pack",
  content: {
    release: `${packId}-${leanVersion}-local`,
    lean: { version: leanVersion, target: "wasm64-unknown-emscripten", gitRevision: revision },
    pack: {
      url: `${packId}.pack.gzip`,
      digest: `sha256:${packDigest}`,
      byteLength: pack.length,
      indexOffset,
      indexLength: indexJson.length,
      transport: {
        encoding: "gzip",
        digest: `sha256:${sha256(gz)}`,
        byteLength: gz.length,
        parts,
      },
    },
    modules,
    roots,
    workerfs: { mountPoint, metadata: { files: workerfsFiles } },
  },
};
manifest.digest = `sha256:${sha256(Buffer.from(JSON.stringify(manifest.content)))}`;
fs.writeFileSync(path.join(outDir, `${packId}.manifest.json`), JSON.stringify(manifest, null, 2));

console.log(
  `${packId}: ${files.length} artifacts, pack ${pack.length} bytes (sha256:${packDigest.slice(0, 16)}…), ` +
    `transport ${gz.length} bytes in ${parts.length} part(s) → ${outDir}`,
);
