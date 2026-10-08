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
 */
export async function composeDown(project: ComposeProject, options: { timeoutMs?: number } = {}): Promise<SpawnResult> {
  const args = composeArgs(project, ["down", "--volumes", "--remove-orphans"]);
  return runToCompletion("docker", args, { cwd: project.cwd, timeoutMs: options.timeoutMs ?? 120000 });
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
 */
export async function cleanupComposeProject(project: ComposeProject, options: { timeoutMs?: number } = {}): Promise<void> {
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
async function getContainerId(project: ComposeProject, service: string): Promise<string | undefined> {
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
