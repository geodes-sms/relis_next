import { z } from "zod";

/**
 * Browser-safe primitives shared by every process schema. This module must
 * never import Node built-ins or server-only packages (dotenv, node:fs) so
 * that it stays importable from client bundles through the "./public"
 * entry point.
 */

export const PORT_MIN = 1;
export const PORT_MAX = 65535;

export const portSchema = z.coerce.number().int().min(PORT_MIN).max(PORT_MAX);

const ALLOWED_URL_PROTOCOLS = ["http:", "https:"] as const;

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasAllowedProtocol(url: URL): boolean {
  return (ALLOWED_URL_PROTOCOLS as readonly string[]).includes(url.protocol);
}

/** An http(s) URL, with or without a path, used for server-to-server calls. */
export const httpUrlSchema = z.string().refine((value) => {
  const url = tryParseUrl(value);
  return url !== null && hasAllowedProtocol(url);
}, "invalid_http_url");

/**
 * An http(s) URL safe to embed in a browser bundle: no embedded
 * username/password credentials.
 */
export const browserSafeUrlSchema = z.string().refine((value) => {
  const url = tryParseUrl(value);
  if (!url || !hasAllowedProtocol(url)) return false;
  return url.username === "" && url.password === "";
}, "invalid_browser_url");

/**
 * An explicit CORS origin: protocol + host (+ port), no path/query/hash,
 * no embedded credentials, and never the "*" wildcard.
 */
export const explicitOriginSchema = z.string().refine((value) => {
  const url = tryParseUrl(value);
  if (!url || !hasAllowedProtocol(url)) return false;
  if (url.username !== "" || url.password !== "") return false;
  return url.origin === value;
}, "invalid_cors_origin");

export const nodeEnvSchema = z.enum(["development", "test", "production"]);

export type NodeEnvValue = z.infer<typeof nodeEnvSchema>;

/**
 * Resolves a raw environment string to a fallback ONLY when the variable
 * is entirely absent. A value that IS supplied — including an empty or
 * whitespace-only string — is returned unchanged so schema validation
 * rejects it instead of silently falling back to the default.
 */
export function resolveOrDefault(raw: string | undefined, fallback: string): string {
  return raw === undefined ? fallback : raw;
}
