/* QED64 shared LSP frame decoder (architecture spec W1; HARDENING #27).
 *
 * One byte-level decoder for BOTH consumers of the Lean worker's stdout: the
 * classic Lean worker (`importScripts("lsp-frames.js")`) and Node's
 * resident-probe / vitest (`import ".../lsp-frames.js"`, a side-effect import
 * of the same file). It therefore uses no `export` and no `require` — it
 * publishes itself as `globalThis.Qed64LspFrames`, which is valid in a classic
 * worker script AND as an ES module under Node's "type": "module".
 *
 * Bytes arrive one at a time from a per-byte TTY `put_char` sink (the glue's
 * default sink line-buffers until byte 10, which is the whole cause of the
 * "stuck last frame" the ticklers worked around), so frames are byte-exact:
 * `Content-Length: N\r\n\r\n` is parsed at the HEAD of the buffer only, and a
 * body is emitted the moment its N bytes are present. Bytes at the head that
 * are not a frame header are reported as "junk" lines and counted — the
 * kernel's trace import (spec K3) drives that count to zero, and the gate
 * asserts it. Bytes are COPIED into the decoder's own buffer (attack 11: the
 * glue hands out HEAPU8 views that shared-memory growth invalidates).
 *
 * Resync: a junk run ends at '\n' OR at the first "Content-Length:" inside
 * it (a rolling match, still O(n)). Without that, one non-LF stdout write
 * (a stray `IO.print`, a C++ printf without '\n') glued to the next header
 * would make every later frame junk for the life of the session, because
 * bodies carry no LF to end the run — the same silent channel death
 * HARDENING #27 describes, one layer down. The frame the junk collided with
 * may be lost; the channel is not.
 */
"use strict";

