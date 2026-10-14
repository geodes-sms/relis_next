// Internal, Prisma-backed implementation of `UserRepository` (see
// ./types.ts for the public interface). Not exported from this package's
// index.ts directly — only `createControlRepositories` (control-repositories.ts)
// constructs one, and only the `UserRepository` INTERFACE (not this file,
// not the Prisma types it imports) is part of the public surface a
// consumer sees.

import type { PrismaClient } from "../../generated/control-client/client.js";
import { isUniqueConstraintError, sanitizeUnexpectedError, uniqueConstraintTargetFields, withSanitizedErrors } from "./errors.js";
import type { CreateUserResult, CreateUserInput, UserRecord, UserRepository } from "./types.js";

/** The minimal, safe column set every query below selects — never `passwordHash`/`passwordSalt`/`passwordParamsVersion`/`sessionTokenVersion`/pending-email-change fields (see UserRecord's own doc comment). */
const SAFE_USER_SELECT = {
  id: true,
  username: true,
  email: true,
  emailVerifiedAt: true,
  status: true,
  isApplicationAdministrator: true,
  preferredLocale: true,
  createdAt: true,
  updatedAt: true,
} as const;

type SafeUserRow = {
  id: string;
  username: string;
  email: string;
  emailVerifiedAt: Date | null;
  status: string;
  isApplicationAdministrator: boolean;
  preferredLocale: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toUserRecord(row: SafeUserRow): UserRecord {
  // The narrowed select above guarantees `status` only ever contains one
  // of these three values at the database level (the `AccountStatus`
  // enum) — this cast documents that guarantee rather than re-validating it.
  return { ...row, status: row.status as UserRecord["status"] };
}

export function createUserRepository(prisma: PrismaClient): UserRepository {
  return {
    async createUser(input: CreateUserInput): Promise<CreateUserResult> {
      try {
        const row = await prisma.user.create({
          data: {
            username: input.username,
            email: input.email,
            passwordHash: input.passwordHash,
            passwordSalt: input.passwordSalt,
            passwordParamsVersion: input.passwordParamsVersion,
          },
          select: SAFE_USER_SELECT,
        });
        return { ok: true, user: toUserRecord(row) };
      } catch (caught) {
        if (isUniqueConstraintError(caught)) {
          const fields = uniqueConstraintTargetFields(caught);
          if (fields.includes("email")) return { ok: false, error: { type: "duplicate_email" } };
          if (fields.includes("username")) return { ok: false, error: { type: "duplicate_username" } };
        }
        throw sanitizeUnexpectedError(caught);
      }
    },

    async findUserByEmail(email: string): Promise<UserRecord | null> {
      return withSanitizedErrors(async () => {
        const row = await prisma.user.findUnique({ where: { email }, select: SAFE_USER_SELECT });
        return row ? toUserRecord(row) : null;
      });
    },

    async findUserByUsername(username: string): Promise<UserRecord | null> {
      return withSanitizedErrors(async () => {
        const row = await prisma.user.findUnique({ where: { username }, select: SAFE_USER_SELECT });
        return row ? toUserRecord(row) : null;
      });
    },

    async findUserById(id: string): Promise<UserRecord | null> {
      return withSanitizedErrors(async () => {
        const row = await prisma.user.findUnique({ where: { id }, select: SAFE_USER_SELECT });
        return row ? toUserRecord(row) : null;
      });
    },
  };
}
