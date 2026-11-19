import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  type ComposeProject,
  cleanupComposeProject,
  composeUp,
  getFreePort,
  isDockerAvailableSync,
  uniqueProjectName,
  waitForHealthy,
} from "@relis/test-utils";

// Real-browser verification that the actual, UNMODIFIED frontend code
// (apps/web/src/app/page.tsx's client-side checkApi(), running inside a
// genuine Chromium instance via Playwright — the prescribed e2e
// framework per context/stack.yml) successfully reaches apps/api
// THROUGH the nginx proxy, and that the corresponding UI success state
// renders.
//
// This is deliberately NOT the same proof as
// tests/integration/docker-compose/stack-smoke.test.ts's
// "[config + host-side connectivity only — NOT a browser check]" test,
// which only confirms the baked-in NEXT_PUBLIC_API_URL is correct and
// reachable via a plain Node `fetch` — it never executes the frontend's
// own browser JavaScript. THIS file does: it observes the ACTUAL network
// request the loaded page issues (via Playwright's real browser network
// stack), asserts it targets the expected proxy URL and succeeds, and
// asserts the resulting UI text the application renders on that success
// path. The application's own request is never replaced with a
// test-issued one, and the API is never mocked.
//
// Navigates to `http://localhost:<port>/`, not `http://127.0.0.1:<port>/`:
// NEXT_PUBLIC_API_URL also uses the "localhost" host (see
// docker-compose.yml), so the page and its own fetch target share the
// SAME origin in the browser's eyes (same scheme+host+port) — this is
// the whole point of routing both through one nginx origin (see
// docs/architecture/docker-compose-stack.md). Navigating to 127.0.0.1
// instead would make the page's own fetch a genuinely CROSS-origin
// request that apps/api's API_CORS_ORIGIN (set to the "localhost" origin
// — see docker-compose.yml) does not allow, causing a self-inflicted
// CORS failure unrelated to any real defect.
//
// Reuses the same isolated-Compose-project pattern as the integration
// suite (packages/test-utils/src/docker-compose.ts): a uniquely-named
// project, a real free host port for NGINX_HTTP_PORT (required — "0"
// would bake the broken "http://localhost:0/api" into NEXT_PUBLIC_API_URL
// at container start; see getFreePort's own doc comment), and cleanup
// scoped to exactly this project, reporting (not swallowing) a cleanup
// failure.
//
// Requires BOTH a reachable Docker daemon AND Playwright's Chromium
// browser actually installed (`pnpm exec playwright install chromium`
// — NOT run as part of implementing this file; see playwright.config.ts
// and the final report for this sub-issue: installing browser binaries
// is system-level software requiring separate authorization). The
// Docker-dependent group below is explicitly skipped, with a reported
// reason, when the daemon is unavailable; a missing browser is not
// separately detected here — if it's absent, Playwright's own test
// runner reports that as its own clear, specific error when this file
// actually executes.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const composeFile = path.join(repoRoot, "docker-compose.yml");

const dockerAvailable = isDockerAvailableSync();

