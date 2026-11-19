# syntax=docker/dockerfile:1
#
# Local-development image for apps/worker. Runs the existing `dev` command
# (`tsx watch src/main.ts`) by default, matching this task's "existing
# worker development process" scope — not `start`. See
# docs/architecture/docker-compose-stack.md and
# docs/architecture/local-stack-inventory.md §3.3.
#
# IMPORTANT: this image's `command:` is overridden in docker-compose.yml
# for the one-shot `migrate-control` / `migrate-project` services, which
# reuse this same image (it already contains a full `pnpm install` of
# every workspace, including packages/database's Prisma CLI) instead of
# adding a fourth, unprescribed Dockerfile just to run
# `pnpm --filter @relis/database run migrate <target>`.
# context/project-structure.md's docker/ tree names only web/, api/,
# worker/, postgres/, and nginx/ — there is no docker/database/ entry.
#
# Image tag chosen to satisfy engines.node (">=22.15"); not independently
# re-verified against Docker Hub in this task (no network access).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/test-utils/package.json packages/test-utils/package.json

RUN pnpm install --frozen-lockfile

# docker-compose.yml's dev service bind-mounts apps/worker/src and
# packages/config/src over this at runtime; node_modules, the Prisma CLI
# used by the migrate-* services, and the initial @relis/config build
# below are not mounted over and survive from this image layer.
COPY . .

# See docker/web/Dockerfile for why this is baked here AND rebuilt again
# by the `command:` override at every container start.
RUN pnpm --filter @relis/config build

# No EXPOSE: apps/worker opens no network listener in either mode (see
# the inventory doc §3.3/§7) — neither does the migrate-* reuse of this
# image, which runs a one-shot CLI command and exits.

CMD ["sh", "-c", "pnpm --filter @relis/config build && exec pnpm --filter @relis/worker dev"]
