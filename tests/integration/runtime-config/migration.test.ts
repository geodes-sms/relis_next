import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runToCompletion } from "@relis/test-utils";
import { runMigrate } from "../../../packages/database/src/migrate.ts";

// packages/database/src/migrate.ts is the migration entry point for the
// two prescribed database targets (control/project — see
// context/project-structure.md). Neither prisma/control/schema.prisma nor
// prisma/project/schema.prisma defines a model: no domain has been
// authorized. This file proves:
//  - Missing/invalid configuration prevents Prisma from ever being
//    invoked (dependency-injected `runPrisma`, ordering check).
//  - Valid configuration reaches the downstream Prisma invocation with
//    the validated connection string.
//  - A downstream (Prisma) failure is propagated as the exit code.
//  - Diagnostics never leak a secret/malformed connection string.
//  - A REAL Prisma CLI invocation (no injection) against a deliberately
//    unreachable database genuinely fails and propagates nonzero — never
//    touching a real database, but exercising real Prisma tooling.
//
// Real-Prisma-subprocess determinism history (both addressed below, but
// distinct — do not conflate them):
//  - Hypothesis (addressed, not the confirmed cause): a fixed low port
//    (originally "1") is not guaranteed free/refusing in every environment.
//    getUnusedLoopbackPort() replaces it with a dynamically-verified-free
//    port. This is still worth keeping (a real, if smaller, source of
//    nondeterminism) but did not, by itself, explain the originally
//    reported failure.
//  - Confirmed cause: an inherited RUST_LOG=warn in the environment running
//    this suite makes Prisma's schema-engine binary emit a generic,
//    detail-free "Schema engine error:" instead of the structured P1001
//    connection diagnostic, for the IDENTICAL command and connection
//    string — independently verified (RUST_LOG=warn: generic error;
//    RUST_LOG=info or unset: P1001). buildMigrationSubprocessEnv() strips
//    RUST_LOG from the real Prisma subprocess's own environment only; it
//    never touches this test process's own `process.env` or any machine
//    setting.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const databaseDir = path.join(repoRoot, "packages", "database");

const SECRET_SENTINEL = "s3cr3t-should-never-leak";

/**
 * Returns a loopback port confirmed free at the moment of the call (briefly
 * bound, then released) instead of a fixed guess like the reserved-looking
 * port 1 this replaced. A fixed low port is not guaranteed unused, reachable
 * -but-refusing, or even unrestricted-to-connect-to in every environment —
 * it can be already bound, proxied, or subject to sandbox-specific network
 * policy that produces something other than a clean, fast connection
 * refusal. An OS-assigned ephemeral port that this process itself just
 * verified as free carries none of those assumptions.
 *
 * Kept as a real hardening in its own right, but note: this alone did NOT
 * resolve the originally reported "Schema engine error:" failure — see
 * buildMigrationSubprocessEnv below for the confirmed cause.
 */
function getUnusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to obtain an ephemeral loopback port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Builds the environment for a REAL Prisma subprocess launched by this file
 * — a fresh, local object, never a mutation of this test process's own
 * `process.env` or any machine-wide setting.
 *
 * Strips RUST_LOG: independently verified as the confirmed cause of the
 * "Schema engine error:" (no P1001 detail) failure this file's real-Prisma
 * tests previously hit — reproduced with the IDENTICAL migrate command and
 * dummy loopback connection string, varying only RUST_LOG:
 *   - RUST_LOG=warn (inherited from this repo's/CI's shell): generic,
 *     detail-free "Schema engine error:".
 *   - RUST_LOG=info, or RUST_LOG unset: the expected structured P1001.
 * The installed schema engine itself runs normally either way; only its
 * OWN error-detail verbosity is gated by RUST_LOG. This is scoped to the
 * subprocess env object returned here — it does not change this test
 * process's real environment, and it does not touch production migration
 * or logging behavior.
 */
function buildMigrationSubprocessEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  delete env.RUST_LOG;
  return env;
}