test.describe("web health check through the proxy (real browser)", () => {
  test.skip(
    !dockerAvailable,
    "Docker is not available in this environment (or no daemon is reachable) — real browser verification was " +
      "not executed; this is a reported blocker, not a pass.",
  );

  const project: ComposeProject = { projectName: uniqueProjectName("relis-e2e"), composeFile, cwd: repoRoot };
  let nginxPort: number;

  test.beforeAll(async () => {
    // Playwright's hook timeout otherwise defaults to the global
    // `timeout` in playwright.config.ts (60s) — far shorter than the
    // work below. `test.setTimeout()`, called as the first statement
    // inside a beforeAll/afterAll, is Playwright's documented
    // hook-specific timeout mechanism: it sets THIS hook invocation's
    // own timeout only, leaving the global config and every other
    // hook/test untouched.
    //
    // Budget: composeUp's own internal cap is 300_000ms (passed below,
    // unchanged) — if that fires first, runToCompletion
    // (packages/test-utils/src/process.ts) terminates the spawned
    // `docker` process tree and CONFIRMS that termination (its own
    // "close" event) before rejecting, so nothing is left running by
    // the time it does. This is a property of a fix to runToCompletion
    // made for this sub-issue, verified on Windows only in the session
    // that made it (see that sub-issue's final report) — not something
    // that was already true of every platform beforehand, and the
    // POSIX-specific half of that fix (process-group signaling) has
    // still not been executed on Linux/macOS. waitForHealthy's default
    // per-call timeout is 120_000ms, and the three calls below run in
    // parallel (Promise.all), so their combined wait is bounded by the
    // slowest single call, not their sum. This hook's own timeout must
    // exceed BOTH stages combined so Playwright's timeout never fires
    // first — if it did, the still-running `docker compose up` process
    // would be orphaned (Playwright has no way to kill a subprocess our
    // own code spawned) and could keep creating containers after
    // afterAll's cleanup has already run. 300_000 (compose) + 120_000
    // (readiness) + 60_000 (margin) = 480_000ms.
    test.setTimeout(480000);

    nginxPort = await getFreePort();
    const env = { NGINX_HTTP_PORT: String(nginxPort) };

    // "nginx" alone is enough: its own depends_on chain starts web/api
    // too (see docker-compose.yml). Nothing here needs postgres,
    // storage, mailhog, or worker.
    const up = await composeUp(project, env, ["nginx"], { build: true, timeoutMs: 300000 });
    if (up.exitCode !== 0) {
      throw new Error(`docker compose up failed (exit ${up.exitCode}):\n${up.stdout}\n${up.stderr}`);
    }
    await Promise.all([waitForHealthy(project, "api"), waitForHealthy(project, "web"), waitForHealthy(project, "nginx")]);
  });

  test.afterAll(async () => {
    // Same hook-specific mechanism as beforeAll above. cleanupComposeProject's
    // own internal cap is 180_000ms (passed below, unchanged;
    // "docker compose down"'s existing command-level limit) — this
    // hook's timeout must exceed that so Playwright never gives up on
    // the hook while the real cleanup command is still legitimately
    // running. 180_000 + 60_000 (margin) = 240_000ms.
    test.setTimeout(240000);

    // Throws on a cleanup failure instead of ignoring it — same
    // contract as the integration suite's identical use of this helper;
    // never masks an earlier beforeAll/test failure (Playwright reports
    // hook failures as their own, separate failure). Still scoped to
    // exactly this project's own containers/network/volumes
    // (cleanupComposeProject/composeDown's own guarantee via `-p
    // <project>`), never anything else.
    await cleanupComposeProject(project, { timeoutMs: 180000 });
  });

  test("loads the app through the proxy and the browser's own client-side health request reaches the expected proxy URL and succeeds", async ({
    page,
  }) => {
    const expectedHealthUrl = `http://localhost:${nginxPort}/api/health`;

    // Set up the observation BEFORE navigating, so a fast response is
    // never missed. This is the BROWSER'S OWN request — the one
    // apps/web/src/app/page.tsx's checkApi() issues via
    // fetch(`${NEXT_PUBLIC_API_URL}/health`) on mount — observed through
    // Playwright's real network stack, not a request this test issues
    // itself and not a mocked response.
    const healthResponsePromise = page.waitForResponse((response) => response.url() === expectedHealthUrl, {
      timeout: 30000,
    });

    await page.goto(`http://localhost:${nginxPort}/`);

    const healthResponse = await healthResponsePromise;
    expect(healthResponse.status()).toBe(200);
    const healthBody = (await healthResponse.json()) as { status: string; message: string };
    expect(healthBody.status).toBe("ok");

    // The corresponding successful UI state: apps/web/src/app/page.tsx
    // renders "API connectée ✓" only once checkApi()'s fetch resolves
    // with {status: "ok"}. Asserting on the real rendered DOM the
    // application produced, not a value this test computed itself.
    await expect(page.getByText("API connectée")).toBeVisible();
  });
});
