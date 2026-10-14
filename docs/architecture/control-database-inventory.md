# `@relis/database` inventory — Control DB schema prerequisite

Local sub-issue: [03.01 — Locate @relis/database in the target
repository](../../../context/notion-tasks/sub-issues/03-01.md), under parent
[03 — Create control Prisma schema](../../../context/notion-tasks/03-control-prisma.md).

> **Superseded for schema content by 03.04.** This document records the
> genuinely **model-free** baseline as it stood for sub-issues 03.01–03.03
> (zero models, zero migrations in `packages/database/prisma/control/`).
> [03.04 — Implement versioned Control schema, migrations and generated
> client](../../../context/notion-tasks/sub-issues/03-04.md) has since
> implemented the approved schema, a committed migration, and a generated
> Control client on top of this same baseline. Everything below about the
> package/workspace/configuration/Compose integration and existing test
> baseline remains accurate; only §3 ("zero models, zero enums, no
> generator block") and §8's "no control-plane entities are modeled" item
> are historical, not current — see
> [`control-database-contracts.md`](control-database-contracts.md) §8 for
> the current per-model data dictionary and 03.04's own completion report
> for the implemented schema.

## 1. Scope and verification method

This document is a bounded inspection deliverable for sub-issue 03.01 only.
It inventories the **existing** `@relis/database` package, its Prisma
structure, its configuration/Compose integration, and its current
consumers/tests, so sub-issues 03.02–03.05 can design and implement the
Control DB schema without recreating existing infrastructure. It does
**not** define entities, add models, write migrations, implement
repositories, or scaffold a new package — all explicitly out of scope for
this slice (see the sub-issue's "Scope" section).

**Verification method:** every finding below was established either by
reading the actual source files in this checkout (labeled
**code-inspected**) or by running a real, non-destructive command recorded
in §7 (labeled **executed**). No migration was run against any real
database, no destructive operation was performed, and no existing Docker
resource was pruned or restarted. Reference material consulted in full
before writing this document: `CLAUDE.md`, `context/project-structure.md`,
`context/stack.yml`, `context/testing-policy.md`, `relis/AGENTS.md`, the
`relis-project-structure` and `relis-stack` skills, this sub-issue's parent
guide, [PENDING-DECISIONS.md](../../../context/notion-tasks/PENDING-DECISIONS.md),
and the prerequisite inventories this document deliberately does not
duplicate: [`local-stack-inventory.md`](local-stack-inventory.md) and
[`docker-compose-stack.md`](docker-compose-stack.md).

## 2. Package and workspace integration

- **Location:** [`packages/database`](../../packages/database) — a single
  package, registered under the `packages/*` glob in
  [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) (code-inspected). No
  second, parallel database package exists anywhere in the checkout
  (confirmed by a repo-wide `schema.prisma` search — only the two files in
  §3 were found).
- **Manifest:** [`packages/database/package.json`](../../packages/database/package.json).
  - `name`: `@relis/database`; `"type": "module"`; no `main`, `exports`, or
    `types` field is declared at all — the package currently has **no
    declared public entry point** for another package to import.
  - Scripts: `typecheck` (`tsc --noEmit`) and `migrate` (`tsx src/migrate.ts`).
    **No `build`, `test`, `lint`, `dev`, or `start` script exists.**
  - Dependencies: `@prisma/adapter-pg`, `@prisma/client`, `@relis/config`
    (workspace), `dotenv`, `pg`. Dev dependencies: `@types/node`,
    `@types/pg`, `prisma`, `tsx`, `typescript`.
- **Source files:** only two TypeScript files exist —
  [`src/index.ts`](../../packages/database/src/index.ts) and
  [`src/migrate.ts`](../../packages/database/src/migrate.ts).
  - `src/index.ts` is a literal `export {};` — an intentionally empty
    export surface. Nothing is exported from the package root today: no
    client, no repository, no type.
  - `src/migrate.ts` is the only implemented behavior (detailed in §4):
    a CLI/library entry point that validates a target's database
    connection string through `@relis/config` before invoking the real
    Prisma CLI.
- **TypeScript configuration:** [`tsconfig.json`](../../packages/database/tsconfig.json)
  extends the shared `tsconfig.base.json`, targets `ES2022` lib, `node`
  types, and includes only `src/**/*.ts`.
- **Prerequisite for its commands:** `migrate.ts` imports
  `ConfigValidationError`, `loadDatabaseConfigForTarget`, `loadEnvFiles`,
  and `resolveRuntimeMode` from `@relis/config`. Like `apps/api`/`apps/web`/
  `apps/worker`'s own `dev`/`start` scripts (not their `build` script —
  see `local-stack-inventory.md` §3.1–3.3), the `migrate` script does
  **not** rebuild `@relis/config` itself (there is no `build` step in
  `packages/database/package.json` at all) — it requires
  `packages/config/dist/` to already exist and be current. In this
  checkout `packages/config/dist/` is already present (code-inspected),
  consistent with the already-completed runtime-config task, but a fresh
  checkout without that build would fail at import time, before any
  configuration validation runs.
- **What is implemented vs. placeholder:** `migrate.ts` is real, exercised
  behavior (§4, §7). `index.ts` is a placeholder in the literal sense —
  valid, intentional, but exporting nothing. There is no placeholder
  *business* code (no stub models, no commented-out schema, no dead
  repository scaffolding) to distinguish from real implementation; the
  package simply does not yet contain that layer.

## 3. Prisma and migration structure

- **Control schema:** [`packages/database/prisma/control/schema.prisma`](../../packages/database/prisma/control/schema.prisma)
  — a `datasource db { provider = "postgresql" }` block and nothing else.
  **Zero models, zero enums, no `generator` block** (confirmed by grepping
  both schema files for `generator` — no match in either). No Prisma
  Client generation is configured yet for either target.
- **Project schema:** [`packages/database/prisma/project/schema.prisma`](../../packages/database/prisma/project/schema.prisma)
  — identical shape: a bare `datasource db` block, zero models, no
  generator.
- **An existing schema file is not an implemented business model.** Both
  files exist only so the Prisma CLI has a valid target to validate
  configuration against and invoke `migrate deploy` on (per both files'
  own header comments); neither defines the control-plane or project-data
  domain this parent issue exists to design.
- **Migration directories do not exist yet.** Neither
  `packages/database/prisma/control/migrations/` nor
  `packages/database/prisma/project/migrations/` exists in this checkout
  (confirmed by directory listing). Each target's
  [`prisma.config.ts`](../../packages/database/prisma/control/prisma.config.ts)
  declares `migrations: { path: "migrations" }`, so a `migrations/`
  directory would be created there once a migration is generated — **an
  executable migration command existing today is not evidence that any
  versioned migration file exists.**
- **Target selection and configuration validated per target:** `migrate.ts`
  takes a `target` argument (`"control" | "project"`, validated by
  `isDatabaseTarget`) and maps it to that target's own
  `prisma.config.ts` path via a `CONFIG_PATH_BY_TARGET` record. Before
  invoking Prisma, it calls `loadDatabaseConfigForTarget(target, env)`
  (from `@relis/config`), which reads **only** that target's own
  variable — `CONTROL_DATABASE_URL` for `"control"`,
  `PROJECT_DATABASE_URL` for `"project"` — never the other one. On a
  validation failure it prints a `ConfigValidationError` diagnostic to
  `stderr` and returns exit code `1` **without ever invoking Prisma**; on
  success it forwards the validated connection string as that same
  target-specific environment variable to a real `prisma migrate deploy
  --config <target's prisma.config.ts>` invocation (shell-free, spawned
  via `node <prisma CLI bin path>`, not a PATH-resolved shell command).
- **Control DB vs. project-runtime boundary:** the Control DB
  (`prisma/control/`) is the single global/control-plane database this
  parent issue is scoped to define (identity, sessions, projects,
  memberships, invitations, drafts, jobs, audit — per the parent card's
  description); the project schema (`prisma/project/`) is the **template**
  schema applied to every isolated per-project runtime database (per its
  own header comment), a separate concern entirely out of this sub-issue's
  and this parent issue's scope. The two targets have independent
  connection-string variables, independent schema files, independent
  (currently nonexistent) migration directories, and are invoked through
  the same `migrate.ts` entry point only by passing a different `target`
  argument — there is no shared schema, shared migration history, or
  shared client between them today.

## 4. Configuration and Compose integration

This section traces entry points and variable consumption only; it does
not duplicate the full configuration/Compose reference already documented
in [`local-stack-inventory.md`](local-stack-inventory.md) (§3.4, §5, §6.1–6.2)
and [`docker-compose-stack.md`](docker-compose-stack.md) (`migrate-control`/
`migrate-project` sections) — consult those for the complete variable
tables, precedence rules, and troubleshooting steps.

- **Native command:** `pnpm --filter @relis/database run migrate <control|project>`
  (working directory `relis/`, or `packages/database/` directly). This
  resolves `CONTROL_DATABASE_URL`/`PROJECT_DATABASE_URL` **natively from
  `process.env`**, loaded via `@relis/config`'s `loadEnvFiles` +
  `resolveRuntimeMode` (reading `.env`/`.env.<mode>` files directly) —
  whatever value is actually present in the environment at invocation
  time, validated as-is.
- **Compose services:** `docker-compose.yml`'s `migrate-control` and
  `migrate-project` services (code-inspected) run the identical command
  (`pnpm --filter @relis/config build && pnpm --filter @relis/database run
  migrate <target>`) inside a container, but **construct** the
  target's connection-string variable rather than passing one through
  directly:
  - `migrate-control`: `CONTROL_DATABASE_URL=postgresql://${POSTGRES_USER:-relis}:${POSTGRES_PASSWORD:-changeme}@postgres:5432/${POSTGRES_DB:-relis_control}`.
  - `migrate-project`: `PROJECT_DATABASE_URL=postgresql://${POSTGRES_USER:-relis}:${POSTGRES_PASSWORD:-changeme}@postgres:5432/${PROJECT_TEST_DB_NAME:-relis_project_example}`.

  This is a distinct mechanism from the native path above: Compose never
  reads a literal `CONTROL_DATABASE_URL`/`PROJECT_DATABASE_URL` line from
  `.env` for these two services — it assembles the URL from `POSTGRES_USER`/
  `POSTGRES_PASSWORD`/`POSTGRES_DB`/`PROJECT_TEST_DB_NAME`, fixed at the
  in-network hostname `postgres:5432`. (`docker-compose-stack.md` §"Database
  URL construction" documents this distinction in full, including why
  editing `CONTROL_DATABASE_URL` directly in `.env` has no effect on these
  two services.)
- **Database initialization vs. migration execution are separate claims.**
  [`docker/postgres/init/01-create-project-test-database.sh`](../../docker/postgres/init/01-create-project-test-database.sh)
  runs once, automatically, via the official Postgres image's
  `docker-entrypoint-initdb.d` mechanism on first container init: it
  creates the `POSTGRES_DB` database (the Control DB target) implicitly
  (image default) and explicitly creates a second database named by
  `PROJECT_TEST_DB_NAME`. **Neither database being created proves a
  migration ever ran against it** — the init script's own header comment
  is explicit that "no schema or tables are created here," since both
  schemas currently define zero models. Conversely, `migrate-control`/
  `migrate-project` exiting `0` proves `prisma migrate deploy` completed
  against an already-initialized database — it does not create the
  database itself (that is Postgres's own init step, which must run
  first; `depends_on: postgres: condition: service_healthy` enforces the
  ordering, not the initialization-vs-migration distinction itself).
- **No real credentials or connection strings are reproduced in this
  document** — only variable names and the (non-secret, default-only)
  shapes already public in `docker-compose.yml` and `.env.example`.

## 5. Existing consumers and tests

- **No consumer imports `@relis/database` as a package.** A repository-wide
  search for `@relis/database` as an **imported module specifier** (as
  opposed to a `package.json` dependency declaration) found no matches
  anywhere in the checkout — not in `apps/api`, `apps/web`, `apps/worker`,
  nor in `tooling/`. This is unsurprising given §2: `index.ts` exports
  nothing, so there is no package-level surface *to* import yet. Every
  actual consumer below reaches `migrate.ts` by direct script/subprocess
  execution instead — distinguished explicitly per consumer:
  - **Relative-path import (in-process):**
    [`tests/integration/runtime-config/migration.test.ts`](../../tests/integration/runtime-config/migration.test.ts)
    imports `runMigrate` directly from `../../../packages/database/src/migrate.ts`
    — a relative file import, not a package import.
  - **pnpm script subprocess:**
    [`tests/integration/docker-compose/config-validation.test.ts`](../../tests/integration/docker-compose/config-validation.test.ts),
    [`dependency-unavailable.test.ts`](../../tests/integration/docker-compose/dependency-unavailable.test.ts), and
    [`stack-smoke.test.ts`](../../tests/integration/docker-compose/stack-smoke.test.ts)
    invoke the `migrate-control`/`migrate-project` Compose services, each of
    which runs `pnpm --filter @relis/database run migrate <target>` inside a
    container — the package's own declared `migrate` script (§2), not a
    package import either.
  - **Direct `tsx` subprocess, bypassing the package script entirely:**
    [`tooling/scripts/deploy.mjs`](../../tooling/scripts/deploy.mjs)'s
    `createMigrateStep(target, env, options)` spawns `tsx` directly
    (`resolveTsxBin()`, resolved from `packages/database`'s own
    `node_modules/tsx`) on the literal path
    `packages/database/src/migrate.ts`, passing `target` as its CLI
    argument — this calls neither the package's `migrate` script (no
    `pnpm --filter` involved) nor an import of any kind. It is a third,
    distinct consumer, detailed immediately below.
