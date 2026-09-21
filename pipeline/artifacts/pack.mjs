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
//        [--revision <githash>] [--roots Mod1,Mod2] \
//        [--url-prefix /profiles/] [--release <string>] [--no-imports]
//
// Every *.olean / *.olean.server / *.olean.private / *.ir / *.ir.sig under
// <dir> is packed; module names derive from relative paths; each module's
// direct imports are read from its .olean (olean-imports.mjs; --no-imports
// skips that for fixtures that are not real regions). `--url-prefix` is where
// the parts will be SERVED from: the browser fetches part URLs verbatim and
// verify-release resolves them under public/, so a pack meant for
// public/profiles/ needs `/profiles/` (the default, bare names, suits a pack
// that is only unpacked locally — unpack.mjs goes by basename either way).
//
// One streaming pass: bytes go to the raw-pack hash, the .pack file and the
// gzip stream as each file is read, and transport parts are cut as the gzip
// output arrives. Nothing pack-sized is ever held in memory — a multi-GB pack
// cannot be hashed in one update() (Node refuses > 2 GiB) nor gzipped in one
// gzipSync() (32-bit input length), and the essential pack is 3.5 GB.

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { oleanImports } from "./olean-imports.mjs";

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
const urlPrefix = arg("url-prefix", "");
const release = arg("release", `${packId}-${leanVersion}-local`);
const readImports = !flag("no-imports");
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
fs.mkdirSync(outDir, { recursive: true });
const packPath = path.join(outDir, `${packId}.pack`);
const packFd = fs.openSync(packPath, "w");
const packHash = createHash("sha256");
const transportHash = createHash("sha256");
const gzip = createGzip({ level: 9 });
const gzipEnded = once(gzip, "end");
const parts = [];
let pending = [];
let pendingBytes = 0;
let transportBytes = 0;
function cutPart(piece) {
  const digest = sha256(piece);
  const name = `${packId}.pack.gzip.${digest.slice(0, 20)}.part-${String(parts.length).padStart(3, "0")}`;
  fs.writeFileSync(path.join(outDir, name), piece);
  parts.push({ url: `${urlPrefix}${name}`, digest: `sha256:${digest}`, byteLength: piece.length });
}
gzip.on("data", (chunk) => {
  transportHash.update(chunk);
  transportBytes += chunk.length;
  pending.push(chunk);
  pendingBytes += chunk.length;
  while (pendingBytes >= PART_BYTES) {
    const all = Buffer.concat(pending, pendingBytes);
    cutPart(all.subarray(0, PART_BYTES));
    pending = all.length > PART_BYTES ? [all.subarray(PART_BYTES)] : [];
    pendingBytes = all.length - PART_BYTES;
  }
});

let offset = 0;
async function emit(bytes) {
  if (bytes.length === 0) return;
  packHash.update(bytes);
  for (let at = 0; at < bytes.length; ) at += fs.writeSync(packFd, bytes, at, bytes.length - at);
  offset += bytes.length;
  if (!gzip.write(bytes)) await once(gzip, "drain");
}

const header = Buffer.alloc(80);
header.write("qed64-pack/v1\0", 0, "ascii");
await emit(header);

const workerfsFiles = [];
const modules = {};
const indexEntries = [];
let unreadable = 0;

for (const file of files) {
  const rel = path.relative(libDir, file).split(path.sep).join("/");
  const facet = facetOf(file);
  const bytes = fs.readFileSync(file);
  if (offset % 8 !== 0) await emit(Buffer.alloc(8 - (offset % 8)));
  const start = offset;
  await emit(bytes);

  const moduleName = rel
    .replace(/\.(olean\.server|olean\.private|olean|ir\.sig|ir)$/, "")
    .split("/")
    .join(".");
  const digest = `sha256:${sha256(bytes)}`;
  workerfsFiles.push({ filename: `/${rel}`, start, end: offset });
  indexEntries.push({ path: rel, facet, start, byteLength: bytes.length, digest });
  if (!modules[moduleName]) modules[moduleName] = { imports: [], artifacts: {} };
  modules[moduleName].artifacts[facet] = { digest, byteLength: bytes.length, encoding: "identity", filename: rel };
  if (facet === "olean" && readImports) {
    const imports = oleanImports(bytes);
    if (imports) modules[moduleName].imports = imports;
    else unreadable += 1;
  }
}
// `Init` is the prelude every non-prelude module imports implicitly; a pack
// that does not carry it (mathlib-essential) leaves that edge out, the way the
// served manifests always have. Explicit `Init.X` imports stay.
if (!modules.Init) for (const entry of Object.values(modules)) entry.imports = entry.imports.filter((name) => name !== "Init");

const indexJson = Buffer.from(JSON.stringify({ format: "qed64-pack-index/v1", entries: indexEntries }));
const indexOffset = offset;
await emit(indexJson);
fs.closeSync(packFd);
gzip.end();
await gzipEnded;
if (pendingBytes > 0) cutPart(Buffer.concat(pending, pendingBytes));
const packLength = offset;
const packDigest = packHash.digest("hex");

const roots = arg("roots", "").split(",").map((r) => r.trim()).filter(Boolean);
const manifest = {
  format: "browser64.artifact-manifest",
  version: 1,
  digest: "sha256:unsigned-local-pack",
  content: {
    release,
    lean: { version: leanVersion, target: "wasm64-unknown-emscripten", gitRevision: revision },
    pack: {
      url: `${urlPrefix}${packId}.pack.gzip`,
      digest: `sha256:${packDigest}`,
      byteLength: packLength,
      indexOffset,
      indexLength: indexJson.length,
      transport: {
        encoding: "gzip",
        digest: `sha256:${transportHash.digest("hex")}`,
        byteLength: transportBytes,
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
  `${packId}: ${files.length} artifacts, ${Object.keys(modules).length} modules, pack ${packLength} bytes (sha256:${packDigest.slice(0, 16)}…), ` +
    `transport ${transportBytes} bytes in ${parts.length} part(s) → ${outDir}`,
);
if (unreadable > 0) {
  console.error(`${packId}: ${unreadable} .olean file(s) had no readable import table (not 64-bit regions?) — their imports are recorded as []; pass --no-imports if that is intended`);
  process.exit(1);
}
