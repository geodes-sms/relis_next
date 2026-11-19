#!/usr/bin/env node
import path from "node:path";
import { loadApiConfig } from "./api.js";
import { loadDatabaseConfig, loadDatabaseConfigForTarget, type DatabaseTarget } from "./database.js";
import { ConfigValidationError } from "./errors.js";
import { findWorkspaceRoot, loadEnvFiles, resolveEffectiveEnv, resolveRuntimeMode } from "./env-loader.js";
import { parsePublicWebConfig } from "./public.js";
import { checkPortConflicts, PortConflictError } from "./ports.js";
import { loadWebRuntimeConfig } from "./web.js";
import { loadWorkerConfig } from "./worker.js";

/**
 * Standalone configuration checker. Useful for a future migration or
 * deployment command to validate its environment, but nothing in this
 * repository invokes it automatically today — it is not itself proof that
 * a real migration/deployment integration exists.
 *
 * Usage:
 *   relis-config check <api|worker|web|database> [--mode <development|test|production>]
 *   relis-config check-ports [--mode <development|test|production>]
 */

type Target = "api" | "worker" | "web" | "database";
const VALID_TARGETS: readonly Target[] = ["api", "worker", "web", "database"];

function printUsage(): void {
  console.error(
    "Usage: relis-config check <api|worker|web|database> [--mode <development|test|production>] [--target <control|project>]",
  );
  console.error("       relis-config check-ports [--mode <development|test|production>]");
}

function isTarget(value: string | undefined): value is Target {
  return value !== undefined && (VALID_TARGETS as readonly string[]).includes(value);
}

function extractFlagValue(rest: string[], flag: string): string | undefined {
  const flagIndex = rest.indexOf(flag);
  if (flagIndex !== -1 && rest[flagIndex + 1]) {
    return rest[flagIndex + 1];
  }
  return undefined;
}

function extractMode(rest: string[]): string | undefined {
  return extractFlagValue(rest, "--mode");
}

function isDatabaseTarget(value: string | undefined): value is DatabaseTarget {
  return value === "control" || value === "project";
}

function runCheck(target: Target, rest: string[]): void {
  switch (target) {
    case "api":
      loadApiConfig(process.env);
      return;
    case "worker":
      loadWorkerConfig(process.env);
      return;
    case "web":
      loadWebRuntimeConfig(process.env);
      parsePublicWebConfig({ NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL });
      return;
    case "database": {
      const databaseTarget = extractFlagValue(rest, "--target");
      if (databaseTarget === undefined) {
        // Preserves the original, generic single-DATABASE_URL check.
        loadDatabaseConfig(process.env);
        return;
      }
      if (!isDatabaseTarget(databaseTarget)) {
        printUsage();
        process.exit(2);
      }
      loadDatabaseConfigForTarget(databaseTarget, process.env);
      return;
    }
  }
}

function reportFailure(error: unknown): never {
  if (error instanceof PortConflictError || error instanceof ConfigValidationError) {
    console.error(JSON.stringify(error.toDiagnostic()));
    process.exit(1);
  }
  throw error;
}

function runCheckCommand(argv: string[]): void {
  const [target, ...rest] = argv;
  if (!isTarget(target)) {
    printUsage();
    process.exit(2);
  }

  const mode = resolveRuntimeMode(extractMode(rest) ?? process.env.NODE_ENV);
  loadEnvFiles(mode);

  try {
    runCheck(target, rest);
  } catch (error) {
    reportFailure(error);
  }

  console.log(JSON.stringify({ code: "CONFIG_OK", process: target }));
}

function runCheckPortsCommand(argv: string[]): void {
  const mode = resolveRuntimeMode(extractMode(argv) ?? process.env.NODE_ENV);
  const workspaceRoot = findWorkspaceRoot(process.cwd());

  // Each application's effective environment is resolved independently
  // from the SAME real process.env snapshot (root/package/file precedence
  // still applies within each resolution). Neither call mutates
  // process.env or feeds its result into the other, so apps/api's
  // resolution can never shadow an apps/web-specific override (or vice
  // versa) — this is exactly what each app's own startup path
  // (loadEnvFiles) would independently see for itself.
  const apiEnv = resolveEffectiveEnv(mode, path.join(workspaceRoot, "apps", "api"), process.env);
  const webEnv = resolveEffectiveEnv(mode, path.join(workspaceRoot, "apps", "web"), process.env);

  try {
    checkPortConflicts(apiEnv, webEnv);
  } catch (error) {
    reportFailure(error);
  }

  console.log(JSON.stringify({ code: "CONFIG_OK", process: "dev (api+web)" }));
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "check-ports") {
    runCheckPortsCommand(rest);
    return;
  }

  if (command === "check") {
    runCheckCommand(rest);
    return;
  }

  printUsage();
  process.exit(2);
}

main();
