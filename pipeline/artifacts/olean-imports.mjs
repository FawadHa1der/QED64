#!/usr/bin/env node
// Direct imports of a module, read from its `.olean` (64-bit compacted region).
//
// Layout (Lean's src/runtime/object.h + the compactor, 64-bit little-endian):
//   [0,5) "olean" · [5] version · [6] flags · [7,40) Lean version · [40,80) githash
//   [80,88) base address the region expects to be mapped at
//   [88,96) pointer to the root object (ModuleData); every pointer in the file
//           is absolute, so `pointer - base` is a file offset
// An object is an 8-byte header (rc:i32, cs_sz:u16, other:u8, tag:u8) followed
// by its fields. ModuleData's first field is `imports : Array Import`; an
// Import is one object field (the module `Name`) followed by the scalar bytes
// importAll, isExported, isMeta; a Name is `box 0` (anonymous), tag 1
// `.str prefix string`, or tag 2 `.num prefix nat`.
//
// Checked against the served manifests (whose import lists came from the
// Browser64 producer): identical for all 629 lean-core modules and a 1,398
// module sample of mathlib-essential.
//
// As a module:  oleanImportEntries(bytes)  → [{ module, importAll, isExported, isMeta }] | null
//               oleanImports(bytes)        → sorted unique module names | null
//               oleanExtEntryCounts(bytes) → { constNames, entries: { <extension>: count } } | null
//               (null = not a region this reader understands; callers decide)
// As a CLI:     node pipeline/artifacts/olean-imports.mjs --audit <olean tree>
//               the `import all` edges of a tree — the static half of the
//               slim-bake audit (docs/SERVER-SLIM-REBAKE.md): `import all M`
//               needs M.olean.private, which a slim tree does not have.
//               node pipeline/artifacts/olean-imports.mjs --entries <olean file>
//               one line, `entries of <file>: <JSON of oleanExtEntryCounts>`.

import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAG_ARRAY = 246;
const TAG_STRING = 249;
const MAX_NAME_DEPTH = 64;

/** A reader over one compacted region: pointer → offset (bounds-checked),
 * object tags and field counts, Names, strings and arrays. Throws on anything
 * it does not understand; the exported functions turn that into null. Takes
 * any Uint8Array (a Buffer, or e.g. the bytes of a fetch() response): the
 * reads below are Buffer methods, so a plain Uint8Array is viewed as a Buffer
 * over the same memory (no copy). */
function regionReader(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 96 || bytes.toString("latin1", 0, 5) !== "olean") return null;
  const base = bytes.readBigUInt64LE(80);
  const at = (pointer) => {
    const offset = pointer - base;
    if (offset < 88n || offset + 8n > BigInt(bytes.length)) throw new RangeError("pointer outside the region");
    return Number(offset);
  };
  const isBoxed = (word) => (word & 1n) === 1n;
  const tagOf = (offset) => bytes.readUInt8(offset + 7);
  const objsOf = (offset) => bytes.readUInt8(offset + 6);
  const field = (offset, i) => bytes.readBigUInt64LE(offset + 8 + 8 * i);
  const stringAt = (offset) => {
    if (tagOf(offset) !== TAG_STRING) throw new TypeError("expected a string");
    const size = Number(bytes.readBigUInt64LE(offset + 8)); // includes the NUL
    return bytes.toString("utf8", offset + 32, offset + 32 + size - 1);
  };
  const nameOf = (word) => {
    const parts = [];
    for (let depth = 0; !isBoxed(word); depth += 1) {
      if (depth > MAX_NAME_DEPTH) throw new RangeError("name too deep");
      const offset = at(word);
      const component = bytes.readBigUInt64LE(offset + 16);
      if (tagOf(offset) === 1) parts.push(stringAt(at(component)));
      else if (tagOf(offset) === 2 && isBoxed(component)) parts.push(String(component >> 1n));
      else throw new TypeError("expected a Name");
      word = bytes.readBigUInt64LE(offset + 8);
    }
    return parts.reverse().join(".");
  };
  /** The element words of the Array object at `offset`. */
  const arrayItems = (offset) => {
    if (tagOf(offset) !== TAG_ARRAY) throw new TypeError("expected an Array");
    const count = Number(bytes.readBigUInt64LE(offset + 8));
    if (offset + 24 + 8 * count > bytes.length) throw new RangeError("array outside the region");
    return Array.from({ length: count }, (_, i) => bytes.readBigUInt64LE(offset + 24 + 8 * i));
  };
  const byteAt = (offset) => bytes.readUInt8(offset);
  return { at, tagOf, objsOf, field, byteAt, nameOf, arrayItems, root: at(bytes.readBigUInt64LE(88)) };
}

