// scripts/upload-artifacts.sh under decision 3 and D2: QED64 uploads only its
// snapshots, each .snapz its tracked index names and each overlay directory
// whole; never an index (both ship in the deploy, docs/DEPLOY.md "Atomic
// deploys") and never a per-build copy. The toolchain release (runtime,
// packs) is its owner's, under lean4-wasm64/<id>/, and must already be in R2.
// The script runs here for real, from a scratch copy of the repository layout
// under the OS temp dir, with `rclone` replaced by a stub on an explicit PATH
// that records its argv (and answers `lsf` of release.json from
// STUB_R2_HAS_RELEASE, or fails it with STUB_LSF_EXIT and STUB_LSF_STDERR;
// with STUB_PUTS, each `copy` or `copyto` appends the R2 keys it lands as one
// line, one transfer; a `copy` then fails with STUB_COPY_EXIT, a `copyto` with
// STUB_COPYTO_EXIT): no network, no credentials.
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
      '  [ -n "$STUB_LSF_STDERR" ] && printf "%s\\n" "$STUB_LSF_STDERR" >&2',
      '  [ -n "$STUB_LSF_EXIT" ] && exit "$STUB_LSF_EXIT"',
      '  case "$2" in */release.json) [ "$STUB_R2_HAS_RELEASE" = 1 ] && echo release.json ;; esac',
      '  exit 0',
      'fi',
      'if [ "$1" = copy ] || [ "$1" = copyto ]; then',
      '  verb=$1 src=$2 dst=${3#qed64-r2:qed64-artifacts/}; shift 3; ex=',
      '  while [ $# -gt 0 ]; do [ "$1" = --exclude ] && { ex="$ex $2"; shift; }; shift; done',
      '  set -f',
      '  if [ "$verb" = copyto ]; then keys=$dst; else',
      // the files rclone would send: every file under the source, less those an --exclude names (a pattern that starts
      // with / is anchored to the source root, as rclone's are; any other matches the file name at any depth)
      '    keys=$(cd "$src" && find . -type f | sed "s|^\\./||" | sort | while read -r f; do',
      '      skip=; for p in $ex; do case "$p" in (/*) case "/$f" in ($p) skip=1 ;; esac ;; (*) case "${f##*/}" in ($p) skip=1 ;; esac ;; esac; done',
      '      [ -n "$skip" ] || printf "%s " "$dst/$f"; done)',
      '  fi',
      '  [ -n "$STUB_PUTS" ] && echo $keys >> "$STUB_PUTS"',
      '  if [ "$verb" = copy ] && [ -n "$STUB_COPY_EXIT" ]; then exit "$STUB_COPY_EXIT"; fi',
      '  if [ "$verb" = copyto ] && [ -n "$STUB_COPYTO_EXIT" ]; then exit "$STUB_COPYTO_EXIT"; fi',
      '  exit 0',
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
    everyArgv.push(...argv);
    return { ...r, argv };
  };
  /** Every rclone command line of every run in this file, for the last test. */
  const everyArgv: string[] = [];
  const LSF = `rclone lsf ${R2}/lean4-wasm64/${ID}/release.json`;
  /** One named .snapz, a single copyto (multipart, no bucket check: an object-scoped token cannot create one). */
  const SNAPZ_PUT = (f: string) => `rclone copyto public/snapshots/${f} ${R2}/snapshots/${f} --checksum --s3-chunk-size 64M --s3-no-check-bucket --progress`;
  /** An overlay directory, whole, without any per-build copy of its own index. */
  const OVERLAY_PUT = (o: string) => `rclone copy public/snapshots/${o} ${R2}/snapshots/${o} --exclude index.*.json --exclude profiles-index.*.json --checksum --transfers 4 --s3-chunk-size 64M --progress`;
  /** The default layout's whole upload: its one named .snapz. */
  const SITE = [SNAPZ_PUT("init.0123456789abcdef.snapz")];

  it("uploads only the .snapz the index names; never an index or a per-build copy", () => {
    layout();
    const r = run([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual([LSF, ...SITE, `rclone ls ${R2}/snapshots`]);
    expect(r.stderr).toContain(`preflight ok: release ${ID}, runtime ${BUILD}, 1 snapshots`);
    expect(r.stdout).toContain("snapshot upload complete; nothing a visitor sees has changed. Next: push main");
    expect(r.stdout).not.toContain("wrangler deploy");
    expect(fs.readdirSync(path.join(repo, "public/runtime"))).toEqual(["chunks", "runtime-manifest.json"]);
    // nothing is written locally
    expect(fs.readdirSync(path.join(repo, "public/snapshots")).sort()).toEqual(["index.json", "init.0123456789abcdef.snapz"]);
  });

  // The two indexes ship in the deploy (D2), so the upload's set is exactly the guard's: the .snapz the
  // committed index names (an older bake still in the checkout is not re-sent), plus overlays, whose own
  // index travels with them as before.
  it("exactly the named .snapz, each overlay directory whole; never an index of its own; a failed copy stops the upload", () => {
    layout();
    const MATHLIB = "mathlib.fedcba9876543210.snapz";
    write("public/snapshots/index.json", JSON.stringify({ snapshots: [
      { name: "init", url: "/snapshots/init.0123456789abcdef.snapz", runtime: BUILD },
      { name: "mathlib", url: `/snapshots/${MATHLIB}`, runtime: BUILD },
    ] }));
    write(`public/snapshots/${MATHLIB}`, "mathlib snap");
    // an older bake the index no longer names
    write("public/snapshots/old.aaaaaaaaaaaaaaaa.snapz", "stale snap");
    // an overlay set (README: public/snapshots/<overlay>/, opened with ?snapshots=snapshots/<overlay>)
    write("public/snapshots/widgets8/index.json", "overlay index");
    write("public/snapshots/widgets8/hasse.aaaaaaaaaaaaaaaa.snapz", "overlay snap");
    write(`public/snapshots/widgets8/index.${BUILD}.json`, "overlay copy");
    // local per-build copies an earlier promote or fetch-artifacts left beside the indexes (neither writes them since D2)
    write(`public/snapshots/index.${BUILD}.json`, "local copy");
    write(`public/snapshots/profiles-index.${BUILD}.json`, "local copy");
    const puts = path.join(tmp, "puts.log");
    // each line: the keys one rclone write lands, in no order among themselves (one transfer)
    const landed = (extra: Record<string, string> = {}) => {
      fs.rmSync(puts, { force: true });
      const r = run([], { STUB_PUTS: puts, ...extra });
      const batches = fs.existsSync(puts) ? fs.readFileSync(puts, "utf8").trim().split("\n").map((l) => l.split(" ").sort()) : [];
      return { ...r, batches };
    };
    const PLAN = [SNAPZ_PUT("init.0123456789abcdef.snapz"), SNAPZ_PUT(MATHLIB), OVERLAY_PUT("widgets8")];

    const r = landed();
    expect(r.status, r.stderr).toBe(0);
    expect(r.batches).toEqual([
      ["snapshots/init.0123456789abcdef.snapz"],
      [`snapshots/${MATHLIB}`],
      ["snapshots/widgets8/hasse.aaaaaaaaaaaaaaaa.snapz", "snapshots/widgets8/index.json"],
    ]);
    expect(r.argv).toEqual([LSF, ...PLAN, `rclone ls ${R2}/snapshots`]);
    const keys = r.batches.flat();
    for (const k of ["snapshots/index.json", "profiles/index.json", "snapshots/old.aaaaaaaaaaaaaaaa.snapz"]) expect(keys, k).not.toContain(k);
    expect(keys.filter((k) => /^snapshots\/(?:profiles-)?index\.[^/]*\.json$/.test(k))).toEqual([]);
    expect(keys.filter((k) => /index\.wasm64-/.test(k))).toEqual([]);

    // a copy that fails stops the upload there (set -e): nothing after it is sent
    const failed = landed({ STUB_COPYTO_EXIT: "1" });
    expect(failed.status).toBe(1);
    expect(failed.batches).toEqual(r.batches.slice(0, 1));
    expect(failed.argv).toEqual([LSF, PLAN[0]]);

    // DRY_RUN prints the same plan and lands nothing
    const dry = landed({ DRY_RUN: "1" });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.batches).toEqual([]);
    expect(dry.argv).toEqual([LSF]);
    expect(dry.stdout.trim().split("\n")).toEqual(PLAN.map((c) => `would run: ${c}`).concat("dry run: nothing uploaded"));
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
      // the deploy serves the profile index with the record, so it must be this runtime's
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
    // an entry the upload could not send as one snapshots/<file> key (the deploy guard refuses it too)
    layout();
    write("public/snapshots/sub/init.0123456789abcdef.snapz", "snap");
    write("public/snapshots/index.json", JSON.stringify({ snapshots: [{ name: "init", url: "/snapshots/sub/init.0123456789abcdef.snapz", runtime: BUILD }] }));
    const nested = run([]);
    expect([nested.status, nested.argv]).toEqual([3, []]);
    expect(nested.stderr).toContain('upload-artifacts: snapshot init names "/snapshots/sub/init.0123456789abcdef.snapz", not a .snapz directly under /snapshots/');
  });

  it("--legacy-root is retired: refused with exit 2 before anything runs (the Worker never reads root runtime/ or profiles/)", () => {
    layout();
    const r = run(["--legacy-root"]);
    expect([r.status, r.argv]).toEqual([2, []]);
    expect(r.stderr).toContain("upload-artifacts: --legacy-root is retired");
    expect(fs.existsSync(path.join(repo, `public/runtime/runtime-manifest.${BUILD}.json`))).toBe(false);
    // the upload uploads no chunks, so its preflight does not need them
    fs.rmSync(path.join(repo, "public/runtime/chunks/c.part-000"));
    expect(run([]).status).toBe(0);
  });

  it("DRY_RUN=1 prints the plan and writes nothing (the R2 check, a read, still runs)", () => {
    layout();
    const r = run([], { DRY_RUN: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toEqual([LSF]);
    expect(r.stdout.trim().split("\n")).toEqual([...[...SITE].map((c) => `would run: ${c}`), "dry run: nothing uploaded"]);
    const refused = run([], { DRY_RUN: "1", STUB_R2_HAS_RELEASE: "0" });
    expect(refused.status).toBe(3);
  });

  it("refuses an unknown argument with exit 2 before running anything", () => {
    layout();
    const r = run(["--legacy"]);
    expect(r.status).toBe(2);
    expect(r.argv).toEqual([]);
    expect(r.stderr).toContain("usage: [DRY_RUN=1] scripts/upload-artifacts.sh");
  });

  // Last, over every run above: R2's indexes and per-build copies are frozen since D2, so no command
  // reads one (no cat) or names one as a source or a key (the overlay's --exclude patterns aside).
  it("no run read or wrote an index: no rclone cat, no index.json or profiles-index key", () => {
    expect(everyArgv.length).toBeGreaterThan(10);
    const named = everyArgv.map((l) => l.replace(/ --exclude \S+/g, ""));
    expect(named.filter((l) => / cat |index\.json|profiles-index/.test(l) && l !== LSF)).toEqual([]);
  });
});
