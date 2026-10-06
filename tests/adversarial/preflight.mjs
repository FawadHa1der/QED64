#!/usr/bin/env node
// Moved to pipeline/release/preflight.mjs (2026-10-06; docs/CLI-CONTRACT.md changelog). This shim keeps the old path working for one re-pin cycle.
export * from "../../pipeline/release/preflight.mjs";
import { main } from "../../pipeline/release/preflight.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Run as a CLI only when this file is the main module. Compare realpaths: through a symlinked
// install (file: dependency, npm link, workspace, pnpm) Node loads the main module by its realpath
// while process.argv[1] keeps the symlink path, so a plain path compare would skip main() and exit 0.
const invokedDirectly = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) {
  console.error("preflight: WARNING — tests/adversarial/preflight.mjs is deprecated; use pipeline/release/preflight.mjs (docs/CLI-CONTRACT.md)");
  await main();
}
