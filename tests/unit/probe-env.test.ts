// snapshot-probe's runtime environment (HARDENING #66). The Emscripten glue does `var ENV={}` and
// then `Module["ENV"]=ENV`, replacing any ENV key of the Module literal, so only an assignment made
// at preRun reaches getenv. The probe passed its ENV in the literal: QED64_PROFILE_INIT never
// reached the runtime, and LEAN_PATH only seemed set because the sysroot gives the same root.
//
// Safety: no real runtime. The artifact is a FAKE whose bin/lean.js does what the real glue does
// with ENV (replaces it, then runs preRun), prints the environment getenv would read, and then
// answers the exports the probe calls with a passing compile. Every child has a SIGKILL timeout.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const probe = path.join(root, "pipeline/snapshot/snapshot-probe.mjs");

const FAKE_GLUE = `// fake lean.js: the real glue's ENV handling, then a passing compile; no wasm
const M = globalThis.Module;
var ENV = {};
M["ENV"] = ENV; // as the real glue: whatever ENV the literal carried is gone
M.FS = { filesystems: { NODEFS: {} }, mkdir() {}, mount() {}, chdir() {} };
for (const f of [].concat(M.preRun || [])) f();
process.stdout.write("GETENV " + JSON.stringify(ENV) + "\\n");
Object.assign(M, {
  getValue: (p, t) => (t === "i64" ? 1n : 0),
  stringToNewUTF8: () => 8, _lean_mk_string: () => 16, _free() {}, _malloc: () => 64,
  _lean_initialize_runtime_module() {}, _lean_initialize() {}, _lean_io_mark_end_initialization() {},
  _lean_init_search_path: () => 32,
  _lean_wasm_load_snapshot: () => 48,
  _lean_wasm_compile: () => { M.print('{"severity":"information","pos":{"line":1,"column":0},"data":"1 : Nat"}'); return 48; },
});
M.onRuntimeInitialized();
`;

let tmp: string;
let art: string;
let lib: string;
let snap: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qed64-probe-env-")));
  art = path.join(tmp, "artifact");
  fs.mkdirSync(path.join(art, "bin"), { recursive: true });
  fs.writeFileSync(path.join(art, "bin/lean.js"), FAKE_GLUE);
  lib = path.join(tmp, "lib");
  fs.mkdirSync(lib);
  snap = path.join(tmp, "probe-input.snap");
  fs.writeFileSync(snap, "not a real snapshot");
});
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function probeEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["QED64_LEAN_ARTIFACT", "QED64_LIB_TREE", "QED64_PROFILE_INIT", "NODE_OPTIONS"].includes(k)) env[k] = v;
  const r = spawnSync(process.execPath, ["--stack-size=8192", probe, "--snap", snap, "--probe", "#check 1", "--artifact", art, "--lib", lib, "--watchdog-ms", "0"], {
    cwd: tmp, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", env: { ...env, TMPDIR: tmp, ...extra },
  });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("GETENV "));
  return { status: r.status, out: `${r.stdout}${r.stderr}`, env: line ? JSON.parse(line.slice("GETENV ".length)) : null };
}

describe("snapshot-probe: the runtime environment is set at preRun, where getenv reads it", () => {
  test("LEAN_PATH reaches the runtime; QED64_PROFILE_INIT does when set, and only then", () => {
    const plain = probeEnv({});
    expect(plain.env, plain.out).toEqual({ LEAN_PATH: "/lib/lean" });
    expect(plain.status, plain.out).toBe(0);
    const profiled = probeEnv({ QED64_PROFILE_INIT: "1" });
    expect(profiled.env, profiled.out).toEqual({ LEAN_PATH: "/lib/lean", QED64_PROFILE_INIT: "1" });
    expect(profiled.status, profiled.out).toBe(0);
  });
});
