// Real-database check script for sub-issue 03.05's repository layer. Not
// part of the package's public source (never imported from src/, never
// exported from index.ts) — a test-support script only, invoked via
// `pnpm --filter @relis/database run smoke:repositories` from inside the
// existing `migrate-control` Compose service, exactly like
// control-client-smoke.mts (03.04's corrective pass) — same rationale:
// PostgreSQL is never published to the host (docker-compose.yml's
// `postgres` service deliberately has no `ports:` block), so every check
// below runs inside the container/network that already has it, instead
// of reopening that hardening.
//
// Imports ONLY the package's own PUBLIC entry point
// (`createControlRepositories` from "../src/index.ts") for everything
// under test — this is the "representative consumer importing the
// actual public entry point" proof for AC1/AC4, not a relative import of
// an internal implementation file. The one exception is a single,
// explicitly-labeled raw-SQL fixture-setup helper (`seedGhostProject`)
// used ONLY to construct a project with no owner membership — a state
// `createControlRepositories`'s own public API cannot produce (by
// design: it never creates a Project without its Owner membership in the
// same transaction) — needed to exercise `activateProject`'s rollback
// path. That helper is clearly marked as test-fixture setup, not part of
// the repository surface being verified.

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createControlRepositories } from "../src/index.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: unknown;
}

const checks: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, detail });
}

function requireConnectionString(): string {
  const value = process.env.CONTROL_DATABASE_URL;
  if (!value) throw new Error("CONTROL_DATABASE_URL is required to run this script");
  return value;
}

/**
 * TEST-FIXTURE SETUP ONLY — raw SQL, bypassing the repository API
 * entirely, specifically to construct a Project row with NO owner
 * membership (a state the public API can never produce, since
 * `createProjectWithOwner` always creates both in one transaction). This
 * is what lets the `activateProject` rollback check below exist at all;
 * it is not part of what is being verified.
 */
async function seedGhostProject(pool: Pool, id: string, shortName: string, creatorUserId: string): Promise<void> {
  await pool.query(
    'INSERT INTO "projects" ("id","title","shortName","createdByUserId","provisioningState","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,now(),now())',
    [id, "Ghost Project (no owner membership)", shortName, creatorUserId, "PROVISIONING"],
  );
}

async function readProjectProvisioningState(pool: Pool, id: string): Promise<string> {
  const result = await pool.query('SELECT "provisioningState" FROM "projects" WHERE "id" = $1', [id]);
  return result.rows[0]?.provisioningState as string;
}

