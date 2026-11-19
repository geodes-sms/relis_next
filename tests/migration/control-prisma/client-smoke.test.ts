import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComposeProject,
  type ResolvedComposePersistence,
  assertProvisioningSafety,
  cleanupDisposableTargets,
  composeExec,
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

// Sub-issue 03.04 (corrective pass) — real evidence that the GENERATED
// Control Prisma client (packages/database/generated/control-client, the
// prescribed `@prisma/adapter-pg` driver adapter) actually connects,
// writes, and reads against a real, migrated PostgreSQL database.
// constraints.test.ts proves the raw SQL constraints exist via `psql`;
// this file proves the generated CLIENT can exercise them too — a file
// existing on disk, or a successful `psql` query, does not prove
// `new PrismaClient({ adapter })` itself works.
//
// Postgres is never published to the host (see docker-compose.yml's
// `postgres` service — deliberately no `ports:` block, per the prior
// port-hardening sub-issue). Rather than reopening that hardening to let
// a host-side test process reach it directly, every check below runs
// INSIDE the existing `migrate-control` service's own image/network via
// `composeRun`, invoking the package's own `generate:control` and
// `smoke:control` scripts (packages/database/scripts/control-client-smoke.mts)
// exactly as a real consumer would — no new Dockerfile, no new exposed
// port, no change to the prior hardening decision.
//
// `smoke:control`'s own script is the one place that imports the
// generated client and the driver adapter; this test file (and
// everything else in 03.04/03.05) still exposes nothing public from
// `@relis/database`'s own `src/index.ts` — that remains `export {};`
// (03.05's scope), and no repository layer is introduced here.
//
// SAFETY/ISOLATION — identical guarded provisioning/cleanup lifecycle and
// explicit-configuration discipline as apply-migration.test.ts/
// constraints.test.ts (see those files' own header comments) — not a
// parallel implementation.
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
    "[migration/control-prisma/client-smoke.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon is " +
      "reachable) in this environment. Real Prisma-Client evidence was NOT produced by this run; this is a " +
      "reported blocker, not a pass.",
  );
}

const POSTGRES_USER = "relis";
const POSTGRES_PASSWORD = "relis-disposable-test-only";
const POSTGRES_DB = "relis_control";
const PROJECT_TEST_DB_NAME = "relis_project_client_smoke_test";
const EPHEMERAL_PORTS = { NGINX_HTTP_PORT: "0", MAILHOG_UI_PORT: "0", SEAWEEDFS_S3_PORT: "0" };

const GENERATE_AND_RUN = (mode: string) => ["sh", "-c", `pnpm --filter @relis/database run generate:control && pnpm --filter @relis/database run smoke:control ${mode}`];

interface SmokeResult {
  ok: boolean;
  mode: string;
  [key: string]: unknown;
}

function parseSmokeResult(stdout: string): SmokeResult {
  const line = stdout.split("\n").find((entry) => entry.includes("SMOKE_RESULT:"));
  if (!line) {
    throw new Error(`No SMOKE_RESULT line found in stdout:\n${stdout}`);
  }
  return JSON.parse(line.slice(line.indexOf("SMOKE_RESULT:") + "SMOKE_RESULT:".length)) as SmokeResult;
}

describe.runIf(dockerAvailable)("Control Prisma client — real write/read and negative evidence", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-control-client-smoke"), composeFile, cwd: repoRoot };
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
    const migrateExitCode = await waitForExitCode(project, "migrate-control", { env: composeEnv });
    if (migrateExitCode !== 0) {
      throw new Error(`migrate-control did not exit 0 (exit ${migrateExitCode}) — cannot smoke-test the client against an unmigrated database`);
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

    if (problems.length > 0) {
      throw new Error(`Cleanup did not complete correctly:\n- ${problems.join("\n- ")}`);
    }
  }, 300000);

  it("provisions a genuinely disposable project (no external volumes, nothing pre-existing under these names)", () => {
    expect(resolved.externalVolumes).toEqual([]);
    for (const volumeName of Object.values(resolved.volumeNames)) {
      expect(baselineVolumeNames).not.toContain(volumeName);
    }
  });

  it("writes and reads back a real row (and a relation) through the generated client + adapter-pg", async () => {
    const result = await composeRun(project, "migrate-control", composeEnv, { command: GENERATE_AND_RUN("write-read"), timeoutMs: 120000 });
    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const smoke = parseSmokeResult(result.stdout);
    expect(smoke.ok, JSON.stringify(smoke)).toBe(true);
    expect(smoke.ownerUserId).toBe("smoke-client-user");
  }, 120000);

  it("rejects a foreign-key violation with Prisma's own P2003 error code (not merely any failure)", async () => {
    const result = await composeRun(project, "migrate-control", composeEnv, { command: GENERATE_AND_RUN("fk-violation"), timeoutMs: 120000 });
    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const smoke = parseSmokeResult(result.stdout);
    expect(smoke.ok, JSON.stringify(smoke)).toBe(true);
    expect(smoke.errorCode).toBe("P2003");
  }, 120000);

  it("rejects a required-field violation with the specific NOT NULL constraint (not merely any failure)", async () => {
    const result = await composeRun(project, "migrate-control", composeEnv, {
      command: GENERATE_AND_RUN("required-field-violation"),
      timeoutMs: 120000,
    });
    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const smoke = parseSmokeResult(result.stdout);
    expect(smoke.ok, JSON.stringify(smoke)).toBe(true);
    expect(String(smoke.message)).toMatch(/null value in column "username".*violates not-null constraint/is);
  }, 120000);

  it("preserves client-written data across a repeated (idempotent) migrate deploy", async () => {
    const redeploy = await composeRun(project, "migrate-control", composeEnv, {
      command: ["sh", "-c", "pnpm --filter @relis/config build && pnpm --filter @relis/database run migrate control"],
      timeoutMs: 120000,
    });
    expect(redeploy.exitCode, redeploy.stderr).toBe(0);

    const result = await composeRun(project, "migrate-control", composeEnv, { command: GENERATE_AND_RUN("read-marker"), timeoutMs: 120000 });
    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const smoke = parseSmokeResult(result.stdout);
    expect(smoke.ok, JSON.stringify(smoke)).toBe(true);
    expect(smoke.found).toBe(true);
  }, 180000);

  it("still does NOT create any Control table in the separate project-test database after real client writes", async () => {
    const controlOnlyTables = ["users", "projects", "memberships"];
    for (const table of controlOnlyTables) {
      const check = await composeExec(
        project,
        "postgres",
        ["psql", "-U", POSTGRES_USER, "-d", PROJECT_TEST_DB_NAME, "-tAc", `SELECT to_regclass('public.${table}') IS NULL;`],
        { env: composeEnv },
      );
      expect(check.stdout.trim(), `Control table "${table}" leaked into the project database — stderr: ${check.stderr}`).toBe("t");
    }
  });
});

describe.skipIf(dockerAvailable)("Control Prisma client — real write/read and negative evidence (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
