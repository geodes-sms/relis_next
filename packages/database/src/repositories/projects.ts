// Internal, Prisma-backed implementation of `ProjectRepository` (see
// ./types.ts for the public interface and the full rationale for
// `createProjectWithOwner`/`activateProject`'s atomicity). Not exported
// from this package's index.ts directly.

import type { PrismaClient } from "../../generated/control-client/client.js";
import { isForeignKeyConstraintError, isUniqueConstraintError, sanitizeUnexpectedError, uniqueConstraintTargetFields, withSanitizedErrors } from "./errors.js";
import type {
  ActivateProjectResult,
  CreateProjectWithOwnerInput,
  CreateProjectWithOwnerResult,
  MembershipRecord,
  ProjectRecord,
  ProjectRepository,
} from "./types.js";

type ProjectRow = {
  id: string;
  title: string;
  shortName: string;
  description: string | null;
  createdByUserId: string;
  provisioningState: string;
  publishedAt: Date | null;
  archivedAt: Date | null;
  coverImageStorageKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

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

const PROJECT_SELECT = {
  id: true,
  title: true,
  shortName: true,
  description: true,
  createdByUserId: true,
  provisioningState: true,
  publishedAt: true,
  archivedAt: true,
  coverImageStorageKey: true,
  createdAt: true,
  updatedAt: true,
} as const;

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

function toProjectRecord(row: ProjectRow): ProjectRecord {
  return { ...row, provisioningState: row.provisioningState as ProjectRecord["provisioningState"] };
}

function toMembershipRecord(row: MembershipRow): MembershipRecord {
  return { ...row, role: row.role as MembershipRecord["role"], status: row.status as MembershipRecord["status"] };
}

export function createProjectRepository(prisma: PrismaClient): ProjectRepository {
  return {
    async createProjectWithOwner(input: CreateProjectWithOwnerInput): Promise<CreateProjectWithOwnerResult> {
      try {
        // ONE transaction creates both rows — 18's explicit requirement.
        // If the Membership insert fails for ANY reason after the
        // Project insert has been issued, Postgres rolls back the WHOLE
        // transaction: the Project row never becomes visible to any
        // other connection either (see the integration test covering
        // this exact rollback for `activateProject` below, and
        // tests/integration/control-prisma/project-repository.test.ts
        // for this operation's own positive/negative evidence).
        const { project, membership } = await prisma.$transaction(async (tx) => {
          const projectRow = await tx.project.create({
            data: {
              title: input.title,
              shortName: input.shortName,
              description: input.description,
              createdByUserId: input.createdByUserId,
              idempotencyKey: input.idempotencyKey,
              provisioningState: "PROVISIONING",
            },
            select: PROJECT_SELECT,
          });
          const membershipRow = await tx.membership.create({
            data: {
              projectId: projectRow.id,
              userId: input.createdByUserId,
              role: "PROJECT_OWNER",
              status: "PENDING_PROVISIONING",
            },
            select: MEMBERSHIP_SELECT,
          });
          return { project: projectRow, membership: membershipRow };
        });
        return { ok: true, project: toProjectRecord(project), ownerMembership: toMembershipRecord(membership) };
      } catch (caught) {
        if (isUniqueConstraintError(caught)) {
          const fields = uniqueConstraintTargetFields(caught);
          if (fields.includes("shortName")) return { ok: false, error: { type: "duplicate_short_name" } };
          if (fields.includes("idempotencyKey")) return { ok: false, error: { type: "duplicate_idempotency_key" } };
        }
        if (isForeignKeyConstraintError(caught)) {
          return { ok: false, error: { type: "creator_not_found" } };
        }
        throw sanitizeUnexpectedError(caught);
      }
    },

    async activateProject(projectId: string): Promise<ActivateProjectResult> {
      try {
        const project = await prisma.$transaction(async (tx) => {
          const existing = await tx.project.findUnique({ where: { id: projectId }, select: { id: true } });
          if (!existing) {
            throw new ProjectNotFoundError();
          }

          // The project ROW UPDATE happens first (the "earlier write" a
          // rollback test deliberately exercises) — if the owner
          // membership turns out to be missing/not-pending immediately
          // after, this entire transaction rolls back, including this
          // update: the project's `provisioningState` is never observably
          // changed outside the transaction unless both succeed. This
          // ordering is a defense-in-depth integrity check (18's explicit
          // "activate the Project and the creator's protected
          // PROJECT_OWNER membership only after... — never before"), not
          // merely a lookup convenience.
          const updatedProject = await tx.project.update({
            where: { id: projectId },
            data: { provisioningState: "READY" },
            select: PROJECT_SELECT,
          });

          const membershipUpdate = await tx.membership.updateMany({
            where: { projectId, role: "PROJECT_OWNER", status: "PENDING_PROVISIONING" },
            data: { status: "ACTIVE" },
          });
          if (membershipUpdate.count !== 1) {
            // Deliberately thrown INSIDE the transaction: Postgres rolls
            // back the project update above too — proving this is a real
            // atomic pair, not two independent writes.
            throw new OwnerMembershipNotPendingError();
          }
          return updatedProject;
        });
        return { ok: true, project: toProjectRecord(project) };
      } catch (caught) {
        if (caught instanceof ProjectNotFoundError) {
          return { ok: false, error: { type: "project_not_found" } };
        }
        if (caught instanceof OwnerMembershipNotPendingError) {
          return { ok: false, error: { type: "owner_membership_not_pending" } };
        }
        throw sanitizeUnexpectedError(caught);
      }
    },

    async findProjectById(id: string): Promise<ProjectRecord | null> {
      return withSanitizedErrors(async () => {
        const row = await prisma.project.findUnique({ where: { id }, select: PROJECT_SELECT });
        return row ? toProjectRecord(row) : null;
      });
    },

    async findProjectByShortName(shortName: string): Promise<ProjectRecord | null> {
      return withSanitizedErrors(async () => {
        const row = await prisma.project.findUnique({ where: { shortName }, select: PROJECT_SELECT });
        return row ? toProjectRecord(row) : null;
      });
    },
  };
}

/** Thrown only inside `activateProject`'s own transaction to force a rollback — never propagated past this file. */
class ProjectNotFoundError extends Error {
  constructor() {
    super("Project not found");
  }
}

/** Thrown only inside `activateProject`'s own transaction to force a rollback — never propagated past this file. */
class OwnerMembershipNotPendingError extends Error {
  constructor() {
    super("Owner membership not found in PENDING_PROVISIONING state for this project");
  }
}
