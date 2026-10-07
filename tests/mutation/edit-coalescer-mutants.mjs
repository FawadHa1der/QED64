#!/usr/bin/env node
// Mutation test for the edit coalescer's back-pressure rules
// (lib/edit-coalescer.ts; docs/EMBEDDING.md §7.8, HARDENING
// #59). Each mutant below is one deliberate wrong rule — the comparison off by
// one, a guard dropped, a release without a hold, a cap that restarts, a
// timer left behind — applied to a COPY of the source under work/embed/mutants
// (gitignored; the served source is never touched, so a dev server's HMR
// never fires). The unit suites of the coalescer and of the session adapter
// run against the copy through a vitest alias; a mutant the suites fail on is
// killed, one they pass on survived and names a rule no test pins.
//
// Usage: node tests/mutation/edit-coalescer-mutants.mjs [--only <substring>]
// Exit 0 = the baseline passes and every mutant is killed; 1 = a survivor;
// 3 = the baseline itself fails (results would mean nothing).
// Never writes under node_modules; vitest runs from the worktree root.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(root, "lib/edit-coalescer.ts");
const OUT = path.join(root, "work/embed/mutants");
const TESTS = ["tests/unit/edit-coalescer.test.ts", "tests/unit/resident-session.test.ts"];
const only = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? process.argv[i + 1] ?? "" : ""; })();

