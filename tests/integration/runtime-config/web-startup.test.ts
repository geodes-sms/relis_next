import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnLongRunning, runToCompletion, type LongRunningProcess } from "@relis/test-utils";

// Spawns the REAL apps/web wrapper (scripts/run.mjs), which is what
// package.json's dev/build/start scripts invoke, to prove invalid public
// config is rejected before Next.js is even spawned, that valid config
// reaches a real Next.js dev server, and that a CLI port override is
// resolved (with the correct precedence) before validation, then forwarded
// as exactly one canonical `-p` argument.
//
// scripts/run.mjs spawns Next by resolving `next/dist/bin/next` and
// invoking it directly through `node` with an argument array (no shell),
// so no PATH/`.bin` setup is needed here.
//
// This sandbox's Turbopack (Next 16's default) fails to load its native
// binding under a Windows Application Control Policy unrelated to this
// change (`@next/swc-win32-x64-msvc` blocked; only WASM bindings load, and
// Turbopack requires native bindings). Tests that need a real running dev
// server pass `--webpack` through to Next purely to route around that
// sandbox restriction; apps/web/package.json itself is unchanged and still
// defaults to Turbopack — see web-build-output.test.ts for the separate,
// explicitly-labeled default-Turbopack-build limitation.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const webDir = path.join(repoRoot, "apps", "web");

let runningProcess: LongRunningProcess | undefined;

beforeAll(() => {
  execSync("pnpm --filter @relis/config build", { cwd: repoRoot, stdio: "pipe" });
}, 60000);

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

describe("apps/web real startup (scripts/run.mjs)", () => {
  it("rejects an invalid NEXT_PUBLIC_API_URL and never spawns Next.js", async () => {
    const port = 3910;
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev"], {
      cwd: webDir,
      env: {
        ...process.env,
        WEB_PORT: String(port),
        NEXT_PUBLIC_API_URL: "http://user:pass@localhost:3001",
      },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web (public)" });
    expect(diagnostic.variables).toContain("NEXT_PUBLIC_API_URL");
    expect(result.stdout + result.stderr).not.toContain("pass@localhost");
    expect(result.stdout).not.toMatch(/Next\.js/i);
    expect(await isPortOpen(port)).toBe(false);
  });

  it("rejects an invalid WEB_PORT and never spawns Next.js", async () => {
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev"], {
      cwd: webDir,
      env: { ...process.env, WEB_PORT: "not-a-port" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web" });
    expect(diagnostic.variables).toContain("WEB_PORT");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("rejects an explicitly empty WEB_PORT instead of silently defaulting", async () => {
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev"], {
      cwd: webDir,
      env: { ...process.env, WEB_PORT: "" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("reaches a real Next.js dev server on the configured WEB_PORT with valid configuration", async () => {
    const port = 3911;
    runningProcess = spawnLongRunning("node", ["scripts/run.mjs", "dev", "--webpack"], {
      cwd: webDir,
      env: {
        ...process.env,
        WEB_PORT: String(port),
        NEXT_PUBLIC_API_URL: "http://localhost:3001",
      },
    });

    await runningProcess.waitForOutput((combined) => /Ready in/i.test(combined), 45000);
    expect(runningProcess.stdout() + runningProcess.stderr()).toContain(`localhost:${port}`);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
  });
});

describe("apps/web runtime mode validation", () => {
  it("rejects an explicitly invalid NODE_ENV and never spawns Next.js", async () => {
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev"], {
      cwd: webDir,
      env: { ...process.env, NODE_ENV: "bogus-mode" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web" });
    expect(diagnostic.variables).toContain("NODE_ENV");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("rejects an explicitly empty NODE_ENV instead of silently defaulting", async () => {
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev"], {
      cwd: webDir,
      env: { ...process.env, NODE_ENV: "" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic.variables).toContain("NODE_ENV");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("accepts a valid explicit NODE_ENV and still reaches Next.js", async () => {
    const port = 3920;
    runningProcess = spawnLongRunning("node", ["scripts/run.mjs", "dev", "--webpack"], {
      cwd: webDir,
      env: { ...process.env, NODE_ENV: "development", WEB_PORT: String(port), NEXT_PUBLIC_API_URL: "http://localhost:3001" },
    });

    await runningProcess.waitForOutput((combined) => /Ready in/i.test(combined), 45000);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
  });
});

describe("apps/web CLI port override resolution", () => {
  it("uses a valid CLI --port override even when WEB_PORT is invalid, and never forwards two port flags", async () => {
    const port = 3912;
    runningProcess = spawnLongRunning("node", ["scripts/run.mjs", "dev", "--webpack", "--port", String(port)], {
      cwd: webDir,
      env: { ...process.env, WEB_PORT: "not-a-port", NEXT_PUBLIC_API_URL: "http://localhost:3001" },
    });

    await runningProcess.waitForOutput((combined) => /Ready in/i.test(combined), 45000);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
  });

  it("rejects an invalid CLI --port override even when WEB_PORT is valid", async () => {
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev", "--port", "not-a-number"], {
      cwd: webDir,
      env: { ...process.env, WEB_PORT: "3000" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web" });
    expect(diagnostic.variables).toContain("WEB_PORT");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("rejects a trailing --port with no value and never spawns Next.js", async () => {
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev", "--port"], {
      cwd: webDir,
      env: { ...process.env, WEB_PORT: "3000" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web" });
    expect(diagnostic.variables).toContain("WEB_PORT");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("rejects a trailing -p with no value and never spawns Next.js", async () => {
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev", "-p"], {
      cwd: webDir,
      env: { ...process.env, WEB_PORT: "3000" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("rejects an empty --port= and never spawns Next.js", async () => {
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev", "--port="], {
      cwd: webDir,
      env: { ...process.env, WEB_PORT: "3000" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic.variables).toContain("WEB_PORT");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("rejects --port immediately followed by another option, instead of consuming the option's name as the port value", async () => {
    const result = await runToCompletion("node", ["scripts/run.mjs", "dev", "--port", "--webpack"], {
      cwd: webDir,
      env: { ...process.env, WEB_PORT: "3000" },
      timeoutMs: 10000,
    });

    expect(result.exitCode).toBe(1);
    const diagnostic = JSON.parse(result.stderr.trim());
    expect(diagnostic).toMatchObject({ code: "CONFIG_INVALID", process: "web" });
    expect(diagnostic.variables).toContain("WEB_PORT");
    expect(result.stdout).not.toMatch(/Next\.js/i);
  });

  it("uses the LAST of repeated --port flags", async () => {
    const port = 3913;
    runningProcess = spawnLongRunning(
      "node",
      ["scripts/run.mjs", "dev", "--webpack", "--port", "9999", "--port", String(port)],
      {
        cwd: webDir,
        env: { ...process.env, NEXT_PUBLIC_API_URL: "http://localhost:3001" },
      },
    );

    await runningProcess.waitForOutput((combined) => /Ready in/i.test(combined), 45000);
    expect(await isPortOpen(9999)).toBe(false);

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
  });
});
