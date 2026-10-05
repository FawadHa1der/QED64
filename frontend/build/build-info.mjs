// dist/qed64-build.json (docs/EMBEDDING.md §4): the shell's identity as data,
// so deploy and pin tools stop scraping `wasm64-<hex>` out of the bundles.
//
//   schema          "qed64.build/v1"
//   buildId         the runtime this shell is paired with (public/runtime/runtime-manifest.json)
//   leanVersion, sourceRevision   from that manifest
//   commit, dirty   the QED64 commit built (null outside a git checkout)
//   shell           "shell-" + 16 hex of the sha256 of the dist listing — one
//                   `<sha256>  <path>\n` line per file, byte-ordered, every file of
//                   dist/ except this one: exactly pipeline/release/release-manifest.mjs's
//                   shell.shellId, which refuses a dist whose qed64-build.json disagrees
//   apiRevision     globalThis.qed64.api.revision of this shell
// Written in writeBundle (post, sequential), after every plugin (the static
// copies included) has written its files, and ONLY for a build that wrote
// them: closeBundle also runs for a failed build (Rollup passes the build
// error; Vite's `finally` calls bundle.close() after a failed write with
// none), where it stamped a stale dist/ or threw ENOENT over the real error.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const BUILD_INFO_FILE = "qed64-build.json";
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function git(args, cwd) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}
function walk(dir, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
const byteOrder = (a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)));

/** The shell id of a built dist/ (every file but qed64-build.json). */
export function shellIdOf(distDir) {
  const listing = walk(distDir).filter((r) => r !== BUILD_INFO_FILE).sort(byteOrder)
    .map((r) => `${sha256(fs.readFileSync(path.join(distDir, r)))}  ${r}\n`).join("");
  return `shell-${sha256(listing).slice(0, 16)}`;
}

/** repoDir: the checkout as a path or a file: URL (never a URL's percent-encoded pathname). */
export function buildInfoPlugin({ manifestUrl, pageApiUrl, repoDir }) {
  let outDir = null;
  return {
    name: "qed64-build-info",
    apply: "build",
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir); },
    writeBundle: {
      order: "post",
      sequential: true,
      handler() {
        const manifest = JSON.parse(fs.readFileSync(manifestUrl, "utf8"));
        const apiRevision = /export const API_REVISION = "([^"]+)"/.exec(fs.readFileSync(pageApiUrl, "utf8"))?.[1] ?? null;
        const commit = git(["rev-parse", "HEAD"], repoDir);
        const info = {
          schema: "qed64.build/v1",
          buildId: manifest.buildId,
          leanVersion: manifest.leanVersion ?? null,
          sourceRevision: manifest.sourceRevision ?? null,
          commit,
          dirty: commit === null ? null : (git(["status", "--porcelain", "--untracked-files=no"], repoDir) ?? "") !== "",
          shell: shellIdOf(outDir),
          apiRevision,
        };
        fs.writeFileSync(path.join(outDir, BUILD_INFO_FILE), `${JSON.stringify(info, null, 2)}\n`);
      },
    },
  };
}
