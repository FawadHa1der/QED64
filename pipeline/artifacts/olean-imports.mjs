#!/usr/bin/env node
// Direct imports of a module, read from its `.olean` (64-bit compacted region).
//
// Layout (src/runtime/object.h + the compactor, 64-bit little-endian):
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
// As a module:  oleanImportEntries(bytes) → [{ module, importAll, isExported, isMeta }] | null
//               oleanImports(bytes)       → sorted unique module names | null
//               (null = not a region this reader understands; callers decide)
// As a CLI:     node pipeline/artifacts/olean-imports.mjs --audit <olean tree>
//               the `import all` edges of a tree — the static half of the
//               slim-bake audit (docs/SERVER-SLIM-REBAKE.md): `import all M`
//               needs M.olean.private, which a slim tree does not have.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TAG_ARRAY = 246;
const TAG_STRING = 249;
const MAX_NAME_DEPTH = 64;

export function oleanImportEntries(bytes) {
  try {
    if (bytes.length < 96 || bytes.toString("latin1", 0, 5) !== "olean") return null;
    const base = bytes.readBigUInt64LE(80);
    const at = (pointer) => {
      const offset = pointer - base;
      if (offset < 88n || offset + 8n > BigInt(bytes.length)) throw new RangeError("pointer outside the region");
      return Number(offset);
    };
    const isBoxed = (word) => (word & 1n) === 1n;
    const tagOf = (offset) => bytes.readUInt8(offset + 7);
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
    const root = at(bytes.readBigUInt64LE(88));
    const array = at(bytes.readBigUInt64LE(root + 8));
    if (tagOf(array) !== TAG_ARRAY) return null;
    const count = Number(bytes.readBigUInt64LE(array + 8));
    const entries = [];
    for (let i = 0; i < count; i += 1) {
      const entry = at(bytes.readBigUInt64LE(array + 24 + 8 * i));
      if (bytes.readUInt8(entry + 6) !== 1) throw new TypeError("expected an Import");
      entries.push({
        module: nameOf(bytes.readBigUInt64LE(entry + 8)),
        importAll: bytes.readUInt8(entry + 16) !== 0,
        isExported: bytes.readUInt8(entry + 17) !== 0,
        isMeta: bytes.readUInt8(entry + 18) !== 0,
      });
    }
    return entries;
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // <cli-contract> generated from SPECS["olean-imports"] in pipeline/snapshot/cli.mjs. Do not edit:
  // `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts
  // fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.
  // It runs before any side effect: --help/-h prints the help and exits 0, a missing required
  // flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and
  // --flag=value is rewritten to the two-token form this script reads (docs/CLI-CONTRACT.md).
  {
    const spec = {"tool":"olean-imports","usage":"olean-imports.mjs --audit <olean tree>","flags":{"audit":1},"required":[["audit"]],"passthrough":null,"passthroughRequired":false};
    spec.help = [
      "usage: olean-imports.mjs --audit <olean tree>",
      "The `import all` edges of an olean tree, by importing library: the static half of the slim-bake audit (`import all M` needs M.olean.private, which a slim tree lacks). As a module it exports oleanImportEntries / oleanImports.",
      "run as: node pipeline/artifacts/olean-imports.mjs",
      "",
      "flags:",
      "  --audit <olean tree>  the tree to audit (every *.olean under it) [required]",
      "  -h, --help            print this help and exit 0, before any side effect",
      "",
      "exit codes:",
      "  0  audited",
      "  1  audited, but some .olean files had no readable import table",
      "  2  usage: --audit missing or the tree does not exist",
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
  const i = process.argv.indexOf("--audit");
  const tree = i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null;
  if (!tree || !fs.existsSync(tree)) {
    console.error("usage: olean-imports.mjs --audit <olean tree>");
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
