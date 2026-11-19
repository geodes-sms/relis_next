#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ConfigValidationError,
  checkPortConflicts,
  loadApiConfig,
  loadDatabaseConfigForTarget,
  loadWebRuntimeConfig,
  loadWorkerConfig,
  PortConflictError,
  resolveEffectiveEnv,
  validateConsistentRuntimeMode,
  validateRuntimeMode,
} from "@relis/config";
import { parsePublicWebConfig } from "@relis/config/public";

/**
 * Minimal local deployment entry point: validates every selected
 * process's configuration up front, runs the control-database migration,
 * builds each app, runs apps/worker once (see below), then starts and
 * supervises apps/api and apps/web (production `start`) as long-running
 * child processes.
 *
 * apps/worker currently only logs its own startup and exits (no queue
 * consumer exists yet — see AGENTS.md/context/stack.yml: background-job
 * technology is still undecided, and this task does not decide it or turn
 * the worker into one). It is therefore run as a completing STEP here,
 * like build/migrate, not as a supervised long-running service: treating
 * its intentional, preserved exit as a supervised process's "unexpected
 * exit" would tear down an otherwise-successful deployment. When a real
 * queue consumer is implemented, apps/worker belongs in the supervised
 * service set below instead.
 *
 * This is plain Node child-process orchestration — no Docker, no CI/CD, no
 * new orchestration technology. Docker Compose remains the prescribed
 * local/dev/test runtime (context/stack.yml) but is a separate,
 * unauthorized-here scaffolding effort (see README "Deployment").
 *
 * Usage: node tooling/scripts/deploy.mjs [--skip-migrate] [--skip-build] [--skip-worker]
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const apiDir = path.join(repoRoot, "apps", "api");
const webDir = path.join(repoRoot, "apps", "web");
const workerDir = path.join(repoRoot, "apps", "worker");
const databaseDir = path.join(repoRoot, "packages", "database");

function require_(specifier, fromDir) {
  const require = createRequire(pathToFileURL(path.join(fromDir, "package.json")));
  return require.resolve(specifier);
}

function resolveTsxBin() {
  const tsxPackageJson = require_("tsx/package.json", databaseDir);
  return path.join(path.dirname(tsxPackageJson), "dist", "cli.mjs");
}

/**
 * Resolves every selected process's effective configuration independently
 * from the SAME base environment snapshot (mirroring check-ports — see
 * packages/config/src/ports.ts): apps/api, apps/web, apps/worker, AND the
 * control database (packages/database), each via `resolveEffectiveEnv`
 * with the same root/package/tier precedence the standalone entry points
 * themselves use — not read directly from `baseEnv`/`process.env`, which
 * would silently ignore any `.env` file those entry points would
 * otherwise have honored.
 *
 * Validates each with its own existing schema (no duplicated rules), plus
 * apps/web's additional NODE_ENV-consistency rule (the same one
 * apps/web/scripts/run.mjs enforces on itself), and checks for a port
 * conflict between apps/api and apps/web. Nothing is spawned as part of
 * this function: a failure here — including a failure to even RESOLVE an
 * environment, not just to validate one — must prevent every subsequent
 * build/migrate/start step, and is always reported as a safe diagnostic,
 * never a raw exception or value.
 *
 * On success, every returned env has its NODE_ENV explicitly set to the
 * exact `mode` used here for tier selection. Each entry point re-runs its
 * own (lenient) env-file resolution when it starts; explicitly forcing
 * NODE_ENV to the already-decided mode means that re-resolution can only
 * ever confirm the same mode, never silently diverge to a different one.
 */
