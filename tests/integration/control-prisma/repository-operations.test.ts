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
// Representative-consumer proof for AC1/AC5: imported via the PACKAGE'S
// OWN NAME (the public entry point `@relis/database` resolves this
// package's `exports` field to src/index.ts), never a relative path into
// an implementation file. `createControlRepositories` is referenced
// below in a real (if trivial, Docker-free) assertion; the type imports
// are exercised by `FakeControlRepositories` further down, which proves
// every interface is implementable by a hand-written substitute with no
// database or Prisma dependency at all — exactly the "how tests can
// inject substitutes" documentation this sub-issue asks for.
import {
  createControlRepositories,
  type AddMemberInput,
  type AddMemberResult,
  type ChangeMemberRoleResult,
  type CreateUserInput,
  type CreateUserResult,
  type MembershipRecord,
  type MembershipRepository,
  type RemoveMemberResult,
  type UserRepository,
} from "@relis/database";

// Sub-issue 03.05 — real repository-layer evidence for
// `@relis/database`'s typed Control persistence surface
// (packages/database/src/repositories/, src/control-repositories.ts).
//
// Postgres is never published to the host (docker-compose.yml's
// `postgres` service deliberately has no `ports:` block — the prior
// port-hardening decision). Every ACTUAL repository call below therefore
// runs INSIDE the existing `migrate-control` Compose service's own
// image/network via `composeRun`, invoking the package's own
// `generate:control` and `smoke:repositories` scripts
// (packages/database/scripts/repository-smoke.mts) — the same pattern
// 03.04's corrective pass established for the raw-client smoke test, and
// for the identical reason (no new Dockerfile, no new exposed port).
// `repository-smoke.mts` itself imports ONLY `createControlRepositories`
// from the package's own public entry point (`../src/index.js`), not an
// internal implementation file — see that script's own header comment.
//
// SAFETY/ISOLATION — identical guarded provisioning/cleanup lifecycle
// and explicit-configuration discipline as
// tests/migration/control-prisma/*.test.ts (see those files' own header
// comments and packages/test-utils/src/docker-compose.ts's `composeRun`
// doc comment) — not a parallel implementation.
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
    "[integration/control-prisma/repository-operations.test.ts] SKIPPED: the `docker` CLI is not available (or no " +
      "daemon is reachable) in this environment. Real repository evidence was NOT produced by this run; this is a " +
      "reported blocker, not a pass.",
  );
}

describe("createControlRepositories — public entry point resolves (no database required)", () => {
  it("is exported as a callable function from the package's own name, not a relative import", () => {
    expect(typeof createControlRepositories).toBe("function");
  });
});

/**
 * A complete, hand-written, Prisma-free, Docker-free substitute for every
 * repository interface this package exports — proves the interfaces
 * themselves are genuinely injectable (the documented pattern from
 * control-repositories.ts's own doc comment), and doubles as a compile-time
 * check that `@relis/database`'s public types describe a real,
 * implementable contract. Never used against a real database; this
 * `describe` block is explicitly NOT part of this sub-issue's AC4
 * real-database evidence.
 */
describe("Repository interfaces are injectable with a hand-written fake (mocked — proves consumer wiring, not database behavior)", () => {
  function createFakeUserRepository(): UserRepository {
    const users = new Map<string, { id: string; username: string; email: string }>();
    return {
      async createUser(input: CreateUserInput): Promise<CreateUserResult> {
        if ([...users.values()].some((u) => u.email === input.email)) return { ok: false, error: { type: "duplicate_email" } };
        const id = `fake-${users.size + 1}`;
        users.set(id, { id, username: input.username, email: input.email });
        return {
          ok: true,
          user: { id, username: input.username, email: input.email, emailVerifiedAt: null, status: "ACTIVE", isApplicationAdministrator: false, preferredLocale: null, createdAt: new Date(), updatedAt: new Date() },
        };
      },
      async findUserByEmail(email) {
        const found = [...users.values()].find((u) => u.email === email);
        return found ? { ...found, emailVerifiedAt: null, status: "ACTIVE", isApplicationAdministrator: false, preferredLocale: null, createdAt: new Date(), updatedAt: new Date() } : null;
      },
      async findUserByUsername() {
        return null;
      },
      async findUserById() {
        return null;
      },
    };
  }

  it("a fake UserRepository satisfies the public interface and behaves as a real consumer would expect", async () => {
    const fake = createFakeUserRepository();
    const first = await fake.createUser({ username: "a", email: "a@example.test" });
    expect(first.ok).toBe(true);
    const duplicate = await fake.createUser({ username: "b", email: "a@example.test" });
    expect(duplicate).toEqual({ ok: false, error: { type: "duplicate_email" } });
  });

  it("a fake MembershipRepository can simulate the Owner-protection invariant without any database", async () => {
    const fake: MembershipRepository = {
      async addMember(input: AddMemberInput): Promise<AddMemberResult> {
        if ((input.role as string) === "PROJECT_OWNER") return { ok: false, error: { type: "owner_role_not_assignable" } };
        return { ok: true, membership: fakeMembership(input.projectId, input.userId, input.role) };
      },
      async removeMember(): Promise<RemoveMemberResult> {
        return { ok: false, error: { type: "cannot_remove_owner" } };
      },
      async changeMemberRole(): Promise<ChangeMemberRoleResult> {
        return { ok: false, error: { type: "cannot_change_owner_role" } };
      },
      async listActiveMembers(): Promise<MembershipRecord[]> {
        return [];
      },
    };
    const rejected = await fake.addMember({ projectId: "p1", userId: "u1", role: "PROJECT_OWNER" as never, addedByUserId: "actor" });
    expect(rejected).toEqual({ ok: false, error: { type: "owner_role_not_assignable" } });
  });
});

