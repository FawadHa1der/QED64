#!/usr/bin/env node
// The JSON and tree work of pipeline/release/adopt-release.sh (plan step B2a),
// one subcommand per job. Node built-ins only; it imports nothing from
// pipeline/ and nothing from lean4-wasm64 (decision 10: the package is called
// as a process, never imported). Not shipped (package.json `files`).
//
//   record     --release <release.json> --id <id> --digest sha256:<hex> --served <dir> [--allow-served] [--init-lib <pack id>]
//              Validate a release record (schema, self-digest, the --id/--digest pin, the fields the
//              adoption uses) and compare it with the served tree <dir> (QED64's public/). Prints one
//              tab-separated line: id digest buildId kernel.patch kernel.commit lean.version mode, where
//              mode is runtime-only (every served pack's raw digest is one of release.packs) or packs-change.
//   confine    --public <dir> --forbid <dir> [--forbid <dir> …]
//              Refuse a --public that is (or lies inside) a forbidden tree once symlinks are resolved,
//              or that holds a symlink whose target leaves it.
//   base-tree  --work <W> --release <release.json> --init-lib <id> --umbrella-source <text> [--fat]
//              Write <W>/base-tree.json: per tree the packs it was unpacked from, the umbrella files it
//              carries (sha256/bytes) and the tree digest (treeDigest below); top-level `umbrella` is the pair.
//   kernel-pin --work <W> --release <release.json> --init-lib <id> --staging <dir>
//              Write <W>/KERNEL-PIN, the generated pin release-manifest.mjs reads.
//
// Every refusal is one stderr line `adopt-release: …` and exit 2.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_SCHEMA = "lean4-wasm64.release/v1";
export const BASE_TREE_SCHEMA = "qed64.base-tree/v1";
export const TREE_DIGEST_RULE = 'sha256 over the lines "<relpath>\\0<sha256 hex>\\n" of every file, relpath /-separated, sorted by byte order';
const UMBRELLA = ["QED64/Essential.olean", "QED64/Essential.olean.server"];

const refuse = (line) => { console.error(`adopt-release: ${line}`); process.exit(2); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const strip = (d) => String(d ?? "").replace(/^sha256:/, "");
const readJson = (file, what) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return refuse(`${what} ${file} is not readable JSON (${e.code ?? e.message})`); }
};

/** releaseDigest of lean4-wasm64 release-record.mjs: sha256 of the record without `digest`, 2-space JSON. */
export function releaseDigest(record) {
  const { digest, ...rest } = record;
  return `sha256:${sha256(JSON.stringify(rest, null, 2))}`;
}

/** Streamed sha256 of one file. */
export function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

/** The tree digest a downstream checks byte identity by (TREE_DIGEST_RULE). Symlinks are refused:
 * an unpacked tree holds regular files only. Returns { digest, files, bytes }. */
export function treeDigest(dir) {
  const lines = [];
  let bytes = 0;
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`${full} is a symlink`);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) { lines.push(`${rel}\0${sha256File(full)}\n`); bytes += fs.statSync(full).size; }
    }
  };
  walk(dir, "");
  lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return { digest: `sha256:${sha256(lines.join(""))}`, files: lines.length, bytes };
}

