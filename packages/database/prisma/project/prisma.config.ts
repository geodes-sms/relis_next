import { defineConfig } from "prisma/config";

// PROJECT_DATABASE_URL is resolved and validated by @relis/config's shared
// database contract (see packages/database/src/migrate.ts) before the
// Prisma CLI is ever invoked; it is expected to already be present in
// process.env by that point.
export default defineConfig({
  schema: "schema.prisma",
  migrations: {
    path: "migrations",
  },
  datasource: {
    url: process.env.PROJECT_DATABASE_URL,
  },
});
