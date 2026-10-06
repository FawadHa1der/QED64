#!/usr/bin/env node
// The release bundle (plan step B2c, docs/RELEASE-BUNDLE.md "The bundle"): the
// files a downstream pins one QED64 release by, written into one directory.
//
//   release.json              qed64.release/v1 of the commit, with the shell section (release-manifest.mjs)
//   qed64-shell.tar.gz        the built dist/ (every file, qed64-build.json included)
//   qed64-manifests.tar.gz    the tracked digest roots, from the commit's git objects:
//                             toolchain/lean4-wasm64-release.json, embedding/base-tree.json,
//                             public/runtime/runtime-manifest.json, public/snapshots/index.json,
//                             public/profiles/*.json
//   umbrella/QED64/…          the umbrella files base-tree.json names (release.json baseTree.umbrellaFiles),
//                             each checked against its sha256 and size; their bytes are not tracked in git
//   SHA256SUMS                `<sha256>  <path>` of every other file, byte-ordered (what `shasum -a 256` prints)
//
// REPRODUCIBLE: the same commit, dist/ and umbrella bytes give the same bytes on
// any machine. The tars are written here, not by a tar binary (macOS bsdtar has
// no --sort=name): ustar, entries byte-ordered by name, directories included,
// mtime = the commit time (`git show -s --format=%ct`), uid/gid 0, empty
// uname/gname, mode 0644 (0755 for directories). gzip is node:zlib level 9 with
// the header pinned (mtime 0, OS byte 0x03), as the fork's pack.mjs pins it;
// deflate itself is a function of the zlib build, so the tar stream (the
// gunzipped bytes) is the identity to compare across Node builds.
//
// Node built-ins and ./release-manifest.mjs only; lean4-wasm64 is not imported
// (decision 10). Not shipped in the package (it needs a QED64 checkout).
//
// Exit: 0 written · 1 refused (one line on stderr: anything release-manifest
// refuses, a dist/ whose qed64-build.json is not a clean build of the commit,
// a shell or umbrella file that does not match, an unwritable --out)
// · 2 usage, or an --out that exists and is not an empty directory.
//
// Usage: node pipeline/release/write-bundle.mjs --help
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import {
  BUILD_INFO_FILE,
  INPUTS,
  ReleaseRefusal,
  buildReleaseManifest,
  commitSource,
  serializeManifest,
} from "./release-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const USAGE = `usage: node pipeline/release/write-bundle.mjs [--commit <rev>] --dist <dir> --umbrella <dir> --out <dir> [--repo <dir>]

