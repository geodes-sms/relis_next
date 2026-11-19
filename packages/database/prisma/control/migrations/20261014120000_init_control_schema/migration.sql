-- Control DB — initial schema (sub-issue 03.04).
--
-- This file has two parts:
--   1. Prisma-generated DDL, produced without connecting to any database
--      via `prisma migrate diff --from-empty --to-schema prisma/control/schema.prisma --script`
--      (reviewed, not hand-edited). Regenerated once, after a review
--      correction made `audit_events.targetType`/`targetId`/`correlationId`
--      required instead of nullable (22-audit-undo.md's envelope lists
--      these unconditionally; only `projectId` carries a "when
--      applicable" qualifier) — the regenerated output was byte-for-byte
--      diffed against this file before being kept.
--   2. Hand-written raw SQL for three invariants Prisma's schema language
--      cannot express declaratively (no conditional/partial unique index,
--      no CHECK constraint) — see prisma/control/schema.prisma's header
--      comment and docs/architecture/control-database-role-decision.md §7
--      for why these are structural invariants rather than
--      application-only logic. Regenerating this migration from the
--      declarative schema alone (`prisma migrate diff`/`db pull`) will NOT
--      reproduce part 2 — any future migration editing this file by hand
--      must re-add these three statements.

-- ============================================================
-- Part 1 — Prisma-generated DDL
-- ============================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('PROJECT_OWNER', 'PROJECT_MANAGER', 'REVIEWER', 'VALIDATOR', 'GUEST');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('PENDING_PROVISIONING', 'ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "ProjectProvisioningState" AS ENUM ('PROVISIONING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('INVITED', 'ACCEPTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "isApplicationAdministrator" BOOLEAN NOT NULL DEFAULT false,
    "passwordHash" TEXT,
    "passwordSalt" TEXT,
    "passwordParamsVersion" INTEGER,
    "lastLoginAt" TIMESTAMP(3),
    "sessionTokenVersion" INTEGER NOT NULL DEFAULT 0,
    "preferredLocale" TEXT,
    "profileImageStorageKey" TEXT,
    "pendingEmail" TEXT,
    "pendingEmailTokenHash" TEXT,
    "pendingEmailExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "verifiedEmailSnapshot" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oidc_login_transactions" (
    "id" TEXT NOT NULL,
    "stateDigest" TEXT NOT NULL,
    "pkceVerifierEncrypted" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "returnPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "oidc_login_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "description" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "provisioningState" "ProjectProvisioningState" NOT NULL DEFAULT 'PROVISIONING',
    "idempotencyKey" TEXT,
    "templateReleaseIdentifier" TEXT,
    "provisioningJobId" TEXT,
    "provisioningFailureCode" TEXT,
    "provisioningFailureMessage" TEXT,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "coverImageStorageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_research_questions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "project_research_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "addedByUserId" TEXT,
    "removedByUserId" TEXT,
    "removedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "proposedRole" "ProjectRole" NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'INVITED',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "inviterUserId" TEXT NOT NULL,
    "acceptedUserId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_creation_drafts" (
    "id" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "currentStep" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_creation_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_records" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "actorUserId" TEXT,
    "projectId" TEXT,
    "progress" INTEGER,
    "safeErrorMessage" TEXT,
    "correlationId" TEXT,
    "resultArtifactReferences" JSONB,
    "idempotencyKey" TEXT,
    "queueJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "actorUserId" TEXT,
    "projectId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "redactedMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_tokenHash_key" ON "email_verification_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_provider_providerSubject_key" ON "external_identities"("provider", "providerSubject");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_login_transactions_stateDigest_key" ON "oidc_login_transactions"("stateDigest");

-- CreateIndex
CREATE UNIQUE INDEX "projects_shortName_key" ON "projects"("shortName");

-- CreateIndex
CREATE UNIQUE INDEX "projects_idempotencyKey_key" ON "projects"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "project_research_questions_projectId_order_key" ON "project_research_questions"("projectId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "project_creation_drafts_idempotencyKey_key" ON "project_creation_drafts"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "job_records_idempotencyKey_key" ON "job_records"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_requestedByAdminId_fkey" FOREIGN KEY ("requestedByAdminId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_research_questions" ADD CONSTRAINT "project_research_questions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviterUserId_fkey" FOREIGN KEY ("inviterUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_acceptedUserId_fkey" FOREIGN KEY ("acceptedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_creation_drafts" ADD CONSTRAINT "project_creation_drafts_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_records" ADD CONSTRAINT "job_records_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Part 2 — Hand-written structural invariants
-- (not expressible via Prisma's declarative schema; see
-- prisma/control/schema.prisma's header comment and
-- docs/architecture/control-database-role-decision.md §7)
-- ============================================================

-- At most one ACTIVE membership per (projectId, userId). A plain
-- composite unique (across ALL statuses) would incorrectly prevent ever
-- re-adding a previously REMOVED member — contracts.md §3.4 states the
-- requirement as "exactly one ACTIVE membership", not "one membership
-- row, ever", per (projectId, userId).
CREATE UNIQUE INDEX "memberships_active_project_user_key"
    ON "memberships" ("projectId", "userId")
    WHERE "status" = 'ACTIVE';

-- At most one PROJECT_OWNER membership per project — the DB-enforceable
-- half of "at most one Owner" (role-decision.md §7, category A/B
-- distinction). "Exactly one Owner, always" (never zero) is NOT
-- expressible as a constraint here; it is guaranteed only by 03.05's
-- transactional creation of Project + this membership together
-- (role-decision.md §6/§7) — this index only prevents a SECOND one from
-- ever being created, it cannot guarantee a first one exists.
CREATE UNIQUE INDEX "memberships_single_owner_per_project_key"
    ON "memberships" ("projectId")
    WHERE "role" = 'PROJECT_OWNER';

-- At most one INVITED invitation per (projectId, normalizedEmail) — same
-- conditional-uniqueness reasoning as the membership index above (15 —
-- Data model/Acceptance criteria: resending invalidates the prior
-- invitation; terminal invitations — ACCEPTED/EXPIRED/CANCELLED — must
-- not block a brand-new invite to the same address).
CREATE UNIQUE INDEX "invitations_active_project_email_key"
    ON "invitations" ("projectId", "normalizedEmail")
    WHERE "status" = 'INVITED';

-- PROJECT_OWNER is never an invitation-assignable role (role-decision.md
-- §3.1/§5 — Owner is assigned automatically to the creator only, never
-- through the invitation flow). Prisma's enum type has no per-field
-- "exclude one value" syntax, so this is a plain CHECK constraint on the
-- already-created enum column.
ALTER TABLE "invitations"
    ADD CONSTRAINT "invitations_proposed_role_not_owner_check"
    CHECK ("proposedRole" <> 'PROJECT_OWNER');
