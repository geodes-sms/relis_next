// Public connection-lifecycle factory for the Control DB repository
// surface (sub-issue 03.05). This is the ONE place `@prisma/adapter-pg`,
// the `pg` driver, and the generated Control client are instantiated —
// every repository below only ever receives the already-constructed
// `PrismaClient`, never a connection string or pool directly, and no
// Prisma type is part of this function's own public signature.
//
// Reuses the EXISTING validated Control configuration contract
// (`@relis/config`'s `loadDatabaseConfigForTarget`) rather than
// introducing a competing environment loader — the same contract
// src/migrate.ts already uses, so a missing/invalid `CONTROL_DATABASE_URL`
// fails the same way here as it does for migration (a `ConfigValidationError`
// with a safe, value-free diagnostic — see @relis/config's own contract).

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadDatabaseConfigForTarget } from "@relis/config";
import { PrismaClient } from "../generated/control-client/client.js";
import { disconnectSafely } from "./repositories/errors.js";
import { createMembershipRepository } from "./repositories/memberships.js";
import { createProjectRepository } from "./repositories/projects.js";
import { createUserRepository } from "./repositories/users.js";
import type { MembershipRepository, ProjectRepository, UserRepository } from "./repositories/types.js";

export interface ControlRepositories {
  users: UserRepository;
  projects: ProjectRepository;
  memberships: MembershipRepository;
  /**
   * Closes the underlying Prisma client AND the `pg` pool it was built on
   * — both must be released for a clean process exit / test teardown.
   * Safe to call once; calling it a second time is not supported (mirrors
   * `PrismaClient.$disconnect()`'s own contract).
   */
  disconnect(): Promise<void>;
}

/**
 * Constructs one set of Control repositories backed by a real PostgreSQL
 * connection, validated against `env` (defaults to `process.env`, exactly
 * like `src/migrate.ts`). Throws `@relis/config`'s `ConfigValidationError`
 * synchronously (before any connection attempt) if `CONTROL_DATABASE_URL`
 * is missing or invalid — never silently falls back to an unvalidated
 * value.
 *
 * Example — a consuming use case receiving repositories by injection
 * (never importing this factory itself, so it stays trivially testable
 * with a hand-written fake):
 * ```ts
 * interface Dependencies { users: UserRepository; projects: ProjectRepository }
 * async function registerUser(deps: Dependencies, input: CreateUserInput) {
 *   return deps.users.createUser(input);
 * }
 * // production wiring:
 * const repos = createControlRepositories();
 * await registerUser(repos, { username: "a", email: "a@example.test" });
 * // test wiring — no database, no Docker:
 * await registerUser({ users: fakeUserRepository, projects: fakeProjectRepository }, input);
 * ```
 */
export function createControlRepositories(env: NodeJS.ProcessEnv = process.env): ControlRepositories {
  const config = loadDatabaseConfigForTarget("control", env);
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  return {
    users: createUserRepository(prisma),
    projects: createProjectRepository(prisma),
    memberships: createMembershipRepository(prisma),
    disconnect: () => disconnectSafely({ disconnect: () => prisma.$disconnect(), end: () => pool.end() }),
  };
}
