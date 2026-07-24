import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeToEdgeCache, storeToR2 } from "../src/index";

// Type the bindings the test touches directly. (In production these come from
// the wrangler-generated worker-configuration.d.ts; declaring them here keeps
// the test self-contained.)
declare module "cloudflare:test" {
  interface ProvidedEnv {
    MIRROR: R2Bucket;
    MIRROR_USER: string;
    MIRROR_SECRET: string;
  }
}

const WORKER = "https://mirror.example.com";
const USER = "test_user"; // matches vitest.config.ts miniflare binding
const SECRET = "test_secret"; // matches vitest.config.ts miniflare binding

function auth(user = USER, secret = SECRET): string {
  return "Basic " + btoa(`${user}:${secret}`);
}

// --- Outbound upstream fetch mock -------------------------------------------
// The worker's cache-miss path calls globalThis.fetch() against the real
// upstream. Intercept it with a FIFO queue matched on origin + method + path;
// an unmatched request throws (mirroring disableNetConnect()), so a test that
// forgets to queue a mock — or a "hit" that wrongly hits the network — fails
// loudly. SELF.fetch() (the request into the worker) does NOT go through this
// spy.
type MockedFetch = (request: Request) => Response | Promise<Response>;
interface MockEntry {
  origin: string;
  method: string;
  path: string;
  handler: MockedFetch;
}
let mockQueue: MockEntry[] = [];
let upstreamRequests: Request[] = [];

function queueUpstream(origin: string, method: string, path: string, handler: MockedFetch): void {
  mockQueue.push({ origin, method, path, handler });
}

