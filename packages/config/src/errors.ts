/**
 * Diagnostic types shared by every schema. Browser-safe: no Node imports.
 *
 * Diagnostics never carry the submitted value or Zod's own issue message
 * (which can echo input in some validators). Only the configuration
 * category and variable name are considered safe to disclose.
 */

export type ConfigCategory = "network" | "cors" | "public" | "database" | "runtime";

export interface ConfigFieldIssue {
  variable: string;
  category: ConfigCategory;
}

export type ConfigDiagnosticCode = "CONFIG_INVALID" | "SERVER_START_FAILED" | "PORT_CONFLICT";

export interface ConfigDiagnostic {
  code: ConfigDiagnosticCode;
  process: string;
  categories: ConfigCategory[];
  variables: string[];
}

export class ConfigValidationError extends Error {
  readonly code = "CONFIG_INVALID" as const;
  readonly processName: string;
  readonly categories: ConfigCategory[];
  readonly variables: string[];

  constructor(processName: string, issues: ConfigFieldIssue[]) {
    const categories = [...new Set(issues.map((issue) => issue.category))].sort();
    super(
      `Invalid ${processName} configuration in categories: ${
        categories.join(", ") || "unknown"
      }. Submitted values are never included in this diagnostic.`,
    );
    this.name = "ConfigValidationError";
    this.processName = processName;
    this.categories = categories;
    this.variables = [...new Set(issues.map((issue) => issue.variable))].sort();
  }

  toDiagnostic(): ConfigDiagnostic {
    return {
      code: this.code,
      process: this.processName,
      categories: this.categories,
      variables: this.variables,
    };
  }
}
