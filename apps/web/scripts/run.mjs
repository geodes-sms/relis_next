#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  ConfigValidationError,
  loadEnvFiles,
  loadWebRuntimeConfig,
  validateConsistentRuntimeMode,
  validateRuntimeMode,
} from "@relis/config";
import { parsePublicWebConfig } from "@relis/config/public";

/**
 * Validates web configuration before Next.js ever opens a listener or
 * starts a build, instead of relying on a lifecycle hook that can run
 * after Next has already started listening.
 *
 * Usage: node scripts/run.mjs <dev|build|start> [extra next args...]
 */

const [, , command, ...rest] = process.argv;
const VALID_COMMANDS = new Set(["dev", "build", "start"]);

if (!VALID_COMMANDS.has(command)) {
  console.error("Usage: node scripts/run.mjs <dev|build|start> [next args...]");
  process.exit(2);
}

function fail(error) {
  if (error instanceof ConfigValidationError) {
    console.error(JSON.stringify(error.toDiagnostic()));
    process.exit(1);
  }
  throw error;
}

// "dev" defaults to development; "build" and "start" are both production
// artifacts/servers and default to production. An explicit NODE_ENV always
// wins over that default, but an explicit, invalid, or empty value is
// rejected here rather than silently coerced and forwarded to the spawned
// Next.js process unexamined. This first validation determines which
// .env.<mode> tier to load and uses only the real OS environment (nothing
// has been loaded yet).
const defaultMode = command === "dev" ? "development" : "production";
let mode;
try {
  mode = validateRuntimeMode(process.env.NODE_ENV, defaultMode);
} catch (error) {
  fail(error);
}
loadEnvFiles(mode);

// A .env file can itself define NODE_ENV (it is not special-cased and
// follows the same precedence as any other variable), which loadEnvFiles
// may just have written into process.env. Re-validate the EFFECTIVE value
// before it is forwarded to the spawned Next.js process: an invalid/empty
// value introduced by a file is rejected, and so is a well-formed but
// DIFFERENT mode than the one already used to select which .env.<mode>
// tier to load — e.g. `start` loads production-tier files, then a file
// sets NODE_ENV=development; accepting that would forward "development"
// to Next despite production files being the ones actually loaded. The
// mode used for tier selection and the mode forwarded to Next must be
// identical; we never silently switch modes after loading files.
let effectiveMode;
try {
  effectiveMode = validateConsistentRuntimeMode(process.env.NODE_ENV, mode);
} catch (error) {
  fail(error);
}
// Assign explicitly so the exact validated string is what Next receives,
// whether it came from the OS, a file, or the per-command default.
process.env.NODE_ENV = effectiveMode;

// A single unique sentinel value marks a `-p`/`--port` flag whose value is
// missing or looks like another flag (e.g. a trailing `--port`, or
// `--port --webpack`) — this must be rejected, not silently ignored by
// treating the next flag's name as the port value.
const MISSING_PORT_VALUE = Symbol("missing-port-value");

// A CLI `-p`/`--port`/`--port=N` override takes precedence over WEB_PORT,
// matching Next's own flag. Extracting it here (instead of forwarding both
// our own `-p` and the caller's) prevents ever handing Next two
// conflicting port arguments. Repeated flags: the last one wins.
function extractPortOverride(args) {
  let override;
  const remaining = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--port") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        override = MISSING_PORT_VALUE;
        continue; // `next`, if any, is another flag — do not consume it as a value
      }
      override = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      override = arg.slice("--port=".length);
      continue;
    }
    remaining.push(arg);
  }
  return { override, remaining };
}

const { override: cliPortOverride, remaining: passthroughArgs } = extractPortOverride(rest);

let webPort;

try {
  // `build` only produces the static/public bundle: it needs the
  // build-time public config, not a runtime listener port.
  if (command !== "build") {
    if (cliPortOverride === MISSING_PORT_VALUE) {
      throw new ConfigValidationError("web", [{ variable: "WEB_PORT", category: "network" }]);
    }
    // The CLI override, when present, replaces WEB_PORT entirely — an
    // invalid override is rejected even if WEB_PORT itself is valid, and a
    // valid override is used even if WEB_PORT itself is invalid.
    const resolvedPort = cliPortOverride !== undefined ? cliPortOverride : process.env.WEB_PORT;
    webPort = loadWebRuntimeConfig({ WEB_PORT: resolvedPort }).WEB_PORT;
  }
  // Validated here so a bad value never reaches `next build`/`next dev`
  // output, even though only the client bundle actually consumes it.
  parsePublicWebConfig({ NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL });
} catch (error) {
  fail(error);
}

const finalArgs = [command, ...passthroughArgs];
if (webPort !== undefined) {
  finalArgs.push("-p", String(webPort));
}

// Resolve Next's own entry script and invoke it directly through Node with
// an argument array — no shell, no PATH-based ".cmd"/".ps1" resolution, and
// no string interpolation of arguments (avoids both injection risk and
// Node's shell-argument-escaping deprecation warning).
const require = createRequire(import.meta.url);
const nextBinPath = require.resolve("next/dist/bin/next");

const child = spawn(process.execPath, [nextBinPath, ...finalArgs], {
  stdio: "inherit",
  env: process.env,
});

// When a parent supervisor (tooling/scripts/deploy.mjs's startAndSupervise)
// spawned this wrapper with an IPC channel, report the Next child's pid so
// the supervisor can still clean it up directly even if this wrapper itself
// exits unexpectedly before it can forward a shutdown signal. A no-op (and
// harmless) when run standalone, e.g. via `pnpm start`, where no IPC
// channel exists and `process.send` is undefined.
if (typeof process.send === "function" && child.pid !== undefined) {
  process.send({ type: "descendant-pid", pid: child.pid });
}

// Forward a shutdown signal to the Next child and WAIT for it to actually
// exit before this wrapper exits — killing this wrapper alone must never
// leave Next running as an orphan. Bounded with an escalation to SIGKILL
// if Next does not exit within the grace period (an uncooperative or
// stuck child must not hang the wrapper, or whatever is supervising it,
// forever).
const SHUTDOWN_GRACE_MS = 5000;
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

child.on("error", (error) => {
  clearTimeout(escalationTimer);
  console.error(`Failed to start Next.js: ${error.message}`);
  process.exit(1);
});
