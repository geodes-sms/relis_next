import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ConfigValidationError,
  loadDatabaseConfigForTarget,
  loadEnvFiles,
  resolveRuntimeMode,
  type DatabaseTarget,
} from "@relis/config";

/**
 * Migration entry point for the two prescribed database targets
 * (context/project-structure.md: packages/database/prisma/control/ and
 * .../project/). Reuses the existing `prisma` CLI (already a devDependency
 * here) instead of reimplementing migration tooling; this module's own job
 * is only to validate the target's connection string through the shared
 * @relis/config contract BEFORE ever invoking Prisma, so invalid or
 * missing configuration never reaches a database client or writes data.
 *
 * Neither prisma/control/schema.prisma nor prisma/project/schema.prisma
 * defines a model: no control-plane or project-data domain has been
 * authorized for implementation. This is a real, runnable migration
 * command for the (currently empty) schemas that exist — not a stand-in
 * for a future business schema.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");

const CONFIG_PATH_BY_TARGET: Record<DatabaseTarget, string> = {
  control: path.join(packageRoot, "prisma", "control", "prisma.config.ts"),
  project: path.join(packageRoot, "prisma", "project", "prisma.config.ts"),
};

export type RunPrisma = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

function resolvePrismaBin(): string {
  const require = createRequire(import.meta.url);
  const prismaPackageJson = require.resolve("prisma/package.json");
  return path.join(path.dirname(prismaPackageJson), "build", "index.js");
}

/**
 * Spawns the real Prisma CLI directly through Node with an argument array
 * — no shell, no PATH-based resolution, no string interpolation — mirroring
 * the same shell-free spawning pattern used by apps/web/scripts/run.mjs.
 */
export const defaultRunPrisma: RunPrisma = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolvePrismaBin(), ...args], {
      stdio: "inherit",
      env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve(signal ? 1 : (code ?? 1));
    });
  });

export interface RunMigrateOptions {
  /** Injectable for tests; defaults to actually spawning Prisma. */
  runPrisma?: RunPrisma;
}

/**
 * Validates `target`'s connection string via the shared @relis/config
 * database contract; only when it is valid does this invoke `prisma
 * migrate deploy` for that target's schema, with the validated value
 * (not merely whatever happened to already be in `env`) forwarded as the
 * target-specific env variable Prisma's config expects. Returns the exit
 * code that should be propagated by the caller — 1 on invalid/missing
 * configuration (never invoking Prisma at all), or Prisma's own exit code
 * otherwise.
 */
export async function runMigrate(
  target: DatabaseTarget,
  env: NodeJS.ProcessEnv,
  options: RunMigrateOptions = {},
): Promise<number> {
  const runPrisma = options.runPrisma ?? defaultRunPrisma;

  let config;
  try {
    config = loadDatabaseConfigForTarget(target, env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(JSON.stringify(error.toDiagnostic()));
      return 1;
    }
    throw error;
  }

  const variableName = target === "control" ? "CONTROL_DATABASE_URL" : "PROJECT_DATABASE_URL";
  const prismaEnv: NodeJS.ProcessEnv = { ...env, [variableName]: config.DATABASE_URL };

  return runPrisma(["migrate", "deploy", "--config", CONFIG_PATH_BY_TARGET[target]], prismaEnv);
}

function isDatabaseTarget(value: string | undefined): value is DatabaseTarget {
  return value === "control" || value === "project";
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!isDatabaseTarget(target)) {
    console.error("Usage: migrate <control|project>");
    process.exit(2);
  }

  loadEnvFiles(resolveRuntimeMode(process.env.NODE_ENV), packageRoot);

  const exitCode = await runMigrate(target, process.env);
  process.exit(exitCode);
}

if (isMainModule()) {
  main();
}
