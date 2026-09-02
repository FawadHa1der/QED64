// The shared LSP frame decoder (public/workers/lsp-frames.js) is fed byte by
// byte from the worker's stdout TTY tap and by Node's resident-probe — one
// parser for both (architecture review A1; HARDENING #27). Frames are
// byte-exact once the per-byte sink exists, so the properties here are the
// ones that bit us: every split of the byte stream decodes identically, body
// lengths count UTF-8 BYTES, a 4 MB body is linear, and non-frame bytes at
// the head are counted (the gate's `nonFrameStdoutBytes === 0`).
import { describe, expect, it } from "vitest";
import "../../public/workers/lsp-frames.js";

interface Decoder {
  push(byte: number): void;
  pushBytes(bytes: Uint8Array): void;
  readonly pendingBytes: number;
  stats: { frames: number; junkLines: number; junkBytes: number };
}
interface DecoderCtor {
  new (sinks: { onFrame(body: string): void; onJunk?(line: string): void }): Decoder;
}
const { LspFrameDecoder } = (globalThis as unknown as { Qed64LspFrames: { LspFrameDecoder: DecoderCtor } }).Qed64LspFrames;

const enc = new TextEncoder();
const frame = (body: string) => enc.encode(`Content-Length: ${enc.encode(body).length}\r\n\r\n${body}`);
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function decodeAll(stream: Uint8Array, mode: "byte" | "bulk" | number[] = "byte") {
  const frames: string[] = [];
  const junk: string[] = [];
  const d = new LspFrameDecoder({ onFrame: (b) => frames.push(b), onJunk: (l) => junk.push(l) });
  if (mode === "byte") for (const b of stream) d.push(b);
  else if (mode === "bulk") d.pushBytes(stream);
  else {
    let at = 0;
    for (const cut of [...mode, stream.length]) {
      d.pushBytes(stream.subarray(at, cut));
      at = cut;
    }
  }
  return { frames, junk, d };
}

// Deterministic PRNG so a failure reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("lsp-frames decoder", () => {
  it("emits byte-exact frames, one per body, with nothing left pending", () => {
    const bodies = ['{"jsonrpc":"2.0","id":1,"result":null}', "{}", '{"method":"x"}'];
    const { frames, junk, d } = decodeAll(concat(bodies.map(frame)));
    expect(frames).toEqual(bodies);
    expect(junk).toEqual([]);
    expect(d.pendingBytes).toBe(0);
    expect(d.stats).toEqual({ frames: 3, junkLines: 0, junkBytes: 0 });
  });

  it("decodes identically under EVERY split of the byte stream (the 256-byte-scan class)", () => {
    const bodies = ['{"a":1}', '{"goal":"∀ x, α → β"}', ""];
    const stream = concat(bodies.map(frame));
    for (let cut = 0; cut <= stream.length; cut += 1) {
      expect(decodeAll(stream, [cut]).frames, `split at ${cut}`).toEqual(bodies);
    }
  });

  it("random frames under random chunking equal the originals (property)", () => {
    const next = rng(0x5eed);
    for (let round = 0; round < 40; round += 1) {
      const n = 1 + Math.floor(next() * 6);
      const bodies = Array.from({ length: n }, () => {
        const len = Math.floor(next() * 300);
        let s = "";
        for (let i = 0; i < len; i += 1) s += next() < 0.1 ? "λ" : String.fromCharCode(0x20 + Math.floor(next() * 90));
        return s;
      });
      const stream = concat(bodies.map(frame));
      const cuts: number[] = [];
      for (let at = 0; at < stream.length; at += 1 + Math.floor(next() * 40)) cuts.push(at);
      expect(decodeAll(stream, cuts.slice(1)).frames).toEqual(bodies);
    }
  });

  it("tolerates a header split across pushes, including inside the CRLF pair", () => {
    const body = '{"split":true}';
    const stream = frame(body);
    const hdrLen = stream.length - enc.encode(body).length;
    for (const cut of [1, 8, 15, 16, hdrLen - 3, hdrLen - 2, hdrLen - 1, hdrLen]) {
      expect(decodeAll(stream, [cut]).frames).toEqual([body]);
    }
  });

  it("counts Content-Length in bytes for multibyte bodies", () => {
    const body = '{"goal":"⊢ ∀ (α : Type), α → α"}';
    expect(enc.encode(body).length).toBeGreaterThan(body.length);
    expect(decodeAll(frame(body)).frames).toEqual([body]);
    expect(decodeAll(concat([frame(body), frame("{}")])).frames).toEqual([body, "{}"]);
  });

  it("is case-insensitive in the header name and ignores extra header lines", () => {
    const s = enc.encode('content-length: 2\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{}');
    expect(decodeAll(s).frames).toEqual(["{}"]);
  });

  it("accepts a bare LF-LF terminator instead of wedging on the next frame", () => {
    const s = concat([enc.encode("Content-Length: 2\n\n{}"), frame('{"next":1}')]);
    expect(decodeAll(s).frames).toEqual(["{}", '{"next":1}']);
  });

  it("decodes a 4 MB body in linear time, byte by byte", () => {
    const body = "x".repeat(4 * 1024 * 1024);
    const stream = frame(body);
    const t0 = performance.now();
    const { frames } = decodeAll(stream, "byte");
    const ms = performance.now() - t0;
    expect(frames[0]!.length).toBe(body.length);
    expect(ms).toBeLessThan(1500);
  });

  it("reports non-frame bytes at the head as junk lines and counts them", () => {
    const junkA = "[DEBUG:PROGRESS] 1/629: Init";
    const junkB = "[WASM LSP] prebuilt lookup HIT";
    const s = concat([enc.encode(`${junkA}\n`), frame("{}"), enc.encode(`${junkB}\r\n\n`), frame('{"b":2}')]);
    const { frames, junk, d } = decodeAll(s);
    expect(frames).toEqual(["{}", '{"b":2}']);
    expect(junk).toEqual([junkA, junkB]);
    expect(d.stats.junkLines).toBe(2);
    // Every non-frame byte counts, blank lines included: A + '\n', B + '\r\n', '\n'.
    expect(d.stats.junkBytes).toBe(enc.encode(`${junkA}\n`).length + enc.encode(`${junkB}\r\n`).length + 1);
  });

  it("treats a header without digits as junk and resumes on the next frame", () => {
    const s = concat([enc.encode("Content-Length: oops\r\n\r\n"), frame("{}")]);
    const { frames, junk } = decodeAll(s);
    expect(frames).toEqual(["{}"]);
    expect(junk).toEqual(["Content-Length: oops"]);
  });

  it("a frame stream with zero junk yields nonFrameStdoutBytes === 0 (the gate assertion)", () => {
    const { d } = decodeAll(concat(Array.from({ length: 50 }, (_, i) => frame(`{"i":${i}}`))), "bulk");
    expect(d.stats.junkBytes).toBe(0);
    expect(d.stats.frames).toBe(50);
  });
});