- **Deployment consumer — `tooling/scripts/deploy.mjs`:**
  - **Environment resolution:** `validateDeployment(baseEnv, options)`
    resolves `databaseEnv` via `resolveEffectiveEnv(mode, databaseDir,
    baseEnv)` — the same root/package/tier `.env`-file precedence
    `migrate.ts`'s own standalone entry point uses via `loadEnvFiles`/
    `resolveRuntimeMode` (§2), applied independently for the database
    target alongside `apps/api`/`apps/web`/`apps/worker`'s own envs, not a
    duplicated rule. Before any step runs, it validates `databaseEnv` with
    the same `loadDatabaseConfigForTarget("control", databaseEnv)` used
    elsewhere (§3), then forces `databaseEnv.NODE_ENV` to the exact `mode`
    already selected, so `migrate.ts`'s own later env-file re-resolution
    (once `createMigrateStep`'s spawned process starts) can only confirm
    that same mode, never diverge from it.
  - **Invocation conditions:** the control-migration validation
    (`loadDatabaseConfigForTarget("control", databaseEnv)`) runs only when
    `!options.skipMigrate`, and `main()` only pushes
    `createMigrateStep("control", databaseEnv)` onto the step list under
    the same condition (`if (!skipMigrate) { steps.push(...) }`) — passing
    `--skip-migrate` skips both the validation and the invocation together,
    confirmed by
    [`deployment.test.ts`](../../tests/integration/runtime-config/deployment.test.ts)'s
    `"requires CONTROL_DATABASE_URL when the migration step is not
    skipped"` and `"does not require CONTROL_DATABASE_URL when migration is
    explicitly not a selected step"` cases (both in-process, real
    `validateDeployment` calls — no subprocess).
  - **Control-only scope:** `deploy.mjs` only ever constructs
    `createMigrateStep("control", ...)` — no code path in the file calls
    it with `"project"`. The file's own comment is explicit: *"Only the
    control database is migrated automatically here: the project schema
    is applied per-project..., not as a single global deploy step, and is
    out of scope."* This mirrors §3's target-selection mechanism exactly
    (one `migrate.ts` entry point, parameterized by `target`) but exercises
    only one of its two valid values.
  - **Test coverage:**
    [`deployment-env-resolution.test.ts`](../../tests/integration/runtime-config/deployment-env-resolution.test.ts)'s
    `"forwards the exact resolved CONTROL_DATABASE_URL (from a file) to the
    real migration step's first spawn"` case runs `deploy.mjs` as a real
    Node subprocess with a spawn-interceptor preload
    ([`tests/fixtures/runtime-config/spawn-interceptor.cjs`](../../tests/fixtures/runtime-config/spawn-interceptor.cjs))
    that **captures, rather than lets through,** the first spawn call —
    proving `createMigrateStep` produces the exact expected args (containing
    `packages/database/src/migrate.ts`) and env
    (`CONTROL_DATABASE_URL` resolved from a `.env` file) without ever
    actually executing `migrate.ts`'s own process. This is real evidence of
    `deploy.mjs`'s own orchestration wiring, not of `migrate.ts` or Prisma
    executing — the inner spawn is intercepted, not real, for this
    specific case.
- **No typed repositories or raw Prisma access are currently exposed** —
  not because they are hidden, but because `index.ts` exports nothing and
  no `PrismaClient` instantiation exists anywhere in `packages/database/src`.
  There is no interface to invent a gap report around: the consuming
  surface is simply absent today (03.05's scope).
- **What each test file actually proves, and what it does not:**

  | Test file | What it proves (executed evidence, §7) | What it does NOT prove |
  | --- | --- | --- |
  | `runtime-config/migration.test.ts` — 7 in-process cases | Missing/malformed/wrong-target connection strings never reach Prisma (dependency-injected `runPrisma` mock — asserts the *contract*, not real Prisma); a valid string is forwarded verbatim to the correct target's config path; the project target uses its own config path; a downstream nonzero exit is propagated; no secret-looking value leaks into the diagnostic. | Nothing about real Prisma or a real database — these 7 cases mock `runPrisma` entirely. |
  | `runtime-config/migration.test.ts` — 3 real-subprocess cases | A REAL `pnpm --filter @relis/database run migrate control` subprocess: (a) exits nonzero with a safe diagnostic and never reaches Prisma when configuration is missing; (b) genuinely invokes real Prisma tooling — a real `prisma migrate deploy` process — and gets a real `P1001` connection-refused error against a deliberately unreachable loopback port (proof it is real Prisma, not a simulated error); (c) a regression case proving an inherited `RUST_LOG=warn` is stripped from the Prisma subprocess's own environment so its error detail is not swallowed. | No real PostgreSQL server is ever reached or required, and no migration was ever verified to complete successfully — by design, cases (b)/(c) assert *connection-refusal* behavior against an endpoint nothing is listening on, never a live database. This is a real `migrate deploy` invocation, but not evidence that one can succeed. |
  | `docker-compose/config-validation.test.ts` | Via `docker compose run --no-deps` (single disposable container, no stack started): `migrate-control` rejects missing/invalid `CONTROL_DATABASE_URL` before touching Prisma, with no secret leaked on either stream. | Requires Docker; **skipped** in this environment (§7) — reported as a blocker, not a pass. |
  | `docker-compose/dependency-unavailable.test.ts` | Against a real, started-then-stopped `postgres` container: `migrate-control` fails with a genuine connectivity error (`P1001`/`ECONNREFUSED`), distinct from the configuration-validation case above; also proves `apps/api`'s `/ready` does **not** detect the outage (documented gap, not a regression). | Requires Docker; **skipped** in this environment. |
  | `docker-compose/stack-smoke.test.ts` | Against a full disposable Compose stack: `migrate-control`/`migrate-project` both genuinely exit `0` (via `docker inspect`'s real `State.ExitCode`), **and** the Control DB and project-test database are verified as two distinct, isolated databases (a table created in one is absent from the other) — this is real isolation evidence, not merely "two differently-named databases exist." | Does not exercise any business schema (there is none yet) — this proves infrastructure plumbing, not persistence of any control-plane entity. Requires Docker; **skipped** in this environment. |

- **Do not read the above as business-persistence coverage.** Every test
  that currently passes exercises configuration validation, Prisma CLI
  invocation/connectivity, or infrastructure isolation against **model-free**
  schemas. None of it is evidence that any control-plane entity (user,
  project, membership, session, etc.) can be persisted or queried — that
  capability does not exist yet (03.04/03.05's scope).

## 6. Control/project ownership boundaries (summary)

Restated briefly for this document's own completeness; §3–§4 above give the
full evidence:

- **Control DB** (`packages/database/prisma/control/`): the single
  global/control-plane database. This parent issue (03) is scoped to define
  its schema here — identity, sessions, projects, memberships, invitations,
  drafts, jobs, audit (per the parent card, not yet modeled).
- **Project DB** (`packages/database/prisma/project/`): the template schema
  applied to every isolated per-project runtime database, provisioned
  per-project (future scope — guides 16/17), never the same schema,
  migration history, or client as the Control DB.
- Both are reached through the same `migrate.ts` entry point, parameterized
  by `target`; they do not share a schema file, a migrations directory, a
  connection-string variable, or (once implemented) a generated Prisma
  Client.

## 7. Checks executed for this document

All commands below were run from `relis/` (or the stated subdirectory),
non-destructively, against no real/shared database, using only disposable
test fixtures already present in the checkout:

| Command | Working dir | Result |
| --- | --- | --- |
| `pnpm --filter @relis/database typecheck` | `relis/` | Exit 0 — `tsc --noEmit` reports no errors. |
| `npx prisma validate --config prisma/control/prisma.config.ts` (with a placeholder, non-real `CONTROL_DATABASE_URL`, no network reached) | `relis/packages/database` | Exit 0 — `"The schema at prisma\control\schema.prisma is valid"`. Syntax/config validation only; no database connection is made by `prisma validate`. |
| `npx prisma validate --config prisma/project/prisma.config.ts` (same, placeholder `PROJECT_DATABASE_URL`) | `relis/packages/database` | Exit 0 — schema valid. |
| `npx vitest run --config vitest.integration.config.ts tests/integration/runtime-config/migration.test.ts` | `relis/` | **1 file, 10/10 tests passed, 0 failed, 0 skipped.** Real subprocess cases included (no Docker required); no real database touched (see §5 table). |
| `npx vitest run --config vitest.integration.config.ts tests/integration/docker-compose/` | `relis/` | **11 files, 80 passed, 44 skipped, 0 failed** (124 total). The skips are the Docker-gated `describe.runIf`/`skipIf` blocks in config-validation/dependency-unavailable/stack-smoke (§5) — confirmed by this environment's own `docker version` check failing (no daemon reachable). This is a **reported blocker**, not evidence those paths pass; the explicit "is a reported blocker, not executed" placeholder assertions in each file did pass, which is itself the intended, honest signal per those files' own design. |
| Repository-wide search for a second `schema.prisma` or a duplicate `@relis/database`-named package | `relis/` | Only the two files in §3 exist; no parallel package found (AC2 evidence). |
| Repository-wide search for `@relis/database` as an imported specifier in `apps/*` | `relis/` | No matches — confirms §5's "no application consumers" finding. |

**Clarification on `migrate deploy`:** running `migration.test.ts` (above)
does invoke a real `prisma migrate deploy` process twice (its two
real-subprocess connectivity cases, §5) — but only against a deliberately
unreachable loopback endpoint that nothing is listening on, never a live
PostgreSQL server, and never a database this checkout owns or shares. No
successful migration was run or verified by this document's own checks.

Not run, and not required for this inspection-only slice: any `migrate
deploy` invocation against a real, reachable PostgreSQL database (no such
database was started — excluded by this task's safe-execution boundary),
`pnpm build`/`pnpm -r build`, or any full-stack Compose `up` (Docker
unavailable here in any case; §5's Docker-gated test results already
report that honestly).

## 8. Missing capabilities and unresolved decisions (not selected here)

Explicitly out of scope for this sub-issue — named for 03.02–03.05, not
resolved:

- No control-plane entities are modeled (identity, session, project,
  membership, invitation, draft, job, audit) — 03.02's consolidation input,
  03.04's implementation target.
- The `PROJECT_OWNER` vs. `PROJECT_ADMIN` naming/role-model discrepancy
  (see [PENDING-DECISIONS.md](../../../context/notion-tasks/PENDING-DECISIONS.md)
  item 2) is unresolved and blocks finalizing any role enum — 03.03's scope.
- No `migrations/` directory exists for either target — nothing has been
  generated yet because no model exists to generate from — 03.04's scope.
- No `generator` block (and therefore no generated Prisma Client
  configuration) exists in either schema yet — also 03.04's scope, since a
  generator is typically added alongside the first real model.
- No typed repository or use-case interface exists — `index.ts` exports
  nothing — 03.05's scope. Do not expose generic CRUD or raw `PrismaClient`
  access when implementing this (per the parent card's explicit API-behavior
  requirement).
- `packages/contracts` (named as an owning location in the sub-issue's
  "Inputs, outputs, and boundaries") was not inspected in depth here — out
  of this slice's stated inspection scope, which is `@relis/database`
  itself; a later sub-issue consolidating shared contracts should inspect
  it directly rather than relying on this document.

## 9. Handoff checklist for 03.02–03.05

- [ ] **03.02** (consolidate identity/session/project/membership/
      invitation/draft/job/audit requirements): use §6 for the Control DB's
      exact boundary; this document intentionally does not propose any
      entity, field, or relationship — the parent card's Data model is
      empty and the entity list is "a planning input, not an approved
      schema" (sub-issue 03.01's own text).
- [ ] **03.03** (resolve `PROJECT_OWNER`/`PROJECT_ADMIN`): must complete, or
      be explicitly deferred with a recorded decision, before any role
      enum is written in the schema — see §8.
- [ ] **03.04** (implement schema/migrations/client): reuse the existing
      `prisma/control/schema.prisma` and `prisma.config.ts` in place (§3) —
      do not create a second schema file or a new package. Add the first
      `generator` block and the first `migrations/` directory as part of
      this step, not before. The native (`pnpm --filter @relis/database
      run migrate <target>`) and Compose (`migrate-control`/
      `migrate-project`) paths (§4) require no changes to keep working
      once models exist — both already validate configuration and invoke
      `migrate deploy` generically, independent of schema content.
- [ ] **03.05** (expose typed repositories): `src/index.ts`'s current
      `export {};` is the exact file to replace with the approved typed
      surface — confirm no other file needs a parallel export change,
      since no other export path exists today (§2).
- [ ] Any new automated test for business persistence belongs in
      `relis/tests/integration/control-prisma/` per this sub-issue's own
      "Test and evidence plan" (§4 of `sub-issues/03-01.md`); no such
      directory exists yet in this checkout (confirmed alongside §3's
      migrations-directory check) and this document does not create it.

## Acceptance-criteria evidence (for this sub-issue, 03.01)

- **AC1 (resolve the actual database package exports and consumers):** §2
  (exports — `index.ts` is `export {}`, no `main`/`exports` field) and §5
  (consumers — zero package imports anywhere; three direct-execution
  consumers of `migrate.ts` — in-process relative import, Compose's
  `pnpm` script subprocess, and `deploy.mjs`'s direct `tsx` subprocess —
  each with its own test coverage) are both code-inspected and, for the
  test behavior, executed (§7).
- **AC2 (ensure no second parallel database package is introduced):** §7's
  repository-wide search found only the one package and the two schema
  files already documented in §3; nothing was created or duplicated by
  this document.
- **AC3 (every requirement accounted for or explicitly reported as a
  blocker):** §8 lists every remaining gap this sub-issue's own scope
  statement anticipates (entities, role discrepancy, migrations,
  generator, repositories) without implementing any of them; §5's test
  table explicitly separates what is proven from what is not, rather than
  implying broader coverage.
- **AC4 (checks actually run and passed, no hidden failure/skip used as
  coverage):** §7 lists every command executed with its real result,
  including the 44 Docker-gated skips reported honestly as a blocker (not
  silently omitted, and not claimed as a pass) and the explicit
  clarification that the real-subprocess `migrate deploy` invocations
  exercised here never reached a live database — no successful migration
  was run or claimed.