const inside = (p, dir) => { const r = path.relative(dir, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
/** realpath of the deepest existing ancestor + the remaining segments. */
const realish = (p) => {
  const rest = [];
  let cur = path.resolve(p);
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { rest.unshift(path.basename(cur)); cur = path.dirname(cur); }
  return path.join(fs.realpathSync.native(cur), ...rest);
};

function parse(argv) {
  const out = { _: [], forbid: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--(.+)$/.exec(argv[i]);
    if (!m) { out._.push(argv[i]); continue; }
    if (["allow-served", "fat"].includes(m[1])) { out[m[1]] = true; continue; }
    const v = argv[(i += 1)];
    if (m[1] === "forbid") out.forbid.push(v); else out[m[1]] = v;
  }
  return out;
}

const packsOf = (record) => new Map((record.packs ?? []).map((p) => [p.id, p]));

function record(o) {
  const r = readJson(o.release, "release record");
  if (r?.schema !== RELEASE_SCHEMA) refuse(`release.json schema is ${JSON.stringify(r?.schema)}, not ${RELEASE_SCHEMA}`);
  const self = releaseDigest(r);
  if (r.digest !== self) refuse(`release.json's digest ${r.digest} is not its own content's (${self}) — the record was edited after it was cut`);
  if (r.id !== o.id) refuse(`the release is ${r.id}, --id says ${o.id}`);
  if (r.digest !== o.digest) refuse(`release.json digest is ${r.digest}, --digest pins ${o.digest}`);
  const fields = [
    ["runtime.buildId", r.runtime?.buildId, /^wasm64-[0-9a-f]{16}$/],
    ["kernel.patch", r.kernel?.patch, /^\d{4}[a-z]?$/],
    ["kernel.commit", r.kernel?.commit, /^[0-9a-f]{40}$/],
    ["lean.version", r.lean?.version, /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/],
  ];
  for (const [name, v, re] of fields) if (typeof v !== "string" || !re.test(v)) refuse(`release.json ${name} ${JSON.stringify(v)} is malformed`);
  const packs = packsOf(r);
  for (const id of ["lean-core", "mathlib-essential", o["init-lib"] ?? "lean-lib"]) {
    if (!/^[0-9a-f]{64}$/.test(strip(packs.get(id)?.rawSha256))) refuse(`release.json lists no ${id} pack with a raw sha256`);
  }
  const servedRuntime = path.join(o.served, "runtime/runtime-manifest.json");
  const servedId = readJson(servedRuntime, "served runtime manifest").buildId;
  if (servedId === r.runtime.buildId && !o["allow-served"]) {
    refuse(`the release's runtime ${servedId} IS the served runtime (${servedRuntime}) — nothing to adopt; a rehearsal passes --allow-served`);
  }
  // Runtime-only: every pack the served index lists is one of the release's, by raw digest.
  const raw = new Set([...packs.values()].map((p) => strip(p.rawSha256)));
  const indexFile = path.join(o.served, "profiles/index.json");
  const served = fs.existsSync(indexFile) ? readJson(indexFile, "served profile index").profiles ?? [] : [];
  const same = served.length > 0 && served.every((e) => {
    const file = path.join(o.served, "profiles", path.basename(String(e.manifest)));
    return fs.existsSync(file) && raw.has(strip(readJson(file, "served pack manifest").content?.pack?.digest));
  });
  console.log([r.id, r.digest, r.runtime.buildId, r.kernel.patch, r.kernel.commit, r.lean.version, same ? "runtime-only" : "packs-change"].join("\t"));
}

function confine(o) {
  if (!o.public) refuse("confine: no --public");
  const pub = path.resolve(o.public);
  if (!fs.existsSync(pub) || !fs.statSync(pub).isDirectory()) {
    refuse(`--public ${pub} is not a directory — fill an isolated served tree first: npm run -s fetch:artifacts -- --out ${pub} --with-manifests`);
  }
  const real = fs.realpathSync.native(pub);
  for (const f of o.forbid) {
    const fr = realish(f);
    if (inside(real, fr)) refuse(`--public ${pub} resolves to ${real}, inside ${fr} — adopt into an ISOLATED served tree, never a checkout's public/`);
  }
  const escapes = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        const target = realish(path.resolve(d, fs.readlinkSync(full)));
        if (!inside(target, real)) escapes.push(`${path.relative(pub, full)} -> ${target}`);
      } else if (e.isDirectory()) walk(full);
    }
  };
  walk(real);
  if (escapes.length) refuse(`--public ${pub} holds ${escapes.length} symlink(s) leaving the tree (first: ${escapes[0]}) — a promote would write through them`);
}

