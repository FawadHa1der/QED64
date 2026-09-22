// The version-import lane's pieces, run as the REAL scripts against temp
// trees: the .olean import reader, the packer's served-URL / release / import
// options, the staged-profiles assembler (pair checks + layout contract), the
// supervisor that reaps the never-exiting CLI, and the lane's own contract
// validation in --dry-run. Nothing here touches public/ or work/.
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { oleanImportEntries, oleanImports } from "../../pipeline/artifacts/olean-imports.mjs";

const root = path.resolve(__dirname, "../..");
const packer = path.join(root, "pipeline/artifacts/pack.mjs");
const stager = path.join(root, "pipeline/release/stage-profiles.mjs");
const supervisor = path.join(root, "pipeline/snapshot/supervised-run.mjs");
const lane = path.join(root, "pipeline/release/import-packs.sh");
const run = (script: string, args: string[]) => spawnSync("node", [script, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-import-lane-")); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

type ImportSpec = { module: string; importAll?: boolean; isExported?: boolean; isMeta?: boolean };

/** A minimal 64-bit compacted region holding ModuleData { imports := … }: the
 * same object layout Lean writes (header, base address, root pointer, then
 * strings / Names / Imports / the Array / the root constructor). */
function makeOlean(imports: ImportSpec[]): Buffer {
  const BASE = 0x2000_0000_0000n;
  const chunks: Buffer[] = [];
  let offset = 96;
  const push = (b: Buffer): bigint => {
    const at = BigInt(offset);
    const padded = Buffer.alloc(Math.ceil(b.length / 8) * 8);
    b.copy(padded);
    chunks.push(padded);
    offset += padded.length;
    return BASE + at;
  };
  const objectHeader = (size: number, fields: number, tag: number) => {
    const h = Buffer.alloc(8);
    h.writeUInt16LE(size, 4);
    h.writeUInt8(fields, 6);
    h.writeUInt8(tag, 7);
    return h;
  };
  const u64 = (...values: bigint[]) => {
    const b = Buffer.alloc(8 * values.length);
    values.forEach((v, i) => b.writeBigUInt64LE(v, 8 * i));
    return b;
  };
  const BOX0 = 1n;
  const leanString = (s: string) => {
    const bytes = Buffer.from(`${s}\0`, "utf8");
    return push(Buffer.concat([objectHeader(1, 0, 249), u64(BigInt(bytes.length), BigInt(bytes.length), BigInt(s.length)), bytes]));
  };
  const leanName = (dotted: string) => {
    let name = BOX0;
    for (const component of dotted.split(".")) {
      name = /^\d+$/.test(component)
        ? push(Buffer.concat([objectHeader(32, 2, 2), u64(name, (BigInt(component) << 1n) | 1n, 0n)]))
        : push(Buffer.concat([objectHeader(32, 2, 1), u64(name, leanString(component), 0n)]));
    }
    return name;
  };
  const entries = imports.map((spec) => {
    const flags = Buffer.alloc(8);
    flags.writeUInt8(spec.importAll ? 1 : 0, 0);
    flags.writeUInt8(spec.isExported ? 1 : 0, 1);
    flags.writeUInt8(spec.isMeta ? 1 : 0, 2);
    return push(Buffer.concat([objectHeader(19, 1, 0), u64(leanName(spec.module)), flags]));
  });
  const array = push(Buffer.concat([objectHeader(1, 0, 246), u64(BigInt(entries.length), BigInt(entries.length), ...entries)]));
  const rootObject = push(Buffer.concat([objectHeader(49, 5, 0), u64(array, BOX0, BOX0, BOX0, BOX0, 1n)]));
  const header = Buffer.alloc(96);
  header.write("olean", 0, "latin1");
  header.writeUInt8(2, 5);
  header.write("4.99.0", 7, "latin1");
  header.writeBigUInt64LE(BASE, 80);
  header.writeBigUInt64LE(rootObject, 88);
  return Buffer.concat([header, ...chunks]);
}

/** Write a module's facets under `lib`. */
function writeModule(lib: string, name: string, imports: ImportSpec[]) {
  const file = path.join(lib, `${name.split(".").join("/")}.olean`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makeOlean(imports));
  fs.writeFileSync(file.replace(/\.olean$/, ".ir"), Buffer.from(`ir of ${name}`));
}

describe("olean-imports.mjs", () => {
  test("reads names, flags and numeric components from a compacted region", () => {
    const bytes = makeOlean([
      { module: "Init.Data.List.Basic", isExported: true },
      { module: "Mathlib.Tactic.Ring", importAll: true },
      { module: "Archive.2024.Q1", isMeta: true },
      { module: "Init" },
    ]);
    expect(oleanImportEntries(bytes)).toEqual([
      { module: "Init.Data.List.Basic", importAll: false, isExported: true, isMeta: false },
      { module: "Mathlib.Tactic.Ring", importAll: true, isExported: false, isMeta: false },
      { module: "Archive.2024.Q1", importAll: false, isExported: false, isMeta: true },
      { module: "Init", importAll: false, isExported: false, isMeta: false },
    ]);
    expect(oleanImports(bytes)).toEqual(["Archive.2024.Q1", "Init", "Init.Data.List.Basic", "Mathlib.Tactic.Ring"]);
    expect(oleanImports(makeOlean([]))).toEqual([]);
  });

  test("reads the real fixture oleans; de-duplicates; returns null for bytes it does not understand", () => {
    const fixture = path.join(root, "tests/fixtures/mini-lib/Init");
    expect(oleanImports(fs.readFileSync(path.join(fixture, "Prelude.olean")))).toEqual([]);
    expect(oleanImports(fs.readFileSync(path.join(fixture, "Core.olean")))).toEqual(["Init.SizeOf", "Init.Tactics"]);
    expect(oleanImports(makeOlean([{ module: "A.B" }, { module: "A.B", isMeta: true }]))).toEqual(["A.B"]);
    expect(oleanImports(Buffer.from("not an olean at all"))).toBeNull();
    const truncated = makeOlean([{ module: "A.B" }]).subarray(0, 120);
    expect(oleanImports(truncated)).toBeNull();
    const wild = makeOlean([{ module: "A.B" }]);
    wild.writeBigUInt64LE(0xdead_beefn, 88); // root pointer outside the region
    expect(oleanImports(wild)).toBeNull();
  });

  test("--audit lists the `import all` edges of a tree, by importer", () => {
    const lib = path.join(tmp, "audit-lib");
    writeModule(lib, "Init.Prelude", []);
    writeModule(lib, "Init.Core", [{ module: "Init.Prelude", importAll: true }]);
    writeModule(lib, "Lib.A", [{ module: "Init.Core", importAll: true }, { module: "Lib.B" }]);
    writeModule(lib, "Lib.B", [{ module: "Init.Prelude" }]);
    const r = run(path.join(root, "pipeline/artifacts/olean-imports.mjs"), ["--audit", lib]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/4 modules, 2 `import all` edge/);
    expect(r.stdout).toMatch(/outside Init\/Std\/Lean\/Lake: 1/);
    expect(r.stdout).toMatch(/Lib\.A → import all Init\.Core/);
  });
});

describe("pack.mjs options the served packs need", () => {
  test("--url-prefix and --release land in the manifest; imports come from the .olean; a bare `Init` edge is dropped when Init is not in the pack", () => {
    const lib = path.join(tmp, "pack-lib");
    writeModule(lib, "Lib.A", [{ module: "Init" }, { module: "Init.Prelude" }, { module: "Lib.B" }]);
    writeModule(lib, "Lib.B", [{ module: "Init" }]);
    const out = path.join(tmp, "pack-out");
    const r = run(packer, ["--lib", lib, "--id", "demo", "--out", out, "--roots", "Lib.A", "--url-prefix", "/profiles/", "--release", "demo-abc1234-wasm64-0123456789abcdef", "--lean-version", "4.99.0"]);
    expect(r.status).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "demo.manifest.json"), "utf8"));
    expect(manifest.content.release).toBe("demo-abc1234-wasm64-0123456789abcdef");
    expect(manifest.content.pack.url).toBe("/profiles/demo.pack.gzip");
    for (const part of manifest.content.pack.transport.parts) {
      expect(part.url).toMatch(/^\/profiles\/demo\.pack\.gzip\.[0-9a-f]{20}\.part-\d{3}$/);
      expect(fs.existsSync(path.join(out, path.basename(part.url)))).toBe(true);
    }
    expect(manifest.content.modules["Lib.A"].imports).toEqual(["Init.Prelude", "Lib.B"]);
    expect(manifest.content.modules["Lib.B"].imports).toEqual([]);
    // The raw .pack on disk is the digest the manifest names.
    expect(`sha256:${createHash("sha256").update(fs.readFileSync(path.join(out, "demo.pack"))).digest("hex")}`).toBe(manifest.content.pack.digest);
  });

  test("an .olean that is not a region fails the pack unless --no-imports", () => {
    const lib = path.join(tmp, "pack-bad");
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, "Junk.olean"), Buffer.from("olean but not really"));
    const refused = run(packer, ["--lib", lib, "--id", "junk", "--out", path.join(tmp, "pack-bad-out")]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/no readable import table/);
    expect(run(packer, ["--lib", lib, "--id", "junk", "--out", path.join(tmp, "pack-bad-out2"), "--no-imports"]).status).toBe(0);
  });
});