Writes the release bundle of one commit into --out (docs/RELEASE-BUNDLE.md, "The bundle"):
release.json, qed64-shell.tar.gz, qed64-manifests.tar.gz, umbrella/QED64/…, SHA256SUMS.

  --commit <rev>    the commit whose tracked inputs are read (git objects only)   [default: HEAD]
  --dist <dir>      the built shell (npm run build:site; artifacts pruned)        (required)
  --umbrella <dir>  a directory holding QED64/Essential.olean* (a base tree's root, e.g. work/adopt/<id>/lib-tree) (required)
  --out <dir>       the bundle directory; absent or empty, written atomically     (required)
  --repo <dir>      the QED64 git checkout                                        [default: the checkout this script is in]
  --help            this text (reads and writes nothing)

exit: 0 written · 1 refused (one-line reason on stderr) · 2 usage error, or --out exists and is not empty`;

export const BUNDLE_FILES = Object.freeze({
  release: "release.json",
  shell: "qed64-shell.tar.gz",
  manifests: "qed64-manifests.tar.gz",
  umbrellaDir: "umbrella",
  sums: "SHA256SUMS",
});

const refuse = (why) => { throw new ReleaseRefusal(why); };
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

// ------------------------------------------------------------------ ustar --
const BLOCK = 512;

function octal(value, width) {
  // width-1 octal digits, zero-padded, then NUL (the POSIX numeric field form).
  const digits = value.toString(8);
  if (digits.length > width - 1) refuse(`tar: ${value} does not fit a ${width}-byte field`);
  return `${digits.padStart(width - 1, "0")}\0`;
}

/** Split a name into ustar's prefix (≤155) and name (≤100) at a "/". */
function splitName(name) {
  const bytes = Buffer.byteLength(name);
  if (bytes <= 100) return { prefix: "", name };
  for (let i = name.lastIndexOf("/", name.length - 2); i > 0; i = name.lastIndexOf("/", i - 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { prefix, name: rest };
  }
  return refuse(`tar: ${name} is too long for a ustar header (100 + 155 bytes)`);
}

function header({ name, size, mtime, dir }) {
  const h = Buffer.alloc(BLOCK, 0);
  const put = (text, offset, width) => {
    const b = Buffer.from(text, "utf8");
    if (b.length > width) refuse(`tar: field ${JSON.stringify(text)} is longer than ${width} bytes`);
    b.copy(h, offset);
  };
  const split = splitName(name);
  put(split.name, 0, 100);
  put(octal(dir ? 0o755 : 0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8); // uid
  put(octal(0, 8), 116, 8); // gid
  put(octal(dir ? 0 : size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  put(dir ? "5" : "0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  // uname (265), gname (297): empty; devmajor/devminor (329, 337): zero
  put(octal(0, 8), 329, 8);
  put(octal(0, 8), 337, 8);
  put(split.prefix, 345, 155);
  let sum = 0;
  for (const byte of h) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

/**
 * A ustar archive of `files` (Map relpath → bytes; "/"-separated, no "." or
 * ".." segments), with an entry for every directory they lie in, every entry
 * byte-ordered by its name (directories as "<dir>/").
 */
export function tarOf(files, mtime) {
  const entries = new Map();
  for (const [rel, bytes] of files) {
    if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) refuse(`tar: ${JSON.stringify(rel)} is not a relative path`);
    entries.set(rel, bytes);
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i += 1) entries.set(`${parts.slice(0, i).join("/")}/`, null);
  }
  const blocks = [];
  for (const name of [...entries.keys()].sort(byteOrder)) {
    const bytes = entries.get(name);
    if (bytes === null) {
      blocks.push(header({ name, size: 0, mtime, dir: true }));
      continue;
    }
    blocks.push(header({ name, size: bytes.length, mtime, dir: false }), bytes);
    const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (pad) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(2 * BLOCK, 0));
  return Buffer.concat(blocks);
}

/** gzip with the header pinned: mtime 0 (bytes 4-7), OS 0x03 (byte 9), whatever the platform's zlib writes. */
export function gzipPinned(bytes) {
  const gz = Buffer.from(zlib.gzipSync(bytes, { level: 9 }));
  gz.writeUInt32LE(0, 4);
  gz[9] = 0x03;
  return gz;
}

// ----------------------------------------------------------------- bundle --
function walkFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
    else refuse(`${path.join(dir, rel)} is not a regular file or directory (symlink?)`);
  }
  return out;
}

/**
 * Build the bundle in memory: Map of bundle path → bytes (SHA256SUMS last),
 * plus the manifest. Throws ReleaseRefusal on any mismatch; reads `dist`,
 * `umbrella` and the source, writes nothing.
 */
export function buildBundle(source, { dist, umbrella }) {
  const manifest = buildReleaseManifest(source, { dist });
  const { commit, committedAt } = manifest.qed64;
  const mtime = Math.floor(Date.parse(committedAt) / 1000);
  if (!Number.isSafeInteger(mtime) || mtime < 0) refuse(`the commit time ${committedAt} of ${commit.slice(0, 7)} is not a tar mtime`);

  // The shell: every dist file, each the bytes release.json names (re-read here, so compared).
  const shellFiles = new Map(walkFiles(dist).sort(byteOrder).map((rel) => [rel, fs.readFileSync(path.join(dist, rel))]));
  // ... and built from exactly this commit, clean (frontend/build/build-info.mjs
  // stamps both): a bundle is a pure function of its commit, so it never ships
  // a shell another commit or uncommitted edits made.
  let info = null;
  try { info = JSON.parse(shellFiles.get(BUILD_INFO_FILE)?.toString("utf8") ?? "null"); } catch { /* refused below */ }
  if (!info) refuse(`--dist has no readable ${BUILD_INFO_FILE} — rebuild at ${commit.slice(0, 7)} (npm run build:site)`);
  if (info.commit !== commit || info.dirty !== false) {
    const built = typeof info.commit === "string" ? info.commit.slice(0, 7) : String(info.commit);
    refuse(`--dist was built from ${built}${info.dirty === false ? "" : ` (dirty: ${JSON.stringify(info.dirty)})`} — rebuild at ${commit.slice(0, 7)} from a clean checkout`);
  }
  const named = new Map(manifest.shell.files.map((f) => [f.path, f]));
  for (const [rel, bytes] of shellFiles) {
    if (rel === BUILD_INFO_FILE) continue;
    const f = named.get(rel);
    if (!f || f.sha256 !== sha256Hex(bytes) || f.bytes !== bytes.length) refuse(`--dist: ${rel} changed while the bundle was written (release.json names other bytes)`);
  }
  if (shellFiles.size - (shellFiles.has(BUILD_INFO_FILE) ? 1 : 0) !== named.size) refuse("--dist: files changed while the bundle was written");

  // The tracked digest roots, from the source (git objects for --commit).
  const manifestPaths = [INPUTS.toolchainRecord, INPUTS.baseTree, INPUTS.runtimeManifest, INPUTS.snapshotIndex,
    ...source.list("public/profiles").filter((rel) => !rel.includes("/") && rel.endsWith(".json")).map((rel) => `public/profiles/${rel}`)];
  const blobs = new Map([
    [INPUTS.toolchainRecord, manifest.toolchain.record],
    [INPUTS.baseTree, { sha256: manifest.baseTree.sha256 }],
    [INPUTS.runtimeManifest, manifest.runtime.manifest],
    [INPUTS.snapshotIndex, manifest.snapshots.index],
    [INPUTS.profileIndex, manifest.profiles.index],
    ...manifest.profiles.packs.map((p) => [`public/${p.manifest.path}`, p.manifest]),
  ]);
  const roots = new Map();
  for (const repoPath of manifestPaths) {
    const bytes = source.read(repoPath);
    if (bytes === null) refuse(`${repoPath} is not in ${source.label}`);
    const want = blobs.get(repoPath);
    if (want && want.sha256 !== sha256Hex(bytes)) refuse(`${repoPath} is not the bytes release.json names`);
    roots.set(repoPath, bytes);
  }

  // The umbrella files, verified against base-tree.json (via release.json).
  const umbrellaFiles = new Map();
  for (const u of manifest.baseTree.umbrellaFiles) {
    const file = path.join(umbrella, u.path);
    let bytes;
    try { bytes = fs.readFileSync(file); } catch (e) { refuse(`--umbrella: ${file} is not readable (${e.code ?? e.message}) — base-tree.json names ${u.path}`); }
    if (bytes.length !== u.bytes || sha256Hex(bytes) !== u.sha256) {
      refuse(`--umbrella: ${u.path} is ${sha256Hex(bytes).slice(0, 16)}… (${bytes.length} B), base-tree.json names ${u.sha256.slice(0, 16)}… (${u.bytes} B) — not the umbrella the base trees carry`);
    }
    umbrellaFiles.set(`${BUNDLE_FILES.umbrellaDir}/${u.path}`, bytes);
  }

  const out = new Map([
    [BUNDLE_FILES.release, Buffer.from(serializeManifest(manifest))],
    [BUNDLE_FILES.shell, gzipPinned(tarOf(shellFiles, mtime))],
    [BUNDLE_FILES.manifests, gzipPinned(tarOf(roots, mtime))],
    ...umbrellaFiles,
  ]);
  const sums = [...out.keys()].sort(byteOrder).map((rel) => `${sha256Hex(out.get(rel))}  ${rel}\n`).join("");
  out.set(BUNDLE_FILES.sums, Buffer.from(sums));
  return { manifest, files: out };
}

class UsageError extends Error {}
class OutExists extends Error {}

/** Throws OutExists unless `out` is absent or an empty directory. */
function checkOut(target) {
  let st = null;
  try { st = fs.lstatSync(target); } catch { return; }
  if (!st.isDirectory() || fs.readdirSync(target).length > 0) throw new OutExists(`--out ${target} exists and is not an empty directory`);
}

/** Write the bundle's files into a sibling temp dir, then rename it to `out`. */
export function writeBundleDir(files, out) {
  const target = path.resolve(out);
  const check = () => checkOut(target);
  check();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(target), `.${path.basename(target)}.tmp-`));
  try {
    for (const [rel, bytes] of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), bytes);
    }
    check();
    try { fs.rmdirSync(target); } catch { /* absent */ }
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return target;
}

// -------------------------------------------------------------------- CLI --
const VALUE_FLAGS = new Set(["--commit", "--dist", "--umbrella", "--out", "--repo"]);

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!VALUE_FLAGS.has(flag)) throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (opts[flag.slice(2)] !== undefined) throw new UsageError(`${flag} given twice`);
    opts[flag.slice(2)] = value;
    i += 1;
  }
  for (const k of ["dist", "umbrella", "out"]) if (opts[k] === undefined) throw new UsageError(`--${k} is required`);
  return opts;
}

export function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`write-bundle: ${e.message}\n${USAGE}`);
    return 2;
  }
  try {
    checkOut(path.resolve(opts.out)); // before any work: an occupied --out is a usage error
    const source = commitSource(opts.commit ?? "HEAD", { repo: opts.repo === undefined ? repoRoot : path.resolve(opts.repo) });
    const { manifest, files } = buildBundle(source, { dist: path.resolve(opts.dist), umbrella: path.resolve(opts.umbrella) });
    const target = writeBundleDir(files, opts.out);
    const sizes = [...files].filter(([rel]) => !rel.startsWith(`${BUNDLE_FILES.umbrellaDir}/`)).map(([rel, b]) => `${rel} ${b.length}`).join(", ");
    console.log(`write-bundle: ${manifest.releaseId} ${manifest.artifactSetId} ${manifest.shell.shellId} → ${target} (${files.size} files: ${sizes}, ${manifest.baseTree.umbrellaFiles.length} umbrella file(s))`);
    return 0;
  } catch (e) {
    if (e instanceof OutExists) {
      console.error(`write-bundle: ${e.message}`);
      return 2;
    }
    if (e instanceof ReleaseRefusal) {
      console.error(`write-bundle: REFUSED: ${e.message}`);
      return 1;
    }
    if (e?.code) { // an unwritable --out and the like: still one line
      console.error(`write-bundle: REFUSED: ${e.code} ${String(e.message).split("\n")[0]}`);
      return 1;
    }
    throw e;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
