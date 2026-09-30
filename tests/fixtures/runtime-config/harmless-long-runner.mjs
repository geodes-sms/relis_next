#!/usr/bin/env node
/**
 * A harmless, long-running process for supervision/lifecycle tests: prints
 * its own pid, then sleeps forever until killed. Never touches the
 * network, a real database, or any real infrastructure.
 *
 * Args:
 *   --exit-after <ms>    exit(0) on its own after the given delay, to
 *                        simulate an "unexpected exit" of a supervised
 *                        service.
 *   --ignore-sigterm     install a SIGTERM handler that does nothing, to
 *                        simulate an uncooperative process that requires
 *                        forceful escalation to actually terminate.
 */
console.log(`PID:${process.pid}`);

const args = process.argv.slice(2);

function argValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : undefined;
}

const exitAfter = argValue("--exit-after");
if (exitAfter !== undefined) {
  setTimeout(() => process.exit(0), Number(exitAfter));
}

if (args.includes("--ignore-sigterm")) {
  process.on("SIGTERM", () => {
    console.log("ignoring SIGTERM");
  });
}

setInterval(() => {}, 1000);
