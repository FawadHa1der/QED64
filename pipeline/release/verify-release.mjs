#!/usr/bin/env node
// Out-of-band release verification: recompute the served runtime's and
// profiles' digests (the snapshots' are not checked here).
//
// Before D1 the in-browser installer verified transport parts (streaming) but
// could not stream-digest the multi-GB raw pack, and this job closed that gap.
// It still inflates each published profile and recomputes its part and raw
// pack digests, plus the runtime chunk/whole digests (over the inflated parts
// for a v2 gzip runtime), and checks that the profile index is paired with
// the served runtime. Run before every deploy.
//
// Usage: node pipeline/release/verify-release.mjs [--public <dir>]

import { createHash } from "node:crypto";
import { createGunzip, gunzipSync } from "node:zlib";
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

// Runtime chunks + wholes. A v2 runtime (org.lean-browser64.runtime/v2, the
// fork's formats/runtime-manifest.md) names each file's encoding, gzip or
// identity: a gzip file's parts are gzip members, each of one decoded slice.
// A part's bytes/sha256 are as served; its decodedBytes, and the file's
// bytes/sha256, are over the inflated bytes. Every part but the last decodes
// to exactly 16 MiB (the v1 chunk size). An absent schema is v1. Built-ins
// only: lean4game vendors this file.
const RUNTIME_V1 = "org.lean-browser64.runtime/v1";
const RUNTIME_V2 = "org.lean-browser64.runtime/v2";
/** The file encodings each runtime manifest schema allows, a closed set (absent: identity in v1, refused in v2). */
const RUNTIME_ENCODINGS = { [RUNTIME_V1]: ["identity"], [RUNTIME_V2]: ["identity", "gzip"] };
/** A v2 part's decoded size, every part but the last (the v1 chunk size). */
const DECODED_SLICE = 16 * 1024 * 1024;
/** Why a file's encoding or parts break its schema's rules, or null. */
function runtimeFileFault(schema, file) {
  const allowed = RUNTIME_ENCODINGS[schema];
  if (!allowed) return `schema ${schema} is not one this tool reads`;
  const encoding = file.encoding ?? (schema === RUNTIME_V1 ? "identity" : undefined);
  if (!allowed.includes(encoding)) return `encoding ${encoding === undefined ? "(none)" : JSON.stringify(encoding)} is not one ${schema} allows (${allowed.join(", ")})`;
  if (schema !== RUNTIME_V2) return null;
  let sum = 0;
  for (const [i, c] of file.chunks.entries()) {
    const d = c.decodedBytes;
    if (!Number.isSafeInteger(d) || d <= 0) return `chunk ${i} has no usable decodedBytes (${JSON.stringify(d) ?? "none"})`;
    if (i < file.chunks.length - 1 ? d !== DECODED_SLICE : d > DECODED_SLICE) return `chunk ${i} decodes to ${d} bytes; every part but the last decodes to exactly ${DECODED_SLICE}, the last to at most that`;
    if (encoding === "identity" && d !== c.bytes) return `chunk ${i} is identity-encoded, but its decodedBytes ${d} is not its bytes ${c.bytes}`;
    sum += d;
  }
  return sum === file.bytes ? null : `its parts decode to ${sum} bytes, the file is ${file.bytes}`;
}
const runtime = JSON.parse(fs.readFileSync(path.join(publicDir, "runtime/runtime-manifest.json"), "utf8"));
const schema = runtime.schema ?? RUNTIME_V1;
check(Object.hasOwn(RUNTIME_ENCODINGS, schema), `runtime manifest: schema ${schema}`);
for (const [name, file] of Object.entries(runtime.files)) {
  const v2 = schema === RUNTIME_V2;
  const gzip = v2 && file.encoding === "gzip";
  const fault = runtimeFileFault(schema, file);
  check(!fault, `${name}: ${fault ?? `encoding ${file.encoding ?? "identity"}${v2 ? `, parts decode to ${file.bytes} bytes in ${DECODED_SLICE}-byte slices` : ""}`}`);
  const whole = createHash("sha256");
  let bytes = 0;
  let chunksOk = true;
  for (const chunk of file.chunks) {
    const p = path.join(publicDir, chunk.url.replace(/^\//, ""));
    const data = fs.readFileSync(p);
    const served = data.length === chunk.bytes && sha256(data) === chunk.sha256;
    if (!served) chunksOk = false;
    // A gzip part is inflated only once it is verified as served: the inflater never sees an unverified byte.
    let decoded = data;
    if (gzip) {
      try { decoded = served ? gunzipSync(data) : Buffer.alloc(0); } catch { chunksOk = false; decoded = Buffer.alloc(0); }
    }
    if (v2 && decoded.length !== chunk.decodedBytes) chunksOk = false;
    whole.update(decoded);
    bytes += decoded.length;
  }
  check(chunksOk, `${name}: ${file.chunks.length} chunks`);
  check(bytes === file.bytes && whole.digest("hex") === file.sha256, `${name}: whole-file digest`);
}

// Profile index ↔ runtime. `runtime` in profiles/index.json names the runtime
// the profiles are SERVED with; promote-staging.mjs owns it and re-points it
// on every promote (kernel-only bumps included), switching it LAST — so an
// index that names another runtime is either an interrupted promote or a
// runtime that was put in public/ some other way. The Lean version is the
// part with teeth: oleans are only readable by the Lean version that wrote
// them, and the runtime does not check (githash gate off, REBUILD.md §2).
const index = JSON.parse(fs.readFileSync(path.join(publicDir, "profiles/index.json"), "utf8"));
check(index.schema === "qed64.profile-index/v1", `profile index: schema ${index.schema}`);
check(index.runtime?.buildId === runtime.buildId,
  `profile index: runtime ${index.runtime?.buildId ?? "(none)"} is the served runtime ${runtime.buildId}` +
    (index.runtime?.buildId === runtime.buildId ? "" : " — rerun promote-staging (it re-points the index)"));
check(index.runtime?.leanVersion === runtime.leanVersion,
  `profile index: Lean ${index.runtime?.leanVersion ?? "(none)"} is the served runtime's Lean ${runtime.leanVersion}`);

// Profiles: stream-inflate and digest the raw pack
for (const profile of index.profiles) {
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, profile.manifest.replace(/^\//, "")), "utf8"));
  const { pack } = manifest.content;
  check(manifest.content.lean?.version === runtime.leanVersion,
    `${profile.id}: packed for Lean ${manifest.content.lean?.version ?? "(none)"}, served runtime is Lean ${runtime.leanVersion}`);
  check(profile.release === manifest.content.release && profile.modules === Object.keys(manifest.content.modules ?? {}).length,
    `${profile.id}: index entry (${profile.release}, ${profile.modules} modules) describes its manifest`);
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
