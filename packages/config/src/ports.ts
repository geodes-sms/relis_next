import { loadApiConfig, type RawApiEnv } from "./api.js";
import { loadWebRuntimeConfig, type RawWebRuntimeEnv } from "./web.js";
import type { ConfigDiagnostic } from "./errors.js";

/**
 * Cross-cutting check for the combined dev startup boundary (root
 * package.json's "dev" script runs apps/api and apps/web together). This
 * intentionally lives OUTSIDE both apps/api's and apps/web's own config
 * schemas: neither process's loader is made to know about the other's
 * port, so each remains independently valid and testable. This is a
 * single validation check, not a deployment orchestrator.
 */
export class PortConflictError extends Error {
  readonly code = "PORT_CONFLICT" as const;
  readonly categories = ["network"] as const;
  readonly variables = ["API_PORT", "WEB_PORT"] as const;

  constructor() {
    super(
      "apps/api and apps/web are configured to listen on the same effective port. Set a distinct API_PORT or WEB_PORT.",
    );
    this.name = "PortConflictError";
  }

  toDiagnostic(): ConfigDiagnostic {
    return {
      code: this.code,
      process: "dev (api+web)",
      categories: [...this.categories],
      variables: [...this.variables],
    };
  }
}

/**
 * Validates apps/api's and apps/web's own configuration (so an
 * individually-invalid value is still reported the normal way) and then
 * checks their effective listener ports do not collide. Throws
 * PortConflictError only when both are otherwise valid and identical.
 */
export function checkPortConflicts(apiEnv: RawApiEnv, webEnv: RawWebRuntimeEnv): void {
  const api = loadApiConfig(apiEnv);
  const web = loadWebRuntimeConfig(webEnv);
  if (api.API_PORT === web.WEB_PORT) {
    throw new PortConflictError();
  }
}
