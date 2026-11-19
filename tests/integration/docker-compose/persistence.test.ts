import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ComposeProject,
  type ResolvedComposePersistence,
  assertProvisioningSafety,
  cleanupComposeProject,
  cleanupDisposableTargets,
  composeDownKeepVolumes,
  composeExec,
  composePort,
  composeStart,
  composeStop,
  composeUp,
  createBucket,
  createComposeCleanupTarget,
  discoverVolumesRequiringInspection,
  evaluateOwnershipGate,
  getS3Object,
  inspectVolume,
  isDockerAvailableSync,
  isS3ObjectAbsent,
  listAllVolumeNames,
  listContainerIds,
  listVolumeNamesByComposeProject,
  putS3Object,
  readS3ErrorResponse,
  resolveComposePersistence,
  uniqueProjectName,
  volumeExists,
  waitForHealthy,
} from "@relis/test-utils";
import {
  BYSTANDER_DB_FIXTURE,
  CONTROL_DB_FIXTURE,
  OBJECT_FIXTURE,
  PROJECT_DB_FIXTURE,
  createFixtureSql,
  fixtureTableExistsSql,
  objectFixtureBody,
  readFixtureMarkerSql,
} from "../../fixtures/docker-compose/persistence-fixtures.js";

// Real disposable-persistence, reset, and recreation check for the local
// Compose stack's two named volumes (see
// docs/architecture/docker-compose-stack.md "Persistence, lifecycle, and
// reset"). Proves, against actual running containers and the actual
// Docker daemon — never mocks, never a name-prefix guess:
//
//   1. The REAL named volumes Compose creates, and their ownership
//      labels (`com.docker.compose.project` / `.volume`), name only this
//      disposable project.
//   2. Every byte of persistent data lives in a named volume; no service
//      bind-mounts a writable data directory out of the working tree.
//   3. The Control DB and the project-test database are distinct, at the
//      connection targets docker-compose.yml itself configures, with a
//      fixture planted in each and NO leakage in either direction.
//   4. A fixture row and a real uploaded object survive a normal
//      stop/start (the same containers coming back).
//   5. They also survive container REMOVAL and recreation while the
//      named volumes are retained (`down` without `--volumes`).
//   6. An explicitly scoped reset (`down --volumes`) removes exactly the
//      volumes identified in step 1 — and nothing else on the daemon.
//   7. The stack recreates afterward from committed configuration alone,
//      with the prior row and object genuinely ABSENT.
//
// A SECOND, independently-named disposable Compose project (`bystander`)
// runs its own `postgres` with its own fixture row throughout. It makes
// the isolation and reset claims real rather than vacuous: two Compose
// projects are shown not to share a data volume, and the reset of the
// first project is shown to leave the second one's volume and row
// untouched. On a daemon that happens to have nothing else on it, the
// "pre-existing volumes survived" check alone would prove nothing.
//
// Only `postgres` and `storage` are started: they are the only two
// services that own persistent data (every other service is stateless —
// see the persistence inventory in the doc above). That keeps this check
// focused on persistence and avoids rebuilding the three application
// images, which tests/integration/docker-compose/stack-smoke.test.ts
// already exercises. The documented connection targets are asserted from
// the RESOLVED configuration of `migrate-control`/`migrate-project`
// rather than by running them (stack-smoke.test.ts already proves those
// two exit 0).
//
// SAFETY — this file performs the only deliberately destructive
// operation in the suite, so every guard is explicit:
//   - Both Compose project names carry a random suffix
//     (`uniqueProjectName`), so neither can be the user's own `relis`
//     development stack.
//   - BEFORE either project is provisioned: `assertProvisioningSafety`
//     validates the RESOLVED configuration (project-scoped volume
//     names, no `external: true`, nothing already on the daemon) —
//     stopping short of starting a single container if that fails.
//   - Before EVERY destructive step (the mid-suite scoped reset AND the
//     final cleanup, for BOTH the primary and the bystander project),
//     ownership is RE-VERIFIED for the UNION of the exact Compose
//     configuration's volume names (re-resolved FRESH, never a cached
//     value) and whatever the daemon's own `com.docker.compose.project`
//     label filter additionally reports — never label discovery alone,
//     which a volume with an incorrect or missing label would escape
//     even though `docker compose down --volumes` addresses volumes by
//     NAME, not by label (`discoverVolumesRequiringInspection`,
//     `evaluateOwnershipGate`/`cleanupDisposableTargets`). A
//     configuration-resolution failure FAILS CLOSED. A CONFIRMED
//     absence never blocks anything (nothing to delete); an inspection
//     FAILURE always does. When ownership cannot be established for a
//     volume, deletion is REFUSED and that volume is reported as
//     requiring manual inspection; only its project's containers/network
//     are removed (always safe), never its data.
//   - Every destructive AND volume-preserving cleanup command
//     (`cleanupComposeProject`/`composeDown`,
//     `removeContainersKeepingVolumesOrThrow`/`composeDownKeepVolumes`)
//     runs under the EXACT SAME environment overrides
//     (`composeEnv`/`bystanderEnv`) used to resolve the configuration
//     its own gate just validated — never a different, possibly-stale
//     environment. `createComposeCleanupTarget` threads one `env` value
//     through both halves for the final cleanup; the mid-suite reset
//     below passes the same `composeEnv` explicitly to its own
//     `cleanupComposeProject` call.
//   - Every volume present on the daemon BEFORE this test ran is
//     captured as a baseline and asserted to still exist afterward.
//   - Partial setup (e.g. the bystander project never actually started)
//     is handled safely: cleanup only acts on resources the daemon
//     confirms belong to a given target, a failure for one target is
//     reported without stopping the other, and the ORIGINAL failure
//     (whatever made setup fail) is never hidden by a cleanup failure —
//     Vitest reports hook failures as additional, separate failures.
//   - Deletion is only ever `docker compose -p <that project> down
//     --volumes` — never `docker volume rm` by name, never a prune,
//     never a filesystem deletion.
//   - All published host ports are ephemeral (`0`), so nothing collides
//     with a running development stack.
//
// The NEGATIVE paths of the ownership gate (rejecting a mislabeled,
// pre-existing, or externally-declared volume; an inspection FAILURE
// never reading as absence; partial-setup cleanup; an unrelated S3 error
// never reading as deletion evidence) are deliberately NOT exercised
// here against a real volume — doing so would require either genuinely
// endangering a resource or an elaborate real-Docker setup that proves
// nothing more than a pure function already proves. They are covered
// instead, with controlled fakes and no Docker dependency, in
// persistence-safety.test.ts.
//
// Requires the `docker` CLI and a reachable daemon; skips, reporting the
// blocker, when absent — never mocks and never fabricates a pass.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const composeFile = path.join(repoRoot, "docker-compose.yml");

