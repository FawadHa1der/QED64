// Pack segmentation: file-aligned cuts, offset rebasing, and byte-exact
// reassembly from arbitrary stream piece boundaries.

import { describe, expect, test } from "vitest";
import { planSegments, buildSegments, type WorkerfsFileEntry } from "../../src/install/profiles";

function files(sizes: number[], gap = 3): WorkerfsFileEntry[] {
  const out: WorkerfsFileEntry[] = [];
  let at = 80; // pack header
  for (let i = 0; i < sizes.length; i += 1) {
    out.push({ filename: `/f${i}`, start: at, end: at + sizes[i]! });
    at += sizes[i]! + gap;
  }
  return out;
}

describe("planSegments", () => {
  test("respects the byte budget and rebases offsets", () => {
    const table = files([100, 100, 100, 100]);
    const plans = planSegments(table, 210);
    expect(plans.length).toBe(2);
    for (const plan of plans) {
      expect(plan.endByte - plan.startByte).toBeLessThanOrEqual(210);
      expect(plan.files[0]!.start).toBe(0);
      for (const f of plan.files) {
        expect(f.end - f.start).toBe(100);
        expect(f.start).toBeGreaterThanOrEqual(0);
        expect(f.end).toBeLessThanOrEqual(plan.endByte - plan.startByte);
      }
    }
  });

  test("an oversized file gets its own segment", () => {
    const table = files([50, 500, 50]);
    const plans = planSegments(table, 200);
    expect(plans.some((p) => p.files.length === 1 && p.files[0]!.end === 500)).toBe(true);
    // every file appears exactly once
    const names = plans.flatMap((p) => p.files.map((f) => f.filename)).sort();
    expect(names).toEqual(["/f0", "/f1", "/f2"]);
  });

  test("single segment when everything fits", () => {
    const plans = planSegments(files([10, 10]), 1 << 20);
    expect(plans.length).toBe(1);
    expect(plans[0]!.files.length).toBe(2);
  });
});

describe("buildSegments", () => {
  test("reassembles bytes exactly across awkward piece boundaries", () => {
    const table = files([64, 64, 64]);
    const total = table[table.length - 1]!.end;
    const raw = new Uint8Array(total).map((_, i) => (i * 7 + 13) & 0xff);
    // pieces with prime-ish sizes that straddle every boundary
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < total; ) {
      const n = Math.min(total - at, 37);
      pieces.push(raw.subarray(at, at + n));
      at += n;
    }
    const plans = planSegments(table, 130);
    const segments = buildSegments(pieces, plans);
    expect(segments.length).toBe(plans.length);
    return Promise.all(
      segments.map(async (segment, si) => {
        const bytes = segment.bytes!;
        const plan = plans[si]!;
        expect(bytes.byteLength).toBe(plan.endByte - plan.startByte);
        expect(Buffer.compare(Buffer.from(bytes), Buffer.from(raw.subarray(plan.startByte, plan.endByte)))).toBe(0);
        for (const f of plan.files) {
          const original = table.find((t) => t.filename === f.filename)!;
          const viaSegment = bytes.subarray(f.start, f.end);
          const direct = raw.subarray(original.start, original.end);
          expect(Buffer.compare(Buffer.from(viaSegment), Buffer.from(direct))).toBe(0);
        }
      }),
    );
  });

  test("throws when the stream is shorter than the plan", () => {
    const table = files([64]);
    expect(() => buildSegments([new Uint8Array(10)], planSegments(table, 1000))).toThrow(/exceeds/);
  });
});
