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

/**
 * Runs a command to completion and captures its output. Intended for
 * processes that are expected to exit on their own (a failed startup
 * validation, a worker that logs and exits).
 */
export function runToCompletion(
  command: string,
  args: string[],
  options: SpawnOptions & { timeoutMs?: number } = {},
): Promise<SpawnResult> {
  const { timeoutMs = 30000, ...spawnOptions } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(toShellCommand(command, args), { ...spawnOptions, shell: true });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error(`Process timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
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
