#!/usr/bin/env node

/**
 * Read-only smoke test for the Bazel R2 mirror.
 *
 * Fetches a small, stable public file through the mirror twice and asserts both
 * requests return 200 with identical bytes and that the second is served from
 * the mirror's cache (`x-mirror-status: hit` from R2, or `hit-edge` from the
 * PoP's edge cache). On a truly cold key the first request is a `miss-stored`
 * (the worker fetches upstream + stores it); on repeat runs it's already a
 * hit — either is fine, the invariant is "second request is served from cache
 * and the bytes match".
 *
 * Usage (MIRROR_SECRET comes from your shell env — see ~/.secrets.zsh):
 *   node scripts/smoke.mjs
 *   MIRROR_BASE=http://localhost:8787 node scripts/smoke.mjs   # vs `wrangler dev`
 */

const BASE = process.env.MIRROR_BASE ?? "https://bazel-mirror.lswith.io";
const SECRET = process.env.MIRROR_SECRET;
// A small, stable file, addressed Bazel-style as host/path (no scheme).
const SAMPLE =
  process.env.MIRROR_SAMPLE ?? "raw.githubusercontent.com/bazelbuild/bazel/master/.bazelversion";

if (!SECRET) {
  console.error("MIRROR_SECRET not set. Export it (see ~/.secrets.zsh) and retry.");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`bazel:${SECRET}`).toString("base64");
const url = `${BASE}/${SAMPLE}`;

async function get(label) {
  const res = await fetch(url, { headers: { authorization: auth } });
  const status = res.headers.get("x-mirror-status");
  const body = Buffer.from(await res.arrayBuffer());
  console.log(`  ${label}: HTTP ${res.status}  x-mirror-status=${status}  ${body.length} bytes`);
  if (!res.ok) {
    console.error(`  FAIL: expected 200, got ${res.status}`);
    process.exit(1);
  }
  return { status, body };
}

console.log(`Smoke: ${url}\n`);

console.log("== 1. first request (cold miss populates, or already cached) ==");
const first = await get("first ");

console.log("== 2. second request (expect cache hit: hit or hit-edge) ==");
const second = await get("second");

if (!first.body.equals(second.body)) {
  console.error("\nFAIL: first and second responses have different bytes.");
  process.exit(1);
}
if (second.status !== "hit" && second.status !== "hit-edge") {
  console.error(`\nFAIL: expected second request to be a hit or hit-edge, got '${second.status}'.`);
  process.exit(1);
}

console.log("\nOK: mirror serves identical bytes and the warm request was served from cache.");
