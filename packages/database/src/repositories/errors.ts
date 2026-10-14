// Shared, Prisma-aware error classification for every repository in this
// directory. Internal only — never re-exported from this package's
// index.ts; a consumer never sees a Prisma error type, only the stable
// typed outcomes each repository method returns.

import type { Prisma } from "../../generated/control-client/client.js";

function isKnownRequestErrorWithCode(error: unknown, code: string): error is Prisma.PrismaClientKnownRequestError {
  // Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError`
  // — that namespaced `export import` re-export does not carry a usable
  // type for `instanceof` narrowing in this generator/TS combination (the
  // same issue documented in
  // packages/database/scripts/control-client-smoke.mts). Every Prisma
  // PrismaClientKnownRequestError stably exposes a string `.code` (its
  // documented, versioned error-code contract).
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === code);
}

/** `P2002` — Prisma's "Unique constraint failed" code. */
export function isUniqueConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return isKnownRequestErrorWithCode(error, "P2002");
}

/** `P2003` — Prisma's "Foreign key constraint failed" code. */
export function isForeignKeyConstraintError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return isKnownRequestErrorWithCode(error, "P2003");
}

/** `P2025` — Prisma's "required record(s) not found" code (e.g. `update`/`delete` targeting a missing row). */
export function isRecordNotFoundError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return isKnownRequestErrorWithCode(error, "P2025");
}

/**
 * The exact unique-constraint field name(s) Prisma reports for a
 * `P2002`, if any. Classic Prisma populates `error.meta.target` directly;
 * this generator/driver-adapter combination (Prisma 7.9.0's
 * query-compiler + `@prisma/adapter-pg` path) was found, by running this
 * exact check against a real disposable PostgreSQL database, to leave
 * `meta.target` absent and report only `meta.modelName` instead — which
 * does not disambiguate between a model's several unique fields (e.g.
 * `User.email` vs. `User.username`). The field name IS present in
 * Prisma's own stable, documented P2002 message text ("Unique
 * constraint failed on the fields: (`email`)"), parsed as a fallback.
 */
export function uniqueConstraintTargetFields(error: Prisma.PrismaClientKnownRequestError): string[] {
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") return [target];
  const match = /Unique constraint failed on the fields: \(([^)]+)\)/.exec(error.message);
  if (match) {
    // Observed real shapes include both a plain field name (`` `email` ``)
    // and a SQL-identifier-quoted one (`` `"shortName"` `` — the raw
    // Postgres detail text for a camelCase column, backticks AND double
    // quotes both present) — strip both wrapper characters.
    return match[1].split(",").map((field) => field.trim().replace(/[`"]/g, ""));
  }
  return [];
}

/**
 * Never re-throws a raw Prisma error (which can carry SQL fragments,
 * connection details, or other internal engine detail in its message) to
 * a repository's caller — every EXPECTED outcome is already mapped to a
 * stable typed result by the caller before this is reached; anything
 * else becomes this single, stable, detail-free error. Deliberately does
 * NOT attach `caught` as `.cause` (or anywhere else on the returned
 * error) — that would reintroduce exactly the leak this function exists
 * to prevent for an unexpected failure.
 */
export function sanitizeUnexpectedError(_caught: unknown): Error {
  return new Error("Unexpected Control DB persistence failure");
}

/**
 * Runs `operation` and, if it throws ANYTHING, rethrows
 * `sanitizeUnexpectedError`'s detail-free replacement instead — never the
 * original. Intended for the read/list operations and auxiliary lookups
 * in this directory that have no EXPECTED Prisma error code to map to a
 * typed outcome (a plain "not found" is already expressed by a `null`/
 * empty return value, not an exception); a genuine connection failure,
 * timeout, or any other unexpected throw must still never reach a public
 * caller unsanitized. Methods that DO branch on specific expected error
 * codes (`createUser`, `createProjectWithOwner`, `activateProject`,
 * `addMember`'s primary `create()` call) keep their own explicit
 * try/catch instead of this helper, since they must inspect `caught`
 * before deciding whether it is expected or not — but they still end
 * their own catch block the same way, by calling
 * `sanitizeUnexpectedError` on anything not already mapped.
 */
export async function withSanitizedErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (caught) {
    throw sanitizeUnexpectedError(caught);
  }
}

/**
 * Runs both cleanup actions regardless of whether one rejects (a failed
 * client disconnect must never skip releasing the underlying connection
 * pool, or vice versa), then sanitizes and rethrows if either failed —
 * a disconnect-time failure can still carry connection-level detail (a
 * driver's own error message), not only a query-level one. Extracted
 * here, independent of `control-repositories.ts`'s real `Pool`/
 * `PrismaClient` construction, specifically so it can be unit-tested
 * with fakes (see tests/integration/control-prisma/error-sanitization.test.ts).
 */
export async function disconnectSafely(parts: { disconnect: () => Promise<void>; end: () => Promise<void> }): Promise<void> {
  const results = await Promise.allSettled([parts.disconnect(), parts.end()]);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected) {
    throw sanitizeUnexpectedError((rejected as PromiseRejectedResult).reason);
  }
}