/** Each `find` must occur exactly once in the source (`all: true`: at least once, every occurrence mutated); a mutant that matches nowhere is a stale list, refused. */
const MUTANTS = [
  { name: "pressured: `<` becomes `<=` (holds at exactly K free)", find: "p.unused < minFree", replace: "p.unused <= minFree" },
  { name: "pressured: an unmeasured pool (-1) counts as pressured", find: "p.unused >= 0 && p.unused < minFree", replace: "p.unused < minFree" },
  { name: "pressured: 0 free Workers counts as unmeasured (the worst case never holds)", find: "p.unused >= 0 && p.unused < minFree", replace: "p.unused > 0 && p.unused < minFree" },
  { name: "options: minFreeWorkers 0 falls back to the default (`||` for `??`)", find: "const minFree = backPressure.minFreeWorkers ?? DEFAULT_MIN_FREE_WORKERS;", replace: "const minFree = backPressure.minFreeWorkers || DEFAULT_MIN_FREE_WORKERS;" },
  { name: "tick: releases under pressure (no hold at the window's end)", find: "if (pressured()) hold(); else release();", replace: "release();" },
  { name: "tick: holds without pressure", find: "if (pressured()) hold(); else release();", replace: "hold();" },
  { name: "observe: releases while still pressured", find: "if (cap !== undefined && !pressured()) { event(\"release\", now() - heldSince); release(); }\n    },", replace: "if (cap !== undefined) { event(\"release\", now() - heldSince); release(); }\n    }," },
  { name: "observe: releases (flushes) without a hold for the pool", find: "if (cap !== undefined && !pressured()) { event(\"release\", now() - heldSince); release(); }\n    },", replace: "if (!pressured()) { event(\"release\", now() - heldSince); release(); }\n    }," },
  { name: "observe: a malformed sample is taken as is", find: "pool = sample && typeof sample.unused === \"number\" && typeof sample.running === \"number\" ? sample : null;", replace: "pool = sample ?? null;" },
  { name: "observe: the first sample sticks", find: "pool = sample && typeof sample.unused === \"number\" && typeof sample.running === \"number\" ? sample : null;", replace: "pool = pool ?? (sample && typeof sample.unused === \"number\" && typeof sample.running === \"number\" ? sample : null);" },
  { name: "a barrier's flush forwards the queue before the held change", find: "    if (held) { const m = held; held = null; sendChange(m); }\n    for (const x of queue.splice(0)) admit(x.msg);", replace: "    for (const x of queue.splice(0)) admit(x.msg);\n    if (held) { const m = held; held = null; sendChange(m); }" },
  // The memory of the last pressured sample.
  { name: "memory: a hold by the memory alone is never re-checked", find: "    if (!sampled(pool)) scheduleRecheck(); // held by the memory alone\n", replace: "" },
  { name: "memory: a pressured sample during a hold does not move the re-check", find: "if (sampled(pool)) { lastPressuredAt = now(); if (cap !== undefined) scheduleRecheck(); }", replace: "if (sampled(pool)) { lastPressuredAt = now(); }" },
  { name: "memory: the re-check releases while still pressured", find: "if (cap !== undefined && !pressured()) { event(\"release\", now() - heldSince); release(); } }, Math.max", replace: "if (cap !== undefined) { event(\"release\", now() - heldSince); release(); } }, Math.max" },
  { name: "memory: the re-check timer outlives the hold", find: "    if (recheck !== undefined) timers.clearTimeout(recheck);\n    recheck = undefined;\n  };", replace: "  };" },
  { name: "memory: ignored (only the latest sample counts)", find: "const pressured = () => sampled(pool) || now() - lastPressuredAt < memory;", replace: "const pressured = () => sampled(pool);" },
  { name: "memory: never recorded", find: "if (sampled(pool)) { lastPressuredAt = now(); if (cap !== undefined) scheduleRecheck(); }", replace: "if (sampled(pool)) { if (cap !== undefined) scheduleRecheck(); }" },
  { name: "memory: `<` becomes `<=`", find: "now() - lastPressuredAt < memory", replace: "now() - lastPressuredAt <= memory" },
  { name: "memory: the host's value is ignored", find: "const memory = backPressure.pressureMemoryMs ?? DEFAULT_PRESSURE_MEMORY_MS;", replace: "const memory = DEFAULT_PRESSURE_MEMORY_MS;" },
  { name: "the default memory is 500 ms", find: "export const DEFAULT_PRESSURE_MEMORY_MS = 1000;", replace: "export const DEFAULT_PRESSURE_MEMORY_MS = 500;" },
  { name: "the default cap is 8", find: "export const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 6;", replace: "export const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 8;" },
  { name: "a release drains the queue before the held change goes (the queue then waits for a reply that never comes)", find: "    if (held) { const m = held; held = null; sendChange(m); }\n    drain();", replace: "    drain();\n    if (held) { const m = held; held = null; sendChange(m); }" },
  { name: "send: a quiet change under pressure goes at once", find: "if (timer === undefined && !pressured()) { sendChange(msg); supersede(uriOf(msg)); return; }", replace: "if (timer === undefined) { sendChange(msg); supersede(uriOf(msg)); return; }" },
  { name: "send: a quiet change under pressure is held with no cap", find: "if (timer === undefined) hold();", replace: "" },
  { name: "send: a change held inside the window starts a cap", find: "if (timer === undefined) hold();", replace: "hold();" },
  { name: "replacement restarts the cap", find: "held = msg; // newest wins; the queue stays behind it, and a hold for the pool keeps its cap", replace: "held = msg; if (cap !== undefined) { endHold(); hold(); }" },
  { name: "a barrier's flush keeps the cap (a late cap fires after it)", find: "    endHold();\n    if (held) { const m = held; held = null; sendChange(m); }\n    for (const x of queue.splice(0))", replace: "    if (held) { const m = held; held = null; sendChange(m); }\n    for (const x of queue.splice(0))" },
  { name: "a release keeps the cap (a second, spurious cap after a drained-pool release)", find: "    endHold();\n    if (held) { const m = held; held = null; sendChange(m); }\n    drain();", replace: "    if (held) { const m = held; held = null; sendChange(m); }\n    drain();" },
  { name: "the cap fires without forwarding", find: "    event(\"cap\", now() - heldSince);\n    release();", replace: "    event(\"cap\", now() - heldSince);" },
  { name: "dispose leaves the cap timer", find: "      timer = undefined;\n      endHold();", replace: "      timer = undefined;" },
  { name: "the cap is the window, not maxHoldMs", find: "cap = timers.setTimeout(capped, maxHold);", replace: "cap = timers.setTimeout(capped, ms);" },
  { name: "the hold's clock is not reset per hold", find: "    heldSince = now();\n", replace: "" },
  { name: "the default threshold is 5", find: "export const DEFAULT_MIN_FREE_WORKERS = 6;", replace: "export const DEFAULT_MIN_FREE_WORKERS = 5;" },
  { name: "the default cap is 3 s", find: "export const DEFAULT_MAX_HOLD_MS = 5000;", replace: "export const DEFAULT_MAX_HOLD_MS = 3000;" },
  { name: "the host's threshold is ignored", find: "const minFree = backPressure.minFreeWorkers ?? DEFAULT_MIN_FREE_WORKERS;", replace: "const minFree = DEFAULT_MIN_FREE_WORKERS;" },
  { name: "the host's cap is ignored", find: "const maxHold = backPressure.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;", replace: "const maxHold = DEFAULT_MAX_HOLD_MS;" },
  { name: "a release is reported as a cap (both release paths)", find: "event(\"release\", now() - heldSince)", replace: "event(\"cap\", now() - heldSince)", all: true },
  { name: "the hold event is never emitted", find: "    event(\"hold\");", replace: "" },
  { name: "events report no queue", find: "queued: queue.length", replace: "queued: 0" },
  // The cap on requests in flight.
  { name: "cap: one more request in flight than the cap", find: "pending.size < maxInFlight", replace: "pending.size <= maxInFlight" },
  { name: "cap: 0 admits nothing instead of everything", find: "const slotFree = () => maxInFlight <= 0 || pending.size < maxInFlight;", replace: "const slotFree = () => pending.size < maxInFlight;" },
  { name: "cap: the drain ignores the slots", find: "      if (isRequest(x.msg) && !slotFree()) {", replace: "      if (false) {" },
  { name: "keep-alive: a keep-alive waits for a request slot like any frame", find: "      if (!replay && !held && isKeepAlive(msg)) { forward(msg); return; } // waits for no slot (see above)\n", replace: "" },
  { name: "keep-alive: the drain leaves queued keep-alives behind a waiting request", find: "        for (let i = 1; i < queue.length;) { if (isKeepAlive(queue[i]!.msg)) forward(queue.splice(i, 1)[0]!.msg); else i += 1; }\n", replace: "" },
  { name: "keep-alive: $/lean/rpc/release jumps the queue too", find: "msg.method === \"$/lean/rpc/keepAlive\" && msg.id === undefined;", replace: "(msg.method === \"$/lean/rpc/keepAlive\" || msg.method === \"$/lean/rpc/release\") && msg.id === undefined;" },
  { name: "cap: a notification behind a waiting request passes it", find: "if (queue.length > 0 || (isRequest(msg) && !slotFree())) {", replace: "if (isRequest(msg) && !slotFree()) {" },
  { name: "cap: a reply admits nothing", find: "      if (pending.delete(id)) drain();", replace: "      pending.delete(id);" },
  { name: "cap: the wait event is never emitted", find: "          if (isRequest(msg)) event(\"wait\");\n", replace: "" },
  { name: "cancel: a cancel for a request in flight waits in the queue", find: "if (i < 0) { forward(msg); return; }", replace: "if (i < 0) { queue.push({ msg, seq: changeSeq }); return; }" },
  { name: "cancel: a queued request is forwarded with its cancel instead of answered", find: "        reject(q!.msg, CANCELLED);\n", replace: "        admit(q!.msg); forward(msg);\n" },
  { name: "cancel: answered ContentModified instead of RequestCancelled", find: "reject(q!.msg, CANCELLED)", replace: "reject(q!.msg, SUPERSEDED)" },
  { name: "supersede: a change forwarded ahead of waiting requests does not answer the ones Monaco rebases", find: "{ sendChange(msg); supersede(uriOf(msg)); return; }", replace: "{ sendChange(msg); return; }" },
  { name: "supersede: ignores the document", find: "SUPERSEDED_METHODS.has(q.msg.method as string) && uriOf(q.msg) === uri", replace: "SUPERSEDED_METHODS.has(q.msg.method as string)" },
];

