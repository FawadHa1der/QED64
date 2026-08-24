/* QED64 edge worker: static app assets + R2-backed artifacts, one origin.
 *
 * Everything is served from the same origin so COEP needs no CORP/CORS
 * gymnastics: the app shell ships as Workers static assets (small files),
 * and the multi-hundred-MB artifacts (runtime chunks, profile packs,
 * snapshots) stream from an R2 bucket bound as ARTIFACTS. Cross-origin
 * isolation headers go on every response; digest-named artifacts are
 * immutable, indexes/manifests revalidate.
 */

const ARTIFACT_PREFIXES = ["/runtime/", "/profiles/", "/snapshots/"];

function isImmutable(pathname) {
  // Digest- or size-named files never change under the same name.
  return /(\.part-\d+|\.snapz|\.chunk\.|[0-9a-f]{16,})/.test(pathname);
}

function withHeaders(response, pathname) {
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set(
    "Cache-Control",
    isImmutable(pathname) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
  );
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (ARTIFACT_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      const key = url.pathname.slice(1);
      const object = await env.ARTIFACTS.get(key);
      if (object === null) return withHeaders(new Response("not found", { status: 404 }), url.pathname);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return withHeaders(new Response(object.body, { headers }), url.pathname);
    }
    const asset = await env.ASSETS.fetch(request);
    return withHeaders(asset, url.pathname);
  },
};
