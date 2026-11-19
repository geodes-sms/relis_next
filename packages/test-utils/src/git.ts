import { runToCompletion } from "./process.js";

/**
 * Read-only Git queries for verifying that generated data and real
 * environment files stay out of version control.
 *
 * Every function here only ever READS: `git ls-files`, `git check-ignore`,
 * and `git status --porcelain`. Nothing stages, adds, commits, or writes
 * to the index — a test must never `git add` a file to find out whether
 * it would be ignored, because that mutates the user's index.
 */

/** NUL-separated output -> a clean list of paths. */
function splitNulList(raw: string): string[] {
  return raw.split("\0").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Newline-separated output -> a clean list of paths. */
function splitLines(raw: string): string[] {
  return raw.split("\n").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const result = await runToCompletion("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 15000 });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Paths Git currently tracks, relative to the repository root. */
export async function listTrackedFiles(cwd: string): Promise<string[]> {
  const result = await runToCompletion("git", ["ls-files", "-z"], { cwd, timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed (exit ${result.exitCode}):\n${result.stderr}`);
  }
  return splitNulList(result.stdout);
}

/**
 * Tracked files that an ignore rule nevertheless matches — i.e. real,
 * committed source an over-broad pattern would have hidden had it not
 * already been added. Must always be empty: a non-empty result means a
 * `.gitignore` pattern is too broad, even though Git keeps honouring the
 * existing tracked entries.
 *
 * `git ls-files -i -c --exclude-standard` answers this in one read-only
 * command, with no path list to assemble and nothing staged.
 */
export async function listTrackedFilesMatchingIgnoreRules(cwd: string): Promise<string[]> {
  const result = await runToCompletion("git", ["ls-files", "-i", "-c", "--exclude-standard", "-z"], { cwd, timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files -i -c failed (exit ${result.exitCode}):\n${result.stderr}`);
  }
  return splitNulList(result.stdout);
}

/** Keeps each `git check-ignore` invocation's command line well short of any platform argv limit. */
const CHECK_IGNORE_CHUNK_SIZE = 40;

/**
 * Characters that would make `git check-ignore`'s newline-separated
 * output ambiguous: Git quotes a path containing any of them, and an
 * embedded newline would split one path into two.
 */
const PATH_CHARS_GIT_WOULD_QUOTE = /["\\\n\r\t]/;

/**
 * The subset of `paths` that Git's ignore rules would exclude.
 *
 * `--no-index` makes the answer depend on the ignore rules ALONE, not on
 * whether a path happens to be tracked already (without it, Git declines
 * to report a tracked path, which would mask an over-broad pattern that
 * shadows real source). The non-verbose form is used deliberately: with
 * `--verbose`, Git also prints paths matched by a NEGATION (`!`) pattern
 * — which are explicitly *not* ignored — and reading those as ignored
 * would invert the answer for an un-ignored exception such as
 * `.env.example`.
 *
 * A path need not exist on disk; these are rule evaluations, not file
 * system checks, and nothing is created, staged, or written.
 *
 * Paths are passed as arguments rather than on stdin (`runToCompletion`
 * offers no stdin channel), so `-z` is unavailable here — Git rejects it
 * outside `--stdin` mode. Output is therefore newline-split, and any
 * path Git would quote is rejected up front rather than silently
 * misreported as not-ignored.
 */
export async function listIgnoredPaths(cwd: string, paths: string[]): Promise<string[]> {
  const unsafe = paths.filter((candidate) => PATH_CHARS_GIT_WOULD_QUOTE.test(candidate));
  if (unsafe.length > 0) {
    throw new Error(`listIgnoredPaths cannot evaluate paths Git would quote: ${unsafe.join(", ")}`);
  }

  const ignored: string[] = [];
  for (let offset = 0; offset < paths.length; offset += CHECK_IGNORE_CHUNK_SIZE) {
    const chunk = paths.slice(offset, offset + CHECK_IGNORE_CHUNK_SIZE);
    const result = await runToCompletion("git", ["check-ignore", "--no-index", ...chunk], { cwd, timeoutMs: 30000 });
    // Exit 0 = at least one path in this chunk is ignored; 1 = none are; anything else is a real error.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(`git check-ignore failed (exit ${result.exitCode}):\n${result.stderr}`);
    }
    ignored.push(...splitLines(result.stdout));
  }
  return ignored;
}

export interface WorkingTreeEntry {
  /** The two-character porcelain status code, e.g. "??" for untracked or " M" for modified. */
  status: string;
  path: string;
}

/**
 * `git status --porcelain` — the current working-tree state, including
 * untracked paths. Reads only.
 *
 * Note on `-z`: a RENAME entry emits two NUL-terminated fields (the old
 * path and the new one), so its second field is reported here as an
 * extra entry whose first two characters are part of the path rather
 * than a status code. Callers that only look for specific path shapes
 * (a `.env` file, a data directory) are unaffected; a caller that needs
 * exact per-entry status codes should not rely on this.
 */
export async function listWorkingTreeEntries(cwd: string): Promise<WorkingTreeEntry[]> {
  const result = await runToCompletion("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd,
    timeoutMs: 30000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git status --porcelain failed (exit ${result.exitCode}):\n${result.stderr}`);
  }
  return splitNulList(result.stdout).map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(2).trim() }));
}
