"use strict";

/**
 * Preloaded via `node --require <this file>` into a REAL entry point
 * (apps/web/scripts/run.mjs, tooling/scripts/deploy.mjs,
 * packages/database/src/migrate.ts, ...) so a test can observe exactly
 * what that entry point decided to spawn — the command, its arguments,
 * working directory, and the relevant forwarded environment variables —
 * without ever launching the real target process (Next.js, Prisma, a
 * built service, ...) or opening a listener.
 *
 * Patches the shared node:child_process module BEFORE the target's own
 * `import { spawn } from "node:child_process"` executes. Node's ESM named
 * imports of core modules are live bindings onto the underlying
 * CommonJS exports object, so this CommonJS-side reassignment (done here,
 * before the target's module graph loads) is what its later call sees.
 *
 * The captured invocation is printed as one line prefixed with
 * "SPAWN_CAPTURED:" followed by JSON, then the process exits immediately
 * — nothing resembling a real child process is ever created. Only the
 * first spawn() call is captured (the process exits before a second could
 * occur); this fixture is for asserting what the FIRST attempted spawn
 * would be, not a full call log.
 */
const childProcess = require("node:child_process");

// Curated rather than the entire process.env: broad enough to cover every
// entry point that currently uses this fixture, without dumping unrelated
// noise into the captured JSON. Values here are always synthetic test
// fixtures, never real secrets.
const CAPTURED_ENV_KEYS = [
  "NODE_ENV",
  "WEB_PORT",
  "NEXT_PUBLIC_API_URL",
  "API_PORT",
  "API_HOST",
  "API_CORS_ORIGIN",
  "CONTROL_DATABASE_URL",
  "PROJECT_DATABASE_URL",
];

childProcess.spawn = function interceptedSpawn(command, args, options) {
  const env = (options && options.env) || {};
  const capturedEnv = {};
  for (const key of CAPTURED_ENV_KEYS) {
    capturedEnv[key] = env[key];
  }
  process.stdout.write(
    "SPAWN_CAPTURED:" +
      JSON.stringify({
        command,
        args,
        cwd: options && options.cwd,
        env: capturedEnv,
      }) +
      "\n",
  );
  process.exit(0);
};
