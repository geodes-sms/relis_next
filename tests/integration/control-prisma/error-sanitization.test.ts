import { describe, expect, it, vi } from "vitest";
import { createUserRepository } from "../../../packages/database/src/repositories/users.ts";
import { createProjectRepository } from "../../../packages/database/src/repositories/projects.ts";
import { createMembershipRepository } from "../../../packages/database/src/repositories/memberships.ts";
import { disconnectSafely } from "../../../packages/database/src/repositories/errors.ts";

// Sub-issue 03.05 (corrective pass) — proves EVERY public repository
// operation, and the connection-lifecycle `disconnect()` path, sanitizes
// an unexpected failure before it reaches a caller — never the original
// error, message, `.code`/`.meta`, or `.cause`.
//
// FAULT INJECTION, NOT REAL DATABASE EVIDENCE: every "Prisma client" below
// is a hand-written fake whose methods reject with a SYNTHETIC error
// containing recognizable markers (a fake connection string, a fake SQL
// fragment, a fake secret token) that would never legitimately appear in
// this package's own sanitized output. No Docker, no real PostgreSQL, no
// real Prisma error is involved — this proves the SANITIZATION BOUNDARY
// itself (a thrown error's full shape, every own/enumerable property,
// `.cause`, and its `String()`/`JSON.stringify()` forms never contain any
// marker), not that a repository method correctly implements its business
// behavior against a real database (tests/integration/control-prisma/
// repository-operations.test.ts is that evidence, and is Docker-gated).
// A real repository method only ever reaches these generic catch-all
// paths for GENUINELY UNEXPECTED failures (connection loss, timeout, an
// error code this package does not specifically handle) — the expected
// conflict/missing-record codes (P2002/P2003/P2025) are deliberately
// exercised elsewhere with REAL Prisma errors
// (repository-operations.test.ts), not synthesized here.

const SECRET_MARKER = "sk_live_SYNTHETIC_SECRET_TOKEN_abc123";
const CONNECTION_MARKER = "postgresql://relis:S3cr3tPassw0rd@internal-db-host.example:5432/relis_control";
const SQL_MARKER = 'SELECT "passwordHash" FROM "users" WHERE "email" = $1 /* synthetic SQL fragment */';

/** A synthetic failure carrying every kind of marker this test set checks for, optionally shaped like a Prisma error with an UNHANDLED code (never P2002/P2003). */
function poisonedError(code?: string): Error & { code?: string; meta?: unknown } {
  const error = new Error(
    `Connection terminated unexpectedly while executing: ${SQL_MARKER} against ${CONNECTION_MARKER} (auth token: ${SECRET_MARKER})`,
  ) as Error & { code?: string; meta?: unknown };
  if (code) {
    error.code = code;
    error.meta = { secret: SECRET_MARKER, target: ["email"] };
  }
  return error;
}

/** Every observable surface a caller could inspect on a thrown value — none of it may ever contain a marker. */
function allObservableText(thrown: unknown): string {
  const parts: string[] = [];
  if (thrown instanceof Error) {
    parts.push(thrown.message, String(thrown.stack ?? ""), String((thrown as { cause?: unknown }).cause ?? ""));
    for (const key of Object.getOwnPropertyNames(thrown)) {
      parts.push(String((thrown as unknown as Record<string, unknown>)[key]));
    }
  }
  try {
    parts.push(JSON.stringify(thrown));
  } catch {
    // Circular/unserializable — the plain-property walk above already covers it.
  }
  parts.push(String(thrown));
  return parts.join("\n");
}

function expectSanitized(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("Unexpected Control DB persistence failure");
  const observable = allObservableText(thrown);
  expect(observable).not.toContain(SECRET_MARKER);
  expect(observable).not.toContain(CONNECTION_MARKER);
  expect(observable).not.toContain(SQL_MARKER);
  expect(observable).not.toContain("passwordHash");
}

async function expectRejectsSanitized(promise: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
    throw new Error("expected the promise to reject, but it resolved");
  } catch (caught) {
    thrown = caught;
  }
  expectSanitized(thrown);
}

