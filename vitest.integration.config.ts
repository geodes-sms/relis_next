import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
    // Startup tests spawn real dev/build processes; keep them sequential
    // to avoid CPU contention and port collisions.
    fileParallelism: false,
  },
});
