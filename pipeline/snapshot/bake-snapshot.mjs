#!/usr/bin/env node
// Bake an environment snapshot with the exact wasm64 runtime under Node.
//
// Snapshots embed closure relocations keyed to the producing binary's function
// table ("wasm-main" pseudo-library), so they MUST be baked by the same
// lean.js/lean.wasm the browser runs. The app preloads the result to replace
// the first import with a seconds-long region load.
//
// Usage: node pipeline/snapshot/bake-snapshot.mjs [--name init] [--probe '#check 2+2'] [--artifact <dir>] [--lib <olean tree>] [--reserve <bytes>] [--out <dir>]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const name = arg("name", "init");
const probe = arg("probe", "#check (2 + 2 : Nat)");
const work = path.join(root, "work/snapshot");
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, "probe.lean"), `${probe}\n`);

const runnerArgs = [
  path.join(root, "pipeline/snapshot/node-runner.mjs"),
  "--work", work,
];
const artifact = arg("artifact", null);
if (artifact) runnerArgs.push("--artifact", artifact);
const lib = arg("lib", null);
if (lib) runnerArgs.push("--lib", lib);
runnerArgs.push("--", `--incr-header-save=/work/${name}.snap`, "/work/probe.lean");

// Reserve the compactor's output buffer in one allocation: a whole-Mathlib
// environment compacts to >2 GiB, and growth-by-doubling would need the old
// and new buffers to coexist — more than the 16 GiB wasm64 space holds next
// to the environment itself (toolchain patch 0011).
const reserve = arg("reserve", String(3.5 * 1024 ** 3));
console.log(`baking ${name}.snap (probe: ${JSON.stringify(probe)}; compactor reserve ${(Number(reserve) / 1024 ** 3).toFixed(1)} GiB) …`);
execFileSync("node", ["--stack-size=8192", ...runnerArgs], {
  stdio: "inherit",
  env: { ...process.env, LEAN_COMPACTOR_RESERVE: reserve },
});

const snap = path.join(work, `${name}.snap`);
if (!fs.existsSync(snap)) {
  console.error("FAIL: snapshot file was not produced");
  process.exit(1);
}
const out = path.resolve(root, arg("out", "public/snapshots"));
fs.mkdirSync(out, { recursive: true });
try { fs.rmSync(`${snap}.deps`); } catch {}
const snapBytes = fs.statSync(snap).size;

// Serve gzip: region dumps compress ~2×, and the worker inflates through
// DecompressionStream. Only the .gz is published.
console.log(`compressing ${name}.snapz …`);
// `.snapz`, not `.gz`: a recognised gzip extension makes servers add Content-Encoding
// and the browser pre-inflates, defeating the worker's compressed OPFS cache.
// The published name is CONTENT-ADDRESSED (`<name>.<digest16>.snapz`):
// snapshots are binary-paired to the runtime, and a rebuilt runtime produces
// a region of the *identical raw size* (same env content, different
// relocation values) — so a fixed name behind immutable HTTP caching let a
// stale snapshot pass every size check and trap "memory access out of
// bounds" against the new binary. The digest in the URL makes immutable
// caching correct.
const tmpPath = path.join(out, `${name}.snapz.tmp`);
const hasher = createHash("sha256");
await pipeline(
  fs.createReadStream(snap),
  createGzip({ level: 6 }),
  async function* (chunks) { for await (const c of chunks) { hasher.update(c); yield c; } },
  fs.createWriteStream(tmpPath),
);
const digest = hasher.digest("hex");
const gzName = `${name}.${digest.slice(0, 16)}.snapz`;
const gzPath = path.join(out, gzName);
fs.renameSync(tmpPath, gzPath);
// Supersede any raw-served copy and every older bake of this logical name.
try { fs.rmSync(path.join(out, `${name}.snap`)); } catch {}
for (const f of fs.readdirSync(out)) {
  if (f !== gzName && (f === `${name}.snapz` || new RegExp(`^${name}\\.[0-9a-f]{16}\\.snapz$`).test(f))) {
    fs.rmSync(path.join(out, f));
  }
}
const transferBytes = fs.statSync(gzPath).size;

// Upsert the snapshot index the app consumes: each entry records the ORDERED
// header imports its environment was baked for (the runtime keys its env
// cache by exactly that list; empty = the default no-import header).
const importsOf = (source) => {
  const found = [];
  for (const line of source.split("\n")) {
    const m = /^(?:public\s+|private\s+)?(?:meta\s+)?import\s+([A-Za-z_][\w.«»]*)/.exec(line.trim());
    if (m) found.push(m[1]);
  }
  return found;
};
const indexPath = path.join(out, "index.json");
let index = { schema: "qed64.snapshot-index/v1", snapshots: [] };
try { index = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch {}
const entry = {
  name,
  url: `/snapshots/${gzName}`,
  digest: `sha256:${digest}`,
  bytes: snapBytes,
  transfer: transferBytes,
  imports: importsOf(probe),
};
index.snapshots = index.snapshots.filter((s) => s.name !== name).concat([entry]);
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
console.log(
  `baked ${gzPath} (${transferBytes} bytes transfer, ${snapBytes} raw); ` +
    `index updated (imports: [${entry.imports.join(", ")}])`,
);