export function validateDeployment(baseEnv, options = {}) {
  let mode;
  let apiEnv;
  let webEnv;
  let workerEnv;
  let databaseEnv;

  try {
    // Initial mode selection is INSIDE the safe boundary too: an
    // invalid/empty OS-provided NODE_ENV must produce the same structured,
    // value-free diagnostic as every other failure here, not escape as an
    // uncaught exception.
    mode = validateRuntimeMode(baseEnv.NODE_ENV, "production", "deploy");
    apiEnv = resolveEffectiveEnv(mode, apiDir, baseEnv);
    webEnv = resolveEffectiveEnv(mode, webDir, baseEnv);
    workerEnv = resolveEffectiveEnv(mode, workerDir, baseEnv);
    databaseEnv = resolveEffectiveEnv(mode, databaseDir, baseEnv);

    loadApiConfig(apiEnv);
    loadWorkerConfig(workerEnv);
    loadWebRuntimeConfig(webEnv);
    parsePublicWebConfig({ NEXT_PUBLIC_API_URL: webEnv.NEXT_PUBLIC_API_URL });
    // The same rule apps/web/scripts/run.mjs enforces on itself: an
    // invalid/empty/conflicting file-provided NODE_ENV must be rejected
    // here too, before any deployment side effect — not only when
    // apps/web happens to be started directly.
    validateConsistentRuntimeMode(webEnv.NODE_ENV, mode);
    checkPortConflicts(apiEnv, webEnv);
    if (!options.skipMigrate) {
      // Only the control database is migrated automatically here: the
      // project schema is applied per-project (see README "Migration"),
      // not as a single global deploy step, and is out of scope.
      loadDatabaseConfigForTarget("control", databaseEnv);
    }
  } catch (error) {
    if (error instanceof ConfigValidationError || error instanceof PortConflictError) {
      return { ok: false, diagnostic: error.toDiagnostic(), mode, apiEnv, webEnv, workerEnv, databaseEnv };
    }
    // An unexpected failure (e.g. an I/O error resolving a .env file)
    // must still produce a safe, value-free diagnostic instead of letting
    // a raw exception — and whatever it might contain — propagate.
    return {
      ok: false,
      diagnostic: { code: "CONFIG_INVALID", process: "deploy", categories: ["runtime"], variables: [] },
      mode,
      apiEnv,
      webEnv,
      workerEnv,
      databaseEnv,
    };
  }

  apiEnv.NODE_ENV = mode;
  webEnv.NODE_ENV = mode;
  workerEnv.NODE_ENV = mode;
  databaseEnv.NODE_ENV = mode;

  return { ok: true, diagnostic: null, mode, apiEnv, webEnv, workerEnv, databaseEnv };
}

function spawnAndWait(spawnFn, command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, options);
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

/**
 * Runs steps strictly in order and stops at the first nonzero result,
 * never invoking any later step. Pure orchestration with no knowledge of
 * what a step actually does — this is the seam tests use with injected
 * fake steps to prove ordering and failure propagation without running
 * any real build, migration, or process.
 */
export async function runSteps(steps) {
  for (const step of steps) {
    const exitCode = await step.run();
    if (exitCode !== 0) {
      return { ok: false, failedStep: step.name, exitCode };
    }
  }
  return { ok: true, failedStep: null, exitCode: 0 };
}

export function createMigrateStep(target, env, options = {}) {
  const spawnFn = options.spawnFn ?? spawn;
  return {
    name: `migrate:${target}`,
    run: () =>
      spawnAndWait(spawnFn, process.execPath, [resolveTsxBin(), path.join(databaseDir, "src", "migrate.ts"), target], {
        stdio: "inherit",
        env,
        cwd: databaseDir,
      }),
  };
}

export function createBuildStep(name, filterArgs, env, options = {}) {
  const spawnFn = options.spawnFn ?? spawn;
  return {
    name: `build:${name}`,
    run: () => spawnAndWait(spawnFn, "pnpm", filterArgs, { stdio: "inherit", shell: true, env, cwd: repoRoot }),
  };
}

/**
 * Runs apps/worker to completion as a step (see the module docstring for
 * why it is not part of the supervised long-running service set).
 */
export function createWorkerStep(env, options = {}) {
  const spawnFn = options.spawnFn ?? spawn;
  return {
    name: "worker",
    run: () =>
      spawnAndWait(spawnFn, process.execPath, [path.join(workerDir, "dist", "main.js")], {
        stdio: "inherit",
        env,
        cwd: workerDir,
      }),
  };
}