const POSTGRES_USER = "relis";
const CONTROL_DB_NAME = "relis_control";
const PROJECT_TEST_DB_NAME = "relis_project_persistence_test";
const BYSTANDER_PROJECT_TEST_DB_NAME = "relis_project_bystander_test";

/** The services that own persistent data — the only ones this check starts. */
const STATEFUL_SERVICES = ["postgres", "storage"];

const STORAGE_CREDENTIALS = { accessKey: "relis-dev-access", secretKey: "relis-dev-secret-key-local-only" };

/** Every published port ephemeral: neither project may contend with a development stack for a host port. */
const EPHEMERAL_PORTS = { SEAWEEDFS_S3_PORT: "0", MAILHOG_UI_PORT: "0", NGINX_HTTP_PORT: "0" };

// Computed synchronously at module/collection time — see
// isDockerAvailableSync's own doc comment for why an async check in a
// beforeAll cannot gate describe.runIf/skipIf correctly.
const dockerAvailable = isDockerAvailableSync();

if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[docker-compose/persistence.test.ts] SKIPPED: the `docker` CLI is not available (or no daemon is reachable) " +
      "in this environment. No real persistence, reset, or recreation behavior was verified; this is a reported " +
      "blocker, not a pass.",
  );
}

describe.runIf(dockerAvailable)("disposable local persistence, scoped reset, and clean recreation", () => {
  const project: ComposeProject = { projectName: uniqueProjectName("relis-persist"), composeFile, cwd: repoRoot };
  const composeEnv = { PROJECT_TEST_DB_NAME, ...EPHEMERAL_PORTS };

  /** A second, independent Compose project standing in for another stack on the same daemon. */
  const bystander: ComposeProject = { projectName: uniqueProjectName("relis-bystander"), composeFile, cwd: repoRoot };
  const bystanderEnv = { PROJECT_TEST_DB_NAME: BYSTANDER_PROJECT_TEST_DB_NAME, ...EPHEMERAL_PORTS };

  /** Volumes that already existed on the daemon before this test ran — must all survive it. */
  let baselineVolumeNames: string[] = [];
  /** The resolved persistence facts (volume names, bind mounts, database targets) for the primary project. */
  let resolved: ResolvedComposePersistence;
  let bystanderResolved: ResolvedComposePersistence;
  /** Recorded once ownership is established, and re-confirmed immediately before the reset. */
  let disposableVolumeNames: string[] = [];
  /** Container ids from the first startup, to distinguish "restarted" from "recreated". */
  let containerIdsAfterFirstStart: Record<string, string[]> = {};

  async function psqlIn(target: ComposeProject, database: string, sql: string): Promise<string> {
    const result = await composeExec(target, "postgres", ["psql", "-U", POSTGRES_USER, "-d", database, "-tAc", sql]);
    expect(result.exitCode, `psql against "${database}" in ${target.projectName} failed: ${result.stderr}`).toBe(0);
    return result.stdout.trim();
  }

  const psql = (database: string, sql: string) => psqlIn(project, database, sql);

  /** The object-storage target, re-resolved every time: an ephemeral host port can change across stop/start and recreation. */
  async function storageTarget(): Promise<{ endpoint: string; bucket: string; key: string }> {
    const port = await composePort(project, "storage", 8333);
    return { endpoint: `http://127.0.0.1:${port}`, bucket: OBJECT_FIXTURE.bucket, key: OBJECT_FIXTURE.key };
  }

  async function startServices(target: ComposeProject, env: Record<string, string>, services: string[]): Promise<void> {
    const up = await composeUp(target, env, services, { timeoutMs: 300000 });
    if (up.exitCode !== 0) {
      throw new Error(
        `docker compose -p ${target.projectName} up ${services.join(" ")} failed (exit ${up.exitCode}):\n${up.stdout}\n${up.stderr}`,
      );
    }
    await Promise.all(services.map((service) => waitForHealthy(target, service)));
  }

  const startStatefulServices = () => startServices(project, composeEnv, STATEFUL_SERVICES);

  beforeAll(async () => {
    // Baseline FIRST: captured before either project creates anything,
    // so the post-reset "nothing unrelated was destroyed" check compares
    // against a genuinely untouched snapshot, and so the provisioning
    // safety check immediately below has something real to compare
    // against.
    baselineVolumeNames = await listAllVolumeNames();

    [resolved, bystanderResolved] = await Promise.all([
      resolveComposePersistence(project, composeEnv),
      resolveComposePersistence(bystander, bystanderEnv),
    ]);

    // Hard safety gate — BEFORE a single container or volume is created
    // for EITHER project: the resolved configuration must be genuinely
    // disposable (volume names scoped to the project, no
    // `external: true`, nothing already on the daemon under these exact
    // names). A failure here throws and stops short of provisioning
    // anything at all.
    assertProvisioningSafety(resolved, baselineVolumeNames);
    assertProvisioningSafety(bystanderResolved, baselineVolumeNames);

    await startStatefulServices();
    containerIdsAfterFirstStart = Object.fromEntries(
      await Promise.all(STATEFUL_SERVICES.map(async (service) => [service, await listContainerIds(project, service)] as const)),
    );

    // The bystander needs only its own PostgreSQL — enough to own a
    // separate named volume holding a separate fixture row.
    await startServices(bystander, bystanderEnv, ["postgres"]);
    await psqlIn(bystander, CONTROL_DB_NAME, createFixtureSql(BYSTANDER_DB_FIXTURE));
  }, 600000);

  afterAll(async () => {
    // Cleans up both projects INDEPENDENTLY and safely, regardless of how
    // far setup got. For EACH target, `createComposeCleanupTarget` wires
    // up discovery against the UNION of the exact configured volume
    // names (re-resolved FRESH here, at cleanup time — never a value
    // cached from beforeAll) and whatever the daemon's own project-label
    // filter additionally reports — never label discovery alone, which
    // a volume with an incorrect or missing label would otherwise
    // escape even though `docker compose down --volumes` addresses
    // volumes by NAME, not by label. A configuration-resolution failure
    // there FAILS CLOSED (propagates as that target's own `error`,
    // never as "nothing to check"). Every discovered volume is
    // RE-VERIFIED immediately before any deletion — never relying on an
    // earlier check — and a failure processing one target never stops
    // or skips the other. When ownership cannot be established for a
    // target's volume(s), deletion is refused for that target entirely
    // (only its containers/network are removed — always safe, since
    // they belong solely to its own Compose project) and the exact
    // volumes are reported as requiring manual inspection.
    const [projectTarget, bystanderTarget] = await Promise.all([
      createComposeCleanupTarget(project, composeEnv, baselineVolumeNames),
      createComposeCleanupTarget(bystander, bystanderEnv, baselineVolumeNames),
    ]);
    const outcomes = await cleanupDisposableTargets([projectTarget, bystanderTarget]);

    // Verify the cleanup's RESULT rather than trusting it blindly. Every
    // problem found here is reported TOGETHER, as an ADDITIONAL failure
    // — Vitest records a hook failure on its own, never replacing or
    // hiding an earlier test's (or beforeAll's) failure, so the original
    // cause always stays visible alongside whatever is found here.
    const survivors = new Set(await listAllVolumeNames());
    const destroyedPreexisting = baselineVolumeNames.filter((name) => !survivors.has(name));

    const problems: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.error) {
        problems.push(`cleanup of "${outcome.label}" failed: ${outcome.error}`);
      }
      if (outcome.volumesRequiringManualInspection.length > 0) {
        problems.push(
          `volume(s) for "${outcome.label}" were NOT deleted — ownership could not be established, and they ` +
            `require manual inspection: ${outcome.volumesRequiringManualInspection.map((v) => `${v.name} (${v.reason})`).join("; ")}`,
        );
      }
    }
    for (const target of [project, bystander]) {
      const remaining = await listVolumeNamesByComposeProject(target);
      if (remaining.length > 0) {
        problems.push(`volumes still labelled for project "${target.projectName}" after cleanup: ${remaining.join(", ")}`);
      }
    }
    if (destroyedPreexisting.length > 0) {
      problems.push(`pre-existing volumes no longer present (MUST NOT happen): ${destroyedPreexisting.join(", ")}`);
    }

    if (problems.length > 0) {
      throw new Error(`Cleanup did not complete correctly:\n- ${problems.join("\n- ")}`);
    }
  }, 420000);

  it("creates exactly two project-scoped named volumes, owned by this disposable project and nothing else", async () => {
    // The volume keys declared in docker-compose.yml, resolved to the
    // real Docker volume names Compose will create. Project-prefixed by
    // Compose itself — which is what keeps two Compose projects from
    // sharing a data volume.
    expect(Object.keys(resolved.volumeNames).sort()).toEqual(["postgres-data", "storage-data"]);
    expect(resolved.volumeNames["postgres-data"]).toBe(`${project.projectName}_postgres-data`);
    expect(resolved.volumeNames["storage-data"]).toBe(`${project.projectName}_storage-data`);

    // No volume may be `external: true`: that would point at a
    // pre-existing user-owned resource this test must never delete.
    expect(resolved.externalVolumes).toEqual([]);

    // This project is genuinely disposable, not the default development
    // stack whose volumes would be `relis_*`.
    expect(project.projectName).toMatch(/^relis-persist-[0-9a-f]{8}$/);
    expect(project.projectName).not.toBe("relis");

    // Ground truth from the DAEMON: which volumes it reports as owned by
    // this project, via Compose's own labels — not a name-prefix guess.
    disposableVolumeNames = (await listVolumeNamesByComposeProject(project)).sort();
    expect(disposableVolumeNames).toEqual([resolved.volumeNames["postgres-data"], resolved.volumeNames["storage-data"]].sort());

    for (const [volumeKey, volumeName] of Object.entries(resolved.volumeNames)) {
      const ownership = await inspectVolume(volumeName);
      expect(ownership, `volume ${volumeName} should exist`).toBeDefined();
      expect(ownership?.composeProject).toBe(project.projectName);
      expect(ownership?.composeVolumeKey).toBe(volumeKey);
      expect(ownership?.driver).toBe("local");
      // Not a volume that existed before this test — so deleting it
      // later cannot destroy anyone else's data.
      expect(baselineVolumeNames).not.toContain(volumeName);
    }
  });

  it("gives a separate Compose project separate data volumes, never shared ones", async () => {
    const bystanderVolumeName = bystanderResolved.volumeNames["postgres-data"];
    expect(bystanderVolumeName).toBe(`${bystander.projectName}_postgres-data`);
    // Different project, different volume name — the two stacks cannot
    // address the same data.
    expect(bystanderVolumeName).not.toBe(resolved.volumeNames["postgres-data"]);
    expect(disposableVolumeNames).not.toContain(bystanderVolumeName);

    const ownership = await inspectVolume(bystanderVolumeName);
    expect(ownership?.composeProject).toBe(bystander.projectName);

    // And the data really is separate: each project's own fixture row is
    // invisible from the other's PostgreSQL server.
    expect(await psqlIn(bystander, CONTROL_DB_NAME, readFixtureMarkerSql(BYSTANDER_DB_FIXTURE))).toBe(BYSTANDER_DB_FIXTURE.marker);
    expect(await psqlIn(project, CONTROL_DB_NAME, fixtureTableExistsSql(BYSTANDER_DB_FIXTURE))).toBe("f");
  });

  it("keeps all persistent data in named volumes, with no writable host bind mount into the working tree", async () => {
    // The structural reason generated database and object data can never
    // become a tracked repository artifact: no service writes data to a
    // path inside the checkout. Every bind mount is either read-only
    // configuration or an application SOURCE directory mounted for live
    // reload — never a data directory.
    const dataWritingBindMounts: string[] = [];
    for (const [service, mounts] of Object.entries(resolved.bindMounts)) {
      for (const mount of mounts) {
        if (mount.readOnly) continue;
        const isSourceMount = /[\\/](?:src|public)$/.test(mount.source);
        if (!isSourceMount) {
          dataWritingBindMounts.push(`${service}: ${mount.source} -> ${mount.target}`);
        }
      }
    }
    expect(dataWritingBindMounts).toEqual([]);

    // And the two stateful services mount their data directories from
    // named volumes, not from the host.
    const bindTargets = Object.values(resolved.bindMounts).flat().map((mount) => mount.target);
    expect(bindTargets).not.toContain("/var/lib/postgresql/data");
    expect(bindTargets).not.toContain("/data");
  });

  it("provisions distinct Control and project-test databases at the connection targets Compose configures", async () => {
    // The documented connection targets, read from the RESOLVED
    // configuration of the two migration services — the same contract
    // docs/architecture/docker-compose-stack.md states. Only
    // host/port/database are available here; credentials are discarded
    // by resolveComposePersistence and never asserted on.
    const controlTarget = resolved.databaseTargets["migrate-control"]?.CONTROL_DATABASE_URL;
    const projectTarget = resolved.databaseTargets["migrate-project"]?.PROJECT_DATABASE_URL;
    expect(controlTarget).toEqual({ host: "postgres", port: "5432", database: CONTROL_DB_NAME });
    expect(projectTarget).toEqual({ host: "postgres", port: "5432", database: PROJECT_TEST_DB_NAME });
    // One server, two databases — same host and port, different database.
    expect(controlTarget?.database).not.toBe(projectTarget?.database);

    // Both targets really exist on the single running server.
    const databaseNames = (await psql(CONTROL_DB_NAME, "SELECT datname FROM pg_database ORDER BY datname;"))
      .split("\n")
      .map((line) => line.trim());
    expect(databaseNames).toContain(CONTROL_DB_NAME);
    expect(databaseNames).toContain(PROJECT_TEST_DB_NAME);
  });

  it("plants a distinct fixture row in each database, with no leakage in either direction", async () => {
    await psql(CONTROL_DB_NAME, createFixtureSql(CONTROL_DB_FIXTURE));
    await psql(PROJECT_TEST_DB_NAME, createFixtureSql(PROJECT_DB_FIXTURE));

    expect(await psql(CONTROL_DB_NAME, readFixtureMarkerSql(CONTROL_DB_FIXTURE))).toBe(CONTROL_DB_FIXTURE.marker);
    expect(await psql(PROJECT_TEST_DB_NAME, readFixtureMarkerSql(PROJECT_DB_FIXTURE))).toBe(PROJECT_DB_FIXTURE.marker);

    // The actual logical-separation proof, asserted BOTH ways: neither
    // database can see the other's fixture table.
    expect(await psql(PROJECT_TEST_DB_NAME, fixtureTableExistsSql(CONTROL_DB_FIXTURE))).toBe("f");
    expect(await psql(CONTROL_DB_NAME, fixtureTableExistsSql(PROJECT_DB_FIXTURE))).toBe("f");
  });

  it("uploads a fixture object through the real authenticated S3 path", async () => {
    const target = await storageTarget();
    const created = await createBucket(target, STORAGE_CREDENTIALS);
    expect(created.status, await created.text().catch(() => "")).toBeLessThan(300);

    const put = await putS3Object(target, STORAGE_CREDENTIALS, objectFixtureBody());
    expect(put.status, await put.text().catch(() => "")).toBeLessThan(300);

    const read = await getS3Object(target, STORAGE_CREDENTIALS);
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer()).equals(objectFixtureBody())).toBe(true);
  });

  it("retains the fixture row and object across a normal stop/start of the same containers", async () => {
    const stopped = await composeStop(project, STATEFUL_SERVICES, { timeoutMs: 120000 });
    expect(stopped.exitCode, stopped.stderr).toBe(0);

    const started = await composeStart(project, STATEFUL_SERVICES, { timeoutMs: 120000 });
    expect(started.exitCode, started.stderr).toBe(0);
    await Promise.all(STATEFUL_SERVICES.map((service) => waitForHealthy(project, service)));

    // Proves this really was a stop/start and not a recreation — the
    // containers are the SAME ones, which also makes the next test's
    // container-id change meaningful evidence of recreation.
    for (const service of STATEFUL_SERVICES) {
      expect(await listContainerIds(project, service)).toEqual(containerIdsAfterFirstStart[service]);
    }

    expect(await psql(CONTROL_DB_NAME, readFixtureMarkerSql(CONTROL_DB_FIXTURE))).toBe(CONTROL_DB_FIXTURE.marker);
    expect(await psql(PROJECT_TEST_DB_NAME, readFixtureMarkerSql(PROJECT_DB_FIXTURE))).toBe(PROJECT_DB_FIXTURE.marker);

    const read = await getS3Object(await storageTarget(), STORAGE_CREDENTIALS);
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer()).equals(objectFixtureBody())).toBe(true);
  });

  it("retains the fixture row and object after container removal and recreation, with the named volumes kept", async () => {
    const down = await composeDownKeepVolumes(project, { timeoutMs: 180000 });
    expect(down.exitCode, down.stderr).toBe(0);

    // The containers are genuinely gone...
    for (const service of STATEFUL_SERVICES) {
      expect(await listContainerIds(project, service)).toEqual([]);
    }
    // ...while both named volumes were RETAINED, because `--volumes` was
    // not passed. This is the distinction the lifecycle documentation
    // draws between removing containers and resetting data.
    for (const volumeName of Object.values(resolved.volumeNames)) {
      expect(await volumeExists(volumeName), `${volumeName} must survive a down without --volumes`).toBe(true);
    }

    await startStatefulServices();

    // New containers, same volumes.
    for (const service of STATEFUL_SERVICES) {
      const recreated = await listContainerIds(project, service);
      expect(recreated).toHaveLength(1);
      expect(recreated).not.toEqual(containerIdsAfterFirstStart[service]);
    }

    expect(await psql(CONTROL_DB_NAME, readFixtureMarkerSql(CONTROL_DB_FIXTURE))).toBe(CONTROL_DB_FIXTURE.marker);
    expect(await psql(PROJECT_TEST_DB_NAME, readFixtureMarkerSql(PROJECT_DB_FIXTURE))).toBe(PROJECT_DB_FIXTURE.marker);
    // Still isolated after recreation, not merely still present.
    expect(await psql(PROJECT_TEST_DB_NAME, fixtureTableExistsSql(CONTROL_DB_FIXTURE))).toBe("f");

    const read = await getS3Object(await storageTarget(), STORAGE_CREDENTIALS);
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer()).equals(objectFixtureBody())).toBe(true);
  });

  it("removes ONLY this disposable project's volumes on an explicitly scoped reset", async () => {
    // Evidence preserved before deletion: the names, and the ownership
    // labels proving they belong to this test's own project.
    const ownedBeforeReset = (await listVolumeNamesByComposeProject(project)).sort();
    expect(ownedBeforeReset).toEqual(disposableVolumeNames);

    // Hard gate, RE-VERIFIED here (fresh, not reused from the "creates
    // exactly two..." test above, and not label-discovery alone): the
    // configured volume names are re-resolved from a FRESH
    // `resolveComposePersistence` call, unioned with whatever the
    // project-label filter additionally reports, and every name in that
    // union is inspected before this stops short of issuing the
    // destructive command — a configuration-resolution failure here
    // fails this `it()` block outright (fails closed) before anything
    // is deleted.
    const freshResolved = await resolveComposePersistence(project, composeEnv);
    const records = await discoverVolumesRequiringInspection({
      resolveConfiguredVolumeNames: async () => Object.values(freshResolved.volumeNames),
      listLabeledVolumeNames: () => listVolumeNamesByComposeProject(project),
      inspectVolumeByName: (name) => inspectVolume(name),
    });
    const gate = evaluateOwnershipGate(records, {
      expectedProjectName: project.projectName,
      baselineVolumeNames,
      externalVolumeKeys: freshResolved.externalVolumes,
    });
    if (!gate.ok) {
      throw new Error(
        `Refusing to reset "${project.projectName}" — ownership could not be established for: ` +
          gate.checks
            .filter((check) => !check.ok)
            .map((check) => `${check.name} (${check.reason})`)
            .join("; "),
      );
    }

    // The explicitly scoped reset — `docker compose -p <this project>
    // down --volumes --remove-orphans`. Never `docker volume rm`, never
    // a prune, never a filesystem deletion. `env: composeEnv` is the
    // SAME environment just used (via `freshResolved` above) to resolve
    // the configuration this gate validated — the destructive command
    // must never run under a different one.
    await cleanupComposeProject(project, { timeoutMs: 180000, env: composeEnv });

    // Exactly the identified volumes are gone...
    for (const volumeName of ownedBeforeReset) {
      expect(await volumeExists(volumeName), `${volumeName} must be destroyed by the scoped reset`).toBe(false);
    }
    expect(await listVolumeNamesByComposeProject(project)).toEqual([]);

    // ...the other Compose project on the same daemon is untouched —
    // its volume still exists AND its row is still readable. This is the
    // assertion that a scoped reset cannot quietly destroy another
    // stack's data.
    const bystanderVolumeName = bystanderResolved.volumeNames["postgres-data"];
    expect(await volumeExists(bystanderVolumeName)).toBe(true);
    expect(await listVolumeNamesByComposeProject(bystander)).toContain(bystanderVolumeName);
    expect(await psqlIn(bystander, CONTROL_DB_NAME, readFixtureMarkerSql(BYSTANDER_DB_FIXTURE))).toBe(BYSTANDER_DB_FIXTURE.marker);

    // ...and every volume that existed before this test ran is still there.
    const survivors = new Set(await listAllVolumeNames());
    expect(baselineVolumeNames.filter((name) => !survivors.has(name))).toEqual([]);
  });

  it("recreates a fresh stack from committed configuration after the reset, with the prior fixtures absent", async () => {
    await startStatefulServices();

    // The volumes come back under the same names — empty this time.
    for (const volumeName of Object.values(resolved.volumeNames)) {
      expect(await volumeExists(volumeName)).toBe(true);
    }

    // Both databases are provisioned again by the committed
    // configuration alone (the official image's own POSTGRES_DB, plus
    // docker/postgres/init/01-create-project-test-database.sh, which
    // re-runs because the data directory is empty again). No manual
    // step, no seed, no business schema.
    const databaseNames = (await psql(CONTROL_DB_NAME, "SELECT datname FROM pg_database ORDER BY datname;"))
      .split("\n")
      .map((line) => line.trim());
    expect(databaseNames).toContain(CONTROL_DB_NAME);
    expect(databaseNames).toContain(PROJECT_TEST_DB_NAME);

    // The prior fixtures are genuinely gone — the reset destroyed data,
    // it did not merely recreate containers.
    expect(await psql(CONTROL_DB_NAME, fixtureTableExistsSql(CONTROL_DB_FIXTURE))).toBe("f");
    expect(await psql(PROJECT_TEST_DB_NAME, fixtureTableExistsSql(PROJECT_DB_FIXTURE))).toBe("f");

    // Confirm the storage service is genuinely OPERATIONAL after
    // recreation — not merely that some request to it happens to error
    // out — via a real, successful, DIFFERENTLY-NAMED put/get
    // round-trip, before drawing any conclusion from the old fixture's
    // absence. Without this, a dead or unreachable server returning a
    // generic failure could be mistaken for "the object was deleted."
    const storageEndpoint = (await storageTarget()).endpoint;
    const livenessTarget = { endpoint: storageEndpoint, bucket: `${OBJECT_FIXTURE.bucket}-liveness-check`, key: "liveness.txt" };
    const livenessBucket = await createBucket(livenessTarget, STORAGE_CREDENTIALS);
    expect(livenessBucket.status, await livenessBucket.text().catch(() => "")).toBeLessThan(300);
    const livenessPut = await putS3Object(livenessTarget, STORAGE_CREDENTIALS, Buffer.from("storage liveness check", "utf8"));
    expect(livenessPut.status, await livenessPut.text().catch(() => "")).toBeLessThan(300);
    const livenessGet = await getS3Object(livenessTarget, STORAGE_CREDENTIALS);
    expect(livenessGet.status).toBe(200);

    // The prior fixture object is genuinely ABSENT — a SPECIFIC S3
    // "not found" response (HTTP 404 with an error Code of NoSuchKey or
    // NoSuchBucket; the whole bucket was destroyed along with the
    // volume, so NoSuchBucket is the expected shape here), never merely
    // "any status >= 400": an authentication failure (401/403), a
    // server error (5xx), or a connection failure must NOT be accepted
    // as evidence the object was deleted — each of those means
    // something else entirely.
    const read = await getS3Object(await storageTarget(), STORAGE_CREDENTIALS);
    const errorInfo = await readS3ErrorResponse(read);
    expect(errorInfo.status, `expected HTTP 404, got ${errorInfo.status} (code=${errorInfo.code}, message=${errorInfo.message})`).toBe(404);
    expect(["NoSuchKey", "NoSuchBucket"]).toContain(errorInfo.code);
    expect(isS3ObjectAbsent(errorInfo)).toBe(true);
  });
});

describe.skipIf(dockerAvailable)("disposable local persistence (blocked)", () => {
  it("is a reported blocker, not executed, when Docker is unavailable", () => {
    expect(dockerAvailable).toBe(false);
  });
});
