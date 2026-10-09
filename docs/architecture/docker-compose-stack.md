# Local Docker Compose stack

Implements local sub-issues [02.02 — Define services and shared
configuration, including the Control DB and per-project test
databases](../../../context/notion-tasks/sub-issues/02-02.md),
[02.03 — Configure local persistent volumes and exclude them from version
control](../../../context/notion-tasks/sub-issues/02-03.md),
[02.04 — Expose health/readiness through the local proxy and restrict
database and storage port exposure](../../../context/notion-tasks/sub-issues/02-04.md),
and [02.05 — Document startup, diagnostics, and local access to
MailHog/Mailpit and job
observability](../../../context/notion-tasks/sub-issues/02-05.md)
(parent: [02 — Add Docker Compose local
stack](../../../context/notion-tasks/02-docker-compose.md)).
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

Implements local sub-issue [02.05](../../../context/notion-tasks/sub-issues/02-05.md)'s
"reproducible startup" requirement. What you actually need depends on
which of the two local-development paths you're using — this repository
has **two independent** ones (see `README.md` "Docker Compose (local
stack)" vs. its earlier "Deployment"/native sections): running the Docker
Compose stack below, or running tests/applications directly on the host
(`pnpm dev`, `pnpm test`, `pnpm run test:e2e`, `node tooling/scripts/deploy.mjs`).

| | Docker-only startup (`docker compose up`) | Running tests or applications directly on the host |
| --- | --- | --- |
| Docker Engine + Compose V2 plugin | **Required.** | Required only for `pnpm run test:integration` (and the integration suites under `tests/integration/docker-compose/`), which spawn real disposable Compose projects. Not required for `pnpm -r test` (package unit suites) or running an app's own `dev`/`start` natively. |
| Node.js | **Not required on the host at all.** Each of `web`/`api`/`worker`'s images installs its own Node 22 runtime (`node:22-bookworm-slim` — see each `docker/*/Dockerfile`'s `FROM` line) and its own dependencies at **image-build time** (`pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`, inside the container). | **Required**, matching this repository's own `package.json` `engines.node` field: `>=22.15`. |
| pnpm | Not required on the host — each image installs its own pnpm via Corepack during the build. | **Required**, pinned exactly by `package.json`'s `packageManager` field: `pnpm@11.17.0`. |
| Playwright's Chromium browser | Not required unless you also run `tests/e2e/docker-compose/` (below). | Required only for `pnpm run test:e2e` — install explicitly with `pnpm exec playwright install chromium` (this repository's tooling never installs it on your behalf automatically). |

(Versions above are read directly from this repository's own
`package.json`/Dockerfiles, not invented — re-check those files if this
document and the code ever disagree.) Docker Engine itself, the Compose
plugin, and a Linux-container backend are **verified by real execution**
in the environment used for this sub-issue's own verification pass
(`docker --version` → Docker Engine `29.8.2`; `docker compose version` →
Compose plugin `v5.5.1`; Windows host, WSL2/Linux-container engine) — the
exact versions your own host reports may differ; what matters is the
Compose **V2** CLI plugin (the `docker compose` subcommand), never the
legacy standalone `docker-compose` V1 binary, with a Linux-container
backend (Windows containers are not supported here).

- Copy `.env.example` to `.env` at the repository root (same convention as
  the existing runtime-config setup — see `README.md` "Runtime
  configuration"). Every value in it is a development-only placeholder,
  safe to commit as an example and safe to use unmodified for ordinary
  local development.

### Compose interpolation vs. application environment loading — two SEPARATE mechanisms

This root `.env` file and `@relis/config`'s own `loadEnvFiles` (documented
in `README.md` "Environment loading and override precedence") are **not
the same mechanism**, and confusing them is the single most common source
of "I changed `.env` but nothing happened" confusion with this stack:

- **Compose interpolation** (what the root `.env` actually feeds): `docker
  compose` itself reads `.env` from the current directory **on the host**,
  purely to resolve `${VAR:-default}` placeholders written directly in
  `docker-compose.yml` — e.g. `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `NGINX_HTTP_PORT`, `MAILHOG_UI_PORT`, `SEAWEEDFS_S3_PORT`,
  `PROJECT_TEST_DB_NAME`. This happens entirely before any container
  starts, and the resolved values are then baked into each service's
  `environment:` block as literal values.
- **Application environment loading** (`@relis/config`'s `loadEnvFiles`,
  used by `apps/api`/`apps/web`/`apps/worker`'s own entry points): reads
  `.env*` files from **inside the running process's own filesystem** —
  the application root and the owning package directory. Verified by
  direct inspection of this repository's build context: `.dockerignore`
  explicitly excludes `.env`/`.env.*` (keeping only `.env.example`) from
  every image's build context, and no service in `docker-compose.yml`
  declares an `env_file:` directive or bind-mounts the root `.env` into
  any container. **The root `.env` file therefore never reaches
  `loadEnvFiles` inside any of the three app containers at all** — every
  value that process needs (`NODE_ENV`, `API_PORT`, `API_HOST`,
  `API_CORS_ORIGIN`, `WEB_PORT`, `NEXT_PUBLIC_API_URL`) is instead set
  directly as a literal in that service's own `environment:` block in
  `docker-compose.yml` (itself possibly built from a Compose-interpolated
  value, e.g. `NEXT_PUBLIC_API_URL: http://localhost:${NGINX_HTTP_PORT:-8080}/api`
  — one mechanism feeding the other, not the same mechanism twice).
