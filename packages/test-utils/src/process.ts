import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

// On Windows, spawning with shell:true runs the command inside a cmd.exe
// wrapper; killing that wrapper process does NOT kill the real process it
// launched (e.g. node/next), leaking a listener that outlives the test.
// taskkill /T kills the whole process tree instead.
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Already exited.
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
}

/**
 * Terminates the process tree owned by `runToCompletion`'s own child —
 * never any other process. `shell:true` means `pid` is the wrapping
 * shell's own pid, not necessarily the real program's, and on
 * Linux/macOS a plain `process.kill(pid, ...)` reaches ONLY that shell
 * process: whether the shell happens to exec-replace itself with the
 * real program (sharing the same pid) or instead forks a child (a
 * separate pid) is shell-implementation-dependent and not something to
 * rely on, so a single-pid signal can leave real descendants running.
 *
 * On Windows, `taskkill /PID <pid> /T /F` already walks the OS's own
 * parent/child records and force-terminates the whole tree regardless of
 * shell behavior, so this is unchanged from `killProcessTree` above.
 *
 * On POSIX, reaching descendants reliably instead requires signaling the
 * NEGATIVE pid — the whole process GROUP — which only reaches exactly
 * this invocation's own subtree because `runToCompletion` spawns with
 * `detached: true` on POSIX, making this child the leader of its OWN
 * process group (distinct from this test runner's own group and every
 * sibling process in it). Falls back to signaling the single pid if
 * group-signaling fails (e.g. it was never made a group leader —
 * defensive only, since every caller here does spawn detached on
 * POSIX). Mirrors the identical, already-reviewed pattern in
 * tooling/scripts/deploy.mjs's `killPid`.
 *
 * Never used for `spawnLongRunning` below, whose child is NOT spawned
 * detached: sending a negative-pid signal for a non-group-leader process
 * would target the CALLER's own process group — exactly the "unrelated
 * processes/the test runner's own process group" this must never signal
 * — so `spawnLongRunning` keeps using the single-pid `killProcessTree`
 * above unchanged.
 */
function killDetachedProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Already exited.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

function quoteArg(value: string): string {
  return /^[\w./:@-]+$/.test(value) ? value : JSON.stringify(value);
}

// Builds a single shell command line instead of passing shell:true together
// with an argv array, which avoids Node's shell-argument-escaping
// deprecation warning (DEP0190). Test commands/args here are fixed
// literals or generated port numbers, never untrusted input.
function toShellCommand(command: string, args: string[]): string {
  return [command, ...args.map(quoteArg)].join(" ");
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Bounds how long a timed-out process is given to actually terminate (and its stdio to close) before that is reported as a termination failure, rather than waited on forever. */
const KILL_GRACE_MS = 5000;

/**
 * Runs a command to completion and captures its output. Intended for
 * processes that are expected to exit on their own (a failed startup
 * validation, a worker that logs and exits) — `timeoutMs` is a safety
 * net for a command that unexpectedly hangs (e.g. a real `docker`
 * invocation), not the expected path.
 *
 * On a timeout, the ENTIRE process tree this invocation owns is
 * terminated (see `killDetachedProcessTree`), and the returned promise
 * only rejects once that termination is CONFIRMED by the child's own
 * "close" event (stdio streams closed, exit/signal known) — or, bounded
 * by `KILL_GRACE_MS`, reports that confirmation explicitly failed rather
 * than silently resolving or rejecting as if cleanup were already safe.
 * This matters specifically because a caller that tears down shared
 * infrastructure (e.g. a disposable Compose project) immediately after
 * this promise settles must never be racing a still-running startup
 * command that could keep creating resources after that teardown ran.
 */
export function runToCompletion(
  command: string,
  args: string[],
  options: SpawnOptions & { timeoutMs?: number } = {},
): Promise<SpawnResult> {
  const { timeoutMs = 30000, ...spawnOptions } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(toShellCommand(command, args), {
      ...spawnOptions,
      shell: true,
      // Detached on POSIX only: makes this child the leader of its OWN
      // process group, which killDetachedProcessTree relies on to
      // signal exactly this subtree on a timeout (see that function's
      // doc comment). A no-op distinction on Windows, where `detached`
      // means something unrelated (console allocation) and tree
      // relationships are tracked by the OS regardless — taskkill /T
      // already handles that case without this.
      ...(process.platform === "win32" ? {} : { detached: true }),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killGraceTimer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killDetachedProcessTree(child.pid);
      // Bounded wait for the "close" handler below to confirm the kill
      // actually took effect. Deliberately does NOT resolve/reject here
      // itself on the happy path — "close" (the single listener below)
      // remains the only place that ever settles this promise, so there
      // is no risk of it firing concurrently with this timer and racing
      // which outcome (resolve vs. the intended timeout rejection) wins.
      killGraceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `Process timed out after ${timeoutMs}ms and could NOT be confirmed terminated within ` +
              `${KILL_GRACE_MS}ms afterward: ${command} ${args.join(" ")}\n` +
              `stdout (captured before the kill):\n${stdout}\nstderr (captured before the kill):\n${stderr}`,
          ),
        );
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      reject(error);
    });

    // "close" (not "exit"): fires only once stdio streams have actually
    // closed, in addition to the process having exited — "exit" alone
    // can fire before buffered stdout/stderr data has been fully
    // delivered. This is also the SOLE place that ever resolves or
    // rejects this promise once spawning succeeded, so a timeout and a
    // natural exit can never race each other to produce the wrong
    // outcome.
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      if (timedOut) {
        // Reaching here means "close" fired AFTER killDetachedProcessTree
        // was invoked above — i.e. termination IS confirmed — so this is
        // the "terminated, but only because we killed it after it timed
        // out" outcome, not a termination-confirmation failure.
        reject(
          new Error(
            `Process timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}\n` +
              `stdout (captured before the kill):\n${stdout}\nstderr (captured before the kill):\n${stderr}`,
          ),
        );
        return;
      }
      resolve({ exitCode: code, signal, stdout, stderr });
    });
  });
}

export interface LongRunningProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  waitForOutput: (predicate: (combined: string) => boolean, timeoutMs?: number) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Spawns a process expected to keep running (a dev/start server) so a test
 * can assert on its output and then clean it up deterministically.
 */
export function spawnLongRunning(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): LongRunningProcess {
  const child = spawn(toShellCommand(command, args), { ...options, shell: true }) as ChildProcessWithoutNullStreams;
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  async function waitForOutput(predicate: (combined: string) => boolean, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate(stdout + stderr)) return;
      if (child.exitCode !== null) {
        throw new Error(
          `Process exited (code ${child.exitCode}) before expected output.\nstdout=${stdout}\nstderr=${stderr}`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    throw new Error(`Timed out waiting for expected output.\nstdout=${stdout}\nstderr=${stderr}`);
  }

  async function stop(): Promise<void> {
    if (child.exitCode !== null) return;
    const pid = child.pid;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        killProcessTree(pid);
        resolveStop();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveStop();
      });
      killProcessTree(pid);
    });
  }

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForOutput,
    stop,
  };
}