beforeEach(async () => {
  mockQueue = [];
  upstreamRequests = [];
  // The local R2 bucket AND the edge cache persist across tests in this file —
  // clear both so each test starts cold. Edge entries are purged via the R2 key
  // list (every edge-cached object was stored in R2 first). Two caveats: a test
  // that deletes an R2 key mid-test must purge the matching edge URL itself
  // (try/finally, so a failed assertion can't strand it for the retry), and a
  // test that populates the edge cache should use a key unique to that test —
  // the put runs via ctx.waitUntil, so it can land AFTER this purge has already
  // run for the next test, stranding an entry that would poison a key-reuser.
  const listed = await env.MIRROR.list();
  for (const o of listed.objects) {
    await caches.default.delete(`${WORKER}/${o.key}`);
  }
  if (listed.objects.length > 0) {
    await env.MIRROR.delete(listed.objects.map((o) => o.key));
  }
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as string | URL, init);
    upstreamRequests.push(request);
    const url = new URL(request.url);
    const idx = mockQueue.findIndex(
      (m) => m.origin === url.origin && m.method === request.method && m.path === url.pathname,
    );
    if (idx === -1) {
      throw new Error(`no upstream mock for ${request.method} ${url.origin}${url.pathname}`);
    }
    const [mock] = mockQueue.splice(idx, 1);
    return mock.handler(request);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("401s a request with no Authorization header", async () => {
    const res = await SELF.fetch(`${WORKER}/github.com/o/r/archive/v1.tar.gz`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic/);
    // Nothing was fetched upstream and nothing was cached.
    expect(upstreamRequests).toHaveLength(0);
    expect(await env.MIRROR.get("github.com/o/r/archive/v1.tar.gz")).toBeNull();
  });

  it("401s a request with the wrong secret", async () => {
    const res = await SELF.fetch(`${WORKER}/github.com/o/r/archive/v1.tar.gz`, {
      headers: { authorization: auth(USER, "wrong") },
    });
    expect(res.status).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("401s a request with the wrong username", async () => {
    const res = await SELF.fetch(`${WORKER}/github.com/o/r/archive/v1.tar.gz`, {
      headers: { authorization: auth("someone-else", SECRET) },
    });
    expect(res.status).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("401s a malformed Basic header (invalid base64)", async () => {
    const res = await SELF.fetch(`${WORKER}/github.com/o/r/x.tar.gz`, {
      headers: { authorization: "Basic !!!not-base64!!!" },
    });
    expect(res.status).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });

  it("accepts the correct username and password", async () => {
    // Key is unique to this test: the 200 schedules a waitUntil edge-cache put
    // that may land after the next test's beforeEach purge (see above).
    await env.MIRROR.put("github.com/o/r/auth-check.tar.gz", "CACHED");
    const res = await SELF.fetch(`${WORKER}/github.com/o/r/auth-check.tar.gz`, {
      headers: { authorization: auth() },
    });
    expect(res.status).toBe(200);
  });
});

describe("method handling", () => {
  it("405s a POST", async () => {
    const res = await SELF.fetch(`${WORKER}/github.com/o/r/x.tar.gz`, {
      method: "POST",
      headers: { authorization: auth() },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });
});

describe("bad requests", () => {
  it("404s a path with no upstream host", async () => {
    const res = await SELF.fetch(`${WORKER}/not-a-host`, { headers: { authorization: auth() } });
    expect(res.status).toBe(404);
    expect(upstreamRequests).toHaveLength(0);
  });
});

describe("cache miss", () => {
  it("fetches upstream, stores in R2, and serves the bytes", async () => {
    queueUpstream(
      "https://github.com",
      "GET",
      "/o/r/archive/v1.tar.gz",
      () => new Response("ARCHIVE-BYTES", { headers: { "content-type": "application/gzip" } }),
    );

    const res = await SELF.fetch(`${WORKER}/github.com/o/r/archive/v1.tar.gz`, {
      headers: { authorization: auth() },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-mirror-status")).toBe("miss-stored");
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(await res.text()).toBe("ARCHIVE-BYTES");

    // Persisted to R2 for next time.
    const stored = await env.MIRROR.get("github.com/o/r/archive/v1.tar.gz");
    expect(stored).not.toBeNull();
    expect(await stored!.text()).toBe("ARCHIVE-BYTES");
  });

  it("stores a streamed upstream body that has no content-length", async () => {
    // Reproduces the production failure: an auto-decompressed / chunked upstream
    // response is a ReadableStream with no known length, which R2 put() rejects.
    // The worker must buffer it first. (miniflare's local R2 is lenient enough
    // that the old streaming code passed here — this guards the fix regardless.)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("STREAMED-"));
        controller.enqueue(new TextEncoder().encode("ARCHIVE"));
        controller.close();
      },
    });
    queueUpstream(
      "https://github.com",
      "GET",
      "/o/r/streamed.tar.gz",
      () => new Response(stream, { headers: { "content-type": "application/gzip" } }),
    );

    const res = await SELF.fetch(`${WORKER}/github.com/o/r/streamed.tar.gz`, {
      headers: { authorization: auth() },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-mirror-status")).toBe("miss-stored");
    expect(await res.text()).toBe("STREAMED-ARCHIVE");
    const stored = await env.MIRROR.get("github.com/o/r/streamed.tar.gz");
    expect(await stored!.text()).toBe("STREAMED-ARCHIVE");
  });

  it("does NOT forward the client's Authorization header upstream", async () => {
    queueUpstream("https://github.com", "GET", "/o/r/x.tar.gz", () => new Response("OK"));
    await SELF.fetch(`${WORKER}/github.com/o/r/x.tar.gz`, { headers: { authorization: auth() } });
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0].headers.get("authorization")).toBeNull();
  });

  it("passes an upstream 404 through and does NOT cache it", async () => {
    queueUpstream(
      "https://github.com",
      "GET",
      "/o/r/missing.tar.gz",
      () => new Response("nope", { status: 404 }),
    );

    const res = await SELF.fetch(`${WORKER}/github.com/o/r/missing.tar.gz`, {
      headers: { authorization: auth() },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("x-mirror-status")).toBe("miss-passthrough");
    expect(await env.MIRROR.get("github.com/o/r/missing.tar.gz")).toBeNull();
  });

  it("502s (uncached) when the upstream fetch throws", async () => {
    queueUpstream("https://github.com", "GET", "/o/r/boom.tar.gz", () => {
      throw new Error("connection reset");
    });

    const res = await SELF.fetch(`${WORKER}/github.com/o/r/boom.tar.gz`, {
      headers: { authorization: auth() },
    });

    expect(res.status).toBe(502);
    expect(res.headers.get("x-mirror-status")).toBe("miss-error");
    expect(await env.MIRROR.get("github.com/o/r/boom.tar.gz")).toBeNull();
  });
});

describe("cache hit", () => {
  it("serves from R2 without any upstream fetch", async () => {
    await env.MIRROR.put("github.com/o/r/cached.tar.gz", "CACHED-BYTES", {
      httpMetadata: { contentType: "application/octet-stream" },
    });

    const res = await SELF.fetch(`${WORKER}/github.com/o/r/cached.tar.gz`, {
      headers: { authorization: auth() },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-mirror-status")).toBe("hit");
    expect(await res.text()).toBe("CACHED-BYTES");
    // The upstream mock queue was empty; a network attempt would have thrown.
    expect(upstreamRequests).toHaveLength(0);
  });

  it("serves headers only (no body) for a HEAD request", async () => {
    await env.MIRROR.put("example.com/thing.bin", "PAYLOAD", {
      httpMetadata: { contentType: "application/octet-stream" },
    });

    const res = await SELF.fetch(`${WORKER}/example.com/thing.bin`, {
      method: "HEAD",
      headers: { authorization: auth() },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-mirror-status")).toBe("hit");
    expect(res.headers.get("content-length")).toBe("7");
    expect(await res.text()).toBe("");
  });

  it("honors a Range request with a 206 partial response", async () => {
    await env.MIRROR.put("example.com/blob", "0123456789");

    const res = await SELF.fetch(`${WORKER}/example.com/blob`, {
      headers: { authorization: auth(), range: "bytes=2-5" },
    });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe("2345");
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
  });

  it("honors a suffix Range request (last N bytes)", async () => {
    await env.MIRROR.put("example.com/blob", "0123456789");

    const res = await SELF.fetch(`${WORKER}/example.com/blob`, {
      headers: { authorization: auth(), range: "bytes=-4" },
    });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe("6789");
    expect(res.headers.get("content-range")).toBe("bytes 6-9/10");
  });

  it("returns 304 when the client's If-None-Match matches", async () => {
    await env.MIRROR.put("example.com/blob", "0123456789");
    const stored = await env.MIRROR.get("example.com/blob");

    const res = await SELF.fetch(`${WORKER}/example.com/blob`, {
      headers: { authorization: auth(), "if-none-match": stored!.httpEtag },
    });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });
});

describe("edge cache", () => {
  // The worker populates the per-PoP edge cache via ctx.waitUntil, which
  // finishes after the response is returned — poll until the entry lands.
  async function expectEdgeCached(url: string): Promise<void> {
    await vi.waitFor(async () => {
      expect(await caches.default.match(url)).toBeDefined();
    });
  }

  it("an R2 hit populates the edge cache and repeat GETs serve from the edge", async () => {
    await env.MIRROR.put("example.com/edge/hit.bin", "EDGE-BYTES", {
      httpMetadata: { contentType: "application/gzip" },
    });
    const url = `${WORKER}/example.com/edge/hit.bin`;

    try {
      const first = await SELF.fetch(url, { headers: { authorization: auth() } });
      expect(first.status).toBe(200);
      expect(first.headers.get("x-mirror-status")).toBe("hit");
      expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await first.text()).toBe("EDGE-BYTES");
      await expectEdgeCached(url);

      // Remove the object from R2: the only way the next GET can succeed is the
      // edge cache (an R2 miss would try upstream, and the empty mock queue
      // throws → 502 miss-error).
      await env.MIRROR.delete("example.com/edge/hit.bin");
      const second = await SELF.fetch(url, { headers: { authorization: auth() } });
      expect(second.status).toBe(200);
      expect(second.headers.get("x-mirror-status")).toBe("hit-edge");
      expect(second.headers.get("content-type")).toBe("application/gzip");
      expect(await second.text()).toBe("EDGE-BYTES");
      expect(upstreamRequests).toHaveLength(0);
    } finally {
      // Key was deleted from R2 mid-test, so beforeEach's R2-derived purge
      // won't see it — purge here even on assertion failure, or the stranded
      // entry would make every retry fail on the FIRST request's status.
      await caches.default.delete(url);
    }
  });

  it("a miss-stored response populates the edge cache too", async () => {
    queueUpstream("https://example.com", "GET", "/edge/fresh.bin", () => new Response("FRESH"));
    const url = `${WORKER}/example.com/edge/fresh.bin`;

    const first = await SELF.fetch(url, { headers: { authorization: auth() } });
    expect(first.headers.get("x-mirror-status")).toBe("miss-stored");
    // The cold-miss path is what sets the edge TTL — pin the header here too.
    expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await first.text()).toBe("FRESH");
    await expectEdgeCached(url);

    const second = await SELF.fetch(url, { headers: { authorization: auth() } });
    expect(second.headers.get("x-mirror-status")).toBe("hit-edge");
    expect(await second.text()).toBe("FRESH");
    expect(upstreamRequests).toHaveLength(1);
  });

  it("honors Range and If-None-Match against an edge-cached object", async () => {
    await env.MIRROR.put("example.com/edge/blob", "0123456789");
    const url = `${WORKER}/example.com/edge/blob`;

    const full = await SELF.fetch(url, { headers: { authorization: auth() } });
    const etag = full.headers.get("etag");
    expect(etag).not.toBeNull();
    await full.text();
    await expectEdgeCached(url);

    const ranged = await SELF.fetch(url, {
      headers: { authorization: auth(), range: "bytes=2-5" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("x-mirror-status")).toBe("hit-edge");
    expect(await ranged.text()).toBe("2345");
    expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10");

    const conditional = await SELF.fetch(url, {
      headers: { authorization: auth(), "if-none-match": etag as string },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("x-mirror-status")).toBe("hit-edge");
  });

  it("still 401s an unauthenticated request for an edge-cached object", async () => {
    await env.MIRROR.put("example.com/edge/secret.bin", "SECRET-BYTES");
    const url = `${WORKER}/example.com/edge/secret.bin`;

    const first = await SELF.fetch(url, { headers: { authorization: auth() } });
    await first.text();
    await expectEdgeCached(url);

    const res = await SELF.fetch(url);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("SECRET-BYTES");
  });

  it("HEAD bypasses the edge cache and serves from R2", async () => {
    await env.MIRROR.put("example.com/edge/head.bin", "HEAD-BYTES");
    const url = `${WORKER}/example.com/edge/head.bin`;

    const populate = await SELF.fetch(url, { headers: { authorization: auth() } });
    await populate.text();
    await expectEdgeCached(url);

    const head = await SELF.fetch(url, { method: "HEAD", headers: { authorization: auth() } });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-mirror-status")).toBe("hit");
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
  });

  it("query variants get distinct edge entries (no cross-poisoning)", async () => {
    // deriveKey keeps the query string in both the R2 key and the URL, so two
    // query variants are two separate objects — pin that the edge cache keys
    // the same way and can never serve one variant's bytes for the other.
    await env.MIRROR.put("example.com/edge/q?v=1", "VARIANT-ONE");
    await env.MIRROR.put("example.com/edge/q?v=2", "VARIANT-TWO");
    const url1 = `${WORKER}/example.com/edge/q?v=1`;
    const url2 = `${WORKER}/example.com/edge/q?v=2`;

    try {
      const one = await SELF.fetch(url1, { headers: { authorization: auth() } });
      expect(await one.text()).toBe("VARIANT-ONE");
      const two = await SELF.fetch(url2, { headers: { authorization: auth() } });
      expect(await two.text()).toBe("VARIANT-TWO");
      await expectEdgeCached(url1);
      await expectEdgeCached(url2);

      // With the R2 objects gone, only the edge cache can answer.
      await env.MIRROR.delete(["example.com/edge/q?v=1", "example.com/edge/q?v=2"]);
      const oneAgain = await SELF.fetch(url1, { headers: { authorization: auth() } });
      expect(oneAgain.headers.get("x-mirror-status")).toBe("hit-edge");
      expect(await oneAgain.text()).toBe("VARIANT-ONE");
      const twoAgain = await SELF.fetch(url2, { headers: { authorization: auth() } });
      expect(twoAgain.headers.get("x-mirror-status")).toBe("hit-edge");
      expect(await twoAgain.text()).toBe("VARIANT-TWO");
    } finally {
      // R2 keys were deleted mid-test — purge the edge entries ourselves.
      await caches.default.delete(url1);
      await caches.default.delete(url2);
    }
  });

  it("a ranged 206 from R2 does NOT create an edge entry (no partial-object poisoning)", async () => {
    await env.MIRROR.put("example.com/edge/partial", "0123456789");
    const url = `${WORKER}/example.com/edge/partial`;

    const ranged = await SELF.fetch(url, {
      headers: { authorization: auth(), range: "bytes=0-3" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("x-mirror-status")).toBe("hit");
    expect(await ranged.text()).toBe("0123");

    // Give a (buggy) background put a chance to land, then assert absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await caches.default.match(url)).toBeUndefined();
  });

  it("serves from R2 when the edge-cache lookup throws (fail open)", async () => {
    await env.MIRROR.put("example.com/edge/failopen.bin", "STILL-SERVED");
    const url = `${WORKER}/example.com/edge/failopen.bin`;

    vi.spyOn(caches.default, "match").mockRejectedValueOnce(new Error("cache exploded"));
    const res = await SELF.fetch(url, { headers: { authorization: auth() } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mirror-status")).toBe("hit");
    expect(await res.text()).toBe("STILL-SERVED");
  });

  it("a failed edge-cache put does not affect the already-served response", async () => {
    await env.MIRROR.put("example.com/edge/putfail.bin", "SERVED-ANYWAY");
    const url = `${WORKER}/example.com/edge/putfail.bin`;

    vi.spyOn(caches.default, "put").mockRejectedValueOnce(new Error("cache full"));
    const res = await SELF.fetch(url, { headers: { authorization: auth() } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mirror-status")).toBe("hit");
    expect(await res.text()).toBe("SERVED-ANYWAY");
  });

  // Direct unit tests of the size cap: tee() buffers the divergence between
  // the cache write and the client download in isolate memory, so oversized
  // objects must skip edge caching entirely (they stream from R2 as before).
  describe("size cap (storeToEdgeCache called directly)", () => {
    function fakeCtx(puts: Promise<unknown>[]): ExecutionContext {
      return {
        waitUntil: (p: Promise<unknown>) => puts.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext;
    }

    function res200(body: string, extraHeaders: Record<string, string> = {}): Response {
      return new Response(body, {
        status: 200,
        headers: {
          "content-length": String(body.length),
          "cache-control": "public, max-age=60",
          ...extraHeaders,
        },
      });
    }

    it("does not schedule a put for an object larger than the cap", async () => {
      const puts: Promise<unknown>[] = [];
      const url = "https://mirror.test/over-cap";
      const out = storeToEdgeCache(res200("0123456789"), new Request(url), url, fakeCtx(puts), 9);
      expect(puts).toHaveLength(0);
      // The body passes through untouched (no tee).
      expect(await out.text()).toBe("0123456789");
      expect(await caches.default.match(url)).toBeUndefined();
    });

    it("does not schedule a put when content-length is missing (fail safe)", async () => {
      const puts: Promise<unknown>[] = [];
      const url = "https://mirror.test/no-length";
      const headerless = new Response("0123456789", { status: 200 });
      headerless.headers.delete("content-length");
      const out = storeToEdgeCache(headerless, new Request(url), url, fakeCtx(puts), 1024);
      expect(puts).toHaveLength(0);
      expect(await out.text()).toBe("0123456789");
    });

    it("schedules a put for an object at the cap", async () => {
      const puts: Promise<unknown>[] = [];
      const url = "https://mirror.test/at-cap";
      const out = storeToEdgeCache(res200("0123456789"), new Request(url), url, fakeCtx(puts), 10);
      expect(await out.text()).toBe("0123456789");
      expect(puts).toHaveLength(1);
      await Promise.all(puts);
      const cached = await caches.default.match(url);
      expect(cached).toBeDefined();
      expect(await cached?.text()).toBe("0123456789");
      await caches.default.delete(url);
    });
  });
});

describe("storeToR2 (streaming into R2)", () => {
  function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  }

  it("uses a single put for a body that fits in one part", async () => {
    await storeToR2(env.MIRROR, "example.com/small.bin", streamOf("small-body"), {
      contentType: "text/plain",
    });
    const stored = await env.MIRROR.get("example.com/small.bin");
    expect(await stored!.text()).toBe("small-body");
    expect(stored!.httpMetadata?.contentType).toBe("text/plain");
  });

  // A patterned body streamed in `chunk`-sized pieces, plus the expected bytes.
  // R2 (and miniflare) enforce a real 5 MiB minimum part size, so multipart
  // tests must use genuine ≥5 MiB parts.
  function patterned(
    total: number,
    chunk: number,
  ): {
    stream: ReadableStream<Uint8Array>;
    bytes: Uint8Array;
  } {
    const bytes = new Uint8Array(total);
    for (let i = 0; i < total; i++) bytes[i] = i % 251;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let off = 0; off < total; off += chunk) {
          controller.enqueue(bytes.subarray(off, Math.min(off + chunk, total)));
        }
        controller.close();
      },
    });
    return { stream, bytes };
  }

  const MiB = 1024 * 1024;

  it("streams a body larger than the part size via multipart, intact and in order", async () => {
    // 11 MiB in 1 MiB chunks, 5 MiB parts → 3 parts (5, 5, 1).
    const { stream, bytes } = patterned(11 * MiB, MiB);
    await storeToR2(
      env.MIRROR,
      "example.com/big.bin",
      stream,
      { contentType: "application/gzip" },
      5 * MiB,
    );

    const stored = await env.MIRROR.get("example.com/big.bin");
    expect(stored).not.toBeNull();
    expect(stored!.size).toBe(11 * MiB);
    expect(stored!.httpMetadata?.contentType).toBe("application/gzip");
    // Full byte-for-byte integrity (fast first-mismatch scan, no diff alloc) —
    // catches a dropped, duplicated, reordered, or corrupted part.
    const got = new Uint8Array(await stored!.arrayBuffer());
    let firstMismatch = -1;
    for (let i = 0; i < bytes.length; i++) {
      if (got[i] !== bytes[i]) {
        firstMismatch = i;
        break;
      }
    }
    expect(firstMismatch).toBe(-1);
  });

  it("ends cleanly when the body finishes exactly on a part boundary", async () => {
    // 10 MiB, 5 MiB parts → exactly 2 parts, then a 0-byte read that must be
    // dropped rather than uploaded as an (invalid) empty trailing part.
    const { stream } = patterned(10 * MiB, MiB);
    await storeToR2(
      env.MIRROR,
      "example.com/exact.bin",
      stream,
      { contentType: "application/octet-stream" },
      5 * MiB,
    );
    const stored = await env.MIRROR.get("example.com/exact.bin");
    expect(stored!.size).toBe(10 * MiB);
  });

  // A patterned body whose chunk sizes cycle through irregular values, like a
  // real upstream fetch() body (TCP/network buffering delivers whatever-sized
  // chunks it has on hand per read(), not neat fixed-size ones). A *uniform*
  // chunk size can't reproduce the production bug: accumulating whole chunks
  // until a part hits partSize always overshoots by the same fixed amount
  // when every chunk is the same size, so parts stay equal-length even with
  // the naive (buggy) accumulation. Irregular chunk sizes are what actually
  // make the overshoot drift from part to part.
  function patternedIrregular(
    total: number,
    chunkSizes: number[],
  ): {
    stream: ReadableStream<Uint8Array>;
    bytes: Uint8Array;
  } {
    const bytes = new Uint8Array(total);
    for (let i = 0; i < total; i++) bytes[i] = i % 251;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let off = 0;
        let i = 0;
        while (off < total) {
          const size = Math.min(chunkSizes[i % chunkSizes.length], total - off);
          controller.enqueue(bytes.subarray(off, off + size));
          off += size;
          i += 1;
        }
        controller.close();
      },
    });
    return { stream, bytes };
  }

  it("uploads uniform-length parts when upstream chunk boundaries don't align to partSize", async () => {
    // 11 MiB delivered in irregular chunk sizes against 5 MiB parts. Without
    // trimming overshoot into a carried-over leftover, this reproduces R2's
    // real "All non-trailing parts must have the same length" rejection.
    const { stream, bytes } = patternedIrregular(11 * MiB, [700_000, 350_000, 900_000, 123_456]);

    const partLengths: number[] = [];
    const createSpy = vi
      .spyOn(env.MIRROR, "createMultipartUpload")
      .mockImplementation(async (key, opts) => {
        createSpy.mockRestore();
        const mpu = await env.MIRROR.createMultipartUpload(key, opts);
        const originalUploadPart = mpu.uploadPart.bind(mpu);
        mpu.uploadPart = async (partNumber: number, value: R2UploadPartValue) => {
          partLengths.push((value as Uint8Array).byteLength);
          return originalUploadPart(partNumber, value);
        };
        return mpu;
      });

    await storeToR2(
      env.MIRROR,
      "example.com/irregular.bin",
      stream,
      { contentType: "application/gzip" },
      5 * MiB,
    );

    expect(partLengths.length).toBeGreaterThan(1);
    const nonTrailing = partLengths.slice(0, -1);
    expect(new Set(nonTrailing)).toEqual(new Set([5 * MiB]));

    const stored = await env.MIRROR.get("example.com/irregular.bin");
    expect(stored!.size).toBe(11 * MiB);
    const got = new Uint8Array(await stored!.arrayBuffer());
    let firstMismatch = -1;
    for (let i = 0; i < bytes.length; i++) {
      if (got[i] !== bytes[i]) {
        firstMismatch = i;
        break;
      }
    }
    expect(firstMismatch).toBe(-1);
  });
});