- **Consequence:** adding a NEW variable to your root `.env` and expecting
  `apps/api`/`apps/web`/`apps/worker` to see it via `loadEnvFiles` **will
  not work** inside this Compose stack — it would only work for a
  natively-run process (`pnpm --filter "./apps/api" dev`, outside Docker).
  To change what a containerized service's OWN code sees, add or change
  it in that service's `environment:` block in `docker-compose.yml`
  (optionally still sourced from a Compose-interpolated `${VAR}`).

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
cd relis                 # the application root — every command below assumes this working directory
cp .env.example .env     # once, if not already done
docker compose up --build
```

First run pulls four base images (`postgres:17-alpine`, `nginx:1.27-alpine`,
`mailhog/mailhog:v1.0.1`, `chrislusf/seaweedfs:3.71` — all **verified to
pull successfully** during this and earlier sub-issues' real
verification) and builds `web`, `api`, and `worker`'s own three images
locally, each of which installs the full pnpm workspace and bakes an
initial `@relis/config` build (see "Clean-checkout startup" below). How
long this takes is **not something this document promises a fixed
duration for** — it depends on your network speed (image pulls, registry
reachability) and host CPU/disk speed (three `pnpm install
--frozen-lockfile` runs), and Docker's own layer cache means a *second*
run of this exact command, even after `git clean`-ing the working tree,
can be meaningfully faster than the first if the underlying Dockerfile
layers haven't changed. Subsequent runs can drop `--build` unless
`package.json`/`pnpm-lock.yaml` changed.

### What a successful startup actually looks like

Verified by real execution — one real `docker compose up -d --build` run
against a uniquely-named disposable project during this sub-issue's own
verification pass (see "Verification" in the completion report; `ps`
output trimmed to the relevant columns):

```
NAME        STATUS                             PORTS
api         Up 18 seconds (healthy)            3001/tcp
mailhog     Up 17 seconds                      127.0.0.1:<MAILHOG_UI_PORT>->8025/tcp
nginx       Up 16 seconds (healthy)             127.0.0.1:<NGINX_HTTP_PORT>->80/tcp
postgres    Up 17 seconds (healthy)             5432/tcp
storage     Up 18 seconds (health: starting)   127.0.0.1:<SEAWEEDFS_S3_PORT>->8333/tcp
web         Up 17 seconds (healthy)             3000/tcp
worker      Up 17 seconds                       (no port, no health column at all)
```

A few seconds later, `storage` converges to `(healthy)` too (its
healthcheck has a `start_period` — see "Known limitations" for the two
real healthcheck defects already found and fixed here). `migrate-control`
and `migrate-project` are **not** in this list at all once they've
finished — `docker compose ps` (with no `-a`) only shows currently-running
containers, and both are one-shot services that **exit** on success:

```bash
docker compose -p relis -f docker-compose.yml ps -a migrate-control migrate-project
# STATUS column reads "Exited (0) ..." for both once provisioning succeeds
```

Three distinct "no health information" shapes exist, by design, and all
three are expected — **none of them is a failure**:

- `worker` has **no `healthcheck:` block at all** in `docker-compose.yml`
  (deliberately — see "Job observability" below for why fabricating one
  would misrepresent what this service actually does) — its `ps` row
  shows no health annotation.
- `mailhog` **has no `healthcheck:` block either** (its official image is
  a near-scratch Go binary with no shell/`wget` bundled — see "Known
  limitations") — same bare "Up ..." row, no health annotation.
- `migrate-control`/`migrate-project` have no `healthcheck:` either, but
  for a different reason: they are not long-running services to probe —
  success is their own process exiting `0`.

Through the proxy, immediately after `nginx` itself reports `(healthy)`.
**Discover the actual published address first — never assume
`localhost:8080`.** `NGINX_HTTP_PORT:-8080` is a default written directly
inside `docker-compose.yml`; it is resolved by `docker compose` itself
from the root `.env` file (see "Compose interpolation vs. application
environment loading" above), which your shell has **no visibility into
at all** unless you've explicitly exported it there yourself. A shell
expression like `${NGINX_HTTP_PORT:-8080}` in your OWN terminal reads
your shell's environment, not `.env` — if `.env` sets a different port
and that variable was never exported into your shell, the expression
silently falls back to the literal `8080`, which may not be published at
all (**verified by real execution**: with `NGINX_HTTP_PORT=19234` set
only in `.env`, a fresh shell's `${NGINX_HTTP_PORT:-8080}` still resolved
to `8080`, and a request to that address failed to connect — nothing was
listening there). Ask Docker for the real, currently-published address
instead, then use exactly that in every probe below:

**Bash:**

```bash
NGINX_ADDR=$(docker compose -p relis -f docker-compose.yml port nginx 80)
echo "$NGINX_ADDR"   # e.g. 127.0.0.1:19234 — the REAL address, whatever NGINX_HTTP_PORT actually resolved to

curl "http://${NGINX_ADDR}/nginx-health"   # -> 200, body "ok"  (proxy liveness only)
curl "http://${NGINX_ADDR}/api/health"     # -> 200, {"status":"ok","message":"...","service":"api"}
curl "http://${NGINX_ADDR}/api/ready"      # -> 200, {"status":"ok","service":"api","checks":{"network":"ok","cors":"ok"}}
```

**PowerShell:**

```powershell
$NginxAddr = docker compose -p relis -f docker-compose.yml port nginx 80
Write-Host $NginxAddr   # e.g. 127.0.0.1:19234

