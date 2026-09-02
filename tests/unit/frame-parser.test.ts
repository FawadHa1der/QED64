// The worker's LSP frame-header scan (public/workers/lean.worker.js) is on the
// SHIPPED pump path and the resident path. Library progress lines interleave
// with frames on stdout, and an earlier whole-buffer-decode implementation was
// O(n^2) — megabyte string allocations per chunk that killed heavy pages.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.resolve(__dirname, "../../public/workers/lean.worker.js"), "utf8");
const m = src.match(/function indexOfHeader\(buf\) \{[\s\S]*?\n\}/);
if (!m) throw new Error("indexOfHeader not found in lean.worker.js");
const indexOfHeader = new Function(`${m[0]}; return indexOfHeader;`)() as (b: Uint8Array) => number;
const enc = new TextEncoder();
const at = (s: string) => indexOfHeader(enc.encode(s));

describe("worker frame-header scan", () => {
  it("finds a header at offset 0", () => expect(at("Content-Length: 42\r\n\r\n{}")).toBe(0));
  it("skips a library progress line before the frame", () =>
    expect(at("[DEBUG:PROGRESS] 1/629: Init\nContent-Length: 42\r\n\r\n{}")).toBe(29));
  it("returns -1 with no header yet", () => expect(at("[DEBUG] loading modules...\n")).toBe(-1));
  it("is case-insensitive", () => expect(at("content-length: 7\r\n\r\n")).toBe(0));
  it("waits for a header split across reads", () => expect(at("Content-Len")).toBe(-1));
  it("reports the FIRST frame at a boundary", () =>
    expect(at("Content-Length: 2\r\n\r\n{}Content-Length: 3\r\n\r\n{a}")).toBe(0));
  it("offsets are in BYTES for multibyte goal text", () =>
    expect(at("[info] goal: ∀ x, α → β\nContent-Length: 5\r\n\r\n")).toBe(enc.encode("[info] goal: ∀ x, α → β\n").length));
  it("scans a 4 MB buffer linearly", () => {
    const big = "x".repeat(4 * 1024 * 1024) + "Content-Length: 2\r\n\r\n{}";
    const t0 = Date.now();
    expect(at(big)).toBe(4 * 1024 * 1024);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
