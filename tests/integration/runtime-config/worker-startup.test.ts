import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runToCompletion } from "@relis/test-utils";

// Spawns the REAL built apps/worker entry point (dist/main.js). The worker
// currently only logs its own startup and exits (no queue/database
// consumer exists yet); this proves config validation runs before that
// existing behavior, without inventing a required variable it does not
// actually consume.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const workerDir = path.join(repoRoot, "apps", "worker");

beforeAll(() => {
  execSync("pnpm --filter @relis/config build", { cwd: repoRoot, stdio: "pipe" });
  execSync("pnpm --filter @relis/worker build", { cwd: repoRoot, stdio: "pipe" });
}, 120000);

describe("apps/worker real startup (dist/main.js)", () => {
  it("exits nonzero with a safe diagnostic on an invalid NODE_ENV, before its normal startup log", async () => {
    const result = await runToCompletion("node", ["dist/main.js"], {
      cwd: workerDir,
      env: { ...process.env, NODE_ENV: "bogus-environment" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("ReLiS worker started");
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "worker" });
    expect(diagnostic.categories).toEqual(["runtime"]);
    expect(diagnostic.variables).toEqual(["NODE_ENV"]);
    expect(result.stdout + result.stderr).not.toContain("bogus-environment");
  });

  it("validates successfully and preserves the existing log-and-exit behavior with a valid environment", async () => {
    const result = await runToCompletion("node", ["dist/main.js"], {
      cwd: workerDir,
      env: { ...process.env, NODE_ENV: "test" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ReLiS worker started");
  });

  it("validates successfully when NODE_ENV is absent (safe default)", async () => {
    const env = { ...process.env };
    delete env.NODE_ENV;

    const result = await runToCompletion("node", ["dist/main.js"], {
      cwd: workerDir,
      env,
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ReLiS worker started");
  });
});
