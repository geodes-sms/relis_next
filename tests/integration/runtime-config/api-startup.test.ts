import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runToCompletion, spawnLongRunning, type LongRunningProcess } from "@relis/test-utils";

// Spawns the REAL built apps/api entry point (dist/main.js), not a mock, to
// prove config validation runs before any listener opens and that a valid
// environment reaches the actual HTTP boundary (/health, /ready).

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const apiDir = path.join(repoRoot, "apps", "api");

const SECRET_SENTINEL = "s3cr3t-should-never-leak";

let runningProcess: LongRunningProcess | undefined;

beforeAll(() => {
  execSync("pnpm --filter @relis/config build", { cwd: repoRoot, stdio: "pipe" });
  execSync('pnpm --filter "./apps/api" build', { cwd: repoRoot, stdio: "pipe" });
}, 120000);

afterEach(async () => {
  if (runningProcess) {
    await runningProcess.stop();
    runningProcess = undefined;
  }
});

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

describe("apps/api real startup (dist/main.js)", () => {
  it("exits nonzero with a safe diagnostic and never opens a listener when API_PORT is invalid", async () => {
    const port = 3901;
    const result = await runToCompletion("node", ["dist/main.js"], {
      cwd: apiDir,
      env: { ...process.env, API_PORT: "not-a-number", API_HOST: "127.0.0.1" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "api" });
    expect(diagnostic.categories).toContain("network");
    expect(diagnostic.variables).toContain("API_PORT");
    expect(result.stdout).not.toContain("running on");
    expect(result.stdout + result.stderr).not.toContain("not-a-number");
    expect(await isPortOpen(port)).toBe(false);
  });

  it("rejects a structurally malformed IPv6-looking API_HOST and never opens a listener", async () => {
    const port = 3904;
    const result = await runToCompletion("node", ["dist/main.js"], {
      cwd: apiDir,
      env: { ...process.env, API_PORT: String(port), API_HOST: "12345::1" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "api" });
    expect(diagnostic.categories).toContain("network");
    expect(diagnostic.variables).toContain("API_HOST");
    expect(await isPortOpen(port)).toBe(false);
  });

  it("rejects a wildcard CORS origin carrying a secret-looking sentinel without leaking it", async () => {
    const result = await runToCompletion("node", ["dist/main.js"], {
      cwd: apiDir,
      env: { ...process.env, API_PORT: "3902", API_CORS_ORIGIN: `http://${SECRET_SENTINEL}@localhost:3000` },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic.categories).toContain("cors");
    expect(diagnostic.variables).toContain("API_CORS_ORIGIN");
    expect(result.stdout + result.stderr).not.toContain(SECRET_SENTINEL);
  });

  it("starts and preserves the existing /health contract, plus /ready, with a valid real environment", async () => {
    const port = 3903;
    runningProcess = spawnLongRunning("node", ["dist/main.js"], {
      cwd: apiDir,
      env: {
        ...process.env,
        API_PORT: String(port),
        API_HOST: "127.0.0.1",
        API_CORS_ORIGIN: "http://localhost:3000",
      },
    });

    await runningProcess.waitForOutput((combined) => combined.includes("ReLiS API running"), 15000);

    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toEqual({
      status: "ok",
      message: "Bienvenue dans le nouveau ReLiS",
      service: "api",
    });

    const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
    expect(rootResponse.status).toBe(200);

    const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(readyResponse.status).toBe(200);
    const ready = (await readyResponse.json()) as { status: string; checks: Record<string, string> };
    expect(ready.status).toBe("ok");
    expect(ready.checks).toEqual({ network: "ok", cors: "ok" });
    // Readiness only claims categories this process actually validated; it
    // must never invent a database/queue check it does not have.
    expect(ready.checks).not.toHaveProperty("database");
    expect(ready.checks).not.toHaveProperty("queue");
  });
});