describe("Repository error sanitization (fault injection, mocked — NOT real database evidence)", () => {
  describe("UserRepository", () => {
    function fakePrisma(methodThatThrows: "create" | "findUnique") {
      return {
        user: {
          create: vi.fn().mockRejectedValue(methodThatThrows === "create" ? poisonedError("P1017") : undefined),
          findUnique: vi.fn().mockRejectedValue(methodThatThrows === "findUnique" ? poisonedError() : undefined),
        },
      } as never;
    }

    it("createUser sanitizes an unexpected (non-P2002) failure", async () => {
      const repo = createUserRepository(fakePrisma("create"));
      await expectRejectsSanitized(repo.createUser({ username: "a", email: "a@example.test" }));
    });

    it("findUserByEmail sanitizes a failure (previously unprotected — the finding this corrects)", async () => {
      const repo = createUserRepository(fakePrisma("findUnique"));
      await expectRejectsSanitized(repo.findUserByEmail("a@example.test"));
    });

    it("findUserByUsername sanitizes a failure (previously unprotected)", async () => {
      const repo = createUserRepository(fakePrisma("findUnique"));
      await expectRejectsSanitized(repo.findUserByUsername("a"));
    });

    it("findUserById sanitizes a failure (previously unprotected)", async () => {
      const repo = createUserRepository(fakePrisma("findUnique"));
      await expectRejectsSanitized(repo.findUserById("id-1"));
    });
  });

  describe("ProjectRepository", () => {
    it("findProjectById sanitizes a failure (previously unprotected)", async () => {
      const fake = { project: { findUnique: vi.fn().mockRejectedValue(poisonedError()) } } as never;
      const repo = createProjectRepository(fake);
      await expectRejectsSanitized(repo.findProjectById("id-1"));
    });

    it("findProjectByShortName sanitizes a failure (previously unprotected)", async () => {
      const fake = { project: { findUnique: vi.fn().mockRejectedValue(poisonedError()) } } as never;
      const repo = createProjectRepository(fake);
      await expectRejectsSanitized(repo.findProjectByShortName("short-name"));
    });

    it("createProjectWithOwner sanitizes an unexpected (non-P2002/P2003) failure inside its transaction", async () => {
      const fake = {
        $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({ project: { create: vi.fn().mockRejectedValue(poisonedError("P1017")) }, membership: { create: vi.fn() } }),
        ),
      } as never;
      const repo = createProjectRepository(fake);
      await expectRejectsSanitized(
        repo.createProjectWithOwner({ title: "T", shortName: "sn", createdByUserId: "creator-1" }),
      );
    });

    it("activateProject sanitizes an unexpected failure inside its transaction", async () => {
      const fake = {
        $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({ project: { findUnique: vi.fn().mockRejectedValue(poisonedError()) } }),
        ),
      } as never;
      const repo = createProjectRepository(fake);
      await expectRejectsSanitized(repo.activateProject("project-1"));
    });
  });

  describe("MembershipRepository", () => {
    it("listActiveMembers sanitizes a failure (previously unprotected — the finding this corrects)", async () => {
      const fake = { membership: { findMany: vi.fn().mockRejectedValue(poisonedError()) } } as never;
      const repo = createMembershipRepository(fake);
      await expectRejectsSanitized(repo.listActiveMembers("project-1"));
    });

    it("addMember sanitizes a failure from its AUXILIARY project lookup inside the FK-error handler (the finding this specifically corrects)", async () => {
      const fkError = poisonedError("P2003");
      const fake = {
        membership: { create: vi.fn().mockRejectedValue(fkError) },
        // The auxiliary lookup itself throws a DIFFERENT poisoned error —
        // proving the SECOND failure is sanitized too, not merely masked
        // by the first one already being handled.
        project: { findUnique: vi.fn().mockRejectedValue(poisonedError()) },
      } as never;
      const repo = createMembershipRepository(fake);
      await expectRejectsSanitized(repo.addMember({ projectId: "p1", userId: "u1", role: "GUEST", addedByUserId: "actor-1" }));
    });

    it("removeMember sanitizes an unexpected failure", async () => {
      const fake = { membership: { updateMany: vi.fn().mockRejectedValue(poisonedError()) } } as never;
      const repo = createMembershipRepository(fake);
      await expectRejectsSanitized(repo.removeMember("membership-1", "actor-1"));
    });

    it("removeMember sanitizes a failure from its auxiliary findUnique lookup (zero-row update path)", async () => {
      const fake = {
        membership: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          findUnique: vi.fn().mockRejectedValue(poisonedError()),
        },
      } as never;
      const repo = createMembershipRepository(fake);
      await expectRejectsSanitized(repo.removeMember("membership-1", "actor-1"));
    });

    it("changeMemberRole sanitizes an unexpected failure", async () => {
      const fake = { membership: { updateMany: vi.fn().mockRejectedValue(poisonedError()) } } as never;
      const repo = createMembershipRepository(fake);
      await expectRejectsSanitized(repo.changeMemberRole("membership-1", "GUEST"));
    });
  });

  describe("Connection lifecycle — disconnectSafely", () => {
    it("sanitizes a failed $disconnect(), and still calls pool.end() regardless", async () => {
      const poolEnd = vi.fn().mockResolvedValue(undefined);
      await expectRejectsSanitized(disconnectSafely({ disconnect: () => Promise.reject(poisonedError()), end: poolEnd }));
      expect(poolEnd).toHaveBeenCalledTimes(1);
    });

    it("sanitizes a failed pool.end(), and still calls $disconnect() regardless", async () => {
      const prismaDisconnect = vi.fn().mockResolvedValue(undefined);
      await expectRejectsSanitized(disconnectSafely({ disconnect: prismaDisconnect, end: () => Promise.reject(poisonedError()) }));
      expect(prismaDisconnect).toHaveBeenCalledTimes(1);
    });

    it("succeeds silently when both cleanup actions succeed", async () => {
      await expect(disconnectSafely({ disconnect: () => Promise.resolve(), end: () => Promise.resolve() })).resolves.toBeUndefined();
    });
  });
});
