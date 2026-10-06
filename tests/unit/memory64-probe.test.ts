// The Memory64 probe bytes exist twice by necessity: src/runtime/client.ts
// exports MEMORY64_PROBE (re-exported by `qed64/embed`, docs/EMBEDDING.md
// §7.0), and public/workers/lean.worker.js, a plain classic script that
// cannot import a module, carries its own copy for its capabilities report.
// This test parses the worker's source and pins the two byte for byte, so an
// embedder that refuses an incapable browser before spawning the worker uses
// exactly the worker's test.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY64_PROBE, probeMemory64 } from "../../src/runtime/client";
import * as embed from "../../frontend/src/embed/index";

const root = path.resolve(__dirname, "../..");
const worker = fs.readFileSync(path.join(root, "public/workers/lean.worker.js"), "utf8");

/** The byte list of the worker's `const MEMORY64_PROBE = new Uint8Array([...]);`. */
function workerProbeBytes(): number[] {
  const m = /^const MEMORY64_PROBE = new Uint8Array\(\[([\s\S]*?)\]\);$/m.exec(worker);
  if (!m) throw new Error("lean.worker.js: no `const MEMORY64_PROBE = new Uint8Array([...]);`");
  const body = m[1]!.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const items = body.split(",").map((t) => t.trim()).filter(Boolean);
  for (const t of items) expect(t, `a non-literal byte in the worker's probe: ${t}`).toMatch(/^(0x[0-9a-fA-F]{1,2}|\d{1,3})$/);
  return items.map((t) => Number(t));
}

describe("MEMORY64_PROBE", () => {
  it("the worker's bytes are the exported bytes", () => {
    expect(workerProbeBytes()).toEqual([...MEMORY64_PROBE]);
    expect(MEMORY64_PROBE).toBeInstanceOf(Uint8Array);
    expect(MEMORY64_PROBE.length).toBe(13);
    // the worker validates its copy, once
    expect(worker.match(/WebAssembly\.validate\(MEMORY64_PROBE\)/g)).toHaveLength(1);
  });

  it("is a wasm header plus one memory64 memory section, and fixed in shape", () => {
    expect([...MEMORY64_PROBE.slice(0, 8)]).toEqual([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    // section id 5 (memory), size 3, one memory, limits flags 0x04 (i64 index), min 0
    expect([...MEMORY64_PROBE.slice(8)]).toEqual([0x05, 0x03, 0x01, 0x04, 0x00]);
    expect(Object.isExtensible(MEMORY64_PROBE)).toBe(false);
    // flags 0x00 is the same module with a 32-bit memory: every engine validates that one
    const m32 = MEMORY64_PROBE.slice();
    m32[11] = 0x00;
    expect(WebAssembly.validate(m32)).toBe(true);
  });

  it("probeMemory64 validates it (Node >= 24 has Memory64 on), and the barrel re-exports both", () => {
    expect(probeMemory64()).toBe(WebAssembly.validate(MEMORY64_PROBE));
    expect(probeMemory64()).toBe(true);
    expect(embed.MEMORY64_PROBE).toBe(MEMORY64_PROBE);
    expect(embed.probeMemory64).toBe(probeMemory64);
  });
});
