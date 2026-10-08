# relis_next
New version of ReLiS 2.0 using Node.js, React, Prisma, Typescript

## Runtime configuration

Every process (`apps/api`, `apps/web`, `apps/worker`) loads its environment
through the shared, typed contract in `packages/config` (`@relis/config`,
built with Zod). No process parses `process.env` on its own: each entry
point calls a `load*Config()` function before doing anything else, and a
missing or invalid **required** value makes that process exit non-zero
before it opens a listener, connects to anything, or writes data. A
value that has a documented safe default is used only when the variable is
absent or empty; a *supplied* invalid value is always rejected, never
silently replaced by the default.

Copy `.env.example` to `.env` (or `.env.local`) and adjust as needed. All
values in `.env.example` are placeholders.

### Variables

| Variable | Owning process(es) | Category | Public/secret | Required/default |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | api, worker, web (wrapper) | runtime | public | Optional; defaults to `development`. Must be `development`, `test`, or `production`. |
| `API_PORT` | api, deployment | network | public | Optional; defaults to `3001`. Integer, 1–65535. |
| `API_HOST` | api | network | public | Optional; defaults to `0.0.0.0`. Must be a bare hostname or IP — no scheme, credentials, path, or port. IPv4/IPv6 structure is validated with Node's own `net.isIP` (not a hand-rolled regular expression), so a malformed address like `::::`, `1:2`, or `12345::1` is rejected. |
| `API_CORS_ORIGIN` | api | cors | public | Optional; defaults to `http://localhost:3000`. Must be one explicit `http(s)` origin (protocol + host [+ port], no path, no credentials, never `*`). |
| `WEB_PORT` | web, deployment | network | public | Optional; defaults to `3000`. Integer, 1–65535. Distinct from `API_PORT` so both services can run together. |
| `NEXT_PUBLIC_API_URL` | web (browser) | public | public | Optional; defaults to `http://localhost:3001`. Must be an `http(s)` URL with no embedded username/password. |
| `CONTROL_DATABASE_URL` | migration (control target), deployment | database | **secret** | Required whenever the control migration step runs (`packages/database`'s migrate command, or deployment unless `--skip-migrate`). Must be a `postgres://`/`postgresql://` connection string. |
| `PROJECT_DATABASE_URL` | migration (project target) | database | **secret** | Required only when migrating the `project` target directly; no automated process supplies this today (see "Migration" below). Same connection-string format as `CONTROL_DATABASE_URL`. |

Background-job (`pg-boss` vs. `BullMQ`) configuration is intentionally
**not** part of this contract: that stack choice is still undecided
(`context/stack.yml`), and `apps/worker` does not connect to a queue today.
A dependency being present in `package.json` does not make its
configuration required.

`CONTROL_DATABASE_URL` and `PROJECT_DATABASE_URL` both validate through the
same underlying schema (`packages/config`'s `databaseConfigSchema` — not
duplicated per target); only the environment variable name consulted, and
the process/variable names used in a rejection diagnostic, differ per
target.

### Environment loading and override precedence

Server-side processes (api, worker, and the web wrapper script) load
`.env` files themselves, before reading `process.env`, from **two
locations**: the owning package directory (e.g. `apps/api`) and the
application root (the pnpm workspace root — found by walking up from the
package directory to the nearest `pnpm-workspace.yaml`, i.e. `relis/`
itself). This resolves the discrepancy between a single documented root
`.env` and a loader that only searched the current package: a shared root
`.env` and a package-specific override now both take effect.

Precedence (highest first; an already-set value always wins, and dotenv
never overrides an already-set `process.env` value):

1. Real OS/shell environment variables (e.g. set by your shell or a
   process manager) — always wins over every file, in either location.
2. `apps/<app>/.env.<mode>.local`
3. `relis/.env.<mode>.local`
4. `apps/<app>/.env.local` (skipped when `NODE_ENV=test`)
5. `relis/.env.local` (skipped when `NODE_ENV=test`)
6. `apps/<app>/.env.<mode>`
7. `relis/.env.<mode>`
8. `apps/<app>/.env`
9. `relis/.env`

In other words: for a given tier (`.env.<mode>.local`, `.env.local`,
`.env.<mode>`, `.env`), the package directory's file wins over the
workspace root's file at that same tier — the root file is a shared
default, the package file is its explicit override.

Test mode (`NODE_ENV=test`) matches installed Next.js behavior exactly:
only the generic `.env.local` is skipped (so tests produce the same
results regardless of a developer's local overrides); `.env.test.local`
is still loaded (tier 2/3 above), ahead of `.env.test` and `.env`.

`<mode>` is `development`, `test`, or `production`, resolved from
`NODE_ENV`. An **absent** `NODE_ENV` falls back to a per-command default:
`development` for `next dev`, `production` for `next build`/`next start`
(a production artifact/server, previously incorrectly defaulted to
`development` for `start`) and for `apps/api`/`apps/worker`. An
**explicit, valid** `NODE_ENV` (`development`, `test`, or `production`)
always wins over that default. `apps/web`'s wrapper (`scripts/run.mjs`)
additionally **rejects** an explicit but invalid or empty `NODE_ENV`
outright (instead of silently coercing it to a default and then
forwarding the bad value to the spawned Next.js process unexamined),
before Next.js is ever spawned.

Since a `.env` file is not special-cased and can set `NODE_ENV` like any
other variable, the wrapper re-validates the *effective* value a second
time, after loading files: the mode used to pick which `.env.<mode>` tier
to load and the mode ultimately forwarded to Next must be identical. A
file introducing a well-formed but **different** mode than the one already
selected (e.g. `next start` selects and loads `production`-tier files,
then a file sets `NODE_ENV=development`) is rejected too, not silently
switched to — Next never receives a mode different from the one whose
files were actually loaded.

Two applications resolve their environments **independently**: apps/api's
resolution never mutates a shared value that apps/web's resolution would
otherwise see (and vice versa). Each of `loadEnvFiles` (the mutating,
single-process form used by an app's own entry point) and
`resolveEffectiveEnv` (the pure form, returning a plain object without
touching `process.env`, used by the `check-ports` command below to resolve
apps/api's and apps/web's environments from the same starting snapshot)
apply the same root/package/tier precedence.

Every loaded file also expands `$VAR` and `${VAR}` references (e.g.
`API_CORS_ORIGIN=http://${WEB_HOSTNAME}:${WEB_PORT}`), matching Next.js's
own environment-loading behavior, once cross-file precedence has already
been resolved — so a package-level override can reference a root-level
base value, or vice versa, regardless of which file happened to load
first. Expansion is **deterministic and chain-aware**: `C=${B}`, `B=${A}`,
`A=resolved` resolves `C` to `"resolved"` no matter which order the three
are declared in (each reference is resolved on demand and memoized,
recursively, rather than in a single left-to-right pass). A direct or
indirect cycle (e.g. `A=${B}`, `B=${A}`) is detected and rejected with a
safe `CONFIG_INVALID` diagnostic naming only the variable — never a value —
instead of recursing forever or leaving a partially-expanded value
assigned. `\$VAR`/`\${VAR}` escapes to a literal `$VAR`/`${VAR}`; an
unresolved reference expands to an empty string. This expansion is
implemented directly in `packages/config`, not via the third-party
`dotenv-expand` package: when it was evaluated for this purpose, `pnpm add`
resolved a release tagged `1000.0.0` whose installed bundle contained
hash/cipher-related code unrelated to environment-variable expansion. That
combination — an unusual version number plus unrelated code — was treated
as reason enough not to adopt the dependency; it was removed immediately
and was not investigated further (in particular, not reinstalled or
executed) beyond inspecting the installed files. This is an observed
anomaly, not a confirmed finding that the package or its registry account
was compromised — no such determination was made or attempted.

### Build-time vs. runtime configuration

- `NEXT_PUBLIC_API_URL` is **build-time, public** configuration: Next.js
  inlines it as a literal string into the client JavaScript bundle when you
  run `next build` (or on each request in `next dev`). Changing it in the
  runtime environment of an already-built app has **no effect** on that
  build's output — you must rebuild. The literal
  `process.env.NEXT_PUBLIC_API_URL` reference lives in
  `apps/web/src/shared/lib/config.ts` specifically so Next's static replacement
  keeps working; `@relis/config`'s own schemas never read `process.env`
  themselves for this reason.
- `WEB_PORT`, `API_PORT`, `API_HOST`, `API_CORS_ORIGIN`, and `NODE_ENV` are
  **runtime** configuration: they only affect the running process, are
  never baked into a build, and can differ between `dev`/`start` runs of
  the same build.
- `next build` therefore does not require `WEB_PORT` (no listener opens
  during a build); `next dev`/`next start` do.

### Diagnostics: liveness vs. readiness

`apps/api` exposes:

- `GET /health` — liveness. Unchanged response shape
  (`{ status, message, service }`), used by the existing web page.
- `GET /ready` — readiness. Reports only the configuration categories this
  process actually initializes (`network`, `cors`) as `"ok"`; it never
  claims a database or queue check, because `apps/api` has neither
  integrated today.

Every diagnostic (failed startup validation, `/ready`, and the standalone
`relis-config` CLI below) reports only a stable `code`, the affected
configuration `categories`, and (for non-secret cases) variable **names**.
Submitted values, secrets, connection strings, and raw validation-library
error text are never included, anywhere.

### Real commands vs. missing integrations

| Process | Entry point / command | Shared validator | Validates before? |
| --- | --- | --- | --- |
| `apps/api` | `apps/api/src/main.ts` — `pnpm --filter "./apps/api" dev\|build\|start` | `loadApiConfig` | `serve()` — no listener opens on invalid config. |
| `apps/web` | `apps/web/scripts/run.mjs` — `pnpm --filter "./apps/web" dev\|build\|start` | `loadWebRuntimeConfig`, `parsePublicWebConfig`, `validateConsistentRuntimeMode` | Spawning `next` — a bad value never reaches Next.js or opens a listener. |
| `apps/worker` | `apps/worker/src/main.ts` — `pnpm --filter @relis/worker dev\|start` | `loadWorkerConfig` | Its existing log-and-exit behavior. |
| Migration | `packages/database/src/migrate.ts` — `pnpm --filter @relis/database run migrate <control\|project>` | `loadDatabaseConfigForTarget` | Initializing any database client or invoking `prisma migrate deploy` — see "Migration" below. |
| Deployment | `tooling/scripts/deploy.mjs` — `node tooling/scripts/deploy.mjs [--skip-migrate] [--skip-build] [--skip-worker]` | `loadApiConfig`, `loadWebRuntimeConfig`, `loadWorkerConfig`, `checkPortConflicts`, `loadDatabaseConfigForTarget` | Every build, migration, and service start — see "Deployment" below. |

You can check any process's configuration manually without starting it:

```bash
pnpm --filter @relis/config build
node packages/config/dist/cli.js check api
node packages/config/dist/cli.js check worker
node packages/config/dist/cli.js check web
node packages/config/dist/cli.js check database                    # generic single DATABASE_URL check
node packages/config/dist/cli.js check database --target control   # CONTROL_DATABASE_URL
node packages/config/dist/cli.js check database --target project   # PROJECT_DATABASE_URL
```

The root `dev` script also runs `node packages/config/dist/cli.js check-ports`
before starting `apps/api` and `apps/web` together, rejecting a startup
where both would listen on the same effective port. This resolves each
application's environment independently (see "Environment loading" above)
and only then compares the two validated ports — neither app's own schema
is made aware of the other's port, and this is a single check, not a
deployment orchestrator.

This `relis-config` CLI is useful on its own, but it is not proof that any
process calls it automatically — see the table above for what is actually
wired in.

### Migration

```bash
pnpm --filter @relis/database run migrate control    # packages/database/prisma/control/
pnpm --filter @relis/database run migrate project     # packages/database/prisma/project/
```

`packages/database/src/migrate.ts` validates the target's connection
string (`CONTROL_DATABASE_URL` or `PROJECT_DATABASE_URL`, via the shared
`loadDatabaseConfigForTarget` — the same schema as the generic `database`
check, not a duplicated rule) **before** initializing any database client
or invoking Prisma at all. On invalid or missing configuration it exits
non-zero with a safe diagnostic and never runs `prisma migrate deploy`. On
valid configuration it invokes the real Prisma CLI (already a
`packages/database` dependency; resolved and spawned directly, shell-free)
with `migrate deploy --config <target>/prisma.config.ts`, and propagates
Prisma's own exit code.

**Supported scope, honestly:** neither `prisma/control/schema.prisma` nor
`prisma/project/schema.prisma` defines a single model — no control-plane
or project-data domain has been authorized for implementation. This is a
real, runnable migration command for the (currently empty) schemas that
exist, not a stand-in for a future business schema. `control` is the
single global control database; `project` is the schema template applied
to every per-project database, but this command migrates *one* connection
string you supply — it does not discover, provision, or loop over
projects. Per-project provisioning/migration orchestration is a separate,
unauthorized-here effort (see `context/notion-tasks/16-project-template.md`
and `17-project-resolver.md`).

Prisma 7 reads the connection URL from `prisma.config.ts` (not from
`url = env(...)` in `schema.prisma`, which Prisma 7 rejects), so each
target has its own `prisma/<target>/prisma.config.ts` reading
`process.env.<TARGET>_DATABASE_URL` — populated by `migrate.ts` with the
already-validated value before Prisma is spawned, so Prisma always
receives exactly the value that was checked.

### Deployment

```bash
node tooling/scripts/deploy.mjs                  # validate, migrate (control), build, run worker once, start & supervise api+web
node tooling/scripts/deploy.mjs --skip-migrate   # skip the migration step (and its CONTROL_DATABASE_URL requirement)
node tooling/scripts/deploy.mjs --skip-build     # reuse already-built dist/.next output
node tooling/scripts/deploy.mjs --skip-worker    # skip running apps/worker's one-shot step
```

`tooling/scripts/deploy.mjs` is a minimal local orchestrator: plain Node
`child_process` supervision — no Docker, no CI/CD, no new orchestration
technology. It is independent of, and not superseded by, the Docker
Compose stack described below — both exist, for different purposes.

Steps, in order, each gated on every earlier one succeeding:

1. **Validate** — resolves apps/api's, apps/web's, apps/worker's, AND the
   control database's (`packages/database`) effective environments
   *independently* (same pattern as `check-ports`: from the same base
   snapshot, using the same root/package/tier env-file precedence the
   standalone entry points themselves use — never reading
   `CONTROL_DATABASE_URL` directly off raw `process.env`, which would
   silently ignore a `.env` file the standalone `migrate` command would
   otherwise have honored). Validates each with its own existing schema,
   enforces apps/web's NODE_ENV-consistency rule (the same one
   `apps/web/scripts/run.mjs` enforces on itself) so an invalid, empty, or
   conflicting file-provided web `NODE_ENV` is rejected here too, and
   checks for an api/web port conflict — all before any build, migration,
   or service starts. Every resolved environment has its `NODE_ENV`
   explicitly forced to the exact mode selected here, so a downstream
   entry point's own (lenient) re-resolution can only ever confirm that
   same mode, never silently diverge to a different one. Any
   resolution or validation failure — never a raw exception or value —
   exits non-zero with a safe diagnostic and skips every later step.
2. **Migrate** (skippable) — runs the `control` migration above, passed
   the EXACT validated database environment from step 1 unchanged (never
   re-reading `process.env`).
3. **Build** (skippable) — `pnpm --filter` builds for api, worker, and web,
   web's using its own resolved environment so `NEXT_PUBLIC_*` values are
   inlined from the right source, distinct from runtime secrets.
4. **Worker** (skippable) — runs `apps/worker/dist/main.js` once to
   completion. apps/worker currently only logs its own startup and exits
   (no queue consumer exists — background-job technology is still
   undecided); it is a completing step here, not a supervised long-running
   service, precisely because that exit is normal and must not be treated
   as a failure. When a real queue consumer exists, it belongs in step 5
   instead.
5. **Start & supervise** — spawns `apps/api` and `apps/web` (`start`) as
   long-running children, each with the exact environment object already
   validated in step 1 (not re-resolved). Lifecycle guarantees:
   - If either fails to spawn or exits unexpectedly, every other running
     service — AND everything it owns (e.g. apps/web's wrapper and the
     Next.js child it spawns) — is terminated, and the process only exits
     non-zero once every one of them is CONFIRMED to have actually
     stopped (not merely "asked to").
   - Termination always runs a platform-appropriate, PID-targeted
     tree-kill (Windows: `taskkill /PID <pid> /T /F`; POSIX: signals the
     process group a service was spawned as the leader of) — never a
     broad or name-based process lookup, so nothing outside the exact
     services this run spawned is ever touched. On Windows this runs
     before any cooperative signal, since a plain signal there terminates
     the direct child immediately (regardless of any handler it
     registered) and would otherwise make its own children impossible to
     find afterward; on POSIX a cooperative group signal is tried first,
     with the forceful tree-kill as a bounded fallback.
   - `apps/web/scripts/run.mjs` itself also forwards `SIGINT`/`SIGTERM` to
     its own Next.js child and waits for it (with its own bounded
     escalation to `SIGKILL`), so it never orphans that child even when
     invoked directly (`pnpm dev`, Ctrl+C) rather than through this
     supervisor.
   - `SIGINT`/`SIGTERM` sent to this deployment process itself trigger the
     identical termination-and-wait sequence for every service, then exit
     0 once all have stopped.

A failed step (2–4) stops the sequence immediately, propagates that step's
exit code, and never reaches a later step or step 5.

**Limitations:** this entry point only migrates and serves a single
environment's worth of configuration (no multi-project fan-out); it does
not build or push container images; it does not implement health-check
gating, rolling restarts, or zero-downtime deploys; and it has only been
exercised here against isolated fixtures, deliberately-invalid
configuration, and harmless local test fixtures standing in for services —
never a real database, a real deployment target, or a real application
service under supervision.

### Docker Compose (local stack)

```bash
cp .env.example .env   # once, if not already done
docker compose up --build
```

Starts all seven required local-development responsibilities as real
processes/containers: `web`, `api`, `worker` (dev/watch mode, not a job
processor), `postgres` (Control DB + a disposable project-test database),
`nginx` (the only published entry point), `storage` (SeaweedFS's
S3-compatible endpoint), and `mailhog` (mail capture). Open
`http://localhost:8080/` for the app; `/api/health` and `/api/ready` are
reachable through the same proxy. `docker compose down` (add `--volumes`
to also drop the disposable database/storage volumes) shuts it down.

Full service graph, address types (internal/host-facing/browser-public),
database-isolation details, and — importantly — this stack's **known
limitations** (no queue consumer, no storage/mail application adapter)
are documented in
[docs/architecture/docker-compose-stack.md](docs/architecture/docker-compose-stack.md).
Read that before relying on this stack for anything beyond local
iteration.

`pnpm run test:integration` exercises the stack with real, disposable
Compose projects (`tests/integration/docker-compose/`); `pnpm run
test:e2e` additionally verifies the frontend's own browser-issued health
request through the proxy with a real Chromium instance
(`tests/e2e/docker-compose/`, via Playwright — requires its browser
binary installed with `pnpm exec playwright install chromium`, not run
automatically). Both require Docker; see
[docs/architecture/docker-compose-stack.md](docs/architecture/docker-compose-stack.md)
for exactly what each does and does not prove.

