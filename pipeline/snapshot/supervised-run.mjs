#!/usr/bin/env node
// Run the wasm64 Lean CLI (node-runner.mjs) for a job that writes ONE output
// file, and come back when the job is done rather than when the process exits.
//
// Since the keepalive guard (patch 0020) and the resident transport (0031) the
// one-shot CLI does its work and then never exits (HARDENING #47), so a
// script that waits on `lean -o X.olean X.lean` waits forever. bake-snapshot
// supervises its own runner the same way; this is that loop for any other
// single-output job (the QED64.Essential umbrella compile). The job is judged
// by OUTPUT:
//   done   — the target exists, its size has not changed for --stable-ms, and
//            the runner has printed nothing for --quiet-ms → the child is
//            reaped, exit 0. The target is unlinked first, so a stale file
//            from an earlier run can never satisfy this.
//   failed — the runner printed an error (Lean `…: error: …`, an uncaught
//            exception, a PANIC, an abort) → exit 1, even if a target appeared;
//            or the runner exited non-zero; or it exited 0 with no target; or
//            nothing finished within --give-up-ms.
//
// Usage: node pipeline/snapshot/supervised-run.mjs --target <file> \
//          [--quiet-ms 30000] [--stable-ms 30000] [--give-up-ms 7200000] \
//          -- <node-runner.mjs arguments…>
// (--runner <script> replaces node-runner.mjs; the unit test uses it.)

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const own = split >= 0 ? argv.slice(0, split) : argv;
const runnerArgs = split >= 0 ? argv.slice(split + 1) : [];
const arg = (name, fallback) => {
  const i = own.indexOf(`--${name}`);
  return i >= 0 && own[i + 1] ? own[i + 1] : fallback;
};
const targetArg = arg("target", null);
if (!targetArg || runnerArgs.length === 0) {
  console.error("usage: supervised-run.mjs --target <file> [--quiet-ms n] [--stable-ms n] [--give-up-ms n] -- <node-runner arguments…>");
  process.exit(2);
}
const target = path.resolve(targetArg);
const quietMs = Number(arg("quiet-ms", 30_000));
const stableMs = Number(arg("stable-ms", 30_000));
const giveUpMs = Number(arg("give-up-ms", 2 * 60 * 60 * 1000));
const runner = path.resolve(arg("runner", path.join(here, "node-runner.mjs")));
const FAILURE = /(^|\n)[^\n]*(: error[:( ]|^error:|uncaught exception|PANIC|ABORT:|RuntimeError:)/m;

try { fs.rmSync(target); } catch { /* absent */ }

const child = spawn("node", ["--stack-size=8192", runner, ...runnerArgs], { stdio: ["ignore", "pipe", "pipe"] });
const started = Date.now();
let lastActivity = started;
let failure = null;
let carry = "";
const watchOutput = (stream, sink) => {
  stream.on("data", (chunk) => {
    lastActivity = Date.now();
    sink.write(chunk);
    // Match across chunk boundaries without keeping the whole log.
    const text = carry + chunk.toString("utf8");
    const hit = FAILURE.exec(text);
    if (hit && !failure) failure = text.slice(hit.index).split("\n").find((line) => line.trim() !== "")?.trim() ?? "error";
    carry = text.slice(-512);
  });
};
watchOutput(child.stdout, process.stdout);
watchOutput(child.stderr, process.stderr);

let lastSize = -1;
let stableSince = 0;
let settled = false;
const settle = (code, why) => {
  if (settled) return;
  settled = true;
  clearInterval(watch);
  console.log(`supervised-run: ${why} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  process.exitCode = code;
};
const watch = setInterval(() => {
  const now = Date.now();
  const size = fs.existsSync(target) ? fs.statSync(target).size : -1;
  if (size !== lastSize) { lastSize = size; stableSince = now; }
  const quiet = now - lastActivity > quietMs;
  if (failure && quiet) return settle(1, `FAILED — the runner reported: ${failure}`);
  if (!failure && quiet && size > 0 && now - stableSince > stableMs) {
    return settle(0, `${path.basename(target)} stable at ${size} bytes with the runner quiet — reaping the kept-alive CLI`);
  }
  if (now - started > giveUpMs) return settle(1, `FAILED — no finished ${path.basename(target)} within ${giveUpMs} ms`);
}, Math.min(5000, Math.max(50, Math.floor(Math.min(quietMs, stableMs) / 4))));

child.on("error", (error) => settle(1, `FAILED — could not start the runner: ${error.message}`));
child.on("exit", (code, signal) => {
  if (settled) return;
  const size = fs.existsSync(target) ? fs.statSync(target).size : -1;
  if (failure) return settle(1, `FAILED — the runner reported: ${failure}`);
  if (code !== 0) return settle(1, `FAILED — the runner exited ${code ?? signal}`);
  if (size <= 0) return settle(1, `FAILED — the runner exited 0 but wrote no ${path.basename(target)}`);
  settle(0, `the runner exited 0 with ${path.basename(target)} at ${size} bytes`);
});
