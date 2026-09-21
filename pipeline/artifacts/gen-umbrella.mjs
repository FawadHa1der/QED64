#!/usr/bin/env node
// Generate the QED64.Essential umbrella source from a profile manifest.
//
// The umbrella is `import <M>` for every module of the mathlib-essential
// manifest — exactly that list: the profile's own Std/Lean modules are in it,
// the core profile's Init modules are not (every one of them is already in
// the closure of what is). Compiled with the wasm runtime and baked as the
// `mathlib` snapshot, it seeds the one environment that serves every import
// combination the profile can satisfy (docs/ARCHITECTURE.md).
//
// Deterministic: names are sorted by UTF-16 code unit (Array.prototype.sort's
// default, which is also the order the served manifest lists its modules in),
// one import per line, a fixed header, a trailing newline. For the served
// manifest this reproduces the hand-made work/umbrella/Essential.lean byte
// for byte.
//
// Usage: node pipeline/artifacts/gen-umbrella.mjs --manifest <mathlib-essential.manifest.json> --out <Essential.lean>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UMBRELLA_HEADER =
  "-- QED64 umbrella module: imports the entire mathlib-essential profile.\n" +
  "-- Compiling `import QED64.Essential` seeds one environment that serves every\n" +
  "-- Mathlib import combination the profile can satisfy.\n";

const PLAIN_COMPONENT = /^[A-Za-z_][A-Za-z0-9_'!?]*$/;

/** `Mathlib.Data.Real.Basic` as Lean spells it in an import; a component that
 * is not a plain identifier (a digit-led file name, say) is «quoted». */
export function importName(moduleName) {
  if (typeof moduleName !== "string" || moduleName === "") throw new Error("empty module name");
  return moduleName
    .split(".")
    .map((component) => {
      if (component === "" || /[«»\n\r]/.test(component)) throw new Error(`module name ${JSON.stringify(moduleName)} cannot be imported`);
      return PLAIN_COMPONENT.test(component) ? component : `«${component}»`;
    })
    .join(".");
}

/** The umbrella source for a list of module names (order and duplicates in
 * the input do not matter). */
export function umbrellaSource(moduleNames) {
  const names = [...new Set(moduleNames)].sort();
  if (names.length === 0) throw new Error("no modules: an empty umbrella would bake an Init-only environment under the Mathlib name");
  const own = names.filter((name) => name === "QED64" || name.startsWith("QED64."));
  if (own.length > 0) throw new Error(`the module list contains the umbrella itself (${own.join(", ")}) — pack from a tree without QED64/`);
  return `${UMBRELLA_HEADER}\n${names.map((name) => `import ${importName(name)}`).join("\n")}\n`;
}

/** Module names of a `browser64.artifact-manifest`. */
export function manifestModules(manifest) {
  const modules = manifest?.content?.modules;
  if (manifest?.format !== "browser64.artifact-manifest" || !modules || typeof modules !== "object") {
    throw new Error("not a browser64.artifact-manifest with content.modules");
  }
  return Object.keys(modules);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
  };
  const manifestPath = arg("manifest");
  const out = arg("out");
  if (!manifestPath || !out) {
    console.error("usage: gen-umbrella.mjs --manifest <mathlib-essential.manifest.json> --out <Essential.lean>");
    process.exit(2);
  }
  try {
    const names = manifestModules(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const source = umbrellaSource(names);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, source);
    console.log(`umbrella: ${names.length} imports → ${out}`);
  } catch (error) {
    console.error(`gen-umbrella: ${error.message}`);
    process.exit(1);
  }
}
