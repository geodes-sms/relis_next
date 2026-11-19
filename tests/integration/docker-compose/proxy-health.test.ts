import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComposeProject,
  assertProvisioningSafety,
  cleanupDisposableTargets,
  composeStart,
  composeStop,
  composeUp,
  createComposeCleanupTarget,
  getFreePort,
  isDockerAvailableSync,
  listAllVolumeNames,
  resolveComposePersistence,
  uniqueProjectName,
  waitForHealthy,
  waitForHttpStatus,
} from "@relis/test-utils";

// Local sub-issue 02.04 — "Expose health/readiness through the local
// proxy and restrict database and storage port exposure." This file
// covers AC1 (proxy readiness/failure probing); see port-exposure.test.ts
// for AC2 (safe port exposure).
//
// apps/api's existing GET /health and GET /ready (apps/api/src/app.ts)
// are reused UNCHANGED. Their actual, honest contract — verified by
// reading that file, not assumed — is:
//   - /health: 200 { status: "ok", message: "...", service: "api" }.
//   - /ready: 200 { status: "ok", service: "api", checks: { network: "ok", cors: "ok" } }.
//     This reports only network/CORS initialization, NEVER a database or
//     queue dependency, because apps/api has neither in code today (see
//     dependency-unavailable.test.ts, which proves this separately for a
//     stopped PostgreSQL). This file does not invent a different
//     readiness contract; it proves the EXISTING one survives the proxy,
//     and proves the proxy's OWN behavior when apps/api itself — the
//     proxied upstream, not a downstream dependency of it — is
//     unreachable.
//
// Brings up only `nginx` (which pulls in `web`/`api` via depends_on —
// see docker-compose.yml); `postgres`/`migrate-*`/`worker`/`storage`/
// `mailhog` are not needed for this file's assertions and are left out to
// keep this suite fast and focused.
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
    "[docker-compose/proxy-health.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon is reachable) " +
      "in this environment. Proxy health/readiness behavior was not verified; this is a reported blocker, not a pass.",
  );
}

