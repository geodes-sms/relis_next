import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComposeProject,
  type ContainerPortBinding,
  assertLoopbackOnlyBindings,
  assertProvisioningSafety,
  cleanupDisposableTargets,
  composePort,
  composeUp,
  createComposeCleanupTarget,
  getContainerHostPortBindings,
  getFreePort,
  isDockerAvailableSync,
  isLoopbackOnlyHostIp,
  listAllVolumeNames,
  resolveComposePersistence,
  resolveComposePublishedPorts,
  uniqueProjectName,
  waitForExitCode,
  waitForHealthy,
  waitForHttpOk,
} from "@relis/test-utils";

// Local sub-issue 02.04 — "Expose health/readiness through the local
// proxy and restrict database and storage port exposure." This file
// covers AC2 (safe port exposure); see proxy-health.test.ts for AC1.
//
// Required exposure policy, verified at TWO independent layers below:
//   - `api`, `web`, `postgres`, `worker`, `migrate-control`, `migrate-project`
//     must publish NO host port at all.
//   - `nginx`, `mailhog` (UI only), and `storage` (S3 only) are the only
//     approved host-published development endpoints, and every one of
//     them must bind to loopback (`127.0.0.1`) ONLY — never a wildcard
//     (`0.0.0.0`/`::`).
//   - SMTP (mailhog:1025) and the storage administration ports
//     (master :9333, filer :8888) must NOT be published.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const composeFile = path.join(repoRoot, "docker-compose.yml");

const dockerAvailable = isDockerAvailableSync();

if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[docker-compose/port-exposure.test.ts] Docker-dependent blocks SKIPPED: the `docker` CLI is not available " +
      "(or no daemon is reachable) in this environment. Resolved-configuration and runtime port bindings were not " +
      "verified against a real daemon; this is a reported blocker, not a pass. The pure validation-logic checks " +
      "below still ran.",
  );
}

// ---------------------------------------------------------------------
// Pure validation-logic checks — no Docker required, no real network.
// These prove the REJECTION rule itself works on controlled, synthetic
// inputs (including the wildcard bindings this task explicitly says to
// reject): they are evidence the validation logic is correct, NOT
// evidence of this stack's actual networking. That real-Docker evidence
// is the two `describe.runIf(dockerAvailable)` blocks below.
// ---------------------------------------------------------------------
describe("isLoopbackOnlyHostIp / assertLoopbackOnlyBindings — wildcard rejection (synthetic inputs)", () => {
  it("accepts ONLY the literal loopback address 127.0.0.1", () => {
    expect(isLoopbackOnlyHostIp("127.0.0.1")).toBe(true);
  });

  it("rejects the IPv4 wildcard 0.0.0.0", () => {
    expect(isLoopbackOnlyHostIp("0.0.0.0")).toBe(false);
  });

  it("rejects the IPv6 wildcard ::", () => {
    expect(isLoopbackOnlyHostIp("::")).toBe(false);
  });

  it("rejects the empty string (Docker's own shorthand for every interface)", () => {
    expect(isLoopbackOnlyHostIp("")).toBe(false);
  });

  it("rejects undefined (no host IP recorded at all)", () => {
    expect(isLoopbackOnlyHostIp(undefined)).toBe(false);
  });

  it("rejects IPv6 loopback ::1 — this stack always uses the literal IPv4 address, never this", () => {
    expect(isLoopbackOnlyHostIp("::1")).toBe(false);
  });

  it("assertLoopbackOnlyBindings passes a genuinely loopback-only binding map", () => {
    const bindings: Record<string, ContainerPortBinding[] | null> = { "80/tcp": [{ hostIp: "127.0.0.1", hostPort: "8080" }] };
    expect(() => assertLoopbackOnlyBindings(bindings, "nginx (fake)")).not.toThrow();
  });

  it("assertLoopbackOnlyBindings passes a service with no published ports at all", () => {
    expect(() => assertLoopbackOnlyBindings({}, "api (fake)")).not.toThrow();
    expect(() => assertLoopbackOnlyBindings({ "3001/tcp": null }, "api (fake)")).not.toThrow();
  });

  it("assertLoopbackOnlyBindings REJECTS a wildcard 0.0.0.0 binding, naming the exact port and address", () => {
    const bindings: Record<string, ContainerPortBinding[] | null> = { "8080/tcp": [{ hostIp: "0.0.0.0", hostPort: "8080" }] };
    expect(() => assertLoopbackOnlyBindings(bindings, "nginx (fake, unsafe)")).toThrow(/8080\/tcp.*0\.0\.0\.0/s);
  });

  it("assertLoopbackOnlyBindings REJECTS a wildcard :: binding", () => {
    const bindings: Record<string, ContainerPortBinding[] | null> = { "8333/tcp": [{ hostIp: "::", hostPort: "8333" }] };
    expect(() => assertLoopbackOnlyBindings(bindings, "storage (fake, unsafe)")).toThrow(/8333\/tcp.*::/s);
  });

  it("assertLoopbackOnlyBindings REJECTS when only ONE of several bindings is unsafe", () => {
    const bindings: Record<string, ContainerPortBinding[] | null> = {
      "8025/tcp": [{ hostIp: "127.0.0.1", hostPort: "8025" }],
      "1025/tcp": [{ hostIp: "0.0.0.0", hostPort: "1025" }],
    };
    expect(() => assertLoopbackOnlyBindings(bindings, "mailhog (fake, unsafe)")).toThrow(/1025\/tcp/);
  });
});

