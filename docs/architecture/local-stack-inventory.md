# Local-stack entry points and configuration contracts — inventory

Local sub-issue: [02.01 — Check which applications exist and their actual
commands](../../../context/notion-tasks/sub-issues/02-01.md), under parent
[02 — Add Docker Compose local stack](../../../context/notion-tasks/02-docker-compose.md).

## 1. Scope and verification method

This document is a bounded investigation deliverable. It inventories the
**existing** application and infrastructure startup contracts in this
checkout so a later Docker Compose implementation can be planned against
real evidence. It does **not** implement Docker Compose, scaffold any
missing service, or change application behavior.

**Verification method:** every finding below was established by reading
the actual source files in this checkout (package manifests, entry points,
`packages/config` schemas, `tooling/scripts/deploy.mjs`, `README.md`,
Prisma schemas/config) — labeled **code-inspected**. No process was
started, no build was run, no migration was executed, and no container was
created to produce this document; the testing policy and this task's
instructions both exclude runtime verification for a documentation-only
change (`context/testing-policy.md`: "Documentation-only changes... Report
that application tests were not run when application code was not
changed."). Where the inventory states a runtime behavior that follows
from a third-party tool's documented default (e.g. Next.js's own listen
address default) rather than from this repository's code, that is called
out explicitly as inferred-from-documented-default, not executed.

