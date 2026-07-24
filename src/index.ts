// Transparent, lazy read-through mirror for any URL-addressed artifact.
//
// The request path IS the upstream URL minus scheme. On a hit the object is
// served straight from R2; on a miss the worker fetches it from the real
// upstream, stores it in R2, and serves it — so the first caller to ask for
// an artifact populates the cache and every later caller gets it from R2.
// This keeps builds/installs resilient to upstream URL rot and outages,
// whatever's downloading — Bazel, npm, pip, a Dockerfile, or a plain script.
//
// Every request must present a shared username + secret via HTTP Basic auth.
// Without valid credentials the worker returns 401 before doing any R2 or
// upstream work — so there's no open-proxy surface.
//
// See README.md for example client wiring (Bazel's downloader config, netrc,
// or a bare curl/wget invocation).

import { createLogger, withRequestContext } from "./logger";

const log = createLogger("r2-cache-proxy");

interface Env {
  // env var (wrangler.jsonc `vars`, or dashboard Settings → Variables)
  MIRROR_USER: string;
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
 * configured credentials. Both the username (MIRROR_USER) and the password
 * (MIRROR_SECRET) must match. Returns false for a missing/malformed header or
 * an unset user/secret (fail closed).
 */
export function checkAuth(header: string | null, user: string, secret: string): boolean {
  if (!user || !secret) return false;
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length).trim());
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  return safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), secret);
}

/**
 * Map an incoming request URL to an R2 key + the upstream URL to fetch on a
 * miss. The path is the upstream URL minus scheme:
 *   `/github.com/o/r/v1.tar.gz` → key `github.com/o/r/v1.tar.gz`,
 *                                 upstream `https://github.com/o/r/v1.tar.gz`.
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

// Mirrored artifacts are treated as immutable — most callers re-verify what
// they download against a checksum of their own anyway (Bazel's sha256, npm's
// integrity hash, a Docker layer digest), so a stale byte just fails that
// check rather than silently corrupting anything. Edge entries can therefore
// live for a year. Refreshing an object needs BOTH an R2 delete and a
// zone-level purge of the URL — see README "Refreshing a cached object".
const EDGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

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
  headers.set("cache-control", EDGE_CACHE_CONTROL);
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

/**
 * Serve an edge-cache match, rewrapping only to restamp x-mirror-status so the
 * response advertises where it came from. cache.match has already resolved
 * Range (206) and If-None-Match (304) against the stored 200.
 */
function serveEdgeMatch(cached: Response): Response {
  const headers = new Headers(cached.headers);
  headers.set("x-mirror-status", "hit-edge");
  return new Response(cached.body, { status: cached.status, headers });
}

// Objects above this size are never edge-cached and always stream from R2.
// Two hard reasons: the Cache API caps entries at 512 MB, and — worse — tee()
// buffers the divergence between the cache write and the client download in
// isolate memory, so a stalled client with a fast cache ingest buffers up to
// the whole object and can blow the 128 MB worker memory limit (the exact
// large-artifact case storeToR2's multipart streaming exists to handle). Large
// artifacts amortize the R2 round trip over their transfer time anyway; the
// edge cache is for the many small fetches where TTFB dominates.
const EDGE_CACHE_MAX_SIZE = 64 * 1024 * 1024;

/**
 * Tee a full-object 200 into the per-PoP edge cache so repeat fetches never
 * touch R2 (the put runs via ctx.waitUntil and doesn't delay the response).
 * Only a plain 200 GET at or under maxSize is storable — the Cache API rejects
 * a 206, a 304 has no body, and oversized objects must not be teed (see
 * EDGE_CACHE_MAX_SIZE) — but ranged/conditional requests still edge-serve
 * later because cache.match slices/revalidates against the stored 200. The
 * entry is keyed on `edgeUrl`, the canonical URL rebuilt from the derived R2
 * key, so a non-canonical request spelling (doubled slash, etc.) can't create
 * a duplicate entry the documented purge flow would miss. Auth is enforced in
 * the handler before any cache lookup. A failed put only logs — the response
 * has already been served. `maxSize` is injectable for tests.
 */
export function storeToEdgeCache(
  response: Response,
  request: Request,
  edgeUrl: string,
  ctx: ExecutionContext,
  maxSize: number = EDGE_CACHE_MAX_SIZE,
): Response {
  if (request.method !== "GET" || response.status !== 200 || !response.body) return response;
  const length = response.headers.get("content-length");
  if (length === null || Number(length) > maxSize) return response;
  const [clientBody, cacheBody] = response.body.tee();
  ctx.waitUntil(
    caches.default
      .put(edgeUrl, new Response(cacheBody, { status: 200, headers: response.headers }))
      .catch((err) => log.warn("edge cache put failed", { url: edgeUrl, error: String(err) })),
  );
  return new Response(clientBody, { status: 200, headers: response.headers });
}

