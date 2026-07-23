import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
