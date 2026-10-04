#!/usr/bin/env node
// Reconstruct an on-disk olean tree from a profile's verified transport parts.
//
// Streams the gzip parts (verifying each SHA-256), inflates to the raw pack in
// memory, then writes every WORKERFS entry as a real file. Used by the
// snapshot-baking pipeline, which needs Lean's library as a filesystem.
//
// Usage: node pipeline/artifacts/unpack.mjs --manifest <file> --out <dir>
// (--help; the contract is docs/CLI-CONTRACT.md)

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

// <cli-contract> generated from SPECS["unpack"] in pipeline/snapshot/cli.mjs. Do not edit:
// `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts
// fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.
// It runs before any side effect: --help/-h prints the help and exits 0, a missing required
// flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and
// --flag=value is rewritten to the two-token form this script reads (docs/CLI-CONTRACT.md).
{
  const spec = {"tool":"unpack","usage":"unpack.mjs --manifest <file> --out <dir>","flags":{"manifest":1,"out":1},"required":[["manifest"],["out"]],"passthrough":null,"passthroughRequired":false};
  spec.help = [
    "usage: unpack.mjs --manifest <file> --out <dir>",
    "Reconstruct an on-disk olean tree from a profile's verified transport parts (each part and the raw pack sha256-checked), for the Node-side bakes.",
    "run as: node pipeline/artifacts/unpack.mjs",
    "",
    "flags:",
    "  --manifest <file>  a profile manifest; its parts are read from the same directory by basename [required]",
    "  --out <dir>        the tree to write (files are added or overwritten, never deleted) [required]",
    "  -h, --help         print this help and exit 0, before any side effect",
    "",
    "exit codes:",
    "  0  unpacked",
    "  1  a part, the raw pack or a path failed verification (or the manifest is unreadable)",
    "  2  usage",
    "",
    "tier 2 (internal-stable). Contract: docs/CLI-CONTRACT.md",
  ].join("\n");
  const args = process.argv.slice(2);
  const normalized = (function cliContract(spec, args, io = { out: (s) => console.log(s), err: (s) => console.error(s), exit: (c) => process.exit(c) }) {
    const values = {};
    const warnings = [];
    const normalized = [];
    let passthrough = [];
    let help = false;
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i];
      if (token === "--help" || token === "-h") { help = true; continue; }
      if (token === "--" && spec.passthrough) { passthrough = args.slice(i + 1); normalized.push(...args.slice(i)); break; }
      const m = /^--([^=]+)(=[\s\S]*)?$/.exec(token);
      const arity = m && Object.hasOwn(spec.flags, m[1]) ? spec.flags[m[1]] : -1;
      if (arity < 0 || (arity === 0 && m[2] !== undefined)) {
        if (spec.passthrough === "implicit") { passthrough = args.slice(i); normalized.push(...passthrough); break; }
        warnings.push(token.startsWith("-") ? `unknown flag ${token} ignored` : `unexpected argument ${token} ignored`);
        normalized.push(token);
        continue;
      }
      const name = m[1];
      let value = true;
      if (arity === 1) {
        value = m[2] !== undefined ? m[2].slice(1) : i + 1 < args.length ? args[(i += 1)] : undefined;
        if (value === "--help" || value === "-h") help = true;
        normalized.push(`--${name}`, ...(value === undefined ? [] : [value]));
        if (!value) warnings.push(`flag --${name} has no value; ignored`);
      } else normalized.push(token);
      if (!Object.hasOwn(values, name)) values[name] = value ?? "";
      else if (arity === 1) warnings.push(`flag --${name} repeated; the first value wins`);
    }
    if (help) { io.out(spec.help); io.exit(0); return null; }
    for (const w of warnings) io.err(`${spec.tool}: WARNING — ${w}`);
    for (const name of Object.keys(values)) if (values[name] === "") delete values[name];
    const missing = (spec.required || []).some((group) => !group.some((name) => Object.hasOwn(values, name)));
    if (missing || (spec.passthroughRequired && passthrough.length === 0)) { io.err(`usage: ${spec.usage}`); io.exit(2); return null; }
    return { values, passthrough, args: normalized };
  })(spec, args)?.args ?? args;
  if (normalized.join("\0") !== args.join("\0")) process.argv.splice(2, args.length, ...normalized);
}
// </cli-contract>

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
