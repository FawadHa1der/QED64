#!/usr/bin/env node
// Moved to pipeline/release/preflight.mjs (2026-10-06; docs/CLI-CONTRACT.md changelog). This shim keeps the old path working for one re-pin cycle.
export * from "../../pipeline/release/preflight.mjs";
import { main } from "../../pipeline/release/preflight.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error("preflight: WARNING — tests/adversarial/preflight.mjs is deprecated; use pipeline/release/preflight.mjs (docs/CLI-CONTRACT.md)");
  await main();
}
