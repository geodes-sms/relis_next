// Public, Prisma-free types for the Control DB repository surface
// (sub-issue 03.05). Every type here is safe to re-export from
// `@relis/database`'s own public entry point (src/index.ts) — none of
// them reference `@prisma/client`, the generated Control client, or any
// Prisma-specific error/delegate type. Consuming use-case code should
// depend ONLY on the interfaces below (never on a concrete Prisma-backed
// implementation), which is what makes a hand-written fake usable in
// tests without a real database — see each repository interface's own
// comment for an example shape.

import type { ProjectRole } from "./role.js";

export type { ProjectRole };

// ---------------------------------------------------------------------
// User
// ---------------------------------------------------------------------

/**
 * The safe, consumer-facing shape of a Control DB user row. Deliberately
 * excludes credential material (`passwordHash`/`passwordSalt`/
 * `passwordParamsVersion`), the session-revocation counter, and
 * pending-email-change token fields — none of this is a "user record"
 * any consuming use case should receive wholesale (contracts.md §8.1:
 * these are sensitive/internal fields with their own lifecycle, not
 * general-purpose read data).
 */
export interface UserRecord {
  id: string;
  username: string;
  email: string;
  emailVerifiedAt: Date | null;
  status: "ACTIVE" | "DISABLED" | "ARCHIVED";
  isApplicationAdministrator: boolean;
  preferredLocale: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  username: string;
  email: string;
  /** Already-hashed credential material — this package never hashes a password itself (09's hashing pipeline is a consuming use case's concern, not the persistence boundary's). Omit for an external-identity-only account (14). */
  passwordHash?: string;
  passwordSalt?: string;
  passwordParamsVersion?: number;
}

export type UserConflict = { type: "duplicate_email" } | { type: "duplicate_username" };

export type CreateUserResult = { ok: true; user: UserRecord } | { ok: false; error: UserConflict };

/**
 * Example fake for tests (no database involved):
 * ```ts
 * const fakeUsers: UserRepository = {
 *   async createUser(input) { return { ok: true, user: { id: "u1", username: input.username, email: input.email, emailVerifiedAt: null, status: "ACTIVE", isApplicationAdministrator: false, preferredLocale: null, createdAt: new Date(), updatedAt: new Date() } }; },
 *   async findUserByEmail() { return null; },
 *   async findUserByUsername() { return null; },
 *   async findUserById() { return null; },
 * };
 * ```
 */
