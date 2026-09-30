import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ConfigValidationError } from "./errors.js";

/**
 * Server-only: loads dotenv files before an entry point reads
 * process.env. Never import this from public.ts or web browser code.
 */

export type RuntimeMode = "development" | "test" | "production";

// Matches $VAR / ${VAR}, with a leading backslash escaping the whole
// reference to a literal "$VAR" / "${VAR}" (dotenv-expand convention).
const EXPANSION_PATTERN = /(\\)?\$\{([A-Za-z_][A-Za-z0-9_]*)\}|(\\)?\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Finds the pnpm workspace root by walking up from `startDir` looking for
 * pnpm-workspace.yaml. Falls back to `startDir` itself if none is found
 * (e.g. a package checked out standalone).
 */
export function findWorkspaceRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

function candidateFiles(mode: RuntimeMode, cwd: string): string[] {
  const root = findWorkspaceRoot(cwd);
  const resolvedCwd = path.resolve(cwd);
  const directories = resolvedCwd === root ? [resolvedCwd] : [resolvedCwd, root];

  // Matches installed Next.js behavior: .env.test.local IS loaded in test
  // mode (only the generic .env.local is skipped there, since tests should
  // produce the same results for everyone regardless of a developer's
  // local overrides).
  const tiers = [
    `.env.${mode}.local`,
    mode !== "test" ? ".env.local" : null,
    `.env.${mode}`,
    ".env",
  ].filter((file): file is string => file !== null);

  const files: string[] = [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    for (const dir of directories) {
      const filePath = path.join(dir, tier);
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      files.push(filePath);
    }
  }
  return files;
}

/**
 * Determines the winning RAW (unexpanded) value per key across every
 * candidate file, in precedence order (highest first): for each
 * Next.js-style tier — .env.<mode>.local > .env.local (skipped in test
 * mode only) > .env.<mode> > .env — the package directory's file wins over
 * the workspace root's file at that same tier. First match per key wins;
 * later files never override an earlier winner.
 */
function collectWinners(mode: RuntimeMode, cwd: string): Record<string, string> {
  const winners: Record<string, string> = {};
  for (const filePath of candidateFiles(mode, cwd)) {
    if (!existsSync(filePath)) continue;
    const parsed = dotenv.parse(readFileSync(filePath, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in winners)) winners[key] = value;
    }
  }
  return winners;
}

/**
 * Resolves `name`'s fully-expanded value, deterministically, regardless of
 * where in `winners` it happens to be declared:
 *  - An already-resolved base/OS value always wins outright and is
 *    returned as-is (base values are never templates to re-expand).
 *  - A winner's raw value is expanded on demand, recursively resolving any
 *    reference it contains first (memoized in `resolved`), so a chain like
 *    C=${B}, B=${A}, A=resolved converges to the same result regardless of
 *    declaration order.
 *  - A reference to a name that is neither a base value nor a winner
 *    expands to an empty string (documented unresolved-reference
 *    behavior).
 *  - A direct or indirect cycle (name re-entered while already being
 *    resolved) throws a safe ConfigValidationError — naming only the
 *    variable, never a value — instead of recursing forever or returning a
 *    partially-expanded string.
 */
function resolveValue(
  name: string,
  winners: Record<string, string>,
  base: Record<string, string>,
  resolved: Map<string, string>,
  inProgress: Set<string>,
): string {
  const baseValue = base[name];
  if (baseValue !== undefined) return baseValue;

  const cached = resolved.get(name);
  if (cached !== undefined) return cached;

  const raw = winners[name];
  if (raw === undefined) return "";

  if (inProgress.has(name)) {
    throw new ConfigValidationError("env", [{ variable: name, category: "runtime" }]);
  }
  inProgress.add(name);

  const expanded = raw.replace(
    EXPANSION_PATTERN,
    (
      match,
      escapedBraced: string | undefined,
      bracedName: string | undefined,
      escapedBare: string | undefined,
      bareName: string | undefined,
    ) => {
      if (escapedBraced || escapedBare) return match.slice(1);
      const referenced = bracedName ?? bareName ?? "";
      return resolveValue(referenced, winners, base, resolved, inProgress);
    },
  );

  inProgress.delete(name);
  resolved.set(name, expanded);
  return expanded;
}

/**
 * Pure computation of an application's fully resolved effective
 * environment: `baseEnv` (typically the real OS environment, or a
 * fixture/snapshot in tests) merged with every applicable .env file for
 * `cwd`, root/package precedence and variable expansion both applied.
 * Never mutates `baseEnv` or `process.env` — callers decide what to do
 * with the result. This lets two applications (e.g. apps/api and
 * apps/web) each resolve their own effective environment independently
 * from the SAME starting snapshot, without one's file-derived values
 * leaking into the other's resolution.
 */
