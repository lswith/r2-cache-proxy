import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (the real Worker runtime) with a real (local) R2
// bucket for MIRROR, so miss→populate→hit is exercised through the same code
// path as production. MIRROR_USER/MIRROR_SECRET are supplied here as
// bindings (both are required secrets — see wrangler.jsonc — with no
// committed value of their own); all other config comes from wrangler.jsonc.
// Outbound upstream fetches are intercepted via vi.spyOn(globalThis, "fetch")
// in the test file — no real network calls.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MIRROR_USER: "test_user",
          MIRROR_SECRET: "test_secret",
        },
        // Real local R2 bucket so tests assert persisted objects directly.
        r2Buckets: ["MIRROR"],
      },
    }),
  ],
  test: {
    // Matches the repo-wide flaky-absorption policy: a single CI flake gets
    // retried instead of failing the build, while a genuinely broken test
    // still fails every attempt.
    retry: 2,
    coverage: {
      // workerd has no node:inspector, so the v8 provider can't instrument it —
      // istanbul instruments at transform time instead. See
      // cloudflare/workers-sdk#5266.
      provider: "istanbul",
      reporter: ["text", "text-summary"],
      include: ["src/index.ts", "src/logger.ts"],
      // Ratchet a small margin below the achieved level — raise as coverage
      // grows, never lower to make a red build pass. (The only uncovered lines
      // are the defensive 500 guard for an object vanishing immediately after
      // put(), which can't be exercised in a test.)
      thresholds: {
        statements: 92,
        branches: 80,
        functions: 95,
        lines: 94,
      },
    },
  },
});
