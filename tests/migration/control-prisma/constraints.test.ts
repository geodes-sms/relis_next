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

// Sub-issue 03.04 — positive/negative evidence for the approved keys,
// uniqueness scopes, required fields, relations, and structural Owner
// invariants recorded in docs/architecture/control-database-contracts.md
// §8 and docs/architecture/control-database-role-decision.md. Exercises
// the REAL PostgreSQL constraints (not a mock, not Prisma Client) via
// `psql` against a disposable database the committed migration has just
// been applied to.
//
// SAFETY/ISOLATION — see apply-migration.test.ts's own header comment for
// the full rationale; this file reuses the identical guarded
// provisioning/cleanup lifecycle and the same explicit-configuration
// discipline (never the ambient environment), not a parallel
// implementation.
//
// Scope note: this exercises a REPRESENTATIVE set of the schema's
// invariants, not an exhaustive one — chosen to match this sub-issue's
// explicit verification requirement ("approved keys, uniqueness scopes,
// required fields, relations, and structural Owner invariants"). Every
// foreign key's onDelete behavior is not individually re-tested here;
// Restrict and Cascade are each demonstrated once, as representative
// cases of the two behaviors used throughout the schema (see
// schema.prisma's own per-field comments for which behavior each
// remaining relation uses and why). Prisma-Client-level negative
// evidence (foreign-key and required-field violations surfaced through
// the generated client, not raw SQL) lives in client-smoke.test.ts.
//
// Concurrency note: the uniqueness checks below are SEQUENTIAL (insert,
// then a second conflicting insert) — they prove the constraint exists
// and rejects a conflict, relying on PostgreSQL's own well-established
// index-level atomicity for concurrent writers rather than re-verifying
// that lower-level engine guarantee with an actual concurrent-transaction
// race in this suite.
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
    "[migration/control-prisma/constraints.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon is " +
      "reachable) in this environment. Real constraint evidence was NOT produced by this run; this is a reported " +
      "blocker, not a pass.",
  );
}

// Explicit disposable-test configuration — never read from the ambient
// environment; always passed as `composeEnv` to every Compose invocation.
const POSTGRES_USER = "relis";
const POSTGRES_PASSWORD = "relis-disposable-test-only";
const POSTGRES_DB = "relis_control";
const PROJECT_TEST_DB_NAME = "relis_project_constraints_test";
const EPHEMERAL_PORTS = { NGINX_HTTP_PORT: "0", MAILHOG_UI_PORT: "0", SEAWEEDFS_S3_PORT: "0" };

