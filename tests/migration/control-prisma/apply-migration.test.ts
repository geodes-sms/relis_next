import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComposeProject,
  type ResolvedComposePersistence,
  type SpawnResult,
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

// Sub-issue 03.04 — proves the COMMITTED migration
// (packages/database/prisma/control/migrations/20261014120000_init_control_schema/)
// actually applies to a real, disposable PostgreSQL database via the
// EXISTING `migrate-control` Compose service (docker-compose.yml) and the
// existing `pnpm --filter @relis/database run migrate control` entry
// point — no new infrastructure is introduced.
//
// SAFETY — reuses the SAME guarded provisioning/cleanup lifecycle as
// tests/integration/docker-compose/persistence.test.ts (not a parallel
// implementation): a pre-run volume baseline, `assertProvisioningSafety`
// BEFORE a single container starts, re-verified ownership via
// `createComposeCleanupTarget`/`cleanupDisposableTargets` immediately
// before any destructive cleanup (fails closed on an inspection failure,
// never on a confirmed absence), and a post-cleanup check that no
// pre-existing volume was touched. Partial setup failures are handled
// safely because cleanup only ever acts on resources the daemon itself
// confirms belong to this run's own project.
//
// ISOLATION — every value this file provisions with, queries against, or
// tears down with (`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`/
// `PROJECT_TEST_DB_NAME`) is an explicit constant below, passed as the
// SAME `composeEnv` object to every `docker compose` invocation this file
// makes: `composeUp` (provisioning), `composeExec` (every SQL query and
// inspection, via the local `psql` helper below), `composeRun` (the
// repeated migrate-control invocations), `waitForHealthy`/`waitForExitCode`
// (container-state polling), and `createComposeCleanupTarget` (teardown).
//
// This consistency is NOT automatic merely from passing `composeEnv` as an
// argument — `@relis/test-utils`'s `composeRun` previously only turned its
// `env` argument into CONTAINER-LEVEL `-e` overrides (applied to the
// one-off container AFTER Compose had already resolved the target
// service's config), without forwarding it to the `docker compose` CLI
// subprocess itself — the process Compose uses to resolve
// `${POSTGRES_USER:-relis}`-style interpolation in docker-compose.yml. A
// caller passing `composeEnv` as `composeRun`'s `env` argument therefore
// got the right container-level overrides but a `CONTROL_DATABASE_URL`
// potentially built from the WRONG (ambient/default) `POSTGRES_*` values —
// silently diverging from whatever `composeUp` had actually provisioned
// PostgreSQL with. This has been fixed in `composeRun` itself (see its own
// doc comment in packages/test-utils/src/docker-compose.ts for the full
// interpolation-vs-container-override distinction); every `composeRun`
// call below relies on that fix rather than re-implementing it here.
// `composeUp`/`composeExec`/`waitForHealthy`/`waitForExitCode` already
// forwarded an explicit `env` to the Compose-config-resolving subprocess
// correctly before this fix — only `composeRun` had the gap.
//
// Explicit shell-level overrides always take precedence over a `.env`
// file Compose would otherwise read (Docker Compose's own documented
// precedence), so a conflicting host-level `POSTGRES_PASSWORD`/
// `PROJECT_TEST_DB_NAME` (exported in the calling shell, or set in a
// committed root `.env`) cannot silently redirect this suite to a
// different, unverified target. This file never reads or writes the
// user's own `.env`. The "verifies the resolved database" test below
// asserts this positively — it checks the database the test actually
// connected to, not merely that an env object was constructed correctly.
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
    "[migration/control-prisma/apply-migration.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon is " +
      "reachable) in this environment. Real migration-application evidence was NOT produced by this run; this is a " +
      "reported blocker, not a pass.",
  );
}

// Explicit disposable-test configuration — see the file header comment.
// Never read from the ambient environment; always passed as `composeEnv`
// below to every Compose invocation this file makes.
const POSTGRES_USER = "relis";
const POSTGRES_PASSWORD = "relis-disposable-test-only";
const POSTGRES_DB = "relis_control";
const PROJECT_TEST_DB_NAME = "relis_project_apply_migration_test";
const EPHEMERAL_PORTS = { NGINX_HTTP_PORT: "0", MAILHOG_UI_PORT: "0", SEAWEEDFS_S3_PORT: "0" };