export function resolveEffectiveEnv(
  mode: RuntimeMode,
  cwd: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) base[key] = value;
  }

  const winners = collectWinners(mode, cwd);
  const resolved = new Map<string, string>();
  const result: Record<string, string> = { ...base };

  for (const key of Object.keys(winners)) {
    if (result[key] !== undefined) continue; // base/OS value always wins outright
    result[key] = resolveValue(key, winners, base, resolved, new Set());
  }

  return result;
}

/**
 * Loads .env files from BOTH the owning package directory (`cwd`, e.g.
 * apps/api) and the application root (the pnpm workspace root), so a
 * shared root-level .env documented in the README and a package-specific
 * override both take effect consistently — instead of each process only
 * ever searching its own directory. Mutates the real process.env in
 * place: intended for a single process's own startup, where process.env
 * genuinely IS that process's environment. Use `resolveEffectiveEnv`
 * instead when two applications' environments must be computed
 * independently (see packages/config/src/cli.ts's `check-ports` command).
 */
export function loadEnvFiles(mode: RuntimeMode, cwd: string = process.cwd()): void {
  const effective = resolveEffectiveEnv(mode, cwd, process.env);
  for (const [key, value] of Object.entries(effective)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Resolves an explicit NODE_ENV to a supported mode for the purpose of
 * choosing which .env files to load. An absent value falls back to
 * `fallback` (chosen per-command by the caller — e.g. "production" for a
 * production start, "development" for dev). An explicit but unsupported
 * value is NOT rejected here — it is treated as "development" only for
 * this file-selection purpose. Use `validateRuntimeMode` instead wherever
 * the resolved mode will also be forwarded to something else (e.g. a
 * spawned child process): that variant rejects an invalid/empty explicit
 * value instead of silently coercing it.
 */
export function resolveRuntimeMode(rawNodeEnv: string | undefined, fallback: RuntimeMode = "development"): RuntimeMode {
  if (rawNodeEnv === undefined) return fallback;
  return rawNodeEnv === "production" || rawNodeEnv === "test" || rawNodeEnv === "development" ? rawNodeEnv : "development";
}

const VALID_RUNTIME_MODES: readonly RuntimeMode[] = ["development", "test", "production"];

/**
 * Strictly resolves NODE_ENV for a command whose resolved mode is also
 * forwarded onward (e.g. apps/web's dev/build/start wrapper, which passes
 * process.env — including NODE_ENV — to the spawned Next.js process). An
 * absent value uses `fallback`. An explicit value must be exactly
 * "development", "test", or "production" — an empty/whitespace-only or
 * otherwise invalid explicit value throws a ConfigValidationError instead
 * of being silently coerced and then forwarded onward unexamined.
 *
 * `processName` labels the resulting diagnostic (default "web", matching
 * this function's original caller, apps/web/scripts/run.mjs); pass the
 * actual caller's identity (e.g. "deploy") so a diagnostic accurately
 * names where the invalid value was rejected.
 */
export function validateRuntimeMode(
  rawNodeEnv: string | undefined,
  fallback: RuntimeMode,
  processName = "web",
): RuntimeMode {
  if (rawNodeEnv === undefined) return fallback;
  if ((VALID_RUNTIME_MODES as readonly string[]).includes(rawNodeEnv)) {
    return rawNodeEnv as RuntimeMode;
  }
  throw new ConfigValidationError(processName, [{ variable: "NODE_ENV", category: "runtime" }]);
}

/**
 * Re-validates NODE_ENV after .env files have been loaded, so the mode
 * used to select which .env.<mode> tier to load (`selectedMode`, resolved
 * via `validateRuntimeMode` BEFORE `loadEnvFiles` ran) and the mode
 * ultimately forwarded onward (e.g. to a spawned Next.js process) can
 * never diverge.
 *
 * A .env file is not special-cased for NODE_ENV — it can set it like any
 * other variable if the OS environment did not already. If it is still
 * absent after loading, `selectedMode` is used unchanged (by
 * construction: `rawNodeEnv` is only ever absent here when the OS did not
 * set it, since an OS-set value would already equal `selectedMode`). If
 * it is present, it must be both valid (delegated to `validateRuntimeMode`
 * — rejects an invalid/empty explicit value) AND equal to `selectedMode`:
 * a well-formed but DIFFERENT mode is rejected too, rather than silently
 * switching modes after the fact — e.g. `start` selects and loads
 * production-tier files, then a file sets NODE_ENV=development, which
 * would otherwise forward "development" to Next despite production files
 * having been the ones actually loaded.
 */
export function validateConsistentRuntimeMode(
  rawNodeEnv: string | undefined,
  selectedMode: RuntimeMode,
  processName = "web",
): RuntimeMode {
  const candidate = validateRuntimeMode(rawNodeEnv, selectedMode, processName);
  if (candidate !== selectedMode) {
    throw new ConfigValidationError(processName, [{ variable: "NODE_ENV", category: "runtime" }]);
  }
  return candidate;
}