const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

/** Bounds how long a single termination COMMAND (not the whole shutdown) may run. */
const KILL_COMMAND_TIMEOUT_MS = 5000;

/**
 * Kills `pid` AND every descendant IT directly owns, on both supported
 * platforms, targeting only that specific pid — never anything unrelated:
 *  - Windows: `taskkill /PID <pid> /T /F` walks the OS-maintained
 *    parent/child records and force-terminates the whole tree. This does
 *    not depend on the target cooperating with a signal at all, which
 *    matters because a plain `child.kill(signal)` on Windows only ever
 *    reaches the immediate child (never further descendants), and is not
 *    guaranteed to invoke a registered `process.on(signal)` handler in the
 *    target the way a real POSIX signal delivery would. IMPORTANT: this
 *    only works while `pid` is still alive — Windows cannot enumerate the
 *    children of a pid that has already exited (see `knownDescendantPids`
 *    below for how an already-dead pid's descendants are still reached).
 *  - POSIX: sends `signal` to the negative pid (the whole process group),
 *    which requires the child to have been spawned with `detached: true`
 *    (making it its own group leader). Unlike Windows, a POSIX process
 *    group ID remains valid for `kill(-pgid, ...)` as long as ANY member
 *    is still alive, even after the original leader has exited. Falls
 *    back to signaling the single pid if group-signaling fails (e.g. it
 *    was never a group leader).
 * The underlying OS command itself is bounded (`KILL_COMMAND_TIMEOUT_MS`)
 * so a hung `taskkill` can never leave this — or anything awaiting it —
 * pending forever; a command failure or timeout resolves `false` rather
 * than throwing, since callers separately CONFIRM the actual outcome by
 * polling liveness (see `waitForPidExit`) rather than trusting the
 * command's own reported success.
 */
function killPid(pid, signal) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: KILL_COMMAND_TIMEOUT_MS }, (error) => {
        resolve(!error);
      });
      return;
    }
    try {
      process.kill(-pid, signal ?? "SIGKILL");
      resolve(true);
    } catch {
      try {
        process.kill(pid, signal ?? "SIGKILL");
        resolve(true);
      } catch {
        resolve(false); // already exited, or never existed
      }
    }
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Polls an ARBITRARY pid (one this process did not itself spawn, so there
 * is no ChildProcess object or "exit" event to listen for) until it is no
 * longer alive, or `timeoutMs` elapses. Used to CONFIRM that a descendant
 * reported over a service's own IPC channel has actually terminated,
 * rather than assuming a kill command's own reported success is enough.
 */