describe("stage-profiles.mjs", () => {
  const BUILD = "wasm64-0123456789abcdef";
  let packs: string;
  let servedIndex: string;
  const packPair = (dir: string, essential: (lib: string) => void) => {
    const core = path.join(dir, "core-lib");
    writeModule(core, "Init", [{ module: "Init.Prelude" }]);
    writeModule(core, "Init.Prelude", []);
    const ess = path.join(dir, "ess-lib");
    essential(ess);
    const out = path.join(dir, "packs");
    for (const [id, lib, roots] of [["lean-core", core, "Init"], ["mathlib-essential", ess, "Lib.A"]] as const) {
      const r = run(packer, ["--lib", lib, "--id", id, "--out", out, "--roots", roots, "--url-prefix", "/profiles/", "--lean-version", "4.99.0", "--release", `${id}-test-${BUILD}`]);
      expect(r.status).toBe(0);
    }
    return out;
  };
  const stage = (packsDir: string, extra: string[] = []) =>
    run(stager, ["--packs", packsDir, "--build-id", BUILD, "--lean-version", "4.99.0", "--served-index", servedIndex, ...extra]);

  beforeAll(() => {
    servedIndex = path.join(tmp, "served-index.json");
    fs.writeFileSync(servedIndex, JSON.stringify({
      schema: "qed64.profile-index/v1",
      runtime: { buildId: "wasm64-ffffffffffffffff", leanVersion: "4.33.0-pre" },
      profiles: [
        { id: "core", manifest: "/profiles/lean-core.manifest.json", release: "old-core", modules: 629 },
        { id: "essential", manifest: "/profiles/mathlib-essential.manifest.json", release: "old-essential", modules: 4192 },
      ],
    }));
    packs = packPair(path.join(tmp, "good"), (lib) => {
      writeModule(lib, "Lib.A", [{ module: "Init" }, { module: "Init.Prelude" }, { module: "Lib.B" }]);
      writeModule(lib, "Lib.B", [{ module: "Init.Prelude" }]);
    });
  });

  test("assembles the staging layout contract: index + both manifests + every part, by basename", () => {
    const out = path.join(tmp, "staging/profiles");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "stale.part-000"), "left over from an earlier pack");
    const r = stage(packs, ["--out", out]);
    expect(r.status).toBe(0);
    const index = JSON.parse(fs.readFileSync(path.join(out, "index.json"), "utf8"));
    expect(index).toEqual({
      schema: "qed64.profile-index/v1",
      runtime: { buildId: BUILD, leanVersion: "4.99.0" },
      profiles: [
        { id: "core", manifest: "/profiles/lean-core.manifest.json", release: `lean-core-test-${BUILD}`, modules: 2 },
        { id: "essential", manifest: "/profiles/mathlib-essential.manifest.json", release: `mathlib-essential-test-${BUILD}`, modules: 2 },
      ],
    });
    const expected = new Set(["index.json"]);
    for (const entry of index.profiles) {
      const name = path.basename(entry.manifest);
      expected.add(name);
      const manifest = JSON.parse(fs.readFileSync(path.join(out, name), "utf8"));
      expect(fs.readFileSync(path.join(out, name), "utf8")).toBe(fs.readFileSync(path.join(packs, name), "utf8"));
      for (const part of manifest.content.pack.transport.parts) {
        const base = path.basename(part.url);
        expected.add(base);
        expect(`sha256:${createHash("sha256").update(fs.readFileSync(path.join(out, base))).digest("hex")}`).toBe(part.digest);
      }
    }
    // Rebuilt, not merged: the stale part of an earlier attempt is gone.
    expect(new Set(fs.readdirSync(out))).toEqual(expected);
  });

  test("--check-only verifies the pair and stages nothing; --expect-modules must be covered", () => {
    const out = path.join(tmp, "never/profiles");
    const list = path.join(tmp, "modules.txt");
    fs.writeFileSync(list, "# essential closure\nInit\nInit.Prelude\nLib.A\nLib.B\n");
    const ok = stage(packs, ["--out", out, "--check-only", "--expect-modules", list]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/all 2 listed modules are packed/);
    expect(fs.existsSync(out)).toBe(false);
    fs.writeFileSync(list, "Lib.A\nLib.B\nLib.Missing\n");
    const missing = stage(packs, ["--out", out, "--check-only", "--expect-modules", list]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/Lib\.Missing/);
  });

  test("refuses --out inside public/, a wrong Lean version, and a part whose bytes changed", () => {
    const inside = stage(packs, ["--out", "public/profiles"]);
    expect(inside.status).toBe(2);
    expect(inside.stderr).toMatch(/refusing --out .*public/);
    const version = run(stager, ["--packs", packs, "--build-id", BUILD, "--lean-version", "4.34.0", "--served-index", servedIndex, "--check-only"]);
    expect(version.status).toBe(1);
    expect(version.stderr).toMatch(/packed for Lean 4\.99\.0, this import is 4\.34\.0/);
    const tampered = path.join(tmp, "tampered");
    fs.cpSync(packs, tampered, { recursive: true });
    const part = fs.readdirSync(tampered).find((f) => f.includes(".part-"))!;
    const bytes = fs.readFileSync(path.join(tampered, part));
    bytes[bytes.length - 1]! ^= 0xff;
    fs.writeFileSync(path.join(tampered, part), bytes);
    const r = stage(tampered, ["--check-only"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not match its digest/);
  });

  test("refuses a pair that is not one import-closed library: a dangling import, a module in both packs, an absent root", () => {
    const dangling = stage(packPair(path.join(tmp, "dangling"), (lib) => {
      writeModule(lib, "Lib.A", [{ module: "Lib.Gone" }]);
    }), ["--check-only"]);
    expect(dangling.status).toBe(1);
    expect(dangling.stderr).toMatch(/resolve in neither pack.*Lib\.A → Lib\.Gone/);
    const overlap = stage(packPair(path.join(tmp, "overlap"), (lib) => {
      writeModule(lib, "Lib.A", [{ module: "Init.Prelude" }]);
      writeModule(lib, "Init.Prelude", []);
    }), ["--check-only"]);
    expect(overlap.status).toBe(1);
    expect(overlap.stderr).toMatch(/Init\.Prelude is in both/);
    const rootless = stage(packPair(path.join(tmp, "rootless"), (lib) => {
      writeModule(lib, "Lib.B", [{ module: "Init.Prelude" }]);
    }), ["--check-only"]);
    expect(rootless.status).toBe(1);
    expect(rootless.stderr).toMatch(/root module\(s\) not in the pack: Lib\.A/);
  });
});

