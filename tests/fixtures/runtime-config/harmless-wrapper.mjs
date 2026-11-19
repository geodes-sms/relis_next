#!/usr/bin/env node
/**
 * Mimics apps/web/scripts/run.mjs's relationship to its `next` child, for
 * lifecycle tests that must not launch a real application service:
 * spawns a harmless grandchild (harmless-long-runner.mjs), forwards
 * SIGINT/SIGTERM to it, and waits for it to actually exit before exiting
 * itself — escalating to SIGKILL if the grandchild does not cooperate
 * within a bounded grace period.
 *
 * Prints its own pid and the grandchild's pid so a test can verify BOTH
 * are gone after the wrapper is supervised/terminated.
 *
 * --detach-child spawns the grandchild detached (its own process group /
 * outside any Windows job object tied to this wrapper), so killing this
 * wrapper directly can NEVER automatically cascade to the grandchild —
 * used by tests that must prove the supervisor's own explicit tree-kill
 * mechanism cleans it up, rather than incidentally relying on platform
 * default process-group/job-object behavior.
 *
 * --self-exit-after <ms> simulates the wrapper itself crashing UNEXPECTEDLY
 * once its child is running: it exits directly (no shutdown forwarded to
 * the child at all) after the given delay, deliberately leaving the child
 * alive — the exact scenario a supervisor relying only on "the direct
 * child's own exit event" fails to clean up. Paired with the descendant-pid
 * IPC report below, a real supervisor (tooling/scripts/deploy.mjs) can
 * still clean the child up despite never seeing this wrapper forward
 * anything to it.
 *
 * When spawned with an IPC channel (i.e. `process.send` exists), reports
 * the grandchild's pid the same way apps/web/scripts/run.mjs does, so a
 * supervisor can track it independently of this wrapper's own liveness.
 *
 * Other extra CLI args (e.g. --ignore-sigterm, --exit-after) are forwarded
 * to the grandchild.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const allArgs = process.argv.slice(2);
const detachChild = allArgs.includes("--detach-child");
const selfExitFlagIndex = allArgs.indexOf("--self-exit-after");
const selfExitAfterMs = selfExitFlagIndex === -1 ? undefined : Number(allArgs[selfExitFlagIndex + 1]);
const extraArgs = allArgs.filter((arg, index) => {
  if (arg === "--detach-child") return false;
  if (index === selfExitFlagIndex || index === selfExitFlagIndex + 1) return false;
  return true;
});

console.log(`WRAPPER_PID:${process.pid}`);

const child = spawn(process.execPath, [path.join(here, "harmless-long-runner.mjs"), ...extraArgs], {
  stdio: "inherit",
  detached: detachChild,
});

console.log(`CHILD_PID:${child.pid}`);

if (typeof process.send === "function") {
  process.send({ type: "descendant-pid", pid: child.pid });
}

if (selfExitAfterMs !== undefined) {
  setTimeout(() => {
    // Deliberately abrupt: no signal forwarded to `child` at all, leaving
    // it alive — simulates this wrapper crashing unexpectedly.
    process.exit(1);
  }, selfExitAfterMs);
}

const SHUTDOWN_GRACE_MS = 2000;
let shuttingDown = false;
let escalationTimer;

function forwardShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  escalationTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, SHUTDOWN_GRACE_MS);
}

process.on("SIGINT", () => forwardShutdown("SIGINT"));
process.on("SIGTERM", () => forwardShutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  clearTimeout(escalationTimer);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", () => {
  clearTimeout(escalationTimer);
  process.exit(1);
});
