# worker-bazel-mirror

A transparent, lazy read-through mirror for Bazel external dependencies, backed
by R2. The request path **is** the upstream URL minus its scheme. On a cache
hit the object is served straight from R2; on a miss the worker fetches it from
the real upstream, stores it in R2, and serves it — so the first build to ask
for an artifact populates the cache and every later build gets it from R2. This
keeps hermetic Bazel builds resilient to upstream URL rot and outages.

On top of R2 sits Cloudflare's **per-PoP edge cache**: every full-object 200 up
to 64 MiB is also written to `caches.default`, so repeat fetches are served
from the PoP nearest the requester (~tens of ms) instead of paying the
cross-region worker → R2 round trip on every hit. R2 stays the durable source
of truth; the edge cache is a latency shortcut that any PoP can rebuild from R2
at any time, and larger objects simply keep streaming from R2 (the Cache API
caps entries at 512 MB, and tee-ing a huge body into the cache would buffer it
in worker memory — see `EDGE_CACHE_MAX_SIZE`).

Deployed at `https://bazel-mirror.lswith.io`. Every request must present a
shared secret via HTTP Basic auth (Bazel supplies it from `~/.netrc`); without
a valid token the worker returns `401` before doing any R2 or upstream work, so
there is no open-proxy surface.

## Endpoints

| Method         | Path             | Behavior                                                                                     |
| -------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `GET` / `HEAD` | `/<host>/<path>` | Hit: serve `<host>/<path>` from R2. Miss: fetch `https://<host>/<path>`, store it, serve it. |

- Auth: `Authorization: Basic base64(<anything>:<MIRROR_SECRET>)` on every
  request. Missing/wrong → `401`, checked **before** any edge-cache or R2
  lookup — a cached object is never served unauthenticated. Any method other
  than `GET`/`HEAD` → `405`.
- `Range` and `If-None-Match` are honored (206 / 304) once an object is cached,
  from both the edge cache and R2.
