# AGENTS.md — NeoReLiS Engineering Guide

## Mission

Build NeoReLiS as a reliable, maintainable, secure systematic-review platform. Favor simple, explicit solutions that fit the existing architecture. Deliver complete vertical slices: UI, API, validation, persistence, tests, and documentation when the feature requires them.

## Working Agreement

- Read the relevant code, configuration, and documentation before editing.
- Preserve existing behavior unless the task explicitly changes it.
- Make the smallest coherent change that fully solves the request.
- Do not invent requirements, APIs, database fields, or business rules. State assumptions and ask when a choice is consequential.
- Do not overwrite or revert unrelated user changes.
- Never commit secrets, `.env` files, credentials, generated builds, dependency folders, or local stores.
- Ask before adding a production dependency, changing a public contract, running a destructive migration, or deleting data.
- Use `pnpm` only. Do not use `npm` or `yarn`.
- Keep the lockfile synchronized when dependencies change.
- Finish by running the relevant checks and reporting what changed, what was verified, and any remaining risk.

## Current Stack

- Runtime: Node.js 22+
- Package manager: pnpm workspaces
- Language: TypeScript with strict type checking
- Web: Next.js App Router, React, Tailwind CSS
- API: Hono on `@hono/node-server`
- Worker: Node.js, `pg-boss`
- Database: PostgreSQL, Prisma with the PostgreSQL driver adapter
- Validation and shared contracts: Zod
- Tests: Vitest; use the existing framework-specific tooling where already configured

Do not replace a current technology or introduce a competing framework without explicit approval.

## Target Repository Architecture