async function main(): Promise<void> {
  const connectionString = requireConnectionString();
  const repos = createControlRepositories(process.env);
  // A SEPARATE raw pool, used ONLY by `seedGhostProject`/`readProjectProvisioningState`
  // above (fixture setup/verification, never the repository surface under test).
  const fixturePool = new Pool({ connectionString });

  try {
    // --- User repository ---
    const suffix = randomUUID().slice(0, 8);
    const userA = await repos.users.createUser({ username: `smoke-user-a-${suffix}`, email: `smoke-user-a-${suffix}@example.test` });
    record("create-user-success", userA.ok && userA.user.status === "ACTIVE" && userA.user.isApplicationAdministrator === false, userA);

    if (userA.ok) {
      const dupEmail = await repos.users.createUser({ username: `smoke-user-a2-${suffix}`, email: userA.user.email });
      record("create-user-duplicate-email", !dupEmail.ok && dupEmail.error.type === "duplicate_email", dupEmail);

      const dupUsername = await repos.users.createUser({ username: userA.user.username, email: `smoke-user-a3-${suffix}@example.test` });
      record("create-user-duplicate-username", !dupUsername.ok && dupUsername.error.type === "duplicate_username", dupUsername);
    }

    const foundByEmail = userA.ok ? await repos.users.findUserByEmail(userA.user.email) : null;
    record("find-user-by-email", foundByEmail?.id === (userA.ok ? userA.user.id : undefined), foundByEmail);

    // --- Project + Owner repository (atomic creation) ---
    const creator = userA.ok ? userA.user : null;
    const createProjectResult = creator
      ? await repos.projects.createProjectWithOwner({
          title: "Smoke Test Project",
          shortName: `smoke-project-${suffix}`,
          createdByUserId: creator.id,
          idempotencyKey: `smoke-idem-${suffix}`,
        })
      : null;
    record(
      "create-project-with-owner-success",
      Boolean(
        createProjectResult?.ok &&
          createProjectResult.project.provisioningState === "PROVISIONING" &&
          createProjectResult.ownerMembership.role === "PROJECT_OWNER" &&
          createProjectResult.ownerMembership.status === "PENDING_PROVISIONING" &&
          createProjectResult.ownerMembership.userId === creator?.id,
      ),
      createProjectResult,
    );

    if (createProjectResult?.ok && creator) {
      const dupShortName = await repos.projects.createProjectWithOwner({
        title: "Duplicate Short Name",
        shortName: createProjectResult.project.shortName,
        createdByUserId: creator.id,
      });
      record("create-project-duplicate-short-name", !dupShortName.ok && dupShortName.error.type === "duplicate_short_name", dupShortName);

      const dupIdempotency = await repos.projects.createProjectWithOwner({
        title: "Duplicate Idempotency Key",
        shortName: `smoke-project-other-${suffix}`,
        createdByUserId: creator.id,
        idempotencyKey: `smoke-idem-${suffix}`,
      });
      record(
        "create-project-duplicate-idempotency-key",
        !dupIdempotency.ok && dupIdempotency.error.type === "duplicate_idempotency_key",
        dupIdempotency,
      );
    }

    const missingCreator = await repos.projects.createProjectWithOwner({
      title: "Orphan Project",
      shortName: `smoke-project-orphan-${suffix}`,
      createdByUserId: "00000000-0000-0000-0000-000000000000",
    });
    record("create-project-creator-not-found", !missingCreator.ok && missingCreator.error.type === "creator_not_found", missingCreator);

    // --- activateProject: success path ---
    const activateSuccess = createProjectResult?.ok ? await repos.projects.activateProject(createProjectResult.project.id) : null;
    record("activate-project-success", Boolean(activateSuccess?.ok && activateSuccess.project.provisioningState === "READY"), activateSuccess);

    // --- activateProject: not-found path ---
    const activateNotFound = await repos.projects.activateProject("00000000-0000-0000-0000-000000000000");
    record("activate-project-not-found", !activateNotFound.ok && activateNotFound.error.type === "project_not_found", activateNotFound);

    // --- activateProject: TRUE TRANSACTION ROLLBACK proof ---
    // A "ghost" project (no owner membership at all, seeded via raw SQL
    // above — the public API cannot create this state). `activateProject`
    // must: (a) update provisioningState to READY as its first write
    // inside the transaction, (b) then find zero matching owner-membership
    // rows to activate, (c) throw, rolling back (a) too. Verified by
    // re-reading the row with a SEPARATE connection/pool AFTER the call
    // returns — proving the rollback is durable and visible outside the
    // failed transaction, not merely "the in-memory result object said
    // PROVISIONING".
    if (creator) {
      const ghostId = randomUUID();
      await seedGhostProject(fixturePool, ghostId, `smoke-ghost-${suffix}`, creator.id);
      const beforeState = await readProjectProvisioningState(fixturePool, ghostId);
      const activateGhost = await repos.projects.activateProject(ghostId);
      const afterState = await readProjectProvisioningState(fixturePool, ghostId);
      record(
        "activate-project-rolls-back-on-missing-owner-membership",
        beforeState === "PROVISIONING" &&
          afterState === "PROVISIONING" &&
          !activateGhost.ok &&
          activateGhost.error.type === "owner_membership_not_pending",
        { beforeState, afterState, activateGhost },
      );
    }

    // --- Membership repository ---
    const member1 = creator ? await repos.users.createUser({ username: `smoke-member-1-${suffix}`, email: `smoke-member-1-${suffix}@example.test` }) : null;
    const projectId = createProjectResult?.ok ? createProjectResult.project.id : null;

    const addMemberSuccess =
      projectId && member1?.ok && creator ? await repos.memberships.addMember({ projectId, userId: member1.user.id, role: "REVIEWER", addedByUserId: creator.id }) : null;
    record("add-member-success", Boolean(addMemberSuccess?.ok && addMemberSuccess.membership.role === "REVIEWER" && addMemberSuccess.membership.status === "ACTIVE"), addMemberSuccess);

    if (projectId && member1?.ok && creator) {
      const ownerRoleRejected = await repos.memberships.addMember({
        projectId,
        // Deliberately bypasses the TypeScript `Exclude<ProjectRole, "PROJECT_OWNER">` type (an untrusted-input simulation) to prove the runtime guard, not just the type.
        role: "PROJECT_OWNER" as never,
        userId: member1.user.id,
        addedByUserId: creator.id,
      });
      record("add-member-owner-role-rejected", !ownerRoleRejected.ok && ownerRoleRejected.error.type === "owner_role_not_assignable", ownerRoleRejected);

      const duplicateActive = await repos.memberships.addMember({ projectId, userId: member1.user.id, role: "VALIDATOR", addedByUserId: creator.id });
      record("add-member-duplicate-active", !duplicateActive.ok && duplicateActive.error.type === "already_active_member", duplicateActive);
    }

    if (member1?.ok && creator) {
      const projectNotFound = await repos.memberships.addMember({
        projectId: "00000000-0000-0000-0000-000000000000",
        userId: member1.user.id,
        role: "GUEST",
        addedByUserId: creator.id,
      });
      record("add-member-project-not-found", !projectNotFound.ok && projectNotFound.error.type === "project_not_found", projectNotFound);
    }

    if (projectId && creator) {
      const userNotFound = await repos.memberships.addMember({
        projectId,
        userId: "00000000-0000-0000-0000-000000000000",
        role: "GUEST",
        addedByUserId: creator.id,
      });
      record("add-member-user-not-found", !userNotFound.ok && userNotFound.error.type === "user_not_found", userNotFound);
    }

    // removeMember: cannot remove Owner
    if (createProjectResult?.ok && creator) {
      const removeOwnerAttempt = await repos.memberships.removeMember(createProjectResult.ownerMembership.id, creator.id, "attempted removal");
      record("remove-member-cannot-remove-owner", !removeOwnerAttempt.ok && removeOwnerAttempt.error.type === "cannot_remove_owner", removeOwnerAttempt);
    }

    // removeMember: not found
    const removeNotFound = creator ? await repos.memberships.removeMember("00000000-0000-0000-0000-000000000000", creator.id) : null;
    record("remove-member-not-found", Boolean(removeNotFound && !removeNotFound.ok && removeNotFound.error.type === "membership_not_found"), removeNotFound);

    // changeMemberRole: success, then cannot-change-owner, then owner-role-rejected — use a SEPARATE member so remove-member-success below still has a target.
    const member2 = creator ? await repos.users.createUser({ username: `smoke-member-2-${suffix}`, email: `smoke-member-2-${suffix}@example.test` }) : null;
    const addMember2 = projectId && member2?.ok && creator ? await repos.memberships.addMember({ projectId, userId: member2.user.id, role: "GUEST", addedByUserId: creator.id }) : null;

    if (addMember2?.ok) {
      const changeRoleSuccess = await repos.memberships.changeMemberRole(addMember2.membership.id, "VALIDATOR");
      record("change-member-role-success", changeRoleSuccess.ok && changeRoleSuccess.membership.role === "VALIDATOR", changeRoleSuccess);

      const changeRoleToOwner = await repos.memberships.changeMemberRole(addMember2.membership.id, "PROJECT_OWNER" as never);
      record("change-member-role-owner-role-rejected", !changeRoleToOwner.ok && changeRoleToOwner.error.type === "owner_role_not_assignable", changeRoleToOwner);

      // Now remove member2 — proves remove-member-success before testing cannot-change-owner on the REAL owner membership.
      const removeMember2 = await repos.memberships.removeMember(addMember2.membership.id, creator?.id ?? "");
      record("remove-member-success", removeMember2.ok && removeMember2.membership.status === "REMOVED", removeMember2);
    }

    if (createProjectResult?.ok) {
      const changeOwnerRole = await repos.memberships.changeMemberRole(createProjectResult.ownerMembership.id, "GUEST");
      record("change-member-role-cannot-change-owner", !changeOwnerRole.ok && changeOwnerRole.error.type === "cannot_change_owner_role", changeOwnerRole);
    }

    const activeMembers = projectId ? await repos.memberships.listActiveMembers(projectId) : [];
    // Owner is PENDING_PROVISIONING→ACTIVE (activated above) + member1 (REVIEWER, still active) = 2; member2 was removed.
    record("list-active-members", activeMembers.length === 2 && activeMembers.some((m) => m.role === "PROJECT_OWNER"), activeMembers);

    // --- Project DB isolation: this script never touches PROJECT_DATABASE_URL at all — no code path here does. Asserted structurally by the outer test's own separate psql check, not duplicated here.
  } finally {
    await repos.disconnect();
    await fixturePool.end();
  }

  const allOk = checks.every((c) => c.ok);
  // eslint-disable-next-line no-console
  console.log(`REPO_SMOKE_RESULT:${JSON.stringify({ ok: allOk, checks })}`);
  process.exitCode = allOk ? 0 : 1;
}

await main();
