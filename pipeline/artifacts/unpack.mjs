#!/usr/bin/env node
// Reconstruct an on-disk olean tree from a profile's verified transport parts.
//
// DEPRECATED FORWARD (contract 3, plan B1a): the tool is the fork's package,
// lean4-wasm64 unpack (same flags and output, plus --slim). This script keeps
// its contract prelude (--help, the usage check, flag warnings) and then
// replaces itself with the package's unpack.mjs (the accepted arguments only:
// each token the prelude warned about is dropped), located by LEAN4_WASM64_DIR
// or the cwd's node_modules/lean4-wasm64 (never imported); absent: one line,
// exit 2.
//
// Usage: node pipeline/artifacts/unpack.mjs --manifest <file> --out <dir> [--slim]
// (--help; the contract is docs/CLI-CONTRACT.md)

import { forwardToLean4Wasm64 } from "../toolchain/artifact-paths.mjs";

// <cli-contract> generated from SPECS["unpack"] in pipeline/snapshot/cli.mjs. Do not edit:
// `node pipeline/snapshot/cli.mjs --write-preludes` rewrites it and tests/unit/cli-contract.test.ts
// fails on drift. Inline, not imported, because downstream vendors this file without cli.mjs.
// It runs before any side effect: --help/-h prints the help and exits 0, a missing required
// flag prints the usage line and exits 2, an unknown flag is a WARNING on stderr, and
// --flag=value is rewritten to the two-token form this script reads, with the later values
// of a repeated flag dropped so the first wins here too (docs/CLI-CONTRACT.md).
{
  const spec = {"tool":"unpack","usage":"unpack.mjs --manifest <file> --out <dir> [--slim]","flags":{"manifest":1,"out":1,"slim":0},"required":[["manifest"],["out"]],"passthrough":null,"passthroughRequired":false};
  spec.help = [
    "usage: unpack.mjs --manifest <file> --out <dir> [--slim]",
    "Reconstruct an on-disk olean tree from a profile's verified transport parts (each part and the raw pack sha256-checked), for the Node-side bakes. Deprecated forward (contract 3): after this help and the usage check it prints one WARNING and runs lean4-wasm64 unpack with the same arguments.",
    "run as: node pipeline/artifacts/unpack.mjs",
    "",
    "flags:",
    "  --manifest <file>  a profile manifest; its parts are read from the same directory by basename [required]",
    "  --out <dir>        the tree to write (files are added or overwritten, never deleted) [required]",
    "  --slim             do not write *.olean.private facets (lean4-wasm64 unpack --slim)",
    "  -h, --help         print this help and exit 0, before any side effect",
    "",
    "environment:",
    "  LEAN4_WASM64_DIR  the lean4-wasm64 package dir the forwards run (unpack, chunk-runtime, and the tier-3 inspect and gate); unset: the first node_modules/lean4-wasm64 above the cwd",
    "",
    "exit codes:",
    "  0  unpacked",
    "  1  a part, the raw pack or a path failed verification (or the manifest is unreadable)",
    "  2  usage, or lean4-wasm64 not found (set LEAN4_WASM64_DIR or install the devDependency)",
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

// Forward only the tokens the prelude accepted. Each one it reported as an
// unknown flag or an unexpected argument was already warned about here and is
// documented as ignored; passed on, the package's identical prelude would warn
// about it a second time. FLAGS is SPECS["unpack"]'s flag arities
// (tests/unit/decision10.test.ts checks they agree).
const FLAGS = { manifest: 1, out: 1, slim: 0 };
const accepted = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const name = /^--(.+)$/.exec(process.argv[i])?.[1];
  if (name === undefined || !Object.hasOwn(FLAGS, name)) continue;
  accepted.push(...process.argv.slice(i, i + 1 + FLAGS[name]));
  i += FLAGS[name];
}

console.error("unpack: WARNING — pipeline/artifacts/unpack.mjs is deprecated; use lean4-wasm64 unpack (the fork's package) (docs/CLI-CONTRACT.md)");
forwardToLean4Wasm64("unpack", "unpack.mjs", accepted);
