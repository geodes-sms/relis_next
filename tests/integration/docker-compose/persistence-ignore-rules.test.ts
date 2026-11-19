import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  isGitRepository,
  listIgnoredPaths,
  listTrackedFiles,
  listTrackedFilesMatchingIgnoreRules,
  listWorkingTreeEntries,
} from "@relis/test-utils";

// Repository-hygiene half of the disposable-persistence work (see
// docs/architecture/docker-compose-stack.md "Persistence, lifecycle, and
// reset"): the local stack's data and real environment files must never
// become tracked repository artifacts, while committed development
// configuration and fixtures must stay tracked.
//
// Every check here is READ-ONLY Git: `git ls-files`, `git check-ignore
// --no-index`, and `git status --porcelain`. Nothing is ever staged,
// added, or written to test an ignore rule — `git check-ignore
// --no-index` evaluates the rules for a path whether or not it exists on
// disk, which is exactly why no file has to be created to probe one.
//
// No real secret is created for this verification: the probe paths below
// are rule evaluations for files that do not exist.
//
// Requires only the `git` CLI and this checkout — no Docker daemon — so
// it runs even where tests/integration/docker-compose/persistence.test.ts
// must skip.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/**
 * Paths that MUST be ignored. None of these exists in the checkout;
 * they are ignore-rule evaluations only.
 *
 * Note that the database and object-storage data of the Compose stack do
 * not appear here, and cannot: they live exclusively in Docker named
 * volumes (`<project>_postgres-data` / `<project>_storage-data`), never
 * at any path in this working tree. That structural property is asserted
 * directly against the resolved Compose configuration by
 * persistence.test.ts ("keeps all persistent data in named volumes, with
 * no writable host bind mount into the working tree"), which is a
 * stronger guarantee than an ignore rule could give.
 */
const MUST_BE_IGNORED = [
  // Real environment files, at the root and in every owning package.
  ".env",
  ".env.local",
  ".env.development.local",
  ".env.production",
  "apps/api/.env",
  "apps/web/.env.local",
  "apps/worker/.env",
  "packages/database/.env",
  // Generated application output.
  "node_modules/anything",
  "apps/web/.next/BUILD_ID",
  "packages/config/dist/index.js",
  "coverage/lcov.info",
  // Test run output.
  "test-results/.last-run.json",
  "playwright-report/index.html",
  "blob-report/report.jsonl",
  // Generated application artifacts in the structure-reserved storage/
  // directories (context/project-structure.md). These do not exist and
  // no adapter writes to them yet; the rules are defensive.
  "storage/uploads/uploaded.pdf",
  "storage/exports/export.csv",
  "storage/temp/scratch.tmp",
];

/** Paths that MUST stay trackable: committed development configuration, examples, and fixtures. */
const MUST_NOT_BE_IGNORED = [
  ".env.example",
  "docker-compose.yml",
  ".gitignore",
  ".dockerignore",
  "docker/postgres/init/01-create-project-test-database.sh",
  "docker/storage/s3-identities.json",
  "docker/nginx/nginx.conf",
  "tests/fixtures/docker-compose/persistence-fixtures.ts",
  "tests/integration/docker-compose/persistence.test.ts",
  "packages/test-utils/src/docker-compose.ts",
  "docs/architecture/docker-compose-stack.md",
  // A .gitkeep must remain possible inside each ignored storage/
  // directory, proving those rules exclude generated content without
  // making the directory itself un-committable.
  "storage/uploads/.gitkeep",
  "storage/exports/.gitkeep",
  "storage/temp/.gitkeep",
  // A source file directly under storage/ is NOT swallowed by the rules
  // above — they are scoped to the three generated-output directories.
  "storage/README.md",
];

const gitAvailable = await isGitRepository(repoRoot);

if (!gitAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[docker-compose/persistence-ignore-rules.test.ts] SKIPPED: this directory is not a Git work tree (or the `git` " +
      "CLI is unavailable), so no ignore rule could be evaluated. This is a reported blocker, not a pass.",
  );
}

describe.runIf(gitAvailable)("disposable stack data stays out of version control", () => {
  let trackedFiles: string[];

  beforeAll(async () => {
    trackedFiles = await listTrackedFiles(repoRoot);
    // Guards against a silently empty tracked-file list making the
    // tracking assertions below vacuously true.
    expect(trackedFiles.length).toBeGreaterThan(0);
  });

  it("ignores real environment files, generated data, and generated output", async () => {
    const ignored = await listIgnoredPaths(repoRoot, MUST_BE_IGNORED);
    const notIgnored = MUST_BE_IGNORED.filter((candidate) => !ignored.includes(candidate));
    expect(notIgnored, "these paths must be excluded by .gitignore but are not").toEqual([]);
  });

  it("keeps committed development configuration, examples, and fixtures trackable", async () => {
    const ignored = await listIgnoredPaths(repoRoot, MUST_NOT_BE_IGNORED);
    expect(ignored, "these paths must stay trackable but an ignore rule excludes them").toEqual([]);
  });

  it("tracks .env.example and no other environment file", () => {
    expect(trackedFiles).toContain(".env.example");
    // Any tracked path whose basename is `.env` or starts with `.env.`,
    // other than the example itself, would be a committed real
    // environment file.
    const trackedEnvFiles = trackedFiles.filter((file) => {
      const basename = path.posix.basename(file);
      return (basename === ".env" || basename.startsWith(".env.")) && file !== ".env.example";
    });
    expect(trackedEnvFiles, "a real environment file appears to be committed").toEqual([]);
  });

  it("tracks no generated database, object-storage, or build artifact", () => {
    const generatedArtifactPattern = /(^|\/)(node_modules|\.next|dist|coverage|test-results|playwright-report|blob-report)(\/|$)/;
    const storageDataPattern = /^storage\/(uploads|exports|temp)\//;
    const offenders = trackedFiles.filter((file) => generatedArtifactPattern.test(file) || storageDataPattern.test(file));
    expect(offenders, "a generated artifact appears to be committed").toEqual([]);
  });

  it("has no ignore pattern broad enough to hide a tracked source file", async () => {
    // `git ls-files -i -c` reports tracked files that an ignore rule
    // nevertheless matches. A non-empty result means a pattern is too
    // broad — real source would have been hidden had it not already been
    // added. See this task's "do not hide source files with overly broad
    // ignore patterns" boundary.
    const shadowed = await listTrackedFilesMatchingIgnoreRules(repoRoot);
    expect(shadowed, "an ignore pattern matches a tracked source file").toEqual([]);
  });

  it("has not accidentally added an environment file or stack data to the working tree", async () => {
    // Does not require a clean tree (ordinary in-progress work is fine)
    // — only that no environment file or disposable stack data is
    // sitting in it awaiting a commit.
    const entries = await listWorkingTreeEntries(repoRoot);
    const risky = entries.filter((entry) => {
      const basename = path.posix.basename(entry.path);
      const isEnvFile = (basename === ".env" || basename.startsWith(".env.")) && entry.path !== ".env.example";
      return isEnvFile || /^storage\/(uploads|exports|temp)\//.test(entry.path);
    });
    expect(
      risky.map((entry) => entry.path),
      "an environment file or stack data artifact is present in the working tree and not ignored",
    ).toEqual([]);
  });
});

describe.skipIf(gitAvailable)("disposable stack data stays out of version control (blocked)", () => {
  it("is a reported blocker, not executed, when Git is unavailable", () => {
    expect(gitAvailable).toBe(false);
  });
});
