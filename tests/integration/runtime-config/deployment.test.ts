import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runToCompletion } from "@relis/test-utils";
import { runSteps, startAndSupervise, validateDeployment } from "../../../tooling/scripts/deploy.mjs";
import type { SupervisedChild } from "../../../tooling/scripts/deploy.mjs";

// tooling/scripts/deploy.mjs is the minimal local deployment entry point:
// validate api/web/worker + the control database independently, run
// ordered steps (migrate, build, worker-once), then start and supervise
// apps/api and apps/web. This file proves:
//  - Missing/invalid deployment configuration prevents EVERY side effect
//    (real subprocess, zero spawn calls observed via interception).
//  - Validated configuration reaches the first real downstream command.
//  - A failed step prevents later steps and propagates failure (injected
//    fake steps — simulated downstream execution).
//  - Diagnostics never leak a secret/malformed value.
//  - Supervised-service cleanup on an unexpected exit, a spawn failure,
//    and a requested shutdown (injected fake child processes — simulated,
//    not real infrastructure).
//
// No real database, build, or service is used anywhere in this file.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const deployScriptPath = path.join(repoRoot, "tooling", "scripts", "deploy.mjs");
const spawnInterceptorPath = path.join(repoRoot, "tests", "fixtures", "runtime-config", "spawn-interceptor.cjs");

const SECRET_SENTINEL = "s3cr3t-should-never-leak";

const VALID_BASE_ENV = {
  API_PORT: "5101",
  WEB_PORT: "5100",
  API_CORS_ORIGIN: "http://localhost:5100",
  NEXT_PUBLIC_API_URL: "http://localhost:5101",
  CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/relis_control",
};

describe("validateDeployment (in-process)", () => {
  it("accepts a fully valid configuration and resolves each process's own effective env", () => {
    const result = validateDeployment(VALID_BASE_ENV);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected validateDeployment to succeed");
    expect(result.apiEnv.API_PORT).toBe("5101");
    expect(result.webEnv.WEB_PORT).toBe("5100");
  });

  it("rejects an invalid api configuration before anything else", () => {
    const result = validateDeployment({ ...VALID_BASE_ENV, API_PORT: "not-a-number" });
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "api" });
  });

  it("rejects a port conflict between apps/api and apps/web", () => {
    const result = validateDeployment({ ...VALID_BASE_ENV, WEB_PORT: VALID_BASE_ENV.API_PORT });
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({ code: "PORT_CONFLICT" });
  });

  it("requires CONTROL_DATABASE_URL when the migration step is not skipped", () => {
    const env: Record<string, string> = { ...VALID_BASE_ENV };
    delete env.CONTROL_DATABASE_URL;
    const result = validateDeployment(env);
    expect(result.ok).toBe(false);
    expect(result.diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "database (control)" });
  });

  it("does not require CONTROL_DATABASE_URL when migration is explicitly not a selected step", () => {
    const env: Record<string, string> = { ...VALID_BASE_ENV };
    delete env.CONTROL_DATABASE_URL;
    const result = validateDeployment(env, { skipMigrate: true });
    expect(result.ok).toBe(true);
  });

  it("never leaks a secret-looking value in its rejection diagnostic", () => {
    const result = validateDeployment({
      ...VALID_BASE_ENV,
      API_CORS_ORIGIN: `http://${SECRET_SENTINEL}@localhost:5100`,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.diagnostic)).not.toContain(SECRET_SENTINEL);
  });
});

describe("runSteps (in-process, injected fake steps — simulated downstream execution)", () => {
  it("runs every step, in order, when all succeed", async () => {
    const calls: string[] = [];
    const steps = ["a", "b", "c"].map((name) => ({
      name,
      run: vi.fn(async () => {
        calls.push(name);
        return 0;
      }),
    }));

    const result = await runSteps(steps);

    expect(result).toEqual({ ok: true, failedStep: null, exitCode: 0 });
    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("stops at the first failing step, propagates its exit code, and never runs later steps", async () => {
    const thirdStepRun = vi.fn(async () => 0);
    const steps = [
      { name: "a", run: vi.fn(async () => 0) },
      { name: "b", run: vi.fn(async () => 3) },
      { name: "c", run: thirdStepRun },
    ];

    const result = await runSteps(steps);

    expect(result).toEqual({ ok: false, failedStep: "b", exitCode: 3 });
    expect(thirdStepRun).not.toHaveBeenCalled();
  });
});

/** A minimal fake ChildProcess: an EventEmitter with a spy-able kill(). */
type FakeChild = EventEmitter & SupervisedChild;

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.signalCode = signal ?? "SIGTERM";
    queueMicrotask(() => child.emit("exit", null, child.signalCode));
  });
  return child;
}

