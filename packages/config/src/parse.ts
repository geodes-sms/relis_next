import type { ZodType } from "zod";
import { ConfigValidationError, type ConfigCategory, type ConfigFieldIssue } from "./errors.js";

export type { ConfigCategory } from "./errors.js";

/**
 * Parses raw input against a schema. On failure, throws a
 * ConfigValidationError built only from field names and categories,
 * deliberately discarding Zod's own issue messages so a submitted value
 * can never leak through a diagnostic.
 */
export function parseConfig<T>(
  processName: string,
  schema: ZodType<T>,
  raw: unknown,
  categoryOf: (variable: string) => ConfigCategory,
): T {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  const issues: ConfigFieldIssue[] = result.error.issues.map((issue) => {
    const variable = String(issue.path[0] ?? "unknown");
    return { variable, category: categoryOf(variable) };
  });

  throw new ConfigValidationError(processName, issues);
}
