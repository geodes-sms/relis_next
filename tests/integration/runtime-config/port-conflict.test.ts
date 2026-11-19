import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPortConflicts, loadEnvFiles, PortConflictError } from "@relis/config";
import { runToCompletion, type SpawnResult } from "@relis/test-utils";

// At the existing combined web/API startup boundary (root package.json's
// "dev" script), detect a conflicting effective listener port before
// starting either service. Neither apps/api's nor apps/web's OWN config
// loader is made aware of the other's port (see
// packages/config/src/ports.ts) — this is a single cross-cutting check,
// not a deployment orchestrator.
//
// The CLI-level tests below run against an ISOLATED temp fixture workspace
// (its own pnpm-workspace.yaml + apps/api/, apps/web/ directories), never
// against this real repository's directories, so they cannot be affected
// by — or accidentally rely on the absence of — a real local .env file.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const cliPath = path.join(repoRoot, "packages", "config", "dist", "cli.js");

describe("checkPortConflicts (in-process, pure)", () => {
  it("does not throw when API_PORT and WEB_PORT differ (defaults)", () => {
    expect(() => checkPortConflicts({}, {})).not.toThrow();
  });

  it("throws PortConflictError when both resolve to the same port", () => {
    expect(() => checkPortConflicts({ API_PORT: "4500" }, { WEB_PORT: "4500" })).toThrow(PortConflictError);
  });

  it("still reports an individual config error normally when one side is independently invalid", () => {
    expect(() => checkPortConflicts({ API_PORT: "not-a-number" }, { WEB_PORT: "3000" })).toThrow();
    expect(() => checkPortConflicts({ API_PORT: "not-a-number" }, { WEB_PORT: "3000" })).not.toThrow(
      PortConflictError,
    );
  });

  it("produces a safe diagnostic naming both variables and the network category", () => {
    try {
      checkPortConflicts({ API_PORT: "4500" }, { WEB_PORT: "4500" });
      expect.unreachable("expected checkPortConflicts to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PortConflictError);
      const diagnostic = (error as PortConflictError).toDiagnostic();
      expect(diagnostic).toEqual({
        code: "PORT_CONFLICT",
        process: "dev (api+web)",
        categories: ["network"],
        variables: ["API_PORT", "WEB_PORT"],
      });
    }
  });
});

describe("relis-config check-ports CLI — isolated fixture workspace", () => {
  let fixtureRoot: string;
  let apiDir: string;
  let webDir: string;

  beforeAll(() => {
    execSync("pnpm --filter @relis/config build", { cwd: repoRoot, stdio: "pipe" });
  }, 60000);

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "relis-port-conflict-"));
    apiDir = path.join(fixtureRoot, "apps", "api");
    webDir = path.join(fixtureRoot, "apps", "web");
    mkdirSync(apiDir, { recursive: true });
    mkdirSync(webDir, { recursive: true });
    writeFileSync(path.join(fixtureRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function write(dir: string, filename: string, content: string): void {
    writeFileSync(path.join(dir, filename), content);
  }

  function runCheckPorts(cwd: string, env: NodeJS.ProcessEnv): Promise<SpawnResult> {
    return runToCompletion("node", [cliPath, "check-ports"], { cwd, env, timeoutMs: 10000 });
  }

  it("accepts distinct effective ports", async () => {
    write(fixtureRoot, ".env", "API_PORT=3001\nWEB_PORT=3000\n");
    const result = await runCheckPorts(fixtureRoot, { ...process.env });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ code: "CONFIG_OK", process: "dev (api+web)" });
  });

  it("respects a root-level WEB_PORT override that apps/web does not itself override", async () => {
    write(fixtureRoot, ".env", "API_PORT=3001\nWEB_PORT=3005\n");
    const result = await runCheckPorts(fixtureRoot, { ...process.env });
    expect(result.exitCode).toBe(0);
  });

  it("rejects a conflict introduced by a package-level override, even though the root files alone do not conflict", async () => {
    write(fixtureRoot, ".env", "API_PORT=3001\nWEB_PORT=3000\n");
    write(webDir, ".env", "WEB_PORT=3001\n"); // apps/web overrides into apps/api's port
    const result = await runCheckPorts(fixtureRoot, { ...process.env });
    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "PORT_CONFLICT" });
    expect(diagnostic.variables).toEqual(["API_PORT", "WEB_PORT"]);
  });

  it("lets real OS environment variables (distinct) override conflicting fixture files (retaining documented precedence)", async () => {
    write(fixtureRoot, ".env", "API_PORT=3001\nWEB_PORT=3001\n"); // would conflict if the files alone were used
    const result = await runCheckPorts(fixtureRoot, { ...process.env, API_PORT: "3001", WEB_PORT: "3002" });
    expect(result.exitCode).toBe(0);
  });

  it("uses the same effective WEB_PORT the real apps/web startup path (loadEnvFiles) would resolve", async () => {
    write(fixtureRoot, ".env", "WEB_PORT=3005\n");
    write(webDir, ".env", "WEB_PORT=4321\n");

    const checkResult = await runCheckPorts(fixtureRoot, { ...process.env });
    expect(checkResult.exitCode).toBe(0); // 4321 vs. apps/api's default 3001 — no conflict

    const savedWebPort = process.env.WEB_PORT;
    delete process.env.WEB_PORT;
    try {
      loadEnvFiles("production", webDir);
      expect(process.env.WEB_PORT).toBe("4321");
    } finally {
      if (savedWebPort === undefined) delete process.env.WEB_PORT;
      else process.env.WEB_PORT = savedWebPort;
    }
  });
});
