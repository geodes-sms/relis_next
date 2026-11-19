import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComposeProject,
  cleanupComposeProject,
  composeExec,
  composeLogs,
  composePort,
  composeUp,
  createBucket,
  getContainerStatus,
  getFreePort,
  getS3Object,
  isDockerAvailableSync,
  putS3Object,
  uniqueProjectName,
  waitForExitCode,
  waitForHealthy,
  waitForHttpOk,
} from "@relis/test-utils";

// Real, disposable-stack smoke check for ALL seven service
// responsibilities (see docker-compose.yml's header comment). Proves,
// against actual running containers (never mocks):
//   - web, api, worker, postgres, nginx, mailhog, and storage all start
//     as real processes/containers and (where a healthcheck exists)
//     report healthy.
//   - migrate-control / migrate-project ACTUALLY exit 0 (via
//     `docker inspect`'s real State.ExitCode, not "a database with the
//     right name exists" — docker/postgres/init/ creates both databases
//     unconditionally regardless of whether either migration ever runs),
//     AND provision two DISTINCT, isolated disposable databases
//     (Control DB + project-test target) — isolation verified by
//     creating a table in one and confirming its absence in the other.
//   - The browser-facing path works THROUGH the proxy only: apps/api's
//     port is never published; /health and /ready are only reached via
//     nginx's /api/ prefix. The frontend's OWN configured
//     NEXT_PUBLIC_API_URL is read back from the real running `web`
//     container (not assumed), and a plain Node `fetch` to that same URL
//     succeeds through the proxy. This is a CONFIGURATION and
//     HOST-SIDE-CONNECTIVITY proof only — it does not execute the
//     frontend's own browser JavaScript, so it is not evidence that a
//     real browser's request succeeds or that the UI reaches its success
//     state. That claim belongs to, and is proved by,
//     tests/e2e/docker-compose/web-health-check.spec.ts (a real
//     Playwright browser), not this file.
//   - apps/worker's existing `dev` process (tsx watch) is actually
//     running (watcher liveness) and completed its own startup/config
//     path (its log line) — explicitly NOT claimed as job processing;
//     no queue consumer exists or is added here.
//   - MailHog's root page and message-listing API ARE MailHog's own
//     mail-capture interface (local sub-issue 02.05) — checked via its
//     distinctive `<title>MailHog</title>`/`ng-app="mailhogApp"` markup
//     and its exact `{total,count,start,items}` API shape, not merely a
//     generic HTTP 200 (which any server would satisfy). Not exercised
//     through the application: no mail adapter exists in apps/api or
//     apps/worker today, so `items` is correctly empty.
//   - A real SeaweedFS S3-gateway upload/download round-trip, signed
//     with the development-only credentials in
//     docker/storage/s3-identities.json — NOT merely "the container
//     started." The SigV4 signer itself (packages/test-utils/src/s3-sigv4.ts)
//     was not previously executed against a live server; this is its
//     first real exercise.
//
// Uses a uniquely-named Compose project. NGINX_HTTP_PORT is a REAL free
// port chosen with getFreePort() BEFORE `up` (not the host-port-0
// "discover afterward" pattern used for MAILHOG_UI_PORT/SEAWEEDFS_S3_PORT
// below — see getFreePort's own doc comment for why NGINX_HTTP_PORT is
// different: it is baked into NEXT_PUBLIC_API_URL at container start, so
// "0" would bake in the broken "http://localhost:0/api"). This never
// collides with an already-running dev stack. Tears down (containers +
// volumes) for THIS project only in afterAll — never touches unrelated
// containers.
//
// Does NOT assert anything about job processing (apps/worker has no
// queue consumer in either mode — see docker-compose.yml's comment) and
// does NOT expect apps/api's static /ready to detect a database outage
// (see dependency-unavailable.test.ts for that boundary instead).
//
// Requires the `docker` CLI and a reachable daemon; skips (never mocks)
// when absent.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const composeFile = path.join(repoRoot, "docker-compose.yml");

