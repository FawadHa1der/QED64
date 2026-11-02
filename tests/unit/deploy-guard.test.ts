// scripts/deploy-guard.mjs (architecture review R19a): before every deploy,
// every .snapz the tracked snapshot index names must answer on the live origin.
// Against an in-process 127.0.0.1 http server with a per-path answer table that
// records every method and path; the index files live in an OS temp dir; the
// retry wait is stubbed to resolve at once (it records the waits it was asked
// for). Nothing touches the network beyond 127.0.0.1.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ORIGIN as FETCH_ORIGIN } from "../../pipeline/release/fetch-artifacts.mjs";
import { checkLiveSnapshots, DEFAULT_INDEX, DEFAULT_ORIGIN, entriesOf, main, Refusal, USAGE } from "../../scripts/deploy-guard.mjs";

const root = path.resolve(__dirname, "../..");
const SCRIPT = path.join(root, "scripts/deploy-guard.mjs");
const INIT = "/snapshots/init.0123456789abcdef.snapz";
const MATHLIB = "/snapshots/mathlib.fedcba9876543210.snapz";

/** How the server answers a path: a status per request (the last repeats), a Content-Length or none. */
type Answer = { statuses: number[]; length?: number | null; location?: string };
const answers = new Map<string, Answer>();
const seen: { method: string; path: string }[] = [];
const allSeen: { method: string; path: string }[] = [];

let tmp = "";
let server: http.Server;
let origin = "";
let waits: number[] = [];
const sleep = async (ms: number) => { waits.push(ms); };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-deploy-guard-"));
  server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    seen.push({ method: req.method ?? "", path: p });
    allSeen.push({ method: req.method ?? "", path: p });
    const a = answers.get(p);
    if (!a) { res.writeHead(404); res.end(); return; }
    const n = seen.filter((s) => s.path === p).length;
    const status = a.statuses[Math.min(n, a.statuses.length) - 1]!;
    const headers: Record<string, string> = {};
    if (status === 200 && a.length != null) headers["content-length"] = String(a.length);
    if (a.location) headers.location = a.location;
    res.writeHead(status, headers);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  answers.clear();
  seen.length = 0;
  waits = [];
});

let n = 0;
/** An index file in the temp dir: `snapshots` entries, or raw text. */
function indexFile(content: unknown): string {
  const file = path.join(tmp, `index-${n++}.json`);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}
const entry = (name: string, url: string, transfer: number, bytes = transfer * 4) => ({ name, url, digest: `sha256:${"0".repeat(64)}`, bytes, transfer, imports: [], runtime: "wasm64-0123456789abcdef" });
const twoEntries = () => indexFile({ schema: "qed64.snapshot-index/v1", snapshots: [entry("init", INIT, 1000), entry("mathlib", MATHLIB, 5000)] });
const check = (index: string, o = origin) => checkLiveSnapshots({ index, origin: o, sleep });

