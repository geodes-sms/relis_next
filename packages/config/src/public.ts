import { z } from "zod";
import { browserSafeUrlSchema, resolveOrDefault } from "./primitives.js";
import { parseConfig, type ConfigCategory } from "./parse.js";

/**
 * Browser-safe entry point. This module (and everything it imports) must
 * never import Node built-ins, dotenv, or any server-only schema, because
 * it is bundled into apps/web's client output via the "@relis/config/public"
 * subpath export.
 */

const DEFAULT_API_URL = "http://localhost:3001";

export const publicWebConfigSchema = z.object({
  NEXT_PUBLIC_API_URL: browserSafeUrlSchema,
});

export type PublicWebConfig = z.infer<typeof publicWebConfigSchema>;

export interface RawPublicWebEnv {
  NEXT_PUBLIC_API_URL?: string;
}

function categoryOfPublicField(): ConfigCategory {
  return "public";
}

/**
 * NEXT_PUBLIC_API_URL is optional in local development (falls back to
 * http://localhost:3001, preserving the previous behavior) but any
 * supplied value must be a valid http(s) URL without embedded credentials.
 * An invalid supplied value is rejected, never silently replaced.
 */
export function parsePublicWebConfig(raw: RawPublicWebEnv): PublicWebConfig {
  const resolved = {
    NEXT_PUBLIC_API_URL: resolveOrDefault(raw.NEXT_PUBLIC_API_URL, DEFAULT_API_URL),
  };
  return parseConfig("web (public)", publicWebConfigSchema, resolved, categoryOfPublicField);
}
