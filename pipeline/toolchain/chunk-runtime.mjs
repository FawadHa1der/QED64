#!/usr/bin/env node
// Chunk a built lean.js/lean.wasm pair into the app's verified runtime layout:
// ≤16 MiB SHA-256-addressed parts under <out>/chunks plus a
// runtime-manifest.json carrying per-chunk and whole-file identities.
//
// The output is a STAGING tree (work/staging/<buildId>/runtime by default),
// never public/: the chunker once ran with `--out public/runtime`, rewrote the
// tracked default manifest and destroyed the served (gitignored) chunks
// (HARDENING #32, review C6). Promotion into public/ is a separate, additive
// step: `npm run promote:staging -- --staging work/staging/<buildId>`.
//
// Usage:
//   node pipeline/toolchain/chunk-runtime.mjs --bin <dir with lean.js+lean.wasm> \
//        [--lean-version 4.33.0-pre] [--revision <githash>] [--upstream-base 5732b84] \
//        [--out work/staging/<buildId>/runtime]
//
// --lean-version is what the product bar shows and what promote-staging pairs
// the library packs against (profiles/index.json runtime.leanVersion, each
// pack's content.lean.version): omitting it is a loud warning, not an error —
// bump-chain.sh only passes it when QED64_LEAN_VERSION is set.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refuseInsidePublic, runtimeBuildId, stagingDir } from "./artifact-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const binDir = path.resolve(arg("bin", ""));
const DEFAULT_LEAN_VERSION = "4.33.0-pre";
const leanVersion = arg("lean-version", null) ?? DEFAULT_LEAN_VERSION;
if (arg("lean-version", null) === null) {
  console.error(
    `chunk-runtime: WARNING — no --lean-version given; the manifest will say Lean ${DEFAULT_LEAN_VERSION}.\n` +
      "  After a version import that is WRONG: the page shows it, and promote-staging refuses a runtime whose\n" +
      "  leanVersion differs from the packs'. Pass --lean-version <x.y.z> (bump-chain.sh: QED64_LEAN_VERSION=<x.y.z>).",
  );
}
// Default the source revision to the fork checkout that (by the pipeline's
// build-then-chunk sequence) produced the binary being chunked, so every
// manifest identifies its exact compiler commit. The upstream base is the
// lean4 commit the qed64-wasm64 branch sits on: 5732b84 for the 4.33.0-pre
// line; a version import passes its own (--upstream-base <tag or sha>). Only
// the default --revision string uses it — an explicit --revision wins.
const UPSTREAM_BASE = arg("upstream-base", "5732b84");
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
  console.error("usage: chunk-runtime.mjs --bin <dir> [--lean-version v] [--revision sha] [--upstream-base sha] [--out dir]");
  process.exit(2);
}
// The default revision describes pipeline/toolchain/work/lean4. For a binary
// built anywhere else (a version import in its own build dir) that checkout
// is NOT the compiler that produced it — say so rather than record it quietly.
if (arg("revision", null) === null && path.relative(path.join(root, "pipeline/toolchain/work"), binDir).startsWith("..")) {
  console.error(
    `chunk-runtime: WARNING — no --revision given for a binary outside pipeline/toolchain/work; sourceRevision will be "${revision}",\n` +
      "  which describes pipeline/toolchain/work/lean4, not this build. Pass --revision \"qed64-wasm64@<built commit> (base <upstream>)\".",
  );
}

const PART = 16 * 1024 * 1024;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const wasmBytes = fs.readFileSync(path.join(binDir, "lean.wasm"));
const buildId = runtimeBuildId(wasmBytes);
// The staging default is keyed by the build so two chunk runs never share a
// tree; an explicit --out inside public/ is refused before anything is written.
const outDir = path.resolve(root, arg("out", stagingDir(root, buildId, "runtime")));
refuseInsidePublic(root, outDir, "chunk-runtime");

// Additive only: content-addressed chunk names cannot collide across builds,
// so an existing chunks/ directory is left exactly as it was (review C6:
// producers never rmSync what a manifest may still reference).
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
// The per-build copy is what `?runtime=<buildId>` and the pinned shell fetch
// (qed64-boot.ts:52/:59); promote installs both names under public/runtime.
fs.writeFileSync(path.join(outDir, `runtime-manifest.${buildId}.json`), JSON.stringify(manifest, null, 2));
console.log(`runtime ${buildId} → ${outDir}`);
