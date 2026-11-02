// One deploy path (plan step A4): .github/workflows/deploy.yml (one run at a
// time, main only, and only while its commit is still main's head) installs both
// roots, runs the tests, then calls scripts/deploy-app.sh, which alone holds
// typecheck:site → build:site → the artifact prune (all but QED64's two
// indexes, which ship with the shell: D2) → the size and index check → the
// live-snapshot guard (scripts/deploy-guard.mjs, R19a; its own test is
// deploy-guard.test.ts) → `npx wrangler deploy`. The script runs here for real,
// from a scratch copy of the repository layout, with `npm`, `npx` and `node`
// replaced by stubs on an explicit PATH that record their argv: no build, no
// network, no guard, no wrangler.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const SCRIPT = "scripts/deploy-app.sh";
const MiB25 = 25 * 1024 * 1024;

// A command line, not a comment: shell/YAML `#`, JS `//`, `/*` and block-comment continuation lines
// (`*` then a space, `/` or the line's end) are prose. A shell `case` arm such as `*) rm -rf …` is code.
const isComment = (line: string) => /^\s*(#|\/\/|\/\*|\*(\s|\/|$))/.test(line);
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

  it("has no `run:` the step list misses: no named step's `run:`, no `run: |` or `run: >` block", () => {
    const runLines = text.split("\n").filter((l) => !isComment(l) && /^\s*-?\s*run:/.test(l));
    expect(runLines.length, runLines.join("\n")).toBe(steps.length);
    for (const l of runLines) expect(l).not.toMatch(/run:\s*[|>]/);
  });

  it("no line but the script's step runs build:site or typecheck:site", () => {
    const lines = text.split("\n").filter((l) => !isComment(l) && l.trim() !== `- run: bash ${SCRIPT}`);
    for (const l of lines) expect(l).not.toMatch(/build:site|typecheck:site/);
  });

  // A concurrency group serializes the runs; the job-level `if:` stops a workflow_dispatch of another
  // branch; the head check stops a re-run of an older run (or a run a newer push overtook while it ran) from
  // deploying over a newer commit, which the group alone does not.
  it("serializes deploys in push order; only main's head deploys", () => {
    expect(text).toMatch(/^concurrency:\n {2}group: qed64-deploy-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false$/m);
    expect(text).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
    const head = steps.findIndex((s) => s.includes("git ls-remote origin refs/heads/main") && s.includes('"$GITHUB_SHA"'));
    expect(head, steps.join("\n")).toBeGreaterThan(at("vitest run tests/unit"));
    expect(head).toBe(steps.length - 2);
    // Fail closed: a refused head check ends the run red (DEPLOY.md quotes the message).
    expect(steps[head]).toMatch(/\|\| \{ echo "deploy refused, [^"]*" >&2; exit 1; \}$/);
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

  it("in the order install → typecheck → build → prune → size check → guard → deploy, from the repo root, strict", () => {
    const lines = fs.readFileSync(path.join(root, SCRIPT), "utf8").split("\n").filter((l) => l.trim() && !isComment(l));
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    expect(at(/^set -euo pipefail$/)).toBe(0);
    const order = [
      at(/^cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\."$/),
      at(/^\[ -d frontend\/node_modules \] \|\| npm ci --prefix frontend$/),
      at(/^npm run typecheck:site$/),
      at(/^npm run build:site$/),
      at(/^rm -rf dist\/runtime$/),
      at(/find "dist\/\$dir" -mindepth 1 -maxdepth 1 ! -name index\.json -exec rm -rf \{\} \+$/),
      at(/find -L dist -type f -size/),
      at(/^node scripts\/deploy-guard\.mjs$/),
      at(/^\s*npx wrangler deploy$/),
    ];
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("scripts/deploy-app.sh against stubbed npm/npx/node", () => {
  let tmp: string, repo: string, bin: string, log: string, elsewhere: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-deploy-app-"));
    repo = path.join(tmp, "repo");
    bin = path.join(tmp, "bin");
    log = path.join(tmp, "argv.log");
    elsewhere = path.join(tmp, "elsewhere");
    for (const d of [path.join(repo, "scripts"), path.join(repo, "frontend"), path.join(repo, "public/profiles"), path.join(repo, "public/snapshots"), bin, elsewhere]) fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(path.join(root, SCRIPT), path.join(repo, SCRIPT));
    // the tracked indexes the build copies into dist/ (D2)
    fs.writeFileSync(path.join(repo, "public/profiles/index.json"), '{"schema":"qed64.profile-index/v1","profiles":[]}\n');
    fs.writeFileSync(path.join(repo, "public/snapshots/index.json"), '{"schema":"qed64.snapshot-index/v1","snapshots":[]}\n');
    // `npm run build:site` writes a dist/ with the artifacts the prune must remove and the two indexes it
    // must keep (copied from public/, as vite's build does; STUB_NO_INDEX=<dir> skips that one,
    // STUB_INDEX_DRIFT=1 appends a byte to the profile index's copy, STUB_SYMLINK=1 makes dist/snapshots a
    // symlink to the real directory), plus STUB_BIG_BYTES of one sparse file; STUB_FAIL names a script that
    // exits STUB_FAIL_CODE (default 7).
    fs.writeFileSync(path.join(bin, "npm"), [
      "#!/bin/sh",
      'printf "npm %s\\n" "$*" >> "$STUB_LOG"',
      'if [ "$1" = run ] && [ "$2" = "$STUB_FAIL" ]; then exit "${STUB_FAIL_CODE:-7}"; fi',
      'if [ "$1" = run ] && [ "$2" = build:site ]; then',
      "  rm -rf dist && mkdir -p dist/assets dist/runtime dist/profiles/mathlib dist/snapshots",
      "  echo shell > dist/index.html; echo chunk > dist/runtime/lean.wasm.0; echo pack > dist/profiles/mathlib/p.pack; echo snap > dist/snapshots/init.0.snapz",
      '  for d in profiles snapshots; do [ "$STUB_NO_INDEX" = "$d" ] || cp "public/$d/index.json" "dist/$d/"; done',
      '  if [ "$STUB_SYMLINK" = 1 ]; then mv dist/snapshots dist/snapshots-real && ln -s snapshots-real dist/snapshots; fi',
      '  if [ "$STUB_INDEX_DRIFT" = 1 ]; then printf x >> dist/profiles/index.json; fi',
      '  if [ -n "$STUB_BIG_BYTES" ]; then dd if=/dev/zero of=dist/assets/big.bin bs=1 count=0 seek="$STUB_BIG_BYTES" 2>/dev/null; fi',
      "fi",
      "",
    ].join("\n"), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "npx"), '#!/bin/sh\nprintf "npx %s\\n" "$*" >> "$STUB_LOG"\n', { mode: 0o755 });
    // The guard: STUB_GUARD_EXIT makes it refuse, as deploy-guard.mjs does, with that exit code.
    fs.writeFileSync(path.join(bin, "node"), [
      "#!/bin/sh",
      'printf "node %s\\n" "$*" >> "$STUB_LOG"',
      'if [ -n "$STUB_GUARD_EXIT" ]; then echo "deploy-guard: REFUSED: stub" >&2; exit "$STUB_GUARD_EXIT"; fi',
      "",
    ].join("\n"), { mode: 0o755 });
  });
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const run = (args: string[], extra: Record<string, string> = {}) => {
    fs.rmSync(log, { force: true });
    fs.rmSync(path.join(repo, "dist"), { recursive: true, force: true });
    // An explicit environment: the stubs first, then only the system tools; nothing inherited (no tokens).
    const env = { PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log, STUB_FAIL: "", STUB_BIG_BYTES: "", STUB_GUARD_EXIT: "", STUB_NO_INDEX: "", STUB_INDEX_DRIFT: "", STUB_SYMLINK: "", HOME: tmp, ...extra };
    const r = spawnSync("/bin/bash", [path.join(repo, SCRIPT), ...args], { cwd: elsewhere, env, encoding: "utf8", timeout: 30_000 });
    const argv = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    return { ...r, argv };
  };
  const BUILD = ["npm ci --prefix frontend", "npm run typecheck:site", "npm run build:site"];
  const GUARD = "node scripts/deploy-guard.mjs";

  // The scratch repo has no frontend/node_modules, so the script's local-use install runs (as a stub); the skip
  // when it exists is pinned by reading the script above, so this test never creates a node_modules.
  it("--dry-run: builds from the repo root whatever the cwd, prunes all but the two indexes, runs the guard, prints the deploy and never runs npx", () => {
    const r = run(["--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual([...BUILD, GUARD]);
    expect(r.stdout).toContain("would run: npx wrangler deploy");
    expect(fs.existsSync(path.join(repo, "dist/index.html"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "dist/runtime"))).toBe(false);
    for (const d of ["profiles", "snapshots"]) {
      expect(fs.readdirSync(path.join(repo, "dist", d)), d).toEqual(["index.json"]);
      expect(fs.readFileSync(path.join(repo, "dist", d, "index.json")), d).toEqual(fs.readFileSync(path.join(repo, "public", d, "index.json")));
    }
    expect(fs.existsSync(path.join(elsewhere, "dist"))).toBe(false);
  });

  // D2: the deploy serves QED64's two tracked indexes with the shell, so a build without one, or with
  // other bytes, would ship no pairing or another; refused before the guard and before any deploy.
  it("refuses, in one line and before the guard, a dist/ missing an index or holding other bytes than the tracked one", () => {
    for (const [extra, line] of [
      [{ STUB_NO_INDEX: "snapshots" }, "deploy-app: REFUSED: dist/snapshots/index.json is missing: the deploy serves QED64's tracked public/snapshots/index.json with the shell (npm run build:site copies it)"],
      [{ STUB_NO_INDEX: "profiles" }, "deploy-app: REFUSED: dist/profiles/index.json is missing: the deploy serves QED64's tracked public/profiles/index.json with the shell (npm run build:site copies it)"],
      [{ STUB_INDEX_DRIFT: "1" }, "deploy-app: REFUSED: dist/profiles/index.json is not byte-identical to the tracked public/profiles/index.json"],
      [{ STUB_SYMLINK: "1" }, "deploy-app: REFUSED: dist/snapshots is a symlink: the deploy carries a plain dist/snapshots/ holding only index.json"],
    ] as [Record<string, string>, string][]) {
      for (const args of [[], ["--dry-run"]]) {
        const r = run(args, extra);
        const label = JSON.stringify({ ...extra, args });
        expect(r.status, label).toBe(1);
        expect(r.argv, label).toEqual(BUILD);
        expect(r.stderr.trim().split("\n"), label).toEqual([line]);
      }
    }
  });

  it("without --dry-run: the same steps, then `npx wrangler deploy`", () => {
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual([...BUILD, GUARD, "npx wrangler deploy"]);
  });

  it("a guard refusal stops the script with exit 1 before any deploy (also with --dry-run)", () => {
    for (const args of [[], ["--dry-run"]]) {
      const r = run(args, { STUB_GUARD_EXIT: "1" });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.argv).toEqual([...BUILD, GUARD]);
      expect(r.stdout).not.toContain("would run");
      expect(r.stderr.trimEnd().split("\n").at(-1)).toBe("deploy-guard: REFUSED: stub");
    }
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

  // vite build exits 1 on an error, the same code as the size refusal: only the REFUSED line tells them apart.
  it("a build failing with exit 1 stops the script with 1 and no REFUSED line", () => {
    const r = run([], { STUB_FAIL: "build:site", STUB_FAIL_CODE: "1" });
    expect(r.status).toBe(1);
    expect(r.argv).toEqual(BUILD);
    expect(r.stderr).not.toMatch(/deploy-app: REFUSED:/);
  });

  it("refuses an unknown argument with exit 2 before running anything", () => {
    const r = run(["--dryrun"]);
    expect(r.status).toBe(2);
    expect(r.argv).toEqual([]);
    expect(r.stderr).toContain("usage: scripts/deploy-app.sh [--dry-run]");
  });
});
