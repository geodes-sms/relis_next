# syntax=docker/dockerfile:1
#
# Local-development image for apps/web (Next.js). This is NOT a production
# build: the container runs the existing `dev` command (the validated
# apps/web/scripts/run.mjs wrapper -> `next dev`), matching this task's
# "existing Next.js web application" scope. See
# docs/architecture/docker-compose-stack.md and
# docs/architecture/local-stack-inventory.md §3.2 for the command this
# mirrors.
#
# Image tag chosen to satisfy the repository's engines.node (">=22.15")
# and packageManager (pnpm, pinned in the workspace's own package.json)
# requirements; not independently re-verified against Docker Hub in this
# task (no network access) — confirm it still resolves before first pull.
FROM node:22-bookworm-slim

# curl is used only by this service's Compose healthcheck (see
# docker-compose.yml); it is not present in the base slim image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Activates the exact pnpm version the workspace's own root package.json
# already pins via "packageManager" — not duplicated here.
RUN corepack enable

WORKDIR /app

# Copy only manifests first so `pnpm install` is cached across source-only
# changes (standard Docker layer-caching for a pnpm workspace).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/test-utils/package.json packages/test-utils/package.json

RUN pnpm install --frozen-lockfile

# Copy the rest of the workspace. docker-compose.yml's dev service
# bind-mounts apps/web/src, apps/web/public, and packages/config/src over
# this at runtime for live editing; node_modules and this initial
# @relis/config build are NOT mounted over, so they survive from this
# image layer regardless of what the mounted source looks like.
COPY . .

# Bakes an initial dist/ so the image is runnable even without the
# `command:` override below. Required because individual dev/start
# commands do not rebuild @relis/config themselves — see
# docs/architecture/local-stack-inventory.md §3 ("Preparation/build
# steps"). The `command:` override in docker-compose.yml rebuilds it again
# at every container start, since the mounted packages/config/src may have
# changed since this image was built.
RUN pnpm --filter @relis/config build

EXPOSE 3000

CMD ["sh", "-c", "pnpm --filter @relis/config build && exec pnpm --filter \"./apps/web\" dev"]
