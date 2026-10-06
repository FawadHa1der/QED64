// pipeline/release/preflight.mjs without a browser: its boot smoke imports the
// CALLER's playwright (a dynamic import that resolves from the script's own
// location), and one that does not resolve, or a Chromium that does not
// launch, is the documented refusal (`PREFLIGHT REFUSED: …`, exit 3), never a
// crash (exit 1). docs/CLI-CONTRACT.md "preflight". Each fetch check is
// answered by an in-process HTTP server on 127.0.0.1; nothing here launches
// Chromium (the importer is injected, or playwright cannot resolve at all).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootSmoke, runPreflight } from "../../pipeline/release/preflight.mjs";
import { resolveTarget } from "../../pipeline/release/page-target.mjs";

const root = path.resolve(__dirname, "../..");
const BUILD = "wasm64-0123456789abcdef";
const CHUNK = "/runtime/chunks/lean.wasm.0123456789abcdef0123.part-000";
const notFound = () => Promise.reject(Object.assign(new Error("Cannot find package 'playwright' imported from /x/preflight.mjs"), { code: "ERR_MODULE_NOT_FOUND" }));

let server: http.Server;
let origin = "";
let tmp = "";
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-preflight-"));
  // The smallest served pairing every fetch check passes: one chunk, no snapshots (a warning), a core profile.
  const json: Record<string, unknown> = {
    "/runtime/runtime-manifest.json": { buildId: BUILD, leanVersion: "4.34.0", files: { "lean.wasm": { chunks: [{ url: CHUNK, bytes: 4 }] } } },
    "/snapshots/index.json": { schema: "qed64.snapshot-index/v1", snapshots: [] },
    "/profiles/index.json": { profiles: [{ id: "core" }] },
  };
  server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p in json) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(json[p])); return; }
    if (p === CHUNK) { res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "4" }); res.end(req.method === "HEAD" ? undefined : "\0asm"); return; }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("preflight's boot smoke: playwright is the caller's", () => {
  it("bootSmoke: an unresolvable playwright is a reason, not a throw; so is a Chromium that does not launch", async () => {
    expect(await bootSmoke("http://127.0.0.1:9/", 1000, { importPlaywright: notFound })).toEqual({
      ok: false, reason: "playwright not resolvable from the caller (ERR_MODULE_NOT_FOUND)",
    });
    const broken = () => Promise.reject(new SyntaxError("Unexpected token"));
    expect(await bootSmoke("http://127.0.0.1:9/", 1000, { importPlaywright: broken })).toEqual({
      ok: false, reason: "playwright could not be imported (SyntaxError): Unexpected token",
    });
    const noBrowser = async () => ({ chromium: { launch: () => Promise.reject(new Error("browserType.launch: Executable doesn't exist")) } });
    const r = await bootSmoke("http://127.0.0.1:9/", 1000, { importPlaywright: noBrowser });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^Error: browserType\.launch: Executable doesn't exist; console tail: $/);
  });

  it("runPreflight passes the importer through: every fetch check passes, then the refusal names playwright", async () => {
    const lines: string[] = [];
    const r = await runPreflight(resolveTarget(`${origin}/`), { log: (l) => lines.push(l), importPlaywright: notFound });
    expect(r).toMatchObject({ ok: false, buildId: BUILD, mode: "resident", reason: "boot smoke: playwright not resolvable from the caller (ERR_MODULE_NOT_FOUND)" });
    expect(lines.at(-1)).toBe("FAIL  boot smoke: playwright not resolvable from the caller (ERR_MODULE_NOT_FOUND)");
    expect(lines.filter((l) => l.startsWith("ok    "))).toHaveLength(3); // manifest, lean.wasm chunks, profiles
  });

  it("the CLI from a copy where playwright cannot resolve: PREFLIGHT REFUSED and exit 3 (it was an uncaught rejection, exit 1)", async () => {
    // preflight.mjs and the two modules it imports, at their relative paths, outside every node_modules tree.
    const copy = path.join(tmp, "copy");
    for (const f of ["pipeline/release/preflight.mjs", "pipeline/release/page-target.mjs", "pipeline/snapshot/cli.mjs"]) {
      fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(copy, f));
    }
    const script = path.join(copy, "pipeline/release/preflight.mjs");
    // The precondition, checked rather than assumed: nothing above the copy provides playwright.
    expect(() => createRequire(script).resolve("playwright")).toThrow(/Cannot find module/);
    // NODE_PATH pointed at the copy (and the cwd there): ESM resolution ignores NODE_PATH, so neither can supply it.
    const child = spawn(process.execPath, [script, "--url", `${origin}/`], { cwd: copy, env: { ...process.env, NODE_PATH: copy }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    const lines = stdout.trim().split("\n");
    expect([code, stderr]).toEqual([3, ""]);
    expect(lines[0]).toMatch(/^preflight: http:\/\/127\.0\.0\.1:\d+\/ \(resident; manifest \S+; snapshots \/snapshots\/\)$/);
    expect(lines.slice(-2)).toEqual([
      "FAIL  boot smoke: playwright not resolvable from the caller (ERR_MODULE_NOT_FOUND)",
      "PREFLIGHT REFUSED: boot smoke: playwright not resolvable from the caller (ERR_MODULE_NOT_FOUND)",
    ]);
  });
});