describe("checkLiveSnapshots", () => {
  test("1: two entries, both 200 with the index's length: ok, two live lines and the OK line", async () => {
    answers.set(INIT, { statuses: [200], length: 1000 });
    answers.set(MATHLIB, { statuses: [200], length: 5000 });
    const r = await check(twoEntries());
    expect(r).toEqual({
      ok: true,
      lines: [
        `deploy-guard: live ${INIT} (1000 bytes)`,
        `deploy-guard: live ${MATHLIB} (5000 bytes)`,
        `deploy-guard: OK 2 snapshot(s) live on ${origin}`,
      ],
    });
    expect(seen).toEqual([{ method: "HEAD", path: INIT }, { method: "HEAD", path: MATHLIB }]);
  });

  test("2: a 200 without Content-Length (a pre-2026-11 Worker's HEAD, QED64_LEGACY) passes on the status alone", async () => {
    answers.set(INIT, { statuses: [200], length: null });
    answers.set(MATHLIB, { statuses: [200], length: null });
    const r = await check(twoEntries());
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(r.lines[0]).toBe(`deploy-guard: live ${INIT} (no length: the live Worker sends none on HEAD)`);
    expect(r.lines.at(-1)).toBe(`deploy-guard: OK 2 snapshot(s) live on ${origin}`);
  });

  test("the size is transfer, else bytes", async () => {
    const noTransfer = { ...entry("init", INIT, 1000), transfer: undefined, bytes: 777 };
    answers.set(INIT, { statuses: [200], length: 777 });
    const r = await check(indexFile({ schema: "qed64.snapshot-index/v1", snapshots: [noTransfer] }));
    expect(r.lines).toEqual([`deploy-guard: live ${INIT} (777 bytes)`, `deploy-guard: OK 1 snapshot(s) live on ${origin}`]);
  });

  test("3: a 404 refuses, naming the url and the upload; the next entry is never asked", async () => {
    answers.set(MATHLIB, { statuses: [200], length: 5000 });
    const r = await check(twoEntries());
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual([
      `deploy-guard: REFUSED: ${INIT}: HTTP 404 from ${origin}${INIT.slice(1)} — upload it first (scripts/upload-artifacts.sh), then re-run the deploy`,
    ]);
    expect(seen).toEqual([{ method: "HEAD", path: INIT }]);
    expect(waits).toEqual([]);
  });

  test("a redirect is not followed: a 301 refuses", async () => {
    answers.set(INIT, { statuses: [301], location: `${origin}elsewhere.snapz` });
    const r = await check(twoEntries());
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toMatch(/^deploy-guard: REFUSED: \/snapshots\/init\.0123456789abcdef\.snapz: HTTP 301 from /);
    expect(seen.map((s) => s.path)).toEqual([INIT]);
  });

  test("4: a length other than the index's refuses (R2 holds other bytes under the name)", async () => {
    answers.set(INIT, { statuses: [200], length: 1000 });
    answers.set(MATHLIB, { statuses: [200], length: 4999 });
    const r = await check(twoEntries());
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual([
      `deploy-guard: live ${INIT} (1000 bytes)`,
      `deploy-guard: REFUSED: ${MATHLIB}: ${origin}${MATHLIB.slice(1)} answers 4999 bytes, the index says 5000 — R2 holds other bytes under this name`,
    ]);
  });

  test("5: a 503 then a 200 passes after one retry (2 s), two HEADs seen", async () => {
    answers.set(INIT, { statuses: [503, 200], length: 1000 });
    answers.set(MATHLIB, { statuses: [200], length: 5000 });
    const r = await check(twoEntries());
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(seen.filter((s) => s.path === INIT)).toEqual([{ method: "HEAD", path: INIT }, { method: "HEAD", path: INIT }]);
    expect(waits).toEqual([2000]);
    expect(r.lines[0]).toBe(`deploy-guard: retry ${origin}${INIT.slice(1)}: HTTP 503; try 2 of 3 in 2 s`);
  });

  test("three 5xx answers refuse after three tries (waits 2 s, then 4 s)", async () => {
    answers.set(INIT, { statuses: [502, 503, 500] });
    const r = await check(twoEntries());
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toBe(`deploy-guard: REFUSED: ${INIT}: ${origin}${INIT.slice(1)} could not be reached (HTTP 500, 3 tries)`);
    expect(seen.length).toBe(3);
    expect(waits).toEqual([2000, 4000]);
  });

  test("6: a closed port refuses: could not be reached, 3 tries", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const r = await check(twoEntries(), `http://127.0.0.1:${port}/`);
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toMatch(new RegExp(`^deploy-guard: REFUSED: /snapshots/init\\.0123456789abcdef\\.snapz: http://127\\.0\\.0\\.1:${port}/snapshots/init\\.0123456789abcdef\\.snapz could not be reached \\(.+, 3 tries\\)$`));
    expect(waits).toEqual([2000, 4000]);
  });

  test("7: an entry url that is not a .snapz directly under /snapshots/ refuses before any request", async () => {
    for (const url of ["/runtime/x.snapz", "https://e.example/snapshots/x.snapz", "/snapshots/a/b.snapz", "/snapshots/x.json", "/snapshots/.x.snapz", 42]) {
      const r = await check(indexFile({ schema: "qed64.snapshot-index/v1", snapshots: [entry("init", INIT, 1000), { ...entry("bad", "", 10), url }] }));
      expect(r.ok, String(url)).toBe(false);
      expect(r.lines).toEqual([`deploy-guard: REFUSED: snapshot bad names ${JSON.stringify(url)}, not a .snapz directly under /snapshots/`]);
    }
    expect(seen).toEqual([]);
  });

  test("an entry without a positive integer size refuses before any request", async () => {
    for (const size of [0, -1, 1.5, "100", null]) {
      const bad = { ...entry("init", INIT, 1000), transfer: size, bytes: size };
      const r = await check(indexFile({ schema: "qed64.snapshot-index/v1", snapshots: [bad] }));
      expect(r.ok, String(size)).toBe(false);
      expect(r.lines.at(-1)).toMatch(/^deploy-guard: REFUSED: snapshot init \(\/snapshots\/init\.0123456789abcdef\.snapz\) gives .* as its size/);
    }
    expect(seen).toEqual([]);
  });

  test("8: a missing index, one that is not JSON, or one of another schema refuses", async () => {
    const cases: [string, RegExp][] = [
      [path.join(tmp, "absent.json"), /cannot be read \(ENOENT\)$/],
      [indexFile("{ not json"), /is not JSON \(/],
      [indexFile({ schema: "qed64.profile-index/v1", profiles: [] }), /is not a qed64\.snapshot-index\/v1 index with a snapshots array$/],
      [indexFile({ schema: "qed64.snapshot-index/v1" }), /is not a qed64\.snapshot-index\/v1 index with a snapshots array$/],
      [indexFile("null"), /is not a qed64\.snapshot-index\/v1 index with a snapshots array$/],
    ];
    for (const [file, re] of cases) {
      const r = await check(file);
      expect(r.ok, file).toBe(false);
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toMatch(/^deploy-guard: REFUSED: index /);
      expect(r.lines[0]).toMatch(re);
    }
    expect(seen).toEqual([]);
  });

  test("an origin that is not http(s) refuses before any request", async () => {
    for (const o of ["file:///tmp/", "ftp://127.0.0.1/", "none", ""]) {
      const r = await check(twoEntries(), o);
      expect(r.ok, o).toBe(false);
      expect(r.lines).toEqual([`deploy-guard: REFUSED: origin ${JSON.stringify(o)} is not an http(s) URL`]);
    }
    expect(seen).toEqual([]);
  });

  test("entriesOf: the tracked index's entries, or a Refusal", () => {
    expect(entriesOf(twoEntries())).toEqual([{ name: "init", url: INIT, size: 1000 }, { name: "mathlib", url: MATHLIB, size: 5000 }]);
    expect(() => entriesOf(path.join(tmp, "absent.json"))).toThrow(Refusal);
    const tracked = entriesOf(DEFAULT_INDEX);
    expect(tracked.length).toBeGreaterThan(0);
    for (const e of tracked) expect(e.url).toMatch(/^\/snapshots\/[^/]+\.snapz$/);
  });
});

