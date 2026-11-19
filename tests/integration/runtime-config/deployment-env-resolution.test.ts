import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateDeployment } from "../../../tooling/scripts/deploy.mjs";
import { runToCompletion } from "@relis/test-utils";

// Items 1 & 2: deploy.mjs must resolve the control-database's effective
// environment the SAME way (root/package env-file precedence, OS
// precedence) the standalone migration entry point does — not read
// CONTROL_DATABASE_URL directly from process.env — and must enforce
// apps/web's NODE_ENV-consistency rule before any deployment side effect,
// including migration.
//
// tooling/scripts/deploy.mjs resolves apps/api, apps/web, apps/worker, and
// packages/database by their real, fixed repository paths (this mirrors
// how it is actually invoked in production — those paths are not
// parameterized). Proving root/package env-file precedence therefore
// means writing temporary, gitignored `.env*` files into those REAL
// directories and always removing them afterward, even if an assertion
// fails — never leaving one behind. This repository has no real `.env`
// files in these directories (verified before this suite existed), so
// these tests cannot clobber real configuration.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const databaseDir = path.join(repoRoot, "packages", "database");
const webDir = path.join(repoRoot, "apps", "web");
const deployScriptPath = path.join(repoRoot, "tooling", "scripts", "deploy.mjs");
const spawnInterceptorPath = path.join(repoRoot, "tests", "fixtures", "runtime-config", "spawn-interceptor.cjs");

const VALID_BASE_ENV = {
  API_PORT: "5301",
  WEB_PORT: "5300",
  API_CORS_ORIGIN: "http://localhost:5300",
  NEXT_PUBLIC_API_URL: "http://localhost:5301",
};

const managedFiles: string[] = [];

function writeManaged(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    throw new Error(`Refusing to overwrite a pre-existing file: ${filePath}`);
  }
  writeFileSync(filePath, content);
  managedFiles.push(filePath);
}

afterEach(() => {
  for (const filePath of managedFiles.splice(0)) {
    rmSync(filePath, { force: true });
  }
});

describe("validateDeployment: control-database env resolution (isolated, real repo paths)", () => {
  it("resolves CONTROL_DATABASE_URL from a root-level .env file", () => {
    writeManaged(path.join(repoRoot, ".env"), "CONTROL_DATABASE_URL=postgresql://u:p@localhost:5432/from_root\n");

    const env = { ...VALID_BASE_ENV };
    const result = validateDeployment(env);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected validateDeployment to succeed");
    expect(result.databaseEnv.CONTROL_DATABASE_URL).toBe("postgresql://u:p@localhost:5432/from_root");
  });

  it("lets a package-level (packages/database/.env) value override the root file", () => {
    writeManaged(path.join(repoRoot, ".env"), "CONTROL_DATABASE_URL=postgresql://u:p@localhost:5432/from_root\n");
    writeManaged(path.join(databaseDir, ".env"), "CONTROL_DATABASE_URL=postgresql://u:p@localhost:5432/from_package\n");

    const result = validateDeployment({ ...VALID_BASE_ENV });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected validateDeployment to succeed");
    expect(result.databaseEnv.CONTROL_DATABASE_URL).toBe("postgresql://u:p@localhost:5432/from_package");
  });

  it("lets a real OS/base environment variable take precedence over any file", () => {
    writeManaged(path.join(databaseDir, ".env"), "CONTROL_DATABASE_URL=postgresql://u:p@localhost:5432/from_file\n");

    const result = validateDeployment({
      ...VALID_BASE_ENV,
      CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/from_os",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected validateDeployment to succeed");
    expect(result.databaseEnv.CONTROL_DATABASE_URL).toBe("postgresql://u:p@localhost:5432/from_os");
  });

  it("rejects a missing CONTROL_DATABASE_URL (no file, no OS variable) before any side effect", () => {
    const result = validateDeployment({ ...VALID_BASE_ENV });

    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "database (control)" });
  });

  it("rejects an invalid CONTROL_DATABASE_URL introduced by a file", () => {
    writeManaged(path.join(databaseDir, ".env"), "CONTROL_DATABASE_URL=not-a-connection-string\n");

    const result = validateDeployment({ ...VALID_BASE_ENV });

    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "database (control)" });
  });

  it("forces the resolved databaseEnv's NODE_ENV to the exact mode used for tier selection (consistency with the standalone migrate entry point)", () => {
    writeManaged(path.join(databaseDir, ".env"), "CONTROL_DATABASE_URL=postgresql://u:p@localhost:5432/c\n");

    const result = validateDeployment({ ...VALID_BASE_ENV, NODE_ENV: "test" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected validateDeployment to succeed");
    expect(result.mode).toBe("test");
    expect(result.databaseEnv.NODE_ENV).toBe("test");
  });

  it("does not require CONTROL_DATABASE_URL when migration is an explicitly unselected step", () => {
    const result = validateDeployment({ ...VALID_BASE_ENV }, { skipMigrate: true });
    expect(result.ok).toBe(true);
  });
});

