// Integration: the runtime's lean.wasm still holds kernel patch 0036's two stack-guard phrases, the words
// lib/stack-limit.ts recognises (HARDENING #92, docs/EMBEDDING.md §7.10). Lean's messages are plain bytes in the wasm
// data segment, so a kernel release that rewords either phrase fails here, at the adoption's integration tier
// (docs/REBUILD.md: `QED64_LEAN_ARTIFACT=$W/artifact npm run test:integration`), instead of silently turning the note
// and the pill's count off in the browser. It only reads the file: no wasm runs, no lock needed.
//
// The artifact is QED64_LEAN_ARTIFACT (a stage1-style dir: <dir>/bin/lean.wasm) only. The deprecated default
// (pipeline/toolchain/work/build/stage1) is not taken: in the main checkout it predates 0036, so it would fail for a
// reason that is not a reword. Without the variable the suite skips and names it.
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { toolPath } from "../../pipeline/toolchain/artifact-paths.mjs";
import { GUARD_PHRASES } from "../../lib/stack-limit";

const found = toolPath({ env: "QED64_LEAN_ARTIFACT" });
const wasm = found ? path.join(found.path, "bin/lean.wasm") : "";
const skipReason = !found
  ? "QED64_LEAN_ARTIFACT is unset: set it to a stage1 dir (<dir>/bin/lean.wasm)"
  : !existsSync(wasm) ? `QED64_LEAN_ARTIFACT (${found.path}) has no bin/lean.wasm` : null;
if (skipReason) console.warn(`stack-guard-phrases: skipped — ${skipReason}`);
const describeIf = skipReason ? describe.skip : describe;

describeIf("the runtime's stack-guard words (kernel patch 0036)", () => {
  test("lean.wasm holds each phrase the classifier matches, verbatim", () => {
    const bytes = readFileSync(wasm);
    const missing = GUARD_PHRASES.filter((p) => !bytes.includes(Buffer.from(p, "utf8")));
    expect(missing, `${wasm} lacks ${JSON.stringify(missing)}: this runtime predates kernel patch 0036, or a release reworded its guard (then update lib/stack-limit.ts GUARD_PHRASES and its fixture, HARDENING #92)`).toEqual([]);
  });
});