describe("runMigrate (in-process, injected Prisma runner — simulated downstream execution)", () => {
  it("never invokes Prisma when CONTROL_DATABASE_URL is missing", async () => {
    const runPrisma = vi.fn().mockResolvedValue(0);

    const exitCode = await runMigrate("control", {}, { runPrisma });

    expect(exitCode).toBe(1);
    expect(runPrisma).not.toHaveBeenCalled();
  });

  it("never invokes Prisma when CONTROL_DATABASE_URL is malformed", async () => {
    const runPrisma = vi.fn().mockResolvedValue(0);

    const exitCode = await runMigrate("control", { CONTROL_DATABASE_URL: "not-a-connection-string" }, { runPrisma });

    expect(exitCode).toBe(1);
    expect(runPrisma).not.toHaveBeenCalled();
  });

  it("never invokes Prisma when PROJECT_DATABASE_URL is missing for the project target", async () => {
    const runPrisma = vi.fn().mockResolvedValue(0);

    const exitCode = await runMigrate("project", { CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/c" }, { runPrisma });

    expect(exitCode).toBe(1);
    expect(runPrisma).not.toHaveBeenCalled();
  });

  it("invokes Prisma with the validated connection string when configuration is valid (reaches the downstream command)", async () => {
    const runPrisma = vi.fn().mockResolvedValue(0);
    const connectionString = "postgresql://u:p@localhost:5432/relis_control";

    const exitCode = await runMigrate("control", { CONTROL_DATABASE_URL: connectionString }, { runPrisma });

    expect(exitCode).toBe(0);
    expect(runPrisma).toHaveBeenCalledTimes(1);
    const [args, env] = runPrisma.mock.calls[0];
    expect(args).toEqual(["migrate", "deploy", "--config", expect.stringContaining(path.join("prisma", "control"))]);
    expect(env.CONTROL_DATABASE_URL).toBe(connectionString);
  });

  it("uses the project schema's config path for the project target", async () => {
    const runPrisma = vi.fn().mockResolvedValue(0);

    await runMigrate("project", { PROJECT_DATABASE_URL: "postgresql://u:p@localhost:5432/relis_project" }, { runPrisma });

    const [args] = runPrisma.mock.calls[0];
    expect(args).toEqual(["migrate", "deploy", "--config", expect.stringContaining(path.join("prisma", "project"))]);
  });

  it("propagates a nonzero exit code from a failed downstream migration", async () => {
    const runPrisma = vi.fn().mockResolvedValue(7);

    const exitCode = await runMigrate("control", { CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/c" }, { runPrisma });

    expect(exitCode).toBe(7);
  });

  it("never leaks a secret-looking connection string in its rejection diagnostic", async () => {
    const runPrisma = vi.fn().mockResolvedValue(0);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const exitCode = await runMigrate(
        "control",
        { CONTROL_DATABASE_URL: `mysql://user:${SECRET_SENTINEL}@localhost/db` },
        { runPrisma },
      );

      expect(exitCode).toBe(1);
      expect(runPrisma).not.toHaveBeenCalled();
      const loggedText = consoleErrorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(loggedText).not.toContain(SECRET_SENTINEL);
      const diagnostic = JSON.parse(consoleErrorSpy.mock.calls[0][0]);
      expect(diagnostic).toEqual({
        code: "CONFIG_INVALID",
        process: "database (control)",
        categories: ["database"],
        variables: ["CONTROL_DATABASE_URL"],
      });
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("packages/database migrate CLI (real subprocess, no real database)", () => {
  it("exits nonzero with a safe diagnostic and never invokes Prisma when configuration is missing", async () => {
    const env = { ...process.env };
    delete env.CONTROL_DATABASE_URL;

    const result = await runToCompletion("pnpm", ["--filter", "@relis/database", "run", "migrate", "control"], {
      cwd: repoRoot,
      env,
      timeoutMs: 20000,
    });

    expect(result.exitCode).not.toBe(0);
    const diagnostic = JSON.parse(result.stderr.trim().split("\n").pop() ?? "{}");
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "database (control)" });
    expect(diagnostic.variables).toContain("CONTROL_DATABASE_URL");
    // Prisma was never reached: its own distinctive output never appears.
    expect(result.stdout + result.stderr).not.toMatch(/Prisma schema loaded/i);
  });

  it("actually invokes real Prisma tooling and propagates its failure against a deliberately unreachable database (no real database touched)", async () => {
    // A port this process just confirmed free fails fast and
    // deterministically (immediate OS-level connection refusal) without any
    // real Postgres server existing — see getUnusedLoopbackPort's docstring
    // for why a fixed low port (e.g. the previously used "1") is not a safe
    // assumption across environments. RUST_LOG is stripped from the
    // subprocess env (see buildMigrationSubprocessEnv) so this test's own
    // P1001 assertions below are deterministic regardless of whatever
    // RUST_LOG this suite itself happens to inherit.
    const port = await getUnusedLoopbackPort();
    const env = buildMigrationSubprocessEnv({
      ...process.env,
      CONTROL_DATABASE_URL: `postgresql://user:pass@127.0.0.1:${port}/relis_control`,
    });
    const result = await runToCompletion("pnpm", ["--filter", "@relis/database", "run", "migrate", "control"], {
      cwd: repoRoot,
      env,
      timeoutMs: 20000,
    });

    expect(result.exitCode).not.toBe(0);
    // Proof this is REAL Prisma tooling (not simulated): its own connection
    // error is present, not one of our own diagnostic codes.
    expect(result.stdout + result.stderr).toMatch(/P1001/);
    expect(result.stdout + result.stderr).toMatch(/Can't reach database server/i);
  }, 30000);

  // Regression for the confirmed cause above: an inherited RUST_LOG=warn
  // must never reach the real Prisma subprocess this file launches. Built
  // as a LOCAL copy simulating an environment that already exports
  // RUST_LOG=warn (e.g. this suite itself run with RUST_LOG=warn set, or a
  // developer/CI shell that sets it) — process.env itself is never mutated.
  it("strips an inherited RUST_LOG=warn from the real Prisma subprocess's environment (regression)", async () => {
    const port = await getUnusedLoopbackPort();
    const inheritedEnv = { ...process.env, RUST_LOG: "warn" };
    const env = buildMigrationSubprocessEnv({
      ...inheritedEnv,
      CONTROL_DATABASE_URL: `postgresql://user:pass@127.0.0.1:${port}/relis_control`,
    });

    // Prove the stripping actually happened before ever spawning anything.
    expect(inheritedEnv.RUST_LOG).toBe("warn");
    expect(env.RUST_LOG).toBeUndefined();

    const result = await runToCompletion("pnpm", ["--filter", "@relis/database", "run", "migrate", "control"], {
      cwd: repoRoot,
      env,
      timeoutMs: 20000,
    });

    expect(result.exitCode).not.toBe(0);
    // With RUST_LOG=warn actually reaching the schema engine, this would
    // instead be a generic, detail-free "Schema engine error:" — the exact
    // failure this test guards against regressing.
    expect(result.stdout + result.stderr).toMatch(/P1001/);
    expect(result.stdout + result.stderr).toMatch(/Can't reach database server/i);
    expect(result.stdout + result.stderr).not.toMatch(/Schema engine error:/i);
  }, 30000);
});
