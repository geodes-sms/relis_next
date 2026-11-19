import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ComposeProject,
  type ResolvedComposePersistence,
  assertProvisioningSafety,
  cleanupDisposableTargets,
  composeRun,
  composeUp,
  createComposeCleanupTarget,
  isDockerAvailableSync,
  listAllVolumeNames,
  listVolumeNamesByComposeProject,
  resolveComposePersistence,
  uniqueProjectName,
  waitForExitCode,
  waitForHealthy,
} from "@relis/test-utils";

// Regression coverage for the `composeRun` fix (see its own doc comment in
// packages/test-utils/src/docker-compose.ts): previously, `composeRun`'s
// `env` argument only became CONTAINER-LEVEL `-e` overrides — it was never
// forwarded to the `docker compose` CLI subprocess itself, so COMPOSE
// INTERPOLATION (`${POSTGRES_USER:-relis}`-style substitution used to
// build `migrate-control`'s own `CONTROL_DATABASE_URL`) silently fell back
// to whatever ambient/default values happened to be present — independent
// of, and potentially different from, the explicit values a caller used to
// actually provision PostgreSQL.
//
// This file proves the fix against REAL Docker/PostgreSQL, not merely
// that the right JS object is constructed: a conflicting value is
// genuinely exported into this test PROCESS'S OWN environment (standing
// in for a developer's shell or a committed root `.env`), and the
// assertion is a real authentication outcome against a real PostgreSQL
// server — not an inspection of what `runToCompletion` was called with.
// (persistence-cleanup-env.test.ts covers the analogous
// `createComposeCleanupTarget` wiring with a fast, explicitly-mocked unit
// test of its own — appropriate there because that claim is about which
// JS object reaches an internal call, not about Compose's own
// interpolation semantics or real container behavior.)
//
// Requires the `docker` CLI and a reachable daemon; skips (never mocks)
// when absent.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const composeFile = path.join(repoRoot, "docker-compose.yml");

const dockerAvailable = isDockerAvailableSync();

if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[docker-compose/compose-run-env-consistency.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon " +
      "is reachable) in this environment. No real interpolation/override evidence was produced by this run; this is " +
      "a reported blocker, not a pass.",
  );
}

const POSTGRES_USER = "relis";
const POSTGRES_PASSWORD = "explicit-correct-password-only";
const POSTGRES_DB = "relis_control";
const PROJECT_TEST_DB_NAME = "relis_project_env_consistency_test";
const EPHEMERAL_PORTS = { NGINX_HTTP_PORT: "0", MAILHOG_UI_PORT: "0", SEAWEEDFS_S3_PORT: "0" };
const MIGRATE_COMMAND = ["sh", "-c", "pnpm --filter @relis/config build && pnpm --filter @relis/database run migrate control"];

