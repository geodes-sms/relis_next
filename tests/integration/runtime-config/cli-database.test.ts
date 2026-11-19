import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runToCompletion } from "@relis/test-utils";

// The database schema (packages/config/src/database.ts) is a reusable
// contract prepared for a FUTURE migration process: no real command in
// this repository calls it today (packages/database has no Prisma schema
// or migration script yet). This file proves the contract itself is sound
// via the standalone `relis-config` CLI, without claiming that any real
// migration/deployment command exists or is wired to it.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const configDir = path.join(repoRoot, "packages", "config");

const SECRET_SENTINEL = "s3cr3t-should-never-leak";

beforeAll(() => {
  execSync("pnpm --filter @relis/config build", { cwd: repoRoot, stdio: "pipe" });
}, 60000);

describe("relis-config CLI: database contract (not wired to a real command)", () => {
  it("rejects a missing DATABASE_URL", async () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;

    const result = await runToCompletion("node", ["dist/cli.js", "check", "database"], {
      cwd: configDir,
      env,
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "database" });
    expect(diagnostic.categories).toEqual(["database"]);
  });

  it("rejects a malformed DATABASE_URL without leaking the value", async () => {
    const result = await runToCompletion("node", ["dist/cli.js", "check", "database"], {
      cwd: configDir,
      env: { ...process.env, DATABASE_URL: `mysql://user:${SECRET_SENTINEL}@localhost/db` },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SECRET_SENTINEL);
  });

  it("accepts a well-formed postgres:// connection string", async () => {
    const result = await runToCompletion("node", ["dist/cli.js", "check", "database"], {
      cwd: configDir,
      env: { ...process.env, DATABASE_URL: `postgresql://user:${SECRET_SENTINEL}@localhost:5432/relis` },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(0);
    const diagnostic = JSON.parse(result.stdout.trim());
    expect(diagnostic).toEqual({ code: "CONFIG_OK", process: "database" });
    expect(result.stdout).not.toContain(SECRET_SENTINEL);
  });
});
