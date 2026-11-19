import { defineConfig, devices } from "@playwright/test";

/**
 * Prescribed e2e framework per context/stack.yml ("end_to_end:
 * Playwright"). Scope for this sub-issue is a single real-browser check
 * under tests/e2e/docker-compose/ (see
 * docs/architecture/docker-compose-stack.md) — it brings up and tears
 * down its own isolated Compose project directly in the spec file
 * (reusing packages/test-utils/src/docker-compose.ts, the same helpers
 * tests/integration/docker-compose/ uses), rather than relying on
 * Playwright's own `webServer` option, since the "server" here is a
 * multi-container Compose stack, not a single `npm run dev`.
 *
 * No `webServer` is configured for the same reason. Run with:
 *   pnpm run test:e2e
 *
 * Requires: a reachable Docker daemon (the spec itself skips, reporting
 * why, when absent — see isDockerAvailableSync) AND Playwright's browser
 * binaries actually installed (`pnpm exec playwright install chromium`
 * — NOT run as part of this task; installing that is system-level
 * software requiring separate authorization, not something this
 * repository's tooling does automatically on your behalf).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
