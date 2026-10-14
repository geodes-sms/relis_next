// Canonical project role enum — user-approved in
// docs/architecture/control-database-role-decision.md §3.1/§4.
// `PROJECT_OWNER` replaces guide 15's `PROJECT_ADMIN`; it is not an
// additional sixth value.
//
// Declared as a plain string-literal union, NOT re-exported from the
// generated Prisma client's own enum — the values are identical by
// construction (this is the single source of truth the Prisma schema's
// `ProjectRole` enum also uses), but keeping this package's PUBLIC type
// declarations free of any import from `../../generated/control-client`
// is what lets src/index.ts avoid pulling Prisma-specific types into a
// consumer's type-checking surface at all.
export type ProjectRole = "PROJECT_OWNER" | "PROJECT_MANAGER" | "REVIEWER" | "VALIDATOR" | "GUEST";

export const PROJECT_ROLES = ["PROJECT_OWNER", "PROJECT_MANAGER", "REVIEWER", "VALIDATOR", "GUEST"] as const satisfies readonly ProjectRole[];
