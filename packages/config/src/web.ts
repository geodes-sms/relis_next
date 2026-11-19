import { z } from "zod";
import { portSchema, resolveOrDefault } from "./primitives.js";
import { parseConfig, type ConfigCategory } from "./parse.js";

export { publicWebConfigSchema, parsePublicWebConfig, type PublicWebConfig, type RawPublicWebEnv } from "./public.js";

const DEFAULTS = {
  WEB_PORT: "3000",
} as const;

/**
 * The Next.js process's own listener port. Distinct from apps/api's port so
 * both services can run together locally.
 */
export const webRuntimeConfigSchema = z.object({
  WEB_PORT: portSchema,
});

export type WebRuntimeConfig = z.infer<typeof webRuntimeConfigSchema>;

export interface RawWebRuntimeEnv {
  WEB_PORT?: string;
}

export function loadWebRuntimeConfig(raw: RawWebRuntimeEnv): WebRuntimeConfig {
  const resolved = {
    WEB_PORT: resolveOrDefault(raw.WEB_PORT, DEFAULTS.WEB_PORT),
  };
  return parseConfig("web", webRuntimeConfigSchema, resolved, () => "network");
}

export const WEB_CONFIG_CATEGORIES: readonly ConfigCategory[] = ["network", "public"];
