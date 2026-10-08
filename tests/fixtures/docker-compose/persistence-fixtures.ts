/**
 * Synthetic, deterministic fixtures for the disposable-persistence check
 * (`tests/integration/docker-compose/persistence.test.ts`).
 *
 * Everything here is harmless, non-sensitive, and invented for this
 * verification only: no credential, no personal record, no real review
 * data, and no business schema (both Prisma schemas still define zero
 * models — see docs/architecture/docker-compose-stack.md). The tables
 * below are created directly with `psql` inside the disposable Compose
 * project's own PostgreSQL container and are destroyed with its volume;
 * they are deliberately NOT Prisma models and must never be mistaken for
 * one.
 *
 * Values are fixed rather than generated (no timestamp, no random
 * suffix) precisely so the post-reset assertions can state the exact
 * thing that must be ABSENT after a reset, rather than "something like
 * it".
 */

/** A fixture row planted in one database, identified by its own distinct marker. */
export interface DatabaseFixture {
  /** Unprefixed table name, created in the `public` schema. */
  table: string;
  /** The single row's marker value — unique per database, so leakage between them is detectable. */
  marker: string;
}

export const CONTROL_DB_FIXTURE: DatabaseFixture = {
  table: "persistence_fixture_control",
  marker: "control-only-fixture",
};

export const PROJECT_DB_FIXTURE: DatabaseFixture = {
  table: "persistence_fixture_project",
  marker: "project-only-fixture",
};

/**
 * Planted in a SEPARATE, independently-named disposable Compose project
 * that stands in for "another stack on the same daemon" (a second test
 * run, or the developer's own `relis` stack). Resetting the first
 * project must leave this one's volume and row completely intact — that
 * is what makes "the reset removed only its own volumes" a real
 * assertion rather than a vacuous one on a daemon with nothing else on
 * it.
 */
export const BYSTANDER_DB_FIXTURE: DatabaseFixture = {
  table: "persistence_fixture_bystander",
  marker: "bystander-only-fixture",
};

/** The non-production object-storage fixture, uploaded through the real authenticated S3 path. */
export const OBJECT_FIXTURE = {
  bucket: "relis-persistence-fixture",
  key: "persistence-fixture.txt",
  /** Fixed bytes, so a survived object can be compared byte-for-byte rather than merely "exists". */
  body: "relis disposable persistence fixture — synthetic, non-sensitive, safe to destroy\n",
} as const;

export function objectFixtureBody(): Buffer {
  return Buffer.from(OBJECT_FIXTURE.body, "utf8");
}

/**
 * Creates the fixture table and inserts its single marker row.
 * `IF NOT EXISTS` is deliberately omitted: a surviving table from an
 * earlier phase must make this fail loudly rather than be silently
 * reused, since every call site expects to be planting a fresh fixture.
 */
export function createFixtureSql(fixture: DatabaseFixture): string {
  return (
    `CREATE TABLE public.${fixture.table} (id int PRIMARY KEY, marker text NOT NULL); ` +
    `INSERT INTO public.${fixture.table} (id, marker) VALUES (1, '${fixture.marker}');`
  );
}

/** Reads back the marker, or the empty string when the table does not exist at all. */
export function readFixtureMarkerSql(fixture: DatabaseFixture): string {
  return (
    `SELECT CASE WHEN to_regclass('public.${fixture.table}') IS NULL THEN '' ` +
    `ELSE (SELECT marker FROM public.${fixture.table} WHERE id = 1) END;`
  );
}

/** `t` when the fixture table exists in the queried database, `f` when it does not. */
export function fixtureTableExistsSql(fixture: DatabaseFixture): string {
  return `SELECT to_regclass('public.${fixture.table}') IS NOT NULL;`;
}
