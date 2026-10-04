// dist/qed64-build.json (docs/EMBEDDING.md §6.1): the shell's identity as data,
// so deploy and pin tools stop scraping `wasm64-<hex>` out of the bundles.
//
//   schema          "qed64.build/v1"
//   buildId         the runtime this shell is paired with (public/runtime/runtime-manifest.json)
//   leanVersion, sourceRevision   from that manifest
//   commit, dirty   the QED64 commit built (null outside a git checkout)
//   shell           "shell-" + 16 hex of sha256 over the Vite bundle (file names + bytes,
//                   sorted); the static-copied InfoView and worker files are not in it
//   apiRevision     globalThis.qed64.api.revision of this shell
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(args, cwd) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

export function buildInfoPlugin({ manifestUrl, pageApiUrl, repoDir }) {
  return {
    name: "qed64-build-info",
    apply: "build",
    generateBundle(_options, bundle) {
      const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
      const apiRevision = /export const API_REVISION = "([^"]+)"/.exec(readFileSync(pageApiUrl, "utf8"))?.[1] ?? null;
      const h = createHash("sha256");
      for (const name of Object.keys(bundle).sort()) {
        const out = bundle[name];
        h.update(name).update("\0").update(out.type === "chunk" ? out.code : out.source).update("\0");
      }
      const commit = git(["rev-parse", "HEAD"], repoDir);
      const info = {
        schema: "qed64.build/v1",
        buildId: manifest.buildId,
        leanVersion: manifest.leanVersion ?? null,
        sourceRevision: manifest.sourceRevision ?? null,
        commit,
        dirty: commit === null ? null : (git(["status", "--porcelain", "--untracked-files=no"], repoDir) ?? "") !== "",
        shell: `shell-${h.digest("hex").slice(0, 16)}`,
        apiRevision,
      };
      this.emitFile({ type: "asset", fileName: "qed64-build.json", source: `${JSON.stringify(info, null, 2)}\n` });
    },
  };
}