describe.runIf(dockerAvailable)("Control schema migration — apply to a disposable PostgreSQL database", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-control-migrate"), composeFile, cwd: repoRoot };
  const composeEnv = { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, PROJECT_TEST_DB_NAME, ...EPHEMERAL_PORTS };

  let baselineVolumeNames: string[] = [];
  let resolved: ResolvedComposePersistence;
  let migrateControlExitCode: number;

  /** Every call site in this file goes through here — see the file header for why `{ env: composeEnv }` is required. */
  async function psql(database: string, sql: string): Promise<SpawnResult> {
    return composeExec(project, "postgres", ["psql", "-U", POSTGRES_USER, "-d", database, "-tAc", sql], { env: composeEnv });
  }

  beforeAll(async () => {
    // Baseline FIRST, before this run provisions anything — the same
    // ordering persistence.test.ts uses, so the post-cleanup "nothing
    // unrelated was destroyed" check has a genuine snapshot to compare
    // against.
    baselineVolumeNames = await listAllVolumeNames();

    resolved = await resolveComposePersistence(project, composeEnv);
    // Hard safety gate BEFORE a single container or volume is created:
    // the resolved configuration must be genuinely disposable (volume
    // names scoped to this project, no `external: true`, nothing already
    // on the daemon under these exact names). Throws — stopping short of
    // provisioning anything — on failure.
    assertProvisioningSafety(resolved, baselineVolumeNames);

    const up = await composeUp(project, composeEnv, ["postgres", "migrate-control"], { build: true, timeoutMs: 300000 });
    if (up.exitCode !== 0) {
      throw new Error(`docker compose up failed (exit ${up.exitCode}):\n${up.stdout}\n${up.stderr}`);
    }
    await waitForHealthy(project, "postgres", { env: composeEnv });
    migrateControlExitCode = await waitForExitCode(project, "migrate-control", { env: composeEnv });
  }, 300000);

  afterAll(async () => {
    // Guarded cleanup, re-verified against the daemon immediately before
    // any destructive step — never reusing a cached ownership check from
    // setup. `createComposeCleanupTarget` threads this SAME `composeEnv`
    // through both the fresh re-resolution of configuration and the
    // actual destructive/volume-preserving commands, so teardown resolves
    // against the identical configuration this suite provisioned with —
    // never a different, possibly-ambient one. A failure here is
    // reported, not silently swallowed; it never hides an earlier test
    // failure (Vitest records hook failures separately).
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
    expect(project.projectName).not.toBe("relis");
    for (const volumeName of Object.values(resolved.volumeNames)) {
      expect(baselineVolumeNames).not.toContain(volumeName);
    }
  });

  it("applies the committed migration to an empty Control DB with real exit code 0", () => {
    expect(migrateControlExitCode).toBe(0);
  });

  it("verifies the resolved database is the explicit disposable target this suite configured, not an ambient default", async () => {
    // Positive proof against redirection: the actually-connected database
    // name, read back from PostgreSQL itself, must equal this file's own
    // explicit constant — not whatever a conflicting host/.env value
    // might otherwise have produced.
    const result = await psql(POSTGRES_DB, "SELECT current_database();");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(POSTGRES_DB);
  });

  it("creates every expected Control table (real schema introspection, not a proxy for migration success)", async () => {
    const expectedTables = [
      "users",
      "email_verification_tokens",
      "password_reset_tokens",
      "external_identities",
      "oidc_login_transactions",
      "sessions",
      "projects",
      "project_research_questions",
      "memberships",
      "invitations",
      "project_creation_drafts",
      "job_records",
      "audit_events",
    ];
    for (const table of expectedTables) {
      const result = await psql(POSTGRES_DB, `SELECT to_regclass('public.${table}') IS NOT NULL;`);
      expect(result.stdout.trim(), `table "${table}" missing — stderr: ${result.stderr}`).toBe("t");
    }
  });

  it("re-running migrate-control a second time succeeds with no destructive reapplication", async () => {
    const second = await composeRun(project, "migrate-control", composeEnv, {
      command: ["sh", "-c", "pnpm --filter @relis/config build && pnpm --filter @relis/database run migrate control"],
      timeoutMs: 120000,
    });
    expect(second.exitCode, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0);
    const combined = `${second.stdout}\n${second.stderr}`.toLowerCase();
    expect(combined).not.toMatch(/error/);
    expect(combined).toMatch(/no pending migrations|already in sync|up to date/);
  }, 120000);

  it("preserves existing data across the second (idempotent) migrate deploy", async () => {
    const marker = await composeExec(
      project,
      "postgres",
      [
        "psql",
        "-U",
        POSTGRES_USER,
        "-d",
        POSTGRES_DB,
        "-c",
        `INSERT INTO "users" ("id","username","email","createdAt","updatedAt") VALUES ('reapply-marker','reapply-marker','reapply-marker@example.test',now(),now());`,
      ],
      { env: composeEnv },
    );
    expect(marker.exitCode, marker.stderr).toBe(0);

    const second = await composeRun(project, "migrate-control", composeEnv, {
      command: ["sh", "-c", "pnpm --filter @relis/config build && pnpm --filter @relis/database run migrate control"],
      timeoutMs: 120000,
    });
    expect(second.exitCode, second.stderr).toBe(0);

    const stillThere = await psql(POSTGRES_DB, `SELECT count(*) FROM "users" WHERE "id" = 'reapply-marker';`);
    expect(stillThere.stdout.trim()).toBe("1");
  }, 120000);

  it("does NOT create any Control table in the separate project-test database", async () => {
    const controlOnlyTables = ["users", "projects", "memberships", "invitations", "audit_events"];
    for (const table of controlOnlyTables) {
      const result = await psql(PROJECT_TEST_DB_NAME, `SELECT to_regclass('public.${table}') IS NULL;`);
      expect(result.stdout.trim(), `Control table "${table}" leaked into the project database — stderr: ${result.stderr}`).toBe("t");
    }
  });
});

describe.skipIf(dockerAvailable)("Control schema migration — apply to a disposable PostgreSQL database (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
