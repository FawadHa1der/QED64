// scripts/upload-artifacts.sh under decision 3: QED64 uploads only its
// site-owned files (public/snapshots/, public/profiles/index.json); the
// toolchain release (runtime, packs) is its owner's, under
// lean4-wasm64/<id>/, and must already be in R2. The script runs here for
// real, from a scratch copy of the repository layout under the OS temp dir,
// with `rclone` replaced by a stub on an explicit PATH that records its argv
// (and answers `lsf` from STUB_R2_HAS_RELEASE, or fails it with STUB_LSF_EXIT
// and STUB_LSF_STDERR; any other lsf from STUB_R2_HAS, `cat` of R2's mutable
// indexes from STUB_R2_SNAPSHOT_INDEX / STUB_R2_PROFILE_INDEX): no network, no
// credentials.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const SCRIPT = "scripts/upload-artifacts.sh";
const ID = "lean-v4.34.0-a8817d0";
const BUILD = "wasm64-3ab1c6a9da03bc29";
const LIVE = "wasm64-f69cca24d0878a58"; // the runtime R2's mutable indexes name before this upload (the deployed pairing)
const R2 = "qed64-r2:qed64-artifacts";

describe("scripts/upload-artifacts.sh against a stubbed rclone", () => {
  let tmp: string, repo: string, bin: string, log: string, elsewhere: string;

  const write = (rel: string, data: string) => {
    const f = path.join(repo, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  };
  const layout = ({ manifestBuild = BUILD, snapshotBuild = BUILD, profileBuild = BUILD as string | null } = {}) => {
    fs.rmSync(path.join(repo, "public"), { recursive: true, force: true });
    write("toolchain/lean4-wasm64-release.json", JSON.stringify({ schema: "lean4-wasm64.release/v1", id: ID, runtime: { buildId: BUILD } }));
    write("public/runtime/runtime-manifest.json", JSON.stringify({ buildId: manifestBuild, files: { "lean.wasm": { chunks: [{ url: "/runtime/chunks/c.part-000" }] } } }));
    write("public/runtime/chunks/c.part-000", "chunk");
    write("public/profiles/index.json", JSON.stringify({ ...(profileBuild === null ? {} : { runtime: { buildId: profileBuild } }), profiles: [] }));
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
      '  case "$2" in',
      '    */release.json)',
      '      [ -n "$STUB_LSF_STDERR" ] && printf "%s\\n" "$STUB_LSF_STDERR" >&2',
      '      [ -n "$STUB_LSF_EXIT" ] && exit "$STUB_LSF_EXIT"',
      '      [ "$STUB_R2_HAS_RELEASE" = 1 ] && echo release.json; exit 0 ;;',
      '    *) for k in $STUB_R2_HAS; do [ "qed64-r2:qed64-artifacts/$k" = "$2" ] && basename "$k"; done; exit 0 ;;',
      '  esac',
      'fi',
      'if [ "$1" = cat ]; then',
      '  case "$2" in',
      '    */snapshots/index.json) [ -n "$STUB_R2_SNAPSHOT_INDEX" ] && printf "%s" "$STUB_R2_SNAPSHOT_INDEX" && exit 0 ;;',
      '    */profiles/index.json) [ -n "$STUB_R2_PROFILE_INDEX" ] && printf "%s" "$STUB_R2_PROFILE_INDEX" && exit 0 ;;',
      '  esac',
      '  echo "ERROR : $2: object not found" >&2; exit 3',
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
  /** Step 1's reads: the runtime R2's mutable indexes name now. */
  const READS = [`rclone cat ${R2}/snapshots/index.json`, `rclone cat ${R2}/profiles/index.json`];
  /** Step 2: this runtime's per-build copies, from the mutable files, before them (HARDENING #64). */
  const PINS = [
    `rclone copyto public/snapshots/index.json ${R2}/snapshots/index.${BUILD}.json --checksum --s3-no-check-bucket`,
    `rclone copyto public/profiles/index.json ${R2}/snapshots/profiles-index.${BUILD}.json --checksum --s3-no-check-bucket`,
  ];
  const SITE = [
    `rclone copy public/snapshots ${R2}/snapshots --exclude index.*.json --exclude profiles-index.*.json --checksum --transfers 4 --s3-chunk-size 64M --progress`,
    `rclone copyto public/profiles/index.json ${R2}/profiles/index.json --checksum --s3-no-check-bucket`,
  ];
  const ROOT = ["runtime", "profiles"].map((d) => `rclone copy public/${d} ${R2}/${d} --checksum --transfers 4 --s3-chunk-size 64M --progress`);

  it("default: checks the release is in R2, then uploads only snapshots/ and profiles/index.json (no per-build manifest copy), each index's per-build copy first", () => {
    layout();
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual([LSF, ...READS, ...PINS, ...SITE, `rclone ls ${R2}/snapshots`]);
    expect(r.stderr).toContain(`preflight ok: release ${ID}, runtime ${BUILD}, 1 snapshots`);
    expect(fs.readdirSync(path.join(repo, "public/runtime"))).toEqual(["chunks", "runtime-manifest.json"]);
    // the per-build index copies go to R2 straight from the mutable files: nothing is written locally
    expect(fs.readdirSync(path.join(repo, "public/snapshots")).sort()).toEqual(["index.json", "init.0123456789abcdef.snapz"]);
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
    for (const extra of [{ STUB_LSF_EXIT: "1", STUB_LSF_STDERR: `2026/10/06 12:00:00 ${err}\nsecond line` }, { STUB_LSF_EXIT: "1", STUB_LSF_STDERR: `2026/10/06 ${err}`, DRY_RUN: "1" }] as Record<string, string>[]) {
      const r = run([], extra);
      expect(r.status).toBe(3);
      expect(r.argv).toEqual([LSF]);
      expect(r.stdout).toBe("");
      expect(r.stderr.trim().split("\n").filter((l) => !l.startsWith("preflight ok"))).toEqual([
        `upload-artifacts: cannot check R2 (rclone lsf exit 1): ${(extra.STUB_LSF_STDERR ?? "").split("\n")[0]}`,
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
      // its per-build copy is named by this runtime, so the profile index must be this runtime's
      [{ profileBuild: "wasm64-0000000000000000" }, `public/profiles/index.json is for runtime wasm64-0000000000000000, the toolchain release ${ID} is ${BUILD}`],
      [{ profileBuild: null }, `public/profiles/index.json is for runtime (none recorded), the toolchain release ${ID} is ${BUILD}`],
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
    expect(r.argv).toEqual([LSF, ...READS, ...PINS, ...SITE, ...ROOT, `rclone ls ${R2}/snapshots`]);
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
      expect(r.argv).toEqual([LSF, ...READS]);
      const plan = r.stdout.trim().split("\n");
      expect(plan).toEqual([
        ...[...PINS, ...SITE].map((c) => `would run: ${c}`),
        ...(args.length ? [`would run: cp public/runtime/runtime-manifest.json public/runtime/runtime-manifest.${BUILD}.json`, ...ROOT.map((c) => `would run: ${c}`)] : []),
        "dry run: nothing uploaded",
      ]);
      expect(fs.existsSync(path.join(repo, `public/runtime/runtime-manifest.${BUILD}.json`))).toBe(false);
    }
    const refused = run([], { DRY_RUN: "1", STUB_R2_HAS_RELEASE: "0" });
    expect(refused.status).toBe(3);
  });

  // HARDENING #64: the shell deployed with R2's CURRENT pairing reads that runtime's per-build copies;
  // the first upload after the change (or a copy lost) finds none, so the upload makes them inside R2
  // from the mutable indexes BEFORE it replaces those.
  const r2Snapshots = (rt: string | string[]) => JSON.stringify({ snapshots: [rt].flat().map((runtime, i) => ({ name: `s${i}`, runtime })) });
  const r2Profiles = (rt: string) => JSON.stringify({ runtime: { buildId: rt }, profiles: [] });
  const LIVE_S = `snapshots/index.${LIVE}.json`;
  const LIVE_P = `snapshots/profiles-index.${LIVE}.json`;
  const PRESERVE = [
    `rclone cat ${R2}/snapshots/index.json`, `rclone lsf ${R2}/${LIVE_S}`, `rclone copyto ${R2}/snapshots/index.json ${R2}/${LIVE_S} --s3-no-check-bucket`,
    `rclone cat ${R2}/profiles/index.json`, `rclone lsf ${R2}/${LIVE_P}`, `rclone copyto ${R2}/profiles/index.json ${R2}/${LIVE_P} --s3-no-check-bucket`,
  ];

  it("pins R2's current pairing first: its indexes are copied inside R2 to their per-build names when absent, before anything is replaced", () => {
    layout();
    const live = { STUB_R2_SNAPSHOT_INDEX: r2Snapshots([LIVE, LIVE]), STUB_R2_PROFILE_INDEX: r2Profiles(LIVE) };
    const r = run([], live);
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual([LSF, ...PRESERVE, ...PINS, ...SITE, `rclone ls ${R2}/snapshots`]);
    expect(r.stderr).toContain(`upload-artifacts: R2's snapshots/index.json is runtime ${LIVE}, which has no ${LIVE_S} yet: copying it there first (HARDENING #64)`);
    expect(r.stderr).toContain(`upload-artifacts: R2's profiles/index.json is runtime ${LIVE}, which has no ${LIVE_P} yet: copying it there first (HARDENING #64)`);
    // DRY_RUN reads and prints the copies, writes nothing
    const dry = run([], { ...live, DRY_RUN: "1" });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.argv).toEqual([LSF, ...PRESERVE.filter((c) => !c.includes("copyto"))]);
    expect(dry.stdout.trim().split("\n").slice(0, 2)).toEqual(PRESERVE.filter((c) => c.includes("copyto")).map((c) => `would run: ${c}`));
    // a copy already there is never overwritten (only the missing one is made)
    const one = run([], { ...live, STUB_R2_HAS: LIVE_S });
    expect(one.argv).toEqual([LSF, ...PRESERVE.filter((c) => !c.includes(`${R2}/${LIVE_S} --s3`)), ...PINS, ...SITE, `rclone ls ${R2}/snapshots`]);
    const both = run([], { ...live, STUB_R2_HAS: `${LIVE_S} ${LIVE_P}` });
    expect(both.argv).toEqual([LSF, ...PRESERVE.filter((c) => !c.includes("copyto")), ...PINS, ...SITE, `rclone ls ${R2}/snapshots`]);
  });

  it("pins nothing from R2 when its indexes are this upload's runtime, mixed, unreadable or absent", () => {
    layout();
    for (const extra of [
      { STUB_R2_SNAPSHOT_INDEX: r2Snapshots(BUILD), STUB_R2_PROFILE_INDEX: r2Profiles(BUILD) }, // a re-upload of the same pairing
      { STUB_R2_SNAPSHOT_INDEX: r2Snapshots([LIVE, BUILD]), STUB_R2_PROFILE_INDEX: "not json" },
      { STUB_R2_SNAPSHOT_INDEX: "<!doctype html>", STUB_R2_PROFILE_INDEX: JSON.stringify({ profiles: [] }) },
      {}, // a fresh bucket: cat finds nothing
    ] as Record<string, string>[]) {
      const r = run([], extra);
      expect(r.status, r.stderr).toBe(0);
      expect(r.argv, JSON.stringify(extra)).toEqual([LSF, ...READS, ...PINS, ...SITE, `rclone ls ${R2}/snapshots`]);
    }
  });

  it("refuses an unknown argument with exit 2 before running anything", () => {
    layout();
    const r = run(["--legacy"]);
    expect(r.status).toBe(2);
    expect(r.argv).toEqual([]);
    expect(r.stderr).toContain("usage: [DRY_RUN=1] scripts/upload-artifacts.sh [--legacy-root]");
  });
});
