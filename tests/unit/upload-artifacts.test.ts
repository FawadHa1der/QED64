// scripts/upload-artifacts.sh under decision 3: QED64 uploads only its
// site-owned files (public/snapshots/, public/profiles/index.json); the
// toolchain release (runtime, packs) is its owner's, under
// lean4-wasm64/<id>/, and must already be in R2. The script runs here for
// real, from a scratch copy of the repository layout under the OS temp dir,
// with `rclone` replaced by a stub on an explicit PATH that records its argv
// (and answers `lsf` from STUB_R2_HAS_RELEASE, or fails it with STUB_LSF_EXIT
// and STUB_LSF_STDERR): no network, no credentials.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const SCRIPT = "scripts/upload-artifacts.sh";
const ID = "lean-v4.34.0-a8817d0";
const BUILD = "wasm64-3ab1c6a9da03bc29";
const R2 = "qed64-r2:qed64-artifacts";

describe("scripts/upload-artifacts.sh against a stubbed rclone", () => {
  let tmp: string, repo: string, bin: string, log: string, elsewhere: string;

  const write = (rel: string, data: string) => {
    const f = path.join(repo, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  };
  const layout = ({ manifestBuild = BUILD, snapshotBuild = BUILD } = {}) => {
    fs.rmSync(path.join(repo, "public"), { recursive: true, force: true });
    write("toolchain/lean4-wasm64-release.json", JSON.stringify({ schema: "lean4-wasm64.release/v1", id: ID, runtime: { buildId: BUILD } }));
    write("public/runtime/runtime-manifest.json", JSON.stringify({ buildId: manifestBuild, files: { "lean.wasm": { chunks: [{ url: "/runtime/chunks/c.part-000" }] } } }));
    write("public/runtime/chunks/c.part-000", "chunk");
    write("public/profiles/index.json", JSON.stringify({ profiles: [] }));
    write("public/profiles/lean-core.manifest.json", "{}");
    write("public/snapshots/index.json", JSON.stringify({ snapshots: [{ name: "init", url: "/snapshots/init.0123456789abcdef.snapz", runtime: snapshotBuild }] }));
    write("public/snapshots/init.0123456789abcdef.snapz", "snap");
  };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-upload-artifacts-"));
    repo = path.join(tmp, "repo");
    bin = path.join(tmp, "bin");
    log = path.join(tmp, "argv.log");
    elsewhere = path.join(tmp, "elsewhere");
    for (const d of [path.join(repo, "scripts"), bin, elsewhere]) fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(path.join(root, SCRIPT), path.join(repo, SCRIPT));
    fs.writeFileSync(path.join(bin, "rclone"), [
      "#!/bin/sh",
      'printf "rclone %s\\n" "$*" >> "$STUB_LOG"',
      'if [ "$1" = lsf ]; then',
      '  [ -n "$STUB_LSF_STDERR" ] && printf "%s\\n" "$STUB_LSF_STDERR" >&2',
      '  [ -n "$STUB_LSF_EXIT" ] && exit "$STUB_LSF_EXIT"',
      '  [ "$STUB_R2_HAS_RELEASE" = 1 ] && echo release.json; exit 0',
      'fi',
      "",
    ].join("\n"), { mode: 0o755 });
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
  });
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const run = (args: string[], extra: Record<string, string> = {}) => {
    fs.rmSync(log, { force: true });
    // An explicit environment: the stubs first, then only the system tools; nothing inherited (no credentials).
    const env = { PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log, STUB_R2_HAS_RELEASE: "1", HOME: tmp, TMPDIR: tmp, ...extra };
    const r = spawnSync("/bin/bash", [path.join(repo, SCRIPT), ...args], { cwd: elsewhere, env, encoding: "utf8", timeout: 30_000 });
    const argv = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    return { ...r, argv };
  };
  const LSF = `rclone lsf ${R2}/lean4-wasm64/${ID}/release.json`;
  const SITE = [
    `rclone copy public/snapshots ${R2}/snapshots --checksum --transfers 4 --s3-chunk-size 64M --progress`,
    `rclone copyto public/profiles/index.json ${R2}/profiles/index.json --checksum --s3-no-check-bucket`,
  ];
  const ROOT = ["runtime", "profiles"].map((d) => `rclone copy public/${d} ${R2}/${d} --checksum --transfers 4 --s3-chunk-size 64M --progress`);

  it("default: checks the release is in R2, then uploads only snapshots/ and profiles/index.json (no per-build manifest copy)", () => {
    layout();
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual([LSF, ...SITE, `rclone ls ${R2}/snapshots`]);
    expect(r.stderr).toContain(`preflight ok: release ${ID}, runtime ${BUILD}, 1 snapshots`);
    expect(fs.readdirSync(path.join(repo, "public/runtime"))).toEqual(["chunks", "runtime-manifest.json"]);
  });

  it("refuses in one line, exit 3, when the release is not in R2, before any write", () => {
    layout();
    const r = run([], { STUB_R2_HAS_RELEASE: "0" });
    expect(r.status).toBe(3);
    expect(r.argv).toEqual([LSF]);
    expect(r.stderr.trim().split("\n").filter((l) => !l.startsWith("preflight ok"))).toEqual([
      `upload-artifacts: REFUSED: the toolchain release ${ID} is not in R2 (its owner uploads it: lean4-wasm64 formats/HOSTING.md)`,
    ]);
  });

  it("an lsf that fails (no remote, credentials, network) is reported as such, not as a missing release; exit 3, no write", () => {
    layout();
    const err = 'CRITICAL: Failed to create file system for "qed64-r2:qed64-artifacts/x": didn\'t find section in config file ("qed64-r2")';
    for (const extra of [{ STUB_LSF_EXIT: "1", STUB_LSF_STDERR: `2026/10/06 12:00:00 ${err}\nsecond line` }, { STUB_LSF_EXIT: "1", STUB_LSF_STDERR: `2026/10/06 ${err}`, DRY_RUN: "1" }]) {
      const r = run([], extra);
      expect(r.status).toBe(3);
      expect(r.argv).toEqual([LSF]);
      expect(r.stdout).toBe("");
      expect(r.stderr.trim().split("\n").filter((l) => !l.startsWith("preflight ok"))).toEqual([
        `upload-artifacts: cannot check R2 (rclone lsf exit 1): ${extra.STUB_LSF_STDERR.split("\n")[0]}`,
      ]);
    }
    const silent = run([], { STUB_LSF_EXIT: "7" });
    expect([silent.status, silent.stderr]).toEqual([3, expect.stringContaining("upload-artifacts: cannot check R2 (rclone lsf exit 7): no error output")]);
    // rclone's own "not found" exits (3 directory, 4 file) mean R2 answered: the release is absent
    for (const code of ["3", "4"]) {
      const r = run([], { STUB_LSF_EXIT: code, STUB_LSF_STDERR: "ERROR : error listing: directory not found" });
      expect([r.status, r.argv]).toEqual([3, [LSF]]);
      expect(r.stderr).toContain(`upload-artifacts: REFUSED: the toolchain release ${ID} is not in R2`);
      expect(r.stderr).not.toContain("cannot check R2");
    }
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith("upload-artifacts-lsf."))).toEqual([]); // its stderr file is removed
  });

  it("refuses, exit 3 and no rclone at all, a shell or a snapshot of another runtime than the release's", () => {
    for (const [opts, msg] of [
      [{ manifestBuild: "wasm64-0000000000000000" }, `public/runtime/runtime-manifest.json is runtime wasm64-0000000000000000, the toolchain release ${ID} is ${BUILD}`],
      [{ snapshotBuild: "wasm64-0000000000000000" }, `snapshot init is for runtime wasm64-0000000000000000, the toolchain release ${ID} is ${BUILD}`],
    ] as const) {
      layout(opts);
      const r = run([]);
      expect(r.status, msg).toBe(3);
      expect(r.argv, msg).toEqual([]);
      expect(r.stderr, msg).toContain(`upload-artifacts: ${msg}`);
    }
    layout();
    fs.rmSync(path.join(repo, "public/snapshots/init.0123456789abcdef.snapz"));
    const missing = run([]);
    expect([missing.status, missing.argv]).toEqual([3, []]);
    expect(missing.stderr).toContain("MISSING: public/snapshots/init.0123456789abcdef.snapz");
  });

  it("--legacy-root: also the per-build manifest copy and runtime/ + profiles/ at the bucket root", () => {
    layout();
    const r = run(["--legacy-root"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual([LSF, ...SITE, ...ROOT, `rclone ls ${R2}/snapshots`]);
    expect(fs.existsSync(path.join(repo, `public/runtime/runtime-manifest.${BUILD}.json`))).toBe(true);
    expect(r.stderr).toContain("1 chunks (--legacy-root)");
    // its preflight also needs the chunks
    layout();
    fs.rmSync(path.join(repo, "public/runtime/chunks/c.part-000"));
    const missing = run(["--legacy-root"]);
    expect([missing.status, missing.argv]).toEqual([3, []]);
    expect(run([]).status).toBe(0); // the default mode uploads no chunks, so it does not need them
  });

  it("DRY_RUN=1 prints the plan and writes nothing (the R2 check, a read, still runs)", () => {
    layout();
    for (const args of [[], ["--legacy-root"]]) {
      const r = run(args, { DRY_RUN: "1" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv).toEqual([LSF]);
      const plan = r.stdout.trim().split("\n");
      expect(plan).toEqual([
        ...SITE.map((c) => `would run: ${c}`),
        ...(args.length ? [`would run: cp public/runtime/runtime-manifest.json public/runtime/runtime-manifest.${BUILD}.json`, ...ROOT.map((c) => `would run: ${c}`)] : []),
        "dry run: nothing uploaded",
      ]);
      expect(fs.existsSync(path.join(repo, `public/runtime/runtime-manifest.${BUILD}.json`))).toBe(false);
    }
    const refused = run([], { DRY_RUN: "1", STUB_R2_HAS_RELEASE: "0" });
    expect(refused.status).toBe(3);
  });

  it("refuses an unknown argument with exit 2 before running anything", () => {
    layout();
    const r = run(["--legacy"]);
    expect(r.status).toBe(2);
    expect(r.argv).toEqual([]);
    expect(r.stderr).toContain("usage: [DRY_RUN=1] scripts/upload-artifacts.sh [--legacy-root]");
  });
});