const source = fs.readFileSync(SRC, "utf8");
fs.mkdirSync(OUT, { recursive: true });
const vitest = (cfg, label) => {
  const args = ["vitest", "run", "--root", root, ...(cfg ? ["--config", cfg] : []), "--reporter=dot", ...TESTS];
  const r = spawnSync("npx", args, { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
  const text = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
  fs.writeFileSync(path.join(OUT, `${label}.log`), text);
  // A kill is a test that FAILED. A run where no test ran (a module that did
  // not resolve, a syntax error in the mutant) is broken, never a kill.
  const failed = Number(/Tests\s+(\d+) failed/.exec(text)?.[1] ?? 0);
  const passed = Number(/Tests\s+(?:\d+ failed \| )?(\d+) passed/.exec(text)?.[1] ?? 0);
  return { status: r.status, failed, passed, ran: failed + passed > 0 };
};

const base = vitest(null, "baseline");
if (base.status !== 0 || !base.ran || base.failed > 0) { console.error(`edit-coalescer-mutants: the baseline fails (${base.failed} tests; work/embed/mutants/baseline.log) — results would mean nothing`); process.exit(3); }
console.log(`edit-coalescer-mutants: baseline green (${TESTS.join(", ")}); ${MUTANTS.length} mutants`);
let survivors = 0;
let broken = 0;
let ran = 0;
MUTANTS.forEach((m, i) => {
  if (only && !m.name.includes(only)) return;
  ran += 1;
  const n = source.split(m.find).length - 1;
  if (m.all ? n < 1 : n !== 1) { console.error(`REFUSED  #${i + 1} ${m.name}: the pattern occurs ${n} times, not ${m.all ? "at least once" : "once"} (stale list)`); process.exit(3); }
  const mutant = path.join(OUT, `edit-coalescer.${i + 1}.ts`);
  fs.writeFileSync(mutant, m.all ? source.split(m.find).join(m.replace) : source.replace(m.find, m.replace));
  const cfg = path.join(OUT, `vitest.${i + 1}.config.mjs`);
  fs.writeFileSync(cfg, `import { defineConfig } from "vitest/config";
export default defineConfig({
  root: ${JSON.stringify(root)},
  resolve: { alias: [{ find: /^.*\\/edit-coalescer$/, replacement: ${JSON.stringify(mutant)} }] },
  test: { environment: "node", include: ${JSON.stringify(TESTS)} },
});
`);
  const r = vitest(cfg, `mutant-${i + 1}`);
  if (!r.ran) { console.error(`BROKEN   #${i + 1} ${m.name}: no test ran (work/embed/mutants/mutant-${i + 1}.log)`); broken += 1; return; }
  const killed = r.failed > 0;
  if (!killed) survivors += 1;
  console.log(`${killed ? "KILLED  " : "SURVIVED"} #${i + 1} ${m.name}${killed ? ` (${r.failed} failing test${r.failed === 1 ? "" : "s"} of ${r.failed + r.passed})` : ""}`);
});
console.log(`edit-coalescer-mutants: ${ran - survivors - broken}/${ran} killed${only ? ` (of ${MUTANTS.length}, --only ${JSON.stringify(only)})` : ""}${survivors ? `, ${survivors} survived` : ""}${broken ? `, ${broken} broken` : ""}; logs in work/embed/mutants/`);
process.exit(broken ? 3 : survivors ? 1 : 0);