Reference material consulted (read in full before writing this document,
per `CLAUDE.md` and the `relis-stack`/`relis-project-structure` skills):
[`context/stack.yml`](../../../context/stack.yml),
[`context/project-structure.md`](../../../context/project-structure.md),
[`context/testing-policy.md`](../../../context/testing-policy.md),
[`AGENTS.md`](../../AGENTS.md) (this repository's engineering guide),
[`context/notion-tasks/02-docker-compose.md`](../../../context/notion-tasks/02-docker-compose.md)
(read for context only; its later implementation steps were not executed),
and [`context/notion-tasks/PENDING-DECISIONS.md`](../../../context/notion-tasks/PENDING-DECISIONS.md).

## 2. Service/dependency matrix

| Service (parent-task list) | Exists in this checkout? | Evidence |
| --- | --- | --- |
| ReLiS2.0 web application | Yes — `apps/web` (Next.js) | `apps/web/package.json`, `apps/web/src/app/page.tsx` |
| API | Yes — `apps/api` (Hono) | `apps/api/package.json`, `apps/api/src/main.ts` |
| Worker | Yes — process exists; **no job consumer** | `apps/worker/package.json`, `apps/worker/src/main.ts` |
| PostgreSQL (Control DB) | Partial — schema/migration contract exists; **no running database, no container** | `packages/database/prisma/control/schema.prisma` (no models), `packages/database/src/migrate.ts` |
| PostgreSQL (per-project test DB) | Partial — same template schema exists; **no provisioning flow, no container** | `packages/database/prisma/project/schema.prisma` (no models) |
| Reverse proxy | **Missing** in this checkout (no config or container exists), but **not an undecided technology** — the mandatory structure names it specifically | `context/project-structure.md`'s `docker/nginx/nginx.conf` entry (not a set of alternatives); no such file exists in this checkout yet |
| Local object storage | **Missing**, in two separate respects: no application-level adapter, and no provisioned infrastructure service/container either | No storage client/SDK found in any `package.json` under `relis/`; no Compose/container definition exists |
| Local mail capture | **Missing**, in two separate respects: no application-level adapter, and no provisioned infrastructure service/container either | No mail client/SDK found in any `package.json` under `relis/`; no Compose/container definition exists |
| Docker Compose files | **Missing** | No `docker-compose*.yml` anywhere under `relis/` |

Legacy MariaDB/phpMyAdmin/Tomcat/BiBler/PHP stack (`deployment/docker-compose.yml`
referenced in the Notion card) is historical context only and is not part
of this inventory or the target architecture.

## 3. Exact existing application commands and source references

All commands below are **declared in `package.json` scripts**
(code-inspected); none were executed as part of this task.

### 3.1 `apps/api` (Hono API)

- Source: `apps/api/src/main.ts` (entry point), `apps/api/src/app.ts` (route composition).
- Working directory: `relis/apps/api` (or run with `pnpm --filter "./apps/api" <script>` from `relis/`).
- Commands (`apps/api/package.json`):
  - `pnpm --filter "./apps/api" dev` → `tsx watch src/main.ts` (no build step; runs TypeScript directly).
  - `pnpm --filter "./apps/api" build` → builds `@relis/config` first, then `tsc` (emits `apps/api/dist/`).
  - `pnpm --filter "./apps/api" start` → `node dist/main.js` (requires the build step to have run first; `dist/app.js`/`dist/main.js` are already present in this checkout, i.e. a prior build exists).
- Preparation/build steps: only the `build` script explicitly rebuilds `@relis/config` first (`pnpm --filter @relis/config build && tsc` — `apps/api/package.json:6`). `dev` (`tsx watch src/main.ts`) and `start` (`node dist/main.js`) do **not** rebuild it: pnpm workspace linking only symlinks `node_modules/@relis/config` to the package directory, it does not compile anything. Both therefore require `packages/config/dist/` to already exist and be current — `@relis/config`'s own `package.json` `exports` resolve only to `./dist/*`, with no source/TS condition (`packages/config/package.json:6-15`) — produced by a prior `pnpm --filter @relis/config build` (run directly, or as the first step of any app's own `build` script).
- Dev vs. production-start: `dev` runs `src/main.ts` directly via `tsx watch` (no compiled output, auto-restart on change); `start` runs the compiled `dist/main.js` — no watch, no transpilation at runtime.
- Listen address/port: `config.API_HOST` / `config.API_PORT`, read from `@relis/config`'s `loadApiConfig` (`apps/api/src/main.ts:28,35-37`). Defaults: `API_HOST=0.0.0.0`, `API_PORT=3001` (`packages/config/src/api.ts:6-11`).
- Container-to-container support: **yes, by current default.** `0.0.0.0` binds all interfaces, so another container reaching this process by its service name/IP on `API_PORT` would work as-is; this was not verified by actually running the process in a container.
- Required configuration categories (names only, never values): `NODE_ENV` (runtime), `API_PORT`/`API_HOST` (network), `API_CORS_ORIGIN` (cors). All four have safe local-development defaults; none is unconditionally required (`packages/config/src/api.ts:6-11`, confirmed by `README.md`'s variable table).
- Established by: code inspection of `apps/api/src/main.ts`, `apps/api/package.json`, `packages/config/src/api.ts`. Not executed in this task.

### 3.2 `apps/web` (Next.js)

- Source: `apps/web/scripts/run.mjs` (wrapper entry point; see rationale in its own header comment), `apps/web/src/app/page.tsx`, `apps/web/src/shared/lib/config.ts`.
- Working directory: `relis/apps/web` (or `pnpm --filter "./apps/web" <script>` from `relis/`).
- Commands (`apps/web/package.json`):
  - `pnpm --filter "./apps/web" dev` → `node ./scripts/run.mjs dev` (wraps `next dev`).
  - `pnpm --filter "./apps/web" build` → builds `@relis/config` first, then `node ./scripts/run.mjs build` (wraps `next build`).
  - `pnpm --filter "./apps/web" start` → `node ./scripts/run.mjs start` (wraps `next start`; **requires a prior `build`** — Next.js production `start` serves the `.next/` build output, which the wrapper does not create itself).
- Preparation/build steps: same pattern as `apps/api` (§3.1) — only `build` explicitly rebuilds `@relis/config` first (`apps/web/package.json:7`); `dev` and `start` do not rebuild it and require `packages/config/dist/` to already exist.
- The wrapper (`run.mjs`) is not a convenience script: it validates `NODE_ENV`, the effective `WEB_PORT`, and `NEXT_PUBLIC_API_URL` through `@relis/config` **before** ever spawning the real `next` binary (see its header comment and `README.md` "Diagnostics" section), and forwards `SIGINT`/`SIGTERM` to the spawned Next.js child with a bounded grace period before escalating to `SIGKILL`.
- Dev vs. production-start: `dev` defaults `NODE_ENV` to `development`; `start` defaults it to `production` and requires a previously built `.next/` output. **Both `dev` and `start` validate the effective listener port before spawning Next.js**: for any command other than `build`, `run.mjs` resolves the effective port (a `-p`/`--port` CLI override when present, else `WEB_PORT`) and validates it through `loadWebRuntimeConfig` (`run.mjs:112-124`), then passes the validated value to `next` via an explicit `-p` argument. **Only `build` skips this port validation entirely** (`run.mjs:113-115` — "`build` only produces the static/public bundle: it needs the build-time public config, not a runtime listener port"), because a build opens no listener.
- Listen address/port: the effective `WEB_PORT` (default `3000`), validated as described above for `dev`/`start` via `loadWebRuntimeConfig` (`packages/config/src/web.ts:7-9,25-30`). **No listen-address (host/interface) variable exists in this contract** — only the port is validated; the bind interface is whatever Next.js's own CLI default is for the installed version (Next's documented default binds all interfaces unless `-H`/`--hostname` is passed, which `run.mjs` never passes). This default-interface behavior is inferred from Next.js's own documented CLI default, not independently re-verified by running the process in this task.
- Container-to-container support: likely yes for the `web` service's own listener (by the same default-interface reasoning above), but note the browser-facing caveat below (§4) — the web **server** is not the only consumer of API connectivity.
- Required configuration categories: `WEB_PORT` (network, optional/defaulted), `NEXT_PUBLIC_API_URL` (public, optional/defaulted — see §4), `NODE_ENV` (runtime, optional/defaulted, with `run.mjs`'s stricter re-validation described in §5).
- Established by: code inspection of `apps/web/scripts/run.mjs`, `apps/web/package.json`, `packages/config/src/web.ts`, `packages/config/src/public.ts`. Not executed in this task.

### 3.3 `apps/worker`

- Source: `apps/worker/src/main.ts`.
- Working directory: `relis/apps/worker` (or `pnpm --filter @relis/worker <script>` from `relis/`).
- Commands (`apps/worker/package.json`):
  - `pnpm --filter @relis/worker dev` → `tsx watch src/main.ts`.
  - `pnpm --filter @relis/worker build` → builds `@relis/config` first, then `tsc`.
  - `pnpm --filter @relis/worker start` → `node dist/main.js`.
  - `pnpm --filter @relis/worker typecheck` → `tsc --noEmit`.
  - `pnpm --filter @relis/worker test` → `vitest run --passWithNoTests` (zero discovered tests today; not evidence of behavioral coverage per the testing policy).
- Preparation/build steps: same pattern as `apps/api` (§3.1) — only `build` explicitly rebuilds `@relis/config` first; `dev` and `start` do not rebuild it and require `packages/config/dist/` to already exist.
- Dev vs. production-start behavior: **the application logic is identical in both modes, but the OS-level process lifecycle differs.** In both modes, `src/main.ts`'s own execution loads and validates configuration, logs `"ReLiS worker started"`, and returns (`apps/worker/src/main.ts:21-28`) — there is no listener, no queue connection, and no long-running loop in either mode's application code. `start` (`node dist/main.js`) runs this to completion and the process then exits fully, with nothing left running. `dev` (`tsx watch src/main.ts`) wraps the same script in `tsx`'s watch supervisor: after the wrapped script's own execution completes, **the supervisor process itself remains running**, watching `src/` for changes so it can re-run the script — so the `dev` command's process does not exit the way `start`'s does (this follows from `tsx watch`'s documented supervisor behavior; it was not independently re-verified by executing the command in this task). **Neither mode processes jobs** — the difference is in process-exit behavior, not in job handling, and matters for Compose because a `dev`-mode service would appear to stay "up" (kept alive by the watch supervisor) despite doing no ongoing work, while a `start`-mode service genuinely exits once it has logged its startup line.
- Listen address/port: **not applicable** — the worker opens no network listener of its own.
- Container-to-container support: not applicable (no listener to reach).
- Required configuration categories: `NODE_ENV` only (runtime), optional/defaulted (`packages/config/src/worker.ts:5-11`). The code comment is explicit that this is deliberate: *"apps/worker currently only logs its own startup: it has no real queue or database consumer, so no variable is required here... do not add queue/database variables to this schema until a real consumer exists."*
- `pg-boss@^12.26.3` is a declared dependency (`apps/worker/package.json:16`) but is **not imported or used anywhere in `apps/worker/src`** (confirmed by searching the source tree). A dependency's presence is not evidence of an implemented queue integration — see §5/§8.
- Established by: code inspection of `apps/worker/src/main.ts`, `apps/worker/package.json`, `packages/config/src/worker.ts`. Not executed in this task.

### 3.4 Migration (`packages/database`)

- Source: `packages/database/src/migrate.ts`.
- Working directory: `relis/packages/database` (or `pnpm --filter @relis/database run migrate <control|project>` from `relis/`).
- Command: `pnpm --filter @relis/database run migrate control` or `... migrate project` (`packages/database/package.json:8` — script is literally `tsx src/migrate.ts`, target supplied as a CLI argument).
- This validates the target's connection string (`CONTROL_DATABASE_URL` or `PROJECT_DATABASE_URL`, via `loadDatabaseConfigForTarget`) **before** ever invoking Prisma (`packages/database/src/migrate.ts:77-98`), then runs the real `prisma migrate deploy --config <target>/prisma.config.ts` CLI, shell-free.
- Like `apps/api`/`apps/web`/`apps/worker`'s own `dev`/`start` (not `build`), the `migrate` script does **not** rebuild `@relis/config` either (`packages/database/package.json`'s `migrate` script is literally `tsx src/migrate.ts`, with no `@relis/config` build step) — it too requires `packages/config/dist/` to already exist.
- Both `packages/database/prisma/control/schema.prisma` and `.../project/schema.prisma` define **zero models** (confirmed by reading both files in full) and neither has a `migrations/` directory in this checkout — there is nothing yet for `migrate deploy` to apply beyond Prisma's own bookkeeping. This command is real and runnable against an empty schema; it is not evidence that a control-plane or project-data domain exists.
- Not executed in this task (migrations are explicitly excluded from this task's safe-execution boundary).

### 3.5 Deployment orchestrator (`tooling/scripts/deploy.mjs`)

- Source: `tooling/scripts/deploy.mjs`.
- Working directory: `relis/` (repository root).
- Command: `node tooling/scripts/deploy.mjs [--skip-migrate] [--skip-build] [--skip-worker]`.
- This is **plain Node `child_process` orchestration**, explicitly documented in its own header as *not* Docker, CI/CD, or a new orchestration technology, and explicitly **not** a substitute for the Docker Compose stack (`tooling/scripts/deploy.mjs:36-41`): *"Docker Compose remains the prescribed local/dev/test runtime (context/stack.yml) but is a separate, unauthorized-here scaffolding effort."*
- Ordered steps (each gated on the previous succeeding — see §7 for the ordering detail): validate every process's configuration → migrate the `control` database (skippable) → build api/worker/web (skippable) → run `apps/worker` once to completion as a step, not a supervised service (skippable) → spawn and supervise `apps/api` and `apps/web` (`start`) as long-running children.
- Not executed in this task (it builds, migrates, and starts real processes — excluded by this task's safe-execution boundary).

## 4. Internal, host-facing, and browser-public address distinctions

| Variable | What consumes it | Where it is evaluated | Internal / host-facing / browser-public |
| --- | --- | --- | --- |
| `API_HOST`, `API_PORT` | `apps/api`'s own listener | Server process, at startup (`apps/api/src/main.ts`) | Internal bind address. Reached directly by: (a) another server-side process on the same network (would be container-to-container inside a future Compose network), and (b) **the browser**, via `NEXT_PUBLIC_API_URL` below — these are two different consumers of the same backend and are not currently distinguished by two separate variables. |
| `WEB_PORT` | `apps/web`'s own listener (via the `run.mjs` wrapper → Next.js) | Server process, at startup | Internal bind address / host-facing port for the dev server. |
| `NEXT_PUBLIC_API_URL` | **The browser**, via `apps/web/src/shared/lib/config.ts`'s `publicConfig.NEXT_PUBLIC_API_URL`, consumed by `apps/web/src/app/page.tsx:22`'s client-side `fetch` | Build-time, inlined into the client JS bundle by Next.js's static replacement (confirmed by the literal `process.env.NEXT_PUBLIC_API_URL` reference required in `config.ts`, and by `README.md`'s "Build-time vs. runtime configuration" section) | **Browser-public.** This is the address the end user's browser calls directly — it must be reachable from wherever the browser runs, which is **not** the same reachability requirement as a container-internal hostname. Default: `http://localhost:3001` (`packages/config/src/public.ts:12`). |
| `CONTROL_DATABASE_URL`, `PROJECT_DATABASE_URL` | Migration command, deployment orchestrator | Server-side only, at migration/deploy time | Internal — never reaches a browser and is marked **secret** in `README.md`'s variable table. Current `.env.example` placeholder points at `localhost:5432`, i.e. a host-facing address for a database this checkout does not run or containerize. |

**Consequence for the eventual Compose stack (not decided here):** `apps/api`'s
listener address (`API_HOST`/`API_PORT`) and the browser-facing URL
(`NEXT_PUBLIC_API_URL`) serve two different audiences — one container-internal,
one reachable from the developer's actual browser — and today share no
explicit "internal vs. external" naming convention in the configuration
contract. A reverse proxy sitting in front of both, as the parent task
requires, would need to resolve this distinction; the current contract
does not yet express it and this task does not resolve it.

## 5. Configuration-contract mapping (shared runtime config)

Source of truth: `packages/config` (`@relis/config`), already implemented
by the completed runtime-config task — reused here, not re-derived. Full
variable reference and precedence tables are already documented in
`README.md` ("Runtime configuration") and are not duplicated verbatim here;
only the mapping needed for this inventory is restated.

| Process | Loader/schema (file) | Validates relative to traffic/writes | Required vars | Optional vars (with default) |
| --- | --- | --- | --- | --- |
| `apps/api` | `loadApiConfig` — `packages/config/src/api.ts` | Before `serve()` opens a listener (`apps/api/src/main.ts:28-36`) | none | `NODE_ENV` (`development`), `API_PORT` (`3001`), `API_HOST` (`0.0.0.0`), `API_CORS_ORIGIN` (`http://localhost:3000`) |
| `apps/web` (runtime) | `loadWebRuntimeConfig`, `parsePublicWebConfig`, `validateConsistentRuntimeMode` — `packages/config/src/web.ts`, `public.ts`, `env-loader.ts` | Before spawning the real `next` binary (`apps/web/scripts/run.mjs`) | none | `WEB_PORT` (`3000`), `NEXT_PUBLIC_API_URL` (`http://localhost:3001`), `NODE_ENV` (per-command default, see `env-loader.ts`) |
| `apps/worker` | `loadWorkerConfig` — `packages/config/src/worker.ts` | Before any further startup logic (there is none beyond logging) | none | `NODE_ENV` (`development`) |
| Migration (`control`/`project`) | `loadDatabaseConfigForTarget` — `packages/config/src/database.ts` | Before any Prisma client/CLI invocation (`packages/database/src/migrate.ts:77-98`) | `CONTROL_DATABASE_URL` or `PROJECT_DATABASE_URL`, **only for the target actually invoked** | none |
| Deployment (`deploy.mjs`) | Composes all of the above plus `checkPortConflicts` — `tooling/scripts/deploy.mjs:87-145` | Before any build, migration, or service start (step 1 of 5, see §7) | `CONTROL_DATABASE_URL` (unless `--skip-migrate`) | everything else as above |

Internal vs. host-facing vs. browser-public is covered in §4 above and is
not duplicated here.

**Incompatibilities / missing configuration for the eventual local stack**
(observed gaps, not resolved here):

- No `WEB_HOST`/bind-interface variable exists for `apps/web` (see §3.2).
- No variable distinguishes an **internal** API URL (for a reverse proxy or
  another container) from the **browser-public** `NEXT_PUBLIC_API_URL` — a
  reverse proxy fronting both services would likely need a second,
  internal-facing variable or a documented convention; this is not decided
  here.
- No object-storage or mail-transport variables exist anywhere in
  `packages/config` (confirmed by reading every file in `packages/config/src/`
  and by the grep in §6) — there is no configuration contract to reuse for
  those two parent-task services yet.
- No queue/background-job variables exist (deliberate, per `worker.ts`'s own
  comment) — consistent with `background_jobs.status: undecided` in
  `context/stack.yml`.

## 6. Database, storage, mail, and persistence responsibilities

### 6.1 Control DB

- Ownership: `packages/database/prisma/control/schema.prisma` + `packages/database/prisma/control/prisma.config.ts`.
- Connection responsibility: `CONTROL_DATABASE_URL`, validated by `loadDatabaseConfigForTarget("control", ...)`.
- Initialization prerequisite: **schema defines zero models**; no `migrations/` directory exists under `prisma/control/` in this checkout. `migrate deploy` is runnable today but has no business schema to apply.
- No running PostgreSQL instance, container, or volume exists in this checkout for this target — the `.env.example` placeholder (`postgresql://relis:changeme@localhost:5432/relis_control`) describes an address format, not a provisioned database.

### 6.2 Project test database(s)

- Ownership: `packages/database/prisma/project/schema.prisma` (the template schema "applied to every isolated per-project database" per its own header comment) + `prisma/project/prisma.config.ts`.
- Connection responsibility: `PROJECT_DATABASE_URL`, validated the same way as control, via `loadDatabaseConfigForTarget("project", ...)`.
- Initialization prerequisite: same as control — zero models, no migrations directory. `README.md` is explicit that *"no automated process supplies [`PROJECT_DATABASE_URL`] today; per-project provisioning is out of scope"* for the completed runtime-config task, and that per-project provisioning/migration orchestration is a separate, unauthorized-here effort (pointing at `context/notion-tasks/16-project-template.md` and `17-project-resolver.md`).
- No running database, container, or volume exists for this target either.

### 6.3 Object storage

- **No application-level adapter exists.** Grepping every `package.json` and source file under `relis/apps` and `relis/packages` for storage-client indicators (`s3`, `S3Client`, `minio`, object-storage SDKs) found no matches outside this inventory's own search.
- `context/project-structure.md`'s `apps/api/src/platform/storage/` and the root `storage/` tree are both named in the **required target structure** but neither directory exists in this checkout — the structure document is explicitly not evidence that the feature exists.
- No protocol or configuration expectation can be reported because no consuming code exists to inspect.
- **This is an application-integration gap, not a reason to withhold the infrastructure service from Compose.** Whether `apps/api` has code that talks to an object-storage service and whether a Compose stack can run an object-storage *container* are separate questions: the parent task's own description requires the Compose stack to provide "local object storage" as one of its services regardless of whether any application code consumes it yet. Nothing found in this checkout blocks provisioning that container; only an application-level adapter is absent.

### 6.4 Mail

- **No application-level adapter exists.** Same grep as above found no mail-client/SMTP indicators (`nodemailer`, `smtp`, mail SDKs) anywhere under `relis/`.
- `context/project-structure.md`'s `apps/api/src/platform/mail/` is named in the required target structure but does not exist in this checkout.
- No transport or configuration expectation can be reported because no consuming code exists to inspect.
- **Same distinction as object storage (§6.3) applies here.** The parent task's own "UI behavior" field is explicit that local MailHog/Mailpit "and job observability endpoints are documented for development use only" — i.e. reachable and useful for local development without requiring `apps/api` to send mail through them first. An absent application-level mail adapter does not, by itself, block Compose from provisioning a mail-capture container.

### 6.5 Persistence and source-control exclusion

- `.gitignore` already excludes `node_modules/`, build output (`dist`, `.next`, `out`), caches, and `.env`/`.env.*` (except `.env.example`) — confirmed by reading the file in full.
- `.gitignore` does **not yet** reference any Compose-specific persistent-volume path (e.g. a future `docker/postgres/data/` or similar), because no such path exists yet. This is a prerequisite for the next (Compose-definition) task, not something to add speculatively here.

## 7. Health, readiness, and startup dependencies

- `apps/api` exposes `GET /health` (liveness; static `{status, message, service}` payload, `apps/api/src/app.ts:25-31`) and `GET /ready` (readiness; `apps/api/src/app.ts:36-45`). `/ready` reports only `network` and `cors` as `"ok"` — it **does not** check a database or queue, and the code comment is explicit about why: *"It does not claim a database or queue dependency: apps/api has neither today."* Both endpoints are unauthenticated and return static/derived data; neither performs an actual outbound connectivity check to any dependency.
- `apps/web` exposes **no server-side health/readiness endpoint of its own.** `apps/web/src/app/page.tsx` performs a **client-side** (browser) fetch of `apps/api`'s `/health` on page load, purely for UI display (`page.tsx:18-44`) — this is not a server-to-server readiness check usable by an orchestrator.
- `apps/worker` exposes no health/readiness endpoint (no listener exists at all — §3.3).
- No reverse proxy, object storage, or mail-capture health endpoint can be reported: none of those services exist in this checkout (§2).
- **Startup ordering supported by existing code:** only `tooling/scripts/deploy.mjs`'s `validateDeployment`/`runSteps` encode an explicit order today: (1) validate every process's configuration and check for an api/web port conflict, (2) migrate the control database (skippable), (3) build api/worker/web (skippable), (4) run the worker once to completion as a step (skippable), (5) start and supervise `api` and `web` as long-running services. Each step is gated on every earlier step's success (`runSteps`, `tooling/scripts/deploy.mjs:162-170`). This ordering exists for the local Node-based deployment orchestrator only — it is not a Compose `depends_on`/healthcheck graph, and no such graph exists yet.
- **Worker is idle, not a processor — in both modes, regardless of process lifecycle:** `apps/worker`'s own application logic logs `"ReLiS worker started"` and returns; it does not poll, subscribe to, or process any job queue in either mode (§3.3). `start` (`node dist/main.js`) then exits fully. `dev` (`tsx watch src/main.ts`) leaves `tsx`'s watch supervisor running after that same return (§3.3) — so the `dev` process keeps running, but not for any job-processing reason. A running worker process, in either mode, is not evidence of an implemented queue consumer; for `dev` specifically, staying alive only because a file watcher is watching is not evidence of job processing either.
- **Gap relevant to Compose:** nothing in the current code expresses a dependency ordering between `apps/api`/`apps/web` and a database, proxy, storage, or mail service, because none of those infrastructure services exist yet to depend on.

## 8. Missing prerequisites and unresolved decisions (not selected here)

Explicit missing prerequisites (not implemented in this task):

- Reverse proxy: no config or routing rules exist anywhere in this checkout yet; the **technology itself is already prescribed** (nginx, per `context/project-structure.md`'s `docker/nginx/nginx.conf` — not an open image choice), so only the actual configuration/scaffolding remains missing (see also the unresolved-decisions note below).
- Local object storage: no **application-level** adapter, dependency, or configuration contract exists (§6.3). This is an application-integration gap, not a blocker to Compose provisioning the object-storage service itself — service availability and application integration are separate concerns.
- Local mail capture: no **application-level** adapter, dependency, or configuration contract exists (§6.4). Same distinction as above: service availability (running a mail-capture container) and application integration (code that sends mail through it) are separate, and only the latter is reported missing here.
- Containerized PostgreSQL for either the Control DB or project template: no container, image, or volume exists; only a connection-string contract and an (empty) Prisma schema per target exist today.
- `docker/`, `docker-compose*.yml`, and the root `storage/` tree from `context/project-structure.md`: none exist in this checkout.
- A `WEB_HOST`/bind-interface variable for `apps/web` (only `WEB_PORT` is validated today).
- An internal-vs-browser-public API address convention (today only `NEXT_PUBLIC_API_URL` exists, and it is browser-public by design — §4).

Unresolved decisions (named, not selected, per `context/stack.yml` and
`context/notion-tasks/PENDING-DECISIONS.md` item 1):

- **Background-job backend (`pg-boss` vs. `BullMQ`):** `context/stack.yml`
  still lists `background_jobs.status: undecided`. `pg-boss` is a declared
  dependency of `apps/worker` but is not used by any code — its presence is
  not a decision. **This inventory does not select one**, and therefore
  does not report whether the eventual stack needs a Redis service (BullMQ)
  or relies solely on PostgreSQL (`pg-boss`) — introducing either
  assumption would contradict this task's explicit instructions.
- **BiBler:** required by the future import task (`29-bibler-import.md`)
  but explicitly **not** part of this parent task's new-service list per
  the Notion card and this task's own instructions. Recorded here only as
  a future import prerequisite — not migrated, scaffolded, or added to this
  inventory's service matrix.
- Object-storage protocol/provider and mail-capture tool (e.g. MailHog vs.
  Mailpit) are named by the parent task only as categories ("local object
  storage," "local mail capture") — no specific technology is selected in
  `context/stack.yml` or elsewhere in this checkout. Selecting one is
  explicitly out of scope for this inventory task.
- **Reverse-proxy technology is not in the same category.**
  `context/project-structure.md`'s mandatory `docker/` tree names
  `docker/nginx/nginx.conf` specifically — not a set of alternatives —
  which makes nginx the prescribed direction under `CLAUDE.md`'s rule that
  "the structure document says 'proposed,' [but] it is the required
  target architecture." Scaffolding that configuration is still out of
  scope for this inventory task; only recognizing the prescribed
  technology (as opposed to an open choice) is reported here.

## 9. Handoff checklist for the Compose-definition sub-issue (02.02+)

This is a checklist of concrete facts the next sub-issue can rely on — it
selects nothing on the next sub-issue's behalf.

- [ ] `apps/api`, `apps/web`, `apps/worker` each have a real, independently
      runnable `build`/`start` pair (§3.1–3.3); a Dockerfile per app
      (`docker/api/Dockerfile`, `docker/web/Dockerfile`, `docker/worker/Dockerfile`
      per `context/project-structure.md`) can wrap these exact commands —
      none need to be invented.
- [ ] `apps/api` already binds `0.0.0.0` by default (§3.1) — compatible
      with container-to-container access without a code change.
  `apps/web`'s bind interface is Next.js's own default (not independently
      verified by execution here) and has no dedicated host variable (§3.2,
      §8) — confirm this explicitly before relying on it in a Compose
      healthcheck.
- [ ] `apps/worker` has no listener and no job consumer in either mode
      (§3.3, §7). This constrains what such a Compose service would
      actually be doing, but **not** whether it can run as a long-running
      Compose service: its `start` command logs and exits (matching the
      one-shot step `deploy.mjs` already runs), while its `dev` command's
      `tsx watch` supervisor stays running indefinitely on its own, with no
      queue consumer required for that. Compose can run the existing `dev`
      command as a long-running service without first implementing a
      queue consumer — but a container that stays "up" only because of
      the watch supervisor is not evidence of job processing, and must not
      be reported as such.
- [ ] The `@relis/config` contract (§5) is the only configuration source of
      truth to reuse — do not invent new environment variable names for
      `apps/api`/`apps/web`/`apps/worker` without extending that package
      first.
- [ ] `CONTROL_DATABASE_URL`/`PROJECT_DATABASE_URL` are the only
      database-connection variables that exist; both validate against an
      **empty** Prisma schema today (§6.1–6.2) — a Compose Postgres service
      can be wired to these variable names, but the schemas themselves
      provision no business tables yet.
- [ ] No **application-level** object-storage or mail-capture adapter or
      configuration contract exists (§6.3–6.4) — but this does **not**
      block the Compose-definition sub-issue from provisioning the
      object-storage and mail-capture **services themselves** (containers,
      ports, volumes). The parent task's own description documents
      MailHog/Mailpit and job-observability endpoints as
      **development-only**, reachable without requiring `apps/api` to
      integrate with them first. Only building an application-level
      adapter that consumes either service is a separate, later effort.
- [ ] `GET /health` and `GET /ready` are the only existing health/readiness
      endpoints, both on `apps/api` only, both static/derived checks with
      no dependency verification (§7) — a reverse-proxy healthcheck
      restricted to these two paths is consistent with existing behavior;
      exposing per-service ports directly would not match the parent task's
      "expose health/readiness only through the local reverse proxy"
      requirement and is not implemented today.
- [ ] The background-job backend decision (`pg-boss` vs. `BullMQ`) remains
      open (§8) — do not add a Redis service to Compose on the assumption
      that BullMQ will be chosen, and do not treat `pg-boss`'s presence in
      `package.json` as a resolved decision.
- [ ] Object-storage provider and mail-capture tool remain unselected
      (§8) — the Compose-definition sub-issue will need to either select
      them (with user approval, per `CLAUDE.md`'s unresolved-decision rule)
      or continue to document them as blocked. **Reverse-proxy technology
      is already prescribed** (nginx, per `context/project-structure.md`'s
      `docker/nginx/nginx.conf` — §2, §8): the next sub-issue can scaffold
      `docker/nginx/nginx.conf` directly rather than treating the proxy
      technology itself as an open decision.

## Acceptance-criteria evidence (for this sub-issue)

- **AC1 (resolve every documented command to an existing package script):**
  every command in §3 was matched to an actual `package.json` script or
  CLI entry point read in this checkout; none was invented. See §3.1–3.5.
- **AC2 (mark nonexistent applications as blocked integrations):** reverse
  proxy (not yet scaffolded, though its technology is prescribed — §2, §8),
  object storage, mail capture, and any running/containerized PostgreSQL
  are marked **missing** in §2, §6.3, §6.4, and §8 — none is presented as
  implemented.
- **AC3 (every requirement accounted for):** §2 covers every service named
  in the parent task's description; §8 lists every unresolved decision
  named in the parent task's own gaps section plus one newly observed gap
  (the internal/browser-public address distinction, §4).
- **AC4 (checks actually run and passed, no hidden failure):** this is a
  documentation-only deliverable; no application tests were run because no
  application code was changed, per `context/testing-policy.md`'s
  "Documentation-only changes" section. Every path, script, and schema
  field cited above was opened and read in this checkout as part of
  producing this document (see §1 "Verification method").
