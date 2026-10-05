// Overlay environments (docs/EMBEDDING.md §8; src/runtime/snapshots.ts): an
// index entry may declare the module roots it serves, a label and an initial
// commit, and the page boots and widens to it by itself. Pinned here: on an
// index WITHOUT roots every decision is exactly the legacy one (the stock
// index, and an overlay that renamed its region to "mathlib"), and with roots
// the choice is the base plus one covering entry, on component boundaries.
// The page's self-widen (frontend/src/self-widen.ts) is driven at the end over
// the REAL relay and editor policy; only the kernel is modelled.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseSnapshots, coversModule, entryLabel, entryRoots, initialBytesForEntries, loadSnapshotIndex, widenTarget,
  type SnapshotEntry, type SnapshotIndex,
} from "../../src/runtime/snapshots";
import {
  EDITOR_POLICY, importedModulesOf, initialBytesForSnapshots, isUmbrellaModule, makeEditorPolicy, snapshotsForHeader, type ResidentPolicy,
} from "../../frontend/src/resident-session";
import { LspRelay, type RelaySession, type RestartOptions } from "../../frontend/src/lsp-relay";
import { selfWiden } from "../../frontend/src/self-widen";
import type { JsonRpcMessage, WorkerStatus } from "../../src/runtime/client";

const GiB = 1073741824;
const MiB = 1048576;
const entry = (name: string, bytes: number, extra: Partial<SnapshotEntry> = {}): SnapshotEntry => ({ name, url: `/snapshots/${name}.x.snapz`, bytes, imports: [], ...extra });
const STOCK: SnapshotIndex = { schema: "qed64.snapshot-index/v1", snapshots: [entry("init", 122 * MiB), entry("mathlib", 1127 * MiB, { imports: ["QED64.Essential"] })] };
const WIDGET_ROOTS = ["Mathlib", "Batteries", "MIL", "QED64", "ProofWidgets", "HasseView", "SimpLens"];
const OVERLAY: SnapshotIndex = {
  schema: "qed64.snapshot-index/v1",
  snapshots: [entry("init", 122 * MiB), entry("mathlib", 1127 * MiB, { imports: ["QED64.Essential"] }), entry("widgets8", 1400 * MiB, { roots: WIDGET_ROOTS, label: "Mathlib + widgets", initialBytes: 3 * GiB })],
};
const HEADERS = [
  "", "theorem t : True := trivial\n", "import Mathlib\n", "import Mathlib.Data.Real.Basic\nimport Foo\n", "import Init.Data.List\n",
  "import Batteries.Data.List\n", "import MIL.Common\n", "import Mathlib2\n", "import Lean\n", "import Aesop\n", "import HasseView\n",
  "public import Mathlib.Tactic\n", "import QED64.Essential\n",
];

describe("an index without roots behaves exactly as before", () => {
  it.each(HEADERS)("header %j: same snapshots and the same commit as the legacy editor policy", (header) => {
    const modules = importedModulesOf(header);
    expect(chooseSnapshots(STOCK, modules)).toEqual(snapshotsForHeader(header));
    expect(initialBytesForEntries(STOCK, snapshotsForHeader(header))).toBe(initialBytesForSnapshots(snapshotsForHeader(header)));
    const policy = makeEditorPolicy(STOCK);
    expect(policy.snapshotsFor!(header)).toEqual(EDITOR_POLICY.snapshotsFor!(header));
    expect(policy.initialBytesFor!(header, ["init", "mathlib"])).toBe(EDITOR_POLICY.initialBytesFor!(header, ["init", "mathlib"]));
  });
  it("widens exactly when the legacy rule did: a light session, every missing module under an umbrella root", () => {
    const legacy = (missing: string[], loaded: string[]) => !loaded.includes("mathlib") && missing.length > 0 && missing.every(isUmbrellaModule);
    for (const [missing, loaded] of [
      [["Mathlib.Data.Real.Basic"], ["init"]], [["Mathlib.Data.Real.Basic", "Foo"], ["init"]], [["Mathlib2"], ["init"]],
      [["Mathlib.Bogus"], ["init", "mathlib"]], [[], ["init"]], [["MIL.Common", "Batteries.X"], ["init"]],
      [["Init.Data.Lisst"], ["init"]], [["Init.Data.Lisst", "Mathlib.Tactic"], ["init"]], // an Init typo: no entry changes that verdict
    ] as Array<[string[], string[]]>) {
      expect(widenTarget(STOCK, missing, loaded)?.name === "mathlib", JSON.stringify([missing, loaded])).toBe(legacy(missing, loaded));
    }
  });
  it("without an index, the policy IS the legacy one", () => {
    expect(makeEditorPolicy(null)).toBe(EDITOR_POLICY);
  });
});