// R2 requires every multipart part except the last to be >= 5 MiB. Use 10 MiB
// parts: memory stays flat at ~one part regardless of object size, and even a
// multi-GB artifact stays well under the ~1000-subrequest-per-invocation limit.
const PART_SIZE = 10 * 1024 * 1024;

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Wrap a stream reader to yield fixed-size parts: every part is exactly
 * `partSize` bytes except the last, which holds whatever remains when the
 * stream ends. R2 requires all non-trailing multipart parts to be the *same*
 * length — handing out a part sized to whatever a single `reader.read()`
 * happened to deliver (as long as it's >= partSize) breaks that invariant the
 * moment upstream chunk boundaries don't align to partSize, since the
 * overshoot varies read to read. This carries any overshoot into `leftover`
 * instead of handing it out, so every returned part lines up exactly.
 */
function createPartReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let leftover = new Uint8Array(0);
  let streamDone = false;
  return async function readPart(partSize: number): Promise<{ data: Uint8Array; done: boolean }> {
    const chunks: Uint8Array[] = leftover.byteLength > 0 ? [leftover] : [];
    let length = leftover.byteLength;
    leftover = new Uint8Array(0);
    while (length < partSize && !streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      chunks.push(value);
      length += value.byteLength;
    }
    const data = concat(chunks, length);
    if (length > partSize) {
      leftover = data.subarray(partSize);
      return { data: data.subarray(0, partSize), done: false };
    }
    return { data, done: streamDone };
  };
}

/**
 * Stream `body` into R2 without buffering the whole object: bodies that fit in
 * one part use a single `put()` (cheaper, and dodges the 5 MiB min-part rule on
 * small files); larger bodies stream through a multipart upload, holding ~one
 * part in memory at a time. This is why object size is bounded by R2's limits
 * rather than the 128 MB worker memory limit. `partSize` is injectable for
 * tests. Aborts the multipart upload if anything fails, then rethrows.
 */
export async function storeToR2(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  httpMetadata: R2HTTPMetadata,
  partSize: number = PART_SIZE,
): Promise<void> {
  const readPart = createPartReader(body.getReader());
  const first = await readPart(partSize);
  if (first.done) {
    // Whole body fit in one part — plain single-shot put.
    await bucket.put(key, first.data, { httpMetadata });
    return;
  }

  const mpu = await bucket.createMultipartUpload(key, { httpMetadata });
  try {
    const parts: R2UploadedPart[] = [];
    let partNumber = 1;
    let part = first;
    while (true) {
      parts.push(await mpu.uploadPart(partNumber, part.data));
      partNumber += 1;
      if (part.done) break;
      part = await readPart(partSize);
      // The stream can end exactly on a part boundary → a 0-byte trailing read.
      // Don't upload an empty part.
      if (part.done && part.data.byteLength === 0) break;
    }
    await mpu.complete(parts);
  } catch (err) {
    try {
      await mpu.abort();
    } catch {
      // Best-effort cleanup of the dangling upload; surface the original error.
    }
    throw err;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    return withRequestContext({ requestId: crypto.randomUUID(), route: url.pathname }, async () => {
      // 1. Auth first — before any R2 or upstream work.
      if (!checkAuth(request.headers.get("authorization"), env.MIRROR_USER, env.MIRROR_SECRET)) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="r2-cache-proxy"' },
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

      // 4. Edge cache: repeat GETs for this PoP are served from local cache
      //    without the cross-region R2 round trip. Keyed on the canonical URL
      //    rebuilt from the derived key (not the raw request URL), carrying the
      //    client's headers so match() resolves Range / If-None-Match against
      //    the stored 200 — 206/304 come back ready. Auth (step 1) has already
      //    run — a cached object is never served to an unauthenticated caller.
      //    HEAD skips the edge cache and reads R2. The cache is a latency
      //    shortcut only: if it throws, fall through to R2 rather than failing
      //    a request R2 could serve.
      const edgeUrl = `${url.origin}/${key}`;
      if (request.method === "GET") {
        try {
          const cached = await caches.default.match(
            new Request(edgeUrl, { headers: request.headers }),
          );
          if (cached) return serveEdgeMatch(cached);
        } catch (err) {
          log.warn("edge cache match failed, falling through to R2", {
            url: edgeUrl,
            error: String(err),
          });
        }
      }

      // 5. R2 hit? R2 resolves Range/conditional directly from the request headers.
      const existing = await env.MIRROR.get(key, {
        range: request.headers,
        onlyIf: request.headers,
      });
      if (existing !== null)
        return storeToEdgeCache(serveObject(existing, request, "hit"), request, edgeUrl, ctx);

      // 6. Miss → fetch upstream. A fresh fetch with no init sends only default
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

      // 7. Store-then-serve, streaming the body into R2 in bounded-size parts so
      // object size is bounded by R2's multipart limits and the per-invocation
      // subrequest cap (~10 GB practical), not the 128 MB worker memory.
      // R2 needs a known length per write, which an auto-decompressed or chunked
      // upstream body lacks — storeToR2 accumulates fixed-size parts (single
      // put() for small bodies, multipart for large) to supply one. Concurrent
      // misses for the same key both store (last write wins, identical bytes) —
      // fine for immutable artifacts.
      try {
        await storeToR2(env.MIRROR, key, upstreamResp.body, {
          contentType: upstreamResp.headers.get("content-type") ?? "application/octet-stream",
        });
        log.info("cached upstream object", { key, upstream });
      } catch (err) {
        log.err("failed to store upstream object", err, { key, upstream });
        return new Response("Bad Gateway\n", {
          status: 502,
          headers: { "x-mirror-status": "miss-error" },
        });
      }

      const stored = await env.MIRROR.get(key, { range: request.headers, onlyIf: request.headers });
      if (stored === null) {
        log.error("object missing immediately after put", { key });
        return new Response("Internal Error\n", { status: 500 });
      }
      return storeToEdgeCache(serveObject(stored, request, "miss-stored"), request, edgeUrl, ctx);
    });
  },
} satisfies ExportedHandler<Env>;
