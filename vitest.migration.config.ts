import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/migration/**/*.test.ts"],
    testTimeout: 180000,
    hookTimeout: 300000,
    // Each file provisions its own disposable Compose project; keep them
    // sequential to avoid CPU/port contention, matching
    // vitest.integration.config.ts's own rationale.
    fileParallelism: false,
  },
});
