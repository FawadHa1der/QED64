// One deploy path (plan step A4): .github/workflows/deploy.yml installs both
// roots, runs the tests, then calls scripts/deploy-app.sh, which alone holds
// typecheck:site → build:site → the artifact prune → the size check →
// `npx wrangler deploy`. The script runs here for real, from a scratch copy of
// the repository layout, with `npm` and `npx` replaced by stubs on an explicit
// PATH that record their argv: no build, no network, no wrangler.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const SCRIPT = "scripts/deploy-app.sh";
const MiB25 = 25 * 1024 * 1024;

// A command line, not a comment: shell/YAML `#`, JS `//` and block-comment `*` lines are prose.
const isComment = (line: string) => /^\s*(#|\/\/|\*|\/\*)/.test(line);
const PRUNE = /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b.*\bdist\/(runtime|profiles|snapshots)\b/;
const WRANGLER_DEPLOY = /\bwrangler(@\S+)?\s+deploy\b|wrangler-action/;

describe("deploy.yml calls the one deploy script", () => {
  const text = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
  const steps = [...text.matchAll(/^\s*- run: (.+)$/gm)].map((m) => m[1]!);
  const at = (needle: string) => steps.findIndex((s) => s.includes(needle));

  it("installs both roots before any check, tests, then runs scripts/deploy-app.sh last", () => {
    const rootInstall = steps.findIndex((s) => /^npm ci\s*$/.test(s));
    const frontInstall = at("npm ci --prefix frontend");
    const tests = at("vitest run tests/unit");
    const deploy = steps.indexOf(`bash ${SCRIPT}`);
    expect(rootInstall).toBe(0);
    expect(frontInstall).toBe(1);
    expect(at("tsc --noEmit")).toBeGreaterThan(frontInstall);
    expect(tests).toBeGreaterThan(frontInstall);
    expect(deploy, steps.join("\n")).toBeGreaterThan(tests);
    expect(deploy).toBe(steps.length - 1);
  });

  it("leaves the build, the prune and wrangler to the script", () => {
    for (const s of steps.filter((s) => s !== `bash ${SCRIPT}`)) {
      expect(s).not.toMatch(/build:site|typecheck:site|\brm\b|wrangler/);
    }
  });

  it("hands the script wrangler's auth variables", () => {
    const after = text.slice(text.indexOf(`- run: bash ${SCRIPT}`));
    const block = after.split(/\n\s*- /)[0]!;
    expect(block).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(block).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
  });
});

describe("the prune and `wrangler deploy` live in exactly one file", () => {
  it("scripts/deploy-app.sh, outside docs and tests", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
    const hits = { prune: new Set<string>(), deploy: new Set<string>() };
    for (const rel of tracked) {
      if (/^(docs|tests)\//.test(rel) || rel.endsWith(".md") || rel.endsWith("package-lock.json")) continue;
      const abs = path.join(root, rel);
      let st: fs.Stats;
      try { st = fs.lstatSync(abs); } catch { continue; } // deleted in the working tree
      if (!st.isFile() || st.size > 1 << 20) continue;
      for (const line of fs.readFileSync(abs, "utf8").split("\n")) {
        if (isComment(line)) continue;
        if (PRUNE.test(line)) hits.prune.add(rel);
        if (WRANGLER_DEPLOY.test(line)) hits.deploy.add(rel);
      }
    }
    expect([...hits.prune]).toEqual([SCRIPT]);
    expect([...hits.deploy]).toEqual([SCRIPT]);
  });

  it("in the order install → typecheck → build → prune → size check → deploy, from the repo root, strict", () => {
    const lines = fs.readFileSync(path.join(root, SCRIPT), "utf8").split("\n").filter((l) => l.trim() && !isComment(l));
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    expect(at(/^set -euo pipefail$/)).toBe(0);
    const order = [
      at(/^cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\."$/),
      at(/^\[ -d frontend\/node_modules \] \|\| npm ci --prefix frontend$/),
      at(/^npm run typecheck:site$/),
      at(/^npm run build:site$/),
      at(/^rm -rf dist\/runtime dist\/profiles dist\/snapshots$/),
      at(/find -L dist -type f -size/),
      at(/^\s*npx wrangler deploy$/),
    ];
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("scripts/deploy-app.sh against stubbed npm/npx", () => {
  let tmp: string, repo: string, bin: string, log: string, elsewhere: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-deploy-app-"));
    repo = path.join(tmp, "repo");
    bin = path.join(tmp, "bin");
    log = path.join(tmp, "argv.log");
    elsewhere = path.join(tmp, "elsewhere");
    for (const d of [path.join(repo, "scripts"), path.join(repo, "frontend"), bin, elsewhere]) fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(path.join(root, SCRIPT), path.join(repo, SCRIPT));
    // `npm run build:site` writes a dist/ with the artifact directories the prune must remove, plus
    // STUB_BIG_BYTES of one sparse file; STUB_FAIL names a script that exits 7.
    fs.writeFileSync(path.join(bin, "npm"), [
      "#!/bin/sh",
      'printf "npm %s\\n" "$*" >> "$STUB_LOG"',
      'if [ "$1" = run ] && [ "$2" = "$STUB_FAIL" ]; then exit 7; fi',
      'if [ "$1" = run ] && [ "$2" = build:site ]; then',
      "  rm -rf dist && mkdir -p dist/assets dist/runtime dist/profiles/mathlib dist/snapshots",
      "  echo shell > dist/index.html; echo chunk > dist/runtime/lean.wasm.0; echo pack > dist/profiles/mathlib/p.pack; echo snap > dist/snapshots/index.json",
      '  if [ -n "$STUB_BIG_BYTES" ]; then dd if=/dev/zero of=dist/assets/big.bin bs=1 count=0 seek="$STUB_BIG_BYTES" 2>/dev/null; fi',
      "fi",
      "",
    ].join("\n"), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "npx"), '#!/bin/sh\nprintf "npx %s\\n" "$*" >> "$STUB_LOG"\n', { mode: 0o755 });
  });
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const run = (args: string[], extra: Record<string, string> = {}) => {
    fs.rmSync(log, { force: true });
    fs.rmSync(path.join(repo, "dist"), { recursive: true, force: true });
    // An explicit environment: the stubs first, then only the system tools; nothing inherited (no tokens).
    const env = { PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log, STUB_FAIL: "", STUB_BIG_BYTES: "", HOME: tmp, ...extra };
    const r = spawnSync("/bin/bash", [path.join(repo, SCRIPT), ...args], { cwd: elsewhere, env, encoding: "utf8", timeout: 30_000 });
    const argv = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    return { ...r, argv };
  };
  const BUILD = ["npm ci --prefix frontend", "npm run typecheck:site", "npm run build:site"];

  // The scratch repo has no frontend/node_modules, so the script's local-use install runs (as a stub); the skip
  // when it exists is pinned by reading the script above, so this test never creates a node_modules.
  it("--dry-run: builds from the repo root whatever the cwd, prunes, prints the deploy and never runs npx", () => {
    const r = run(["--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual(BUILD);
    expect(r.stdout).toContain("would run: npx wrangler deploy");
    expect(fs.existsSync(path.join(repo, "dist/index.html"))).toBe(true);
    for (const d of ["runtime", "profiles", "snapshots"]) expect(fs.existsSync(path.join(repo, "dist", d)), d).toBe(false);
    expect(fs.existsSync(path.join(elsewhere, "dist"))).toBe(false);
  });

  it("without --dry-run: the same steps, then `npx wrangler deploy`", () => {
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual([...BUILD, "npx wrangler deploy"]);
  });

  it("refuses, in one line and before any deploy, a dist/ file over 25 MiB", () => {
    const r = run([], { STUB_BIG_BYTES: String(MiB25 + 1) });
    expect(r.status).toBe(1);
    expect(r.argv).toEqual(BUILD);
    expect(r.stderr.trim().split("\n")).toEqual([
      `deploy-app: REFUSED: dist/ holds 1 file(s) over 25 MiB, the Workers assets cap; first: dist/assets/big.bin (${MiB25 + 1} bytes)`,
    ]);
  });

  it("accepts a file of exactly 25 MiB", () => {
    const r = run(["--dry-run"], { STUB_BIG_BYTES: String(MiB25) });
    expect(r.status, r.stderr).toBe(0);
  });

  it("a failing step stops the script with its exit code", () => {
    const r = run([], { STUB_FAIL: "typecheck:site" });
    expect(r.status).toBe(7);
    expect(r.argv).toEqual(BUILD.slice(0, 2));
  });

  it("refuses an unknown argument with exit 2 before running anything", () => {
    const r = run(["--dryrun"]);
    expect(r.status).toBe(2);
    expect(r.argv).toEqual([]);
    expect(r.stderr).toContain("usage: scripts/deploy-app.sh [--dry-run]");
  });
});