Invoke-WebRequest "http://$NginxAddr/nginx-health" -UseBasicParsing
Invoke-WebRequest "http://$NginxAddr/api/health" -UseBasicParsing
Invoke-WebRequest "http://$NginxAddr/api/ready" -UseBasicParsing
```

Both forms were run against a real, disposable, guarded project with a
deliberately non-default `NGINX_HTTP_PORT` (`19234`, chosen far from the
default specifically to rule out a coincidental match) during this
sub-issue's own verification pass: `docker compose port nginx 80` printed
`127.0.0.1:19234`, and every probe against that discovered address
returned `200` in both Bash and PowerShell. Open the same discovered
address in a browser (`http://<discovered-address>/`) for the application
itself.

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

## Local access quick reference

Implements local sub-issue [02.05](../../../context/notion-tasks/sub-issues/02-05.md).
Every row's "Purpose" and "Limitation" is traceable to a specific section
below (or to "Known limitations") — this table is a map, not a
replacement for reading those sections before relying on any of this for
more than a quick lookup.

| URL / address | Host-facing or internal-only? | Purpose | Limitation |
| --- | --- | --- | --- |
| `http://localhost:${NGINX_HTTP_PORT:-8080}/` | Host-facing, loopback only | The application itself (served by `web`, via nginx). | None beyond normal app behavior — not this sub-issue's concern. |
| `http://localhost:${NGINX_HTTP_PORT:-8080}/nginx-health` | Host-facing, loopback only | **Proxy liveness only.** | Does **not** mean `web`/`api` are reachable or ready — see "Health and readiness" below. |
| `http://localhost:${NGINX_HTTP_PORT:-8080}/api/health` | Host-facing, loopback only | `apps/api`'s liveness route, through the proxy. | Not a dependency check of any kind — see "Health and readiness" below. |
| `http://localhost:${NGINX_HTTP_PORT:-8080}/api/ready` | Host-facing, loopback only | `apps/api`'s readiness route, through the proxy. | Reports **network/CORS initialization only** — never database or queue readiness, because `apps/api` has neither integrated. See "Health and readiness" below. |
| `http://127.0.0.1:${MAILHOG_UI_PORT:-8025}/` | Host-facing, loopback only | MailHog's real mail-capture UI (verified identity, not an arbitrary `200` — see "Mail capture" below). | Development-only tooling, not a product feature. No application mail adapter exists to send anything to it yet — see "Mail capture" below. |
| `http://127.0.0.1:${SEAWEEDFS_S3_PORT:-8333}/` | Host-facing, loopback only | SeaweedFS's S3-compatible gateway (credentialed — `docker/storage/s3-identities.json`). | Development-only infrastructure. No application storage adapter exists yet. |
| `api:3001`, `web:3000`, `postgres:5432`, `mailhog:1025` (SMTP), `storage:9333`/`8888` (SeaweedFS master/filer) | **Internal only** — Compose network hostnames | Container-to-container addressing. | Never reachable from the host browser/shell at all; reaching them requires `docker compose exec` into a container already on the `relis` network. See "Host port exposure policy" above for why this is deliberate, and its own explicit statement that Docker's internal network is not a security boundary against the host administrator. |
| *(no URL — none exists)* | n/a | Job/queue observability. | **No such endpoint exists anywhere in this stack.** See "Job observability" below — do not go looking for one. |

## Health and readiness — verified URLs and their actual meaning

Implements local sub-issue [02.04](../../../context/notion-tasks/sub-issues/02-04.md).
Every URL below is reached through the proxy only — `apps/api`'s own port
(`3001`) is never published to the host (see "Host port exposure policy"
below).

| URL | Reaches | Meaning — verified by reading the actual route/behavior, not assumed |
| --- | --- | --- |
| `http://127.0.0.1:${NGINX_HTTP_PORT:-8080}/nginx-health` | nginx itself (not proxied — a dedicated `location` in `docker/nginx/nginx.conf`) | **Proxy liveness only.** Always `200 ok` whenever the nginx process is up, regardless of whether `web`/`api` are reachable. **Never treat this as application readiness** — `proxy-health.test.ts` proves it stays `200 ok` even while the `api` upstream is stopped. |
| `http://127.0.0.1:${NGINX_HTTP_PORT:-8080}/api/health` | `apps/api`'s existing `GET /health` (`apps/api/src/app.ts`), via the `/api/` prefix (stripped by nginx) | `200 {"status":"ok","message":"...","service":"api"}` whenever the API process can respond at all. Not a dependency check of any kind. |
| `http://127.0.0.1:${NGINX_HTTP_PORT:-8080}/api/ready` | `apps/api`'s existing `GET /ready` | `200 {"status":"ok","service":"api","checks":{"network":"ok","cors":"ok"}}`. This is the **entire, existing** readiness contract — it reports only that the process itself initialized its network/CORS configuration. It does **not** check PostgreSQL, the worker, or any queue, because `apps/api` has no such dependency in code today. `dependency-unavailable.test.ts` proves this stays `"ok"` even with `postgres` stopped — a documented limitation, not a bug introduced by this sub-issue. No database-readiness semantics are invented here. |

### Behavior when the API upstream itself is unreachable

**Verified by real execution** (`proxy-health.test.ts`): stopping `api`
(`docker compose stop api`, the upstream nginx proxies to — distinct from
stopping a *downstream* dependency of the API, which is what
`dependency-unavailable.test.ts` covers instead) does **not** produce an
instant failure. `docker/nginx/nginx.conf`'s `proxy_pass http://api:3001/;`
uses a static hostname, so nginx resolves and caches that hostname's IP
once, at nginx's own startup, and does not re-resolve per request. After
`api` stops, nginx's cached route to it is dead, and packets toward it are
dropped rather than refused — so nginx hits its own default
`proxy_connect_timeout` (60s; not overridden in this minimal dev config)
before responding `504 Gateway Timeout`. Either way, the response:

