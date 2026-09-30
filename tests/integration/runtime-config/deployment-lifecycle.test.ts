import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAndSupervise } from "../../../tooling/scripts/deploy.mjs";

// Proves startAndSupervise's REAL process-tree cleanup guarantees using
// real, harmless local subprocesses (never application services, never a
// real database or deployment) — deliberately NOT relying only on mocked
// kill() calls, per the explicit requirement for this file. See
// deployment.test.ts for the separate, faster, injected-fake-child tests
// that exercise pure ordering logic.
//
// Fixtures (tests/fixtures/runtime-config/):
//  - harmless-long-runner.mjs: sleeps forever; can self-exit after a delay
//    (--exit-after) or ignore SIGTERM (--ignore-sigterm).
//  - harmless-wrapper.mjs: mimics apps/web/scripts/run.mjs's relationship
//    to its Next child — spawns a harmless-long-runner grandchild,
//    forwards SIGINT/SIGTERM to it, and waits for it (with its own bounded
//    escalation). --detach-child spawns that grandchild detached (its own
//    process group / outside any Windows job object tied to the wrapper),
//    constructing a deliberately adversarial case: killing the wrapper can
//    NEVER automatically cascade to a detached grandchild, so cleanup can
//    only happen via startAndSupervise's own explicit tree-kill logic —
//    this is this file's "uncooperative" case.

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, "..", "..", "fixtures", "runtime-config");
const wrapperPath = path.join(fixturesDir, "harmless-wrapper.mjs");
const longRunnerPath = path.join(fixturesDir, "harmless-long-runner.mjs");

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8000, intervalMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/** Captures a spawned fixture's own stdout so its printed pid(s) can be read. */
function makeCapturingSpawnFn() {
  const outputs = new Map<string, string>();
  const children: ChildProcess[] = [];

  function spawnFn(command: string, args: string[], options: Record<string, unknown>) {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    outputs.set(args.join(" "), "");
    child.stdout.on("data", (chunk: Buffer) => {
      outputs.set(args.join(" "), (outputs.get(args.join(" ")) ?? "") + chunk.toString());
    });
    return child;
  }

  function pidFrom(args: string[], label: string): number | undefined {
    const output = outputs.get(args.join(" ")) ?? "";
    const match = output.match(new RegExp(`${label}:(\\d+)`));
    return match ? Number(match[1]) : undefined;
  }

  return { spawnFn, pidFrom, children };
}

/**
 * Same as makeCapturingSpawnFn, but also opens an IPC channel to the
 * spawned process — required for a service (e.g. harmless-wrapper.mjs,
 * matching apps/web/scripts/run.mjs) to report a descendant pid via
 * `process.send`, which is how startAndSupervise's own knownDescendantPids
 * tracking is exercised with a REAL subprocess rather than an injected fake.
 */
function makeCapturingSpawnFnWithIpc() {
  const outputs = new Map<string, string>();
  const children: ChildProcess[] = [];

  function spawnFn(command: string, args: string[], options: Record<string, unknown>) {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    children.push(child);
    outputs.set(args.join(" "), "");
    // stdio's "pipe" second slot guarantees a real stdout stream; the extra
    // "ipc" 4th slot just widens the overload TypeScript infers from.
    if (!child.stdout) throw new Error("Expected spawn() to provide a piped stdout stream");
    child.stdout.on("data", (chunk: Buffer) => {
      outputs.set(args.join(" "), (outputs.get(args.join(" ")) ?? "") + chunk.toString());
    });
    return child;
  }

  function pidFrom(args: string[], label: string): number | undefined {
    const output = outputs.get(args.join(" ")) ?? "";
    const match = output.match(new RegExp(`${label}:(\\d+)`));
    return match ? Number(match[1]) : undefined;
  }

  return { spawnFn, pidFrom, children };
}

/** A real, working kill — used as the underlying implementation of a spied `killFn` so call counts reflect genuine behavior. */
function realKill(pid: number, signal?: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("exit", (code) => resolve(code === 0));
      killer.on("error", () => resolve(false));
      return;
    }
    try {
      process.kill(-pid, (signal as NodeJS.Signals) ?? "SIGKILL");
      resolve(true);
    } catch {
      try {
        process.kill(pid, (signal as NodeJS.Signals) ?? "SIGKILL");
        resolve(true);
      } catch {
        resolve(false);
      }
    }
  });
}

// Safety net: force-clean any fixture process left alive if an assertion
// throws mid-test, so a failing test never leaks a real background
// process. Uses the OS-appropriate mechanism directly (not
// startAndSupervise itself, to stay independent of the code under test).
const stragglers: number[] = [];
afterEach(async () => {
  for (const pid of stragglers.splice(0)) {
    if (!isAlive(pid)) continue;
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }
});