describe("validateDeployment: web NODE_ENV consistency enforced before any deployment side effect", () => {
  it("rejects a conflicting file-provided web NODE_ENV even when the database and every other process are valid", () => {
    writeManaged(path.join(webDir, ".env"), "NODE_ENV=development\n"); // conflicts with deployment's own "production" default
    writeManaged(path.join(databaseDir, ".env"), "CONTROL_DATABASE_URL=postgresql://u:p@localhost:5432/c\n");

    const result = validateDeployment({ ...VALID_BASE_ENV });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validateDeployment to fail");
    expect(result.diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web" });
    expect(result.diagnostic.variables).toContain("NODE_ENV");
  });

  it("rejects an empty file-provided web NODE_ENV", () => {
    writeManaged(path.join(webDir, ".env"), "NODE_ENV=\n");

    const result = validateDeployment({ ...VALID_BASE_ENV, CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/c" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validateDeployment to fail");
    expect(result.diagnostic.variables).toContain("NODE_ENV");
  });

  it("accepts a file-provided web NODE_ENV that matches the deployment mode", () => {
    writeManaged(path.join(webDir, ".env"), "NODE_ENV=production\n");

    const result = validateDeployment({ ...VALID_BASE_ENV, CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/c" });

    expect(result.ok).toBe(true);
  });
});

describe("tooling/scripts/deploy.mjs: real subprocess — invalid configuration prevents every step (zero spawn calls)", () => {
  beforeAll(() => {
    execSync("pnpm --filter @relis/config build", { cwd: repoRoot, stdio: "pipe" });
  }, 60000);

  function parseCaptured(stdout: string) {
    const line = stdout.split("\n").find((entry) => entry.startsWith("SPAWN_CAPTURED:"));
    return line ? JSON.parse(line.slice("SPAWN_CAPTURED:".length)) : null;
  }

  it("never invokes the migration step (or anything else) when web's NODE_ENV conflicts, even with fully valid database config", async () => {
    writeManaged(path.join(webDir, ".env"), "NODE_ENV=development\n");

    // The test runner itself may already have NODE_ENV set (vitest sets
    // NODE_ENV=test); that would count as an already-resolved OS-level
    // value and mask the fixture file's NODE_ENV entirely (a file never
    // overrides an already-set value) — delete it so the file is the ONLY
    // source, and deployment's own "production" default plus the file's
    // "development" are what actually conflict.
    const env = { ...process.env };
    delete env.NODE_ENV;

    const result = await runToCompletion("node", ["--require", spawnInterceptorPath, deployScriptPath], {
      cwd: repoRoot,
      env: {
        ...env,
        API_PORT: "5302",
        WEB_PORT: "5303",
        API_CORS_ORIGIN: "http://localhost:5303",
        NEXT_PUBLIC_API_URL: "http://localhost:5302",
        CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/relis_control",
      },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(parseCaptured(result.stdout)).toBeNull();
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web" });
    expect(diagnostic.variables).toContain("NODE_ENV");
  });

  it("forwards the exact resolved CONTROL_DATABASE_URL (from a file) to the real migration step's first spawn", async () => {
    writeManaged(path.join(databaseDir, ".env"), "CONTROL_DATABASE_URL=postgresql://u:p@localhost:5432/from_file_e2e\n");

    const result = await runToCompletion(
      "node",
      ["--require", spawnInterceptorPath, deployScriptPath, "--skip-build", "--skip-worker"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          API_PORT: "5304",
          WEB_PORT: "5305",
          API_CORS_ORIGIN: "http://localhost:5305",
          NEXT_PUBLIC_API_URL: "http://localhost:5304",
        },
        timeoutMs: 10000,
      },
    );

    const captured = parseCaptured(result.stdout);
    expect(captured).not.toBeNull();
    // The migrate step is the first thing spawned (build/worker skipped,
    // start-services never reached since spawn is intercepted).
    expect(captured.args.join(" ")).toContain(path.join("packages", "database", "src", "migrate.ts"));
    expect(captured.env.CONTROL_DATABASE_URL).toBe("postgresql://u:p@localhost:5432/from_file_e2e");
  });

  // validateDeployment's initial mode selection (validateRuntimeMode) runs
  // BEFORE its try/catch resolves any process's config — proving these two
  // cases are caught by the same safe boundary as every other config
  // failure (not an uncaught exception escaping the real entry point),
  // with zero downstream spawn calls, is only possible via a real
  // subprocess: an in-process call can't distinguish "returned a rejection
  // object" from "the OS process itself crashed uncaught".
  it("rejects an invalid OS-provided NODE_ENV with a safe diagnostic and zero downstream spawn calls", async () => {
    const env = { ...process.env };
    delete env.NODE_ENV;

    const result = await runToCompletion("node", ["--require", spawnInterceptorPath, deployScriptPath], {
      cwd: repoRoot,
      env: {
        ...env,
        NODE_ENV: "bogus",
        API_PORT: "5306",
        WEB_PORT: "5307",
        API_CORS_ORIGIN: "http://localhost:5307",
        NEXT_PUBLIC_API_URL: "http://localhost:5306",
        CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/relis_control",
      },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(parseCaptured(result.stdout)).toBeNull();
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "deploy" });
    expect(diagnostic.variables).toContain("NODE_ENV");
  });

  it("rejects an empty OS-provided NODE_ENV with a safe diagnostic and zero downstream spawn calls", async () => {
    const env = { ...process.env };
    delete env.NODE_ENV;

    const result = await runToCompletion("node", ["--require", spawnInterceptorPath, deployScriptPath], {
      cwd: repoRoot,
      env: {
        ...env,
        NODE_ENV: "",
        API_PORT: "5308",
        WEB_PORT: "5309",
        API_CORS_ORIGIN: "http://localhost:5309",
        NEXT_PUBLIC_API_URL: "http://localhost:5308",
        CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/relis_control",
      },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(parseCaptured(result.stdout)).toBeNull();
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "deploy" });
    expect(diagnostic.variables).toContain("NODE_ENV");
  });
});
