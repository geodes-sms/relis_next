import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runToCompletion, type SpawnResult } from "@relis/test-utils";

// Sub-issue 03.04 ("Implement versioned Control schema, migrations and
// generated client"). These checks require NO database connection at all
// — `prisma validate` and `prisma generate` both operate purely on the
// schema file — and therefore run for real in every environment,
// including one where Docker/PostgreSQL is unavailable (see
// tests/migration/control-prisma/ for the Docker-gated checks that DO
// need a real disposable PostgreSQL instance).
//
// What this file does NOT prove: that the committed migration SQL
// actually applies to a real PostgreSQL database, that the hand-written
// raw-SQL constraints (partial unique indexes, the CHECK constraint) are
// syntactically valid against a real server, or that any business
// invariant holds under real data. Those are exactly what
// tests/migration/control-prisma/ exists for, and are Docker-gated there.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const databaseDir = path.join(repoRoot, "packages", "database");
const controlDir = path.join(databaseDir, "prisma", "control");
const projectSchemaPath = path.join(databaseDir, "prisma", "project", "schema.prisma");
const prismaBin = path.join(databaseDir, "node_modules", ".bin", process.platform === "win32" ? "prisma.CMD" : "prisma");
const generatedClientDir = path.join(databaseDir, "generated", "control-client");

async function runPrisma(args: string[]): Promise<SpawnResult> {
  return runToCompletion(prismaBin, args, { cwd: databaseDir, timeoutMs: 60000 });
}

describe("Control schema validation and client generation (no database required)", () => {
  it("validates the Control schema (prisma validate)", async () => {
    const result = await runPrisma(["validate", "--config", "prisma/control/prisma.config.ts"]);
    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("is valid");
  });

  it("generates the Control Prisma client from a clean (deleted) output directory", async () => {
    // Proves the generation path does not silently depend on a stale
    // artifact already being present — delete, then regenerate from
    // scratch.
    rmSync(generatedClientDir, { recursive: true, force: true });
    expect(existsSync(generatedClientDir)).toBe(false);

    const result = await runPrisma(["generate", "--config", "prisma/control/prisma.config.ts"]);
    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(existsSync(path.join(generatedClientDir, "client.d.ts"))).toBe(true);
    expect(existsSync(path.join(generatedClientDir, "index.d.ts"))).toBe(true);
  });

  it("generates the Control client into its own distinct output directory, never the Project schema's", async () => {
    expect(existsSync(generatedClientDir)).toBe(true);
    // The Project schema has no generator block at all today (no
    // Project-DB business schema is introduced by this sub-issue) — so
    // there is nothing it could conflate with; this assertion will start
    // to matter the moment a future sub-issue adds one.
    const projectSchemaSource = readFileSync(projectSchemaPath, "utf8");
    expect(projectSchemaSource).not.toContain("generator");
  });

  it("does not introduce any model in the Project schema (control/project boundary)", () => {
    const projectSchemaSource = readFileSync(projectSchemaPath, "utf8");
    expect(projectSchemaSource).not.toMatch(/^model\s+\w+/m);
  });

  it("the Control schema defines no project-runtime domain models (papers/screening/QA/extraction)", () => {
    const controlSchemaSource = readFileSync(path.join(controlDir, "schema.prisma"), "utf8");
    for (const forbidden of ["model Paper", "model Screening", "model QualityAssessment", "model Extraction", "model Classification"]) {
      expect(controlSchemaSource).not.toContain(forbidden);
    }
  });

  it("the committed migration directory exists with a lock file and the expected SQL file", () => {
    const migrationsDir = path.join(controlDir, "migrations");
    expect(existsSync(path.join(migrationsDir, "migration_lock.toml"))).toBe(true);
    const lockContent = readFileSync(path.join(migrationsDir, "migration_lock.toml"), "utf8");
    expect(lockContent).toContain('provider = "postgresql"');

    const migrationSqlPath = path.join(migrationsDir, "20261014120000_init_control_schema", "migration.sql");
    expect(existsSync(migrationSqlPath)).toBe(true);
    const sql = readFileSync(migrationSqlPath, "utf8");

    // Part 1 (Prisma-generated) sanity markers.
    expect(sql).toContain('CREATE TABLE "users"');
    expect(sql).toContain('CREATE TABLE "memberships"');
    expect(sql).toContain('CREATE TABLE "invitations"');

    // Part 2 (hand-written structural invariants) must be present —
    // these are NOT reproducible by re-running `prisma migrate diff`
    // from the declarative schema alone (see the schema's own header
    // comment and the migration file's Part 2 banner).
    expect(sql).toContain('"memberships_active_project_user_key"');
    expect(sql).toContain('"memberships_single_owner_per_project_key"');
    expect(sql).toContain('"invitations_active_project_email_key"');
    expect(sql).toContain('"invitations_proposed_role_not_owner_check"');
  });
});
