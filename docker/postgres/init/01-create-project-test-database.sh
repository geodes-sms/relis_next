#!/bin/sh
# Runs automatically on first init via the official postgres image's
# docker-entrypoint-initdb.d mechanism, alongside its own creation of
# POSTGRES_DB (the Control DB target, CONTROL_DATABASE_URL). This script
# only adds the SECOND, isolated database used as the project-test target
# (PROJECT_DATABASE_URL) — see docs/architecture/docker-compose-stack.md
# and docs/architecture/local-stack-inventory.md §6.1-§6.2.
#
# No schema or tables are created here: both
# packages/database/prisma/control/schema.prisma and
# .../project/schema.prisma define zero models, so there is nothing to
# provision beyond the empty database itself (see this task's boundary:
# "without adding business models or implementing per-project
# provisioning features").
set -e

: "${PROJECT_TEST_DB_NAME:?PROJECT_TEST_DB_NAME must be set for this init script to run}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
    CREATE DATABASE "${PROJECT_TEST_DB_NAME}";
SQL