function fakeMembership(projectId: string, userId: string, role: string): MembershipRecord {
  return {
    id: "fake-membership",
    projectId,
    userId,
    role: role as MembershipRecord["role"],
    status: "ACTIVE",
    addedByUserId: null,
    removedByUserId: null,
    removedReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const POSTGRES_USER = "relis";
const POSTGRES_PASSWORD = "relis-disposable-test-only";
const POSTGRES_DB = "relis_control";
const PROJECT_TEST_DB_NAME = "relis_project_repository_test";
const EPHEMERAL_PORTS = { NGINX_HTTP_PORT: "0", MAILHOG_UI_PORT: "0", SEAWEEDFS_S3_PORT: "0" };
const SENTINEL_TABLE_SQL = 'CREATE TABLE "repository_test_sentinel" ("marker" TEXT NOT NULL);';
const SENTINEL_INSERT_SQL = `INSERT INTO "repository_test_sentinel" ("marker") VALUES ('untouched-by-control-repositories');`;
const SENTINEL_READ_SQL = `SELECT "marker" FROM "repository_test_sentinel";`;

interface RepoCheck {
  name: string;
  ok: boolean;
  detail?: unknown;
}

describe.runIf(dockerAvailable)("Control repositories — real PostgreSQL evidence (AC1–AC4)", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-control-repos"), composeFile, cwd: repoRoot };
  const composeEnv = { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, PROJECT_TEST_DB_NAME, ...EPHEMERAL_PORTS };

  let baselineVolumeNames: string[] = [];
  let resolved: ResolvedComposePersistence;
  let repoChecks: RepoCheck[] = [];

  function checkByName(name: string): RepoCheck | undefined {
    return repoChecks.find((c) => c.name === name);
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
    const migrateExitCode = await waitForExitCode(project, "migrate-control", { env: composeEnv, timeoutMs: 180000 });
    if (migrateExitCode !== 0) {
      throw new Error(`migrate-control did not exit 0 (exit ${migrateExitCode}) — cannot test repositories against an unmigrated database`);
    }

    // Plant a sentinel row in the SEPARATE project-test database BEFORE
    // any repository operation runs — proves not just "no Control table
    // exists there" but that PRE-EXISTING project data genuinely survives
    // untouched (task's explicit "preservation of sentinel data").
    const createSentinel = await composeExec(project, "postgres", ["psql", "-U", POSTGRES_USER, "-d", PROJECT_TEST_DB_NAME, "-c", SENTINEL_TABLE_SQL], { env: composeEnv });
    if (createSentinel.exitCode !== 0) throw new Error(`failed to create sentinel table: ${createSentinel.stderr}`);
    const insertSentinel = await composeExec(project, "postgres", ["psql", "-U", POSTGRES_USER, "-d", PROJECT_TEST_DB_NAME, "-c", SENTINEL_INSERT_SQL], { env: composeEnv });
    if (insertSentinel.exitCode !== 0) throw new Error(`failed to insert sentinel row: ${insertSentinel.stderr}`);

    const result = await composeRun(project, "migrate-control", composeEnv, {
      command: ["sh", "-c", "pnpm --filter @relis/database run generate:control && pnpm --filter @relis/database run smoke:repositories"],
      timeoutMs: 180000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`repository smoke script failed (exit ${result.exitCode}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    const line = result.stdout.split("\n").find((l) => l.includes("REPO_SMOKE_RESULT:"));
    if (!line) throw new Error(`No REPO_SMOKE_RESULT line found in stdout:\n${result.stdout}`);
    const parsed = JSON.parse(line.slice(line.indexOf("REPO_SMOKE_RESULT:") + "REPO_SMOKE_RESULT:".length)) as { ok: boolean; checks: RepoCheck[] };
    repoChecks = parsed.checks;
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
      problems.push(`volume(s) not deleted — ownership could not be established: ` + outcome.volumesRequiringManualInspection.map((v) => `${v.name} (${v.reason})`).join("; "));
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

  // --- AC1/AC2: User repository ---
  it("creates a user and rejects duplicate email/username (stable conflict outcomes)", () => {
    expect(checkByName("create-user-success")?.ok, JSON.stringify(checkByName("create-user-success"))).toBe(true);
    expect(checkByName("create-user-duplicate-email")?.ok, JSON.stringify(checkByName("create-user-duplicate-email"))).toBe(true);
    expect(checkByName("create-user-duplicate-username")?.ok, JSON.stringify(checkByName("create-user-duplicate-username"))).toBe(true);
    expect(checkByName("find-user-by-email")?.ok, JSON.stringify(checkByName("find-user-by-email"))).toBe(true);
  });

  // --- AC1/AC2/AC3: Project + Owner atomic creation ---
  it("creates a Project and its PROJECT_OWNER membership atomically, and rejects duplicate short name/idempotency key/missing creator", () => {
    expect(checkByName("create-project-with-owner-success")?.ok, JSON.stringify(checkByName("create-project-with-owner-success"))).toBe(true);
    expect(checkByName("create-project-duplicate-short-name")?.ok, JSON.stringify(checkByName("create-project-duplicate-short-name"))).toBe(true);
    expect(checkByName("create-project-duplicate-idempotency-key")?.ok, JSON.stringify(checkByName("create-project-duplicate-idempotency-key"))).toBe(true);
    expect(checkByName("create-project-creator-not-found")?.ok, JSON.stringify(checkByName("create-project-creator-not-found"))).toBe(true);
  });

  it("activates a project (Project + Owner membership together) and rejects a missing project", () => {
    expect(checkByName("activate-project-success")?.ok, JSON.stringify(checkByName("activate-project-success"))).toBe(true);
    expect(checkByName("activate-project-not-found")?.ok, JSON.stringify(checkByName("activate-project-not-found"))).toBe(true);
  });

  it("AC3 — rolls back the project's own state update when the paired owner-membership update fails (real transaction rollback, re-read after the call returns)", () => {
    const check = checkByName("activate-project-rolls-back-on-missing-owner-membership");
    expect(check?.ok, JSON.stringify(check)).toBe(true);
  });

  // --- Membership repository: Owner-protection invariants ---
  it("adds a member and rejects assigning PROJECT_OWNER / a duplicate active member / missing project or user", () => {
    expect(checkByName("add-member-success")?.ok, JSON.stringify(checkByName("add-member-success"))).toBe(true);
    expect(checkByName("add-member-owner-role-rejected")?.ok, JSON.stringify(checkByName("add-member-owner-role-rejected"))).toBe(true);
    expect(checkByName("add-member-duplicate-active")?.ok, JSON.stringify(checkByName("add-member-duplicate-active"))).toBe(true);
    expect(checkByName("add-member-project-not-found")?.ok, JSON.stringify(checkByName("add-member-project-not-found"))).toBe(true);
    expect(checkByName("add-member-user-not-found")?.ok, JSON.stringify(checkByName("add-member-user-not-found"))).toBe(true);
  });

  it("removes a member, but unconditionally rejects removing the Owner, and rejects a missing membership", () => {
    expect(checkByName("remove-member-success")?.ok, JSON.stringify(checkByName("remove-member-success"))).toBe(true);
    expect(checkByName("remove-member-cannot-remove-owner")?.ok, JSON.stringify(checkByName("remove-member-cannot-remove-owner"))).toBe(true);
    expect(checkByName("remove-member-not-found")?.ok, JSON.stringify(checkByName("remove-member-not-found"))).toBe(true);
  });

  it("changes a member's role, but unconditionally rejects changing/assigning the Owner role", () => {
    expect(checkByName("change-member-role-success")?.ok, JSON.stringify(checkByName("change-member-role-success"))).toBe(true);
    expect(checkByName("change-member-role-owner-role-rejected")?.ok, JSON.stringify(checkByName("change-member-role-owner-role-rejected"))).toBe(true);
    expect(checkByName("change-member-role-cannot-change-owner")?.ok, JSON.stringify(checkByName("change-member-role-cannot-change-owner"))).toBe(true);
  });

  it("lists exactly the active members for a project", () => {
    expect(checkByName("list-active-members")?.ok, JSON.stringify(checkByName("list-active-members"))).toBe(true);
  });

  // --- AC4: Project database isolation, including sentinel preservation ---
  it("AC4 — does not create any Control table in the separate project-test database", async () => {
    const controlOnlyTables = ["users", "projects", "memberships"];
    for (const table of controlOnlyTables) {
      const result = await composeExec(project, "postgres", ["psql", "-U", POSTGRES_USER, "-d", PROJECT_TEST_DB_NAME, "-tAc", `SELECT to_regclass('public.${table}') IS NULL;`], {
        env: composeEnv,
      });
      expect(result.stdout.trim(), `Control table "${table}" leaked into the project database — stderr: ${result.stderr}`).toBe("t");
    }
  });

  it("AC4 — the project database's pre-existing sentinel row survives untouched", async () => {
    const result = await composeExec(project, "postgres", ["psql", "-U", POSTGRES_USER, "-d", PROJECT_TEST_DB_NAME, "-tAc", SENTINEL_READ_SQL], { env: composeEnv });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("untouched-by-control-repositories");
  });
});

describe.skipIf(dockerAvailable)("Control repositories — real PostgreSQL evidence (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