const STORAGE_CREDENTIALS = { accessKey: "relis-dev-access", secretKey: "relis-dev-secret-key-local-only" };
const TEST_BUCKET = "relis-smoke-test";
const TEST_KEY = `smoke-${Date.now()}.txt`;
const TEST_BODY = Buffer.from(`relis compose smoke check ${new Date().toISOString()}`, "utf8");

// Computed synchronously at module/collection time — see
// isDockerAvailableSync's own doc comment for why an async check in a
// beforeAll cannot gate describe.runIf/skipIf correctly.
const dockerAvailable = isDockerAvailableSync();

if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[docker-compose/stack-smoke.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon is reachable) " +
      "in this environment. No real container startup was verified; this is a reported blocker, not a pass.",
  );
}

describe.runIf(dockerAvailable)("disposable stack smoke check", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-smoke"), composeFile, cwd: repoRoot };

  let nginxPort: number;
  let migrateControlExitCode: number;
  let migrateProjectExitCode: number;

  beforeAll(async () => {
    // NGINX_HTTP_PORT must be a REAL port chosen before `up`, not the
    // ephemeral-port placeholder "0": it is baked directly into
    // NEXT_PUBLIC_API_URL on the `web` service at container start (see
    // docker-compose.yml), so passing "0" through unresolved would bake
    // the broken "http://localhost:0/api" into the running container —
    // see getFreePort's own doc comment for why this differs from
    // MAILHOG_UI_PORT/SEAWEEDFS_S3_PORT below (neither is read by any
    // application code, so discovering their real port AFTER `up` is
    // fine for those two).
    nginxPort = await getFreePort();
    const env = {
      NGINX_HTTP_PORT: String(nginxPort),
      MAILHOG_UI_PORT: "0",
      SEAWEEDFS_S3_PORT: "0",
      PROJECT_TEST_DB_NAME: "relis_project_smoke_test",
    };

    const up = await composeUp(project, env, [], { build: true, timeoutMs: 600000 });
    if (up.exitCode !== 0) {
      throw new Error(`docker compose up failed (exit ${up.exitCode}):\n${up.stdout}\n${up.stderr}`);
    }
    await Promise.all([
      waitForHealthy(project, "postgres"),
      waitForHealthy(project, "api"),
      waitForHealthy(project, "web"),
      waitForHealthy(project, "nginx"),
      waitForHealthy(project, "storage"),
    ]);
    // mailhog has no Compose healthcheck (see docker-compose.yml) — poll
    // its own HTTP port from the test side instead.
    const mailhogPort = await composePort(project, "mailhog", 8025);
    await waitForHttpOk(`http://127.0.0.1:${mailhogPort}/`);

    // Block until both one-shot migration containers have actually
    // EXITED (not merely "a database with the right name exists" — see
    // the dedicated test below for why that is a different, insufficient
    // claim) before any test runs, so later assertions never race a
    // still-running migration.
    [migrateControlExitCode, migrateProjectExitCode] = await Promise.all([
      waitForExitCode(project, "migrate-control"),
      waitForExitCode(project, "migrate-project"),
    ]);
  }, 600000);

  afterAll(async () => {
    // Throws (reporting the exact exit code/output) if cleanup itself
    // fails, instead of silently leaving this project's containers,
    // network, or volumes behind. If a setup/test step already failed,
    // Vitest records that failure independently of whatever this hook
    // does — a cleanup failure here is reported as an ADDITIONAL
    // failure, never a replacement for it.
    await cleanupComposeProject(project, { timeoutMs: 180000 });
  }, 180000);

  it("provisions two distinct, isolated disposable databases", async () => {
    const createTable = await composeExec(project, "postgres", [
      "psql",
      "-U",
      "relis",
      "-d",
      "relis_control",
      "-c",
      "CREATE TABLE smoke_marker (id int);",
    ]);
    expect(createTable.exitCode, createTable.stderr).toBe(0);

    const controlHasTable = await composeExec(project, "postgres", [
      "psql",
      "-U",
      "relis",
      "-d",
      "relis_control",
      "-tAc",
      "SELECT to_regclass('public.smoke_marker') IS NOT NULL;",
    ]);
    expect(controlHasTable.stdout.trim()).toBe("t");

    // The table created in relis_control must NOT be visible from the
    // project-test database — this is the actual isolation proof, not
    // just two differently-named databases existing.
    const projectHasTable = await composeExec(project, "postgres", [
      "psql",
      "-U",
      "relis",
      "-d",
      "relis_project_smoke_test",
      "-tAc",
      "SELECT to_regclass('public.smoke_marker') IS NULL;",
    ]);
    expect(projectHasTable.stdout.trim()).toBe("t");
  });

  it("runs migrate-control and migrate-project to completion with real exit code 0", () => {
    // NOT the same claim as "the database exists" (see the isolation
    // test above, and docker/postgres/init/ which creates BOTH databases
    // unconditionally on first init, independently of whether either
    // migration container ever runs or succeeds). migrateControlExitCode
    // / migrateProjectExitCode come from `docker inspect`'s real
    // State.ExitCode (waitForExitCode, in beforeAll) — the actual outcome
    // of `pnpm --filter @relis/database run migrate <target>`, not a
    // proxy for it.
    expect(migrateControlExitCode).toBe(0);
    expect(migrateProjectExitCode).toBe(0);
  });

  it("reaches apps/api's health and readiness ONLY through the nginx proxy", async () => {
    const health = await fetch(`http://127.0.0.1:${nginxPort}/api/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { status: string };
    expect(healthBody.status).toBe("ok");

    const ready = await fetch(`http://127.0.0.1:${nginxPort}/api/ready`);
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as { status: string; checks: Record<string, string> };
    expect(readyBody.status).toBe("ok");
    // Matches apps/api/src/app.ts's actual, honest readiness contract: it
    // only reports network/cors, never a database/queue it does not have.
    expect(readyBody.checks).toEqual({ network: "ok", cors: "ok" });
  });

  it("serves the web app through the same proxy origin as the API (browser-public address)", async () => {
    const page = await fetch(`http://127.0.0.1:${nginxPort}/`);
    expect(page.status).toBe(200);
  });

  it("[config + host-side connectivity only — NOT a browser check] gives the frontend a real NEXT_PUBLIC_API_URL, and that URL is independently reachable through the proxy via plain Node fetch", async () => {
    // IMPORTANT — what this test does and does NOT prove:
    // It reads the ACTUAL NEXT_PUBLIC_API_URL the running `web` container
    // was given (ground truth, not an assumption) and then issues its
    // OWN plain Node `fetch`, from the test process, to the same URL the
    // browser WOULD use. That proves (a) the baked-in configuration is
    // correct (the real nginx port, never the ephemeral-port placeholder
    // "0" that NGINX_HTTP_PORT=0 would otherwise leak into it — see
    // getFreePort's doc comment) and (b) that URL is genuinely reachable
    // through the proxy from outside the Compose network.
    // It does NOT prove a real browser's JavaScript execution ever makes
    // this request, nor that the resulting UI reaches its success state.
    // That is a DIFFERENT claim, proved separately — with an actual
    // browser, observing the actual request the page's own client code
    // issues, and the resulting UI — by
    // tests/e2e/docker-compose/web-health-check.spec.ts.
    const envResult = await composeExec(project, "web", ["sh", "-c", "printenv NEXT_PUBLIC_API_URL"]);
    expect(envResult.exitCode, envResult.stderr).toBe(0);
    const configuredApiUrl = envResult.stdout.trim();
    expect(configuredApiUrl).toBe(`http://localhost:${nginxPort}/api`);
    expect(configuredApiUrl).not.toContain(":0/");

    // A plain Node-side fetch to the same URL — a host-side connectivity
    // check, not a substitute for the browser actually issuing it.
    const response = await fetch(`${configuredApiUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("runs the worker's existing dev process (tsx watch) and completes its config/startup path — not evidence of job processing", async () => {
    // "running" here is the tsx watch SUPERVISOR staying alive after the
    // wrapped script's own log-and-return (see docker-compose.yml's
    // comment and docs/architecture/local-stack-inventory.md §3.3) — it
    // is watcher liveness, not a job being processed. No queue consumer
    // is added or implied by this assertion.
    const status = await getContainerStatus(project, "worker");
    expect(status).toBe("running");

    // Proves loadWorkerConfig() actually succeeded and main() executed
    // its startup path (not merely that the container didn't crash on
    // the way up) — apps/worker/src/main.ts's own log line.
    const logs = await composeLogs(project, "worker");
    expect(logs.stdout).toContain("ReLiS worker started");
  });

  it("serves MailHog's OWN mail-capture interface — not merely an arbitrary HTTP 200", async () => {
    // Local sub-issue 02.05: a bare `200` from this port is not evidence
    // it is actually MailHog — any web server would satisfy that. Two
    // independent, MailHog-SPECIFIC signals are checked instead, each
    // confirmed by direct inspection of a real `mailhog/mailhog:v1.0.1`
    // container during this task:
    const mailhogPort = await composePort(project, "mailhog", 8025);

    // 1. The root page is MailHog's own Angular UI shell — its <title>
    // and navbar brand both read "MailHog" (apps/web's homepage, the only
    // other UI this stack serves, has neither).
    const ui = await fetch(`http://127.0.0.1:${mailhogPort}/`);
    expect(ui.status).toBe(200);
    const uiBody = await ui.text();
    expect(uiBody).toContain("<title>MailHog</title>");
    expect(uiBody).toContain('ng-app="mailhogApp"');

    // 2. MailHog's own message-listing API returns its distinctive JSON
    // shape ({total, count, start, items}) — a contract specific to
    // MailHog's real API, not a generic page. Also proves it is
    // functioning as a mail CAPTURE interface (a queryable inbox), not
    // just a static page that happens to look like one. An empty `items`
    // array here is expected and correct: nothing has been sent to it in
    // this test (apps/api/apps/worker have no mail adapter — see "Known
    // limitations" — so this is deliberately NOT exercised through the
    // application), not a sign of malfunction.
    const api = await fetch(`http://127.0.0.1:${mailhogPort}/api/v2/messages`);
    expect(api.status).toBe(200);
    const inbox = (await api.json()) as { total: number; count: number; start: number; items: unknown[] };
    expect(inbox).toEqual({ total: 0, count: 0, start: 0, items: [] });
  });

  it("performs a real, credentialed object-storage upload and download round-trip", async () => {
    const storagePort = await composePort(project, "storage", 8333);
    const target = { endpoint: `http://127.0.0.1:${storagePort}`, bucket: TEST_BUCKET, key: TEST_KEY };

    // Disposable bucket setup: issued explicitly rather than relying on
    // SeaweedFS's own auto-vivify-on-first-PUT convenience, which is not
    // part of the S3 API contract (see createBucket's doc comment).
    const createBucketResponse = await createBucket(target, STORAGE_CREDENTIALS);
    expect(createBucketResponse.status, await createBucketResponse.text().catch(() => "")).toBeLessThan(300);

    const putResponse = await putS3Object(target, STORAGE_CREDENTIALS, TEST_BODY);
    expect(putResponse.status, await putResponse.text().catch(() => "")).toBeLessThan(300);

    const getResponse = await getS3Object(target, STORAGE_CREDENTIALS);
    expect(getResponse.status).toBe(200);
    const roundTripped = Buffer.from(await getResponse.arrayBuffer());
    expect(roundTripped.equals(TEST_BODY)).toBe(true);
  });
});

describe.skipIf(dockerAvailable)("disposable stack smoke check (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