describe("an overlay that declares roots", () => {
  it("boots the smallest entry covering the header — the stock umbrella for Mathlib, the overlay for its own roots", () => {
    expect(chooseSnapshots(OVERLAY, ["Mathlib.Data.Real.Basic"])).toEqual(["init", "mathlib"]);
    expect(chooseSnapshots(OVERLAY, ["HasseView"])).toEqual(["init", "widgets8"]);
    expect(chooseSnapshots(OVERLAY, ["Mathlib.Tactic", "SimpLens.Core"])).toEqual(["init", "widgets8"]);
    expect(chooseSnapshots(OVERLAY, ["HasseView2"])).toEqual(["init"]); // component boundary
    expect(chooseSnapshots(OVERLAY, ["HasseView", "Unknown.Thing"])).toEqual(["init", "widgets8"]); // covers the most
  });
  it("sizes the commit by the entry's initialBytes", () => {
    expect(initialBytesForEntries(OVERLAY, ["init", "widgets8"])).toBe(3 * GiB);
    expect(initialBytesForEntries(OVERLAY, ["init", "mathlib"])).toBe(2048 * MiB);
    expect(initialBytesForEntries(OVERLAY, ["init"])).toBe(256 * MiB);
    expect(makeEditorPolicy(OVERLAY).initialBytesFor!("import HasseView\n", ["init", "widgets8"])).toBe(3 * GiB);
  });
  it("widens a running session to the entry covering EVERY missing module, never to one already loaded", () => {
    expect(widenTarget(OVERLAY, ["HasseView"], ["init"])?.name).toBe("widgets8");
    expect(widenTarget(OVERLAY, ["HasseView"], ["init", "mathlib"])?.name).toBe("widgets8"); // a Mathlib session gaining a widget import
    expect(widenTarget(OVERLAY, ["Mathlib.Data.Real.Basic"], ["init"])?.name).toBe("mathlib"); // the smaller one
    expect(widenTarget(OVERLAY, ["HasseView"], ["init", "widgets8"])).toBeNull();
    expect(widenTarget(OVERLAY, ["HasseView", "Unknown"], ["init"])).toBeNull();
  });
  it("never widens to an entry that would be refused for what the old session covered (the review's ping-pong)", () => {
    // `hasse` serves HasseView only; `mathlib` the umbrella. A header naming both is covered by neither.
    const PAIR: SnapshotIndex = { schema: "qed64.snapshot-index/v1", snapshots: [entry("init", 1), entry("mathlib", 1000, { imports: ["QED64.Essential"] }), entry("hasse", 900, { roots: ["HasseView"] })] };
    const header = ["Mathlib", "HasseView"];
    expect(chooseSnapshots(PAIR, header)).toEqual(["init", "hasse"]); // covers the most, ties → smaller
    expect(widenTarget(PAIR, ["Mathlib"], ["init", "hasse"], header)).toBeNull(); // mathlib would be refused for HasseView
    expect(widenTarget(PAIR, ["HasseView"], ["init", "mathlib"], header)).toBeNull();
    // Without the header (the old call shape) the bounce is possible — the page always passes it.
    expect(widenTarget(PAIR, ["Mathlib"], ["init", "hasse"])?.name).toBe("mathlib");
    // An overlay covering both is still found.
    const BOTH: SnapshotIndex = { ...PAIR, snapshots: [...PAIR.snapshots, entry("widgets", 1400, { roots: ["Mathlib", "HasseView"] })] };
    expect(widenTarget(BOTH, ["Mathlib"], ["init", "hasse"], header)?.name).toBe("widgets");
  });
  it("never widens for a module a loaded entry already claims: the kernel has just refuted that claim (a prefix, a typo)", () => {
    const header = ["Mathlib.Tactic", "Mathlib.D"];
    expect(widenTarget(OVERLAY, ["Mathlib.D"], ["init", "mathlib"], header)).toBeNull(); // not to the overlay, whose roots claim Mathlib too
    expect(widenTarget(OVERLAY, ["Mathlib.D"], ["init", "widgets8"], header)).toBeNull(); // nor back
    expect(widenTarget(OVERLAY, ["Mathlib.Tactic.Bogus"], ["init", "mathlib"], ["Mathlib.Tactic.Bogus"])).toBeNull();
    expect(widenTarget(OVERLAY, ["Mathlib.D"], ["init"], ["Mathlib.D"])?.name).toBe("mathlib"); // a light session: nothing loaded claims it
    // A module no loaded entry claims still widens — to an entry claiming the refuted one too.
    expect(widenTarget(OVERLAY, ["Mathlib.D", "HasseView"], ["init", "mathlib"], [...header, "HasseView"])?.name).toBe("widgets8");
  });
  it.each(["Aesop", "Qq", "Lean.Elab.Command"])("a header module no root names (%s) does not block the overlay widen", (other) => {
    // The umbrella's closure serves it, and so does the overlay's: the kernel judges it, as chooseSnapshots leaves it.
    const header = ["Mathlib.Tactic", other, "HasseView"];
    expect(chooseSnapshots(OVERLAY, header)).toEqual(["init", "widgets8"]);
    expect(widenTarget(OVERLAY, ["HasseView"], ["init", "mathlib"], header)?.name).toBe("widgets8");
    expect(widenTarget(OVERLAY, [other], ["init", "widgets8"], header)).toBeNull(); // were the overlay to lack it: no entry claims it
  });

  it("labels and roots", () => {
    expect(entryLabel(OVERLAY.snapshots[2]!)).toBe("Mathlib + widgets");
    expect(entryLabel(STOCK.snapshots[1]!)).toBe("Mathlib");
    expect(entryLabel(entry("game", 1))).toBe("game");
    expect(entryRoots(STOCK.snapshots[0]!)).toEqual([]);
    expect(coversModule(["Mathlib"], "Mathlib")).toBe(true);
    expect(coversModule(["Mathlib"], "MathlibX.Y")).toBe(false);
  });
});

