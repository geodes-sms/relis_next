import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runToCompletion } from "@relis/test-utils";
import type { ConfigDiagnostic } from "@relis/config";

// Spawns the REAL apps/web wrapper (scripts/run.mjs) with its `cwd` pointed
// at an ISOLATED temp fixture directory (never the real apps/web or relis/
// directories), so a .env file can introduce values without touching any
// real developer file. Node resolves "@relis/config"/"next" relative to
// run.mjs's own file location, not `cwd`, so this works unmodified.
//
// Covers:
//  1. NODE_ENV is validated AFTER loadEnvFiles(), not only from the OS
//     environment before it — a .env file introducing an invalid/empty, or
//     well-formed but CONFLICTING, NODE_ENV must be rejected before Next
//     is spawned.
//  2. .env.test.local is loaded in test mode (matching installed Next.js
//     behavior), and invalid configuration originating from it is
//     rejected before Next is spawned.
//
// Two complementary proof mechanisms are used:
//  - runWrapper(): the real wrapper's exit code and (safe, value-free)
//    stderr diagnostic — sufficient to prove REJECTION.
//  - runWrapperCapturingSpawn(): the real wrapper with
//    node:child_process.spawn intercepted (see
//    tests/fixtures/runtime-config/spawn-interceptor.cjs), which proves
//    exactly what command/args/env WOULD have been spawned, or that
//    nothing was — stronger than checking for the absence of Next's own
//    banner text, and the only way to positively prove what gets
//    forwarded on ACCEPTANCE.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const realWebDir = path.join(repoRoot, "apps", "web");
const runScriptPath = path.join(realWebDir, "scripts", "run.mjs");

let fixtureRoot: string;
let fixtureWebDir: string;

beforeAll(() => {
  execSync("pnpm --filter @relis/config build", { cwd: repoRoot, stdio: "pipe" });
}, 60000);

