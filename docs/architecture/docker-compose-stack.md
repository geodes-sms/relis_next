# Local Docker Compose stack

Implements local sub-issues [02.02 — Define services and shared
configuration, including the Control DB and per-project test
databases](../../../context/notion-tasks/sub-issues/02-02.md) and
[02.03 — Configure local persistent volumes and exclude them from version
control](../../../context/notion-tasks/sub-issues/02-03.md) (parent: [02
— Add Docker Compose local stack](../../../context/notion-tasks/02-docker-compose.md)).
Builds directly on [the local-stack inventory](local-stack-inventory.md)
from the preceding sub-issue — read that document first for the
application startup contracts this stack reuses unchanged (it does not
re-derive them here). Data persistence, the stop/start/recreate/reset
lifecycle, and what a reset destroys are in
["Persistence, lifecycle, and reset"](#persistence-lifecycle-and-reset).

## Scope

One Compose file (`docker-compose.yml`, repository root) defines all seven
required service responsibilities as real processes/containers:

1. `web` — the existing Next.js app, `dev` command.
2. `api` — the existing Hono API, `dev` command.
3. `worker` — the existing worker **development** process (`tsx watch`) —
   not `start`, and not a job processor either way (see "Known
   limitations" below).
4. `postgres` — one PostgreSQL server, two disposable databases: the
   Control DB and a project-test target.
5. `nginx` — the reverse proxy; the only published entry point for the
   browser.
6. `storage` — SeaweedFS, S3-compatible endpoint, single-node mode.
7. `mailhog` — local mail capture.

Everything here is local-development only. No production target, no TLS,
no CI wiring, no business schema, no queue consumer, no storage/mail
*application* adapter. `docker-compose.dev.yml` / `docker-compose.test.yml`
were not created: `docker-compose.yml` already runs dev-mode processes
with live-reload mounts (see "Development mounts" below), so a separate
dev overlay was not needed for this sub-issue's scope, and the test
harness (`tests/integration/docker-compose/`) achieves isolation via a
unique `-p` project name and either a pre-picked free host port
(`NGINX_HTTP_PORT` — required because that value is baked into
`NEXT_PUBLIC_API_URL` at container start) or an ephemeral host port
discovered after startup (`MAILHOG_UI_PORT`/`SEAWEEDFS_S3_PORT`, neither
read by any application code) instead of a dedicated compose file — see
"Tests" below.

## Prerequisites

- Docker Engine with the Compose V2 CLI plugin (the `docker compose`
  subcommand, not the legacy standalone `docker-compose` V1 binary), with
  a Linux-container backend. **Verified by real execution** (Docker
  Desktop 29.8.2 / `docker compose` plugin v5.5.1, Windows host,
  WSL2/Linux-container engine) — see the final report for sub-issue #47
  for the exact commands and results. Earlier drafts of this document
  were written before Docker was available and said so explicitly; that
  caveat no longer applies.
- No `pnpm`/Node install needed on the host — every app container installs
  its own dependencies at image-build time (`pnpm install --frozen-lockfile`
  against the committed `pnpm-lock.yaml`).
- Copy `.env.example` to `.env` at the repository root (same convention as
  the existing runtime-config setup — see `README.md` "Runtime
  configuration"). Every value in it is a development-only placeholder.
- Only for the real-browser check (`tests/e2e/docker-compose/`):
  Playwright's Chromium browser binary must be installed
  (`pnpm exec playwright install chromium`). **Now installed and
  verified** in the environment that ran the sub-issue #47 real
  verification (`pnpm run test:e2e` passed with a real Chromium
  instance). Installing it remains a deliberate, separately-authorized
  step in a fresh checkout — this repository's tooling does not do it on
  your own behalf automatically.

## Startup

```bash
docker compose up --build
```

First run builds `web`, `api`, and `worker`'s images (each installs the
full pnpm workspace and bakes an initial `@relis/config` build — see
"Clean-checkout startup" below) and provisions two disposable PostgreSQL
databases via the `migrate-control` / `migrate-project` one-shot services.
Subsequent runs can drop `--build` unless `package.json`/`pnpm-lock.yaml`
changed.

## Shutdown and reset

```bash
docker compose -p relis -f docker-compose.yml stop                              # stop, keep containers and data
docker compose -p relis -f docker-compose.yml down --remove-orphans             # remove containers/network, KEEP data
docker compose -p relis -f docker-compose.yml down --volumes --remove-orphans   # reset: DELETE this project's data
```

The last command destroys both local databases and every stored
object. Read ["Persistence, lifecycle, and reset"](#persistence-lifecycle-and-reset)
below for the full lifecycle table, exactly what a reset deletes, and
how to recreate the stack afterward.

## Service graph and addresses

| Service | Role | Published to host? | Internal address | Notes |
| --- | --- | --- | --- | --- |
| `nginx` | Reverse proxy | **Yes** — `127.0.0.1:${NGINX_HTTP_PORT:-8080}` | `nginx:80` | The only entry point for `web`/`api`. |
| `web` | Next.js dev | No | `web:3000` | Reached only via `nginx`. |
| `api` | Hono dev | No | `api:3001` | Reached only via `nginx`'s `/api/` prefix — never published directly, per this task's "health/readiness only through the proxy" requirement. |
| `worker` | Worker dev (`tsx watch`) | n/a (no listener) | n/a | See "Known limitations." |
| `postgres` | Control DB + project-test DB | No | `postgres:5432` | Two databases, one server — see "Database isolation." |
| `migrate-control` / `migrate-project` | One-shot provisioning | n/a | n/a | Run once at startup, exit 0, do not stay running. |
| `storage` | SeaweedFS S3 gateway | **Yes** — `127.0.0.1:${SEAWEEDFS_S3_PORT:-8333}` | `storage:8333` | Development-only endpoint; no app adapter consumes it. |
| `mailhog` | Mail capture, web UI | **Yes** (UI only) — `127.0.0.1:${MAILHOG_UI_PORT:-8025}` | `mailhog:8025` (UI), `mailhog:1025` (SMTP) | SMTP stays internal — nothing submits mail through it yet. |

### Internal vs. host-facing vs. browser-public addresses

- **Internal (Compose-only hostnames)**: `postgres:5432`, `api:3001`,
  `web:3000`, `storage:8333`/`9333`/`8888`, `mailhog:1025`. These resolve
  only inside the Compose network and are never reachable from the host
  browser or shell.
- **Host-facing (loopback-published)**: `127.0.0.1:${NGINX_HTTP_PORT}`,
  `127.0.0.1:${MAILHOG_UI_PORT}`, `127.0.0.1:${SEAWEEDFS_S3_PORT}` — reachable
  from the host machine (curl, a browser, a local S3 client) but bound to
  loopback only, never `0.0.0.0`, per this task's "bind published
  development ports to loopback" requirement.
- **Browser-public**: `NEXT_PUBLIC_API_URL`, set to
  `http://localhost:${NGINX_HTTP_PORT:-8080}/api` — **not** the internal
  `api:3001` hostname. `apps/web/src/app/page.tsx`'s existing client-side
  `fetch(`${apiUrl}/health`)` call is unmodified; it now resolves through
  nginx's `/api/` prefix (stripped by nginx, reaching `apps/api` as
  `GET /health`) instead of a hostname the browser could never resolve.
  Because the page itself is also served through the same nginx origin,
  this fetch is **same-origin** — no cross-origin request, so the
  existing `API_CORS_ORIGIN` setting (still configured, defensively, as
  `http://localhost:${NGINX_HTTP_PORT}`) is not actually exercised in
  normal use.

## Clean-checkout startup

Each of `docker/web/Dockerfile`, `docker/api/Dockerfile`, and
`docker/worker/Dockerfile`:

1. Copies only manifests first, then runs `pnpm install --frozen-lockfile`
   (cached across source-only changes).
2. Copies the rest of the workspace and runs `pnpm --filter @relis/config
   build` once, baking an initial `dist/`.
3. At container start, the `command:` override in `docker-compose.yml`
   runs `pnpm --filter @relis/config build` **again** before the real
   `dev` command — because, as established in
   [the inventory doc](local-stack-inventory.md#3-exact-existing-application-commands-and-source-references),
   individual `dev`/`start`/`migrate` commands do **not** rebuild
   `@relis/config` themselves, and its `package.json` `exports` resolve
   only to `./dist/*`. Rebuilding on every start keeps that dist current
   with whatever `packages/config/src` the development bind-mount (below)
   is currently showing, even though the image already baked one copy.

## Development mounts

Only **source** subdirectories are bind-mounted for live editing —
`apps/web/src`, `apps/web/public`, `apps/api/src`, `apps/worker/src`, and
`packages/config/src` (into whichever of the three app containers consume
it). `node_modules`, `dist`, and `.next` are **never** mounted: they stay
whatever the image build produced, so a bind mount can never hide an
installed dependency or a required build artifact. This also sidesteps a
harder problem a whole-repository bind mount would create: on a genuinely
clean host checkout, `node_modules` doesn't exist yet (it's gitignored),
so mounting the entire repository over the image's `/app` would hide the
image's own already-installed `node_modules` with nothing. Mounting only
`src/`/`public/` avoids that entirely.

## Database isolation

`migrate-control` and `migrate-project` each run the **existing**
`packages/database/src/migrate.ts` entry point, unchanged, against one
target each:

- `migrate-control` → `CONTROL_DATABASE_URL=postgresql://.../relis_control`
- `migrate-project` → `PROJECT_DATABASE_URL=postgresql://.../relis_project_example`

Both URLs are built from `POSTGRES_USER`/`POSTGRES_PASSWORD` plus their
own database name — never from each other, and never substituted for one
another. `docker/postgres/init/01-create-project-test-database.sh` creates
the second database (`relis_project_example` by default) alongside the
official postgres image's own creation of `POSTGRES_DB`
(`relis_control`). Neither Prisma schema defines a model, so this proves
the two-target connection contract, not a business schema — consistent
with this task's "without adding business models" boundary.

## Persistence, lifecycle, and reset

Implements local sub-issue [02.03 — Configure local persistent volumes
and exclude them from version
control](../../../context/notion-tasks/sub-issues/02-03.md). Everything
below describes **local, disposable development data only** — there is no
production target, no external volume, and no backup or restore
mechanism anywhere in this stack.

### What persists, and where

Two Docker **named volumes** hold every byte of persistent state. One
PostgreSQL server with one physical volume holds *both* logical
databases — deliberately: a container or volume per database is not a
requirement of this stack and is not implemented.

| Owning service | Container path | Backed by | Holds | Disposable? |
| --- | --- | --- | --- | --- |
| `postgres` | `/var/lib/postgresql/data` | named volume `<project>_postgres-data` | The whole PostgreSQL cluster: **both** logical databases (the Control DB `relis_control` *and* the project-test database `relis_project_example`), plus server-wide state (roles, WAL, the `postgres`/`template*` databases). | Yes |
| `storage` | `/data` | named volume `<project>_storage-data` | SeaweedFS's entire single-node state in one directory: master metadata, volume (object) files, and filer metadata — i.e. every bucket and non-production object. | Yes |

`<project>` is the Compose project name (see "Project scoping" below).
With the default startup from this directory that is `relis`, so the two
real volume names are `relis_postgres-data` and `relis_storage-data`.

Everything else mounted into a container is **configuration or source,
never generated data**:

| Owning service | Container path | Backed by | Kind |
| --- | --- | --- | --- |
| `postgres` | `/docker-entrypoint-initdb.d` | `./docker/postgres/init` (read-only) | Committed first-init SQL. |
| `storage` | `/etc/seaweedfs/s3-identities.json` | `./docker/storage/s3-identities.json` (read-only) | Committed development-only S3 identity. |
| `nginx` | `/etc/nginx/nginx.conf` | `./docker/nginx/nginx.conf` (read-only) | Committed proxy routing. |
| `api` | `/app/apps/api/src` | `./apps/api/src` | Committed source, mounted for live reload. |
| `web` | `/app/apps/web/src`, `/app/apps/web/public` | `./apps/web/src`, `./apps/web/public` | Committed source/assets, mounted for live reload. |
| `worker` | `/app/apps/worker/src` | `./apps/worker/src` | Committed source, mounted for live reload. |
| `api`, `web`, `worker` | `/app/packages/config/src` | `./packages/config/src` | Committed shared-config source (see "Development mounts"). |

Generated **application** artifacts — `node_modules`, `dist`, `.next` —
are never mounted at all: each lives only inside its image/container
layer (see "Development mounts" above) and is rebuilt from the committed
lockfile and source. They are therefore not persistent across container
recreation either, and recreating a container re-derives them.

The consequence worth stating explicitly: **no service bind-mounts a
writable data directory out of this repository.** Database and object
data cannot become a tracked repository artifact, because no path in the
working tree ever holds any. `tests/integration/docker-compose/persistence.test.ts`
asserts this directly against the resolved Compose configuration, which
is a stronger guarantee than an ignore rule.

`.gitignore` covers the remaining cases: real environment files
(`.env`, `.env.*`, with `.env.example` the committed exception),
generated build output (`dist`, `.next`, `node_modules`), coverage, test
run output (`test-results/`, `playwright-report/`, `blob-report/`), and —
defensively — the generated-artifact directories the required structure
reserves at `storage/uploads/`, `storage/exports/`, and `storage/temp/`
(those do not exist yet and no application adapter writes to them).
`tests/integration/docker-compose/persistence-ignore-rules.test.ts`
verifies all of it with read-only Git commands, and additionally asserts
that no ignore pattern is broad enough to shadow a tracked source file.

### Project scoping

Compose prefixes each declared volume with the project name, so the
project name alone decides which data a startup reuses:

| Startup | Project name | Volumes used |
| --- | --- | --- |
| `docker compose up` from this directory | `relis` (the directory name) | `relis_postgres-data`, `relis_storage-data` |
| `docker compose -p other up` | `other` | `other_postgres-data`, `other_storage-data` |
| An integration test's disposable project | `relis-persist-<random>` etc. | `relis-persist-<random>_postgres-data`, … |

Consequences, all verified rather than assumed:

- **A normal startup reuses the intended development volumes.** Running
  `docker compose up` again — with or without `--build`, and after any
  number of `docker compose down` cycles — reattaches `relis_*` and
  finds the previous data.
- **Separate Compose projects cannot share a data volume.** Neither
  volume is `external: true`, neither declares an explicit `name:`, and
  nothing points at a path outside the repository or at a
  machine-specific location, so two projects can only ever resolve to
  different volume names. `persistence.test.ts` proves this with a
  second, independently-named Compose project whose own fixture row is
  invisible from the first and survives the first's reset.
- The Compose **network** is likewise per-project: it is declared as
  `${COMPOSE_PROJECT_NAME:-relis}-net`, and Compose V2 feeds `-p` into
  that interpolation (confirmed: `docker compose -p X config` resolves
  the network name to `X-net`), so a `-p`-scoped run does not reuse the
  default stack's network either.
- No production endpoint, external volume, or absolute host path appears
  anywhere in `docker-compose.yml`; every bind source is a
  repository-relative path.

### Lifecycle operations

Always pass the project and file explicitly — `-p <project> -f
docker-compose.yml` — so a command can never act on a different project
than intended. (`docker compose` infers the project from the current
directory's name when `-p` is omitted; being explicit costs nothing and
removes the ambiguity entirely, which matters most for the last row.)

| Goal | Command | Containers | Named volumes | Data |
| --- | --- | --- | --- | --- |
| **Stop**, keeping containers and data | `docker compose -p relis -f docker-compose.yml stop` | Stopped, **kept** | Kept | **Kept** |
| **Start** again (same containers) | `docker compose -p relis -f docker-compose.yml start` | Restarted in place | Kept | **Kept** |
| **Restart** in one step | `docker compose -p relis -f docker-compose.yml restart` | Restarted in place | Kept | **Kept** |
| **Remove containers and the network**, keeping data | `docker compose -p relis -f docker-compose.yml down --remove-orphans` | **Removed** | **Kept** | **Kept** |
| Recreate after that removal | `docker compose -p relis -f docker-compose.yml up -d` | Newly created | Reattached | **Kept** |
| **Reset** — delete this project's disposable data | `docker compose -p relis -f docker-compose.yml down --volumes --remove-orphans` | **Removed** | **DELETED** | **DESTROYED** |

The only difference between the fourth row and the last is the
`--volumes` flag. That flag is the entire reset.

### ⚠️ Reset destroys data — read before running it

`docker compose -p relis -f docker-compose.yml down --volumes --remove-orphans`
**permanently and irreversibly deletes**:

- `relis_postgres-data` — and with it **both** logical databases at
  once: the Control DB (`relis_control`) *and* the project-test database
  (`relis_project_example`), plus every table, row, and role on that
  server. They share one volume; there is no way to reset one and keep
  the other.
- `relis_storage-data` — and with it **every bucket and object** in the
  local SeaweedFS instance.

It does **not** touch: your source code, `.env`, any other Compose
project's containers or volumes, or the built images (those are a build
cache, removed separately and deliberately if ever wanted). There is no
backup, no snapshot, and no undo — this stack intentionally implements
none, because its data is local and disposable by design.

Substitute the real project name for `relis` if you started the stack
with a different `-p`. If you are unsure what a reset would delete, list
it first — a read-only check:

```bash
docker volume ls --filter label=com.docker.compose.project=relis
```

Never reset as part of ordinary startup: `up`, `up --build`, `stop`,
`start`, `restart`, and `down` (without `--volumes`) all keep data, and
that is the normal path.

**Do not** use broad commands to clean up instead. `docker system prune`,
`docker volume prune`, `docker builder prune --all`, a bare
`docker volume rm` against a guessed name, or deleting a directory with
`rm -rf` all reach beyond this project and can destroy unrelated
containers, volumes, and other developers' or other projects' data. The
scoped `down --volumes` above is the only reset this stack needs, which
is why **no reset script is provided**: the existing Compose commands and
this table are sufficient, and a script would add a second, more
dangerous way to do the same thing.

### Clean recreation after a reset

Everything needed to come back is committed; no manual data restoration
step exists or is required.

```bash
docker compose -p relis -f docker-compose.yml up -d --build
```

That alone recreates, from committed configuration plus the documented
local setup (`cp .env.example .env`, see "Prerequisites"):

1. Both named volumes, empty, under the same names.
2. An initialised PostgreSQL cluster. Because the data directory is empty
   again, the official image runs its own first-init sequence: it creates
   `POSTGRES_DB` (the Control DB) and then runs everything in
   `/docker-entrypoint-initdb.d`, so
   `docker/postgres/init/01-create-project-test-database.sh` recreates
   the project-test database too.
3. A fresh single-node SeaweedFS instance with no buckets and no objects.
4. `migrate-control` and `migrate-project`, each running the existing
   migration entry point against its own target (see "Database
   isolation").

Verify with the same read-only commands used to inspect any startup —
`docker compose -p relis -f docker-compose.yml ps` and the `/api/health`
endpoint through nginx.

**Honest limitations of "recreated":**

- **The databases come back empty, and that is all they can be.** Both
  `packages/database/prisma/control/schema.prisma` and
  `.../project/schema.prisma` define **zero models** and have **no
  `migrations/` directory**, so `migrate-control`/`migrate-project` have
  nothing to apply: they validate the connection contract and exit 0.
  Recreation restores *databases*, not a schema — there is no business
  schema to restore, and none is added here.
- **No seed data of any kind.** Nothing repopulates application content
  after a reset; any fixture you had is gone for good. Test fixtures are
  created by the tests that need them.
- **No backup or restore.** Not implemented, not planned in this slice.
  If local data matters to you, do not reset.
- **`docker/postgres/init/` only runs on a genuinely first init** — i.e.
  against an empty data directory. Changing `POSTGRES_DB` or
  `PROJECT_TEST_DB_NAME` while `relis_postgres-data` still exists does
  **not** create the newly-named database; the init scripts are simply
  not re-run. Either create it manually or reset the volume (destroying
  the existing data) for the new name to take effect.
- **No per-project provisioning.** `relis_project_example` is a single
  disposable project-test target, not a per-project database factory.
  Creating a database per real review project is a separate, unimplemented
  feature.
- **A volume's on-disk format belongs to the image that wrote it.** Data
  written by `postgres:17-alpine` or `chrislusf/seaweedfs:3.71` is not
  guaranteed readable after a major version change of either image; a
  reset is the expected remedy in that case, since this data is
  disposable.

## Known limitations (read before relying on this stack)

- **`apps/worker` does not process jobs, in any mode.** Its `dev` command
  (`tsx watch`) keeps the container's process alive (the watch supervisor
  stays running after the wrapped script's own log-and-return), but that
  liveness is **not** evidence of job processing — there is no queue
  consumer. The background-job backend (`pg-boss` vs. `BullMQ`) remains
  undecided (`context/stack.yml`); no Redis or other BullMQ-only
  dependency was added here on an assumption. `worker` intentionally has
  **no Compose healthcheck** — fabricating one would misrepresent this.
- **No application storage or mail adapter exists.** `storage` (SeaweedFS)
  and `mailhog` are real, running infrastructure services — reachable,
  credentialed (storage), and usable for manual inspection — but nothing
  in `apps/api`/`apps/worker` talks to either yet. Implementing those
  adapters is explicitly out of scope for this sub-issue.
- **Image tags: verified by real execution.** `postgres:17-alpine`,
  `nginx:1.27-alpine`, `mailhog/mailhog:v1.0.1`, and
  `chrislusf/seaweedfs:3.71` all pulled successfully from Docker Hub
  during the sub-issue #47 real verification. No longer a documentation
  caveat.
- **`mailhog` intentionally has no Compose `healthcheck:`.** MailHog's
  official image is commonly built as a minimal/near-scratch Go binary
  with no shell or `wget` bundled. Rather than ship a healthcheck command
  that might simply fail with "not found" (and be misread as "the
  service is unhealthy"), readiness is instead polled with a plain HTTP
  request from the test client's own side (`waitForHttpOk` in
  `packages/test-utils/src/docker-compose.ts`, used by
  `stack-smoke.test.ts`) — confirmed working this way against the real
  container.
- **Two healthcheck defects were found and fixed by real verification**
  (both reproducible, not transient):
  - `nginx`'s healthcheck used `http://localhost/nginx-health`.
    `nginx:alpine`'s musl resolver returns `::1` before `127.0.0.1` for
    "localhost" inside the container, and this `nginx.conf`'s `listen
    80;` only binds IPv4 — so the healthcheck connection was refused even
    though nginx was serving correctly. Fixed by targeting `127.0.0.1`
    explicitly. Confirmed to not affect host access or
    container-to-container traffic (neither ever addresses this service
    as "localhost").
  - `storage` (SeaweedFS)'s healthcheck targeted the master's
    `/cluster/status` on port 9333, which becomes ready slightly before
    its S3 gateway (port 8333) finishes connecting to the filer
    internally — confirmed via that container's own startup logs. Docker
    reported "healthy" in that narrow window, and a real signed PUT
    issued right after got the connection closed by the server with no
    HTTP response at all (`SocketError: other side closed`). Fixed by
    checking the S3 gateway's own port directly (`nc -z 127.0.0.1 8333`
    — BusyBox `wget`'s exit code cannot distinguish "got a 403" from
    "connection refused," and `curl` is not present in this image, both
    confirmed by direct inspection).
- **The SeaweedFS SigV4 signer: verified against a live server.**
  `packages/test-utils/src/s3-sigv4.ts` implements AWS Signature Version
  4 (Node's built-in `crypto` only, no new dependency). A real signed PUT
  + GET round-trip against the actual running `storage` container
  succeeded byte-for-byte (after the healthcheck fix above, and after
  adding an explicit `createBucket` call before the upload — see
  `packages/test-utils/src/s3-sigv4.ts` and `stack-smoke.test.ts`;
  SeaweedFS auto-vivifies a bucket on first PUT, but explicit creation
  does not rely on that server-specific behavior).
  `docker/storage/s3-identities.json`'s schema
  (`identities`/`credentials`/`actions`) and the `-s3.config` flag both
  worked as written — no changes were needed there.
- **A dependency-unavailable Prisma failure reveals the target host,
  port, database name, and schema — but not the embedded credentials.**
  Reproduced directly: stopping `postgres` and running `migrate-control`
  against it produces Prisma's own real error —
  `` Datasource "db": PostgreSQL database "relis_control", schema "public" at "postgres:5432"
  Error: P1001: Can't reach database server at `postgres:5432` `` — which
  is **not** as strictly secret-free as this project's own
  `ConfigValidationError` diagnostics (which never reveal any part of a
  value, only variable names/categories): it does echo the database name
  and host:port parsed out of the connection string. It does **not**
  echo the username or password. This is real Prisma CLI behavior,
  unchanged and out of scope to alter here; documented precisely rather
  than assumed.
- **Graceful shutdown: observed clean across every real test run, exact
  signal chain not individually instrumented.** `docker compose down`
  completed successfully (containers stopped and removed, no forced
  escalation observed) across roughly a dozen real `composeUp`/
  `cleanupComposeProject` cycles during verification, including after
  deliberately-failing scenarios. Whether `pnpm`'s own process forwards
  `SIGTERM` to the underlying `tsx watch`/`next dev`/`run.mjs` child via
  the same path as `apps/web/scripts/run.mjs`'s own signal-forwarding
  logic specifically (as opposed to Docker's own escalation to `SIGKILL`
  after its stop grace period) was not individually isolated or timed.

## Tests

`tests/integration/docker-compose/`:

- `compose-config.test.ts` — `docker compose config --quiet` resolves the
  whole stack with no missing references, printing nothing (so no
  resolved placeholder value is echoed).
- `stack-smoke.test.ts` — brings up the full disposable stack (unique
  project name) and verifies:
  - `migrate-control`/`migrate-project` actually **exit 0** (`docker
    inspect`'s real `State.ExitCode`, via `waitForExitCode` — not "a
    database with the matching name exists," which `docker/postgres/init/`
    creates unconditionally regardless of whether either migration
    container ever runs or succeeds), and the two databases they target
    are genuinely isolated (a table created in one is absent from the
    other).
  - `/api/health`/`/api/ready` reachable only through nginx.
  - **[Configuration + host-side connectivity only — NOT a browser check]**
    the frontend's **actual** `NEXT_PUBLIC_API_URL` — read back from the
    real running `web` container via `printenv`, not assumed — equals the
    real nginx port, and a plain Node `fetch` (issued by the TEST
    PROCESS, not a browser) to that same URL succeeds through the proxy.
    This proves the baked-in configuration is correct and reachable; it
    does **not** execute the frontend's own browser JavaScript, so it is
    not evidence that a real browser's request succeeds or that the UI
    reaches its success state. That claim is proved separately, with an
    actual browser, by `tests/e2e/docker-compose/web-health-check.spec.ts`
    (see below) — an earlier version of this test's name and comments did
    not make that distinction clearly enough.
  - `apps/worker`'s container is actually `running` (the `tsx watch`
    supervisor's liveness) and its startup log line is present —
    explicitly not treated as evidence of job processing.
  - MailHog's UI reachable; a real signed SeaweedFS S3 PUT + GET
    round-trip.
  - `NGINX_HTTP_PORT` is chosen as a REAL free port with `getFreePort()`
    **before** `docker compose up` runs — not the host-port-`0`
    "discover the real port afterward" pattern still used for
    `MAILHOG_UI_PORT`/`SEAWEEDFS_S3_PORT`. An earlier version of this
    test used `0` for `NGINX_HTTP_PORT` too, which — because that
    variable is baked directly into `NEXT_PUBLIC_API_URL` on the `web`
    service at container start — baked the broken value
    `http://localhost:0/api` into the running container. See
    `getFreePort`'s doc comment in `packages/test-utils/src/docker-compose.ts`.
- `config-validation.test.ts` — `migrate-control` run with a missing, then
  an invalid, `CONTROL_DATABASE_URL` (via `docker compose run -e ...
  --no-deps -T`, never touching a real database) — both blocked before
  Prisma runs. The `CONFIG_INVALID` diagnostic is asserted on **stderr**
  (where `console.error` actually writes it — an earlier version of this
  test incorrectly checked stdout, where it never appears), with both
  streams checked for a leaked raw value. `-T` (no pseudo-TTY) is required
  for `docker compose run` to keep stdout/stderr separate at all; without
  it they would be merged into one stream.
- `dependency-unavailable.test.ts` — explicitly starts `postgres` (plus
  `nginx`/`api`; an earlier version only requested `["nginx"]`, which
  never actually started `postgres` at all, since nothing in nginx's own
  `depends_on` chain — `web`/`api` — depends on it, making the subsequent
  wait for it hang until its own timeout), waits for it to genuinely
  report healthy, THEN stops it, then runs `migrate-control` against the
  now-unreachable (but validly configured) target. The failure is
  asserted to actually be a database-connectivity error (Prisma's `P1001`
  code, or a connection-refused-style fallback — not executed against a
  real Prisma CLI in this environment, so the exact text could not be
  confirmed), not merely "any nonzero exit." Separately asserts `apps/api`'s
  `/health`/`/ready` still report `"ok"` through nginx, proving — not
  merely asserting — that its static readiness check does not detect the
  outage.

- `persistence.test.ts` — the real disposable-persistence, scoped-reset,
  and clean-recreation check for both named volumes (see
  ["Persistence, lifecycle, and reset"](#persistence-lifecycle-and-reset)).
  Starts only the two services that own data (`postgres`, `storage`), so
  it builds no application image. In order, against the real daemon:
  - The actual volumes Compose created, confirmed by `docker volume
    inspect`'s own `com.docker.compose.project` / `.volume` labels — an
    ownership record, not a name-prefix guess — and asserted not to be
    `external` and not to have existed beforehand.
  - Every bind mount in the **resolved** configuration is read-only
    configuration or an application source directory; nothing writable
    points at a data directory in the working tree, and neither
    `/var/lib/postgresql/data` nor `/data` is bind-mounted. This is the
    structural reason database/object data cannot become a tracked
    repository artifact.
  - The Control DB and project-test database are distinct at the
    connection targets `migrate-control`/`migrate-project` are actually
    configured with (read from the resolved configuration, with
    credentials discarded — see `resolveComposePersistence`), both exist
    on the one server, and a fixture row planted in each is invisible
    from the other **in both directions**.
  - A fixture row and a real signed-S3-uploaded object survive a
    `stop`/`start`, asserted together with the container ids being
    **unchanged** (so this is genuinely a restart).
  - Both survive `down --remove-orphans` (no `--volumes`) followed by
    `up`, asserted together with the container ids having **changed**
    (genuinely recreated) and both volumes still existing in between.
  - `down --volumes` deletes exactly the recorded volumes; a **second,
    independently-named Compose project** running its own `postgres`
    with its own fixture row is then shown to still have its volume and
    its row. Without that second project, "the reset removed only its
    own volumes" would be vacuous on a daemon with nothing else on it.
  - Recreating afterward works from committed configuration alone, both
    databases are provisioned again by the init path, and the prior
    fixture table and object are **gone**.

  Destructive steps are gated: both project names carry a random suffix,
  volume ownership is confirmed by label immediately before the reset
  (`confirmDisposableOwnershipOrStop` throws rather than deleting on an
  assumption), every volume present before the run is asserted to still
  exist after it, all published ports are ephemeral, and deletion is
  only ever a `-p`-scoped `docker compose down --volumes` — never
  `docker volume rm`, never a prune, never a filesystem deletion. The
  `afterAll` hook tears down **both** projects, reports a failure for
  either without discarding the other, and verifies the result
  (this project's volumes gone, every pre-existing volume still there)
  instead of trusting the exit code.
- `persistence-ignore-rules.test.ts` — the repository-hygiene half, and
  the only file here that needs **no Docker daemon** (just `git` and this
  checkout). Read-only Git throughout — `git ls-files`, `git check-ignore
  --no-index`, `git status --porcelain` (helpers in
  `packages/test-utils/src/git.ts`): nothing is ever staged or created to
  probe a rule, and no real secret is written, since `check-ignore
  --no-index` evaluates a path whether or not it exists. Asserts that
  real environment files (root and per-package), generated build output,
  test run output, and the structure-reserved `storage/{uploads,exports,temp}/`
  directories are all ignored; that `.env.example`, the committed
  development configuration (`docker/postgres/init/`,
  `docker/storage/s3-identities.json`, `docker/nginx/nginx.conf`), the
  fixtures, and a `.gitkeep` inside each ignored `storage/` directory all
  stay trackable; that `.env.example` is the only tracked environment
  file and no generated artifact is tracked; that nothing risky is
  sitting untracked in the working tree; and — via `git ls-files -i -c`
  — that **no ignore pattern is broad enough to shadow a tracked source
  file**.

Every file that needs a container runtime gates on a **synchronous**
Docker-availability check (`isDockerAvailableSync`, in
`packages/test-utils`) evaluated at module load so
`describe.runIf`/`skipIf` see the real value during Vitest's collection
pass (an `async` check inside a `beforeAll` is still `false` at that
point, since hooks run after collection — see that function's own
comment). `persistence-ignore-rules.test.ts` is the exception by design:
it needs only `git`, and gates on `isGitRepository` instead. This stack
was first authored in an environment with no Docker at all, where every
one of those suites was skipped by necessity. It was **later verified by
real execution** once Docker Desktop (with a Linux-container engine)
became available: all six files now pass for real — see the final
reports for sub-issues #47 and #48 for exact commands, exit codes, and
the two real defects #47's verification found and fixed (both now
described in "Known limitations" above, not as open questions).

### Cleanup robustness

Every file above (plus the e2e spec below) tears down its own Compose
project with `cleanupComposeProject` (`packages/test-utils/src/docker-compose.ts`),
not a bare `composeDown` call: it THROWS, naming the exit code and
output, if cleanup itself fails, rather than discarding that failure
silently. This never masks an earlier `beforeAll`/test failure — Vitest
(and Playwright, for the e2e spec) report a hook failure as its own,
separate failure, not a replacement for one already recorded. Every
cleanup call is still scoped to exactly its own uniquely-named project
(`docker compose -p <project> down --volumes --remove-orphans`), never
touching another project's containers, network, or volumes.
`config-validation.test.ts` previously had no cleanup step at all, even
though `composeRun`'s `--rm` only removes the one-off container it
creates — the project's implicitly-created network (Compose creates this
for any command in a project, `run` included) was being left behind. It
now cleans up too.

`persistence.test.ts` extends the same contract to two projects at once
(its own and its bystander) and additionally verifies the cleanup's
RESULT rather than its exit code: afterward, no volume may still carry
either project's label, and every volume that existed before the run
must still exist. It is also the one file that calls a deliberately
NON-destructive `down` mid-test (`composeDownKeepVolumes` —
`--remove-orphans` without `--volumes`), which is the lifecycle step
whose whole point is that data survives it; its `afterAll` cleanup is
still the `--volumes` form.

**Verified by real execution:** across every real test run during
sub-issue #47's and #48's verification (stack-smoke, config-validation,
dependency-unavailable, persistence, the e2e spec, plus several manual
debug sessions), `docker ps -a`, `docker network ls`, and `docker volume
ls` showed zero leftover containers, networks, or volumes afterward — in
both the normal-completion and the deliberately-failing scenarios, and
after the deliberate reset in `persistence.test.ts`. Built
images are NOT removed by `docker compose down` (expected, standard
behavior — they are a build cache, not disposed with the project);
cleaning those up, when desired, is a separate, manual step outside this
cleanup contract.

### End-to-end (real browser)

`tests/e2e/docker-compose/web-health-check.spec.ts` (Playwright — the
framework prescribed by `context/stack.yml`): brings up an isolated
Compose project (`nginx` + its `web`/`api` dependencies only; a real
free `NGINX_HTTP_PORT` from `getFreePort()`, same reasoning as above),
navigates an actual Chromium browser to `http://localhost:<port>/`
(not `127.0.0.1` — see the spec file's own comment: the page and its API
calls must share the exact origin `NEXT_PUBLIC_API_URL` uses, or the
browser would treat the frontend's own request as cross-origin and
`API_CORS_ORIGIN` would not allow it), and:

- Observes, via Playwright's real network APIs, the **actual** request
  `apps/web/src/app/page.tsx`'s unmodified client-side `checkApi()`
  issues on mount, asserting it targets the expected proxy URL
  (`http://localhost:<port>/api/health`) and receives a real `200`
  `{"status":"ok",...}` response.
- Asserts the corresponding real rendered UI state ("API connectée ✓"
  becoming visible) — the application's own success path, not a value
  the test computed.

The application's request is never replaced with a test-issued one, and
the API is never mocked. This is the proof the Node-`fetch`-based check
in `stack-smoke.test.ts` (above) explicitly does **not** provide.

Requires BOTH a reachable Docker daemon and Playwright's Chromium browser
actually installed. **Verified by real execution**: with both installed
and Docker Desktop's Linux-container engine running, `pnpm run test:e2e`
passed — a real Chromium instance loaded the page through nginx, observed
the frontend's own unmodified `fetch(`${NEXT_PUBLIC_API_URL}/health`)`
request actually reach `apps/api` through the proxy with a real `200
{"status":"ok"}` response, and confirmed "API connectée ✓" rendered. No
code changes were needed to make this pass — see the final report for
sub-issue #47. (An earlier run of this document, before Docker/Chromium
were available, reported this as `1 skipped` with the Docker check
short-circuiting first; that no longer applies.)