describe.runIf(dockerAvailable)("composeRun — explicit configuration wins over conflicting ambient/default settings (real Docker)", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-compose-run-env"), composeFile, cwd: repoRoot };
  const composeEnv = { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, PROJECT_TEST_DB_NAME, ...EPHEMERAL_PORTS };

  let baselineVolumeNames: string[] = [];
  let resolved: ResolvedComposePersistence;

  beforeAll(async () => {
    baselineVolumeNames = await listAllVolumeNames();
    resolved = await resolveComposePersistence(project, composeEnv);
    assertProvisioningSafety(resolved, baselineVolumeNames);

    const up = await composeUp(project, composeEnv, ["postgres", "migrate-control"], { build: true, timeoutMs: 300000 });
    if (up.exitCode !== 0) {
      throw new Error(`docker compose up failed (exit ${up.exitCode}):\n${up.stdout}\n${up.stderr}`);
    }
    await waitForHealthy(project, "postgres", { env: composeEnv });
    // Warms the Prisma/pnpm cold-start cost (image build, schema-engine
    // resolution, `@relis/config` build) into this generously-timed
    // beforeAll, same as apply-migration.test.ts's own beforeAll — the
    // later `composeRun` invocations below are then a WARM second run,
    // fast enough for an ordinary per-test timeout.
    const warmupExitCode = await waitForExitCode(project, "migrate-control", { env: composeEnv, timeoutMs: 180000 });
    if (warmupExitCode !== 0) {
      throw new Error(`warm-up migrate-control did not exit 0 (exit ${warmupExitCode}) — cannot test env consistency against an unmigrated database`);
    }
  }, 300000);

  afterAll(async () => {
    const target = await createComposeCleanupTarget(project, composeEnv, baselineVolumeNames);
    const [outcome] = await cleanupDisposableTargets([target]);

    const survivors = new Set(await listAllVolumeNames());
    const destroyedPreexisting = baselineVolumeNames.filter((name) => !survivors.has(name));
    const remainingLabeled = await listVolumeNamesByComposeProject(project);

    const problems: string[] = [];
    if (outcome.error) problems.push(`cleanup of "${outcome.label}" failed: ${outcome.error}`);
    if (outcome.volumesRequiringManualInspection.length > 0) {
      problems.push(
        `volume(s) not deleted — ownership could not be established: ` +
          outcome.volumesRequiringManualInspection.map((v) => `${v.name} (${v.reason})`).join("; "),
      );
    }
    if (remainingLabeled.length > 0) problems.push(`volumes still labelled for this project after cleanup: ${remainingLabeled.join(", ")}`);
    if (destroyedPreexisting.length > 0) problems.push(`pre-existing volumes no longer present (MUST NOT happen): ${destroyedPreexisting.join(", ")}`);
    if (problems.length > 0) throw new Error(`Cleanup did not complete correctly:\n- ${problems.join("\n- ")}`);
  }, 300000);

  it("provisions a genuinely disposable project (no external volumes, nothing pre-existing under these names)", () => {
    expect(resolved.externalVolumes).toEqual([]);
    for (const volumeName of Object.values(resolved.volumeNames)) {
      expect(baselineVolumeNames).not.toContain(volumeName);
    }
  });

  describe("real conflicting ambient value in THIS test process's own environment", () => {
    const originalAmbientPassword = process.env.POSTGRES_PASSWORD;

    afterEach(() => {
      // Never leak this simulated conflict into any other test file —
      // restored (or deleted, if it was genuinely unset before) after
      // every test in this block, success or failure.
      if (originalAmbientPassword === undefined) delete process.env.POSTGRES_PASSWORD;
      else process.env.POSTGRES_PASSWORD = originalAmbientPassword;
    });

    it("Compose interpolation uses the explicit composeEnv, not a conflicting ambient POSTGRES_PASSWORD", async () => {
      // Simulates a developer's shell (or a committed root .env) exporting
      // a DIFFERENT password than the one this suite explicitly
      // provisioned PostgreSQL with. If composeRun still forwarded no
      // explicit interpolation env (the bug), `migrate-control`'s own
      // CONTROL_DATABASE_URL would be built from THIS wrong value and
      // authentication against the real, already-running PostgreSQL
      // server (started above with POSTGRES_PASSWORD) would fail.
      process.env.POSTGRES_PASSWORD = "wrong-ambient-password-that-must-not-be-used";

      const result = await composeRun(project, "migrate-control", composeEnv, { command: MIGRATE_COMMAND, timeoutMs: 120000 });
      expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/password authentication failed|P1000/i);
    }, 120000);

    it("negative control: an explicit interpolation env that itself carries the WRONG password still fails authentication (proves this is a real auth outcome, not an always-pass stub)", async () => {
      // Distinguishes composeEnv (interpolation) from a container-level
      // override: here the CORRECT password is passed only as a
      // container-level override, while the INTERPOLATION env
      // (`composeEnv` argument) deliberately carries the wrong one.
      // CONTROL_DATABASE_URL is computed by Compose from the
      // interpolation env BEFORE the container-level override is ever
      // applied, so this must still fail — proving the two mechanisms are
      // genuinely distinct, and that the passing case above is not simply
      // always-green.
      const wrongInterpolationEnv = { ...composeEnv, POSTGRES_PASSWORD: "deliberately-wrong-for-interpolation" };
      const result = await composeRun(project, "migrate-control", composeEnv, { command: MIGRATE_COMMAND, timeoutMs: 120000, composeEnv: wrongInterpolationEnv });
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/password authentication failed|P1000/i);
    }, 120000);
  });

  it("container-level `-e` overrides still reach the started container directly (preserved, pre-existing behavior)", async () => {
    const result = await composeRun(project, "migrate-control", { ...composeEnv, SMOKE_MARKER: "container-level-value" }, {
      command: ["sh", "-c", "printenv SMOKE_MARKER"],
      timeoutMs: 30000,
    });
    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("container-level-value");
  }, 30000);
});

describe.skipIf(dockerAvailable)("composeRun — explicit configuration wins over conflicting ambient/default settings (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