describe.runIf(dockerAvailable)("Control schema — real PostgreSQL constraint evidence", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-control-constraints"), composeFile, cwd: repoRoot };
  const composeEnv = { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, PROJECT_TEST_DB_NAME, ...EPHEMERAL_PORTS };

  let baselineVolumeNames: string[] = [];
  let resolved: ResolvedComposePersistence;

  async function psql(sql: string): Promise<SpawnResult> {
    // `{ env: composeEnv }` is required here — without it, `docker compose
    // exec` would resolve its own Compose configuration (which service
    // belongs to this project, etc.) using ambient/default values instead
    // of the ones this suite actually provisioned PostgreSQL with. See
    // composeRun's doc comment in @relis/test-utils for the full
    // interpolation-vs-container-override distinction.
    return composeExec(project, "postgres", ["psql", "-v", "ON_ERROR_STOP=1", "-U", POSTGRES_USER, "-d", POSTGRES_DB, "-c", sql], {
      env: composeEnv,
    });
  }

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
      throw new Error(`migrate-control did not exit 0 (exit ${migrateExitCode}) — cannot test constraints against an unmigrated database`);
    }

    const createBaseUser = await psql(
      `INSERT INTO "users" ("id","username","email","createdAt","updatedAt") VALUES ('base-user','base-user','base-user@example.test',now(),now());`,
    );
    if (createBaseUser.exitCode !== 0) {
      throw new Error(`failed to create baseline test user: ${createBaseUser.stderr}`);
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

  it("rejects a duplicate user email (users_email_key)", async () => {
    const first = await psql(
      `INSERT INTO "users" ("id","username","email","createdAt","updatedAt") VALUES ('dup-email-1','dup-email-1','dup@example.test',now(),now());`,
    );
    expect(first.exitCode, first.stderr).toBe(0);

    const second = await psql(
      `INSERT INTO "users" ("id","username","email","createdAt","updatedAt") VALUES ('dup-email-2','dup-email-2','dup@example.test',now(),now());`,
    );
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toMatch(/duplicate key value violates unique constraint "users_email_key"/);
  });

  it("allows at most one ACTIVE membership per (projectId,userId), but allows re-adding after REMOVED (memberships_active_project_user_key)", async () => {
    const project1 = await psql(
      `INSERT INTO "projects" ("id","title","shortName","createdByUserId","createdAt","updatedAt") VALUES ('proj-membership','Membership Test Project','membership-test-project','base-user',now(),now());`,
    );
    expect(project1.exitCode, project1.stderr).toBe(0);

    const member1 = await psql(
      `INSERT INTO "users" ("id","username","email","createdAt","updatedAt") VALUES ('member-1','member-1','member-1@example.test',now(),now());`,
    );
    expect(member1.exitCode, member1.stderr).toBe(0);

    const firstMembership = await psql(
      `INSERT INTO "memberships" ("id","projectId","userId","role","status","createdAt","updatedAt") VALUES ('m1','proj-membership','member-1','PROJECT_MANAGER','ACTIVE',now(),now());`,
    );
    expect(firstMembership.exitCode, firstMembership.stderr).toBe(0);

    const conflictingMembership = await psql(
      `INSERT INTO "memberships" ("id","projectId","userId","role","status","createdAt","updatedAt") VALUES ('m1-dup','proj-membership','member-1','REVIEWER','ACTIVE',now(),now());`,
    );
    expect(conflictingMembership.exitCode).not.toBe(0);
    expect(conflictingMembership.stderr).toMatch(/duplicate key value violates unique constraint "memberships_active_project_user_key"/);

    const removeFirst = await psql(`UPDATE "memberships" SET "status" = 'REMOVED' WHERE "id" = 'm1';`);
    expect(removeFirst.exitCode, removeFirst.stderr).toBe(0);

    const readd = await psql(
      `INSERT INTO "memberships" ("id","projectId","userId","role","status","createdAt","updatedAt") VALUES ('m1-readded','proj-membership','member-1','REVIEWER','ACTIVE',now(),now());`,
    );
    expect(readd.exitCode, readd.stderr).toBe(0);
  });

  it("allows at most one PROJECT_OWNER membership per project (memberships_single_owner_per_project_key)", async () => {
    const proj = await psql(
      `INSERT INTO "projects" ("id","title","shortName","createdByUserId","createdAt","updatedAt") VALUES ('proj-owner','Owner Test Project','owner-test-project','base-user',now(),now());`,
    );
    expect(proj.exitCode, proj.stderr).toBe(0);

    const ownerA = await psql(
      `INSERT INTO "users" ("id","username","email","createdAt","updatedAt") VALUES ('owner-a','owner-a','owner-a@example.test',now(),now());`,
    );
    expect(ownerA.exitCode, ownerA.stderr).toBe(0);
    const ownerB = await psql(
      `INSERT INTO "users" ("id","username","email","createdAt","updatedAt") VALUES ('owner-b','owner-b','owner-b@example.test',now(),now());`,
    );
    expect(ownerB.exitCode, ownerB.stderr).toBe(0);

    const firstOwner = await psql(
      `INSERT INTO "memberships" ("id","projectId","userId","role","status","createdAt","updatedAt") VALUES ('owner-m1','proj-owner','owner-a','PROJECT_OWNER','ACTIVE',now(),now());`,
    );
    expect(firstOwner.exitCode, firstOwner.stderr).toBe(0);

    const secondOwner = await psql(
      `INSERT INTO "memberships" ("id","projectId","userId","role","status","createdAt","updatedAt") VALUES ('owner-m2','proj-owner','owner-b','PROJECT_OWNER','ACTIVE',now(),now());`,
    );
    expect(secondOwner.exitCode).not.toBe(0);
    expect(secondOwner.stderr).toMatch(/duplicate key value violates unique constraint "memberships_single_owner_per_project_key"/);
  });

  it("allows at most one INVITED invitation per (projectId,normalizedEmail), but allows a new one after CANCELLED (invitations_active_project_email_key)", async () => {
    const proj = await psql(
      `INSERT INTO "projects" ("id","title","shortName","createdByUserId","createdAt","updatedAt") VALUES ('proj-invite','Invite Test Project','invite-test-project','base-user',now(),now());`,
    );
    expect(proj.exitCode, proj.stderr).toBe(0);

    const firstInvite = await psql(
      `INSERT INTO "invitations" ("id","projectId","normalizedEmail","proposedRole","status","tokenHash","expiresAt","inviterUserId","sentAt") VALUES ('inv-1','proj-invite','invitee@example.test','REVIEWER','INVITED','hash-1',now() + interval '7 days','base-user',now());`,
    );
    expect(firstInvite.exitCode, firstInvite.stderr).toBe(0);

    const conflictingInvite = await psql(
      `INSERT INTO "invitations" ("id","projectId","normalizedEmail","proposedRole","status","tokenHash","expiresAt","inviterUserId","sentAt") VALUES ('inv-1-dup','proj-invite','invitee@example.test','GUEST','INVITED','hash-1-dup',now() + interval '7 days','base-user',now());`,
    );
    expect(conflictingInvite.exitCode).not.toBe(0);
    expect(conflictingInvite.stderr).toMatch(/duplicate key value violates unique constraint "invitations_active_project_email_key"/);

    const cancelFirst = await psql(`UPDATE "invitations" SET "status" = 'CANCELLED' WHERE "id" = 'inv-1';`);
    expect(cancelFirst.exitCode, cancelFirst.stderr).toBe(0);

    const reinvite = await psql(
      `INSERT INTO "invitations" ("id","projectId","normalizedEmail","proposedRole","status","tokenHash","expiresAt","inviterUserId","sentAt") VALUES ('inv-1-reinvited','proj-invite','invitee@example.test','GUEST','INVITED','hash-1-reinvited',now() + interval '7 days','base-user',now());`,
    );
    expect(reinvite.exitCode, reinvite.stderr).toBe(0);
  });

  it("rejects an invitation proposing PROJECT_OWNER (invitations_proposed_role_not_owner_check)", async () => {
    const attempt = await psql(
      `INSERT INTO "invitations" ("id","projectId","normalizedEmail","proposedRole","status","tokenHash","expiresAt","inviterUserId","sentAt") VALUES ('inv-owner-attempt','proj-invite','owner-attempt@example.test','PROJECT_OWNER','INVITED','hash-owner-attempt',now() + interval '7 days','base-user',now());`,
    );
    expect(attempt.exitCode).not.toBe(0);
    expect(attempt.stderr).toMatch(/violates check constraint "invitations_proposed_role_not_owner_check"/);
  });

  it("restricts deleting a User referenced by a Membership (onDelete: Restrict)", async () => {
    const deleteAttempt = await psql(`DELETE FROM "users" WHERE "id" = 'member-1';`);
    expect(deleteAttempt.exitCode).not.toBe(0);
    expect(deleteAttempt.stderr).toMatch(/violates foreign key constraint/);
  });

  it("cascades deleting a Session when its User is deleted (onDelete: Cascade)", async () => {
    const cascadeUser = await psql(
      `INSERT INTO "users" ("id","username","email","createdAt","updatedAt") VALUES ('cascade-user','cascade-user','cascade-user@example.test',now(),now());`,
    );
    expect(cascadeUser.exitCode, cascadeUser.stderr).toBe(0);

    const session = await psql(
      `INSERT INTO "sessions" ("id","userId","createdAt","expiresAt") VALUES ('session-1','cascade-user',now(),now() + interval '1 day');`,
    );
    expect(session.exitCode, session.stderr).toBe(0);

    const deleteUser = await psql(`DELETE FROM "users" WHERE "id" = 'cascade-user';`);
    expect(deleteUser.exitCode, deleteUser.stderr).toBe(0);

    const sessionGone = await composeExec(
      project,
      "postgres",
      ["psql", "-U", POSTGRES_USER, "-d", POSTGRES_DB, "-tAc", `SELECT count(*) FROM "sessions" WHERE "id" = 'session-1';`],
      { env: composeEnv },
    );
    expect(sessionGone.stdout.trim()).toBe("0");
  });
});

describe.skipIf(dockerAvailable)("Control schema — real PostgreSQL constraint evidence (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