// The kernel (patch 0032 K1, lookupPrebuiltEnv) resolves a header against what the loaded environments CONTAIN, not
// against roots: covered when every import is in some loaded closure, else refused naming the imports none contains.
// The umbrella contains Aesop, Qq and Lean but no `Mathlib.D`; the overlay contains the umbrella and its widgets.
const INIT_CLOSURE = ["Init", "Init.Prelude", "Init.Data.List"];
const UMBRELLA_CLOSURE = ["Mathlib", "Mathlib.Tactic", "Mathlib.Data.Real.Basic", "Mathlib.Basic.Real.Basic", "Batteries", "MIL.Common", "Aesop", "Qq", "Lean", "Lean.Elab.Command"];
const CLOSURES: Record<string, readonly string[]> = {
  init: INIT_CLOSURE, mathlib: UMBRELLA_CLOSURE, widgets8: [...UMBRELLA_CLOSURE, "HasseView", "ProofWidgets", "SimpLens.Core"], hasse: ["HasseView"],
};

/** A session as the relay drives it: ResidentSession's boot inputs (restart options, else the policy over the header
 * it is built for), the worker's verdict per document text once armed, delivered as a message (never inside the call). */
class KernelSession implements RelaySession {
  static seq = 0;
  readonly id = `S${(KernelSession.seq += 1)}`;
  readonly snapshots: string[];
  private text: string | null = null;
  private version = 0;
  private armed = false;
  private gone = false;
  onLsp: (msg: JsonRpcMessage) => void = () => {};
  onStatus: (s: WorkerStatus) => void = () => {};
  onDied: (code: number | null, reason: string, message: string, cause?: unknown) => void = () => {};
  constructor(policy: ResidentPolicy, headerText: string, opts: RestartOptions) {
    this.snapshots = opts.snapshots ?? policy.snapshotsFor!(headerText);
  }
  start() { return Promise.resolve(); }
  arm() { this.armed = true; this.verdict(); return Promise.resolve(); }
  lsp(msg: JsonRpcMessage) {
    const p = msg.params as { textDocument: { version: number; text?: string }; contentChanges?: { text: string }[] };
    if (msg.method === "textDocument/didOpen") this.text = p.textDocument.text!;
    else if (msg.method === "textDocument/didChange") this.text = p.contentChanges![0]!.text;
    else return;
    this.version = p.textDocument.version;
    if (this.armed) this.verdict();
  }
  private verdict() {
    if (this.text === null) return;
    const key = importedModulesOf(this.text);
    const missing = key.filter((m) => !this.snapshots.some((e) => CLOSURES[e]!.includes(m)));
    const refused = missing.length > 0;
    const status: WorkerStatus = {
      phase: refused ? "headerRefused" : "ready", version: this.version,
      header: { version: this.version, mode: refused ? "refused" : "covered", key, moduleCount: key.length, missing, ms: 1 },
      ring: { bytesQueued: 0, refused: 0 }, pool: { unused: 4, running: 0 }, dropped: 0, collision: null,
    };
    setImmediate(() => { if (!this.gone) this.onStatus(status); });
  }
  dispose() { this.gone = true; }
  terminate() { this.gone = true; }
}