(function (root) {
  // "Content-Length:" — letters compared case-insensitively, punctuation exactly.
  const HEADER = [0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x2d, 0x6c, 0x65, 0x6e, 0x67, 0x74, 0x68, 0x3a];
  const JUNK_LINE_CAP = 4096; // a non-header run longer than this is flushed without waiting for '\n'
  const CR = 0x0d;
  const LF = 0x0a;

  /** One header byte, case-insensitively for the letters. */
  function headerByteMatches(byte, want) {
    const isLetter = want >= 0x61 && want <= 0x7a;
    return isLetter ? (byte | 32) === want : byte === want;
  }

  class LspFrameDecoder {
    /** @param {{onFrame:(body:string)=>void, onJunk?:(line:string)=>void}} sinks */
    constructor(sinks) {
      this.onFrame = sinks.onFrame;
      this.onJunk = sinks.onJunk || (() => {});
      this.decoder = new TextDecoder();
      this.buf = new Uint8Array(64 * 1024);
      this.head = 0; // first unconsumed byte
      this.len = 0; // one past the last byte
      this.need = -1; // body bytes awaited, or -1 while reading a header
      this.headerOk = true; // the bytes since `head` still match "Content-Length:"
      this.match = 0; // while !headerOk: header bytes matched by the tail of the junk run (resync)
      this.stats = { frames: 0, junkLines: 0, junkBytes: 0 };
    }

    /** Bytes buffered but not yet emitted (backpressure / debugging datum). */
    get pendingBytes() {
      return this.len - this.head;
    }

    /** Feed one byte (0..255). */
    push(byte) {
      if (this.len === this.buf.length) this.grow(1);
      this.buf[this.len++] = byte;
      if (this.need >= 0) {
        if (this.len - this.head >= this.need) this.emitBody();
        return;
      }
      const at = this.len - this.head - 1; // index of `byte` within the header run
      if (this.headerOk) {
        if (at < HEADER.length) this.headerOk = headerByteMatches(byte, HEADER[at]);
        if (this.headerOk) {
          if (byte === LF && this.headerTerminated()) this.parseHeader();
          else if (this.len - this.head >= JUNK_LINE_CAP) this.flushJunk(); // a header this long is not one
          return;
        }
        this.match = 0; // the run just became junk; `byte` is its first candidate below
      }
      // Junk run: rolling match of HEADER over its tail. A plain "restart at
      // this byte" fallback is exact here because 'c' occurs once in the
      // pattern (no prefix of "content-length:" recurs inside it), so no
      // KMP failure table is needed.
      if (headerByteMatches(byte, HEADER[this.match])) this.match += 1;
      else this.match = headerByteMatches(byte, HEADER[0]) ? 1 : 0;
      if (this.match === HEADER.length) {
        this.resync(this.len - HEADER.length);
      } else if (byte === LF || this.len - this.head >= JUNK_LINE_CAP) {
        this.flushJunk();
      }
    }

    /** A full "Content-Length:" ends the junk run at `start`: report the
     * bytes before it, then continue as if the header had begun at `head`. */
    resync(start) {
      this.flushJunk(start);
      this.headerOk = true;
      this.match = 0;
    }

    /** Feed a chunk; bodies are copied in bulk, headers byte by byte. */
    pushBytes(bytes) {
      let i = 0;
      while (i < bytes.length) {
        if (this.need >= 0) {
          const take = Math.min(bytes.length - i, this.need - (this.len - this.head));
          if (this.len + take > this.buf.length) this.grow(take);
          this.buf.set(bytes.subarray(i, i + take), this.len);
          this.len += take;
          i += take;
          if (this.len - this.head >= this.need) this.emitBody();
        } else {
          this.push(bytes[i++]);
        }
      }
    }

    grow(extra) {
      // Compact first: everything before `head` is consumed.
      if (this.head > 0) {
        this.buf.copyWithin(0, this.head, this.len);
        this.len -= this.head;
        this.head = 0;
      }
      if (this.len + extra > this.buf.length) {
        let size = this.buf.length * 2;
        while (size < this.len + extra) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
      }
    }

    /** True when the header run ends in a blank line: "\r\n\r\n" (the wire
     * form) or a bare "\n\n" (tolerated so a lone-LF writer cannot wedge the
     * decoder by swallowing the next frame into an unterminated header). */
    headerTerminated() {
      const b = this.buf;
      const e = this.len;
      if (e - this.head >= 4 && b[e - 4] === CR && b[e - 3] === LF && b[e - 2] === CR && b[e - 1] === LF) return true;
      return e - this.head >= 2 && b[e - 2] === LF && b[e - 1] === LF;
    }

    parseHeader() {
      // Digits follow "Content-Length:" after optional spaces; other header
      // lines (Content-Type) are ignored. No digits ⇒ not a frame ⇒ junk.
      const b = this.buf;
      let i = this.head + HEADER.length;
      while (i < this.len && b[i] === 0x20) i += 1;
      let n = 0;
      let digits = 0;
      while (i < this.len && b[i] >= 0x30 && b[i] <= 0x39) {
        n = n * 10 + (b[i] - 0x30);
        i += 1;
        digits += 1;
      }
      if (digits === 0) {
        this.flushJunk();
        return;
      }
      this.head = this.len; // the header is consumed; the body starts here
      this.need = n;
      if (n === 0) this.emitBody();
    }

    emitBody() {
      const body = this.decoder.decode(this.buf.subarray(this.head, this.head + this.need));
      this.head += this.need;
      this.need = -1;
      this.headerOk = true;
      this.match = 0;
      this.stats.frames += 1;
      if (this.head === this.len) this.head = this.len = 0;
      this.onFrame(body);
    }

    /** Report bytes [head, end) as junk. Called with no `end` from the LF /
     * cap / no-digits paths: a cap flush keeps the last `match` bytes (a
     * header may be in progress across the boundary), the others take all. */
    flushJunk(end) {
      const keep = end === undefined && !this.headerOk ? this.match : 0;
      if (end === undefined) end = this.len - keep;
      let trimmed = end;
      while (trimmed > this.head && (this.buf[trimmed - 1] === LF || this.buf[trimmed - 1] === CR)) trimmed -= 1;
      const line = this.decoder.decode(this.buf.subarray(this.head, trimmed));
      this.stats.junkBytes += end - this.head; // every non-frame byte counts, blank lines included
      if (end === this.len) {
        this.head = this.len = 0;
        this.headerOk = true;
        this.match = 0;
      } else {
        this.head = end; // the kept tail stays a junk run with `match` header bytes (or the resync header)
      }
      if (line.trim()) {
        this.stats.junkLines += 1;
        this.onJunk(line);
      }
    }
  }

  root.Qed64LspFrames = { LspFrameDecoder };
})(globalThis);