describe("startAndSupervise (real, harmless local subprocesses — no application services, no real database/deployment)", () => {
  it("cleans up a wrapper AND its grandchild on a cooperative requested shutdown", async () => {
    const { spawnFn, pidFrom } = makeCapturingSpawnFn();
    const wrapperArgs = [wrapperPath];

    const supervisor = startAndSupervise(
      [{ name: "wrapper", command: process.execPath, args: wrapperArgs, env: process.env, cwd: fixturesDir }],
      { spawnFn, gracePeriodMs: 3000 },
    );

    await waitUntil(() => pidFrom(wrapperArgs, "CHILD_PID") !== undefined);
    const wrapperPid = pidFrom(wrapperArgs, "WRAPPER_PID");
    const grandchildPid = pidFrom(wrapperArgs, "CHILD_PID");
    stragglers.push(wrapperPid!, grandchildPid!);

    expect(isAlive(wrapperPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    const exitCode = await supervisor.requestShutdown("SIGTERM");

    expect(exitCode).toBe(0);
    expect(isAlive(wrapperPid)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
  }, 15000);

  it("cleans up an UNCOOPERATIVE wrapper's grandchild on requested shutdown (detached — escapes any automatic tree cascade)", async () => {
    const { spawnFn, pidFrom } = makeCapturingSpawnFn();
    const wrapperArgs = [wrapperPath, "--detach-child"];

    const supervisor = startAndSupervise(
      [{ name: "wrapper", command: process.execPath, args: wrapperArgs, env: process.env, cwd: fixturesDir }],
      { spawnFn, gracePeriodMs: 3000 },
    );

    await waitUntil(() => pidFrom(wrapperArgs, "CHILD_PID") !== undefined);
    const wrapperPid = pidFrom(wrapperArgs, "WRAPPER_PID");
    const grandchildPid = pidFrom(wrapperArgs, "CHILD_PID");
    stragglers.push(wrapperPid!, grandchildPid!);

    expect(isAlive(wrapperPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    const exitCode = await supervisor.requestShutdown("SIGTERM");

    expect(exitCode).toBe(0);
    // The whole point of the detached grandchild: it CANNOT be cleaned up
    // by the wrapper dying alone (no automatic cascade is possible). If
    // this passes, startAndSupervise's own explicit tree-kill logic (not
    // an incidental platform side effect) is what did it.
    expect(isAlive(wrapperPid)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
  }, 15000);

  it("tears down a sibling wrapper (and its grandchild) when another service exits unexpectedly", async () => {
    const { spawnFn, pidFrom } = makeCapturingSpawnFn();
    const wrapperArgs = [wrapperPath];
    const selfExitingArgs = [longRunnerPath, "--exit-after", "600"];

    const supervisor = startAndSupervise(
      [
        { name: "wrapper", command: process.execPath, args: wrapperArgs, env: process.env, cwd: fixturesDir },
        { name: "self-exiting", command: process.execPath, args: selfExitingArgs, env: process.env, cwd: fixturesDir },
      ],
      { spawnFn, gracePeriodMs: 3000 },
    );

    await waitUntil(() => pidFrom(wrapperArgs, "CHILD_PID") !== undefined);
    const wrapperPid = pidFrom(wrapperArgs, "WRAPPER_PID");
    const grandchildPid = pidFrom(wrapperArgs, "CHILD_PID");
    stragglers.push(wrapperPid!, grandchildPid!);

    expect(isAlive(wrapperPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);

    // "self-exiting" exits on its own after 600ms — an unexpected exit
    // that must tear down the wrapper sibling and everything IT owns too.
    const exitCode = await supervisor.exitPromise;

    expect(exitCode).not.toBe(0);
    expect(isAlive(wrapperPid)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
  }, 15000);

  it("tears down a sibling wrapper (and its grandchild) when another service fails to spawn", async () => {
    const { spawnFn, pidFrom } = makeCapturingSpawnFn();
    const wrapperArgs = [wrapperPath];

    const supervisor = startAndSupervise(
      [
        { name: "wrapper", command: process.execPath, args: wrapperArgs, env: process.env, cwd: fixturesDir },
        { name: "bad", command: "this-command-does-not-exist-12345", args: [], env: process.env, cwd: fixturesDir },
      ],
      { spawnFn, gracePeriodMs: 3000 },
    );

    await waitUntil(() => pidFrom(wrapperArgs, "CHILD_PID") !== undefined);
    const wrapperPid = pidFrom(wrapperArgs, "WRAPPER_PID");
    const grandchildPid = pidFrom(wrapperArgs, "CHILD_PID");
    stragglers.push(wrapperPid!, grandchildPid!);

    const exitCode = await supervisor.exitPromise;

    expect(exitCode).not.toBe(0);
    expect(isAlive(wrapperPid)).toBe(false);
    expect(isAlive(grandchildPid)).toBe(false);
  }, 15000);

  it("never touches an unrelated process: a plain uninvolved long-runner survives a supervised shutdown", async () => {
    // Spawned entirely OUTSIDE startAndSupervise, to prove termination is
    // scoped strictly to the pids this function itself spawned.
    const bystander = spawn(process.execPath, [longRunnerPath], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(bystander.pid)).toBe(true);

    const { spawnFn, pidFrom } = makeCapturingSpawnFn();
    const wrapperArgs = [wrapperPath];
    const supervisor = startAndSupervise(
      [{ name: "wrapper", command: process.execPath, args: wrapperArgs, env: process.env, cwd: fixturesDir }],
      { spawnFn, gracePeriodMs: 3000 },
    );
    await waitUntil(() => pidFrom(wrapperArgs, "CHILD_PID") !== undefined);
    stragglers.push(pidFrom(wrapperArgs, "WRAPPER_PID")!, pidFrom(wrapperArgs, "CHILD_PID")!);

    await supervisor.requestShutdown("SIGTERM");

    expect(isAlive(bystander.pid)).toBe(true);

    bystander.kill("SIGKILL");
    await waitUntil(() => !isAlive(bystander.pid));
  }, 15000);

  // Item 2: a wrapper that exits UNEXPECTEDLY on its own (not via a
  // requested/forwarded shutdown) must not leave its own still-alive child
  // behind, and must still tear down its sibling service too — proving
  // service-tree ownership (via the descendant-pid IPC report) is tracked
  // independently of whether the OWNING process itself is still alive by
  // the time cleanup runs.
  it("cleans up a wrapper's descendant AND a sibling service when the wrapper itself exits unexpectedly (child left alive)", async () => {
    const { spawnFn, pidFrom, children } = makeCapturingSpawnFnWithIpc();
    // --detach-child: on Windows, a NON-detached grandchild is automatically
    // torn down by the OS's own job-object cascade the instant its parent
    // (the wrapper) exits — proving nothing about OUR cleanup logic. Detaching
    // it (exactly like the existing "uncooperative" test above) is what makes
    // this genuinely adversarial: only the descendant-pid IPC report + this
    // supervisor's own explicit kill can reach it once the wrapper is gone.
    const wrapperArgs = [wrapperPath, "--detach-child", "--self-exit-after", "400"];
    const siblingArgs = [longRunnerPath];

    const bystander = spawn(process.execPath, [longRunnerPath], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(bystander.pid)).toBe(true);
    stragglers.push(bystander.pid!);

    const supervisor = startAndSupervise(
      [
        { name: "wrapper", command: process.execPath, args: wrapperArgs, env: process.env, cwd: fixturesDir },
        { name: "sibling", command: process.execPath, args: siblingArgs, env: process.env, cwd: fixturesDir },
      ],
      { spawnFn, gracePeriodMs: 3000 },
    );

    await waitUntil(() => pidFrom(wrapperArgs, "CHILD_PID") !== undefined);
    const wrapperPid = pidFrom(wrapperArgs, "WRAPPER_PID");
    const grandchildPid = pidFrom(wrapperArgs, "CHILD_PID");
    const siblingPid = children[1]?.pid;
    stragglers.push(wrapperPid!, grandchildPid!, siblingPid!);

    expect(isAlive(wrapperPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);
    expect(isAlive(siblingPid)).toBe(true);

    // Give the "descendant-pid" IPC message time to actually reach the
    // supervisor before the wrapper self-exits at 400ms — this report is
    // the ONLY reason the grandchild is reachable once its parent is gone.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const exitCode = await supervisor.exitPromise;

    expect(exitCode).not.toBe(0); // the wrapper's own exit(1) is an unexpected failure
    expect(isAlive(wrapperPid)).toBe(false); // exited on its own
    expect(isAlive(grandchildPid)).toBe(false); // reached via the reported descendant pid, not via the dead parent
    expect(isAlive(siblingPid)).toBe(false); // torn down as a sibling of the failed service
  }, 15000);

  // Item 3: completion must depend on CONFIRMED cleanup, not merely on a
  // direct child's own "exit" event, and must never hang even when
  // confirmation is delayed or ultimately impossible.
  describe("awaited cleanup and termination-failure handling", () => {
    it("confirms descendant cleanup only after a transient termination failure, retrying before giving up", async () => {
      const { spawnFn, pidFrom } = makeCapturingSpawnFnWithIpc();
      // Detached so the OS cannot clean it up on its own when the wrapper
      // exits — the retry loop over the reported descendant pid must be
      // what actually confirms this one gone.
      const wrapperArgs = [wrapperPath, "--detach-child", "--self-exit-after", "200"];

      let calls = 0;
      const killFn = vi.fn(async (pid: number, signal?: string) => {
        calls += 1;
        if (calls === 1) return false; // simulate one failed termination command
        return realKill(pid, signal);
      });

      const supervisor = startAndSupervise(
        [{ name: "wrapper", command: process.execPath, args: wrapperArgs, env: process.env, cwd: fixturesDir }],
        { spawnFn, killFn, gracePeriodMs: 800 },
      );

      await waitUntil(() => pidFrom(wrapperArgs, "CHILD_PID") !== undefined);
      const grandchildPid = pidFrom(wrapperArgs, "CHILD_PID");
      stragglers.push(pidFrom(wrapperArgs, "WRAPPER_PID")!, grandchildPid!);

      await supervisor.exitPromise;

      // Confirmed via REAL liveness polling (not the fake killFn's own
      // claim) — the retry inside ensurePidGone is what made this succeed
      // despite the first attempt reporting failure.
      expect(isAlive(grandchildPid)).toBe(false);
      expect(calls).toBeGreaterThanOrEqual(2);
    }, 15000);

    it("resolves nonzero without hanging when termination can never be confirmed, and never claims success", async () => {
      const { spawnFn, pidFrom } = makeCapturingSpawnFnWithIpc();
      // Detached: only the injected (lying) killFn could reach it — proving
      // the failure is genuinely unconfirmed rather than masked by an
      // incidental OS-level cascade.
      const wrapperArgs = [wrapperPath, "--detach-child", "--self-exit-after", "200"];

      // Always reports success while never actually touching the real
      // process — exactly the case "never report successful cleanup when
      // it has not been confirmed" guards against.
      const killFn = vi.fn(async () => true);

      const start = Date.now();
      const supervisor = startAndSupervise(
        [{ name: "wrapper", command: process.execPath, args: wrapperArgs, env: process.env, cwd: fixturesDir }],
        { spawnFn, killFn, gracePeriodMs: 300 },
      );

      await waitUntil(() => pidFrom(wrapperArgs, "CHILD_PID") !== undefined);
      const grandchildPid = pidFrom(wrapperArgs, "CHILD_PID");
      stragglers.push(pidFrom(wrapperArgs, "WRAPPER_PID")!, grandchildPid!);

      const exitCode = await supervisor.exitPromise;
      const elapsedMs = Date.now() - start;

      // Bounded: MAX_DESCENDANT_KILL_ATTEMPTS (2) * gracePeriodMs (300ms)
      // plus fixed overhead — proves exitPromise never hangs indefinitely
      // even though cleanup could never be confirmed.
      expect(elapsedMs).toBeLessThan(10000);
      expect(exitCode).not.toBe(0);
      // The fake killFn lied — the real descendant is genuinely still
      // alive, and this suite's own afterEach (not startAndSupervise) is
      // what actually reaps it below.
      expect(isAlive(grandchildPid)).toBe(true);
    }, 15000);

    it("is idempotent under repeated shutdown requests: cleanup runs exactly once and both calls resolve identically", async () => {
      const { spawnFn, pidFrom } = makeCapturingSpawnFn();
      const wrapperArgs = [wrapperPath];
      const killFn = vi.fn(realKill);

      const supervisor = startAndSupervise(
        [{ name: "wrapper", command: process.execPath, args: wrapperArgs, env: process.env, cwd: fixturesDir }],
        { spawnFn, killFn, gracePeriodMs: 3000 },
      );

      await waitUntil(() => pidFrom(wrapperArgs, "CHILD_PID") !== undefined);
      const wrapperPid = pidFrom(wrapperArgs, "WRAPPER_PID");
      const grandchildPid = pidFrom(wrapperArgs, "CHILD_PID");
      stragglers.push(wrapperPid!, grandchildPid!);

      const [exitCodeA, exitCodeB] = await Promise.all([
        supervisor.requestShutdown("SIGTERM"),
        supervisor.requestShutdown("SIGTERM"),
      ]);

      expect(exitCodeA).toBe(0);
      expect(exitCodeB).toBe(exitCodeA);
      expect(isAlive(wrapperPid)).toBe(false);
      expect(isAlive(grandchildPid)).toBe(false);
      // The second requestShutdown call must not start a second, redundant
      // termination pass over the same entry.
      expect(killFn.mock.calls.filter((call) => call[0] === wrapperPid).length).toBe(1);
    }, 15000);
  });
});
