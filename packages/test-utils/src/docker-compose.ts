import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { runToCompletion, type SpawnResult } from "./process.js";

/**
 * Checks whether the `docker` CLI is present AND a daemon is reachable.
 * Integration tests that require a real container runtime must gate on
 * this and report a skip — never fabricate a pass, and never fall back
 * to a mock, when it is false. See
 * docs/architecture/docker-compose-stack.md and this sub-issue's
 * "Tests and verification" boundary.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const result = await runToCompletion("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Synchronous equivalent of `isDockerAvailable`, for use at MODULE scope
 * (e.g. `const dockerAvailable = isDockerAvailableSync();` at the top of
 * a test file) so the result can gate `describe.runIf`/`skipIf`.
 * Vitest collects a test file by running it top-to-bottom once BEFORE any
 * `beforeAll` hook body executes, so an async check stored in a
 * `beforeAll` is always still `false` at the point `describe.runIf` reads
 * it — this sync check exists specifically to avoid that trap.
 */
export function isDockerAvailableSync(): boolean {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A short, random suffix keeps parallel/leftover test runs from colliding on project name. */
export function uniqueProjectName(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/**
 * Finds a currently-free TCP port on loopback by briefly binding to port
 * 0 and reading back the OS-assigned port, then releasing it
 * immediately.
 *
 * This exists specifically for NGINX_HTTP_PORT, and must NOT be confused
 * with the "pass 0, discover the real port with `composePort` afterward"
 * pattern used for MAILHOG_UI_PORT/SEAWEEDFS_S3_PORT: those two variables
 * are never read by any application code, so discovering the real port
 * AFTER `docker compose up` is fine. NGINX_HTTP_PORT is different — it is
 * baked directly into `NEXT_PUBLIC_API_URL` on the `web` service at
 * container start (see docker-compose.yml). Passing the literal string
 * "0" there bakes the broken value "http://localhost:0/api" into the
 * running container; the real port must be known BEFORE `docker compose
 * up` runs, which is what this function is for.
 *
 * Has the usual small TOCTOU race (another process could claim the port
 * between this closing it and Compose binding it) — an accepted
 * trade-off for a disposable local test run, same as any "find a free
 * port" test helper.
 */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine an assigned port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export interface ComposeProject {
  /** Unique per test run — scopes every container/network/volume Compose creates (`docker compose -p`). */
  projectName: string;
  /** Path to docker-compose.yml. */
  composeFile: string;
  /** Directory to run `docker compose` from (the repository root). */
  cwd: string;
}

export type ComposeEnv = Record<string, string>;

function composeArgs(project: ComposeProject, rest: string[]): string[] {
  return ["compose", "-p", project.projectName, "-f", project.composeFile, ...rest];
}

function withEnv(env: ComposeEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

/**
 * Brings up the stack (or a subset of `services`) for `project`. Callers
 * are responsible for calling `cleanupComposeProject` (preferred — it
 * throws on a cleanup failure instead of silently ignoring it) or
 * `composeDown` on the SAME project afterward — this never touches any
 * other Compose project, container, or volume (Compose namespaces
 * everything by `-p` project name). Note that `composeRun` (below) also
 * implicitly creates the project's network, even though its container is
 * removed by `--rm` — cleanup is required after using it too, not only
 * after `composeUp`.
 */
export async function composeUp(
  project: ComposeProject,
  env: ComposeEnv,
  services: string[] = [],
  options: { build?: boolean; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  const args = composeArgs(project, ["up", "-d"]);
  if (options.build) args.push("--build");
  args.push(...services);
  return runToCompletion("docker", args, { cwd: project.cwd, env: withEnv(env), timeoutMs: options.timeoutMs ?? 300000 });
}

/**
 * Tears down ONLY this project's containers, network, and anonymous/named
 * volumes created for it. Never stops unrelated containers and never runs
 * a broad prune — see this sub-issue's test-safety boundary.
 *
 * `options.env`, when given, is merged exactly like `composeUp`'s own
 * `env` (`withEnv`) — the SAME environment overrides used to RESOLVE the
 * Compose configuration (`resolveComposePersistence`) must also reach
 * this actual destructive command, since `docker compose down
 * --volumes` targets volumes BY THE NAMES Compose computes from that
 * same configuration/environment. Omitting it (the default) preserves
 * every existing caller's current behavior unchanged — it merges no
 * overrides on top of this process's own inherited environment, exactly
 * as before this parameter existed.
 */
export async function composeDown(project: ComposeProject, options: { timeoutMs?: number; env?: ComposeEnv } = {}): Promise<SpawnResult> {
  const args = composeArgs(project, ["down", "--volumes", "--remove-orphans"]);
  return runToCompletion("docker", args, { cwd: project.cwd, env: withEnv(options.env ?? {}), timeoutMs: options.timeoutMs ?? 120000 });
}

/**
 * `composeDown`, but THROWS when cleanup itself fails instead of letting
 * a nonzero exit code pass silently. Intended for an `afterAll` cleanup
 * step: Vitest (and Playwright) report a hook failure as its OWN,
 * separate failure — it does not replace or hide an earlier test's (or
 * `beforeAll`'s) failure in the same file, so throwing here never masks
 * the original cause; both are reported. Still scoped to exactly this
 * project's own containers/network/volumes (`composeDown`'s own
 * guarantee), never anything else.
 *
 * `options.env` is forwarded to `composeDown` unchanged — see that
 * function's own doc comment for why this must be the SAME environment
 * used to resolve the Compose configuration being torn down.
 */
export async function cleanupComposeProject(project: ComposeProject, options: { timeoutMs?: number; env?: ComposeEnv } = {}): Promise<void> {
  const result = await composeDown(project, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker compose down failed for project "${project.projectName}" (exit ${result.exitCode}) — cleanup did NOT ` +
        `complete; resources for this project may still exist and may need manual removal ` +
        `("docker compose -p ${project.projectName} down --volumes --remove-orphans").\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

/**
 * `docker compose config --quiet` — resolves and validates the merged
 * configuration without starting anything AND without printing the
 * resolved file (which would otherwise echo every interpolated
 * development-only placeholder value, e.g. POSTGRES_PASSWORD, in
 * plaintext). On success, stdout/stderr are expected to be empty; only a
 * failure's own error text is captured for diagnosis.
 */
export async function composeConfigQuiet(project: ComposeProject, env: ComposeEnv): Promise<SpawnResult> {
  const args = composeArgs(project, ["config", "--quiet"]);
  return runToCompletion("docker", args, { cwd: project.cwd, env: withEnv(env), timeoutMs: 30000 });
}

/** Stops (without removing) the given services — used to simulate a dependency becoming unavailable mid-run. */
export async function composeStop(project: ComposeProject, services: string[], options: { timeoutMs?: number } = {}): Promise<SpawnResult> {
  const args = composeArgs(project, ["stop", ...services]);
  return runToCompletion("docker", args, { cwd: project.cwd, timeoutMs: options.timeoutMs ?? 30000 });
}

export async function composeExec(
  project: ComposeProject,
  service: string,
  command: string[],
  options: { timeoutMs?: number; env?: ComposeEnv } = {},
): Promise<SpawnResult> {
  const args = composeArgs(project, ["exec", "-T", service, ...command]);
  return runToCompletion("docker", args, {
    cwd: project.cwd,
    env: options.env ? withEnv(options.env) : process.env,
    timeoutMs: options.timeoutMs ?? 30000,
  });
}

/**
 * Runs `service`'s command in a NEW, disposable container (not the
 * long-running one `composeUp` may have already started), with `env`
 * overrides applied directly to that one invocation — e.g. to simulate a
 * genuinely missing or invalid required variable without touching the
 * project's other services. Mirrors `docker compose run --rm -e ...`.
 *
 * `-T` disables pseudo-TTY allocation — without it, `docker compose run`
 * can allocate one by default, which merges the container's stdout and
 * stderr into a single stream; callers that need to distinguish which
 * stream a diagnostic was written to (e.g. a ConfigValidationError,
 * logged via console.error to stderr — see config-validation.test.ts)
 * require them to stay separate.
 */
export async function composeRun(
  project: ComposeProject,
  service: string,
  env: ComposeEnv,
  options: { timeoutMs?: number; command?: string[] } = {},
): Promise<SpawnResult> {
  const args = composeArgs(project, ["run", "--rm", "--no-deps", "-T"]);
  for (const [key, value] of Object.entries(env)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(service);
  if (options.command) args.push(...options.command);
  return runToCompletion("docker", args, { cwd: project.cwd, timeoutMs: options.timeoutMs ?? 60000 });
}

/** Queries the actual host-assigned port for a published container port (works with `0` / ephemeral bindings too). */
export async function composePort(project: ComposeProject, service: string, containerPort: number): Promise<number> {
  const result = await runToCompletion("docker", composeArgs(project, ["port", service, String(containerPort)]), {
    cwd: project.cwd,
    timeoutMs: 15000,
  });
  const match = /:(\d+)\s*$/.exec(result.stdout.trim());
  if (!match) {
    throw new Error(`Could not determine the published port for ${service}:${containerPort}.\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return Number(match[1]);
}

export async function composeLogs(project: ComposeProject, service: string, options: { timeoutMs?: number } = {}): Promise<SpawnResult> {
  const args = composeArgs(project, ["logs", "--no-color", service]);
  return runToCompletion("docker", args, { cwd: project.cwd, timeoutMs: options.timeoutMs ?? 15000 });
}

/** The container id for `service` (its most recent one, including already-exited containers via `-a`), or `undefined` if none exists yet. */
export async function getContainerId(project: ComposeProject, service: string): Promise<string | undefined> {
  const result = await runToCompletion("docker", composeArgs(project, ["ps", "-a", "-q", service]), {
    cwd: project.cwd,
    timeoutMs: 15000,
  });
  const id = result.stdout.trim().split("\n")[0]?.trim();
  return id || undefined;
}

/**
 * The container's real `docker inspect` lifecycle status ("running",
 * "exited", "created", ...) — not Compose's own healthcheck status (see
 * `waitForHealthy` for that). Used to confirm actual process liveness for
 * a service with no healthcheck (e.g. `worker`, which has none — see
 * docker-compose.yml's comment on why).
 */
export async function getContainerStatus(project: ComposeProject, service: string): Promise<string> {
  const containerId = await getContainerId(project, service);
  if (!containerId) {
    throw new Error(`No container found for service "${service}" in project ${project.projectName}`);
  }
  const inspect = await runToCompletion("docker", ["inspect", containerId, "--format", "{{.State.Status}}"], { timeoutMs: 15000 });
  return inspect.stdout.trim();
}

/**
 * Polls `docker inspect` for `service`'s container until its lifecycle
 * status is "exited", then returns its real `State.ExitCode` — the
 * actual outcome of the command the container ran, not a proxy for it
 * (e.g. not "a database it creates exists", which can be true regardless
 * of whether the command itself succeeded — see docker/postgres/init/,
 * which creates databases independently of migrate-control/migrate-project
 * ever running at all).
 */
export async function waitForExitCode(project: ComposeProject, service: string, timeoutMs = 120000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const containerId = await getContainerId(project, service);
    if (containerId) {
      const inspect = await runToCompletion(
        "docker",
        ["inspect", containerId, "--format", "{{.State.Status}}|{{.State.ExitCode}}"],
        { timeoutMs: 15000 },
      );
      const [status, exitCodeRaw] = inspect.stdout.trim().split("|");
      if (status === "exited") {
        return Number(exitCodeRaw);
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for service "${service}" to exit in project ${project.projectName}`);
}

/**
 * Polls `url` with plain HTTP GET requests until it responds (any status
 * code — this only proves the server is accepting connections, not that
 * the endpoint itself is semantically "ok"), or `timeoutMs` elapses. Used
 * for a service with no Compose `healthcheck:` block (e.g. `mailhog` —
 * see docker-compose.yml's comment on why) instead of fabricating one.
 */
export async function waitForHttpOk(url: string, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    }
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url} to accept connections. Last error: ${String(lastError)}`);
}

/**
 * Polls `url` with plain HTTP GET requests until a response's status code
 * satisfies `isAcceptable`, or `timeoutMs` elapses — unlike `waitForHttpOk`
 * (which accepts ANY status, including a failure one, as "the server is
 * accepting connections"), this is for a BOUNDED wait on a specific
 * outcome, e.g. "the proxy reports success again after its upstream was
 * restored." Returns the accepted `Response` so the caller can inspect its
 * body without a second request.
 *
 * Genuinely bounded by `timeoutMs` overall, not merely "checked between
 * requests": each individual `fetch` is given an `AbortController` tied to
 * the REMAINING time left in the overall deadline (`deadline - Date.now()`
 * at the moment that request starts), not a fresh `timeoutMs` of its own —
 * a single pending request (e.g. a proxy that has silently dropped
 * packets toward a dead upstream, with no reply at all) can therefore
 * never push the total wait past `timeoutMs`. The retry delay between
 * attempts is likewise clamped to whatever remains of the deadline, never
 * a fixed delay that could itself overshoot it.
 *
 * Every REJECTED response's body is explicitly released
 * (`response.body?.cancel()`) before the next attempt — this is not a
 * cosmetic cleanup: an un-drained response body can otherwise stall a
 * kept-alive connection's reuse by the HTTP client on the very next
 * request. The ACCEPTED response is returned untouched — its body is
 * never read or cancelled here — so the caller can still consume it
 * exactly once.
 */
export async function waitForHttpStatus(
  url: string,
  isAcceptable: (status: number) => boolean,
  timeoutMs = 60000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  let lastError: unknown;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (isAcceptable(response.status)) {
        return response;
      }
      lastStatus = response.status;
      // Not the response we're waiting for — release it (see doc comment
      // above) rather than leaving its body unconsumed.
      try {
        await response.body?.cancel();
      } catch {
        // Already closed/errored; nothing left to release.
      }
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(abortTimer);
    }

    const retryDelay = Math.min(1000, deadline - Date.now());
    if (retryDelay <= 0) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${url} to reach an acceptable status. ` +
      `Last observed status: ${lastStatus ?? "(none — request never completed)"}. Last error: ${String(lastError)}`,
  );
}

/**
 * Polls `docker compose ps` for `service` until its healthcheck reports
 * "(healthy)", or `timeoutMs` elapses. Relies on a real `healthcheck:`
 * block existing on that service in docker-compose.yml — never
 * fabricates readiness for a service with no healthcheck (e.g.
 * apps/worker, which has none — see docker-compose.yml's comment on why).
 */
export async function waitForHealthy(project: ComposeProject, service: string, timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await runToCompletion("docker", composeArgs(project, ["ps", service]), {
      cwd: project.cwd,
      timeoutMs: 15000,
    });
    const serviceLine = result.stdout.split("\n").find((line) => line.includes(service));
    if (serviceLine?.includes("(healthy)")) return;
    if (serviceLine?.includes("(unhealthy)")) {
      throw new Error(`Service "${service}" reported unhealthy in project ${project.projectName}:\n${result.stdout}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for service "${service}" to become healthy in project ${project.projectName}`);
}

/**
 * Starts previously-`composeStop`ped services again WITHOUT recreating
 * their containers — the "normal restart" half of the stop/start
 * lifecycle (`docker compose start`). Deliberately distinct from
 * `composeUp`, which recreates a container whose configuration changed;
 * a persistence check that needs to prove "the SAME container came
 * back" must use this one.
 */
export async function composeStart(project: ComposeProject, services: string[], options: { timeoutMs?: number } = {}): Promise<SpawnResult> {
  const args = composeArgs(project, ["start", ...services]);
  return runToCompletion("docker", args, { cwd: project.cwd, timeoutMs: options.timeoutMs ?? 120000 });
}

/**
 * Removes this project's containers and network but **keeps its named
 * volumes** (`docker compose down --remove-orphans`, deliberately
 * WITHOUT `--volumes`). This is the lifecycle step that separates
 * "container recreation" from "reset": data in `postgres-data` /
 * `storage-data` must survive it.
 *
 * Contrast with `composeDown`, which always passes `--volumes` and is
 * therefore the destructive reset. Both stay scoped to exactly this
 * `-p` project — neither ever prunes, and neither can touch another
 * project's containers, network, or volumes.
 *
 * `options.env`, when given, is merged exactly like `composeDown`'s own
 * `env` — see that function's doc comment for why this must be the SAME
 * environment used to resolve the Compose configuration. Omitting it
 * (the default) preserves every existing caller's current behavior
 * unchanged.
 */
export async function composeDownKeepVolumes(
  project: ComposeProject,
  options: { timeoutMs?: number; env?: ComposeEnv } = {},
): Promise<SpawnResult> {
  const args = composeArgs(project, ["down", "--remove-orphans"]);
  return runToCompletion("docker", args, { cwd: project.cwd, env: withEnv(options.env ?? {}), timeoutMs: options.timeoutMs ?? 120000 });
}

/** Container ids for `service` (including exited ones), newest first — empty when the service has no container at all. */
export async function listContainerIds(project: ComposeProject, service: string): Promise<string[]> {
  const result = await runToCompletion("docker", composeArgs(project, ["ps", "-a", "-q", service]), {
    cwd: project.cwd,
    timeoutMs: 15000,
  });
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Every Docker volume name currently on the daemon — used to prove a scoped reset left unrelated volumes untouched. */
export async function listAllVolumeNames(): Promise<string[]> {
  const result = await runToCompletion("docker", ["volume", "ls", "--format", "{{.Name}}"], { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(`docker volume ls failed (exit ${result.exitCode}):\n${result.stderr}`);
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Volume names the DAEMON itself reports as belonging to `project`, read
 * from Compose's own `com.docker.compose.project` label — an ownership
 * record, not a name-prefix guess. A destructive reset must only ever
 * delete volumes this returns for a project the test itself created.
 */
export async function listVolumeNamesByComposeProject(project: ComposeProject): Promise<string[]> {
  const result = await runToCompletion(
    "docker",
    ["volume", "ls", "--filter", `label=com.docker.compose.project=${project.projectName}`, "--format", "{{.Name}}"],
    { timeoutMs: 30000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`docker volume ls (project filter) failed (exit ${result.exitCode}):\n${result.stderr}`);
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

export interface VolumeOwnership {
  name: string;
  driver: string;
  /** `com.docker.compose.project` — which Compose project created it. */
  composeProject: string | undefined;
  /** `com.docker.compose.volume` — which volume key declared in docker-compose.yml it implements. */
  composeVolumeKey: string | undefined;
  /** Every label, for diagnosis. Compose's own labels carry no secret values. */
  labels: Record<string, string>;
}

/**
 * Matches Docker's own, specific "no such volume" error line (confirmed
 * against the real CLI: `docker volume inspect <missing-name>` exits 1
 * with stderr `Error response from daemon: get <name>: no such volume`).
 * This is the ONLY signal `inspectVolume` treats as genuine absence —
 * exported so the classification itself can be unit-tested with
 * synthetic stderr text, without a real Docker daemon. Every other
 * nonzero-exit stderr (a daemon unreachable error, a permission
 * failure, or anything else) does NOT match, so it is treated as a real
 * failure by `inspectVolume`, never as absence.
 */
export function isVolumeNotFoundError(stderr: string): boolean {
  return /no such volume/i.test(stderr);
}

/**
 * `docker volume inspect` for one volume.
 *
 * Returns `undefined` ONLY for a genuine "no such volume" response (see
 * `isVolumeNotFoundError`) — never for any other nonzero exit. A daemon
 * that is unreachable, a permission failure, or any other command
 * failure THROWS instead, naming the exit code and stderr. Malformed
 * output on a zero exit (unparseable JSON) also throws rather than being
 * swallowed. This matters specifically because `volumeExists` (below)
 * delegates to this function: without this distinction, an inspection
 * FAILURE could silently read as "the volume does not exist," which
 * would let a caller wrongly treat a failed check as proof a volume was
 * deleted.
 */
export async function inspectVolume(name: string): Promise<VolumeOwnership | undefined> {
  const result = await runToCompletion("docker", ["volume", "inspect", name, "--format", "{{json .}}"], { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    if (isVolumeNotFoundError(result.stderr)) return undefined;
    throw new Error(
      `docker volume inspect "${name}" failed (exit ${result.exitCode}) and is NOT a "no such volume" response — ` +
        `refusing to treat this as absence:\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
  }
  let raw: { Name: string; Driver: string; Labels: Record<string, string> | null };
  try {
    raw = JSON.parse(result.stdout.trim()) as { Name: string; Driver: string; Labels: Record<string, string> | null };
  } catch (error) {
    throw new Error(
      `docker volume inspect "${name}" exited 0 but its output could not be parsed as JSON: ${String(error)}\nstdout:\n${result.stdout}`,
    );
  }
  const labels = raw.Labels ?? {};
  return {
    name: raw.Name,
    driver: raw.Driver,
    composeProject: labels["com.docker.compose.project"],
    composeVolumeKey: labels["com.docker.compose.volume"],
    labels,
  };
}

/**
 * Whether `name` currently exists. Delegates entirely to `inspectVolume`,
 * so an inspection FAILURE (daemon unreachable, permission denied,
 * malformed output) propagates as a thrown error here too, rather than
 * resolving to `false` — a caller asserting "this volume was deleted"
 * must never have that assertion pass merely because the check itself
 * failed.
 */
export async function volumeExists(name: string): Promise<boolean> {
  return (await inspectVolume(name)) !== undefined;
}

export interface VolumeDeletionCheck {
  name: string;
  ok: boolean;
  /** Present when `ok` is false — the exact reason deletion was refused, for a "requires manual inspection" report. */
  reason?: string;
}

export interface VolumeOwnershipContext {
  /** The Compose project this volume is expected to be labelled with. */
  expectedProjectName: string;
  /** Volume names that already existed on the daemon before this run started — see `listAllVolumeNames`. */
  baselineVolumeNames: readonly string[];
  /** Volume KEYS (docker-compose.yml's own `volumes:` keys, e.g. "postgres-data") declared `external: true` — a pre-existing user resource, never one this stack created. */
  externalVolumeKeys: readonly string[];
}

/**
 * The three — and only three — outcomes inspecting one volume name can
 * have, kept explicitly distinct so a destructive gate can never
 * confuse one for another:
 *   - `"exists"` — the volume is really there, with its real ownership.
 *   - `"absent"` — the daemon CONFIRMED no such volume exists (see
 *     `isVolumeNotFoundError`). There is nothing to delete and nothing
 *     to protect: this must never block a destructive step.
 *   - `"failed"` — inspecting it did not succeed at all (daemon
 *     unreachable, permission denied, malformed output — see
 *     `inspectVolume`'s own contract). This is NOT the same as absence
 *     and MUST block a destructive step: the volume could exist and we
 *     simply don't know.
 */
export type VolumeInspectionResult =
  | { status: "exists"; ownership: VolumeOwnership }
  | { status: "absent" }
  | { status: "failed"; error: string };

/** One volume name that had to be considered, together with how inspecting it actually went. */
export interface OwnedVolumeRecord {
  name: string;
  inspection: VolumeInspectionResult;
}

/**
 * Pure ownership gate for ONE volume, given an already-fetched
 * inspection result: it never queries the daemon itself, which is what
 * makes it independently unit-testable with constructed fakes (no real
 * Docker, no risk to any real volume).
 *
 * - `"absent"` is always `ok: true` — a CONFIRMED absence is not a
 *   reason to block anything; there is simply nothing there to delete.
 * - `"failed"` is always `ok: false` — an inspection FAILURE must never
 *   be treated as "safe to proceed," because the volume might still be
 *   there.
 * - `"exists"` is `ok: true` only when ALL of: the volume is NOT in
 *   `context.baselineVolumeNames` (it did not already exist before this
 *   run); its `com.docker.compose.project` label matches
 *   `context.expectedProjectName` exactly (it belongs to THIS disposable
 *   project, not a development stack or another project, and never a
 *   name-prefix guess); and its `com.docker.compose.volume` key is not
 *   one of `context.externalVolumeKeys` (not declared `external: true`,
 *   which would make it a pre-existing resource regardless of its
 *   labels).
 */
export function checkVolumeOwnershipForDeletion(
  name: string,
  inspection: VolumeInspectionResult,
  context: VolumeOwnershipContext,
): VolumeDeletionCheck {
  if (inspection.status === "absent") {
    return { name, ok: true };
  }
  if (inspection.status === "failed") {
    return { name, ok: false, reason: `could not be inspected: ${inspection.error}` };
  }
  const { ownership } = inspection;
  if (context.baselineVolumeNames.includes(name)) {
    return { name, ok: false, reason: "already existed on the daemon before this run started — it is a pre-existing resource" };
  }
  if (ownership.composeProject !== context.expectedProjectName) {
    return {
      name,
      ok: false,
      reason:
        `labelled com.docker.compose.project="${ownership.composeProject ?? "(none)"}", not the expected disposable ` +
        `project "${context.expectedProjectName}" — it may belong to a development stack or another user resource`,
    };
  }
  if (ownership.composeVolumeKey !== undefined && context.externalVolumeKeys.includes(ownership.composeVolumeKey)) {
    return {
      name,
      ok: false,
      reason: `implements volume key "${ownership.composeVolumeKey}", declared external:true — a pre-existing user resource`,
    };
  }
  return { name, ok: true };
}

export interface OwnershipGateResult {
  ok: boolean;
  checks: VolumeDeletionCheck[];
}

/**
 * The hard gate a destructive reset or cleanup must pass before
 * `--volumes` is ever issued: PURE and synchronous — it only classifies
 * already-fetched `records` (see `discoverVolumesRequiringInspection`
 * for how those are built), which is what makes it independently
 * unit-testable with constructed fakes. `ok` is true only when EVERY
 * record passes `checkVolumeOwnershipForDeletion`. An EMPTY `records`
 * list is itself refused — there is nothing to establish ownership of,
 * which must never be read as "nothing to check, proceed."
 */
export function evaluateOwnershipGate(records: readonly OwnedVolumeRecord[], context: VolumeOwnershipContext): OwnershipGateResult {
  if (records.length === 0) {
    return {
      ok: false,
      checks: [{ name: "(none)", ok: false, reason: "no volume was identified for this project — ownership cannot be established" }],
    };
  }
  const checks = records.map((record) => checkVolumeOwnershipForDeletion(record.name, record.inspection, context));
  return { ok: checks.every((check) => check.ok), checks };
}

export interface VolumeDiscoverySources {
  /**
   * The EXACT volume names `docker compose down --volumes` would target
   * for this project — i.e. a FRESH read of `resolveComposePersistence`'s
   * `volumeNames` values, using the SAME Compose file/project/env the
   * destructive step itself will use. MUST reject (never resolve to a
   * partial or stale list) when the configuration cannot be resolved —
   * `discoverVolumesRequiringInspection` propagates that rejection so
   * the caller fails closed.
   */
  resolveConfiguredVolumeNames: () => Promise<string[]>;
  /** Volume names the daemon's own `com.docker.compose.project` label filter reports for this project (e.g. `listVolumeNamesByComposeProject`). */
  listLabeledVolumeNames: () => Promise<string[]>;
  /** Inspects one volume name. Resolves to `undefined` ONLY for a CONFIRMED absence; any other failure must throw (see `inspectVolume`'s own contract). */
  inspectVolumeByName: (name: string) => Promise<VolumeOwnership | undefined>;
}

/**
 * Builds the full, de-duplicated set of volume names that MUST be
 * inspected before a destructive cleanup, and inspects every one.
 *
 * The set is the UNION of:
 *   - the volume names resolved from the EXACT Compose configuration the
 *     destructive step will use (`resolveConfiguredVolumeNames`) — this
 *     is what `docker compose down --volumes` actually targets, by
 *     NAME; and
 *   - whatever the daemon's own project-LABEL filter additionally
 *     reports (`listLabeledVolumeNames`).
 * Label-based discovery ALONE is not enough to gate a destructive step:
 * a volume whose NAME matches what Compose will target, but whose
 * `com.docker.compose.project` label is missing or wrong (created
 * out-of-band, relabeled, or a Compose/engine quirk), would never
 * appear in a label-filtered list — yet `docker compose down --volumes`
 * addresses volumes by NAME, not by label, and would still remove it.
 * The union closes exactly that gap.
 *
 * FAILS CLOSED: if EITHER `resolveConfiguredVolumeNames` or
 * `listLabeledVolumeNames` rejects, this rejects too, rather than
 * silently proceeding with whichever half succeeded — an INCOMPLETE
 * name set must never be treated as "nothing else to check." (Callers
 * such as `cleanupDisposableTargets` catch this and block the
 * destructive step for that target entirely, reporting the failure.)
 *
 * A single name's OWN inspection failure, by contrast, does NOT abort
 * this whole function: once the complete name set is known, every name
 * is inspected independently, and a failure for one is recorded as that
 * record's own `{status:"failed"}` (see `VolumeInspectionResult`) so
 * every other volume's real status is still reported — never silently
 * dropped, and never confused with a confirmed `"absent"`.
 */
export async function discoverVolumesRequiringInspection(sources: VolumeDiscoverySources): Promise<OwnedVolumeRecord[]> {
  const [configuredNames, labeledNames] = await Promise.all([sources.resolveConfiguredVolumeNames(), sources.listLabeledVolumeNames()]);
  const unionNames = Array.from(new Set([...configuredNames, ...labeledNames]));
  return Promise.all(
    unionNames.map(async (name): Promise<OwnedVolumeRecord> => {
      try {
        const ownership = await sources.inspectVolumeByName(name);
        return { name, inspection: ownership ? { status: "exists", ownership } : { status: "absent" } };
      } catch (error) {
        return { name, inspection: { status: "failed", error: String(error) } };
      }
    }),
  );
}

export interface ProvisioningSafetyCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Validates a RESOLVED Compose configuration is safe to provision as a
 * disposable project — called BEFORE any container or volume is
 * created, using only the static `docker compose config` output (no
 * daemon query, which is what makes this pure and unit-testable with a
 * constructed `ResolvedComposePersistence`). Every declared volume must:
 *   - Resolve to a name actually prefixed by the project's own name
 *     (`<project>_<key>` or `<project>-<key>`), so it cannot collide
 *     with a different project's volume.
 *   - Not be declared `external: true` — that would point at a
 *     pre-existing user resource this stack must never create or
 *     destroy.
 *   - Not already exist on the daemon (the pre-captured baseline) —
 *     catches the one scenario volume-name-prefixing alone cannot: a
 *     volume that, by coincidence or a reused project name, already
 *     exists under the exact name this run is about to use.
 */
export function checkProvisioningSafety(
  resolved: ResolvedComposePersistence,
  baselineVolumeNames: readonly string[],
): ProvisioningSafetyCheck {
  const problems: string[] = [];
  if (resolved.externalVolumes.length > 0) {
    problems.push(`volume key(s) declared external:true: ${resolved.externalVolumes.join(", ")} — refusing a pre-existing resource`);
  }
  for (const [key, name] of Object.entries(resolved.volumeNames)) {
    if (!name.startsWith(`${resolved.projectName}_`) && !name.startsWith(`${resolved.projectName}-`)) {
      problems.push(`volume "${name}" (key "${key}") is not scoped to project "${resolved.projectName}" by name`);
    }
    if (baselineVolumeNames.includes(name)) {
      problems.push(`volume "${name}" (key "${key}") already exists on the daemon before this run started`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** `checkProvisioningSafety`, but throws — stopping short of provisioning anything — when the check fails. */
export function assertProvisioningSafety(resolved: ResolvedComposePersistence, baselineVolumeNames: readonly string[]): void {
  const check = checkProvisioningSafety(resolved, baselineVolumeNames);
  if (!check.ok) {
    throw new Error(`Refusing to provision disposable project "${resolved.projectName}":\n- ${check.problems.join("\n- ")}`);
  }
}

/**
 * `composeDownKeepVolumes`, but throws on a nonzero exit instead of
 * returning a result the caller might forget to check. `options.env` is
 * forwarded to `composeDownKeepVolumes` unchanged.
 */
export async function removeContainersKeepingVolumesOrThrow(
  project: ComposeProject,
  options: { timeoutMs?: number; env?: ComposeEnv } = {},
): Promise<void> {
  const result = await composeDownKeepVolumes(project, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker compose down (keeping volumes) failed for project "${project.projectName}" (exit ${result.exitCode}):\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

export interface DisposableCleanupTarget {
  /** Identifies this target in a reported outcome — typically the Compose project name. */
  label: string;
  /**
   * Produces the full set of volumes requiring inspection for this
   * target (see `discoverVolumesRequiringInspection` — the union of the
   * exact configured names and whatever label-based discovery reports,
   * each already paired with its inspection result). Resolving this
   * here, rather than inside `cleanupDisposableTargets` itself, is what
   * keeps that function's own decision logic pure and independently
   * unit-testable with constructed fakes — no real Docker call is
   * hard-wired into it. MUST reject (fail closed) rather than resolve
   * to a partial list when the underlying configuration cannot be
   * resolved — see `discoverVolumesRequiringInspection`'s own contract.
   */
  discoverVolumes: () => Promise<OwnedVolumeRecord[]>;
  /** Context used to verify EVERY discovered volume immediately before any is destroyed. */
  ownershipContext: VolumeOwnershipContext;
  /** Removes this target's containers/network but KEEPS its volumes. Always safe to call: it never touches another target's resources, and never deletes data. */
  removeContainersKeepingVolumes: () => Promise<void>;
  /** Removes this target's containers/network AND its named volumes. Only ever invoked by `cleanupDisposableTargets` after every discovered volume has passed the ownership gate. */
  removeContainersAndVolumes: () => Promise<void>;
}

export interface DisposableCleanupOutcome {
  label: string;
  volumesDeleted: string[];
  volumesRequiringManualInspection: { name: string; reason: string }[];
  /** Set when something about processing this target itself failed (discovering its volumes, or either removal call) — includes a failed/fail-closed configuration resolution. */
  error?: string;
}

/**
 * Cleans up multiple disposable targets independently and safely.
 *
 * For EACH target: discovers every volume that must be inspected
 * (`discoverVolumes` — the union of configured and label-discovered
 * names, never label discovery alone), then re-checks EVERY one of them
 * with the PURE `evaluateOwnershipGate` immediately before any
 * destructive step — never relying on an ownership check performed
 * earlier in the test run, since the exact resources present at cleanup
 * time are what matters. Only when EVERY volume passes is
 * `removeContainersAndVolumes` invoked; otherwise this REFUSES the
 * destructive step for that target entirely (removing only
 * containers/network, which is always safe since they belong solely to
 * that target's own Compose project) and reports exactly which volumes
 * require manual inspection, with why. Only volumes CONFIRMED to exist
 * are reported as `volumesDeleted` — a confirmed-absent one had nothing
 * to delete.
 *
 * A failure processing ONE target (discovering its volumes — including
 * a fail-closed configuration-resolution failure — or either removal
 * call throwing) is caught and reported in that target's own outcome —
 * it never stops or skips the other targets, which is what makes this
 * safe to use for partial setup (e.g. a target whose containers never
 * actually started).
 */
export async function cleanupDisposableTargets(targets: DisposableCleanupTarget[]): Promise<DisposableCleanupOutcome[]> {
  return Promise.all(
    targets.map(async (target): Promise<DisposableCleanupOutcome> => {
      try {
        const records = await target.discoverVolumes();
        const gate = evaluateOwnershipGate(records, target.ownershipContext);
        if (!gate.ok) {
          await target.removeContainersKeepingVolumes();
          return {
            label: target.label,
            volumesDeleted: [],
            volumesRequiringManualInspection: gate.checks
              .filter((check) => !check.ok)
              .map((check) => ({ name: check.name, reason: check.reason ?? "unknown" })),
          };
        }

        await target.removeContainersAndVolumes();
        const volumesDeleted = records.filter((record) => record.inspection.status === "exists").map((record) => record.name);
        return { label: target.label, volumesDeleted, volumesRequiringManualInspection: [] };
      } catch (error) {
        return { label: target.label, volumesDeleted: [], volumesRequiringManualInspection: [], error: String(error) };
      }
    }),
  );
}

/**
 * Builds a REAL, Docker-backed `DisposableCleanupTarget` for `project`.
 *
 * `discoverVolumes` re-resolves the Compose configuration FRESH, at the
 * moment cleanup actually runs — "the exact Compose configuration used
 * for cleanup" — rather than reusing a value cached from setup time;
 * a resolution failure there propagates (fails closed), which
 * `cleanupDisposableTargets` reports as this target's own `error`
 * without ever attempting a deletion. `externalVolumeKeys` on the
 * returned `ownershipContext` is read from a SEPARATE, best-effort
 * resolution (degrading to `[]` on failure) — this is only a secondary
 * signal for the ownership context; the baseline/project-label checks
 * remain the dominant guard, and the PRIMARY fail-closed behavior is
 * `discoverVolumes` above.
 *
 * `env` — the SAME `ComposeEnv` this function receives — is used for
 * BOTH halves of the gate/act pair: resolving the configuration
 * (`discoverVolumes`'s `resolveConfiguredVolumeNames` and the
 * `externalVolumeKeys` lookup above) AND the actual cleanup commands
 * (`removeContainersKeepingVolumes`/`removeContainersAndVolumes`
 * below). Environment overrides can change which volume names, ports,
 * or database targets a Compose project resolves to; a cleanup command
 * run under a DIFFERENT environment than the one its own gate just
 * validated could target a different, unverified configuration. Using
 * one single `env` value throughout this target is what rules that out.
 */
export async function createComposeCleanupTarget(
  project: ComposeProject,
  env: ComposeEnv,
  baselineVolumeNames: readonly string[],
): Promise<DisposableCleanupTarget> {
  const externalVolumeKeys = await resolveComposePersistence(project, env)
    .then((resolved) => resolved.externalVolumes)
    .catch(() => [] as string[]);

  return {
    label: project.projectName,
    discoverVolumes: () =>
      discoverVolumesRequiringInspection({
        resolveConfiguredVolumeNames: () =>
          resolveComposePersistence(project, env).then((resolved) => Object.values(resolved.volumeNames)),
        listLabeledVolumeNames: () => listVolumeNamesByComposeProject(project),
        inspectVolumeByName: (name) => inspectVolume(name),
      }),
    ownershipContext: { expectedProjectName: project.projectName, baselineVolumeNames, externalVolumeKeys },
    // Both removal calls receive the SAME `env` this function was given
    // — the identical overrides `discoverVolumes` above uses to resolve
    // the configuration being torn down. This is the fix: a destructive
    // or volume-preserving cleanup command must never run against a
    // DIFFERENT environment than the one its own ownership gate just
    // validated against.
    removeContainersKeepingVolumes: () => removeContainersKeepingVolumesOrThrow(project, { timeoutMs: 180000, env }),
    removeContainersAndVolumes: () => cleanupComposeProject(project, { timeoutMs: 180000, env }),
  };
}

export interface ComposeBindMount {
  source: string;
  target: string;
  readOnly: boolean;
}

/** Host/port/database parsed out of a connection string — deliberately never its credentials or its raw value. */
export interface DatabaseTarget {
  host: string;
  port: string;
  database: string;
}

export interface ResolvedComposePersistence {
  /** The Compose project name the resolved configuration will actually use. */
  projectName: string;
  /** Volume key declared in docker-compose.yml -> the real Docker volume name Compose will create. */
  volumeNames: Record<string, string>;
  /** Volume keys declared `external: true` — a pre-existing user resource a test must never delete. */
  externalVolumes: string[];
  /** Service name -> its bind mounts (host source path, container target, read-only flag). */
  bindMounts: Record<string, ComposeBindMount[]>;
  /** Service name -> `*_DATABASE_URL` variable -> its host/port/database. Credentials are discarded, never returned. */
  databaseTargets: Record<string, Record<string, DatabaseTarget>>;
}

/**
 * Resolves the merged Compose configuration and extracts ONLY the
 * persistence facts a test needs: volume names and their external flag,
 * bind mounts, and the host/port/database of every `*_DATABASE_URL`.
 *
 * The underlying `docker compose config --format json` output echoes
 * every interpolated development-only placeholder in plaintext
 * (POSTGRES_PASSWORD, and the credentials embedded in each connection
 * string) — which is exactly why `composeConfigQuiet` exists. This
 * function therefore parses that document in-process and returns only
 * the narrow, credential-free shape above: it never returns it, logs it,
 * or includes it in an error message (a failure reports stderr only,
 * never stdout). Callers must preserve that property.
 *
 * Requires the `docker compose` CLI but NOT a running daemon.
 */
export async function resolveComposePersistence(project: ComposeProject, env: ComposeEnv): Promise<ResolvedComposePersistence> {
  const args = composeArgs(project, ["config", "--format", "json"]);
  const result = await runToCompletion("docker", args, { cwd: project.cwd, env: withEnv(env), timeoutMs: 60000 });
  if (result.exitCode !== 0) {
    throw new Error(`docker compose config --format json failed (exit ${result.exitCode}):\n${result.stderr}`);
  }

  const parsed = JSON.parse(result.stdout) as {
    name?: string;
    volumes?: Record<string, { name?: string; external?: boolean } | null>;
    services?: Record<
      string,
      {
        volumes?: { type?: string; source?: string; target?: string; read_only?: boolean }[];
        environment?: Record<string, string | null>;
      }
    >;
  };

  const volumeNames: Record<string, string> = {};
  const externalVolumes: string[] = [];
  for (const [key, definition] of Object.entries(parsed.volumes ?? {})) {
    volumeNames[key] = definition?.name ?? `${parsed.name ?? project.projectName}_${key}`;
    if (definition?.external === true) externalVolumes.push(key);
  }

  const bindMounts: Record<string, ComposeBindMount[]> = {};
  const databaseTargets: Record<string, Record<string, DatabaseTarget>> = {};
  for (const [serviceName, service] of Object.entries(parsed.services ?? {})) {
    const binds = (service.volumes ?? [])
      .filter((mount) => mount.type === "bind")
      .map((mount) => ({ source: mount.source ?? "", target: mount.target ?? "", readOnly: mount.read_only === true }));
    if (binds.length > 0) bindMounts[serviceName] = binds;

    for (const [variable, value] of Object.entries(service.environment ?? {})) {
      if (!variable.endsWith("_DATABASE_URL") || typeof value !== "string" || value.length === 0) continue;
      const url = new URL(value);
      databaseTargets[serviceName] ??= {};
      // hostname/port/pathname only — the username and password are dropped here and never leave this function.
      databaseTargets[serviceName][variable] = {
        host: url.hostname,
        port: url.port,
        database: url.pathname.replace(/^\//, ""),
      };
    }
  }

  return { projectName: parsed.name ?? project.projectName, volumeNames, externalVolumes, bindMounts, databaseTargets };
}

/** One `ports:` entry as `docker compose config --format json` resolves it for a service. */
export interface ResolvedComposePort {
  /** The container-side port being published. */
  target: number;
  /** Host-side port, when published (may be unset for an ephemeral/unspecified mapping). */
  published?: string;
  /** Host IP the port is bound to, exactly as resolved — e.g. `"127.0.0.1"`, `"0.0.0.0"`, or unset (meaning every interface). Never assume loopack when this is absent. */
  hostIp?: string;
  protocol?: string;
}

/**
 * Resolves the merged Compose configuration and extracts ONLY each
 * service's declared `ports:` entries (never bind mounts, volumes, or
 * environment — see `resolveComposePersistence` for those). Read-only and
 * safe at any time: it runs `docker compose config`, which requires the
 * `docker compose` CLI but not a running daemon, and creates nothing.
 *
 * This is the STATIC half of this sub-issue's port-exposure proof — it
 * confirms what Compose WOULD publish for a given environment, before any
 * container exists. See `getContainerHostPortBindings` below for the
 * matching RUNTIME half (the actual bindings an already-running container
 * was created with).
 */
export async function resolveComposePublishedPorts(project: ComposeProject, env: ComposeEnv): Promise<Record<string, ResolvedComposePort[]>> {
  const args = composeArgs(project, ["config", "--format", "json"]);
  const result = await runToCompletion("docker", args, { cwd: project.cwd, env: withEnv(env), timeoutMs: 60000 });
  if (result.exitCode !== 0) {
    throw new Error(`docker compose config --format json failed (exit ${result.exitCode}):\n${result.stderr}`);
  }

  const parsed = JSON.parse(result.stdout) as {
    services?: Record<string, { ports?: { target?: number; published?: string; host_ip?: string; protocol?: string }[] }>;
  };

  const out: Record<string, ResolvedComposePort[]> = {};
  for (const [serviceName, service] of Object.entries(parsed.services ?? {})) {
    out[serviceName] = (service.ports ?? []).map((entry) => ({
      target: entry.target ?? 0,
      published: entry.published,
      hostIp: entry.host_ip,
      protocol: entry.protocol,
    }));
  }
  return out;
}

/** One host-port binding for a container, as `docker inspect`'s `HostConfig.PortBindings` reports it. */
export interface ContainerPortBinding {
  hostIp: string;
  hostPort: string;
}

/**
 * The actual host-port bindings `service`'s container was CREATED with —
 * `docker inspect`'s `HostConfig.PortBindings`, keyed by `"<containerPort>/<protocol>"`
 * (e.g. `"80/tcp"`). Deliberately reads `HostConfig.PortBindings`, not
 * `NetworkSettings.Ports`: the latter only reflects ACTIVE bindings while a
 * container is running and can read back empty for an already-exited
 * container (e.g. `migrate-control`/`migrate-project`, which exit quickly),
 * even though its publish configuration is unchanged — `HostConfig.PortBindings`
 * is fixed at container-creation time and is therefore accurate whether the
 * container is running, exited, or stopped.
 *
 * A container that declares no `ports:` at all resolves to `{}` (Docker
 * never adds an EXPOSE-only port here — only an explicit publish does),
 * which is exactly the proof this sub-issue needs for `api`/`web`/`postgres`/
 * `worker`/the migration services: no host port exposure, regardless of
 * what the image itself exposes internally.
 *
 * Works on an already-exited container too (uses `getContainerId`'s own
 * `-a` lookup) — required for the one-shot migration services.
 */
export async function getContainerHostPortBindings(project: ComposeProject, service: string): Promise<Record<string, ContainerPortBinding[] | null>> {
  const containerId = await getContainerId(project, service);
  if (!containerId) {
    throw new Error(`No container found for service "${service}" in project ${project.projectName}`);
  }
  const inspect = await runToCompletion("docker", ["inspect", containerId, "--format", "{{json .HostConfig.PortBindings}}"], {
    timeoutMs: 15000,
  });
  if (inspect.exitCode !== 0) {
    throw new Error(`docker inspect "${containerId}" failed (exit ${inspect.exitCode}):\n${inspect.stderr}`);
  }
  const raw = JSON.parse(inspect.stdout.trim() || "null") as Record<string, { HostIp: string; HostPort: string }[] | null> | null;
  if (!raw) return {};
  const result: Record<string, ContainerPortBinding[] | null> = {};
  for (const [portKey, bindings] of Object.entries(raw)) {
    result[portKey] = bindings ? bindings.map((binding) => ({ hostIp: binding.HostIp, hostPort: binding.HostPort })) : null;
  }
  return result;
}

/**
 * Whether `hostIp` is a genuinely loopback-only bind address. ONLY
 * `"127.0.0.1"` qualifies — never a wildcard (`"0.0.0.0"`, `"::"`), never
 * the empty string (Docker's own shorthand for "every interface," the same
 * as `0.0.0.0`), and never IPv6 loopback `"::1"` either, since this
 * stack's own published services are always configured with the literal
 * IPv4 loopback address (see docker-compose.yml) — accepting `::1` here
 * too would let a silent IPv6-wildcard regression (`::`, which Linux can
 * map to dual-stack `0.0.0.0`-like exposure) pass unnoticed.
 *
 * Pure and synchronous — independently unit-testable with synthetic
 * values, no Docker required. Used to validate BOTH the static resolved
 * configuration (`resolveComposePublishedPorts`) and real running
 * containers' bindings (`getContainerHostPortBindings`).
 */
export function isLoopbackOnlyHostIp(hostIp: string | undefined): boolean {
  return hostIp === "127.0.0.1";
}

/**
 * Asserts every binding in `bindings` (as returned by
 * `getContainerHostPortBindings` or adapted from `resolveComposePublishedPorts`)
 * is loopback-only, throwing with the exact offending port/address
 * otherwise. `context` names what is being checked, for a readable
 * failure. A service with no bindings at all (`{}`) trivially passes —
 * this function only rejects a genuinely unsafe PUBLISHED binding, never
 * the absence of one.
 */
export function assertLoopbackOnlyBindings(bindings: Record<string, ContainerPortBinding[] | null>, context: string): void {
  for (const [portKey, list] of Object.entries(bindings)) {
    if (!list) continue;
    for (const binding of list) {
      if (!isLoopbackOnlyHostIp(binding.hostIp)) {
        throw new Error(
          `${context}: port ${portKey} is published on host address "${binding.hostIp}", not loopback-only ("127.0.0.1") — ` +
            `this is a wildcard or otherwise non-loopback bind, exposing the service beyond the local host.`,
        );
      }
    }
  }
}
