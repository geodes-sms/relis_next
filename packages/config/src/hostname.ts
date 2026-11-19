import net from "node:net";
import { z } from "zod";

/**
 * Server-only: validates a bare listener hostname/IP for binding a server
 * socket (API_HOST). Deliberately kept OUT of primitives.ts (the
 * browser-safe module behind "@relis/config/public") because it imports
 * node:net — apps/web's client bundle must never pull this in.
 *
 * IPv4/IPv6 structure is validated with Node's own `net.isIP`, a platform
 * primitive, rather than a hand-rolled regular expression: an earlier
 * character-class-only regex incorrectly accepted malformed addresses such
 * as "::::", "1:2", and "12345::1". `net.isIP` correctly rejects all three
 * while still accepting compressed/full IPv6, IPv4-mapped IPv6, and
 * zone-index forms (e.g. "fe80::1%eth0").
 */

const HOSTNAME_LABEL = "(?!-)[A-Za-z0-9-]{1,63}(?<!-)";
const HOSTNAME_REGEX = new RegExp(`^${HOSTNAME_LABEL}(\\.${HOSTNAME_LABEL})*$`);

function isDottedQuadShape(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part));
}

/**
 * A bare listener hostname/IP for binding a server socket: no scheme, no
 * embedded credentials, no path, no port. Rejects a full URL
 * ("http://host"), a value carrying "user:pass@", and other malformed
 * input outright rather than letting it reach the network stack.
 */
export function isValidHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  if (/\s/.test(value)) return false;
  if (value.includes("@")) return false;
  if (value.includes("://")) return false;
  if (value.includes("/")) return false;
  if (net.isIP(value) !== 0) return true;
  // A dotted-quad SHAPE that net.isIP rejected is an invalid IPv4 address
  // (e.g. an out-of-range octet like "999.0.0.1") — never fall through to
  // accepting it as a generic hostname (numeric labels are technically
  // legal hostname labels).
  if (isDottedQuadShape(value)) return false;
  // ":" is not a valid hostname character and net.isIP already rejected
  // this as a real IPv6 address.
  if (value.includes(":")) return false;
  return HOSTNAME_REGEX.test(value);
}

export const hostnameSchema = z.string().refine(isValidHostname, "invalid_hostname");