- Response header `x-mirror-status` reports what happened: `hit-edge` (served
  from this PoP's edge cache, no R2 read), `hit` (served from R2), `miss-stored`,
  `miss-passthrough` (upstream returned non-2xx — passed through, **not**
  cached), or `miss-error` (upstream fetch threw → `502`).
- Edge-cache population is GET-only, full-200-only, and capped at 64 MiB (a
  ranged 206 or a 304 is never stored, so a partial object can't poison the
  cache; HEAD bypasses the edge cache; bigger objects always stream from R2).
  Entries carry `cache-control: public, max-age=31536000,
immutable` — safe because Bazel re-verifies every download against its
  `sha256`.

## Layout

```
worker-bazel-mirror/
  src/index.ts       — auth, key derivation, edge-cache + R2 hit/miss handling
  src/logger.ts      — shared NDJSON logger (copied verbatim across workers)
  test/mirror.test.ts  — workerd + real local R2: auth, hit, miss, range, passthrough
  test/helpers.test.ts — unit tests for deriveKey / checkAuth
  test/logger.test.ts  — logger shape + request-context stamping
  scripts/smoke.mjs  — read-only cold/warm smoke against a deployed mirror
```

## Env vars

| Name            | Where it lives                     | Purpose                                                            |
| --------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `MIRROR`        | binding (`wrangler.jsonc`)         | R2 bucket `lswith-bazel-mirror`.                                   |
| `MIRROR_SECRET` | **secret** (`wrangler secret put`) | Shared token — the Basic-auth password every request must present. |

## One-time setup

From this directory, with wrangler logged into the **luke@lswith.io / Ridgeline**
Cloudflare account (`pnpm exec wrangler login` first if needed):

```bash
pnpm exec wrangler r2 bucket create lswith-bazel-mirror
openssl rand -hex 32 | pnpm exec wrangler secret put MIRROR_SECRET
pnpm run deploy   # first deploy provisions the bazel-mirror.lswith.io custom domain
```

Keep a copy of the generated `MIRROR_SECRET` — it goes into your Bazel `~/.netrc`
(below) and into CI as a secret env var.

## Wiring Bazel to the mirror

These changes live in the **consuming Bazel repo**, not here.

1. Enable the downloader config in `.bazelrc`:

   ```
   common --experimental_downloader_config=bazel_downloader.cfg
   ```

2. Create `bazel_downloader.cfg` beside it:

   ```
   # Route every download through the mirror, keeping the original upstream as a
   # fallback. Bazel matches the URL WITHOUT its scheme, so $1 is host+path. A
   # plain `rewrite` REPLACES the URL, so the second (self-mapping) rule is what
   # re-adds the origin as a fallback candidate — Bazel tries the mirror first,
   # then the origin.
   rewrite (.*) bazel-mirror.lswith.io/$1
   rewrite (.*) $1
   ```

3. Add the shared secret to `~/.netrc` (and write the same file on CI from a
   secret env var) so Bazel authenticates to the mirror:

   ```
   machine bazel-mirror.lswith.io
   login bazel
   password <MIRROR_SECRET>
   ```

   The username is ignored; only the password is checked.

Notes / gotchas:

- Bazel caches the downloader config in its server — run `bazel shutdown` after
  editing `bazel_downloader.cfg` for changes to take effect
  ([bazelbuild/bazel#24166](https://github.com/bazelbuild/bazel/issues/24166)).
- The rewrite intercepts `http_archive` / `http_file` downloads. If you use
  bzlmod, confirm it also covers your registry fetches — there have historically
  been gaps ([bazelbuild/bazel#19402](https://github.com/bazelbuild/bazel/issues/19402)).
- Integrity is Bazel's job: it re-verifies every download against the `sha256`
  in your build files, so a corrupt/truncated cache entry just fails the
  checksum. Purge that key from R2 and it re-fetches. The mirror does no hashing.

## Local development

```bash
cp .dev.vars.example .dev.vars   # set MIRROR_SECRET
pnpm run dev                     # wrangler dev — local R2, http://localhost:8787

# cold miss then warm hit (same bytes, second is x-mirror-status: hit-edge —
# miniflare implements caches.default too — or hit if served from R2):
curl -u bazel:$MIRROR_SECRET http://localhost:8787/raw.githubusercontent.com/bazelbuild/bazel/master/.bazelversion -i
curl  # no creds → 401
```

## Testing

```bash
pnpm test            # vitest run — inside workerd, with a real local R2 bucket
pnpm run test:coverage
node scripts/smoke.mjs   # read-only cold/warm check against a deployed mirror
```

Tests run in the `@cloudflare/vitest-pool-workers` runtime. The worker is driven
via `SELF.fetch()`; the cache-miss path's outbound `fetch()` is intercepted with
`vi.spyOn(globalThis, "fetch")` (an unmatched request throws, so a "hit" that
wrongly touches the network fails loudly), and R2 is a **real local bucket**
(`miniflare: { r2Buckets: ["MIRROR"] }`) so miss→populate→hit is exercised end
to end. Coverage thresholds in `vitest.config.ts` are a ratchet — raise as
coverage grows, never lower to make a red build pass.

## Deploying

```bash
pnpm run deploy   # wrangler deploy
```

There is no GitHub deploy workflow — like the other workers, deploys go through
**Cloudflare Workers Builds**. To auto-deploy on push to `main`, set up a
Workers Builds project for this Worker with **Root directory `worker-bazel-mirror/`**
and build command `pnpm run deploy`.

## Error tracking

Uncaught errors, and every explicit `log.err`, show up in the Cloudflare
dashboard under this Worker → **Logs**, with a full stack trace — no third-party
APM needed.

- **Source maps** — `"upload_source_maps": true` in `wrangler.jsonc` makes
  `wrangler deploy` bundle real source maps, so exception stack traces resolve
  back to this TypeScript rather than minified/bundled JS.
- **Breadcrumbs** — `observability.logs.invocation_logs` (100% sampling) groups
  every log line from a request into one timeline, and `src/logger.ts` stamps
  each line with a shared `requestId`/`route` via `AsyncLocalStorage`
  (`withRequestContext`), so an error's log line carries the request that led to
  it.

## Operating notes

- **HTTPS-only upstreams.** The reconstructed upstream is always `https://<path>`.
  Bazel deps are https in practice; http upstreams aren't mirror-able.
- **Concurrent misses** for the same key both fetch and `put` (last write wins,
  identical bytes) — fine for immutable build artifacts.
- **Size ceiling: the platform's, not the worker's memory.** On a miss the
  body streams into R2 in fixed 10 MiB parts (single `put()` for small
  objects, multipart upload for large ones — see `storeToR2`), holding ~one
  part in memory at a time. The binding ceiling is therefore the per-invocation
  subrequest cap (~1,000 calls × 10 MiB parts ≈ 10 GB per artifact), not the
  128 MB worker memory limit. Far beyond any real Bazel dep.
- **Refreshing a cached object** (e.g. an upstream re-tagged a release) takes
  two steps now that the edge cache exists:
  1. Delete the key from R2 —
     `pnpm exec wrangler r2 object delete lswith-bazel-mirror/<host>/<path>`.
  2. Purge the URL from the zone's edge cache (dashboard → lswith.io → Caching
     → Purge by URL, or the API) with
     `https://bazel-mirror.lswith.io/<host>/<path>` — edge entries are stored
     with a 1-year TTL, so without the purge, PoPs that already hold the object
     keep serving the old bytes.
- **Non-2xx is never cached**, so a transient upstream 5xx or a 404 won't poison
  the cache; the next request retries the upstream.
