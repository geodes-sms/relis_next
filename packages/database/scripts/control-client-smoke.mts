// Real-database smoke/negative-evidence script for sub-issue 03.04's
// corrective review pass. Not part of the package's public source (never
// imported from src/, never exported from index.ts) — a test-support
// script only, invoked via `pnpm --filter @relis/database run
// smoke:control -- <mode>` from inside the existing `migrate-control`
// Compose service by tests/migration/control-prisma/client-smoke.test.ts.
// Lives under scripts/ (not src/) so it is never mistaken for library
// code 03.05 might import, matching this repository's existing
// apps/web/scripts/run.mjs convention for a support script that is not
// part of its package's own public surface.
//
// Proves the GENERATED Control client (packages/database/generated/
// control-client, built with the prescribed `@prisma/adapter-pg` driver
// adapter — see schema.prisma's generator block) actually works against a
// real, already-migrated PostgreSQL database: file-existence assertions
// and raw `psql` queries (constraints.test.ts) do not prove the client
// itself can connect, write, and read through Prisma's query engine.
//
// Each mode below asserts the INTENDED outcome specifically — never "any
// error" for the negative modes — and always disconnects in a
// `finally` block so a thrown assertion never leaks the pool connection.

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/control-client/client.js";

const SMOKE_USER_ID = "smoke-client-user";
const SMOKE_PROJECT_ID = "smoke-client-project";

function requireConnectionString(): string {
  const value = process.env.CONTROL_DATABASE_URL;
  if (!value) {
    throw new Error("CONTROL_DATABASE_URL is required to run this script");
  }
  return value;
}

/** Prefixed (like the codebase's existing "SPAWN_CAPTURED:" convention —
 * see tests/integration/runtime-config/deployment-env-resolution.test.ts)
 * so the calling test can find this one line reliably amid any other
 * stdout noise (pnpm's own banner lines, etc.). */
function report(ok: boolean, mode: string, detail: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(`SMOKE_RESULT:${JSON.stringify({ ok, mode, ...detail })}`);
  process.exitCode = ok ? 0 : 1;
}

async function runWriteRead(prisma: PrismaClient): Promise<void> {
  const user = await prisma.user.create({
    data: { id: SMOKE_USER_ID, username: SMOKE_USER_ID, email: `${SMOKE_USER_ID}@example.test` },
  });

  const project = await prisma.project.create({
    data: { id: SMOKE_PROJECT_ID, title: "Client Smoke Project", shortName: "client-smoke-project", createdByUserId: user.id },
  });

  await prisma.membership.create({
    data: { projectId: project.id, userId: user.id, role: "PROJECT_OWNER", status: "ACTIVE" },
  });

  const reread = await prisma.project.findUniqueOrThrow({
    where: { id: SMOKE_PROJECT_ID },
    include: { memberships: true },
  });

  const ownerMembership = reread.memberships.find((m) => m.role === "PROJECT_OWNER");
  const ok = reread.title === "Client Smoke Project" && ownerMembership?.userId === SMOKE_USER_ID && ownerMembership.status === "ACTIVE";
  report(ok, "write-read", { readBackTitle: reread.title, ownerUserId: ownerMembership?.userId ?? null });
}

async function runReadMarker(prisma: PrismaClient): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: SMOKE_USER_ID } });
  report(user !== null && user.username === SMOKE_USER_ID, "read-marker", { found: user !== null });
}

async function runFkViolation(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.membership.create({
      data: { projectId: "nonexistent-project-id", userId: "nonexistent-user-id", role: "GUEST", status: "ACTIVE" },
    });
    report(false, "fk-violation", { unexpected: "create() succeeded — the foreign key constraint did not fire" });
  } catch (caught) {
    // Duck-typed rather than `instanceof Prisma.PrismaClientKnownRequestError`:
    // that namespaced `export import` re-export does not carry a usable
    // type for `instanceof` narrowing here. Every Prisma
    // PrismaClientKnownRequestError stably exposes a string `.code` (its
    // documented, versioned error-code contract, e.g. "P2003" for a
    // foreign-key constraint failure) — checked directly instead.
    const code = caught && typeof caught === "object" && "code" in caught ? String((caught as { code: unknown }).code) : null;
    report(code === "P2003", "fk-violation", {
      errorCode: code,
      errorName: caught instanceof Error ? caught.constructor.name : typeof caught,
      message: caught instanceof Error ? caught.message : String(caught),
    });
  }
}

async function runRequiredFieldViolation(prisma: PrismaClient): Promise<void> {
  // Prisma Client validates required scalar fields CLIENT-SIDE before a
  // typed `create()` ever reaches SQL — bypassing that validation (via a
  // raw query, deliberately omitting the required `username`/`email`
  // columns) is the only way to exercise the actual database-level
  // NOT NULL constraint through this client, rather than Prisma's own
  // pre-flight check.
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "users" ("id", "createdAt", "updatedAt") VALUES ('required-field-violation-user', now(), now());`,
    );
    report(false, "required-field-violation", { unexpected: "$executeRawUnsafe succeeded — the NOT NULL constraint did not fire" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const matchesNotNullViolation = /null value in column "username".*violates not-null constraint/is.test(message);
    report(matchesNotNullViolation, "required-field-violation", {
      errorName: error instanceof Error ? error.constructor.name : typeof error,
      message,
    });
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const pool = new Pool({ connectionString: requireConnectionString() });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    switch (mode) {
      case "write-read":
        await runWriteRead(prisma);
        break;
      case "read-marker":
        await runReadMarker(prisma);
        break;
      case "fk-violation":
        await runFkViolation(prisma);
        break;
      case "required-field-violation":
        await runRequiredFieldViolation(prisma);
        break;
      default:
        report(false, String(mode), { unexpected: `unknown mode "${mode}"` });
    }
  } catch (error) {
    report(false, String(mode), { unexpected: error instanceof Error ? error.message : String(error) });
  } finally {
    // Always disconnect, even on a thrown/caught error above — never
    // leak the pool connection.
    await prisma.$disconnect();
    await pool.end();
  }
}

await main();