export interface UserRepository {
  createUser(input: CreateUserInput): Promise<CreateUserResult>;
  /** Exact-match lookup only (15 — API behavior: "accept one exact, normalized... value; never return a list"). */
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserByUsername(username: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
}

// ---------------------------------------------------------------------
// Project (+ atomic Owner creation/activation)
// ---------------------------------------------------------------------

export interface ProjectRecord {
  id: string;
  title: string;
  shortName: string;
  description: string | null;
  createdByUserId: string;
  provisioningState: "PROVISIONING" | "READY" | "FAILED";
  publishedAt: Date | null;
  archivedAt: Date | null;
  coverImageStorageKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipRecord {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  status: "PENDING_PROVISIONING" | "ACTIVE" | "REMOVED";
  addedByUserId: string | null;
  removedByUserId: string | null;
  removedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectWithOwnerInput {
  title: string;
  shortName: string;
  description?: string;
  createdByUserId: string;
  /** Deduplicates a repeated provisioning command (16 — Data model/Acceptance criteria). */
  idempotencyKey?: string;
}

export type ProjectConflict =
  | { type: "duplicate_short_name" }
  | { type: "duplicate_idempotency_key" }
  | { type: "creator_not_found" };

export type CreateProjectWithOwnerResult =
  | { ok: true; project: ProjectRecord; ownerMembership: MembershipRecord }
  | { ok: false; error: ProjectConflict };

export type ActivateProjectError = { type: "project_not_found" } | { type: "owner_membership_not_pending" };

export type ActivateProjectResult = { ok: true; project: ProjectRecord } | { ok: false; error: ActivateProjectError };

/**
 * Example fake for tests (no database involved):
 * ```ts
 * const fakeProjects: ProjectRepository = {
 *   async createProjectWithOwner(input) { ... },
 *   async activateProject() { return { ok: false, error: { type: "project_not_found" } }; },
 *   async findProjectById() { return null; },
 *   async findProjectByShortName() { return null; },
 * };
 * ```
 */
export interface ProjectRepository {
  /**
   * Creates the `Project` row (state `PROVISIONING`) and its creator's
   * protected `PROJECT_OWNER` membership (status `PENDING_PROVISIONING`)
   * in ONE transaction — both or neither (18 — API behavior: "In one
   * Control DB transaction: create the Project record... create the
   * creator's protected PROJECT_OWNER membership..."). This is the only
   * place a `PROJECT_OWNER` membership is ever created; there is no
   * public operation to assign that role any other way.
   */
  createProjectWithOwner(input: CreateProjectWithOwnerInput): Promise<CreateProjectWithOwnerResult>;
  /**
   * Transitions the project to `READY` and its owner membership to
   * `ACTIVE` together, or neither (18 — API behavior: "activate the
   * Project and the creator's protected PROJECT_OWNER membership only
   * after... — never before"). Fails (rolling back any partial update)
   * if the owner membership is not found in `PENDING_PROVISIONING` state
   * for this project — this is a real integrity check, not merely a
   * lookup convenience, and is this package's own defense against ever
   * leaving a project `READY` without an active Owner.
   */
  activateProject(projectId: string): Promise<ActivateProjectResult>;
  findProjectById(id: string): Promise<ProjectRecord | null>;
  findProjectByShortName(shortName: string): Promise<ProjectRecord | null>;
}

// ---------------------------------------------------------------------
// Membership (Owner-protection invariants enforced here, not merely by
// the database's partial unique indexes — see each method's own comment)
// ---------------------------------------------------------------------

export interface AddMemberInput {
  projectId: string;
  userId: string;
  /** `PROJECT_OWNER` is never accepted here — see `MembershipError`'s `owner_role_not_assignable`. */
  role: Exclude<ProjectRole, "PROJECT_OWNER">;
  addedByUserId: string;
}

export type MembershipError =
  | { type: "project_not_found" }
  | { type: "user_not_found" }
  | { type: "already_active_member" }
  | { type: "owner_role_not_assignable" }
  | { type: "membership_not_found" }
  | { type: "cannot_remove_owner" }
  | { type: "cannot_change_owner_role" };

export type AddMemberResult = { ok: true; membership: MembershipRecord } | { ok: false; error: MembershipError };
export type RemoveMemberResult = { ok: true; membership: MembershipRecord } | { ok: false; error: MembershipError };
export type ChangeMemberRoleResult = { ok: true; membership: MembershipRecord } | { ok: false; error: MembershipError };

/**
 * Example fake for tests (no database involved):
 * ```ts
 * const fakeMemberships: MembershipRepository = {
 *   async addMember() { return { ok: false, error: { type: "project_not_found" } }; },
 *   async removeMember() { return { ok: false, error: { type: "membership_not_found" } }; },
 *   async changeMemberRole() { return { ok: false, error: { type: "membership_not_found" } }; },
 *   async listActiveMembers() { return []; },
 * };
 * ```
 */
export interface MembershipRepository {
  /** Rejects `role: "PROJECT_OWNER"` at the TYPE level already (see `AddMemberInput`); also rejects it defensively at runtime, since a caller could still construct an object bypassing the type (e.g. from untrusted deserialized input upstream). No source ever describes assigning Owner through this path (role-decision.md §5 — "no such action exists"). */
  addMember(input: AddMemberInput): Promise<AddMemberResult>;
  /** Unconditionally rejects removing the `PROJECT_OWNER` membership — role-decision.md §3.2/§6: absolute, not count-based, and not an authorization check this package can see (any caller, any role). There is no "last Manager" guard — removing the last Manager succeeds. */
  removeMember(membershipId: string, removedByUserId: string, reason?: string): Promise<RemoveMemberResult>;
  /** Unconditionally rejects changing the role of a `PROJECT_OWNER` membership, and rejects `newRole: "PROJECT_OWNER"` for any membership — both directions of role-decision.md's "Owner can never be assigned/removed/role-changed via membership endpoints". */
  changeMemberRole(membershipId: string, newRole: Exclude<ProjectRole, "PROJECT_OWNER">): Promise<ChangeMemberRoleResult>;
  listActiveMembers(projectId: string): Promise<MembershipRecord[]>;
}