function waitForPidExit(pid, timeoutMs, intervalMs = 100) {
  if (!isPidAlive(pid)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (!isPidAlive(pid)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

/**
 * The default spawnFn used by startAndSupervise:
 *  - Spawns detached on POSIX (so the child becomes its own process-group
 *    leader and `killPid` can target the whole group even after the
 *    leader itself has exited) — a no-op distinction on Windows, where
 *    tree relationships are tracked by the OS regardless of `detached`.
 *  - Adds a 4th ("ipc") stdio slot alongside whatever the caller asked
 *    for, so a Node.js service can optionally report a descendant pid it
 *    owns via `process.send({ type: "descendant-pid", pid })` — see
 *    `startAndSupervise`'s `knownDescendantPids` tracking below. A service
 *    that never calls `process.send` is entirely unaffected.
 */
function defaultSpawnService(command, args, options) {
  const requestedStdio = options.stdio ?? "inherit";
  const baseStdio = Array.isArray(requestedStdio) ? requestedStdio : [requestedStdio, requestedStdio, requestedStdio];
  const spawnOptions = {
    ...options,
    stdio: [...baseStdio, "ipc"],
    ...(process.platform === "win32" ? {} : { detached: true }),
  };
  return spawn(command, args, spawnOptions);
}

/** Waits for a CHILD PROCESS THIS FUNCTION SPAWNED to emit "exit", bounded by `timeoutMs`. */
function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

/** Bounds how many times a still-alive descendant pid is forcefully re-killed before giving up on it. */
const MAX_DESCENDANT_KILL_ATTEMPTS = 2;

/**
 * Forces an arbitrary (already-spawned, possibly parent-less) pid to exit,
 * confirming the outcome by polling liveness rather than trusting a single
 * kill command's own reported success — a hung or ignored kill command must
 * not be mistaken for a clean exit. Bounded to `MAX_DESCENDANT_KILL_ATTEMPTS`
 * so a stuck pid can never keep the caller waiting indefinitely; returns
 * whether the pid was actually confirmed gone.
 */
async function ensurePidGone(pid, killFn, gracePeriodMs) {
  if (!isPidAlive(pid)) return true;
  for (let attempt = 0; attempt < MAX_DESCENDANT_KILL_ATTEMPTS; attempt++) {
    await killFn(pid, "SIGKILL");
    if (await waitForPidExit(pid, gracePeriodMs)) return true;
  }
  return !isPidAlive(pid);
}

/**
 * Spawns every service and supervises the group's lifecycle:
 *  - If one fails to spawn (including a synchronous spawn exception) or
 *    exits unexpectedly (before a requested shutdown), every service —
 *    including the one that failed — and everything each one owns is
 *    terminated, and the returned promise resolves nonzero only AFTER
 *    every owned process has been confirmed to have actually exited (not
 *    merely "asked to").
 *  - A requested shutdown (`requestShutdown`, wired to SIGINT/SIGTERM by
 *    the caller) terminates every service the same way and resolves 0
 *    once cleanup is confirmed complete — never 0 if any owned process
 *    could not be confirmed gone.
 *  - Termination of a service's DIRECT process is bounded, in two steps,
 *    and the second step ALWAYS runs regardless of how the first went:
 *    (1) a cooperative signal (`child.kill(signal)`), giving a
 *    well-behaved process — including apps/web's wrapper, which forwards
 *    it to its own Next child — a chance to shut down its own tree on its
 *    own, bounded by `gracePeriodMs`; then (2) an unconditional,
 *    platform-appropriate tree-kill (`killFn`) targeting the same pid.
 *    Step 2 is not an "if step 1 failed" escalation: a direct child can
 *    appear to exit immediately (on Windows, a non-SIGKILL signal
 *    terminates the direct child outright, before it can forward anything
 *    to what it spawned) while still leaving a descendant it owns running.
 *  - Independently of the direct process's own exit status — including a
 *    direct process that already exited on its own, unexpectedly, before
 *    termination was ever requested — every pid a service has reported
 *    via its own IPC channel (`process.send({ type: "descendant-pid", pid
 *    })`, e.g. apps/web/scripts/run.mjs's Next child) is force-killed and
 *    its exit confirmed too. A dead parent's pid is never assumed
 *    sufficient to find or identify its descendants: only pids a service
 *    itself has reported are ever targeted this way, exactly the
 *    "appropriate mechanism" available on both platforms without a new
 *    dependency or unreliable process enumeration of an already-dead
 *    parent (Windows cannot enumerate a dead pid's children at all; a
 *    reported pid sidesteps that limitation entirely).
 *  - Never signals anything beyond the specific pids this function itself
 *    spawned or was explicitly told about (and their process groups on
 *    POSIX) — no broad or name-based process lookup is ever used.
 *
 * `options.spawnFn` is injectable so tests can simulate spawn failures
 * without depending on a specific missing executable; `options.killFn` is
 * injectable so lifecycle-ordering tests can observe termination calls
 * without real process trees, while separate tests use the real `killPid`
 * against harmless local fixtures to prove actual OS-level cleanup.
 */
export function startAndSupervise(services, options = {}) {
  const spawnFn = options.spawnFn ?? defaultSpawnService;
  const killFn = options.killFn ?? killPid;
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  const entries = new Map();
  let finalCode = 0;
  let cleanupFailed = false;
  let settled = false;
  let terminationPromise = null;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  function settle(code) {
    if (settled) return;
    settled = true;
    resolveExit(code);
  }

  /**
   * Terminates one entry's OWNED TREE: its direct process (if not already
   * exited) AND every descendant pid it has ever reported, regardless of
   * whether the direct process is currently alive, already exited
   * cooperatively, or already exited unexpectedly. Never throws — a
   * failure to confirm cleanup is recorded (`cleanupFailed`) and logged,
   * never silently treated as success.
   */
  async function terminate(entry, signal) {
    const { child } = entry;
    let directConfirmed = true;

    if (child !== null && !entry.exited) {
      const pid = child.pid;

      if (process.platform === "win32") {
        // See killPid's docstring: run the guaranteed tree-kill FIRST,
        // while the process (and its recorded parent/child relationships)
        // still exist, since a plain signal can terminate the direct
        // child immediately without it ever forwarding anything onward.
        if (pid !== undefined) {
          directConfirmed = await killFn(pid, "SIGKILL");
        }
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill(signal ?? "SIGTERM");
          } catch {
            /* already gone */
          }
        }
        const exited = await waitForChildExit(child, gracePeriodMs);
        directConfirmed = directConfirmed && exited;
      } else {
        // POSIX: signal the whole process group (this child was spawned
        // as its own group leader — see defaultSpawnService) first, so a
        // well-behaved process AND everything it owns gets a genuine
        // chance to shut down cooperatively.
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-pid, signal ?? "SIGTERM");
          } catch {
            try {
              child.kill(signal ?? "SIGTERM");
            } catch {
              /* already gone */
            }
          }
        }
        let exited = await waitForChildExit(child, gracePeriodMs);
        if (!exited && pid !== undefined) {
          await killFn(pid, "SIGKILL");
          exited = await waitForChildExit(child, gracePeriodMs);
        }
        directConfirmed = exited;
      }
      entry.exited = true;
    }

    // Independently of the direct process's fate: clean up every
    // descendant this service ever told us about. This is what reaches a
    // wrapper's still-alive child even when the wrapper itself already
    // exited (cooperatively or not) before this ran.
    let descendantsConfirmed = true;
    for (const descendantPid of entry.knownDescendantPids) {
      const gone = await ensurePidGone(descendantPid, killFn, gracePeriodMs);
      if (!gone) descendantsConfirmed = false;
    }

    if (!directConfirmed || !descendantsConfirmed) {
      cleanupFailed = true;
      console.error(JSON.stringify({ code: "SERVICE_CLEANUP_FAILED", service: entry.name }));
    }
  }

  /**
   * Starts (idempotently) terminating every owned tree and settles
   * `exitPromise` only once every one of them has been awaited — never on
   * the mere firing of a direct child's "exit" event. Safe to call
   * repeatedly (a requested shutdown racing an unexpected exit, or
   * multiple signals) — every call after the first returns the same
   * in-flight promise instead of starting a redundant, overlapping
   * termination pass.
   */
  function beginTermination(signal) {
    if (terminationPromise) return terminationPromise;
    terminationPromise = Promise.all([...entries.values()].map((entry) => terminate(entry, signal)))
      .then(() => {
        settle(cleanupFailed ? finalCode || 1 : finalCode);
      })
      .catch((error) => {
        console.error(
          JSON.stringify({ code: "SUPERVISOR_CLEANUP_ERROR", message: error instanceof Error ? error.message : String(error) }),
        );
        settle(finalCode || 1);
      });
    return terminationPromise;
  }

  // A synchronous spawn exception must still tear down every OTHER
  // service, including ones not yet spawned at the point of the throw —
  // so termination is deferred until every entry exists in `entries`,
  // rather than started immediately mid-loop (which would silently omit
  // any later service from the termination pass entirely).
  let hasSyncSpawnFailure = false;

  for (const service of services) {
    const entry = { name: service.name, child: null, exited: false, knownDescendantPids: new Set() };
    entries.set(service.name, entry);

    let child;
    try {
      child = spawnFn(service.command, service.args, {
        stdio: service.stdio ?? "inherit",
        env: service.env,
        cwd: service.cwd,
      });
    } catch {
      // A synchronous spawn exception leaves no ChildProcess to wait on or
      // signal at all — otherwise identical to an async "error" event.
      console.error(JSON.stringify({ code: "SERVICE_SPAWN_FAILED", service: service.name }));
      entry.exited = true;
      finalCode = finalCode || 1;
      hasSyncSpawnFailure = true;
      continue;
    }
    entry.child = child;

    if (typeof child.on === "function") {
      child.on("message", (message) => {
        if (message && message.type === "descendant-pid" && typeof message.pid === "number") {
          entry.knownDescendantPids.add(message.pid);
        }
      });
    }

    child.once("error", () => {
      console.error(JSON.stringify({ code: "SERVICE_SPAWN_FAILED", service: service.name }));
      entry.exited = true; // an async spawn error means there is no real process to wait for
      finalCode = finalCode || 1;
      void beginTermination();
    });

    child.once("exit", (code) => {
      const wasAlreadyShuttingDown = terminationPromise !== null;
      entry.exited = true;
      if (!wasAlreadyShuttingDown) {
        console.error(JSON.stringify({ code: "SERVICE_EXITED_UNEXPECTEDLY", service: service.name }));
        finalCode = code && code !== 0 ? code : 1;
        void beginTermination();
      }
    });
  }

  if (services.length === 0) {
    settle(0); // degenerate case: nothing to supervise or ever terminate
  } else if (hasSyncSpawnFailure) {
    void beginTermination();
  }

  function requestShutdown(signal) {
    void beginTermination(signal);
    return exitPromise;
  }

  return { exitPromise, requestShutdown };
}