describe.runIf(dockerAvailable)("nginx proxy health/readiness", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-proxy-health"), composeFile, cwd: repoRoot };

  let nginxPort: number;
  let composeEnv: Record<string, string>;
  /** Volumes that already existed on the daemon before this test ran — must all survive it. See sub-issue 02.03's guarded-cleanup contract. */
  let baselineVolumeNames: string[] = [];

  beforeAll(async () => {
    // A real free port, not the ephemeral "0" placeholder: baked into
    // `web`'s NEXT_PUBLIC_API_URL at container start (see
    // docker-compose.yml and getFreePort's own doc comment) — this file
    // doesn't assert on that value directly, but an invalid baked-in URL
    // would still leave `web` itself servable, which is exercised below.
    nginxPort = await getFreePort();
    composeEnv = { NGINX_HTTP_PORT: String(nginxPort) };

    // Baseline FIRST, before anything is provisioned — see
    // persistence.test.ts (sub-issue 02.03) for why: the post-cleanup
    // "nothing unrelated was destroyed" check needs a genuinely
    // untouched snapshot, and the safety gate immediately below needs
    // one to compare against. This suite starts only `nginx`
    // (web/api via depends_on) — neither mounts the project's two named
    // volumes (`postgres-data`/`storage-data`), so no volume is actually
    // expected to be created — but the SAME guarded gate/cleanup
    // contract applies regardless, rather than bypassing it because
    // "this one shouldn't create anything."
    baselineVolumeNames = await listAllVolumeNames();

    const resolved = await resolveComposePersistence(project, composeEnv);
    // Hard safety gate — BEFORE a single container is created: the
    // resolved configuration must be genuinely disposable (volume names
    // scoped to this project, no `external: true`, nothing already on
    // the daemon under these exact names). Throws and stops short of
    // provisioning anything if it fails.
    assertProvisioningSafety(resolved, baselineVolumeNames);

    const up = await composeUp(project, composeEnv, ["nginx"], { build: true, timeoutMs: 300000 });
    if (up.exitCode !== 0) {
      throw new Error(`docker compose up failed (exit ${up.exitCode}):\n${up.stdout}\n${up.stderr}`);
    }
    await Promise.all([waitForHealthy(project, "api"), waitForHealthy(project, "web"), waitForHealthy(project, "nginx")]);
  }, 300000);

  afterAll(async () => {
    // Guarded cleanup (sub-issue 02.03's contract), not a bare
    // `cleanupComposeProject`: `createComposeCleanupTarget` re-resolves
    // the exact configured volume names FRESH (never a cached value) and
    // unions them with whatever the daemon's own `com.docker.compose.project`
    // label filter additionally reports, then `cleanupDisposableTargets`
    // re-verifies ownership for every one of them immediately before any
    // deletion — never relying on the safety gate run in `beforeAll`.
    // `composeEnv` is passed through unchanged so configuration
    // resolution, the original `up`, and this cleanup all resolve the
    // SAME configuration. A failure discovering volumes (fails closed)
    // or an ownership refusal blocks the destructive step for this
    // target and falls back to removing only containers/network — always
    // safe, since those belong solely to this project.
    const target = await createComposeCleanupTarget(project, composeEnv, baselineVolumeNames);
    const [outcome] = await cleanupDisposableTargets([target]);

    // Report a cleanup failure as its OWN failure — Vitest already
    // reports a hook failure separately from any earlier test/beforeAll
    // failure, so this never hides or replaces the original cause.
    const problems: string[] = [];
    if (outcome.error) {
      problems.push(`cleanup of "${outcome.label}" failed: ${outcome.error}`);
    }
    if (outcome.volumesRequiringManualInspection.length > 0) {
      problems.push(
        `volume(s) were NOT deleted — ownership could not be established, and they require manual inspection: ` +
          outcome.volumesRequiringManualInspection.map((v) => `${v.name} (${v.reason})`).join("; "),
      );
    }
    if (problems.length > 0) {
      throw new Error(`Cleanup did not complete correctly:\n- ${problems.join("\n- ")}`);
    }
  }, 180000);

  it("proxies GET /api/health and GET /api/ready to apps/api's existing routes, preserving status and body", async () => {
    const health = await fetch(`http://127.0.0.1:${nginxPort}/api/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { status: string; service: string };
    expect(healthBody.status).toBe("ok");
    expect(healthBody.service).toBe("api");

    const ready = await fetch(`http://127.0.0.1:${nginxPort}/api/ready`);
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as { status: string; checks: Record<string, string> };
    expect(readyBody.status).toBe("ok");
    // The existing, honest contract: network/CORS only — never a
    // fabricated database/queue check.
    expect(readyBody.checks).toEqual({ network: "ok", cors: "ok" });
  });

  it("keeps /nginx-health reporting the PROXY's own liveness, independent of the API's readiness contract", async () => {
    const nginxHealth = await fetch(`http://127.0.0.1:${nginxPort}/nginx-health`);
    expect(nginxHealth.status).toBe(200);
    expect((await nginxHealth.text()).trim()).toBe("ok");
    // This is NOT application readiness — it says nothing about apps/api,
    // the database, or the worker, and the two routes below prove that
    // distinction by both failing independently of this one while the API
    // upstream is down.
  });

  describe("API upstream unavailable", () => {
    beforeAll(async () => {
      const stop = await composeStop(project, ["api"]);
      if (stop.exitCode !== 0) {
        throw new Error(`docker compose stop api failed:\n${stop.stderr}`);
      }
    }, 30000);

    // Restores the upstream for every later test/describe in this file
    // (there is only one more, but this keeps the suite order-independent)
    // and specifically for the "recovery" test below.
    afterAll(async () => {
      const start = await composeStart(project, ["api"]);
      if (start.exitCode !== 0) {
        throw new Error(`docker compose start api failed:\n${start.stderr}`);
      }
    }, 60000);

    it("returns a non-success response through the proxy — never a false-healthy 200, and never the web page", async () => {
      // Verified by real execution: `proxy_pass http://api:3001/;` uses a
      // static hostname, so nginx resolves and caches "api"'s IP only
      // once, at its own startup — it does not re-resolve per request.
      // After `docker compose stop api`, that cached IP is no longer
      // reachable, and packets toward it are silently dropped rather than
      // refused — so nginx hits its OWN default `proxy_connect_timeout`
      // (60s, unset in this minimal dev config — see docker/nginx/nginx.conf)
      // before giving up with 504 Gateway Timeout, rather than an
      // immediate 502. This test's own timeout is raised accordingly
      // (below) instead of assuming an instant failure.
      const health = await fetch(`http://127.0.0.1:${nginxPort}/api/health`);
      expect(health.status).toBeGreaterThanOrEqual(500);
      expect(health.status).toBeLessThan(600);
      expect(health.ok).toBe(false);

      const healthBody = await health.text();
      // Must never be apps/web's rendered homepage (its unique copy —
      // apps/web/src/app/page.tsx — not present anywhere else) and must
      // never be a 200 "ok" JSON body either.
      expect(healthBody).not.toContain("Le socle Web, API et TypeScript est opérationnel");
      expect(healthBody).not.toContain('"status":"ok"');

      const ready = await fetch(`http://127.0.0.1:${nginxPort}/api/ready`);
      expect(ready.status).toBeGreaterThanOrEqual(500);
      expect(ready.status).toBeLessThan(600);
      const readyBody = await ready.text();
      expect(readyBody).not.toContain('"status":"ok"');
    }, 150000);

    it("still serves the (unaffected) web app through the same proxy, and keeps /nginx-health reporting ok", async () => {
      // Proves the failure above is specific to the /api/ upstream, not a
      // proxy-wide outage — `web` was never stopped.
      const page = await fetch(`http://127.0.0.1:${nginxPort}/`);
      expect(page.status).toBe(200);

      const nginxHealth = await fetch(`http://127.0.0.1:${nginxPort}/nginx-health`);
      expect(nginxHealth.status).toBe(200);
      expect((await nginxHealth.text()).trim()).toBe("ok");
    });
  });

  it("recovers to the existing success contract after the API upstream is restored (bounded polling)", async () => {
    // By this point the nested describe's own afterAll already issued
    // `docker compose start api`; this test proves RECOVERY is actually
    // observable through the proxy, bounded, rather than assuming the
    // restart alone is sufficient evidence.
    const health = await waitForHttpStatus(`http://127.0.0.1:${nginxPort}/api/health`, (status) => status === 200, 30000);
    const healthBody = (await health.json()) as { status: string };
    expect(healthBody.status).toBe("ok");

    const ready = await waitForHttpStatus(`http://127.0.0.1:${nginxPort}/api/ready`, (status) => status === 200, 30000);
    const readyBody = (await ready.json()) as { status: string; checks: Record<string, string> };
    expect(readyBody.status).toBe("ok");
    expect(readyBody.checks).toEqual({ network: "ok", cors: "ok" });
  });
});

describe.skipIf(dockerAvailable)("nginx proxy health/readiness (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