describe("supervised-run.mjs", () => {
  const fakeRunner = (name: string, body: string) => {
    const file = path.join(tmp, `${name}.mjs`);
    fs.writeFileSync(file, `import fs from "node:fs";\nconst target = process.argv[2];\n${body}\n`);
    return file;
  };
  const supervise = (runner: string, target: string) =>
    run(supervisor, ["--target", target, "--quiet-ms", "400", "--stable-ms", "400", "--give-up-ms", "20000", "--runner", runner, "--", target]);

  test("reaps a runner that wrote its output and then never exits (the keepalive guard), exit 0", () => {
    const target = path.join(tmp, "kept-alive.olean");
    fs.writeFileSync(target, "stale output of an earlier run");
    const runner = fakeRunner("kept-alive", `
      if (fs.existsSync(target)) { console.log("STALE TARGET VISIBLE"); }
      console.log("[DEBUG:PROGRESS] Loading 3 modules...");
      setTimeout(() => fs.writeFileSync(target, "fresh olean bytes"), 300);
      setInterval(() => {}, 1000);`);
    const r = supervise(runner, target);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/STALE TARGET VISIBLE/);
    expect(r.stdout).toMatch(/stable at 17 bytes with the runner quiet — reaping/);
    expect(fs.readFileSync(target, "utf8")).toBe("fresh olean bytes");
  });

  test("a Lean error fails the job even though the process never exits and even if a target appears", () => {
    const target = path.join(tmp, "errored.olean");
    const runner = fakeRunner("errored", `
      console.log("/work/Essential.lean:7:0: error: unknown module prefix 'Mathlib.Gone'");
      fs.writeFileSync(target, "should not count");
      setInterval(() => {}, 1000);`);
    const r = supervise(runner, target);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAILED — the runner reported: .*unknown module prefix/);
  });

  test("warnings are not errors; an exit without output, or a non-zero exit, is a failure", () => {
    const warned = path.join(tmp, "warned.olean");
    const ok = supervise(fakeRunner("warned", `
      console.log("/work/Essential.lean:5:0: warning: \`Lean.RBTree\` is deprecated");
      fs.writeFileSync(target, "fine");`), warned);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/the runner exited 0 with warned\.olean at 4 bytes/);
    const silent = supervise(fakeRunner("silent", `console.log("did nothing");`), path.join(tmp, "silent.olean"));
    expect(silent.status).toBe(1);
    expect(silent.stdout).toMatch(/exited 0 but wrote no silent\.olean/);
    const crashed = supervise(fakeRunner("crashed", `fs.writeFileSync(target, "partial"); process.exit(3);`), path.join(tmp, "crashed.olean"));
    expect(crashed.status).toBe(1);
    expect(crashed.stdout).toMatch(/the runner exited 3/);
  });
});

