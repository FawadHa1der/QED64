# QED64: Lean 4 in your browser, 64-bit

QED64 is a Lean 4 editor in the spirit of
[live.lean-lang.org](https://live.lean-lang.org), with one difference: **no
server checks your proofs**. The real Lean 4 compiler and language server run
in a Web Worker as **WebAssembly Memory64** (64-bit pointers, shared memory,
pthreads). Lean's core library and a 4,354-module **Mathlib** environment are
mounted from verified, content-addressed artifacts. The page is lean4monaco
(Monaco plus the vscode-lean4 InfoView) over that in-browser LSP. It serves
Lean 4.34.0 and Mathlib v4.34.0 ([docs/PROVENANCE.md](docs/PROVENANCE.md)).

Live: **https://qed64.fawadworkaddress.workers.dev/**

## Requirements

**To use it (a browser):**
- Desktop **Chrome/Edge 133+** or **Firefox 134+**: WebAssembly Memory64 and
  `SharedArrayBuffer`. Safari has no Memory64 and is out of scope.
- **Cross-origin isolation.** The top document must be served with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, or Memory64 shared memory
  does not exist. The live site, `npm run dev` and `npm run preview:prod` all
  send these headers.
- **Memory.** A tab takes about 8 to 9 GB once the Mathlib environment is
  loaded ([docs/HARDENING.md](docs/HARDENING.md) #44). Only one QED64 runs per
  top-level page. On a 16 GB machine, close other heavy tabs first.
- **Browser storage.** About 5 GB free in the browser profile for the Mathlib
  tier (OPFS).

**To build or test it:**
- macOS or Linux, **Node 24+** (Memory64 on by default) and npm.
- Disk: `npm run fetch:artifacts` writes about 1.65 GB into `public/` (the
  runtime, 159 MB; the two profile packs, 1.13 GB; the two snapshots,
  354 MB). Adopting a release and rebaking needs 12 GB free under `work/`
  (16 GB with `--fat-tree`), the floor `pipeline/release/adopt-release.sh`
  checks.

## Use QED64

There are three ways, from least to most code. The contract for all three is
[docs/EMBEDDING.md](docs/EMBEDDING.md) (v1). §6.1 there is a complete,
tested recipe.

### (a) QED64's page in an iframe

Build the shell from a QED64 checkout at the commit you pin (see "Build from
source"). Serve `dist/` at your origin root, with `/runtime/`, `/profiles/`
and `/snapshots/` beside it. Then frame `/?embed=1`:

```html
<!-- your page, on the same origin as QED64's dist/, sent with COOP same-origin + COEP require-corp -->
<script type="module">
  addEventListener("qed64:frame-api", async ({ detail: { api } }) => {
    api.on("diagnostics", (d) => console.log(d.version, d.diagnostics));
    await api.setDocument("import Mathlib\n\nexample : 2 + 2 = 4 := by norm_num\n");
    console.log((await api.settled()).phase);   // "ready"
  });
</script>
<iframe src="/?embed=1" allow="clipboard-read; clipboard-write" style="width:100%;height:80vh;border:0"></iframe>
```

- **Same origin only in v1.** The frame inherits cross-origin isolation from
  your page, so your page needs the COOP/COEP headers too. A cross-origin
  frame cannot boot, so you cannot frame the live site from another origin.
- **Embed mode** (`?embed=1`) hides the examples menu and leaves persistence to
  you: listen for the `document` event and call `setDocument`.
- **URL parameters** ([docs/EMBEDDING.md](docs/EMBEDDING.md) §3–§4):
  `#code=<text>` (a boot document, honoured only in a same-origin frame),
  `snapshots=<dir>` and `profiles=<dir>` (overlay sets on this origin),
  `runtime=<buildId>`, `memory=<GiB>` and `edithold=<n>`. A refused value
  fails the boot and names the parameter.
- **The page API** is `globalThis.qed64.api` (§2): `setDocument`,
  `settled`, `status`, `restart`, and the `boot`, `ready`, `diagnostics`,
  `document`, `death` and `reboot` events. Feature-detect with
  `api.capabilities`.

### (b) `qed64/embed` in your own page

Install QED64 as a git dependency pinned by a full commit (npm honours its
`files`; there is no npm registry release):

```json
{ "dependencies": { "qed64": "github:FawadHa1der/QED64#<40-hex commit>" } }
```

You need four things ([docs/EMBEDDING.md](docs/EMBEDDING.md) §6.1). First,
COOP/COEP on your page, and in Vite `optimizeDeps: { exclude: ["qed64"] }`
and `build: { target: "es2022" }` (the code below uses top-level `await`,
which Vite's default target refuses). Second, the five workers that
`embedding/closure.json` lists, copied to their `serveAs` paths before every
build. Third, the artifacts at `/runtime/`, `/profiles/` and `/snapshots/` on
your origin: the package does not ship the tracked manifests, so fetch
QED64's served set with them from a QED64 checkout at your pin,
`node node_modules/qed64/pipeline/release/fetch-artifacts.mjs --manifests
<QED64 checkout>/public --out public --with-manifests` (EMBEDDING §6, §6.1
step 4; without `--manifests` it refuses). Fourth, the code below. The
workers step is a short `prebuild` script:

```js
// scripts/stage-qed64-workers.mjs: run before every dev start and build
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const pkg = path.dirname(createRequire(import.meta.url).resolve("qed64/package.json"));
const closure = JSON.parse(fs.readFileSync(path.join(pkg, "embedding/closure.json"), "utf8"));
fs.rmSync("public/workers", { recursive: true, force: true });
for (const { path: from, serveAs } of closure.workers) {
  fs.mkdirSync(path.dirname(`public${serveAs}`), { recursive: true });
  fs.copyFileSync(path.join(pkg, from), `public${serveAs}`);
}
```

**Without the editor**, your code is the language client. It boots a session
behind the relay and speaks JSON-RPC on one `MessagePort`. This is
[docs/EMBEDDING.md](docs/EMBEDDING.md) §6.1 (a) verbatim (`npm run
test:consumer` checks that the two copies match, then type-checks and builds
it). It uses top-level `await`, hence the `build.target` above. The `pagehide`
line is required: without it every reload leaves a dead multi-GiB Memory64
heap behind until the renderer is killed (EMBEDDING §7.9, `unload()`):

```ts
import { LspRelay, MEMORY64_PROBE, ResidentSession, installArtifacts, makeEditorPolicy, type StatusSink } from "qed64/embed";

if (!crossOriginIsolated || !WebAssembly.validate(MEMORY64_PROBE)) throw new Error("needs COOP/COEP and Memory64");
const ui: StatusSink = {   // progress as data (§7.1)
  busy: (label, info) => console.log("busy", label, info?.stage),
  progress: (label, info) => console.log(label, info?.loaded, info?.total),
  idle: (label) => console.log("idle", label),
};
const artifacts = await installArtifacts(ui, { overrides: "none" });   // manifest, snapshot index, core pack
const policy = makeEditorPolicy(artifacts.snapshots);                    // snapshots and memory per header
let current = "import Mathlib\n\nexample : 2 + 2 = 4 := by norm_num\n";   // what a (re)boot serves
const relay = new LspRelay(
  (opts) => new ResidentSession({ artifacts, ui, policy, headerText: current }, opts ?? {}),
  { status: (s) => console.log(s.relay, s.phase, s.lastDeath?.cause?.kind ?? "") },   // deaths, §7.2
  () => new Promise((r) => setTimeout(r, 1500)),
);
addEventListener("pagehide", () => relay.unload(), { once: true });

const port = relay.clientPort, uri = "file:///project/Probe.lean";
port.onmessage = (e) => { if (e.data.method === "textDocument/publishDiagnostics") console.log(e.data.params.diagnostics); };
port.postMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
port.postMessage({ jsonrpc: "2.0", method: "initialized", params: {} });
port.postMessage({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "lean4", version: 1, text: current } } });
// an edit: update `current`, then a full-text didChange (coalesced, §7.8)
```

**With the editor**, boot the same way (the `pagehide` line included) and hand
`relay.clientPort` to lean4monaco instead of posting on it yourself, as
QED64's own page does (`frontend/src/main.ts`):

```ts
await leanMonaco.start({
  websocket: { $type: "WorkerDirect", worker: { postMessage() {} }, messagePort: relay.clientPort } as unknown as { url: string },
});
```

The InfoView's static files are lean4monaco's to serve: copy
`@leanprover/infoview/dist/*` and `lean4monaco/dist/webview/webview.js` to
`/infoview/` on your origin, as `frontend/vite.config.ts` does, or the
InfoView frame 404s (QED64's copy also patches `webview.js` so widget panels
get their RPC right, [docs/HARDENING.md](docs/HARDENING.md) #56).

The library API (progress, failure causes, deaths, overlays, edit
coalescing) is [docs/EMBEDDING.md](docs/EMBEDDING.md) §7.
`npm run test:consumer` builds a consumer from the packed tarball
(`tests/consumer/fixture/` plus the block above).

### (c) `qed64/edge` in your own Cloudflare Worker

`qed64/edge` is the edge-worker library that serves QED64 itself. It is one
dependency-free ES module that sets the isolation headers, the cache rule, HEAD
and Range on the artifacts, and the R2 key mapping:

```js
// your Worker's main module (wrangler.toml: [assets] binding "ASSETS" with run_worker_first = true,
// [[r2_buckets]] binding "ARTIFACTS")
import { createWorker } from "qed64/edge";

export default createWorker({
  r2Prefix: (env) => env.R2_PREFIX,               // e.g. "my-site/" in a shared bucket; unset: the bucket root
  rootRedirect: (env) => env.ROOT_REDIRECT ?? null,
});
```

[docs/DEPLOY.md](docs/DEPLOY.md) "Using qed64/edge in your own Worker" has the
full `wrangler.toml`, every option, the `release` option that reads the
toolchain's files from a shared `lean4-wasm64/<id>/` prefix, and the five
ways it differs from a hand-written worker.

## Build from source

```sh
git clone https://github.com/FawadHa1der/QED64 && cd QED64
npm ci                     # the root: library, pipeline, tests (and the pinned lean4-wasm64 package)
npm --prefix frontend ci   # the page: lean4monaco, Vite
npm run fetch:artifacts    # public/: runtime chunks, profile packs, snapshots (~1.65 GB), each sha256-verified
npm run build:site         # dist/: the page (writes dist/qed64-build.json last)
npm run preview:prod       # http://localhost:5185, served by the live Worker's own code (infra/worker.js)
```

`npm run dev` is the Vite dev server instead (http://localhost:5184, COOP/COEP
set). The tracked manifests (`public/runtime/runtime-manifest.json`,
`public/profiles/*.json`, `public/snapshots/index.json`) pin every served byte
by SHA-256. The bytes are not in git. `fetch:artifacts` downloads exactly what
the manifests name (from the live site by default; `--origin <url>` names
another deployment, `--release <dir|url>` a toolchain release), checks each
file before it is renamed into place, and skips files already present
([docs/CLI-CONTRACT.md](docs/CLI-CONTRACT.md) "fetch-artifacts").

**Where the compiler comes from.** Nothing is compiled here. The wasm64 Lean
toolchain (the patched compiler, its patch series, the runtime build and the
library packs) belongs to the Lean fork
[FawadHa1der/lean4](https://github.com/FawadHa1der/lean4), branch
`qed64-wasm64`, `wasm64-build/`. QED64 consumes its releases. The release it
serves is pinned in `toolchain/lean4-wasm64-release.json` (schema
`lean4-wasm64.release/v1`). The fork's `lean4-wasm64` package is a
devDependency, pinned by that release's tgz URL. The base trees the snapshots
were baked from are recorded in `embedding/base-tree.json`. To rebuild the
runtime itself, follow [docs/REBUILD.md](docs/REBUILD.md) §1 in the fork.
[docs/PROVENANCE.md](docs/PROVENANCE.md) is the digest chain and how to
verify it.

**Adopting a new release.** `pipeline/release/adopt-release.sh --id <id>
--digest sha256:<hex> --from <release URL> --public <isolated tree> …` does
the whole adoption: fetch and verify, base trees, both snapshot bakes, staging,
an isolated promote, and `base-tree.json`. `--dry-run` prints the plan and
writes nothing ([docs/REBUILD.md](docs/REBUILD.md) §3).

**Baking your own snapshots.** A snapshot is binary-paired: bake it with the
exact runtime you serve. The bake reads a runtime directory (`bin/lean.wasm`)
and an olean tree. Fetch the runtime from the pinned release (`id` and
`digest` in `toolchain/lean4-wasm64-release.json`) with the fork's CLI, as
`adopt-release.sh` does for its `$W/artifact`, then bake into a directory of
your own:

```sh
node node_modules/lean4-wasm64/cli.mjs fetch --from https://github.com/FawadHa1der/lean4/releases/download/<id>/ \
  --out <work>/artifact --only runtime --id <id> --digest sha256:<hex>
npm run bake:snapshot -- --name <name> --artifact <work>/artifact --lib <olean tree> \
  --work <work>/snap --out <work>/overlay --roots <A,B> --probe '<lean source>'
```

For an extra environment, serve that set as an overlay, with no promote: the
page boots the base `init` plus at most one other entry
([docs/EMBEDDING.md](docs/EMBEDDING.md) §8), so bake `init` into the same
`--out` as well (REBUILD §3 step 8 has its command line), copy the directory
to `public/snapshots/<overlay>/` (bake-snapshot refuses an `--out` inside
`public/`) and open `/?snapshots=snapshots/<overlay>`. To replace the served
pair itself, use `adopt-release.sh` above: it stages the runtime and both
snapshots together. `npm run promote:staging` takes only such a complete
staging (`runtime/runtime-manifest.json` and `chunks/`, and every snapshot of
the pairing) and replaces the served index wholesale.
Every pipeline tool, with its flags, exit codes and stable output lines, is in
[docs/CLI-CONTRACT.md](docs/CLI-CONTRACT.md).

Deploying (Cloudflare Workers static assets plus R2, one origin) is
[docs/DEPLOY.md](docs/DEPLOY.md). `scripts/deploy-app.sh` is the one deploy
path.

## Test

Three gates ([docs/TESTING.md](docs/TESTING.md) has every lane, its command,
its prerequisites and its pass line):

- **G0**, needs no artifacts and no browser:
  ```sh
  npx tsc --noEmit && npm test && npm run -s typecheck:site && npm run -s build:site && node pipeline/snapshot/cli.mjs --check-preludes && npm pack --dry-run --json > /dev/null
  ```
- **G1**, end to end in a real browser, against the fetched artifacts
  (`npx playwright install chromium` first): `npm run test:adversarial`
  (preflight, then the compiler battery, then e2e 23/23; `-- --skip-compiler`
  on a fresh clone, because the battery needs Node-side build outputs). Add
  the page lanes `tests/adversarial/{page-api,infoview-actions,liveness-faults,reload-storm,edit-storm,…}.mjs`
  and the integration tier `npm run test:integration` (the real runtime under
  Node; `QED64_LEAN_ARTIFACT` names it). Run one browser lane at a time. On a
  machine shared with other sessions, run each through the host's browser lock.
- **G2**, the consumer view: `npm run test:consumer -- --work <dir outside the
  repo>` packs QED64, resolves every `exports` key from the extracted tarball,
  and builds `tests/consumer/fixture/` (a `qed64/embed` page and a `qed64/edge`
  Worker) with the repo's tsc and Vite.

## Layout

| Path | What lives there |
|---|---|
| `lib/` | the library, `qed64/embed` (`index.ts` is the barrel): worker client, OPFS installer, snapshot index, boot, session adapter, LSP relay, edit coalescer, causes, parameters |
| `frontend/` | the page (its own `package.json`): lean4monaco over the in-browser LSP, the page API, import completion |
| `public/workers/` | the five worker scripts (`lean.worker.js` runs the runtime; the LSP front door, framer, Memory64 probe, snapshot prefetch) |
| `public/{runtime,profiles,snapshots}/` | the served artifacts: manifests tracked, bytes fetched (`npm run fetch:artifacts`), never committed |
| `infra/` | `edge-worker.js` (`qed64/edge`) and `worker.js`, the live site's Worker |
| `pipeline/` | `snapshot/` (bake, probes, Node runner, the CLI contract), `release/` (fetch, adopt, promote, verify, release manifest, bundle), `artifacts/` (pack, olean reader, umbrella), `toolchain/` (path rule, forwards to `lean4-wasm64`) |
| `scripts/` | `deploy-app.sh`, `serve-dist.mjs` (`npm run preview:prod`), `upload-artifacts.sh` |
| `tests/` | `unit/`, `integration/`, `adversarial/` (the browser lanes), `consumer/` (G2), `mutation/` |
| `toolchain/`, `embedding/` | the pinned toolchain release record; `closure.json` (what an embedder needs) and `base-tree.json` |
| `src/`, `frontend/src/embed/`, `frontend/src/{qed64-boot,resident-session,lsp-relay}.ts` | one-cycle shims at the library's old paths (each re-exports its `lib/` file) |
| `docs/` | the contracts and the design record; `docs/history/` holds superseded documents |

## License

MIT, see [LICENSE](LICENSE). Lean, Mathlib and Batteries are Apache-2.0. The
wasm build derives from [cauli/lean4](https://github.com/cauli/lean4)
`reinstate-wasm` (Apache-2.0).