describe("startAndSupervise (in-process, injected fake child processes — simulated, not real infrastructure)", () => {
  const services = [
    { name: "a", command: "fake-a", args: [], env: {}, cwd: "." },
    { name: "b", command: "fake-b", args: [], env: {}, cwd: "." },
  ];

  it("kills every remaining service when one exits unexpectedly, and resolves nonzero", async () => {
    const childA = createFakeChild();
    const childB = createFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);

    const { exitPromise } = startAndSupervise(services, { spawnFn });

    childA.emit("exit", 1, null);

    const exitCode = await exitPromise;
    expect(exitCode).toBe(1);
    expect(childB.kill).toHaveBeenCalled();
  });

  it("kills every remaining service when one fails to spawn, and resolves nonzero", async () => {
    const childA = createFakeChild();
    const childB = createFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);

    const { exitPromise } = startAndSupervise(services, { spawnFn });

    childA.emit("error", new Error("spawn ENOENT"));

    const exitCode = await exitPromise;
    expect(exitCode).toBe(1);
    expect(childB.kill).toHaveBeenCalled();
  });

  it("gracefully shuts down every service on request and resolves 0 once all have exited", async () => {
    const childA = createFakeChild();
    const childB = createFakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(childA).mockReturnValueOnce(childB);

    const { exitPromise, requestShutdown } = startAndSupervise(services, { spawnFn });

    requestShutdown("SIGTERM");

    expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
    expect(childB.kill).toHaveBeenCalledWith("SIGTERM");

    const exitCode = await exitPromise;
    expect(exitCode).toBe(0);
  });
});

function parseCaptured(stdout: string) {
  const line = stdout.split("\n").find((entry: string) => entry.startsWith("SPAWN_CAPTURED:"));
  return line ? JSON.parse(line.slice("SPAWN_CAPTURED:".length)) : null;
}

describe("tooling/scripts/deploy.mjs (real subprocess, no real database, build, or service)", () => {
  it("prevents every deployment side effect when configuration is invalid — zero spawn calls", async () => {
    const result = await runToCompletion("node", ["--require", spawnInterceptorPath, deployScriptPath], {
      cwd: repoRoot,
      env: { ...process.env, API_PORT: "not-a-number" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(parseCaptured(result.stdout)).toBeNull();
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "api" });
  });

  it("prevents every deployment side effect on a port conflict — zero spawn calls", async () => {
    const result = await runToCompletion("node", ["--require", spawnInterceptorPath, deployScriptPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        API_PORT: "5201",
        WEB_PORT: "5201",
        CONTROL_DATABASE_URL: "postgresql://u:p@localhost:5432/relis_control",
      },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(parseCaptured(result.stdout)).toBeNull();
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "PORT_CONFLICT" });
  });

  it("prevents every deployment side effect when CONTROL_DATABASE_URL is missing — zero spawn calls", async () => {
    const env: Record<string, string | undefined> = { ...process.env, API_PORT: "5204", WEB_PORT: "5205" };
    delete env.CONTROL_DATABASE_URL;

    const result = await runToCompletion("node", ["--require", spawnInterceptorPath, deployScriptPath], {
      cwd: repoRoot,
      env,
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(parseCaptured(result.stdout)).toBeNull();
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "database (control)" });
  });

  it("with valid configuration and every step skipped, its first spawn starts the api service with the validated env", async () => {
    const result = await runToCompletion(
      "node",
      ["--require", spawnInterceptorPath, deployScriptPath, "--skip-migrate", "--skip-build", "--skip-worker"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          API_PORT: "5202",
          WEB_PORT: "5203",
          API_CORS_ORIGIN: "http://localhost:5203",
          NEXT_PUBLIC_API_URL: "http://localhost:5202",
        },
        timeoutMs: 10000,
      },
    );

    const captured = parseCaptured(result.stdout);
    expect(captured).not.toBeNull();
    expect(captured.args.join(" ")).toContain(path.join("apps", "api", "dist", "main.js"));
    expect(captured.env.API_PORT).toBe("5202");
  });

  it("does not leak a secret-looking value in its real-process diagnostic output", async () => {
    const result = await runToCompletion("node", ["--require", spawnInterceptorPath, deployScriptPath], {
      cwd: repoRoot,
      env: { ...process.env, API_CORS_ORIGIN: `http://${SECRET_SENTINEL}@localhost:5100` },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SECRET_SENTINEL);
  });
});