- Is always a `5xx`, never a false `200`.
- Is never `apps/web`'s rendered homepage — the browser-facing `/` route
  and the `/api/` route fail independently of each other, proved by `web`
  staying reachable (`200`) throughout the same test.
- Never causes `/nginx-health` to report anything other than `200 ok` —
  proxy liveness and application readiness are, and must stay, unrelated
  signals.

Restarting the upstream (`docker compose start api`) is observed to
recover within the existing success contract above, confirmed by bounded
polling (`waitForHttpStatus`, `packages/test-utils/src/docker-compose.ts`) —
not merely asserted from the restart command's own exit code.

## Host port exposure policy

Implements local sub-issue [02.04](../../../context/notion-tasks/sub-issues/02-04.md),
building on the service graph above.

- **`api`, `web`, `postgres`, `worker`, `migrate-control`, `migrate-project`
  publish NO host port at all.** They declare no `ports:` entry in
  `docker-compose.yml`, and `port-exposure.test.ts` confirms this at both
  the resolved `docker compose config` level and against real (or, for the
  two one-shot migration services, real-but-already-exited) containers'
  `docker inspect`-reported `HostConfig.PortBindings` — not merely the
  static file, and not merely "the container didn't crash."
- **`nginx`, `mailhog` (UI only), and `storage` (S3 gateway only) are the
  only approved host-published development endpoints, and every one binds
  to `127.0.0.1` — loopback — only.** Never `0.0.0.0`, never `::`, never an
  unspecified host IP (Docker's own shorthand for "every interface").
  `port-exposure.test.ts` asserts this against the real running
  containers' actual bindings, not just the compose file's intent.
- **SMTP (`mailhog:1025`) and the storage administration ports (SeaweedFS
  master `:9333`, filer `:8888`) are never published.** No application
  mail or storage adapter exists yet to use them from outside the Compose
  network (see "Known limitations"), and nothing in this sub-issue adds
  one.
- **Docker's internal bridge network is not, and is never claimed to be, a
  security boundary against the host administrator.** Isolating
  container-to-container traffic on the `relis` network keeps *other
  containers on a different Compose project* from reaching `api`/`postgres`/
  `worker` directly, but anyone with access to the Docker daemon on this
  host (another `docker run --network`, `docker exec`, etc.) can still
  reach any internal service regardless of whether it publishes a host
  port. The loopback-only publish rule above is the actual, and only,
  host-facing boundary this sub-issue establishes and verifies.

## Mail capture

Implements local sub-issue [02.05](../../../context/notion-tasks/sub-issues/02-05.md).
MailHog is prescribed by `context/project-structure.md`'s required
`docker/mailhog/` entry — it is this stack's mail-capture tool, not an
open MailHog-vs.-Mailpit choice still to be made (the parent task's own
language mentions "MailHog/Mailpit" generically, but the structure
document already settled it, and `docker-compose.yml` already runs
`mailhog/mailhog:v1.0.1`).

- **URL:** `http://127.0.0.1:${MAILHOG_UI_PORT:-8025}/` (loopback-only —
  see "Host port exposure policy" above).
- **Verified to actually be MailHog's own interface, not merely an
  arbitrary `200`.** `stack-smoke.test.ts` checks two signals specific to
  the real `mailhog/mailhog:v1.0.1` image (confirmed by direct inspection
  of a live container during this task), not a generic status code:
  - The root page's `<title>MailHog</title>` and `ng-app="mailhogApp"` —
    markup unique to MailHog's own Angular UI shell.
  - `GET /api/v2/messages` returns MailHog's own distinctive JSON shape
    (`{"total":0,"count":0,"start":0,"items":[]}` against a fresh
    instance) — MailHog's real message-listing API, not a page that
    merely looks like a mail client.
- **Distinguish "MailHog is running and reachable" from "the application
  sends mail through it" — the second does NOT exist.** Searching
  `apps/api`/`apps/web`/`apps/worker` finds no mail-sending code, no SMTP
  client dependency, and no `mail/` module anywhere in this checkout (the
  structure document reserves such a module's location, but it has not
  been created) — there is no application-level mail adapter to verify,
  and none is implemented by this sub-issue. The empty `items: []` above
  is therefore the **correct**, expected state: nothing has ever been
  sent to it, by this stack or by the application.
- **Why this task does not go further and send a real test email through
  SMTP:** MailHog's SMTP port (`mailhog:1025`) is deliberately
  **internal-only** (see "Host port exposure policy" above) — reaching it
  would require executing a raw SMTP conversation from inside another
  container on the `relis` network (e.g. via `docker compose exec`),
  which was judged disproportionate complexity/risk for marginal
  additional evidence beyond the two MailHog-specific signals above, and
  is explicitly out of this sub-issue's scope ("Do not implement email
  delivery"). The two checks above already distinguish MailHog's real
  identity/API from an arbitrary `200` without touching SMTP at all.
- **Development-only tooling, not a product feature.** MailHog exists so
  a developer can *manually* inspect what an application would have sent,
  once a mail adapter exists — it ships with this stack regardless of
  whether anything is using it yet (see
  `docs/architecture/local-stack-inventory.md` §9 for the same
  distinction, drawn independently during the preceding sub-issue).

## Job observability

Implements local sub-issue [02.05](../../../context/notion-tasks/sub-issues/02-05.md).
**No job-observability endpoint of any kind exists in this stack** —
there is no dashboard, no HTTP status page, and no API to query job
state. This was verified by inspection, not assumed:

- `apps/worker/src/main.ts` (reproduced in full below) opens **no network
  listener at all**, in either `dev` or `start` mode — it loads and
  validates configuration, logs one line, and returns:

  ```ts
  function main(): void {
    loadEnvFiles(resolveRuntimeMode(process.env.NODE_ENV));
    loadValidatedConfig();
    console.log("ReLiS worker started");
  }
  ```

- `docker-compose.yml` assigns `worker` no internal port, no published
  host port (independently confirmed by the real running-container check
  in `port-exposure.test.ts`, sub-issue 02.04), and no `healthcheck:`
  block — there is no address to query even if you wanted to.
- No other service in this stack (`api`, `web`, `nginx`, `postgres`,
  `storage`, `mailhog`) exposes anything job-related either; `apps/api`'s
  `/ready` explicitly reports only `network`/`cors`, never a queue check
  (see "Health and readiness" above).

**The only observability actually available is process-level, via
Docker itself — not application-level:**

```bash
docker compose -p relis -f docker-compose.yml ps worker      # container lifecycle status (no health column — see "What a successful startup actually looks like")
docker compose -p relis -f docker-compose.yml logs worker    # expect exactly one line: "ReLiS worker started"
docker inspect <worker-container-id> --format '{{.State.Status}}'   # "running" in dev mode (tsx watch's supervisor)
```

**This process-level liveness is explicitly NOT evidence that any job was
consumed or completed — there is no job to consume.** `worker`'s `dev`
command (`tsx watch`) keeps its OS process alive by virtue of being a
*file-watching supervisor*, not because it is waiting on or processing
work; `start` mode runs the identical application logic to completion and
exits. Neither mode polls, subscribes to, or drains any queue, in either
mode, today. Treat `ps`/`logs` output here the same way you'd treat
"the lights are on" — informative about the process, silent about work.

- **The background-job technology (`pg-boss` vs. `BullMQ`) remains
  undecided**, per `context/stack.yml`'s `background_jobs.status:
  undecided`, and this sub-issue does not select or implement one (out of
  scope by the task's own instruction).
- **`pg-boss@^12.26.3` is a declared dependency of `apps/worker`
  (`apps/worker/package.json`) but is imported and used nowhere in
  `apps/worker/src`** — confirmed by searching the source tree during
  this task (zero matches outside `package.json` itself and generated
  `dist/`/`node_modules/` output). A dependency's presence in
  `package.json` is not evidence of an implemented queue integration; see
  `docs/architecture/local-stack-inventory.md` §3.3/§8 for the identical
  finding, reached independently during the preceding sub-issue.
- **No dashboard URL is documented here because none exists to document.**
  Reporting this absence honestly, rather than inventing a URL or
  building a dashboard to make this section look complete, is this
  sub-issue's explicit instruction.
- **Development-only concern, not a product feature** — once a real
  queue consumer and (optionally) a dashboard are authorized and
  implemented in a future, separately-scoped task, this section should be
  rewritten to describe them; until then, this honest "unavailable" is
  the accurate state.

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

## Diagnostics

Implements local sub-issue [02.05](../../../context/notion-tasks/sub-issues/02-05.md).
Actionable steps for the failure scenarios this sub-issue calls out,
each with a real symptom (several captured from this document's own
real verification pass — see the completion report) and a scoped fix.
**None of these recommends restarting Docker Desktop, deleting
resources, or a broad prune as a routine step** — if a scoped fix below
doesn't resolve it, that is a blocker to report, not a reason to reach
for `docker system prune`.

### Scoped inspection commands (service status, logs, migration exit codes, health/readiness, published ports)

Every command below is scoped to this ONE project (`-p relis`, or
substitute your own `-p` if you started with a different one) and is
read-only — none of them changes any state, so they're always safe to
run first, before anything in the scenario-specific steps below.

**Discover the published port BEFORE probing health/readiness — never
assume `localhost:8080`.** The health/readiness probes below depend on
knowing the real address first, which is exactly why the port-inspection
step comes before them here (not after, as an earlier draft of this
document had it): `${NGINX_HTTP_PORT:-8080}` typed directly into your own
shell reads your shell's environment, never the root `.env` file that
`docker compose` itself resolves it from (see "Compose interpolation vs.
application environment loading" above) — if that variable isn't
separately exported into your shell, the expression silently falls back
to `8080`, which may not be published at all. **Verified by real
execution** against a disposable, guarded project with a deliberately
non-default `NGINX_HTTP_PORT` (`19234`): `docker compose port nginx 80`
printed the real `127.0.0.1:19234`, while a naive, unexported
`${NGINX_HTTP_PORT:-8080}` in a fresh shell still resolved to `8080` and
failed to connect.

**Bash:**

```bash
# Service status at a glance (STATUS column shows "(healthy)", "(health: starting)",
# "Exited (0)" for a successful one-shot migration, or no health annotation at all
# for worker/mailhog/migrate-* — see "What a successful startup actually looks like").
docker compose -p relis -f docker-compose.yml ps        # running services only
docker compose -p relis -f docker-compose.yml ps -a     # include exited ones (migrate-control/migrate-project)

# Logs for one service (add -f to follow).
docker compose -p relis -f docker-compose.yml logs <service>

# A migration's real exit code — not "a database with the right name exists"
# (docker/postgres/init/ creates both databases unconditionally regardless of
# whether either migration container ever runs — see "Database isolation").
docker inspect $(docker compose -p relis -f docker-compose.yml ps -a -q migrate-control) --format '{{.State.ExitCode}}'

# What host port (if any) a service is ACTUALLY published on right now —
# discover this FIRST, then use it below.
NGINX_ADDR=$(docker compose -p relis -f docker-compose.yml port nginx 80)
echo "$NGINX_ADDR"   # e.g. 127.0.0.1:19234 — the REAL address, whatever NGINX_HTTP_PORT actually resolved to

# Health/readiness through the proxy, using the DISCOVERED address (see "Health and readiness" above for what each actually means).
curl "http://${NGINX_ADDR}/nginx-health"
curl "http://${NGINX_ADDR}/api/health"
curl "http://${NGINX_ADDR}/api/ready"

# The more complete picture (every declared container port, including ones NOT
# published at all) — what port-exposure.test.ts itself asserts on:
docker inspect <container-id> --format '{{json .HostConfig.PortBindings}}'
```

**PowerShell:**

```powershell
# Service status, logs, and migration exit code — identical commands, no shell-specific syntax.
docker compose -p relis -f docker-compose.yml ps
docker compose -p relis -f docker-compose.yml ps -a
docker compose -p relis -f docker-compose.yml logs <service>
docker inspect $(docker compose -p relis -f docker-compose.yml ps -a -q migrate-control) --format '{{.State.ExitCode}}'

# Discover the real published address first, then use it.
$NginxAddr = docker compose -p relis -f docker-compose.yml port nginx 80
Write-Host $NginxAddr   # e.g. 127.0.0.1:19234

Invoke-WebRequest "http://$NginxAddr/nginx-health" -UseBasicParsing
Invoke-WebRequest "http://$NginxAddr/api/health" -UseBasicParsing
Invoke-WebRequest "http://$NginxAddr/api/ready" -UseBasicParsing

docker inspect <container-id> --format '{{json .HostConfig.PortBindings}}'
```

### Docker is unavailable

**Symptom:** `docker compose up` (or any `docker` command) hangs or fails
immediately with something like `error during connect` or `the docker
daemon is not running`.

```bash
docker info --format "{{.ServerVersion}}"   # succeeds (prints a version) only if the daemon is actually reachable
```

If this fails: start Docker Desktop (or your Docker daemon) **yourself** —
this is a manual step, never an automated one. Every integration test in
`tests/integration/docker-compose/` detects this the same way
(`isDockerAvailableSync`) and reports a **skip with an explicit blocker
message**, never a silent pass — the same honesty applies here: report
"Docker is unavailable," don't claim the stack was verified.

### A host port is already occupied

**Symptom** (real text captured during this sub-issue's own verification,
starting a second project while the first still held the same port):

```
Error response from daemon: failed to set up container networking: driver
failed programming external connectivity on endpoint ...: Bind for
127.0.0.1:58634 failed: port is already allocated
```

**Fix:** either stop whatever already holds that port, or change the
conflicting variable in your `.env` — `NGINX_HTTP_PORT`, `MAILHOG_UI_PORT`,
or `SEAWEEDFS_S3_PORT` (see "Compose interpolation vs. application
environment loading" above for why editing `.env` is the right lever
here, specifically) — then `docker compose up -d` again. To see what's
already bound before changing anything: `docker compose -p relis -f
docker-compose.yml ps` (another one of YOUR Compose projects) — do not
assume the conflicting port is `8080`; read it from `.env`, or discover
whatever is ACTUALLY published right now with `docker compose -p relis -f
docker-compose.yml port nginx 80` (see "Scoped inspection commands"
above) — or your OS's own port-listing tool for a non-Docker process
(substitute the real port number, e.g. `netstat -ano | findstr :<port>`
on Windows PowerShell/cmd).

### An image build fails

**Symptom:** `docker compose up --build` exits non-zero during the `api`,
`web`, or `worker` image build step (`pnpm install --frozen-lockfile` or
the `@relis/config` build failing inside the Dockerfile).

```bash
docker compose -p relis -f docker-compose.yml build api     # rebuild just one service, full output
docker compose -p relis -f docker-compose.yml build --no-cache api   # rule out a stale cached layer specifically
```

Common causes: no network access to the pnpm/npm registry from inside
the build (registry/proxy/firewall issue on the host), or a genuinely
broken `pnpm-lock.yaml` (should not happen on an unmodified checkout —
`pnpm install --frozen-lockfile` fails loudly rather than silently
resolving different versions if the lockfile and `package.json` disagree).

### Compose configuration itself is rejected

**Symptom** (real text captured during this sub-issue's own verification,
deliberately passing a malformed `NGINX_HTTP_PORT`):

```bash
$ NGINX_HTTP_PORT=not-a-number docker compose -f docker-compose.yml config --quiet
invalid hostPort: not-a-number
```

This fails **before** anything starts — `compose-config.test.ts` asserts
the healthy case prints nothing on success; a non-empty message (as
above) or a non-zero exit from `docker compose config --quiet` means the
resolved configuration itself is invalid. Check whatever `.env` value you
most recently changed first; this is a Compose-level failure, distinct
from an application's own `CONFIG_INVALID` diagnostic (next).

### A migration fails

**Symptom:** `migrate-control` or `migrate-project` exits non-zero
instead of `0`.

```bash
docker compose -p relis -f docker-compose.yml logs migrate-control
docker inspect <container-id> --format '{{.State.ExitCode}}'
```

Two distinct causes this stack's own tests already distinguish — check
which one your log output matches before assuming either:

- **Missing/invalid configuration**, caught BEFORE Prisma ever runs — a
  safe `CONFIG_INVALID` diagnostic naming only the affected variable
  category, never a value (`config-validation.test.ts`'s exact scenario).
  **Fix — inspect and correct the right SOURCE variables; see "Which
  settings actually apply" immediately below before touching `.env` —
  `CONTROL_DATABASE_URL`/`PROJECT_DATABASE_URL` themselves are NOT what
  these two Compose services read `.env` for, and editing them there has
  no effect on this failure.**
- **A valid configuration, unreachable target** — Prisma's own real
  error, e.g. `` Error: P1001: Can't reach database server at
  `postgres:5432` `` (`dependency-unavailable.test.ts`'s exact scenario;
  this does echo the host/port/database name, but never the username or
  password — see "Known limitations"). Fix: confirm `postgres` itself is
  healthy first (`docker compose ps postgres`) — if it isn't, diagnose
  `postgres` itself before retrying the migration.

#### Which settings actually apply, per target — Compose vs. native

**Verified directly against `docker-compose.yml`'s own `migrate-control`/
`migrate-project` service definitions.** Each one's `environment:` block
sets `CONTROL_DATABASE_URL`/`PROJECT_DATABASE_URL` as a literal value
**assembled by Compose interpolation from smaller `POSTGRES_*` pieces** —
it does **not** read a `CONTROL_DATABASE_URL`/`PROJECT_DATABASE_URL` line
from `.env` directly, even though `.env.example` happens to define lines
with those exact same names (for a *different* purpose — see "Native
migration," below). Shown here as a shape with the SOURCE variable names
in place of any value, never a real connection string or credential:

| Compose target | URL variable the migration CODE validates | Built by Compose interpolation from (root `.env`, read by `docker compose` itself only) | Host/port |
| --- | --- | --- | --- |
| `migrate-control` | `CONTROL_DATABASE_URL` | `postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<POSTGRES_DB>` | Fixed at `postgres:5432` — not independently configurable here. |
| `migrate-project` | `PROJECT_DATABASE_URL` | `postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<PROJECT_TEST_DB_NAME>` | Same, fixed at `postgres:5432`. |

**So, to fix a Compose migration's configuration:** inspect and correct
`POSTGRES_USER`, `POSTGRES_PASSWORD`, and — depending on which target
failed — `POSTGRES_DB` (`migrate-control`) or `PROJECT_TEST_DB_NAME`
(`migrate-project`), all in the root `.env`. **Editing the
`CONTROL_DATABASE_URL`/`PROJECT_DATABASE_URL` lines in that SAME `.env`
file has no effect whatsoever on either Compose service** — neither one
is wired to read them (see "Compose interpolation vs. application
environment loading" above for the general version of this distinction).

**Native migration execution reads the opposite set of variables.**
Running the identical migration OUTSIDE Docker —
`pnpm --filter @relis/database run migrate control` /
`run migrate project`, from `relis/` — uses `@relis/config`'s own
`loadEnvFiles` (documented in `README.md` "Environment loading and
override precedence") to read `CONTROL_DATABASE_URL`/
`PROJECT_DATABASE_URL` **directly, as a complete connection string**, from
`.env`/`.env.local`/the real shell environment — it never assembles one
from `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`/
`PROJECT_TEST_DB_NAME` at all. These are genuinely two different
mechanisms sharing one `.env` file for two different sets of variables;
a value correct for one migration path (native) is not what the other
path (Compose) consumes, and vice versa.

**⚠️ Changing `POSTGRES_DB` or `PROJECT_TEST_DB_NAME` to "fix" a Compose
migration does not retroactively apply to an already-existing
`<project>_postgres-data` volume** — this is the SAME warning already
stated in "Honest limitations of 'recreated'" above, repeated here
because it is the single most common way this specific fix goes wrong:
`docker/postgres/init/` only runs on a genuinely first init, so renaming
either variable against a volume that already exists does not create a
database under the new name — the migration will then fail differently
(the target database itself does not exist), not because the new name is
wrong. **This is not a reason to reset by default.** First confirm
whether the database name you actually need already exists on the
running server (read-only, no credential in the example — `$POSTGRES_USER`
here is expanded BY THE CONTAINER's own shell via `sh -c`, where it is
genuinely set from the same `environment:` block Compose already
resolved; expanding it from your own host shell instead would silently
read an unrelated or empty value, the identical class of mistake as the
port-discovery issue above):

```bash
docker compose -p relis -f docker-compose.yml exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT datname FROM pg_database;"'
```

If it's genuinely missing and you intend to keep the existing volume's
other data, create it manually (a non-destructive, explicit DDL
statement — substitute the real target name, never paste a password into
this command: `psql` picks up its own credentials from the container's
already-configured environment, or prompts interactively):

```bash
docker compose -p relis -f docker-compose.yml exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE <target-db-name>;"'
```

Only if you genuinely want a clean slate — never as the routine or
default response to this specific failure — does the explicit, already
project-scoped reset in ["Shutdown and reset"](#shutdown-and-reset) apply
instead.

### The API is unavailable through the proxy

**Symptom:** `/api/health`/`/api/ready` through nginx return a `5xx`
(observed: `504 Gateway Timeout`, not an instant `502` — see "Health and
readiness" above for exactly why) instead of `200`.

```bash
docker compose -p relis -f docker-compose.yml ps api     # is it even running, and healthy?
docker compose -p relis -f docker-compose.yml logs api   # why did it stop, or never start?
docker compose -p relis -f docker-compose.yml restart api
```

This is specific to the `/api/` route — `/` (the web app) and
`/nginx-health` keep working throughout (proxy liveness is independent of
API readiness; see "Health and readiness" above), so check those two
first to confirm the failure is actually scoped to `api` and not the
whole proxy/stack.

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
  - MailHog's root page and message-listing API are genuinely MailHog's
    OWN interface (local sub-issue 02.05) — its distinctive
    `<title>MailHog</title>`/`ng-app="mailhogApp"` markup and exact
    `{total,count,start,items}` API shape, not merely an arbitrary `200`
    (see "Mail capture" above); a real signed SeaweedFS S3 PUT + GET
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
- `proxy-health.test.ts` — implements local sub-issue
  [02.04](../../../context/notion-tasks/sub-issues/02-04.md)'s AC1. Brings
  up only `nginx` (which pulls in `web`/`api` via `depends_on`) and
  verifies, against the real stack: `/api/health`/`/api/ready` preserve
  `apps/api`'s existing status codes and bodies through the proxy;
  `/nginx-health` stays `200 ok` independent of the API's own readiness;
  stopping `api` makes the proxy respond `5xx` (observed: `504`, after
  nginx's own default 60s `proxy_connect_timeout` against its cached,
  now-dead upstream route — see "Health and readiness" above) and never a
  false `200` or the web page, while `/` (served by the untouched `web`
  container) and `/nginx-health` keep working; and restarting `api`
  recovers within the existing success contract, confirmed by bounded
  polling (`waitForHttpStatus`). Setup/teardown follow the SAME guarded
  lifecycle contract as `persistence.test.ts` (sub-issue 02.03) — see
  "Cleanup robustness" below — even though this suite's own services
  (`nginx`/`web`/`api`) are not expected to create either named volume.
- `port-exposure.test.ts` — implements local sub-issue
  [02.04](../../../context/notion-tasks/sub-issues/02-04.md)'s AC2 at three
  layers: (1) pure, Docker-free unit tests of the loopback-only validation
  logic itself (`isLoopbackOnlyHostIp`/`assertLoopbackOnlyBindings`),
  including the explicit negative cases this sub-issue calls for —
  synthetic `0.0.0.0`, `::`, and empty-string bindings are all REJECTED —
  proving the validation logic only, never presented as real networking
  evidence; (2) the RESOLVED `docker compose config --format json` output
  (`resolveComposePublishedPorts`), asserting `api`/`web`/`postgres`/
  `worker`/`migrate-control`/`migrate-project` declare no `ports:` at all,
  and `nginx`/`mailhog`/`storage` declare exactly their approved,
  loopback-bound port and nothing else (never SMTP `1025`, never storage
  admin `9333`/`8888`); (3) the REAL running (or, for the one-shot
  migration services, real-but-exited) containers' own `docker inspect`
  `HostConfig.PortBindings` (`getContainerHostPortBindings`) — the actual
  runtime evidence the resolved configuration alone cannot provide,
  confirming every service matches layer (2) in practice. Layer (3) brings
  up the full stack, including `postgres`/`storage` (which DO create this
  project's two real named volumes), so its setup/teardown use the SAME
  guarded lifecycle contract as `persistence.test.ts` — baseline capture,
  `assertProvisioningSafety` before `up`, and `createComposeCleanupTarget`
  + `cleanupDisposableTargets` in `afterAll` (see "Cleanup robustness"
  below) — rather than an unguarded `cleanupComposeProject`.
- `wait-for-http-status.test.ts` — deterministic, Docker-free regression
  coverage for `waitForHttpStatus` itself (used by `proxy-health.test.ts`'s
  recovery check above), against a real local `node:http` server
  (loopback, ephemeral port — never an external service): resolves on an
  acceptable status, retries past repeated unacceptable ones and recovers,
  times out reporting the last observed status, and — the regression this
  file exists for — stays genuinely BOUNDED by `timeoutMs` even when a
  single request hangs and never responds at all (an earlier version only
  checked the deadline *between* requests, so one hanging request could
  keep the whole wait open indefinitely — exactly the shape of nginx's own
  60s `proxy_connect_timeout` behavior documented above). A dedicated case
  confirms the pending request is actually cancelled at the network level
  (observed via the test server's own `req.on("close")`), not merely that
  the calling promise gives up locally.
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

`proxy-health.test.ts` and `port-exposure.test.ts` (sub-issue 02.04) use
the FULLER guarded contract instead — the same one `persistence.test.ts`
uses (below): a volume baseline captured before anything is provisioned,
`assertProvisioningSafety` checked before `composeUp`, and
`createComposeCleanupTarget` + `cleanupDisposableTargets` in `afterAll`
(re-resolving the exact configured volume names fresh and re-verifying
ownership immediately before any deletion, failing closed on a discovery
failure, and falling back to a containers-only removal — never the
destructive one — when ownership cannot be established). An earlier
version of both files called `cleanupComposeProject` directly, bypassing
this contract; `persistence-safety.test.ts` now also carries fakes-based
regression coverage, shaped specifically after these two files' own
projects (a `nginx`/`web`/`api`-only project with no volume expected to
exist, and a full-stack project that genuinely owns `postgres-data`/
`storage-data`), proving a failed discovery or an unsafe ownership check
(mislabeled, pre-existing/baseline, or an inspection failure) still blocks
the destructive step for either shape — never exercised against a real
volume, for the same reason `persistence.test.ts` itself doesn't (see that
file's own header comment).
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