export function oleanImportEntries(bytes) {
  try {
    const r = regionReader(bytes);
    if (r === null) return null;
    const array = r.at(r.field(r.root, 0));
    if (r.tagOf(array) !== TAG_ARRAY) return null;
    return r.arrayItems(array).map((word) => {
      const entry = r.at(word);
      if (r.objsOf(entry) !== 1) throw new TypeError("expected an Import");
      return {
        module: r.nameOf(r.field(entry, 0)),
        importAll: r.byteAt(entry + 16) !== 0,
        isExported: r.byteAt(entry + 17) !== 0,
        isMeta: r.byteAt(entry + 18) !== 0,
      };
    });
  } catch {
    return null;
  }
}

/** ModuleData's object fields, in order: imports, constNames, constants,
 * extraConstNames, entries. `entries : Array (Name × Array EnvExtensionEntry)`
 * holds each environment extension's entries for the module (where a
 * legacy, non-`module` file keeps its IR: Lean.IR.declMapExt). Returns
 * `{ constNames, entries }` with the number of constant names and, per
 * extension name, its entry count; null when the bytes are not a region this
 * reader understands. Same shape as the widgets showcase's
 * scripts/lib/olean-entries.mjs oleanExtEntryCounts, which it replaces. */
export function oleanExtEntryCounts(bytes) {
  try {
    const r = regionReader(bytes);
    if (r === null || r.tagOf(r.root) !== 0 || r.objsOf(r.root) < 5) return null;
    const constNames = r.arrayItems(r.at(r.field(r.root, 1))).length;
    const entries = r.arrayItems(r.at(r.field(r.root, 4))).map((word) => {
      const pair = r.at(word);
      if (r.tagOf(pair) !== 0 || r.objsOf(pair) !== 2) throw new TypeError("expected a Name × Array pair");
      return [r.nameOf(r.field(pair, 0)), r.arrayItems(r.at(r.field(pair, 1))).length];
    });
    return { constNames, entries: Object.fromEntries(entries) };
  } catch {
    return null;
  }
}

export function oleanImports(bytes) {
  const entries = oleanImportEntries(bytes);
  return entries && [...new Set(entries.map((e) => e.module))].sort();
}

function walkOleans(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkOleans(full, out);
    else if (entry.name.endsWith(".olean")) out.push(full);
  }
  return out;
}

