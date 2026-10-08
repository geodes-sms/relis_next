import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComposeProject,
  cleanupComposeProject,
  composePort,
  composeRun,
  composeStop,
  composeUp,
  getFreePort,
  isDockerAvailableSync,
  uniqueProjectName,
  waitForHealthy,
} from "@relis/test-utils";

// Proves behavior at a boundary that GENUINELY depends on PostgreSQL —
// migrate-control, via the real `prisma migrate deploy` command — when
// postgres becomes unavailable AFTER startup (stopped, not merely
// misconfigured; see config-validation.test.ts for the configuration
// case). This is deliberately NOT the same as a missing/invalid
// configuration case: the connection string here is valid and correctly
// addressed, but the target is unreachable.
//
// This file also explicitly asserts the documented limitation this
// sub-issue calls out: apps/api's existing GET /health and GET /ready do
// NOT detect a PostgreSQL outage, because apps/api has no database
// dependency in its code today (docs/architecture/local-stack-inventory.md
// §7) — that is expected, current behavior, not a bug introduced here,
// and this test proves it rather than merely asserting it in prose.
//
// Requires the `docker` CLI and a reachable daemon; skips (never mocks)
// when absent.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const composeFile = path.join(repoRoot, "docker-compose.yml");

const dockerAvailable = isDockerAvailableSync();

if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[docker-compose/dependency-unavailable.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon is reachable) " +
      "in this environment. This case was not executed; this is a reported blocker, not a pass.",
  );
}

describe.runIf(dockerAvailable)("dependency unavailable (postgres stopped)", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-dep-down"), composeFile, cwd: repoRoot };

  beforeAll(async () => {
    // A real free port, not the ephemeral-port placeholder "0": nginx's
    // depends_on chain starts `web` too (alongside `api`), and NGINX_HTTP_PORT
    // is baked into `web`'s NEXT_PUBLIC_API_URL at container start — "0"
    // would bake in the broken "http://localhost:0/api" even though this
    // file's own assertions never exercise the frontend (see
    // getFreePort's doc comment and stack-smoke.test.ts, which DOES
    // assert on that value).
    const env = { NGINX_HTTP_PORT: String(await getFreePort()) };

    // Explicitly include "postgres": nginx's own depends_on chain only
    // reaches web/api (neither of which depends on postgres — see
    // docker-compose.yml), so `up(["nginx"])` alone would never start
    // postgres at all, making the later waitForHealthy(postgres) hang
    // until its own timeout waiting on a container that was never
    // created. Listing it explicitly here is the fix for that.
    const up = await composeUp(project, env, ["nginx", "postgres"], { build: true, timeoutMs: 300000 });
    if (up.exitCode !== 0) {
      throw new Error(`docker compose up failed (exit ${up.exitCode}):\n${up.stdout}\n${up.stderr}`);
    }

    // Verify postgres is GENUINELY up and ready before stopping it —
    // otherwise "stop" would prove nothing about availability actually
    // transitioning from up to down.
    await waitForHealthy(project, "postgres");
    await Promise.all([waitForHealthy(project, "api"), waitForHealthy(project, "nginx")]);

    const stop = await composeStop(project, ["postgres"]);
    if (stop.exitCode !== 0) {
      throw new Error(`docker compose stop postgres failed:\n${stop.stderr}`);
    }
  }, 300000);

  afterAll(async () => {
    // See stack-smoke.test.ts's identical comment: throws (with the
    // exit code/output) on a cleanup failure instead of ignoring it;
    // never masks an earlier setup/test failure, since Vitest reports
    // hook failures independently.
    await cleanupComposeProject(project, { timeoutMs: 180000 });
  }, 180000);

  it("fails migrate-control with an actual database-connectivity error (valid config, unreachable target)", async () => {
    const result = await composeRun(
      project,
      "migrate-control",
      {},
      {
        command: ["sh", "-c", "pnpm --filter @relis/config build && pnpm --filter @relis/database run migrate control"],
        timeoutMs: 120000,
      },
    );
    const combinedOutput = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).not.toBe(0);
    // This is a connectivity failure, not our own configuration
    // validation — the CONFIG_INVALID diagnostic path is not what
    // reports it (see config-validation.test.ts for that path instead).
    expect(combinedOutput).not.toContain("CONFIG_INVALID");
    // Must actually be a database-connectivity failure, not merely "some
    // nonzero exit" (which could just as easily be an unrelated crash).
    // Prisma's real `migrate deploy` CLI reports an unreachable server
    // with its own P1001 error code; ECONNREFUSED/"reach database
    // server" are included as resilient fallbacks in case the exact
    // Prisma error-code text differs across versions — this was not
    // executed against a real Prisma CLI in this environment (Docker is
    // unavailable here), so the exact match could not be confirmed.
    expect(combinedOutput).toMatch(/P1001|ECONNREFUSED|reach database server|connection refused/i);
  }, 120000);

  it("does NOT have apps/api's health/readiness detect the outage — current, honest limitation", async () => {
    const proxyPort = await composePort(project, "nginx", 80);

    const health = await fetch(`http://127.0.0.1:${proxyPort}/api/health`);
    expect(health.status).toBe(200);

    const ready = await fetch(`http://127.0.0.1:${proxyPort}/api/ready`);
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as { status: string; checks: Record<string, string> };
    // Still reports "ok" with only network/cors checks, even though
    // postgres is stopped — apps/api has no database dependency in its
    // code to report on. Asserting this PASSES today; it documents the
    // gap rather than failing because of it.
    expect(readyBody.status).toBe("ok");
    expect(readyBody.checks).toEqual({ network: "ok", cors: "ok" });
  });
});

describe.skipIf(dockerAvailable)("dependency unavailable (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
