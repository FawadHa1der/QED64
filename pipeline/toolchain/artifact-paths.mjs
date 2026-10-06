// Artifact discipline shared by every producer (chunk-runtime, bake-snapshot)
// and the promote step — review C6 / migration phase 1 — and the path rule
// every pipeline tool resolves its inputs and outputs by (plan step A3):
//   - ONE runtime identity function (`wasm64-<sha256(lean.wasm)[:16]>`), so a
//     bake stamps the same `runtime` into its index entries that the chunker
//     writes into the manifest, and the worker can refuse an unpaired load;
//   - producers stage under work/staging/<buildId>/ and hard-error on any
//     --out that resolves inside public/ (HARDENING #32: the chunker once
//     destroyed the served chunks); only promote writes public/, additively;
//   - ONE path-resolution rule (resolveToolPath, docs/CLI-CONTRACT.md "Path
//     resolution"): the flag, its environment variable, the deprecated
//     repo-relative default (one re-pin cycle, one WARNING), else exit 2;
//   - the --stack-size=8192 the wasm-booting tools need (ensureStackSize).
// Node built-ins only and no relative imports: lean4game vendors this file
// one by one beside the scripts that import it (scripts/sync-qed64.sh).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The runtime buildId as chunk-runtime.mjs has always computed it. */
export function runtimeBuildId(wasmBytes) {
  return `wasm64-${createHash("sha256").update(wasmBytes).digest("hex").slice(0, 16)}`;
}

/** Read lean.wasm from a stage1-style artifact dir (`<dir>/bin/lean.wasm`) or a
 * bin dir (`<dir>/lean.wasm`) and return its buildId; null when absent. */
export function buildIdOfArtifact(dir) {
  for (const candidate of [path.join(dir, "bin/lean.wasm"), path.join(dir, "lean.wasm")]) {
    if (fs.existsSync(candidate)) return runtimeBuildId(fs.readFileSync(candidate));
  }
  return null;
}

/** work/staging/<buildId>/<kind> — the producers' default output. */
export function stagingDir(root, buildId, kind) {
  return path.join(root, "work/staging", buildId, kind);
}

/** True when `target` is public/ itself or anything beneath it. Symlinks are
 * resolved as far as they exist so `public/snapshots-0031 -> ../work/...` and
 * a symlink INTO public/ are both judged by where the bytes would land. */
export function isInsidePublic(root, target) {
  const publicDir = realpathAsFar(path.resolve(root, "public"));
  const resolved = realpathAsFar(path.resolve(target));
  return resolved === publicDir || resolved.startsWith(publicDir + path.sep);
}

function realpathAsFar(p) {
  // realpath of the deepest existing ancestor + the remaining segments, so a
  // not-yet-created output dir is still resolved through existing symlinks.
  let head = p;
  const tail = [];
  while (!fs.existsSync(head)) {
    tail.unshift(path.basename(head));
    const parent = path.dirname(head);
    if (parent === head) return p;
    head = parent;
  }
  return path.join(fs.realpathSync(head), ...tail);
}

/** Exit 2 with a one-line reason when a producer would write into public/. */
export function refuseInsidePublic(root, target, who) {
  if (!isInsidePublic(root, target)) return;
  console.error(`${who}: refusing --out ${target}: it resolves inside public/. ` +
    "Producers stage under work/staging/<buildId>/; use `npm run promote:staging` to publish (HARDENING #32).");
  process.exit(2);
}

/**
 * Where a tool's path comes from, without printing anything: the explicit
 * flag value (a relative one resolves against `base`, default the cwd), else
 * the environment variable `env` (non-empty; relative to the cwd), else the
 * deprecated default `legacy` when `holds(legacy)` (no `holds`: always, as for
 * an output dir the tool creates). `envTo` maps the variable's value to the
 * path (QED64_STAGING names a root: <root>/<buildId>/<kind>). Returns
 * `{ path, source }` with source "flag" | "env" | "default", or null when
 * nothing resolves.
 */