// Run as a CLI only when this file is the main module. Compare realpaths: through a symlinked
// install (file: dependency, npm link, workspace, pnpm) Node loads the main module by its realpath
// while process.argv[1] keeps the symlink path, so a plain path compare would skip main() and exit 0.
const invokedDirectly = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) {
  // <cli-contract> generated from SPECS["olean-imports"] in pipeline/snapshot/cli.mjs. Do not edit:
  // `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts
  // fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.
  // It runs before any side effect: --help/-h prints the help and exits 0, a missing required
  // flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and
  // --flag=value is rewritten to the two-token form this script reads, with the later values
  // of a repeated flag dropped so the first wins here too (docs/CLI-CONTRACT.md).
  {
    const spec = {"tool":"olean-imports","usage":"olean-imports.mjs (--audit <olean tree> | --entries <olean file>)","flags":{"audit":1,"entries":1},"required":[["audit","entries"]],"passthrough":null,"passthroughRequired":false};
    spec.help = [
      "usage: olean-imports.mjs (--audit <olean tree> | --entries <olean file>)",
      "--audit: the `import all` edges of an olean tree, by importing library: the static half of the slim-bake audit (`import all M` needs M.olean.private, which a slim tree lacks). --entries: one .olean's ModuleData entry counts (constant names; entries per environment extension) as one line of JSON. As a module it exports oleanImportEntries / oleanImports / oleanExtEntryCounts.",
      "run as: node pipeline/artifacts/olean-imports.mjs",
      "",
      "flags:",
      "  --audit <olean tree>    the tree to audit (every *.olean under it) [one of --audit, --entries is required]",
      "  --entries <olean file>  print the file's ModuleData entry counts instead (one JSON line) [one of --audit, --entries is required]",
      "  -h, --help              print this help and exit 0, before any side effect",
      "",
      "exit codes:",
      "  0  audited, or the entry counts printed",
      "  1  audited, but some .olean files had no readable import table; or the --entries file has no readable ModuleData",
      "  2  usage: neither --audit nor --entries, both, or the tree or file does not exist",
      "",
      "tier 1 (downstream-stable). Contract: docs/CLI-CONTRACT.md",
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
        const repeated = Object.hasOwn(values, name);
        let value = true;
        if (arity === 1) {
          value = m[2] !== undefined ? m[2].slice(1) : i + 1 < args.length ? args[(i += 1)] : undefined;
          if (value === "--help" || value === "-h") help = true;
          if (!repeated) normalized.push(`--${name}`, ...(value === undefined ? [] : [value]));
          if (!value) warnings.push(`flag --${name} has no value; ignored`);
        } else normalized.push(token);
        if (!repeated) values[name] = value ?? "";
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
  const valueOf = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null;
  };
  if (process.argv.includes("--audit") && process.argv.includes("--entries")) {
    console.error("usage: olean-imports.mjs (--audit <olean tree> | --entries <olean file>)");
    process.exit(2);
  }
  if (process.argv.includes("--entries")) {
    const file = valueOf("entries");
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      console.error("usage: olean-imports.mjs (--audit <olean tree> | --entries <olean file>)");
      process.exit(2);
    }
    const counts = oleanExtEntryCounts(fs.readFileSync(file));
    if (!counts) {
      console.log(`no readable ModuleData in ${file}`);
      process.exit(1);
    }
    console.log(`entries of ${file}: ${JSON.stringify(counts)}`);
    process.exit(0);
  }
  const tree = valueOf("audit");
  if (!tree || !fs.existsSync(tree)) {
    console.error("usage: olean-imports.mjs (--audit <olean tree> | --entries <olean file>)");
    process.exit(2);
  }
  const files = walkOleans(tree).sort();
  const edges = [];
  let unreadable = 0;
  for (const file of files) {
    const importer = path.relative(tree, file).slice(0, -".olean".length).split(path.sep).join(".");
    const entries = oleanImportEntries(fs.readFileSync(file));
    if (!entries) { unreadable += 1; continue; }
    for (const e of entries) if (e.importAll) edges.push({ importer, imported: e.module });
  }
  const byLibrary = {};
  for (const { importer } of edges) {
    const library = importer.split(".")[0];
    byLibrary[library] = (byLibrary[library] ?? 0) + 1;
  }
  console.log(`import-all audit of ${tree}: ${files.length} modules, ${edges.length} \`import all\` edge(s)` +
    (unreadable ? `, ${unreadable} unreadable .olean file(s)` : ""));
  for (const [library, count] of Object.entries(byLibrary).sort()) console.log(`  ${library}: ${count}`);
  // Init/Std/Lean use `import all` between their own modules and are baked
  // from the same slim trees already; the ones a NEW library pin can add are
  // the edges whose importer lives outside them.
  const outside = edges.filter(({ importer }) => !/^(Init|Std|Lean|Lake)(\.|$)/.test(importer));
  console.log(`  outside Init/Std/Lean/Lake: ${outside.length}`);
  for (const { importer, imported } of outside.slice(0, 40)) console.log(`    ${importer} → import all ${imported}`);
  if (outside.length > 40) console.log(`    … ${outside.length - 40} more`);
  process.exit(unreadable ? 1 : 0);
}