const NO_HOST_PORT_SERVICES = ["api", "web", "postgres", "worker", "migrate-control", "migrate-project"] as const;
const LOOPBACK_SERVICES = ["nginx", "mailhog", "storage"] as const;

// ---------------------------------------------------------------------
// Layer 1 — the RESOLVED Compose configuration (`docker compose config
// --format json`). Requires the `docker compose` CLI but no running
// daemon and creates nothing; proves what Compose WOULD publish.
// ---------------------------------------------------------------------
describe.runIf(dockerAvailable)("resolved Compose configuration — declared ports", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-port-config"), composeFile, cwd: repoRoot };

  it("declares NO published ports for api/web/postgres/worker/migrate-control/migrate-project", async () => {
    const resolved = await resolveComposePublishedPorts(project, {});
    for (const service of NO_HOST_PORT_SERVICES) {
      expect(resolved[service] ?? [], `service "${service}" must declare no ports:`).toEqual([]);
    }
  });

  it("publishes nginx:80, mailhog:8025 (UI only), and storage:8333 (S3 only) bound to 127.0.0.1 — never SMTP or storage admin ports", async () => {
    const resolved = await resolveComposePublishedPorts(project, {});

    const nginxPorts = resolved.nginx ?? [];
    expect(nginxPorts).toHaveLength(1);
    expect(nginxPorts[0]?.target).toBe(80);
    expect(nginxPorts[0]?.hostIp).toBe("127.0.0.1");

    const mailhogPorts = resolved.mailhog ?? [];
    expect(mailhogPorts).toHaveLength(1);
    expect(mailhogPorts[0]?.target).toBe(8025);
    expect(mailhogPorts[0]?.hostIp).toBe("127.0.0.1");
    // SMTP (1025) must not appear among mailhog's published ports at all.
    expect(mailhogPorts.some((entry) => entry.target === 1025)).toBe(false);

    const storagePorts = resolved.storage ?? [];
    expect(storagePorts).toHaveLength(1);
    expect(storagePorts[0]?.target).toBe(8333);
    expect(storagePorts[0]?.hostIp).toBe("127.0.0.1");
    // Storage administration ports (master 9333, filer 8888) must not be published.
    expect(storagePorts.some((entry) => entry.target === 9333 || entry.target === 8888)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Layer 2 — ACTUAL running (and, for the one-shot migration services,
// already-exited) container port bindings, via `docker inspect`'s
// `HostConfig.PortBindings`. This is the real-networking evidence the
// resolved-configuration layer above cannot provide on its own: it
// confirms Compose's resolved intent and the real container were
// actually created consistently with it.
//
// Brings up every service EXCEPT nothing is skipped here — the full
// stack is needed because this suite must inspect all seven service
// responsibilities' real bindings, not a subset.
// ---------------------------------------------------------------------
describe.runIf(dockerAvailable)("real running containers — actual host port bindings", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-port-runtime"), composeFile, cwd: repoRoot };
  let composeEnv: Record<string, string>;
  /** Volumes that already existed on the daemon before this test ran — must all survive it. See sub-issue 02.03's guarded-cleanup contract. */
  let baselineVolumeNames: string[] = [];

  beforeAll(async () => {
    const nginxPort = await getFreePort();
    composeEnv = { NGINX_HTTP_PORT: String(nginxPort), MAILHOG_UI_PORT: "0", SEAWEEDFS_S3_PORT: "0" };

    // Baseline FIRST, before anything is provisioned — this suite brings
    // up the FULL stack, including `postgres` and `storage`, which DO
    // create this project's two real named volumes
    // (`postgres-data`/`storage-data`). See persistence.test.ts (sub-issue
    // 02.03) for the full rationale.
    baselineVolumeNames = await listAllVolumeNames();

    const resolved = await resolveComposePersistence(project, composeEnv);
    // Hard safety gate — BEFORE a single container or volume is created:
    // the resolved configuration must be genuinely disposable (volume
    // names scoped to this project, no `external: true`, nothing already
    // on the daemon under these exact names). Throws and stops short of
    // provisioning anything if it fails.
    assertProvisioningSafety(resolved, baselineVolumeNames);

    const up = await composeUp(project, composeEnv, [], { build: true, timeoutMs: 600000 });
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
    // its real published port directly instead, same as stack-smoke.test.ts.
    const mailhogPort = await composePort(project, "mailhog", 8025);
    await waitForHttpOk(`http://127.0.0.1:${mailhogPort}/`);
    // Block until the one-shot migration containers have actually exited
    // — their HostConfig.PortBindings is fixed at creation time regardless
    // (see getContainerHostPortBindings's own doc comment), but waiting
    // here keeps this suite's intent explicit and avoids racing teardown.
    await Promise.all([waitForExitCode(project, "migrate-control"), waitForExitCode(project, "migrate-project")]);
  }, 600000);

  afterAll(async () => {
    // Guarded cleanup (sub-issue 02.03's contract): re-resolves the exact
    // configured volume names FRESH, unions them with whatever the
    // daemon's own project-label filter additionally reports, and
    // re-verifies ownership for every one of them immediately before any
    // deletion — never relying on the safety gate run in `beforeAll`.
    // `composeEnv` is passed through unchanged so configuration
    // resolution, the original `up`, and this cleanup all resolve the
    // SAME configuration. A discovery failure (fails closed) or an
    // ownership refusal blocks the destructive step and falls back to
    // removing only containers/network — always safe.
    const target = await createComposeCleanupTarget(project, composeEnv, baselineVolumeNames);
    const [outcome] = await cleanupDisposableTargets([target]);

    // Report a cleanup failure as its OWN failure — never hiding or
    // replacing an earlier test/beforeAll failure, which Vitest already
    // reports separately.
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

  it.each(NO_HOST_PORT_SERVICES)("publishes NO host port for %s", async (service) => {
    const bindings = await getContainerHostPortBindings(project, service);
    expect(bindings, `service "${service}" must have no HostConfig.PortBindings entries`).toEqual({});
  });

  it.each(LOOPBACK_SERVICES)("binds %s's published port(s) to loopback (127.0.0.1) only — never a wildcard", async (service) => {
    const bindings = await getContainerHostPortBindings(project, service);
    // Must have published AT LEAST one real binding (this is an approved,
    // intentionally-published development endpoint) — an empty result
    // here would be a regression removing the documented endpoint, not a
    // pass.
    const totalBindings = Object.values(bindings).filter((list): list is ContainerPortBinding[] => list !== null).flat().length;
    expect(totalBindings, `service "${service}" must publish at least one real host binding`).toBeGreaterThan(0);
    expect(() => assertLoopbackOnlyBindings(bindings, service)).not.toThrow();
  });

  it("mailhog publishes ONLY its UI port (8025) — SMTP (1025) stays internal", async () => {
    const bindings = await getContainerHostPortBindings(project, "mailhog");
    expect(Object.keys(bindings)).toEqual(["8025/tcp"]);
  });

  it("storage publishes ONLY its S3 gateway port (8333) — master (9333) and filer (8888) stay internal", async () => {
    const bindings = await getContainerHostPortBindings(project, "storage");
    expect(Object.keys(bindings)).toEqual(["8333/tcp"]);
  });

  it("nginx publishes ONLY port 80 (its own listen port)", async () => {
    const bindings = await getContainerHostPortBindings(project, "nginx");
    expect(Object.keys(bindings)).toEqual(["80/tcp"]);
  });
});

describe.skipIf(dockerAvailable)("port exposure (Docker-dependent blocks blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