export function toolPath({ value, env, envTo = null, legacy = null, holds = null, base = process.cwd(), environment = process.env }) {
  if (value) return { path: path.resolve(base, value), source: "flag" };
  const fromEnv = env ? environment[env] : undefined;
  if (fromEnv) return { path: path.resolve(envTo ? envTo(fromEnv) : fromEnv), source: "env" };
  if (legacy && (!holds || holds(legacy))) return { path: path.resolve(legacy), source: "default" };
  return null;
}

/**
 * The one path-resolution rule of the pipeline tools (docs/CLI-CONTRACT.md
 * "Path resolution"): toolPath(), plus what the tool prints. A deprecated
 * default prints exactly one WARNING on stderr and still resolves; when
 * nothing resolves the tool prints one line naming the flag and the variable,
 * then `usage: <synopsis>`, and exits 2 before any side effect.
 * `o`: { tool, flag, placeholder, value, env, legacy, legacyLabel, holds,
 * needs, base, usage }; `needs` names what `holds` checks ("bin/lean.js").
 */
export function resolveToolPath(o, io = { err: (s) => console.error(s), exit: (c) => process.exit(c), environment: process.env }) {
  const r = toolPath({ ...o, environment: io.environment ?? process.env });
  if (r?.source === "default") {
    io.err(`${o.tool}: WARNING — the default --${o.flag} ${o.legacyLabel} (${r.path}) is deprecated; use --${o.flag} ${o.placeholder} or set ${o.env} (docs/CLI-CONTRACT.md)`);
  }
  if (r) return r;
  const tail = o.legacy ? `; the deprecated default ${path.resolve(o.legacy)} ${o.needs ? `has no ${o.needs}` : "is absent"}` : "";
  io.err(`${o.tool}: no --${o.flag} given and ${o.env} is unset${tail} — pass --${o.flag} ${o.placeholder} or set ${o.env}`);
  io.err(`usage: ${o.usage}`);
  io.exit(2);
  return null;
}

const STACK_SIZE_FLAG = /^--stack[-_]size(=|$)/;

/**
 * The tools that boot the wasm runtime in their own process need V8's
 * --stack-size=8192 (docs/CLI-CONTRACT.md "Runtime"). Started without any
 * --stack-size, this replaces the process with itself plus that flag through
 * process.execve: the same PID, the same stdin/stdout/stderr, the new image's
 * exit code, nothing printed, so a supervisor that pipes and SIGKILLs the PID
 * (supervised-run, bake-snapshot, gate's timeout) sees one process. An
 * explicit --stack-size of any size is respected. Where execve is unavailable
 * (Windows, a Node without it) or would drop an IPC channel, one WARNING says
 * how to run the tool and it continues as before. Call it before printing.
 */
export function ensureStackSize(tool, kib = 8192, proc = process) {
  if (proc.execArgv.some((a) => STACK_SIZE_FLAG.test(a))) return "present";
  const how = `run it as node --stack-size=${kib} ${path.basename(proc.argv[1] ?? tool)} (docs/CLI-CONTRACT.md)`;
  if (typeof proc.execve !== "function" || proc.channel) {
    console.error(`${tool}: WARNING — started without --stack-size and cannot re-exec itself with it; ${how}`);
    return "absent";
  }
  try {
    proc.execve(proc.execPath, [proc.execPath, ...proc.execArgv, `--stack-size=${kib}`, ...proc.argv.slice(1)], { ...proc.env });
  } catch (e) {
    console.error(`${tool}: WARNING — started without --stack-size and the re-exec failed (${e?.code ?? e?.message}); ${how}`);
  }
  return "absent";
}

/** How to get the lean4-wasm64 package (decision 10: a devDependency pinned by its release tgz URL). */
export const LEAN4_WASM64_TGZ_HINT = "npm i -D <release tgz URL> (toolchain/lean4-wasm64-release.json names it)";

