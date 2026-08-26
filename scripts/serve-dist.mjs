// Local stand-in for infra/worker.js: serve the built shell from dist/ and
// the artifacts from public/{runtime,profiles,snapshots} (locally standing in
// for R2), with the cross-origin-isolation headers the app cannot live
// without. Use it to verify a production build end-to-end BEFORE pushing:
//   npm run build:site && npm run preview:prod   → http://localhost:5185
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.PORT) || 5185;
const ARTIFACT_PREFIXES = ["/runtime/", "/profiles/", "/snapshots/"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const fromPublic = ARTIFACT_PREFIXES.some((p) => safe.startsWith(p));
  const base = fromPublic ? join(ROOT, "public") : join(ROOT, "dist");
  let file = join(base, safe === "/" ? "index.html" : safe);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Length": body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end(`not found: ${safe}`);
  }
}).listen(PORT, () => console.log(`prod preview: http://localhost:${PORT} (dist/ + public artifacts)`));
