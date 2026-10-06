#!/usr/bin/env node
// Inspect and verify a pack against its manifest.
//
// DEPRECATED FORWARD (tier 3, plan B1a): the tool is the fork's package,
// lean4-wasm64 inspect, which this script replaces itself with after one
// WARNING, arguments unchanged. The package's inspect is stricter than the
// one that lived here (it also checks the manifest digest, the transport
// digest and overlapping WORKERFS ranges) and streams the parts, so the
// 3.5 GB essential pack is never held whole. Located by LEAN4_WASM64_DIR or
// the cwd's node_modules/lean4-wasm64 (never imported); absent: one line, exit 2.
//
// Usage: node pipeline/artifacts/inspect.mjs <manifest.json> [--pack <file>] [--deep]

import { forwardToLean4Wasm64 } from "../toolchain/artifact-paths.mjs";

console.error("inspect: WARNING — pipeline/artifacts/inspect.mjs is deprecated; use lean4-wasm64 inspect (the fork's package) (docs/CLI-CONTRACT.md)");
forwardToLean4Wasm64("inspect", "inspect.mjs", process.argv.slice(2));