describe("import-packs.sh contract validation (--dry-run)", () => {
  const SERVED_ROOTS = (JSON.parse(fs.readFileSync(path.join(root, "public/profiles/mathlib-essential.manifest.json"), "utf8")) as { content: { roots: string[] } }).content.roots;
  const dryRun = (args: string[]) => spawnSync("bash", [lane, ...args, "--dry-run"], { cwd: root, encoding: "utf8", timeout: 60_000 });
  const fakeK = (name: string, withMathlib: boolean) => {
    const k = path.join(tmp, name);
    const lib = path.join(k, "build/stage1/lib/lean");
    fs.mkdirSync(path.join(k, "build/stage1/bin"), { recursive: true });
    fs.writeFileSync(path.join(k, "build/stage1/bin/lean.js"), "// glue\n");
    fs.writeFileSync(path.join(k, "build/stage1/bin/lean.wasm"), Buffer.from(`\0asm-${name}`));
    fs.mkdirSync(path.join(lib, "Init"), { recursive: true });
    for (const f of ["Init.olean", "Init.olean.server", "Init.olean.private", "Init.ir", "Init.ir.sig", "Init/Prelude.olean"]) fs.writeFileSync(path.join(lib, f), "x");
    fs.writeFileSync(path.join(k, "BUILT-COMMIT"), `${"ab".repeat(20)}\n`);
    if (withMathlib) {
      const tree = path.join(k, "mathlib/essential-tree");
      for (const d of ["Mathlib", "Lean", "Std"]) fs.mkdirSync(path.join(tree, d), { recursive: true });
      for (const r of SERVED_ROOTS) {
        const f = path.join(tree, `${r.split(".").join("/")}.olean`);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, "x");
      }
      fs.writeFileSync(path.join(k, "mathlib/essential-modules.txt"), SERVED_ROOTS.join("\n"));
      fs.writeFileSync(path.join(k, "mathlib/MATHLIB-COMMIT"), `${"cd".repeat(20)}\n`);
    }
    return k;
  };

  test("a complete K: contract met, the plan names every step, nothing is run or created", () => {
    const k = fakeK("k-complete", true);
    const scratch = path.join(tmp, "scratch-complete");
    const r = dryRun([k, "--lean-version", "4.34.0", "--scratch", scratch]);
    expect(r.stdout).toMatch(/DRY RUN — contract met, nothing was run/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/buildId {2}wasm64-[0-9a-f]{16}/);
    expect(r.stdout).toMatch(/--release lean-core-4\.34\.0-wasm64-[0-9a-f]{16} --url-prefix \/profiles\//);
    expect(r.stdout).toMatch(/--release mathlib-essential-cdcdcdc-wasm64-[0-9a-f]{16}/);
    expect(r.stdout).toMatch(/QED64_SNAP_WORK=.*scratch-complete\/snapshot .*bump-chain\.sh stage-artifact/);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  test("a K without its Mathlib half: each missing contract path is named, exit 1", () => {
    const k = fakeK("k-runtime-only", false);
    const r = dryRun([k, "--lean-version", "4.34.0"]);
    expect(r.status).toBe(1);
    const missing = r.stdout.split("\n").filter((l) => l.startsWith("  MISSING  "));
    expect(missing).toEqual([
      `  MISSING  ${fs.realpathSync(k)}/mathlib/essential-tree/`,
      `  MISSING  ${fs.realpathSync(k)}/mathlib/essential-modules.txt`,
      `  MISSING  ${fs.realpathSync(k)}/mathlib/MATHLIB-COMMIT`,
    ]);
    expect(r.stdout).toMatch(/IMPORT-FAIL the K contract is not met: 3 problem/);
  });

  test("--lean-version is required and has no default; a malformed BUILT-COMMIT and an Init-carrying essential tree are contract violations", () => {
    const k = fakeK("k-bad", true);
    fs.writeFileSync(path.join(k, "BUILT-COMMIT"), "8d91aad\n");
    fs.mkdirSync(path.join(k, "mathlib/essential-tree/Init"));
    const r = dryRun([k]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/MISSING {2}--lean-version <x\.y\.z> \(required/);
    expect(r.stdout).toMatch(/BUILT-COMMIT exists but is not 40 lowercase hex/);
    expect(r.stdout).toMatch(/must NOT contain Init/);
    expect(dryRun([k, "--lean-version", "v4.34.0"]).stdout).toMatch(/is not x\.y\.z/);
  });

  test("refuses a scratch dir whose lib-tree/ and snapshot/ would be the served pairing's, and unknown steps", () => {
    const k = fakeK("k-scratch", true);
    const r = dryRun([k, "--lean-version", "4.34.0", "--scratch", "work"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/IMPORT-FAIL --scratch .* is not a private scratch dir/);
    const step = dryRun([k, "--lean-version", "4.34.0", "--only", "bake"]);
    expect(step.status).toBe(2);
    expect(step.stdout).toMatch(/unknown step 'bake'/);
  });
  test("K whose runtime is already served: a full run refuses (nothing to import); a partial re-issue without 'stage' proceeds", () => {
    const k = fakeK("k-served", true);
    const wasm = fs.readFileSync(path.join(k, "build/stage1/bin/lean.wasm"));
    const id = `wasm64-${createHash("sha256").update(wasm).digest("hex").slice(0, 16)}`;
    const pub = fs.mkdtempSync(path.join(tmp, "public-served-"));
    fs.mkdirSync(path.join(pub, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(pub, "runtime/runtime-manifest.json"), JSON.stringify({ buildId: id, leanVersion: "4.34.0", files: {} }));
    const env = { ...process.env, QED64_PUBLIC_DIR: pub };
    const full = spawnSync("bash", [lane, k, "--lean-version", "4.34.0", "--dry-run"], { cwd: root, encoding: "utf8", env });
    expect(full.status).toBe(1);
    expect(full.stdout).toMatch(/IS the served runtime .* nothing to import/);
    const partial = spawnSync("bash", [lane, k, "--lean-version", "4.34.0", "--dry-run", "--only", "pack-extra"], { cwd: root, encoding: "utf8", env });
    expect(partial.status).toBe(0);
    expect(partial.stdout).toMatch(/partial re-issue of: +pack-extra/);
    expect(partial.stdout).toMatch(/DRY RUN/);
  });
});