/** Whether `dir` holds a package.json whose name is lean4-wasm64. */
function isLean4Wasm64(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "lean4-wasm64";
  } catch {
    return false; // absent or not a package
  }
}

/**
 * The lean4-wasm64 package dir: $LEAN4_WASM64_DIR (relative to `cwd`), else
 * the first <ancestor of cwd>/node_modules/lean4-wasm64 whose package.json
 * name is lean4-wasm64 (the consumer's own install), else null. The variable
 * passes the same name check: a dir it names that is not the package gives
 * null (no fallback to the walk). Never resolves from this file's own
 * location and never imports the package: the forwards below hand it paths
 * (docs/CLI-CONTRACT.md "lean4-wasm64").
 */
export function lean4Wasm64Dir({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.LEAN4_WASM64_DIR) {
    const named = path.resolve(cwd, env.LEAN4_WASM64_DIR);
    return isLean4Wasm64(named) ? named : null;
  }
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    const candidate = path.join(d, "node_modules", "lean4-wasm64");
    if (isLean4Wasm64(candidate)) return candidate;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * Replace this process with `node <pkg>/<script> ...args` through
 * process.execve: the same PID, stdio and exit code, so a supervisor sees one
 * process. Where execve is unavailable (or would drop an IPC channel) the
 * script runs as a child with inherited stdio: SIGINT/SIGTERM/SIGHUP are
 * passed on to it, and this process exits when it does, with its code or
 * 128 + its signal. Each refusal is one stderr line and exit 2: no package
 * (naming LEAN4_WASM64_DIR and the install), a LEAN4_WASM64_DIR that is not
 * the package, a package without `script`, or a `script` that is the running
 * script itself (it would re-exec forever).
 */
export function forwardToLean4Wasm64(tool, script, args, { env = process.env, cwd = process.cwd(), proc = process } = {}) {
  const dir = lean4Wasm64Dir({ env, cwd });
  const how = `set LEAN4_WASM64_DIR=<package dir> or install it: ${LEAN4_WASM64_TGZ_HINT} (docs/CLI-CONTRACT.md)`;
  const refuse = (line) => {
    console.error(line);
    return proc.exit(2);
  };
  if (!dir && env.LEAN4_WASM64_DIR) {
    const named = path.resolve(cwd, env.LEAN4_WASM64_DIR);
    return refuse(`${tool}: LEAN4_WASM64_DIR=${named} is not the lean4-wasm64 package (no package.json named lean4-wasm64) — ${how}`);
  }
  if (!dir) return refuse(`${tool}: lean4-wasm64 not found — ${how}`);
  const target = path.join(dir, script);
  if (!fs.existsSync(target)) return refuse(`${tool}: lean4-wasm64 at ${dir} has no ${script} — ${how}`);
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if (proc.argv[1] && real(target) === real(proc.argv[1])) {
    return refuse(`${tool}: lean4-wasm64 at ${dir} would run this script again (${target}) — ${how}`);
  }
  const argv = [proc.execPath, target, ...args];
  if (typeof proc.execve === "function" && !proc.channel) {
    try {
      return proc.execve(proc.execPath, argv, { ...env });
    } catch { /* fall through to a child process */ }
  }
  // Built-ins fetched lazily, so this file's import list stays as lean4game vendors it.
  // spawn, not spawnSync: a blocked spawnSync parent dies alone on a signal and
  // leaves the package's tool (and the runtime a gate starts) orphaned.
  const { spawn } = proc.getBuiltinModule("node:child_process");
  const { constants } = proc.getBuiltinModule("node:os");
  const child = spawn(proc.execPath, argv.slice(1), { stdio: "inherit", env: { ...env } });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) proc.on(sig, () => child.kill(sig));
  child.on("error", (e) => refuse(`${tool}: could not start lean4-wasm64 ${script} (${e.code ?? e.message}) — ${how}`));
  child.on("exit", (code, signal) => proc.exit(code ?? 128 + (constants.signals[signal] ?? 0)));
}