describe("main", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => { out.push(l); }, err: (l: string) => { err.push(l); }, sleep } };
  };

  test("10: QED64_DEPLOY_ORIGIN=none skips with exit 0 and asks nothing", async () => {
    const t = io();
    let fetched = 0;
    const code = await main([], { QED64_DEPLOY_ORIGIN: "none" }, { ...t.io, fetchImpl: async () => { fetched++; return new Response(null); } });
    expect(code).toBe(0);
    expect(t.err).toEqual(["deploy-guard: SKIPPED: QED64_DEPLOY_ORIGIN=none (a first deploy: no live origin to ask yet)"]);
    expect(t.out).toEqual([]);
    expect(fetched).toBe(0);
    expect(seen).toEqual([]);
  });

  test("10: an unknown argument, a flag without a value or given twice exits 2 with the usage line", async () => {
    for (const argv of [["--bogus"], ["--index"], ["--origin="], ["--index", "a", "--index=b"], ["stray"]]) {
      const t = io();
      expect(await main(argv, {}, t.io), argv.join(" ")).toBe(2);
      expect(t.err).toHaveLength(2);
      expect(t.err[0]).toMatch(/^deploy-guard: /);
      expect(t.err[1]).toBe(USAGE);
    }
    expect(seen).toEqual([]);
  });

  test("--help prints the usage on stdout and exits 0", async () => {
    const t = io();
    expect(await main(["--help"], {}, t.io)).toBe(0);
    expect(t.out).toEqual([USAGE]);
    expect(USAGE).toBe("usage: [QED64_DEPLOY_ORIGIN=<url>|none] node scripts/deploy-guard.mjs [--index <file>] [--origin <url>]");
  });

  test("--index and --origin (or QED64_DEPLOY_ORIGIN): 0 when live, 1 refused, every line on stderr", async () => {
    answers.set(INIT, { statuses: [200], length: 1000 });
    answers.set(MATHLIB, { statuses: [200], length: 5000 });
    const index = twoEntries();
    let t = io();
    expect(await main(["--index", index, `--origin=${origin}`], {}, t.io)).toBe(0);
    expect(t.err.at(-1)).toBe(`deploy-guard: OK 2 snapshot(s) live on ${origin}`);
    expect(t.out).toEqual([]);
    t = io();
    expect(await main([`--index=${index}`], { QED64_DEPLOY_ORIGIN: origin }, t.io)).toBe(0);
    // the flag wins over the variable, also over none
    t = io();
    expect(await main(["--index", index, "--origin", origin], { QED64_DEPLOY_ORIGIN: "none" }, t.io)).toBe(0);
    expect(t.err.at(-1)).toMatch(/^deploy-guard: OK /);
    answers.delete(MATHLIB);
    t = io();
    expect(await main(["--index", index, "--origin", origin], {}, t.io)).toBe(1);
    expect(t.err.at(-1)).toMatch(/^deploy-guard: REFUSED: \/snapshots\/mathlib\.fedcba9876543210\.snapz: HTTP 404 /);
  });

  test("11: the default origin is fetch-artifacts' DEFAULT_ORIGIN; the default index is the tracked one", () => {
    expect(DEFAULT_ORIGIN).toBe(FETCH_ORIGIN);
    expect(DEFAULT_INDEX).toBe(path.join(root, "public/snapshots/index.json"));
  });

  test("as a CLI: the exit code is main's, every line on stderr", async () => {
    answers.set(INIT, { statuses: [200], length: 1000 });
    answers.set(MATHLIB, { statuses: [200], length: 5000 });
    const index = twoEntries();
    const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    let r = await run(["--index", index, "--origin", origin]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr.trimEnd().split("\n")).toEqual([
      `deploy-guard: live ${INIT} (1000 bytes)`,
      `deploy-guard: live ${MATHLIB} (5000 bytes)`,
      `deploy-guard: OK 2 snapshot(s) live on ${origin}`,
    ]);
    answers.set(MATHLIB, { statuses: [200], length: 1 });
    r = await run(["--index", index], { QED64_DEPLOY_ORIGIN: origin });
    expect(r.code).toBe(1);
    expect(r.stderr.trimEnd().split("\n").at(-1)).toMatch(/^deploy-guard: REFUSED: .* answers 1 bytes, the index says 5000/);
    r = await run([], { QED64_DEPLOY_ORIGIN: "none" });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^deploy-guard: SKIPPED: /);
    r = await run(["--nope"]);
    expect(r.code).toBe(2);
  });
});

describe("the guard asks with HEAD only", () => {
  test("9: every request any test above made was a HEAD", () => {
    expect(allSeen.length).toBeGreaterThan(0);
    expect(allSeen.filter((s) => s.method !== "HEAD")).toEqual([]);
  });
});