/** main.ts's wiring: the policy over the index, the factory's header (`relay?.lastText || initialText`), the
 * self-widen as a status sink with its "loading <label>…" callback. */
function page(index: SnapshotIndex | null, initialText: string) {
  const policy = makeEditorPolicy(index);
  const widens: string[] = [];
  let version = 1;
  let relay: LspRelay; // as in main.ts: the relay builds its first session before `relay` is assigned
  relay = new LspRelay(
    (opts) => new KernelSession(policy, relay?.lastText || initialText, opts ?? {}),
    { status: selfWiden(() => relay, index, (target) => widens.push(entryLabel(target))) },
    () => new Promise((r) => setImmediate(r)),
  );
  const quiet = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };
  const doc = (text: string) => ({ uri: "file:///project/Probe.lean", languageId: "lean4", version, text });
  return {
    relay, widens,
    session: () => relay.session as KernelSession,
    open: async () => { relay.fromClient({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: doc(initialText) } }); await quiet(); },
    edit: async (text: string) => {
      version += 1;
      relay.fromClient({ jsonrpc: "2.0", method: "textDocument/didChange", params: { textDocument: { uri: doc(text).uri, version }, contentChanges: [{ text }] } });
      await quiet();
    },
    crash: async () => { relay.session.onDied(null, "crash", "worker abort"); await quiet(); },
    close: () => { relay.clientPort.close(); relay.unload(); },
  };
}

