import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runToCompletion } from "@relis/test-utils";

// Runs a REAL `next build` (through apps/web/scripts/run.mjs) with a public
// sentinel and an unrelated secret-looking sentinel in the environment,
// then inspects the actual compiled output: the public sentinel must be
// inlined into the client bundle (build-time NEXT_PUBLIC_* behavior is
// preserved), and the secret sentinel must never appear anywhere in it.
//
// See web-startup.test.ts for why `--webpack` is passed here: this
// sandbox's Turbopack cannot load its native binding under a Windows
// Application Control Policy unrelated to this change. scripts/run.mjs
// resolves and spawns `next/dist/bin/next` directly through `node` (no
// shell, no PATH/.bin lookup), so no PATH setup is needed for either build.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const webDir = path.join(repoRoot, "apps", "web");
const nextDir = path.join(webDir, ".next");

const PUBLIC_SENTINEL = "http://config-sentinel-public.example:4321";
const SECRET_SENTINEL = "supersecretpassword-should-never-leak";

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else {
      files.push(entryPath);
    }
  }
  return files;
}

let buildExitCode: number | null = null;
let buildStdout = "";
let buildStderr = "";

beforeAll(async () => {
  execSync("pnpm --filter @relis/config build", { cwd: repoRoot, stdio: "pipe" });
  rmSync(nextDir, { recursive: true, force: true });

  const result = await runToCompletion("node", ["scripts/run.mjs", "build", "--webpack"], {
    cwd: webDir,
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: PUBLIC_SENTINEL,
      // Unrelated secret-looking variable: nothing in apps/web consumes
      // DATABASE_URL. It must never end up in client output regardless.
      DATABASE_URL: `postgresql://secretuser:${SECRET_SENTINEL}@evil-host:5432/db`,
    },
    timeoutMs: 180000,
  });

  buildExitCode = result.exitCode;
  buildStdout = result.stdout;
  buildStderr = result.stderr;
}, 200000);

afterAll(() => {
  rmSync(nextDir, { recursive: true, force: true });
});

describe("apps/web real production build output", () => {
  it("completes successfully", () => {
    expect(buildExitCode, `stdout:\n${buildStdout}\nstderr:\n${buildStderr}`).toBe(0);
  });

  it("inlines the public sentinel into the client bundle", async () => {
    const files = await collectFiles(path.join(nextDir, "static"));
    let found = false;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (content.includes(PUBLIC_SENTINEL)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("never includes the secret sentinel anywhere in the build output", async () => {
    const files = await collectFiles(nextDir);
    for (const file of files) {
      const content = await readFile(file, "utf8").catch(() => "");
      expect(content, `secret sentinel leaked into ${path.relative(nextDir, file)}`).not.toContain(SECRET_SENTINEL);
    }
  });
});

// This is a SEPARATE check for the DEFAULT build (no `--webpack`), kept
// apart from the --webpack build above so the two results are always
// reported distinctly and neither can be mistaken for the other.
// apps/web/package.json is unchanged and still defaults to Turbopack (no
// bundler-default change was made, and none is authorized here).
//
// A successful default build is accepted as passing product coverage — it
// is NOT expected to fail. In THIS sandbox specifically, Turbopack cannot
// load its native binding (a Windows Application Control Policy blocks
// `@next/swc-win32-x64-msvc`), which is an environment limitation, not a
// product defect. That specific, recognizable failure is reported as
// blocked/skipped with a reason, never as a pass. Any OTHER failure (a
// different error, or no error at all with a nonzero exit) still fails the
// test loudly — this is not "accept any outcome".
describe("apps/web default (Turbopack) build", () => {
  const KNOWN_SANDBOX_LIMITATION = /Turbopack is not supported on this platform/i;
  let result: Awaited<ReturnType<typeof runToCompletion>> | undefined;

  beforeAll(async () => {
    rmSync(nextDir, { recursive: true, force: true });
    result = await runToCompletion("node", ["scripts/run.mjs", "build"], {
      cwd: webDir,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: PUBLIC_SENTINEL,
        DATABASE_URL: `postgresql://secretuser:${SECRET_SENTINEL}@evil-host:5432/db`,
      },
      timeoutMs: 180000,
    });
  }, 200000);

  afterAll(() => {
    rmSync(nextDir, { recursive: true, force: true });
  });

  it("succeeds by default, or is explicitly blocked by a recognized environment limitation", (ctx) => {
    if (!result) throw new Error("default build did not run");

    if (result.exitCode !== 0) {
      const combined = result.stdout + result.stderr;
      if (KNOWN_SANDBOX_LIMITATION.test(combined)) {
        ctx.skip(
          "Blocked: this sandbox cannot load Turbopack's native binding (Windows Application " +
            "Control Policy), unrelated to this change. apps/web/package.json is unchanged and " +
            "still defaults to Turbopack; equivalent product-behavior coverage runs separately " +
            "via --webpack above.",
        );
      }
      expect(
        result.exitCode,
        `unexpected default-build failure (not the known Turbopack limitation):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
    }

    expect(result.exitCode).toBe(0);
  });

  it("when it succeeds: inlines the public sentinel and excludes the secret sentinel", async (ctx) => {
    if (!result || result.exitCode !== 0) {
      ctx.skip("Default build did not succeed in this run — see the previous test for whether that is a known limitation or a real failure.");
      return;
    }

    const staticFiles = await collectFiles(path.join(nextDir, "static"));
    let foundPublicSentinel = false;
    for (const file of staticFiles) {
      const content = await readFile(file, "utf8");
      if (content.includes(PUBLIC_SENTINEL)) {
        foundPublicSentinel = true;
        break;
      }
    }
    expect(foundPublicSentinel).toBe(true);

    const allFiles = await collectFiles(nextDir);
    for (const file of allFiles) {
      const content = await readFile(file, "utf8").catch(() => "");
      expect(content, `secret sentinel leaked into ${path.relative(nextDir, file)}`).not.toContain(SECRET_SENTINEL);
    }
  });
});
