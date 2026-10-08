import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runToCompletion } from "@relis/test-utils";

// Regression coverage for packages/test-utils/src/process.ts's
// runToCompletion. The reported defect: on Linux/macOS, a timeout killed
// only the wrapping shell's own pid (spawn(..., {shell:true})'s
// child.pid — not necessarily the real program's, since whether the
// shell exec-replaces itself or forks a separate child is
// shell-implementation-dependent) and rejected IMMEDIATELY, without
// confirming any descendant had actually terminated. That left real
// descendants (anything forked rather than merely exec-replaced)
// running, and raced a caller (e.g. Compose cleanup in an afterAll) that
// assumes "the promise settled" already means it is safe to tear down
// shared resources.
//
// Uses only real, harmless local processes — no Docker, no network, no
// real infrastructure. Reuses the EXISTING
// tests/fixtures/runtime-config/harmless-wrapper.mjs (which itself
// spawns a harmless grandchild,
// tests/fixtures/runtime-config/harmless-long-runner.mjs) to exercise a
// genuine multi-level, non-detached process tree, plus a small dedicated
// fixture (tests/fixtures/test-utils/exit-with-output.mjs) for the
// normal-completion / output-preservation case.
//
// IMPORTANT — platform coverage: this file reports the OS it actually
// ran on (see the describe title and the final report for this
// sub-issue) rather than claiming cross-platform verification from a
// single host. The POSIX-specific branch of the fix
// (killDetachedProcessTree's `detached: true` + negative-pid
// process-group signaling) is only reached when
// `process.platform !== "win32"`; running this suite on Windows
// exercises the platform-agnostic "confirm termination before
// rejecting" logic and the (unchanged) Windows taskkill-based tree-kill,
// but NOT that POSIX branch.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const harmlessWrapperPath = path.join(repoRoot, "tests", "fixtures", "runtime-config", "harmless-wrapper.mjs");
const exitWithOutputPath = path.join(repoRoot, "tests", "fixtures", "test-utils", "exit-with-output.mjs");

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls (rather than asserting instantaneously) since an orphaned grandchild's own reaping can lag the direct child's by a beat even after both received the same kill. */
async function waitUntilPidGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return !isPidAlive(pid);
}

function extractPid(output: string, label: "WRAPPER_PID" | "CHILD_PID" | "PID"): number {
  const match = new RegExp(`${label}:(\\d+)`).exec(output);
  if (!match) {
    throw new Error(`Could not find ${label}:<pid> in captured output:\n${output}`);
  }
  return Number(match[1]);
}

// Belt-and-suspenders cleanup: force-kill any pid a test captured, even
// if an assertion throws before (or regardless of whether)
// runToCompletion's own confirmed-kill logic already handled it. Scoped
// to EXACTLY the pids captured by THIS file's own tests — never a
// broad/name-based lookup, and never anything belonging to the test
// runner itself.
let pidsToForceCleanup: number[] = [];

afterEach(() => {
  for (const pid of pidsToForceCleanup) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone — the expected outcome when the fix under test
      // worked correctly.
    }
  }
  pidsToForceCleanup = [];
});

describe(`runToCompletion termination (exercised on process.platform=${process.platform})`, () => {
  it("on timeout, confirms termination of the ENTIRE process tree — including a non-detached grandchild — not just the top-level shell pid", async () => {
    const promise = runToCompletion("node", [harmlessWrapperPath], { timeoutMs: 1500 });

    await expect(promise).rejects.toThrow(/Process timed out after 1500ms/);
    // Already proven to reject above; this just recovers that same
    // rejection's message (promises are idempotent — awaiting an
    // already-settled one again is safe and does not re-run anything).
    const errorMessage = (await promise.catch((error: Error) => error.message)) as string;

    const wrapperPid = extractPid(errorMessage, "WRAPPER_PID");
    const grandchildPid = extractPid(errorMessage, "CHILD_PID");
    pidsToForceCleanup.push(wrapperPid, grandchildPid);

    // By the time the promise rejected, termination was ALREADY
    // confirmed (runToCompletion waits for the child's own "close" event
    // before rejecting) — the direct child must already be gone with no
    // further waiting needed.
    expect(isPidAlive(wrapperPid)).toBe(false);

    // The grandchild is reparented once the wrapper dies; its own
    // reaping can lag by a beat even though it received the same kill —
    // poll briefly rather than asserting instantaneously. This is the
    // actual regression check: before this fix, only the shell/wrapper
    // was targeted, and this grandchild would still be alive here.
    expect(await waitUntilPidGone(grandchildPid)).toBe(true);
  }, 15000);

  it("rejects only AFTER confirming termination for a simple (non-nested) long-running process — proving the ordering, not merely that it eventually rejects", async () => {
    const promise = runToCompletion("node", [exitWithOutputPath, "--delay-ms", "30000"], { timeoutMs: 1000 });

    await expect(promise).rejects.toThrow(/Process timed out after 1000ms/);
    const errorMessage = (await promise.catch((error: Error) => error.message)) as string;

    const pid = extractPid(errorMessage, "PID");
    pidsToForceCleanup.push(pid);

    // No polling here deliberately: this IS the ordering assertion —
    // the promise does not settle until "close" has already fired, so
    // the process must be confirmed dead at the moment we observe this,
    // with no grace period needed (unlike the nested-grandchild case
    // above).
    expect(isPidAlive(pid)).toBe(false);
  }, 15000);

  it("resolves normally (does not time out) for a short-lived process, preserving stdout, stderr, and a non-zero exit code", async () => {
    const result = await runToCompletion(
      "node",
      [exitWithOutputPath, "--delay-ms", "200", "--stdout", "hello-stdout", "--stderr", "hello-stderr", "--exit-code", "7"],
      { timeoutMs: 10000 },
    );

    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    // stdout also carries the fixture's own "PID:<n>" startup line
    // first; stderr carries only what was asked for.
    expect(result.stdout).toContain("hello-stdout");
    expect(result.stderr).toBe("hello-stderr");
  }, 15000);
});
