import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type ComposeProject, cleanupComposeProject, composeRun, isDockerAvailableSync, uniqueProjectName } from "@relis/test-utils";

// Proves that the migrate-control service — the one Compose service that
// genuinely requires CONTROL_DATABASE_URL, with no safe default (see
// docs/architecture/local-stack-inventory.md §5: every apps/api,
// apps/web, apps/worker variable IS defaulted; only the database targets
// are not) — rejects a missing or invalid value BEFORE invoking Prisma or
// touching any database, with a secret-free diagnostic. This reuses the
// EXISTING loadDatabaseConfigForTarget contract unchanged; nothing here
// adds new validation.
//
// The CONFIG_INVALID diagnostic is written via console.error — STDERR,
// not stdout — by packages/database/src/migrate.ts's runMigrate(); every
// assertion below checks stderr for the diagnostic itself, and checks
// BOTH streams for a leaked raw value (pnpm's own build-step output on
// stdout could in principle leak something the diagnostic itself does
// not).
//
// `docker compose run -e ... --no-deps` overrides the environment for a
// single disposable invocation without starting postgres or any other
// service — deliberately not testing against a real database here (that
// would conflate "misconfigured" with "unreachable"; see
// dependency-unavailable.test.ts for the latter).
//
// `composeRun`'s `--rm` only removes the ONE-OFF CONTAINER it creates; it
// does not tear down the project's implicitly-created network (Compose
// creates that network for ANY command in the project, `run` included).
// `afterAll` below cleans that up — this file previously had no cleanup
// step at all.
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
    "[docker-compose/config-validation.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon is reachable) " +
      "in this environment. These cases were not executed; this is a reported blocker, not a pass.",
  );
}

const MIGRATE_COMMAND = ["sh", "-c", "pnpm --filter @relis/config build && pnpm --filter @relis/database run migrate control"];

describe.runIf(dockerAvailable)("missing/invalid required configuration (migrate-control)", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-config-fail"), composeFile, cwd: repoRoot };

  afterAll(async () => {
    // `composeRun` never starts a long-running stack here, but it still
    // creates this project's network (see the file header comment) —
    // clean it up, and surface (not swallow) a cleanup failure.
    await cleanupComposeProject(project, { timeoutMs: 60000 });
  }, 60000);

  it("blocks on a genuinely missing CONTROL_DATABASE_URL, before invoking Prisma", async () => {
    const result = await composeRun(project, "migrate-control", { CONTROL_DATABASE_URL: "" }, { command: MIGRATE_COMMAND, timeoutMs: 120000 });

    expect(result.exitCode).not.toBe(0);
    // migrate.ts's runMigrate() reports ConfigValidationError via
    // console.error — that writes to STDERR, not stdout (the earlier
    // version of this test asserted on stdout, which this diagnostic
    // never reaches).
    expect(result.stderr).toContain("CONFIG_INVALID");
    expect(result.stderr).toContain("database");
    // Secret-free: check BOTH streams, not just the one the diagnostic
    // happens to use — pnpm's own build-step output (stdout) must not
    // leak a connection string either, even though the diagnostic itself
    // is on stderr.
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(combinedOutput).not.toContain("postgresql://");
    // Prisma is never invoked: runMigrate()'s catch block returns 1
    // immediately on a ConfigValidationError, before ever calling
    // runPrisma() (packages/database/src/migrate.ts) — a real Prisma CLI
    // invocation would print its own "Datasource"/schema-loading banner,
    // which must be absent here. This is a best-effort textual signal
    // (not executed against a real Prisma CLI in this environment, since
    // Docker is unavailable), in addition to the structural proof that
    // the code path never reaches runPrisma() at all.
    expect(combinedOutput).not.toContain("Datasource");
    expect(combinedOutput).not.toContain("migrate deploy");
  }, 120000);

  it("blocks on an invalid CONTROL_DATABASE_URL (not a postgres URL), before invoking Prisma", async () => {
    const result = await composeRun(
      project,
      "migrate-control",
      { CONTROL_DATABASE_URL: "mysql://not-a-postgres-url" },
      { command: MIGRATE_COMMAND, timeoutMs: 120000 },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("CONFIG_INVALID");
    // The invalid submitted value itself must never be echoed back, on
    // either stream.
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(combinedOutput).not.toContain("mysql://not-a-postgres-url");
    expect(combinedOutput).not.toContain("Datasource");
    expect(combinedOutput).not.toContain("migrate deploy");
  }, 120000);
});

describe.skipIf(dockerAvailable)("missing/invalid required configuration (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
