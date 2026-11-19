// Public entry point for `@relis/database` (sub-issue 03.05). Exposes
// ONLY typed repository interfaces/factories and application-facing
// types — never `PrismaClient`, a Prisma delegate, a raw transaction
// client, arbitrary SQL, arbitrary table/database selection, or an
// unrestricted create/update/delete argument object. See each type's own
// doc comment in src/repositories/types.ts for the consuming-requirement
// this surface traces to, and docs/architecture/control-database-contracts.md
// §8 for the full field-level data dictionary.
//
// `src/migrate.ts` (the existing, unchanged migration entry point) is
// intentionally NOT re-exported here — it is invoked only as a CLI
// script (`pnpm --filter @relis/database run migrate <target>`), never
// imported as a library dependency by application code.

export { createControlRepositories } from "./control-repositories.js";
export type { ControlRepositories } from "./control-repositories.js";

export type {
  ProjectRole,
  // User
  UserRecord,
  CreateUserInput,
  CreateUserResult,
  UserConflict,
  UserRepository,
  // Project
  ProjectRecord,
  MembershipRecord,
  CreateProjectWithOwnerInput,
  CreateProjectWithOwnerResult,
  ProjectConflict,
  ActivateProjectResult,
  ActivateProjectError,
  ProjectRepository,
  // Membership
  AddMemberInput,
  MembershipError,
  AddMemberResult,
  RemoveMemberResult,
  ChangeMemberRoleResult,
  MembershipRepository,
} from "./repositories/types.js";
