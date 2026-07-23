// Transparent, lazy read-through mirror for Bazel external dependencies.
//
// The request path IS the upstream URL minus scheme. On a hit the object is
// served straight from R2; on a miss the worker fetches it from the real
// upstream, stores it in R2, and serves it — so the first build to ask for an
// artifact populates the cache and every later build gets it from R2. This
// keeps hermetic Bazel builds resilient to upstream URL rot/outages.
//
// Every request must present a shared secret via HTTP Basic auth (Bazel
// supplies it from ~/.netrc). Without a valid token the worker returns 401
// before doing any R2 or upstream work — so there's no open-proxy surface.
//
// See README.md for the Bazel-side wiring (downloader config + netrc).

import { createLogger, withRequestContext } from "./logger";

const log = createLogger("bazel-mirror");

interface Env {
  // secret (via `wrangler secret put`)
  MIRROR_SECRET: string;
  // binding (wrangler.jsonc)
  MIRROR: R2Bucket;
}

/**
 * Constant-time string comparison. A length difference short-circuits (a minor
 * length leak we accept); equal-length inputs are compared byte-by-byte with no
 * early exit, so a matching prefix doesn't run measurably faster than a
 * mismatching one.
 */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/**
 * Validate an `Authorization: Basic <base64(user:pass)>` header against the
 * shared secret. The username is ignored (Bazel's netrc `login` can be
 * anything); only the password must equal MIRROR_SECRET. Returns false for a
 * missing/malformed header or an unset secret (fail closed).
 */
export function checkAuth(header: string | null, secret: string): boolean {
  if (!secret) return false;
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length).trim());
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  return safeEqual(decoded.slice(sep + 1), secret);
}

/**
 * Map an incoming request URL to an R2 key + the upstream URL to fetch on a
 * miss. The path is the upstream URL minus scheme:
 *   `/github.com/o/r/x.tar.gz` → key `github.com/o/r/x.tar.gz`,
 *                                 upstream `https://github.com/o/r/x.tar.gz`.
 * Any query string is kept verbatim in both (distinct queries → distinct cache
 * entries). Returns null for an empty/traversal path or one with no host.
 */
export function deriveKey(url: URL): { key: string; upstream: string } | null {
  // new URL() has already normalized any `..`/`.` dot-segments out of the
  // pathname, so there's nothing to sanitize — just strip the leading slash.
  const path = url.pathname.replace(/^\/+/, "");
  if (!path) return null;
  // Require a host-shaped first segment (something.tld). A bare word with no
  // dot isn't a mirror-able upstream.
  const host = path.split("/")[0];
  if (!host.includes(".")) return null;
  return { key: path + url.search, upstream: `https://${path}${url.search}` };
}

/**
 * Build the HTTP response for an R2 object (a cache hit or a freshly-stored
 * miss), honoring Range (206) and conditional (304) semantics that R2 resolved
 * from the request headers.
 */
function serveObject(
  object: R2Object | R2ObjectBody,
  request: Request,
  mirrorStatus: string,
): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-mirror-status", mirrorStatus);

  const body = "body" in object ? object.body : null;
  if (!body) {
    // onlyIf precondition failed (e.g. If-None-Match matched) → not modified.
    return new Response(null, { status: 304, headers });
  }

  const isHead = request.method === "HEAD";
  // Decide 206-vs-200 on whether the *client* sent a Range header, not on
  // object.range (R2 populates object.range even for an unconditional get).
  if (request.headers.get("range") !== null && object.range) {
    const size = object.size;
    const r = object.range as { offset?: number; length?: number; suffix?: number };
    let start = 0;
    let end = size - 1;
    if (r.suffix !== undefined) {
      start = size - r.suffix;
    } else {
      if (r.offset !== undefined) start = r.offset;
      if (r.length !== undefined) end = start + r.length - 1;
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(isHead ? null : body, { status: 206, headers });
  }

  headers.set("content-length", String(object.size));
  return new Response(isHead ? null : body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    return withRequestContext({ requestId: crypto.randomUUID(), route: url.pathname }, async () => {
      // 1. Auth first — before any R2 or upstream work.
      if (!checkAuth(request.headers.get("authorization"), env.MIRROR_SECRET)) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="bazel-mirror"' },
        });
      }

      // 2. Reads only.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed\n", {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      }

      // 3. Resolve key + upstream.
      const target = deriveKey(url);
      if (!target) return new Response("Not Found\n", { status: 404 });
      const { key, upstream } = target;

      // 4. Hit? R2 resolves Range/conditional directly from the request headers.
      const existing = await env.MIRROR.get(key, {
        range: request.headers,
        onlyIf: request.headers,
      });
      if (existing !== null) return serveObject(existing, request, "hit");

      // 5. Miss → fetch upstream. A fresh fetch with no init sends only default
      // headers, so the client's Authorization is never forwarded upstream. We
      // always fetch the FULL object (no Range forwarded) and slice locally.
      let upstreamResp: Response;
      try {
        upstreamResp = await fetch(upstream, { redirect: "follow" });
      } catch (err) {
        log.err("upstream fetch failed", err, { key, upstream });
        return new Response("Bad Gateway\n", {
          status: 502,
          headers: { "x-mirror-status": "miss-error" },
        });
      }

      // Non-2xx (or bodyless): pass through, do NOT cache — never poison the
      // cache with a 404 page or an error body.
      if (!upstreamResp.ok || !upstreamResp.body) {
        log.warn("upstream non-ok, passing through uncached", { key, status: upstreamResp.status });
        const headers = new Headers({ "x-mirror-status": "miss-passthrough" });
        const ct = upstreamResp.headers.get("content-type");
        if (ct) headers.set("content-type", ct);
        return new Response(request.method === "HEAD" ? null : upstreamResp.body, {
          status: upstreamResp.status,
          headers,
        });
      }

      // 6. Store-then-serve. put() streams the body into R2 (so large archives
      // stay within the 128 MB memory limit); then re-get so Range/conditional
      // on the populating request go through the same serve path as a hit.
      // Concurrent misses for the same key both fetch+put (last write wins,
      // identical bytes) — acceptable for immutable build artifacts.
      await env.MIRROR.put(key, upstreamResp.body, {
        httpMetadata: {
          contentType: upstreamResp.headers.get("content-type") ?? "application/octet-stream",
        },
      });
      log.info("cached upstream object", { key, upstream });

      const stored = await env.MIRROR.get(key, { range: request.headers, onlyIf: request.headers });
      if (stored === null) {
        log.error("object missing immediately after put", { key });
        return new Response("Internal Error\n", { status: 500 });
      }
      return serveObject(stored, request, "miss-stored");
    });
  },
} satisfies ExportedHandler<Env>;
