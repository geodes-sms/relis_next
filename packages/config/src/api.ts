import { z } from "zod";
import { hostnameSchema } from "./hostname.js";
import { explicitOriginSchema, nodeEnvSchema, portSchema, resolveOrDefault } from "./primitives.js";
import { parseConfig, type ConfigCategory } from "./parse.js";

const DEFAULTS = {
  NODE_ENV: "development",
  API_PORT: "3001",
  API_HOST: "0.0.0.0",
  API_CORS_ORIGIN: "http://localhost:3000",
} as const;

export const apiConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  API_PORT: portSchema,
  API_HOST: hostnameSchema,
  API_CORS_ORIGIN: explicitOriginSchema,
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export interface RawApiEnv {
  NODE_ENV?: string;
  API_PORT?: string;
  API_HOST?: string;
  API_CORS_ORIGIN?: string;
}

const CATEGORY_BY_FIELD: Record<string, ConfigCategory> = {
  NODE_ENV: "runtime",
  API_PORT: "network",
  API_HOST: "network",
  API_CORS_ORIGIN: "cors",
};

/**
 * apps/api owns synchronous HTTP. None of its variables require a value
 * with no safe local-development default: every field falls back when
 * absent/empty, but a supplied invalid value is always rejected.
 */
export function loadApiConfig(raw: RawApiEnv): ApiConfig {
  const resolved = {
    NODE_ENV: resolveOrDefault(raw.NODE_ENV, DEFAULTS.NODE_ENV),
    API_PORT: resolveOrDefault(raw.API_PORT, DEFAULTS.API_PORT),
    API_HOST: resolveOrDefault(raw.API_HOST, DEFAULTS.API_HOST),
    API_CORS_ORIGIN: resolveOrDefault(raw.API_CORS_ORIGIN, DEFAULTS.API_CORS_ORIGIN),
  };
  return parseConfig("api", apiConfigSchema, resolved, (field) => CATEGORY_BY_FIELD[field] ?? "network");
}

export const API_CONFIG_CATEGORIES: readonly ConfigCategory[] = ["network", "cors", "runtime"];
