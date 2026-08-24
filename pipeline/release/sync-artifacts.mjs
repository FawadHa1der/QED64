#!/usr/bin/env node
// Provenance-checked artifact sync.
//
// Copies the wasm64 Lean runtime (chunked) and profile packs from a source
// workspace into public/, verifying every part's SHA-256 against the source
// manifests before it is accepted. Nothing is served that was not verified.
//
// Usage:
//   node pipeline/release/sync-artifacts.mjs [--source <dir>] [--profiles core,essential]
//
// Default source: ../wasm64-lean-codex/browser64/public  (relative to repo root)

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const source = path.resolve(root, arg("source", "../../wasm64-lean-codex/browser64/public"));
const wanted = arg("profiles", "core,essential").split(",").map((p) => p.trim()).filter(Boolean);

async function sha256File(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

function stripPrefix(digest) {
  return digest.startsWith("sha256:") ? digest.slice(7) : digest;
}

async function verifiedCopy(from, to, expectedSha, expectedBytes, label) {
  // Verification is mandatory: a manifest that fails to name a digest or a
  // byte length is itself a release error, never a reason to copy blindly.
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error(`${label}: manifest is missing a byte length for ${from}.`);
  }
  if (!/^(sha256:)?[a-f0-9]{64}$/.test(expectedSha || "")) {
    throw new Error(`${label}: manifest is missing a SHA-256 for ${from}.`);
  }
  const bytes = await readFile(from);
  if (bytes.length !== expectedBytes) {
    throw new Error(`${label}: ${from} is ${bytes.length} bytes; manifest says ${expectedBytes}.`);
  }
  const hash = createHash("sha256");
  hash.update(bytes);
  const digest = hash.digest("hex");
  if (digest !== stripPrefix(expectedSha)) {
    throw new Error(`${label}: SHA-256 mismatch for ${from}\n  expected ${expectedSha}\n  actual   sha256:${digest}`);
  }
  await mkdir(path.dirname(to), { recursive: true });
  // Write the bytes that were hashed, not whatever the file contains later.
  await writeFile(to, bytes);
  return bytes.length;
}

async function syncRuntime() {
  const manifestPath = path.join(source, "lean-wasm64/runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let total = 0;
  let parts = 0;
  for (const [name, file] of Object.entries(manifest.files)) {
    // Whole-file identity must be present and self-consistent with the chunks.
    if (!/^[a-f0-9]{64}$/.test(file.sha256 || "") || !Number.isSafeInteger(file.bytes)) {
      throw new Error(`runtime ${name}: manifest missing whole-file identity.`);
    }
    const chunkSum = file.chunks.reduce((sum, c) => sum + c.bytes, 0);
    if (chunkSum !== file.bytes) {
      throw new Error(`runtime ${name}: chunks sum to ${chunkSum}, expected ${file.bytes}.`);
    }
    for (const chunk of file.chunks) {
      const basename = path.basename(new URL(chunk.url, "https://x/").pathname);
      total += await verifiedCopy(
        path.join(source, "lean-wasm64/chunks", basename),
        path.join(root, "public/runtime/chunks", basename),
        chunk.sha256,
        chunk.bytes,
        `runtime ${name}`,
      );
      parts += 1;
    }
  }
  // Rewrite chunk URLs for our layout (/runtime/chunks/...) and persist.
  const rewritten = structuredClone(manifest);
  for (const file of Object.values(rewritten.files)) {
    for (const chunk of file.chunks) {
      chunk.url = `/runtime/chunks/${path.basename(new URL(chunk.url, "https://x/").pathname)}`;
    }
  }
  await mkdir(path.join(root, "public/runtime"), { recursive: true });
  await writeFile(
    path.join(root, "public/runtime/runtime-manifest.json"),
    JSON.stringify(rewritten, null, 2),
  );
  console.log(`runtime  ${manifest.buildId}: ${parts} chunks, ${(total / 1e6).toFixed(1)} MB — all SHA-256 verified`);
  return rewritten;
}

const PROFILE_FILES = { core: "lean-core", essential: "mathlib-essential" };

async function syncProfile(shortName) {
  const base = PROFILE_FILES[shortName];
  if (!base) throw new Error(`Unknown profile '${shortName}'. Known: ${Object.keys(PROFILE_FILES).join(", ")}`);
  const manifestPath = path.join(source, "profiles", `${base}.manifest.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const content = manifest.content;
  let total = 0;
  const rewrittenParts = [];
  for (const part of content.pack.transport.parts) {
    const basename = path.basename(new URL(part.url, "https://x/").pathname);
    total += await verifiedCopy(
      path.join(source, "profiles", basename),
      path.join(root, "public/profiles", basename),
      part.digest,
      part.byteLength,
      `${base} transport`,
    );
    rewrittenParts.push({ ...part, url: `/profiles/${basename}` });
  }
  const rewritten = structuredClone(manifest);
  rewritten.content.pack.transport.parts = rewrittenParts;
  rewritten.content.pack.url = `/profiles/${base}.pack.gzip`;
  await mkdir(path.join(root, "public/profiles"), { recursive: true });
  await writeFile(
    path.join(root, "public/profiles", `${base}.manifest.json`),
    JSON.stringify(rewritten),
  );
  console.log(
    `profile  ${content.release}: ${rewrittenParts.length} parts, ` +
      `${(total / 1e6).toFixed(1)} MB transport, ${Object.keys(content.modules).length} modules — all SHA-256 verified`,
  );
  return { shortName, base, release: content.release, modules: Object.keys(content.modules).length };
}

const runtime = await syncRuntime();
const profiles = [];
for (const p of wanted) profiles.push(await syncProfile(p));

await writeFile(
  path.join(root, "public/profiles/index.json"),
  JSON.stringify(
    {
      schema: "qed64.profile-index/v1",
      runtime: { buildId: runtime.buildId, leanVersion: runtime.leanVersion },
      profiles: profiles.map(({ shortName, base, release, modules }) => ({
        id: shortName,
        manifest: `/profiles/${base}.manifest.json`,
        release,
        modules,
      })),
    },
    null,
    2,
  ),
);
console.log(`index    public/profiles/index.json written (${profiles.length} profiles)`);
