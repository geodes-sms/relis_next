import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { composeConfigQuiet, isDockerAvailableSync, type ComposeProject, uniqueProjectName } from "@relis/test-utils";

// Proves the root docker-compose.yml resolves cleanly (every image/build
// reference, env-var interpolation, and service reference is valid)
// without starting any container and without printing resolved
// development-only placeholder values (POSTGRES_PASSWORD, SeaweedFS
// credentials, etc.) to the test report — see
// docs/architecture/docker-compose-stack.md and this sub-issue's
// acceptance criterion "Compose configuration resolves without missing
// references or conflicting host ports."
//
// Requires the `docker` CLI and a reachable daemon; skips (never mocks)
// when absent, and reports that explicitly rather than claiming success.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const composeFile = path.join(repoRoot, "docker-compose.yml");

// Computed synchronously at module/collection time — see
// isDockerAvailableSync's own doc comment for why an async check in a
// beforeAll cannot gate describe.runIf/skipIf correctly.
const dockerAvailable = isDockerAvailableSync();

if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[docker-compose/compose-config.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon is reachable) " +
      "in this environment. Static config validation was not performed; this is a reported blocker, not a pass.",
  );
}

describe.runIf(dockerAvailable)("docker compose config", () => {
  let project: ComposeProject;

  beforeAll(() => {
    project = { projectName: uniqueProjectName("relis-config-check"), composeFile, cwd: repoRoot };
  });

  it("resolves the full stack with no missing references or interpolation errors", async () => {
    const result = await composeConfigQuiet(project, {});
    expect(result.exitCode, `docker compose config --quiet failed:\n${result.stderr}`).toBe(0);
    // --quiet prints nothing on success — asserting this directly backs
    // the "without printing resolved secrets" acceptance criterion.
    expect(result.stdout.trim()).toBe("");
  });
});

describe.skipIf(dockerAvailable)("docker compose config (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