describe("the page's self-widen over the real relay (frontend/src/self-widen.ts)", () => {
  const BODY = "\nexample : True := trivial\n";
  const INIT_DOC = `theorem t : 1 + 1 = 2 := rfl\n`;
  const MATHLIB_DOC = `import Mathlib.Basic.Real.Basic\n${BODY}`;
  let pages: Array<ReturnType<typeof page>> = [];
  const open = async (index: SnapshotIndex | null, text: string) => { const p = page(index, text); pages.push(p); await p.open(); return p; };
  afterEach(() => { for (const p of pages) p.close(); pages = []; });

  it.each([["the stock index", STOCK], ["no index", null]] as const)("widens again after a reboot dropped the umbrella (%s)", async (_, index) => {
    const p = await open(index, INIT_DOC);
    expect(p.session().snapshots).toEqual(["init"]);
    await p.edit(MATHLIB_DOC); // refused on the light session: widened
    expect([p.session().snapshots, p.relay.status().phase]).toEqual([["init", "mathlib"], "ready"]);
    await p.edit(INIT_DOC);
    await p.crash(); // the import lines changed since the widen: the relay forgets its options, the policy boots light
    expect(p.session().snapshots).toEqual(["init"]);
    await p.edit(MATHLIB_DOC);
    expect([p.session().snapshots, p.relay.status().phase]).toEqual([["init", "mathlib"], "ready"]);
    expect(p.widens).toEqual(["Mathlib", "Mathlib"]);
  });

  it("a Mathlib session typing a Mathlib import never swaps environments (an overlay that also claims Mathlib)", async () => {
    const tactic = "import Mathlib.Tactic\n";
    const p = await open(OVERLAY, tactic + BODY);
    const first = p.session();
    expect(first.snapshots).toEqual(["init", "mathlib"]);
    for (const partial of ["Mathlib.D", "Mathlib.Da", "Mathlib.Tactic.Bogus", "Mathlib.Data.Real.Basic"]) await p.edit(`${tactic}import ${partial}\n${BODY}`);
    expect([p.relay.stats.userRestarts, p.widens, p.session() === first, p.relay.status().phase]).toEqual([0, [], true, "ready"]);
  });

  it("a light session typing its first Mathlib import widens once, however many prefixes it is refused for", async () => {
    const p = await open(OVERLAY, INIT_DOC);
    for (const partial of ["Mathlib.D", "Mathlib.Da", "Mathlib.Dat", "Mathlib.Data.Real.Basic"]) await p.edit(`import ${partial}\n${BODY}`);
    expect([p.relay.stats.userRestarts, p.widens, p.session().snapshots, p.relay.status().phase]).toEqual([1, ["Mathlib"], ["init", "mathlib"], "ready"]);
  });

  it.each(["Aesop", "Qq", "Lean.Elab.Command"])("a Mathlib session that also imports %s widens to the overlay for import HasseView", async (other) => {
    const head = `import Mathlib.Tactic\nimport ${other}\n`;
    const p = await open(OVERLAY, head + BODY);
    expect([p.session().snapshots, p.relay.status().phase]).toEqual([["init", "mathlib"], "ready"]);
    await p.edit(`${head}import HasseView\n${BODY}`);
    expect([p.widens, p.session().snapshots, p.relay.status().phase]).toEqual([["Mathlib + widgets"], ["init", "widgets8"], "ready"]);
  });

  it("two entries that each cover half the header never ping-pong (the first review's loop)", async () => {
    const PAIR: SnapshotIndex = { schema: "qed64.snapshot-index/v1", snapshots: [entry("init", 1), entry("mathlib", 1000, { imports: ["QED64.Essential"] }), entry("hasse", 900, { roots: ["HasseView"] })] };
    const p = await open(PAIR, `import Mathlib.Tactic\nimport HasseView\n${BODY}`);
    await p.edit(`import Mathlib.Tactic\nimport HasseView\n${BODY}-- an edit\n`);
    await p.crash();
    expect([p.relay.stats.userRestarts, p.session().snapshots, p.relay.status().phase]).toEqual([0, ["init", "hasse"], "headerRefused"]);
  });
});

describe("index validation of the new fields", () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (index: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(index), { status: 200 })));
  it.each([
    [{ roots: "Mathlib" }], [{ roots: [""] }], [{ roots: ["Mathlib.*"] }], [{ roots: ["a b"] }], [{ roots: [3] }],
    [{ label: 3 }], [{ initialBytes: -1 }], [{ initialBytes: "3GiB" }],
  ])("refuses %j", async (bad) => {
    serve({ schema: "qed64.snapshot-index/v1", snapshots: [entry("o", 1, bad as Partial<SnapshotEntry>)] });
    await expect(loadSnapshotIndex()).rejects.toThrow(/malformed entry "o"/);
  });
  it("accepts the documented shape", async () => {
    serve(OVERLAY);
    await expect(loadSnapshotIndex()).resolves.toEqual(OVERLAY);
  });
});
