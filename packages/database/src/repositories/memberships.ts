// Internal, Prisma-backed implementation of `MembershipRepository` (see
// ./types.ts for the public interface and the Owner-protection rationale).
// Not exported from this package's index.ts directly.

import type { PrismaClient } from "../../generated/control-client/client.js";
import { isForeignKeyConstraintError, isUniqueConstraintError, sanitizeUnexpectedError, withSanitizedErrors } from "./errors.js";
import type { AddMemberInput, AddMemberResult, ChangeMemberRoleResult, MembershipRecord, MembershipRepository, RemoveMemberResult } from "./types.js";

type MembershipRow = {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  status: string;
  addedByUserId: string | null;
  removedByUserId: string | null;
  removedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const MEMBERSHIP_SELECT = {
  id: true,
  projectId: true,
  userId: true,
  role: true,
  status: true,
  addedByUserId: true,
  removedByUserId: true,
  removedReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toMembershipRecord(row: MembershipRow): MembershipRecord {
  return { ...row, role: row.role as MembershipRecord["role"], status: row.status as MembershipRecord["status"] };
}

export function createMembershipRepository(prisma: PrismaClient): MembershipRepository {
  return {
    async addMember(input: AddMemberInput): Promise<AddMemberResult> {
      // Defensive runtime check, independent of the type system (see
      // AddMemberInput's own doc comment) — this is the ONLY place that
      // could ever be tempted to assign PROJECT_OWNER outside project
      // creation, so it is rejected explicitly and first, before any
      // database round trip.
      if ((input.role as string) === "PROJECT_OWNER") {
        return { ok: false, error: { type: "owner_role_not_assignable" } };
      }
      try {
        const row = await prisma.membership.create({
          data: {
            projectId: input.projectId,
            userId: input.userId,
            role: input.role,
            status: "ACTIVE",
            addedByUserId: input.addedByUserId,
          },
          select: MEMBERSHIP_SELECT,
        });
        return { ok: true, membership: toMembershipRecord(row) };
      } catch (caught) {
        if (isUniqueConstraintError(caught)) {
          // The partial unique index `memberships_active_project_user_key`
          // — at most one ACTIVE row per (projectId, userId).
          return { ok: false, error: { type: "already_active_member" } };
        }
        if (isForeignKeyConstraintError(caught)) {
          // Prisma does not distinguish WHICH foreign key failed from the
          // error shape alone without an extra round trip; a missing
          // project is checked first (the more common caller mistake —
          // an unauthorized/cross-project id), falling back to
          // user_not_found when the project does exist. This auxiliary
          // lookup is its OWN failure point (e.g. the connection drops
          // between the two calls) — wrapped so that failure is
          // sanitized too, not merely the original `create()` error.
          const projectExists = await withSanitizedErrors(() => prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true } }));
          return { ok: false, error: { type: projectExists ? "user_not_found" : "project_not_found" } };
        }
        throw sanitizeUnexpectedError(caught);
      }
    },

    async removeMember(membershipId: string, removedByUserId: string, reason?: string): Promise<RemoveMemberResult> {
      try {
        // Unconditional: `updateMany` with an explicit `role: { not: "PROJECT_OWNER" }`
        // guard means an attempt to remove the Owner matches ZERO rows —
        // never silently "succeeds" by removing the wrong row, and never
        // relies on a separate pre-check that could race with a
        // concurrent change (the WHERE clause itself is the guard,
        // evaluated atomically by Postgres for this single statement).
        const result = await prisma.membership.updateMany({
          where: { id: membershipId, role: { not: "PROJECT_OWNER" } },
          data: { status: "REMOVED", removedByUserId, removedReason: reason },
        });
        if (result.count === 0) {
          const existing = await prisma.membership.findUnique({ where: { id: membershipId }, select: { role: true } });
          if (!existing) return { ok: false, error: { type: "membership_not_found" } };
          // It exists, and the guarded update still matched nothing — the
          // only remaining explanation given the WHERE clause above is
          // that it is the protected Owner membership.
          return { ok: false, error: { type: "cannot_remove_owner" } };
        }
        const row = await prisma.membership.findUniqueOrThrow({ where: { id: membershipId }, select: MEMBERSHIP_SELECT });
        return { ok: true, membership: toMembershipRecord(row) };
      } catch (caught) {
        throw sanitizeUnexpectedError(caught);
      }
    },

    async changeMemberRole(membershipId: string, newRole): Promise<ChangeMemberRoleResult> {
      if ((newRole as string) === "PROJECT_OWNER") {
        return { ok: false, error: { type: "owner_role_not_assignable" } };
      }
      try {
        const result = await prisma.membership.updateMany({
          where: { id: membershipId, role: { not: "PROJECT_OWNER" } },
          data: { role: newRole },
        });
        if (result.count === 0) {
          const existing = await prisma.membership.findUnique({ where: { id: membershipId }, select: { role: true } });
          if (!existing) return { ok: false, error: { type: "membership_not_found" } };
          return { ok: false, error: { type: "cannot_change_owner_role" } };
        }
        const row = await prisma.membership.findUniqueOrThrow({ where: { id: membershipId }, select: MEMBERSHIP_SELECT });
        return { ok: true, membership: toMembershipRecord(row) };
      } catch (caught) {
        throw sanitizeUnexpectedError(caught);
      }
    },

    async listActiveMembers(projectId: string): Promise<MembershipRecord[]> {
      return withSanitizedErrors(async () => {
        const rows = await prisma.membership.findMany({
          where: { projectId, status: "ACTIVE" },
          select: MEMBERSHIP_SELECT,
          orderBy: { createdAt: "asc" },
        });
        return rows.map(toMembershipRecord);
      });
    },
  };
}
