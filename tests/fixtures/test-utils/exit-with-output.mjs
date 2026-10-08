#!/usr/bin/env node
/**
 * A harmless, short-lived process with deterministic, known output and
 * exit code — for regression tests of runToCompletion's NORMAL
 * (non-timeout) completion path: exact stdout/stderr capture and exit
 * code propagation. Never touches the network, a real database, or any
 * real infrastructure.
 *
 * Prints its own pid first (matching
 * tests/fixtures/runtime-config/harmless-long-runner.mjs's existing
 * `PID:<pid>` convention), so a test can independently confirm it has
 * actually terminated afterward.
 *
 * Args:
 *   --stdout <text>     write <text> to stdout after the delay below (default: none)
 *   --stderr <text>     write <text> to stderr after the delay below (default: none)
 *   --exit-code <n>     exit with code n (default: 0)
 *   --delay-ms <n>      wait n ms before writing output and exiting
 *                       (default: 0) — simulates a brief, bounded
 *                       runtime well within a test's timeout budget.
 */
console.log(`PID:${process.pid}`);

const args = process.argv.slice(2);

function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : fallback;
}

const stdoutText = argValue("--stdout", "");
const stderrText = argValue("--stderr", "");
const exitCode = Number(argValue("--exit-code", "0"));
const delayMs = Number(argValue("--delay-ms", "0"));

function finish() {
  if (stdoutText) process.stdout.write(stdoutText);
  if (stderrText) process.stderr.write(stderrText);
  process.exit(exitCode);
}

if (delayMs > 0) {
  setTimeout(finish, delayMs);
} else {
  finish();
}