```text
.
├── AGENTS.md
├── apps/
│   ├── web/
│   │   ├── public/
│   │   └── src/
│   │       ├── app/                 # Routes, layouts, loading/error states
│   │       ├── components/
│   │       │   ├── ui/              # Reusable presentation primitives
│   │       │   └── features/        # Feature-specific composed components
│   │       ├── hooks/               # Reusable client hooks only
│   │       ├── lib/                 # API client, utilities, configuration
│   │       └── types/               # Web-only types
│   ├── api/
│   │   └── src/
│   │       ├── index.ts             # Process entry point only
│   │       ├── app.ts               # Hono app composition
│   │       ├── routes/              # Thin HTTP route handlers
│   │       ├── middleware/          # Auth, errors, logging, request context
│   │       ├── services/            # Business use cases
│   │       ├── repositories/        # Persistence access when needed
│   │       ├── config/              # Validated runtime configuration
│   │       └── lib/                 # API-only helpers
│   └── worker/
│       └── src/
│           ├── main.ts              # Worker entry point only
│           ├── jobs/                 # One handler per background job
│           ├── queues/               # Queue registration and dispatch
│           ├── services/             # Worker-specific orchestration
│           └── config/               # Validated runtime configuration
├── packages/
│   ├── contracts/
│   │   └── src/
│   │       ├── schemas/              # Shared Zod request/response schemas
│   │       ├── types/                # Types inferred from schemas
│   │       └── index.ts              # Deliberate public exports
│   └── database/
│       ├── prisma/
│       │   ├── control/              # Control-plane Prisma schema/migrations
│       │   └── project/              # Project-data Prisma schema/migrations
│       └── src/
│           ├── clients/              # Prisma client construction/lifecycle
│           ├── repositories/         # Shared persistence implementations
│           └── index.ts              # Deliberate public exports
├── docs/                              # Architecture and operational decisions
├── tooling/                           # Shared development configuration/scripts
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

Create directories only when a real feature needs them. Do not add empty placeholder files merely to reproduce this tree.

## Architecture Boundaries

- `apps/web` owns rendering and browser interaction. It must not access PostgreSQL or Prisma directly.
- `apps/api` owns synchronous HTTP use cases and authorization enforcement.
- `apps/worker` owns asynchronous and retryable work. Job handlers must be idempotent whenever practical.
- `packages/contracts` owns schemas shared across process boundaries. Infer TypeScript types from Zod schemas rather than duplicating interfaces.
- `packages/database` owns database clients and persistence primitives. Keep Prisma details out of UI code and HTTP presentation code.
- Routes validate input, call a service, and map the result to HTTP. Business logic belongs in services, not route handlers or React components.
- Do not create circular dependencies. Applications may depend on packages; packages must not depend on applications.
- Use package public exports. Avoid reaching into another package's private internal paths.
- Keep control-plane and project-data schemas, migrations, clients, and connection handling explicitly separated.

## TypeScript Standards

- Keep strict mode enabled. Do not weaken compiler or lint rules to make code pass.
- Avoid `any`. Use `unknown` at untrusted boundaries and narrow it safely.
- Validate all external input: HTTP parameters, bodies, environment variables, job payloads, and database-derived JSON.
- Prefer small, named types and discriminated unions for state.
- Prefer type inference locally; add explicit types at public boundaries.
- Use `import type` for type-only imports.
- Prefer named exports for reusable modules. Default exports are acceptable where Next.js requires or conventionally expects them.
- Avoid non-null assertions and unsafe type casts. If a cast is unavoidable, keep it narrow and explain why.
- Use `async`/`await`; handle promise failures intentionally. Never leave floating promises.
- Keep functions focused and use early returns to reduce nesting.
- Use clear domain names. Avoid vague names such as `data`, `item`, `manager`, or `utils` when a precise name exists.
- Remove dead code, commented-out implementations, debug logging, and unused exports.

## React and Next.js Standards

- Use the App Router conventions already present in `apps/web/src/app`.
- Prefer React Server Components. Add `"use client"` only when browser APIs, local interactive state, effects, or event handlers require it.
- Keep client components as small and low in the tree as possible.
- Never use `useEffect` for derived state. Compute derived values during render or with memoization only when measurement proves it useful.
- Keep data fetching close to the server boundary when possible. Browser-side fetching is appropriate for live interaction, polling, or client-only state.
- Model loading, empty, error, and success states explicitly.
- Use semantic HTML, visible focus states, keyboard support, associated labels, and meaningful accessible names.
- Do not suppress hydration warnings or accessibility warnings instead of fixing their cause.
- Use Next.js primitives such as `Link` and `Image` when appropriate.
- Keep feature behavior near the feature. Promote code to shared components or hooks only after genuine reuse appears.
- Avoid oversized components. Extract a component when it has a distinct responsibility, meaningful reuse, or independently testable behavior.
- Do not introduce a global state library unless local state, URL state, server state, and React context are demonstrably insufficient.

## Styling and Tailwind CSS

- Use Tailwind CSS utilities as the default and primary styling system.
- Preserve the existing design tokens and visual language before introducing new ones.
- Build responsive layouts mobile-first.
- Prefer reusable React components over repeated long class strings.
- Use a class composition helper already present in the repository; do not add one without approval.
- Do not use inline `style` attributes except for truly dynamic values that Tailwind cannot express cleanly.
- Do not create CSS modules, styled-components, Sass, or another styling system.
- Add custom CSS only when strictly necessary, such as global tokens/reset rules, a browser limitation, third-party integration, or an animation that Tailwind cannot reasonably express.
- Before adding custom CSS, verify that Tailwind utilities, arbitrary values, variants, and theme tokens cannot solve the need.
- Keep unavoidable custom CSS minimal, colocated or documented, and free of component-specific duplication.
- Do not use `!important` unless required to override third-party styles; document the reason.
- Avoid arbitrary one-off colors and spacing when a theme token is suitable.

## API and Node.js Standards

- Keep `src/index.ts` limited to configuration loading, dependency construction, server startup, and graceful shutdown.
- Compose Hono routes in `app.ts` or route modules; do not let the entry point become the application.
- Validate requests and responses with schemas from `@relis/contracts` where the contract is shared.
- Return consistent JSON envelopes and appropriate HTTP status codes.
- Centralize error mapping. Do not expose stack traces, SQL details, credentials, or internal exception messages to clients.
- Treat authentication and authorization as separate checks. Enforce authorization server-side for every protected resource.
- Pass dependencies explicitly where practical so services can be tested without starting a server.
- Add timeouts and cancellation to outbound network calls.
- Use structured logging with useful context. Never log passwords, tokens, cookies, full sensitive payloads, or connection strings.
- Handle `SIGINT` and `SIGTERM` when the process owns long-lived resources.
- Keep CORS origins configuration-driven outside local development; never use unrestricted CORS for authenticated endpoints.

## Database and Prisma Standards

- Access Prisma through `@relis/database`; do not instantiate clients throughout the codebase.
- Reuse clients and close them during process shutdown. Do not create a client per request.
- Keep transactions short and explicit.
- Select only required fields for large or sensitive records.
- Prevent N+1 query patterns and unbounded list queries. Paginate collection endpoints.
- Add indexes and constraints based on actual access patterns and invariants.
- Use migrations for schema changes. Never edit an already-applied migration.
- Review generated SQL before applying a migration.
- Never run destructive migrations, resets, or production data changes without explicit confirmation and a recovery plan.
- Preserve the boundary between `control` and `project` databases. Never silently route one domain through the other's client.

## Worker and Job Standards

- Define and validate every job payload with Zod.
- Give jobs stable names and explicit versioning when payload compatibility may change.
- Make handlers idempotent or protect side effects with a deduplication strategy.
- Classify failures as retryable or permanent. Do not retry invalid input indefinitely.
- Configure bounded retries and backoff; log the job identifier and attempt without sensitive content.
- Keep queue registration separate from handler business logic.
- Support graceful shutdown so active work is not abandoned abruptly.

## Security and Privacy

- Assume project and review data may be sensitive.
- Follow least privilege for database access, API permissions, and service credentials.
- Store secrets only in environment variables or an approved secret manager.
- Provide safe `.env.example` placeholders; never include real values.
- Validate and normalize user-controlled filenames, URLs, identifiers, filters, and pagination values.
- Use parameterized database access through Prisma or the approved driver. Never concatenate SQL with untrusted input.
- Protect state-changing endpoints against unauthorized requests and browser-origin attacks as applicable.
- Avoid rendering unsanitized HTML. Do not use `dangerouslySetInnerHTML` without an approved sanitization strategy.
- Do not expose whether a protected resource exists when the caller lacks permission.

## Legacy Migration and Specification Traceability

NeoReLiS is a modernization of the open-source legacy ReLiS application:

https://github.com/geodes-sms/relis

Migration features are specified primarily through the approved Notion feature
specifications. These specifications may describe the legacy behavior, intended
NeoReLiS behavior, permissions, UI behavior, API behavior, data ownership, and
acceptance criteria.

Treat the approved feature specification as the source of truth for the intended
behavior. Use the legacy repository, DSL examples, documentation, and tests as
supporting evidence for understanding historical behavior and discovering
undocumented edge cases.

Do not reproduce legacy implementation details merely because they exist. The goal
is preservation or deliberate evolution of domain capabilities, not UI, code, or
architecture parity.

Before implementing a migrated feature:

1. Read the complete approved feature specification.
2. Identify every stated business rule, permission rule, lifecycle condition,
   data-ownership boundary, and acceptance criterion.
3. Inspect the relevant legacy implementation when the specification references
   legacy behavior, leaves an ambiguity, or may omit an important edge case.
4. Map each acceptance criterion to one or more automated tests.
5. Report any undocumented difference between the specification and the legacy
   behavior before deciding whether to preserve or remove it.

Tests must validate the intended business outcomes described by the specification,
including meaningful negative cases. A rendered page or successful form submission
alone is not sufficient proof that a migrated feature is complete.

For every migrated feature, maintain traceability between:

- the approved specification or acceptance criterion;
- the relevant legacy evidence when applicable;
- the NeoReLiS implementation;
- the automated tests proving the behavior.

This traceability may live in the feature specification, implementation plan, pull
request, or a dedicated migration document. Do not create duplicate documentation
when the existing specification already contains the required information.

Do not commit deliberately failing tests to represent missing parity. If an
acceptance criterion cannot be satisfied, mark the feature as incomplete and
document the gap in the specification or its tracked issue.

A migrated feature is complete only when every applicable acceptance criterion has
passing coverage or an explicit approved decision explains why it was changed,
deferred, or removed.

## Testing Standards

- Add or update tests for changed behavior, not implementation details.
- Prefer the smallest useful test level: pure unit tests for domain logic, integration tests for routes/repositories.
- Cover the happy path, validation failures, authorization failures, and meaningful edge cases.
- Tests must be deterministic and isolated. Do not depend on execution order, wall-clock timing, or external network services.
- Mock process boundaries, not every internal function.
- A bug fix should include a regression test when feasible.
- Do not delete, skip, or weaken a failing test merely to make CI pass.

## Commands and Verification

Run commands from the repository root. Prefer scoped checks while iterating, then run all checks affected by the change.

```bash
pnpm install --frozen-lockfile

