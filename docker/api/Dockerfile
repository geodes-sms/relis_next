# syntax=docker/dockerfile:1
#
# Local-development image for apps/api (Hono). Runs the existing `dev`
# command (`tsx watch src/main.ts`), matching this task's "existing Hono
# API" scope. See docs/architecture/docker-compose-stack.md and
# docs/architecture/local-stack-inventory.md §3.1.
#
# Image tag chosen to satisfy engines.node (">=22.15"); not independently
# re-verified against Docker Hub in this task (no network access).
FROM node:22-bookworm-slim

# curl is used only by this service's Compose healthcheck (apps/api's own
# GET /health — see docker-compose.yml) and is not in the base slim image.
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

# docker-compose.yml's dev service bind-mounts apps/api/src and
# packages/config/src over this at runtime; node_modules and the initial
# @relis/config build below are not mounted over and survive from this
# image layer.
COPY . .

# See docker/web/Dockerfile for why this is baked here AND rebuilt again
# by the `command:` override at every container start.
RUN pnpm --filter @relis/config build

EXPOSE 3001

CMD ["sh", "-c", "pnpm --filter @relis/config build && exec pnpm --filter \"./apps/api\" dev"]