function isMainModule() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

async function main() {
  const args = process.argv.slice(2);
  const skipMigrate = args.includes("--skip-migrate");
  const skipBuild = args.includes("--skip-build");
  const skipWorker = args.includes("--skip-worker");

  const validation = validateDeployment(process.env, { skipMigrate });
  if (!validation.ok) {
    console.error(JSON.stringify(validation.diagnostic));
    process.exit(1);
  }

  const { apiEnv, webEnv, workerEnv, databaseEnv } = validation;

  const steps = [];
  if (!skipMigrate) {
    // databaseEnv was already resolved (root/package env-file precedence)
    // AND validated above — including its CONTROL_DATABASE_URL and its
    // NODE_ENV forced to the same `mode` — so it is passed through
    // unchanged. Raw process.env is never re-read here.
    steps.push(createMigrateStep("control", databaseEnv));
  }
  if (!skipBuild) {
    steps.push(createBuildStep("api", ["--filter", "./apps/api", "build"], apiEnv));
    steps.push(createBuildStep("worker", ["--filter", "@relis/worker", "build"], workerEnv));
    steps.push(createBuildStep("web", ["--filter", "./apps/web", "build"], webEnv));
  }
  if (!skipWorker) {
    steps.push(createWorkerStep(workerEnv));
  }

  const stepResult = await runSteps(steps);
  if (!stepResult.ok) {
    console.error(JSON.stringify({ code: "DEPLOY_STEP_FAILED", step: stepResult.failedStep }));
    process.exit(stepResult.exitCode);
  }

  // Only api and web are genuinely long-running; see the module docstring
  // for why apps/worker is a completing step above instead.
  const services = [
    { name: "api", command: process.execPath, args: [path.join(apiDir, "dist", "main.js")], env: apiEnv, cwd: apiDir },
    {
      name: "web",
      command: process.execPath,
      args: [path.join(webDir, "scripts", "run.mjs"), "start"],
      env: webEnv,
      cwd: webDir,
    },
  ];

  const supervisor = startAndSupervise(services);
  process.on("SIGINT", () => supervisor.requestShutdown("SIGINT"));
  process.on("SIGTERM", () => supervisor.requestShutdown("SIGTERM"));

  const exitCode = await supervisor.exitPromise;
  process.exit(exitCode);
}

if (isMainModule()) {
  main();
}
