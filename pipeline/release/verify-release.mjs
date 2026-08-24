#!/usr/bin/env node
// Out-of-band release verification: recompute every digest the browser trusts.
//
// The in-browser installer verifies transport parts (streaming) but cannot
// stream-digest the multi-GB raw pack; this job closes that gap by inflating
// each published profile and recomputing the raw pack digest, plus the
// runtime chunk/whole digests. Run before every deploy.
//
// Usage: node pipeline/release/verify-release.mjs [--public <dir>]

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const publicDir = path.resolve(root, arg("public", "public"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const strip = (d) => (d.startsWith("sha256:") ? d.slice(7) : d);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};

// Runtime chunks + wholes
const runtime = JSON.parse(fs.readFileSync(path.join(publicDir, "runtime/runtime-manifest.json"), "utf8"));
for (const [name, file] of Object.entries(runtime.files)) {
  const whole = createHash("sha256");
  let bytes = 0;
  let chunksOk = true;
  for (const chunk of file.chunks) {
    const p = path.join(publicDir, chunk.url.replace(/^\//, ""));
    const data = fs.readFileSync(p);
    if (data.length !== chunk.bytes || sha256(data) !== chunk.sha256) chunksOk = false;
    whole.update(data);
    bytes += data.length;
  }
  check(chunksOk, `${name}: ${file.chunks.length} chunks`);
  check(bytes === file.bytes && whole.digest("hex") === file.sha256, `${name}: whole-file digest`);
}

// Profiles: stream-inflate and digest the raw pack
const index = JSON.parse(fs.readFileSync(path.join(publicDir, "profiles/index.json"), "utf8"));
for (const profile of index.profiles) {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, profile.manifest.replace(/^\//, "")), "utf8"));
  const { pack } = manifest.content;
  const gunzip = createGunzip();
  const rawHash = createHash("sha256");
  let rawBytes = 0;
  gunzip.on("data", (d) => {
    rawHash.update(d);
    rawBytes += d.length;
  });
  const feed = (async function* () {
    for (const part of pack.transport.parts) {
      const p = path.join(publicDir, part.url.replace(/^\//, ""));
      const data = fs.readFileSync(p);
      if (data.length !== part.byteLength || sha256(data) !== strip(part.digest)) {
        throw new Error(`transport part ${part.url} failed verification`);
      }
      yield data;
    }
  })();
  try {
    await pipeline(feed, gunzip);
    check(rawBytes === pack.byteLength, `${profile.id}: raw pack length ${pack.byteLength}`);
    check(rawHash.digest("hex") === strip(pack.digest), `${profile.id}: raw pack digest`);
  } catch (error) {
    check(false, `${profile.id}: ${error.message}`);
  }
}

console.log(failures === 0 ? "\nRELEASE VERIFIED" : `\nRELEASE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