pnpm --filter "./apps/web" lint
pnpm --filter "./apps/web" build

pnpm --filter "./apps/api" build

pnpm --filter @relis/worker typecheck
pnpm --filter @relis/worker build
pnpm --filter @relis/worker test

pnpm --filter @relis/contracts typecheck
pnpm --filter @relis/contracts test

pnpm --filter @relis/database typecheck
```

- Run the checks relevant to every package touched.
- If a script is not yet defined, do not claim it passed. Add it only when doing so is in scope.
- When changing a cross-package contract, verify its producers and consumers.
- Once the Prisma schemas exist, validate each changed `control` or `project` schema with its explicit configuration.
- When changing the full-stack smoke path, start the API and web app and verify `GET /health` plus the rendered UI.
- Before finishing, inspect `git diff` and `git status --short` for accidental generated files or secrets.

## Dependency Policy

- Prefer platform APIs and existing dependencies.
- Before proposing a new dependency, check maintenance, license, security posture, bundle/runtime cost, and whether the repository already solves the need.
- Ask for approval before adding a production dependency.
- Add dependencies to the narrowest owning workspace with `pnpm --filter`.
- Do not manually edit the lockfile.

## Documentation and Decisions

- Update documentation when setup, environment variables, public contracts, commands, architecture, or operational behavior changes.
- Record consequential architecture decisions in `docs/` with context, decision, alternatives, and consequences.
- Comments should explain why, constraints, or non-obvious behavior—not restate the code.
- Keep examples runnable and synchronized with the implementation.

## Code Review Rules

Flag these as blocking unless there is an explicit, documented exception:

- Unvalidated external input or unsafe TypeScript casts at a boundary.
- Authentication without resource-level authorization.
- Secrets, personal data, tokens, or connection strings in code or logs.
- Direct database access from `apps/web` or Prisma usage outside the database boundary.
- Business logic embedded in React components, route handlers, or process entry points.
- A shared request/response type duplicated instead of derived from `@relis/contracts`.
- Mixing control-plane and project-data clients or migrations.
- Unbounded queries, obvious N+1 access, or destructive migrations without a recovery plan.
- Client components that could remain server components.
- Custom CSS when Tailwind expresses the same design cleanly.
- New production dependencies without explicit approval.
- Behavior changes without relevant tests or verification.
- Suppressed errors, ignored promises, or logs containing sensitive information.

## Definition of Done

A task is complete only when:

- The requested behavior works end to end.
- Architectural boundaries remain intact.
- External inputs and configuration are validated.
- Loading, error, empty, and success states are handled where relevant.
- Accessibility and responsive behavior were considered for UI changes.
- Relevant tests, type checks, lint, and builds pass.
- Documentation and `.env.example` are updated when needed.
- No secrets, generated artifacts, unrelated edits, or debug code are included.
- The final report names changed areas, commands run, results, and any verification that could not be performed.