function baseTree(o) {
  const r = readJson(o.release, "release record");
  const packs = packsOf(r);
  const pack = (id) => ({ id, release: packs.get(id)?.release ?? null, rawSha256: `sha256:${strip(packs.get(id)?.rawSha256)}` });
  const work = path.resolve(o.work);
  const umbrella = UMBRELLA.map((p) => {
    const file = path.join(work, "lib-tree-slim", p);
    if (!fs.existsSync(file)) refuse(`base-tree: ${file} is absent`);
    return { path: p, sha256: sha256File(file), bytes: fs.statSync(file).size };
  });
  const trees = {};
  const add = (name, slim, ids, withUmbrella) => {
    const dir = path.join(work, name);
    if (!fs.existsSync(dir)) refuse(`base-tree: ${dir} is absent`);
    let d;
    try { d = treeDigest(dir); } catch (e) { refuse(`base-tree: ${e.message}`); }
    // The umbrella files this tree carries: the pair, and in a fat tree Essential.olean.private when its source had one.
    const umbrellaFiles = withUmbrella
      ? fs.readdirSync(path.join(dir, "QED64")).sort().map((f) => ({ path: `QED64/${f}`, sha256: sha256File(path.join(dir, "QED64", f)), bytes: fs.statSync(path.join(dir, "QED64", f)).size }))
      : [];
    trees[name] = { slim, packs: ids.map(pack), umbrella: umbrellaFiles, files: d.files, bytes: d.bytes, digest: d.digest };
  };
  add("core-lib-slim", true, [o["init-lib"]], false);
  add("lib-tree-slim", true, ["lean-core", "mathlib-essential"], true);
  if (o.fat) add("lib-tree", false, ["lean-core", "mathlib-essential"], true);
  const doc = {
    schema: BASE_TREE_SCHEMA,
    releaseId: r.id,
    releaseDigest: r.digest,
    runtime: r.runtime.buildId,
    packs: ["lean-core", "mathlib-essential"].map(pack),
    slim: true,
    umbrella,
    umbrellaSource: o["umbrella-source"] ?? null,
    initLib: o["init-lib"],
    digestRule: TREE_DIGEST_RULE,
    trees,
  };
  fs.writeFileSync(path.join(work, "base-tree.json"), `${JSON.stringify(doc, null, 2)}\n`);
  for (const [name, t] of Object.entries(trees)) console.log(`base-tree ${name}: ${t.files} files, ${t.bytes} bytes, ${t.digest}`);
}

function kernelPin(o) {
  const r = readJson(o.release, "release record");
  const work = path.resolve(o.work);
  const size = (f) => (fs.existsSync(path.join(work, "snapshot", f)) ? fs.statSync(path.join(work, "snapshot", f)).size : "?");
  const packs = packsOf(r);
  const packLine = ["lean-core", "mathlib-essential", o["init-lib"]].filter((v, i, a) => a.indexOf(v) === i)
    .map((id) => `${id} ${strip(packs.get(id)?.rawSha256).slice(0, 8)}… (${packs.get(id)?.rawBytes} B)`).join(", ");
  const text = [
    `${r.kernel.commit}  qed64-wasm64 @ FawadHa1der/lean4`,
    `# GENERATED by pipeline/release/adopt-release.sh from the lean4-wasm64 release ${r.id}; do not edit by hand.`,
    `# Lean ${r.lean.version}, kernel patch ${r.kernel.patch}, tools lean4-wasm64 ${r.tools?.version ?? "?"} (docs/REBUILD.md §3).`,
    "#",
    "# Paired build identity (snapshots are binary-paired to this runtime; served together or not at all):",
    `#   release        ${r.id} ${r.digest}`,
    `#   runtime        ${r.runtime.buildId} (sha256[:16] of bin/lean.wasm, ${r.runtime.files?.["lean.wasm"]?.bytes} bytes)`,
    `#   mathlib.snap   ${size("mathlib.snap")} bytes raw (probe: import QED64.Essential, lib-tree-slim)`,
    `#   init.snap      ${size("init.snap")} bytes raw (lib: core-lib-slim, unpacked --slim from ${o["init-lib"]})`,
    `#   packs          ${packLine}`,
    `#   staging        ${o.staging}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(work, "KERNEL-PIN"), text);
  console.log(`KERNEL-PIN → ${path.join(work, "KERNEL-PIN")} (kernel ${r.kernel.commit.slice(0, 12)}, runtime ${r.runtime.buildId})`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parse(rest);
  const jobs = { record, confine, "base-tree": baseTree, "kernel-pin": kernelPin };
  if (!jobs[cmd]) refuse(`adopt-helper: unknown subcommand ${JSON.stringify(cmd)} (${Object.keys(jobs).join(", ")})`);
  jobs[cmd](o);
}
