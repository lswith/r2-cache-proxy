import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeToR2 } from "../src/index";

// Type the bindings the test touches directly. (In production these come from
// the wrangler-generated worker-configuration.d.ts; declaring them here keeps
// the test self-contained.)
declare module "cloudflare:test" {
  interface ProvidedEnv {
    MIRROR: R2Bucket;
    MIRROR_SECRET: string;
  }
}

const WORKER = "https://bazel-mirror.lswith.io";
const SECRET = "test_secret"; // matches vitest.config.ts miniflare binding

function auth(secret = SECRET): string {
  return "Basic " + btoa(`bazel:${secret}`);
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
  // The local R2 bucket persists across tests in this file — clear it so each
  // test starts from an empty cache and keys can be reused freely.
  const listed = await env.MIRROR.list();
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
      headers: { authorization: auth("wrong") },
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

  it("accepts any username, only the password (secret) matters", async () => {
    await env.MIRROR.put("github.com/o/r/x.tar.gz", "CACHED");
    const res = await SELF.fetch(`${WORKER}/github.com/o/r/x.tar.gz`, {
      headers: { authorization: "Basic " + btoa(`anyone:${SECRET}`) },
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
});
