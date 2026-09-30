import { z } from "zod";
import { ConfigValidationError } from "./errors.js";
import { parseConfig, type ConfigCategory } from "./parse.js";

const ALLOWED_PROTOCOLS = ["postgres:", "postgresql:"] as const;

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (ALLOWED_PROTOCOLS as readonly string[]).includes(url.protocol) && url.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Generic single-connection-string contract, shared by both database
 * targets below rather than duplicated per target. Exercised directly via
 * `relis-config check database` (see cli.ts) and by
 * relis/tests/integration/runtime-config/.
 */
export const databaseConfigSchema = z.object({
  DATABASE_URL: z.string().min(1).refine(isPostgresUrl, "invalid_database_url"),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

export interface RawDatabaseEnv {
  DATABASE_URL?: string;
}

export function loadDatabaseConfig(raw: RawDatabaseEnv): DatabaseConfig {
  return parseConfig("database", databaseConfigSchema, raw, () => "database");
}

export const DATABASE_CONFIG_CATEGORIES: readonly ConfigCategory[] = ["database"];

/**
 * The two prescribed database targets (context/project-structure.md:
 * packages/database/prisma/control/ and .../project/). Each is an
 * independent PostgreSQL database with its own connection string; neither
 * schema currently defines any model (no control-plane or project-data
 * domain has been authorized for implementation).
 */
export type DatabaseTarget = "control" | "project";

export const DATABASE_URL_VARIABLE_BY_TARGET: Record<DatabaseTarget, string> = {
  control: "CONTROL_DATABASE_URL",
  project: "PROJECT_DATABASE_URL",
};

/**
 * Validates a specific target's connection string using the SAME schema
 * as `loadDatabaseConfig` (not a duplicated rule) — only the env variable
 * name consulted, and the process/variable names used in a rejection
 * diagnostic, differ per target. Used by packages/database's migration
 * entry point; not invoked by any process that does not consume that
 * target's database.
 */
export function loadDatabaseConfigForTarget(target: DatabaseTarget, env: NodeJS.ProcessEnv): DatabaseConfig {
  const variableName = DATABASE_URL_VARIABLE_BY_TARGET[target];
  try {
    return loadDatabaseConfig({ DATABASE_URL: env[variableName] });
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw new ConfigValidationError(`database (${target})`, [{ variable: variableName, category: "database" }]);
    }
    throw error;
  }
}