beforeEach(() => {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "relis-web-env-fixture-"));
  fixtureWebDir = path.join(fixtureRoot, "apps", "web");
  mkdirSync(fixtureWebDir, { recursive: true });
  // Marks fixtureRoot as the workspace root for findWorkspaceRoot(), fully
  // isolating this fixture from the real relis/ workspace root.
  writeFileSync(path.join(fixtureRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function write(dir: string, filename: string, content: string): void {
  writeFileSync(path.join(dir, filename), content);
}

function runWrapper(command: string, env: NodeJS.ProcessEnv, extraArgs: string[] = []) {
  return runToCompletion("node", [runScriptPath, command, ...extraArgs], {
    cwd: fixtureWebDir,
    env,
    timeoutMs: 10000,
  });
}

/**
 * Parses stderr as our diagnostic JSON, or returns null if it isn't one.
 * Partial<ConfigDiagnostic> (not the full type) because a malformed or
 * unrelated payload is not guaranteed to carry every field.
 */
function parseDiagnostic(stderr: string): Partial<ConfigDiagnostic> | null {
  try {
    return JSON.parse(stderr.trim());
  } catch {
    return null;
  }
}

const spawnInterceptorPath = path.join(repoRoot, "tests", "fixtures", "runtime-config", "spawn-interceptor.cjs");

interface CapturedSpawn {
  command: string;
  args: string[];
  env: { NODE_ENV?: string; WEB_PORT?: string; NEXT_PUBLIC_API_URL?: string };
}

/**
 * Runs the REAL wrapper with node:child_process.spawn intercepted (see
 * tests/fixtures/runtime-config/spawn-interceptor.cjs). A passing
 * assertion here proves exactly what would have been spawned — command,
 * args, and the relevant forwarded env vars — or that nothing was spawned
 * at all, without ever launching a real Next.js process or relying only on
 * the absence of Next's own banner text as proof.
 */
async function runWrapperCapturingSpawn(
  command: string,
  env: NodeJS.ProcessEnv,
  extraArgs: string[] = [],
): Promise<{ result: Awaited<ReturnType<typeof runToCompletion>>; captured: CapturedSpawn | null }> {
  const result = await runToCompletion(
    "node",
    ["--require", spawnInterceptorPath, runScriptPath, command, ...extraArgs],
    { cwd: fixtureWebDir, env, timeoutMs: 10000 },
  );
  const captureLine = result.stdout.split("\n").find((line) => line.startsWith("SPAWN_CAPTURED:"));
  const captured: CapturedSpawn | null = captureLine ? JSON.parse(captureLine.slice("SPAWN_CAPTURED:".length)) : null;
  return { result, captured };
}

describe("apps/web: NODE_ENV re-validated after env-file loading (isolated fixtures)", () => {
  it("rejects an invalid NODE_ENV introduced by a .env file, before Next is spawned", async () => {
    write(fixtureWebDir, ".env", "NODE_ENV=bogus-from-file\n");
    const env = { ...process.env };
    delete env.NODE_ENV;

    const result = await runWrapper("dev", env);

    expect(result.exitCode).toBe(1);
    const diagnostic = parseDiagnostic(result.stderr);
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID" });
    expect(diagnostic?.variables).toContain("NODE_ENV");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("rejects an empty NODE_ENV introduced by a .env file, before Next is spawned", async () => {
    write(fixtureWebDir, ".env", "NODE_ENV=\n");
    const env = { ...process.env };
    delete env.NODE_ENV;

    const result = await runWrapper("dev", env);

    expect(result.exitCode).toBe(1);
    const diagnostic = parseDiagnostic(result.stderr);
    expect(diagnostic?.variables).toContain("NODE_ENV");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("accepts a NODE_ENV from a .env file that MATCHES the tier-selection mode (proceeds past NODE_ENV validation)", async () => {
    // "dev" selects "development" by default; the file's value matches it.
    write(fixtureWebDir, ".env", "NODE_ENV=development\n");
    const env: Record<string, string | undefined> = { ...process.env, WEB_PORT: "not-a-number" };
    delete env.NODE_ENV;

    const result = await runWrapper("dev", env);

    // If NODE_ENV had been wrongly rejected, the diagnostic would name
    // NODE_ENV. Instead validation should proceed to the (deliberately
    // invalid) WEB_PORT, proving the file-provided NODE_ENV was accepted.
    expect(result.exitCode).toBe(1);
    const diagnostic = parseDiagnostic(result.stderr);
    expect(diagnostic?.variables).toContain("WEB_PORT");
    expect(diagnostic?.variables).not.toContain("NODE_ENV");
  });

  it("rejects a well-formed but CONFLICTING NODE_ENV introduced by a .env file, before Next is spawned", async () => {
    // "start" selects and loads "production"-tier files by default; the
    // file then sets NODE_ENV=development — a valid mode, but a different
    // one than what was already used to select which files to load.
    // Accepting it would forward "development" to Next despite production
    // files being the ones actually loaded.
    write(fixtureWebDir, ".env", "NODE_ENV=development\n");
    const env = { ...process.env };
    delete env.NODE_ENV;

    const result = await runWrapper("start", env);

    expect(result.exitCode).toBe(1);
    const diagnostic = parseDiagnostic(result.stderr);
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web" });
    expect(diagnostic?.variables).toContain("NODE_ENV");
    expect(diagnostic?.categories).toContain("runtime");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("accepts a NODE_ENV from a .env file that matches the OS-absent, command-derived default for `start` (production)", async () => {
    write(fixtureWebDir, ".env", "NODE_ENV=production\n");
    const env: Record<string, string | undefined> = { ...process.env, WEB_PORT: "not-a-number" };
    delete env.NODE_ENV;

    const result = await runWrapper("start", env);

    expect(result.exitCode).toBe(1);
    const diagnostic = parseDiagnostic(result.stderr);
    expect(diagnostic?.variables).toContain("WEB_PORT");
    expect(diagnostic?.variables).not.toContain("NODE_ENV");
  });

  it("lets a real OS NODE_ENV take precedence over a conflicting/invalid value from a .env file", async () => {
    write(fixtureWebDir, ".env", "NODE_ENV=bogus-from-file\n");
    const result = await runWrapper("dev", {
      ...process.env,
      NODE_ENV: "development",
      WEB_PORT: "not-a-number",
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = parseDiagnostic(result.stderr);
    expect(diagnostic?.variables).toContain("WEB_PORT");
    expect(diagnostic?.variables).not.toContain("NODE_ENV");
  });

});

describe("apps/web: spawn invocation captured (proves exactly what would be forwarded, without launching Next)", () => {
  // Each tier below sets DIFFERENT, individually valid WEB_PORT and
  // NEXT_PUBLIC_API_URL values so a test fails if the wrong tier were ever
  // selected. (An earlier version of the dev/start tests set the same
  // invalid port in both files, so it could not distinguish a broken tier
  // selection from a correct one — either selection produced the same
  // validation failure. `build` has no runtime port to cross-check, but it
  // DOES consume NEXT_PUBLIC_API_URL — its whole purpose is inlining
  // NEXT_PUBLIC_* values — so that variable discriminates tier selection
  // for `build` the way WEB_PORT does for `dev`/`start`.)
  function writeDistinguishableTiers() {
    write(fixtureWebDir, ".env.development", "WEB_PORT=4001\nNEXT_PUBLIC_API_URL=http://tier-development.example\n");
    write(fixtureWebDir, ".env.production", "WEB_PORT=4002\nNEXT_PUBLIC_API_URL=http://tier-production.example\n");
  }

  function envWithoutInheritedOverrides(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.NODE_ENV;
    delete env.WEB_PORT;
    delete env.NEXT_PUBLIC_API_URL;
    return env;
  }

  it("selects the development tier and forwards NODE_ENV=development for `dev` when NODE_ENV is absent", async () => {
    writeDistinguishableTiers();

    const { captured } = await runWrapperCapturingSpawn("dev", envWithoutInheritedOverrides());

    expect(captured).not.toBeNull();
    expect(captured?.env.NODE_ENV).toBe("development");
    expect(captured?.env.NEXT_PUBLIC_API_URL).toBe("http://tier-development.example");
    expect(captured?.args).toContain("4001");
    expect(captured?.args).not.toContain("4002");
  });

  it("selects the production tier and forwards NODE_ENV=production for `start` when NODE_ENV is absent", async () => {
    writeDistinguishableTiers();

    const { captured } = await runWrapperCapturingSpawn("start", envWithoutInheritedOverrides());

    expect(captured).not.toBeNull();
    expect(captured?.env.NODE_ENV).toBe("production");
    expect(captured?.env.NEXT_PUBLIC_API_URL).toBe("http://tier-production.example");
    expect(captured?.args).toContain("4002");
    expect(captured?.args).not.toContain("4001");
  });

  it("selects the production tier and forwards NODE_ENV=production for `build` when NODE_ENV is absent", async () => {
    writeDistinguishableTiers();

    const { captured } = await runWrapperCapturingSpawn("build", envWithoutInheritedOverrides());

    expect(captured).not.toBeNull();
    expect(captured?.env.NODE_ENV).toBe("production");
    expect(captured?.env.NEXT_PUBLIC_API_URL).toBe("http://tier-production.example");
  });

  it("forwards the NODE_ENV a .env file provides when it matches the tier-selection mode", async () => {
    write(fixtureWebDir, ".env", "NODE_ENV=development\n");
    const env = { ...process.env };
    delete env.NODE_ENV;

    const { captured } = await runWrapperCapturingSpawn("dev", env);

    expect(captured).not.toBeNull();
    expect(captured?.env.NODE_ENV).toBe("development");
  });

  it("forwards the real OS NODE_ENV, ignoring a conflicting value from a .env file", async () => {
    write(fixtureWebDir, ".env", "NODE_ENV=production\n");
    const env = { ...process.env, NODE_ENV: "development" };

    const { captured } = await runWrapperCapturingSpawn("dev", env);

    expect(captured).not.toBeNull();
    expect(captured?.env.NODE_ENV).toBe("development");
  });

  it("never spawns anything when a .env file provides an invalid NODE_ENV", async () => {
    write(fixtureWebDir, ".env", "NODE_ENV=bogus-from-file\n");
    const env = { ...process.env };
    delete env.NODE_ENV;

    const { result, captured } = await runWrapperCapturingSpawn("dev", env);

    expect(captured).toBeNull();
    expect(result.exitCode).toBe(1);
  });

  it("never spawns anything when a .env file provides an empty NODE_ENV", async () => {
    write(fixtureWebDir, ".env", "NODE_ENV=\n");
    const env = { ...process.env };
    delete env.NODE_ENV;

    const { result, captured } = await runWrapperCapturingSpawn("dev", env);

    expect(captured).toBeNull();
    expect(result.exitCode).toBe(1);
  });

  it("never spawns anything when a .env file provides a well-formed but CONFLICTING NODE_ENV", async () => {
    write(fixtureWebDir, ".env", "NODE_ENV=development\n");
    const env = { ...process.env };
    delete env.NODE_ENV;

    const { result, captured } = await runWrapperCapturingSpawn("start", env);

    expect(captured).toBeNull();
    expect(result.exitCode).toBe(1);
  });
});

describe("apps/web: .env.test.local is honored by the real wrapper (isolated fixtures)", () => {
  // ".env.test.local is loaded" and ".env.local is ignored" at the loader
  // level are covered directly (and more cheaply) in env-loading.test.ts's
  // "loadEnvFiles: test-mode handling" suite. This test covers what
  // specifically requires the real process boundary: invalid configuration
  // sourced from .env.test.local must be rejected before Next is spawned.
  it("loads .env.test.local in test mode and rejects invalid configuration it introduces, before Next is spawned", async () => {
    write(fixtureWebDir, ".env.test.local", "WEB_PORT=not-a-number-from-test-local\n");
    const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: "test" };
    delete env.WEB_PORT;

    const result = await runWrapper("dev", env);

    expect(result.exitCode).toBe(1);
    const diagnostic = parseDiagnostic(result.stderr);
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web" });
    expect(diagnostic?.variables).toContain("WEB_PORT");
    expect(result.stdout).not.toMatch(/Next\.js/i);
    expect(result.stdout + result.stderr).not.toContain("not-a-number-from-test-local");
  });
});
