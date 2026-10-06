// pipeline/release/adopt-release.sh --dry-run (plan step B2a), run for real
// against FAKES: a hand-written release dir (release.json with a valid
// self-digest, releaseDigest = sha256(JSON.stringify(rest, null, 2))), a tools
// dir whose cli.mjs only records its argv, a fake served tree
// (QED64_PUBLIC_DIR) and an isolated --public. Nothing here fetches, unpacks,
// bakes or boots a runtime; a dry run calls the package for --version only.
// Plus adopt-helper.mjs's tree digest and base-tree.json.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TREE_DIGEST_RULE, releaseDigest, treeDigest } from "../../pipeline/release/adopt-helper.mjs";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "pipeline/release/adopt-release.sh");
const helper = path.join(root, "pipeline/release/adopt-helper.mjs");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const SERVED_ID = "wasm64-00000000000000aa";
const NEW_ID = "wasm64-0123456789abcdef";
const RAW = { "lean-core": sha("core"), "mathlib-essential": sha("essential"), "lean-lib": sha("lean-lib") };
const ID = "lean-v9.9.9-abc1234";

let tmp: string;
let tools: string;
let served: string;
let pub: string;
let umbrella: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qed64-adopt-")));
  tools = path.join(tmp, "tools");
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, "package.json"), JSON.stringify({ name: "lean4-wasm64", version: "0.0.0-fake", type: "module" }));
  fs.writeFileSync(path.join(tools, "cli.mjs"), [
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(path.join(tools, "argv.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'if (process.argv[2] === "--version") console.log("0.0.0-fake");',
    // FAKE_FETCH_FAIL: every fetch fails the way fetch-release.mjs does (one stderr line, exit 1), before writing
    'if (process.argv[2] === "fetch" && process.env.FAKE_FETCH_FAIL) { console.error(process.env.FAKE_FETCH_FAIL); process.exit(1); }',
    "",
  ].join("\n"));
  // The served tree adopt-release compares against (QED64's public/, here a fake).
  served = path.join(tmp, "served");
  fs.mkdirSync(path.join(served, "runtime"), { recursive: true });
  fs.mkdirSync(path.join(served, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(served, "runtime/runtime-manifest.json"), JSON.stringify({ buildId: SERVED_ID }));
  fs.writeFileSync(path.join(served, "profiles/index.json"), JSON.stringify({
    schema: "qed64.profile-index/v1",
    profiles: [{ id: "core", manifest: "/profiles/lean-core.manifest.json" }, { id: "essential", manifest: "/profiles/mathlib-essential.manifest.json" }],
  }));
  for (const id of ["lean-core", "mathlib-essential"] as const) {
    fs.writeFileSync(path.join(served, `profiles/${id}.manifest.json`), JSON.stringify({ content: { pack: { digest: `sha256:${RAW[id]}` } } }));
  }
  // The isolated served tree, filled: the three mutable manifests and every profile manifest the index lists.
  pub = path.join(tmp, "public-isolated");
  for (const f of ["runtime/runtime-manifest.json", "snapshots/index.json", "profiles/lean-core.manifest.json", "profiles/mathlib-essential.manifest.json"]) {
    fs.mkdirSync(path.dirname(path.join(pub, f)), { recursive: true });
    fs.writeFileSync(path.join(pub, f), "{}");
  }
  fs.copyFileSync(path.join(served, "profiles/index.json"), path.join(pub, "profiles/index.json"));
  umbrella = path.join(tmp, "umbrella");
  fs.mkdirSync(path.join(umbrella, "QED64"), { recursive: true });
  fs.writeFileSync(path.join(umbrella, "QED64/Essential.olean"), "olean");
  fs.writeFileSync(path.join(umbrella, "QED64/Essential.olean.server"), "server");
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

type Release = Record<string, unknown> & { digest?: string };
/** A release dir holding only release.json, self-digested unless `digest` is given. */
function fakeRelease(name: string, edit: (r: Release) => void = () => {}, digest?: string) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const r: Release = {
    schema: "lean4-wasm64.release/v1",
    id: ID,
    lean: { version: "9.9.9" },
    kernel: { commit: "ab".repeat(20), patch: "0036" },
    runtime: { buildId: NEW_ID, files: { "lean.wasm": { bytes: 42 } } },
    packs: Object.entries(RAW).map(([id, raw]) => ({ id, release: `${id}-9.9.9`, rawSha256: raw, rawBytes: 1 })),
    tools: { version: "9.9.9-abc1234" },
  };
  edit(r);
  delete r.digest;
  const record = { ...r, digest: digest ?? releaseDigest(r) };
  fs.writeFileSync(path.join(dir, "release.json"), `${JSON.stringify(record, null, 2)}\n`);
  return { dir, digest: record.digest as string };
}

/** Every file under `dir` with its digest: "nothing was written". */
function state(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = e.isSymbolicLink() ? `-> ${fs.readlinkSync(full)}` : sha(fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function adopt(args: string[], env: Record<string, string> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, QED64_PUBLIC_DIR: served };
  delete base.LEAN4_WASM64_DIR;
  fs.rmSync(path.join(tools, "argv.log"), { force: true });
  const r = spawnSync("bash", [script, ...args], { cwd: root, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: { ...base, ...env } });
  const log = fs.existsSync(path.join(tools, "argv.log")) ? fs.readFileSync(path.join(tools, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", errLines: (r.stderr ?? "").split("\n").filter(Boolean), calls: log };
}
const valid = (rel: { dir: string; digest: string }, extra: string[] = []) =>
  ["--id", ID, "--digest", rel.digest, "--from-dir", rel.dir, "--public", pub, "--tools", tools, "--umbrella", umbrella, "--dry-run", ...extra];
/** A refusal: exit 2, exactly one stderr line, nothing on stdout, the package never ran. */
function refused(r: ReturnType<typeof adopt>, re: RegExp) {
  expect(r.errLines, r.stderr).toHaveLength(1);
  expect(r.errLines[0]).toMatch(/^adopt-release: /);
  expect(r.errLines[0]).toMatch(re);
  expect(r.status).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.calls.filter((c) => c[0] !== "--version")).toEqual([]);
}
const STEPS = ["fetch", "verify", "checks", "artifact-lib", "base-trees", "umbrella", "base-tree", "gate", "bake-init", "bake-mathlib",
  "stage-runtime", "stage-profiles", "pairing", "promote", "next"];
const stepNames = (stdout: string) => stdout.split("\n").map((l) => /^ {2}([a-z][a-z-]+) {2,}/.exec(l)?.[1]).filter((s): s is string => !!s && !["work", "staging", "public", "disk"].includes(s));

describe("adopt-release.sh --dry-run", () => {
  test("a valid runtime-only release: the plan names exactly the steps, the package runs only for --version, nothing is written", () => {
    const rel = fakeRelease("rel-ok");
    const before = state(tmp);
    const r = adopt(valid(rel, ["--fat-tree", "--gate"]));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe("DRY RUN — inputs valid, nothing was fetched or written");
    expect(stepNames(r.stdout)).toEqual(STEPS);
    expect(r.calls).toEqual([["--version"]]);
    const plan = r.stdout;
    expect(plan).toMatch(new RegExp(`^plan for ${ID}: runtime ${NEW_ID}, Lean 9\\.9\\.9, kernel ${"ab".repeat(20)} \\(patch 0036, floor 0032\\), runtime-only; lean4-wasm64 0\\.0\\.0-fake at ${tools}$`, "m"));
    const W = path.join(root, "work/adopt", ID);
    // the exact package commands
    expect(plan).toContain(`node ${tools}/cli.mjs fetch --from ${rel.dir} --out ${W}/release --only runtime-chunks,lean-lib,lean-core,mathlib-essential --id ${ID} --digest ${rel.digest}`);
    expect(plan).toContain(`node ${tools}/cli.mjs fetch --from ${rel.dir} --out ${W}/artifact --only runtime --id ${ID} --digest ${rel.digest}`);
    expect(plan).toContain(`node ${tools}/cli.mjs verify --release ${rel.dir} --skip-packs`);
    expect(plan).toContain(`node ${tools}/cli.mjs unpack --manifest ${W}/release/profiles/lean-lib.manifest.json --out ${W}/artifact/lib/lean`);
    expect(plan).toContain(`node ${tools}/cli.mjs unpack --slim --manifest ${W}/release/profiles/lean-lib.manifest.json --out ${W}/core-lib-slim`);
    expect(plan).toContain(`node ${tools}/cli.mjs unpack --manifest ${W}/release/profiles/{lean-core,mathlib-essential}.manifest.json --out ${W}/lib-tree`);
    expect(plan).toContain(`reuse cp ${umbrella}/QED64/Essential.olean{,.server} → ${W}/lib-tree-slim/QED64/ ${W}/lib-tree/QED64/  (+ Essential.olean.private into lib-tree: ABSENT in the source, pair only)`);
    expect(plan).toContain(`node ${tools}/cli.mjs gate --artifact ${W}/artifact > ${W}/logs/gate.log`);
    const staging = path.join(root, "work/staging", NEW_ID);
    expect(plan).toContain(`node --stack-size=8192 pipeline/snapshot/bake-snapshot.mjs --artifact ${W}/artifact --work ${W}/snapshot --out ${staging}/snapshots --name init --lib ${W}/core-lib-slim --reserve 1073741824`);
    expect(plan).toContain(`--name mathlib --lib ${W}/lib-tree-slim --reserve 3221225472 --probe 'import QED64.Essential'`);
    expect(plan).toMatch(/stage-profiles +none: the served packs stay/);
    expect(plan).toContain(`node pipeline/release/promote-staging.mjs --staging ${staging} --public ${pub} --dry-run`);
    expect(plan).toContain(`node pipeline/release/verify-release.mjs --public ${pub}; cmp ${pub}/runtime/runtime-manifest.json ${W}/release/runtime/runtime-manifest.json`);
    // nothing written: not the fixtures, not this checkout's work/
    expect(state(tmp)).toEqual({ ...before, "tools/argv.log": expect.any(String) });
    expect(fs.existsSync(W)).toBe(false);
    expect(fs.existsSync(staging)).toBe(false);
  });

  test("--init-lib lean-core bakes init from lean-core; no --gate says so; --keep and --allow-served change no step", () => {
    const rel = fakeRelease("rel-init");
    const r = adopt(valid(rel, ["--init-lib", "lean-core", "--keep"]));
    expect(r.status, r.stderr).toBe(0);
    expect(stepNames(r.stdout)).toEqual(STEPS);
    expect(r.stdout).toMatch(/unpack --slim --manifest \S+\/lean-core\.manifest\.json --out \S+\/core-lib-slim/);
    expect(r.stdout).toMatch(/ {2}gate +skipped \(no --gate/);
    expect(r.stdout).not.toMatch(/\/lib-tree\b(?!-slim)/);
    refused(adopt(valid(rel, ["--init-lib", "lean-game"])), /--init-lib is lean-lib or lean-core, not lean-game/);
  });

  test("a missing --digest, a malformed one and a mismatch refuse; so does a record edited after it was cut", () => {
    const rel = fakeRelease("rel-pin");
    const args = valid(rel);
    refused(adopt(args.filter((a, i) => a !== "--digest" && args[i - 1] !== "--digest")), /--digest sha256:<64 hex> is required/);
    refused(adopt(args.map((a) => (a === rel.digest ? "sha256:abc" : a))), /--digest sha256:abc is not sha256:<64 lowercase hex>/);
    refused(adopt(args.map((a) => (a === rel.digest ? `sha256:${"0".repeat(64)}` : a))), new RegExp(`release\\.json digest is ${rel.digest}, --digest pins sha256:0{64}`));
    refused(adopt(args.map((a) => (a === ID ? "lean-v9.9.9-fff0000" : a))), /the release is lean-v9\.9\.9-abc1234, --id says lean-v9\.9\.9-fff0000/);
    const edited = fakeRelease("rel-edited", () => {}, `sha256:${"1".repeat(64)}`);
    refused(adopt(valid(edited).map((a) => (a === edited.digest ? `sha256:${"1".repeat(64)}` : a))), /release\.json's digest sha256:1{64} is not its own content's/);
    refused(adopt(valid(rel).filter((a) => a !== "--from-dir" && a !== rel.dir)), /--from <release URL> or --from-dir <release dir> is required/);
  });

  test("a kernel patch below embedding/closure.json runtime.minKernelPatch refuses (NNNN, then an optional suffix)", () => {
    const floor = JSON.parse(fs.readFileSync(path.join(root, "embedding/closure.json"), "utf8")).runtime.minKernelPatch as string;
    expect(floor).toBe("0032");
    for (const patch of ["0031", "0031z"]) {
      const rel = fakeRelease(`rel-floor-${patch}`, (r) => { (r.kernel as { patch: string }).patch = patch; });
      refused(adopt(valid(rel)), new RegExp(`kernel\\.patch ${patch} is below embedding/closure\\.json runtime\\.minKernelPatch 0032`));
    }
    for (const patch of ["0032", "0032a", "0100"]) {
      const rel = fakeRelease(`rel-floor-${patch}`, (r) => { (r.kernel as { patch: string }).patch = patch; });
      expect(adopt(valid(rel)).status, patch).toBe(0);
    }
  });

  test("the already-served runtime refuses unless --allow-served (a rehearsal into an isolated tree)", () => {
    const rel = fakeRelease("rel-served", (r) => { (r.runtime as { buildId: string }).buildId = SERVED_ID; });
    refused(adopt(valid(rel)), new RegExp(`the release's runtime ${SERVED_ID} IS the served runtime \\(${served}/runtime/runtime-manifest\\.json\\) — nothing to adopt; a rehearsal passes --allow-served`));
    const ok = adopt(valid(rel, ["--allow-served"]));
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/runtime not the served one \(--allow-served: a rehearsal\)/);
  });

  test("--public = this checkout's public/ (by any spelling) refuses; so does main's", () => {
    const rel = fakeRelease("rel-public");
    const withPublic = (p: string) => valid(rel).map((a) => (a === pub ? p : a));
    refused(adopt(withPublic(path.join(root, "public"))), /inside .*\/public — adopt into an ISOLATED served tree, never a checkout's public\//);
    refused(adopt(withPublic(path.join(root, "public/runtime/.."))), /never a checkout's public\//);
    const link = path.join(tmp, "link-to-public");
    fs.symlinkSync(path.join(root, "public"), link);
    refused(adopt(withPublic(link)), /resolves to .*\/public, inside/);
    const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const mainPublic = path.join(path.dirname(common), "public");
    if (fs.existsSync(mainPublic)) refused(adopt(withPublic(mainPublic)), /never a checkout's public\//);
    refused(adopt(withPublic(path.join(tmp, "nope"))), /is not a directory — fill an isolated served tree first/);
    const empty = path.join(tmp, "public-empty");
    fs.mkdirSync(empty);
    refused(adopt(withPublic(empty)), /has no runtime\/runtime-manifest\.json — fill the isolated tree first/);
    // only the three mutable manifests: promote-staging's re-point would refuse it after the bakes, so the precheck does now
    const thin = path.join(tmp, "public-thin");
    fs.cpSync(pub, thin, { recursive: true });
    fs.rmSync(path.join(thin, "profiles/mathlib-essential.manifest.json"));
    refused(adopt(withPublic(thin)), /lists profile essential but has no profiles\/mathlib-essential\.manifest\.json — fill the isolated tree first/);
    fs.writeFileSync(path.join(thin, "profiles/index.json"), "{}");
    refused(adopt(withPublic(thin)), /profiles\/index\.json is not qed64\.profile-index\/v1 — fill the isolated tree first/);
    // the release dir is never written: a --public inside it refuses
    fs.mkdirSync(path.join(rel.dir, "pub"));
    refused(adopt(withPublic(path.join(rel.dir, "pub"))), new RegExp(`inside ${rel.dir}`));
  });

  test("a --public holding a symlink that leaves the tree refuses (this worktree's public/runtime/chunks is one); an inner one is fine", () => {
    const rel = fakeRelease("rel-escape");
    const p = path.join(tmp, "public-escape");
    fs.cpSync(pub, p, { recursive: true });
    fs.mkdirSync(path.join(tmp, "elsewhere"));
    fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(p, "runtime/chunks"));
    refused(adopt(valid(rel).map((a) => (a === pub ? p : a))), /holds 1 symlink\(s\) leaving the tree \(first: runtime\/chunks -> .*\/elsewhere\) — a promote would write through them/);
    const inner = path.join(tmp, "public-inner");
    fs.cpSync(pub, inner, { recursive: true });
    fs.mkdirSync(path.join(inner, "runtime/chunks-real"));
    fs.symlinkSync("chunks-real", path.join(inner, "runtime/chunks"));
    expect(adopt(valid(rel).map((a) => (a === pub ? inner : a))).status).toBe(0);
  });

  test("the umbrella mode follows the record: runtime-only reuses (--umbrella), changed packs rebuild and stage the packs", () => {
    const rel = fakeRelease("rel-umbrella");
    const noUmbrella = valid(rel).filter((a) => a !== "--umbrella" && a !== umbrella);
    refused(adopt(noUmbrella), /a runtime-only release reuses the umbrella pair: pass --umbrella/);
    refused(adopt([...noUmbrella, "--rebuild-umbrella"]), /pass --umbrella <dir>, not --rebuild-umbrella/);
    refused(adopt([...noUmbrella, "--umbrella", path.join(tmp, "tools")]), /--umbrella .* has no QED64\/Essential\.olean/);
    refused(adopt([...valid(rel), "--rebuild-umbrella"]), /--umbrella and --rebuild-umbrella are exclusive/);
    const changed = fakeRelease("rel-changed", (r) => { (r.packs as { id: string; rawSha256: string }[])[1]!.rawSha256 = sha("new essential"); });
    refused(adopt(valid(changed)), /the release's packs are not the served ones: pass --rebuild-umbrella/);
    const r = adopt([...valid(changed).filter((a) => a !== "--umbrella" && a !== umbrella), "--rebuild-umbrella"]);
    expect(r.status, r.stderr).toBe(0);
    expect(stepNames(r.stdout)).toEqual(STEPS);
    const W = path.join(root, "work/adopt", ID);
    expect(r.stdout).toMatch(/packs-change/);
    expect(r.stdout).toContain(`node ${tools}/cli.mjs verify --release ${changed.dir}\n`);
    expect(r.stdout).toContain(`node pipeline/snapshot/supervised-run.mjs --target ${W}/umbrella/Essential.olean -- --artifact ${W}/artifact --work ${W}/umbrella --lib ${W}/lib-tree -- -o /work/Essential.olean /work/Essential.lean`);
    expect(r.stdout).toContain(`node ${tools}/cli.mjs olean-imports --audit ${W}/lib-tree`);
    expect(r.stdout).toContain(`node pipeline/release/stage-profiles.mjs --packs ${W}/release/profiles --build-id ${NEW_ID} --lean-version 9.9.9 --expect-modules ${W}/release/lists/essential-modules.txt --out ${path.join(root, "work/staging", NEW_ID)}/profiles`);
    expect(r.stdout).toMatch(/disk {5}\d+ GB free under .*, floor 16 GB/); // the fat tree is implied
  });

  test("no lean4-wasm64: one line naming the install; a URL source is planned without being fetched", () => {
    const rel = fakeRelease("rel-tools");
    refused(adopt(valid(rel).map((a) => (a === tools ? umbrella : a))), /lean4-wasm64 not found at .* — pass --tools <package dir>, set LEAN4_WASM64_DIR, or install it: npm i -D <release tgz URL>/);
    const viaEnv = adopt(valid(rel).filter((a) => a !== "--tools" && a !== tools), { LEAN4_WASM64_DIR: tools });
    expect(viaEnv.status, viaEnv.stderr).toBe(0);
    const url = `https://github.com/FawadHa1der/lean4/releases/download/${ID}/`;
    const r = adopt(valid(rel).map((a) => (a === "--from-dir" ? "--from" : a === rel.dir ? url : a)));
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([["--version"]]);
    expect(stepNames(r.stdout)).toEqual(STEPS);
    expect(r.stdout).toMatch(/^plan for lean-v9\.9\.9-abc1234: runtime \?, /);
    expect(r.stdout).toMatch(/verify +skipped: --from is a URL/);
    refused(adopt(valid(rel).map((a) => (a === "--from-dir" ? "--from" : a === rel.dir ? "http://example.invalid/" : a))), /is not an https:\/\/ URL/);
    refused(adopt([...valid(rel), "--bogus"]), /unknown argument --bogus/);
  });
});

/** A throwaway checkout holding only what the script reads (itself, its helper, closure.json; not a
 * git repo, no work/ unless a test makes one), so writes and symlinks under work/ stay in os.tmpdir(). */
function fakeRepo(name: string) {
  const q = path.join(tmp, name);
  for (const f of ["pipeline/release/adopt-release.sh", "pipeline/release/adopt-helper.mjs", "embedding/closure.json"]) {
    fs.mkdirSync(path.dirname(path.join(q, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(q, f));
  }
  return { q, W: path.join(q, "work/adopt", ID), run: (args: string[], env: Record<string, string> = {}) => {
    const base: Record<string, string | undefined> = { ...process.env, QED64_PUBLIC_DIR: served };
    delete base.LEAN4_WASM64_DIR;
    const r = spawnSync("bash", [path.join(q, "pipeline/release/adopt-release.sh"), ...args], { cwd: q, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: { ...base, ...env } });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", errLines: (r.stderr ?? "").split("\n").filter(Boolean) };
  } };
}
/** One stderr line `adopt-release: …` matching `re`, exit 2. */
function refusedLine(r: { status: number | null; stderr: string; errLines: string[] }, re: RegExp) {
  expect(r.errLines, r.stderr).toHaveLength(1);
  expect(r.errLines[0]).toMatch(/^adopt-release: /);
  expect(r.errLines[0]).toMatch(re);
  expect(r.status).toBe(2);
}

describe("adopt-release.sh: its own work dirs, the URL record and the patch order", () => {
  test("a fresh checkout without work/: the dry run measures the disk where it is, and still writes nothing", () => {
    const repo = fakeRepo("repo-fresh");
    const rel = fakeRelease("rel-fresh");
    const r = repo.run(valid(rel));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const kb = Number(spawnSync("df", ["-Pk", repo.q], { encoding: "utf8" }).stdout.split("\n")[1]!.trim().split(/\s+/)[3]);
    expect(r.stdout).toContain(`  disk     ${Math.floor(kb / 1048576)} GB free under ${repo.q}/work, floor 12 GB`);
    expect(fs.existsSync(path.join(repo.q, "work"))).toBe(false);
  });

  test("$W, or a link inside it, that leads elsewhere refuses before anything is written (dry run too)", () => {
    const repo = fakeRepo("repo-links");
    const rel = fakeRelease("rel-links");
    const elsewhere = path.join(tmp, "elsewhere-work");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.dirname(repo.W), { recursive: true });
    fs.symlinkSync(elsewhere, repo.W);
    refusedLine(repo.run(valid(rel)), new RegExp(`${repo.W} is a symlink: the adoption writes only into this checkout's own work/`));
    fs.rmSync(repo.W);
    for (const sub of ["artifact", "lib-tree-slim", "release/runtime/chunks"]) {
      fs.mkdirSync(path.dirname(path.join(repo.W, sub)), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(repo.W, sub));
      refusedLine(repo.run(valid(rel)), new RegExp(`${path.join(repo.W, sub)} is a symlink: a rerun would delete, unpack or copy through it`));
      refusedLine(repo.run(valid(rel).filter((a) => a !== "--dry-run")), /is a symlink: a rerun would delete/);
      fs.rmSync(path.join(repo.W, sub));
    }
    // the staging dir of the planned runtime, too
    const staging = path.join(repo.q, "work/staging", NEW_ID);
    fs.mkdirSync(path.dirname(staging), { recursive: true });
    fs.symlinkSync(elsewhere, staging);
    refusedLine(repo.run(valid(rel)), new RegExp(`${staging} is a symlink`));
    fs.rmSync(staging);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(repo.run(valid(rel)).status).toBe(0);
  });

  test("an --umbrella or --public inside work/adopt or work/staging refuses: a rerun deletes its own inputs", () => {
    const repo = fakeRepo("repo-overlap");
    const rel = fakeRelease("rel-overlap");
    const prev = path.join(repo.q, "work/adopt", ID, "lib-tree");
    fs.cpSync(umbrella, prev, { recursive: true });
    refusedLine(repo.run(valid(rel).map((a) => (a === umbrella ? prev : a))), /--umbrella .*\/lib-tree lies inside .*\/work\/adopt or work\/staging, which an adoption deletes and rewrites/);
    const other = path.join(repo.q, "work/adopt/lean-v0.0.1-other/lib-tree-slim");
    fs.cpSync(umbrella, other, { recursive: true });
    refusedLine(repo.run(valid(rel).map((a) => (a === umbrella ? other : a))), /lies inside .*\/work\/adopt/);
    for (const where of [`work/staging/${NEW_ID}/public`, `work/adopt/${ID}/public`]) {
      const p = path.join(repo.q, where);
      fs.cpSync(pub, p, { recursive: true });
      refusedLine(repo.run(valid(rel).map((a) => (a === pub ? p : a))), /inside .*\/work\/(staging|adopt) — adopt into an ISOLATED served tree/);
      fs.rmSync(p, { recursive: true });
    }
  });

  test("--from <URL>: a pin mismatch from the package is a one-line refusal, exit 2, and $W is never created", () => {
    const repo = fakeRepo("repo-url");
    const rel = fakeRelease("rel-url");
    const url = `https://github.com/FawadHa1der/lean4/releases/download/${ID}/`;
    const args = valid(rel).filter((a) => a !== "--dry-run").map((a) => (a === "--from-dir" ? "--from" : a === rel.dir ? url : a));
    for (const msg of [`fetch: release.json digest is sha256:${"2".repeat(64)}, pinned ${rel.digest}`, `fetch: release is lean-v9.9.9-0000000, expected ${ID}`]) {
      const r = repo.run(args, { FAKE_FETCH_FAIL: msg });
      refusedLine(r, new RegExp(`^adopt-release: ${msg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      expect(r.stdout).not.toMatch(/ADOPT-FAIL/);
      expect(fs.existsSync(repo.W)).toBe(false);
    }
    // any other fetch failure stays a failed step (exit 1), still before $W/logs
    const other = repo.run(args, { FAKE_FETCH_FAIL: `fetch: cannot read release.json from ${url}release.json: 404` });
    expect(other.status).toBe(1);
    expect(other.stdout).toMatch(/^ADOPT-FAIL fetch-record/m);
    expect(fs.existsSync(repo.W)).toBe(false);
  });

  test("patch_ge orders kernel patches like comparePatchIds: NNNN by number, then the suffix (\"\" first)", () => {
    const fn = spawnSync("sed", ["-n", "/^patch_ge()/,/; }$/p", script], { encoding: "utf8" }).stdout;
    expect(fn).toMatch(/^patch_ge\(\)/);
    const ge = (a: string, b: string) => spawnSync("bash", ["-c", `${fn}\npatch_ge "$1" "$2"`, "_", a, b]).status;
    const table: [string, string, number][] = [
      ["0035", "0035b", 1], ["0035b", "0035", 0], ["0035a", "0035b", 1], ["0035c", "0035b", 0], ["0035b", "0035b", 0],
      ["0036", "0035b", 0], ["0036", "0035z", 0], ["0034z", "0035", 1], ["0032", "0035b", 1], ["0035b", "0032", 0], ["0100", "0099z", 0],
    ];
    for (const [a, b, want] of table) expect(ge(a, b), `${a} >= ${b}`).toBe(want);
    const malformed: [string, string][] = [["35", "0032"], ["0035B", "0032"], ["0035ab", "0032"], ["0035", ""]];
    for (const [a, b] of malformed) expect(ge(a, b), `${a} vs ${b}`).toBe(2);
  });
});

describe("adopt-helper.mjs: every failure is one refusal line", () => {
  test("confine on a --public holding an unreadable directory: one line, exit 2, no stack trace", () => {
    const p = path.join(tmp, "public-unreadable");
    fs.cpSync(pub, p, { recursive: true });
    fs.mkdirSync(path.join(p, "locked"));
    fs.chmodSync(path.join(p, "locked"), 0o000);
    try {
      const r = spawnSync("node", [helper, "confine", "--public", p, "--forbid", path.join(root, "public")], { encoding: "utf8" });
      const lines = r.stderr.split("\n").filter(Boolean);
      expect(lines, r.stderr).toHaveLength(1);
      expect(lines[0]).toMatch(/^adopt-release: confine: EACCES: permission denied, scandir .*locked/);
      expect(r.status).toBe(2);
    } finally { fs.chmodSync(path.join(p, "locked"), 0o755); }
  });
});

describe("adopt-helper.mjs: the tree digest and base-tree.json", () => {
  test("treeDigest is sha256 over the sorted \"<relpath>\\0<sha256>\\n\" lines; a symlink is refused", () => {
    const t = path.join(tmp, "tree");
    fs.mkdirSync(path.join(t, "Init/Data"), { recursive: true });
    fs.writeFileSync(path.join(t, "Init.olean"), "a");
    fs.writeFileSync(path.join(t, "Init/Data/B.olean"), "b");
    fs.writeFileSync(path.join(t, "Init/A.olean"), "c");
    const lines = ["Init.olean", "Init/A.olean", "Init/Data/B.olean"].map((p) => `${p}\0${sha(fs.readFileSync(path.join(t, p)))}\n`);
    expect(treeDigest(t)).toEqual({ digest: `sha256:${sha(lines.join(""))}`, files: 3, bytes: 3 });
    expect(TREE_DIGEST_RULE).toMatch(/sorted by byte order/);
    fs.symlinkSync("Init.olean", path.join(t, "link.olean"));
    expect(() => treeDigest(t)).toThrow(/is a symlink/);
  });

  test("base-tree writes per tree the packs, the umbrella pair and the digest; kernel-pin is retired (plan B2c)", () => {
    const rel = fakeRelease("rel-base");
    const W = path.join(tmp, "W");
    const files: Record<string, string> = {
      "core-lib-slim/Init.olean": "i", "lib-tree-slim/Init.olean": "i", "lib-tree-slim/QED64/Essential.olean": "olean", "lib-tree-slim/QED64/Essential.olean.server": "server",
      "lib-tree/Init.olean": "i", "lib-tree/Init.olean.private": "p", "lib-tree/QED64/Essential.olean": "olean", "lib-tree/QED64/Essential.olean.server": "server", "lib-tree/QED64/Essential.olean.private": "priv",
      "snapshot/init.snap": "1234", "snapshot/mathlib.snap": "123456",
    };
    for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(W, p)), { recursive: true }); fs.writeFileSync(path.join(W, p), text); }
    const b = spawnSync("node", [helper, "base-tree", "--work", W, "--release", path.join(rel.dir, "release.json"), "--init-lib", "lean-lib", "--umbrella-source", "reused", "--fat"], { encoding: "utf8" });
    expect(b.status, b.stderr).toBe(0);
    const doc = JSON.parse(fs.readFileSync(path.join(W, "base-tree.json"), "utf8"));
    expect(doc).toMatchObject({ schema: "qed64.base-tree/v1", releaseId: ID, releaseDigest: rel.digest, runtime: NEW_ID, slim: true, initLib: "lean-lib", umbrellaSource: "reused" });
    expect(doc.packs).toEqual([{ id: "lean-core", release: "lean-core-9.9.9", rawSha256: `sha256:${RAW["lean-core"]}` }, { id: "mathlib-essential", release: "mathlib-essential-9.9.9", rawSha256: `sha256:${RAW["mathlib-essential"]}` }]);
    expect(doc.umbrella).toEqual([{ path: "QED64/Essential.olean", sha256: sha("olean"), bytes: 5 }, { path: "QED64/Essential.olean.server", sha256: sha("server"), bytes: 6 }]);
    expect(Object.keys(doc.trees)).toEqual(["core-lib-slim", "lib-tree-slim", "lib-tree"]);
    expect(doc.trees["core-lib-slim"]).toEqual({ slim: true, packs: [{ id: "lean-lib", release: "lean-lib-9.9.9", rawSha256: `sha256:${RAW["lean-lib"]}` }], umbrella: [], files: 1, bytes: 1, digest: treeDigest(path.join(W, "core-lib-slim")).digest });
    expect(doc.trees["lib-tree-slim"].umbrella).toEqual(doc.umbrella);
    expect(doc.trees["lib-tree"]).toMatchObject({ slim: false, files: 5, digest: treeDigest(path.join(W, "lib-tree")).digest });
    expect(doc.trees["lib-tree"].umbrella.map((u: { path: string }) => u.path)).toEqual(["QED64/Essential.olean", "QED64/Essential.olean.private", "QED64/Essential.olean.server"]);
    // The kernel pin is the record's kernel.commit now (toolchain.kernel in qed64.release/v1): no generated file.
    const k = spawnSync("node", [helper, "kernel-pin", "--work", W, "--release", path.join(rel.dir, "release.json"), "--init-lib", "lean-lib", "--staging", "work/staging/x"], { encoding: "utf8" });
    expect(k.status).toBe(2);
    expect(k.stderr).toMatch(/^adopt-release: adopt-helper: unknown subcommand "kernel-pin" \(record, confine, base-tree\)/);
    expect(fs.existsSync(path.join(W, "KERNEL-PIN"))).toBe(false);
  });

  test("the printed landing copies the record and $W/base-tree.json, and names no KERNEL-PIN (retired 2026-10, plan B2c)", () => {
    const text = fs.readFileSync(script, "utf8");
    const landing = text.slice(text.indexOf("Landing, by the operator"));
    expect(landing).toContain(" 1. cp $W/release/release.json toolchain/lean4-wasm64-release.json\n");
    expect(landing).toContain(" 2. cp $W/base-tree.json embedding/base-tree.json");
    expect(landing).toContain("node pipeline/release/release-manifest.mjs --worktree");
    expect(text).not.toMatch(/KERNEL-PIN|kernel-pin/);
    expect(fs.existsSync(path.join(root, "pipeline/toolchain/KERNEL-PIN"))).toBe(false);
  });
});
