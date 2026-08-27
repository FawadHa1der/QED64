#!/usr/bin/env node
// Chunk a built lean.js/lean.wasm pair into the app's verified runtime layout:
// ≤16 MiB SHA-256-addressed parts under public/runtime/chunks plus a
// runtime-manifest.json carrying per-chunk and whole-file identities.
//
// Usage:
//   node pipeline/toolchain/chunk-runtime.mjs --bin <dir with lean.js+lean.wasm> \
//        [--lean-version 4.33.0-pre] [--revision <githash>] [--out public/runtime]

import { createHash } from "node:crypto";
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const binDir = path.resolve(arg("bin", ""));
const outDir = path.resolve(root, arg("out", "public/runtime"));
const leanVersion = arg("lean-version", "4.33.0-pre");
// Default the source revision to the fork checkout that (by the pipeline's
// build-then-chunk sequence) produced the binary being chunked, so every
// manifest identifies its exact compiler commit. The pinned upstream base is
// the lean4 commit the qed64-wasm64 branch is rebased on.
const UPSTREAM_BASE = "5732b84";
function forkRevision() {
  try {
    const head = execSync("git -C pipeline/toolchain/work/lean4 rev-parse --short=9 HEAD", { encoding: "utf8" }).trim();
    return `qed64-wasm64@${head} (base ${UPSTREAM_BASE})`;
  } catch {
    return "unspecified";
  }
}
const revision = arg("revision", forkRevision());
if (!binDir) {
  console.error("usage: chunk-runtime.mjs --bin <dir> [--lean-version v] [--revision sha] [--out dir]");
  process.exit(2);
}

const PART = 16 * 1024 * 1024;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const wasmBytes = fs.readFileSync(path.join(binDir, "lean.wasm"));
const buildId = `wasm64-${sha256(wasmBytes).slice(0, 16)}`;

fs.rmSync(path.join(outDir, "chunks"), { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "chunks"), { recursive: true });

function chunkFile(name) {
  const bytes = name === "lean.wasm" ? wasmBytes : fs.readFileSync(path.join(binDir, name));
  const whole = sha256(bytes);
  const chunks = [];
  for (let at = 0; at < bytes.length; at += PART) {
    const piece = bytes.subarray(at, Math.min(at + PART, bytes.length));
    const digest = sha256(piece);
    const file = `${name}.${digest.slice(0, 20)}.part-${String(chunks.length).padStart(3, "0")}`;
    fs.writeFileSync(path.join(outDir, "chunks", file), piece);
    chunks.push({ url: `/runtime/chunks/${file}`, bytes: piece.length, sha256: digest });
  }
  console.log(`${name}: ${bytes.length} bytes, ${chunks.length} chunks, sha256:${whole.slice(0, 16)}…`);
  return { bytes: bytes.length, sha256: whole, chunks };
}

const manifest = {
  schema: "org.lean-browser64.runtime/v1",
  buildId,
  leanVersion,
  sourceRevision: revision,
  target: "wasm64-unknown-emscripten",
  pointerBits: 64,
  memory: { initialBytes: 134217728, maximumBytes: 17179869184, shared: true },
  files: {
    "lean.js": chunkFile("lean.js"),
    "lean.wasm": chunkFile("lean.wasm"),
  },
};
fs.writeFileSync(path.join(outDir, "runtime-manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`runtime ${buildId} → ${outDir}`);
