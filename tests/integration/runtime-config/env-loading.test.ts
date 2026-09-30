import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConfigValidationError,
  loadEnvFiles,
  resolveEffectiveEnv,
  resolveRuntimeMode,
  validateConsistentRuntimeMode,
  validateRuntimeMode,
} from "@relis/config";

// Exercises loadEnvFiles'/resolveEffectiveEnv's root-vs-package precedence,
// tier precedence, test-mode handling, chained variable expansion, and
// cycle detection against throwaway temp directories — never against a
// developer's real .env files.

const TEST_VARS = [
  "RELIS_TEST_ROOT_ONLY",
  "RELIS_TEST_OVERRIDE",
  "RELIS_TEST_EXPANDED",
  "RELIS_TEST_ESCAPED",
  "RELIS_TEST_TIER",
  "RELIS_TEST_LOCAL_ONLY",
  "RELIS_TEST_OS_WINS",
  "RELIS_TEST_CHAIN_A",
  "RELIS_TEST_CHAIN_B",
  "RELIS_TEST_CHAIN_C",
  "RELIS_TEST_CYCLE_A",
  "RELIS_TEST_CYCLE_B",
];

function clearTestVars(): void {
  for (const name of TEST_VARS) delete process.env[name];
}

let workspaceDir: string;
let packageDir: string;

beforeEach(() => {
  clearTestVars();
  workspaceDir = mkdtempSync(path.join(os.tmpdir(), "relis-env-root-"));
  packageDir = path.join(workspaceDir, "apps", "fake-pkg");
  mkdirSync(packageDir, { recursive: true });
  // Marks workspaceDir as the workspace root for findWorkspaceRoot().
  writeFileSync(path.join(workspaceDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
});

afterEach(() => {
  clearTestVars();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function write(dir: string, filename: string, content: string): void {
  writeFileSync(path.join(dir, filename), content);
}

describe("loadEnvFiles: root vs. package precedence", () => {
  it("uses a root-level value when the package directory does not define it", () => {
    write(workspaceDir, ".env", "RELIS_TEST_ROOT_ONLY=from-root\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_ROOT_ONLY).toBe("from-root");
  });

  it("lets the package directory's file override the same variable at the root", () => {
    write(workspaceDir, ".env", "RELIS_TEST_OVERRIDE=from-root\n");
    write(packageDir, ".env", "RELIS_TEST_OVERRIDE=from-package\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_OVERRIDE).toBe("from-package");
  });

  it("never overrides an already-set real process.env value", () => {
    process.env.RELIS_TEST_OS_WINS = "from-os";
    write(workspaceDir, ".env", "RELIS_TEST_OS_WINS=from-root\n");
    write(packageDir, ".env", "RELIS_TEST_OS_WINS=from-package\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_OS_WINS).toBe("from-os");
  });
});

describe("loadEnvFiles: tier precedence", () => {
  it("prefers .env.<mode> over the base .env, package-level, ahead of any root file", () => {
    write(workspaceDir, ".env.production", "RELIS_TEST_TIER=root-mode\n");
    write(packageDir, ".env", "RELIS_TEST_TIER=package-base\n");
    write(packageDir, ".env.production", "RELIS_TEST_TIER=package-mode\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_TIER).toBe("package-mode");
  });

  it("prefers .env.local over .env.<mode> in non-test modes", () => {
    write(packageDir, ".env.production", "RELIS_TEST_TIER=mode-tier\n");
    write(packageDir, ".env.local", "RELIS_TEST_TIER=local-tier\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_TIER).toBe("local-tier");
  });

  it("prefers .env.<mode>.local as the single highest tier", () => {
    write(packageDir, ".env", "RELIS_TEST_TIER=base\n");
    write(packageDir, ".env.local", "RELIS_TEST_TIER=local\n");
    write(packageDir, ".env.production", "RELIS_TEST_TIER=mode\n");
    write(packageDir, ".env.production.local", "RELIS_TEST_TIER=mode-local\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_TIER).toBe("mode-local");
  });
});

describe("loadEnvFiles: test-mode handling", () => {
  // Matches installed Next.js behavior: .env.test.local IS loaded in test
  // mode; only the generic .env.local is skipped (so tests produce the
  // same results for everyone regardless of a developer's local
  // overrides).

  it("loads .env.test.local in test mode, ahead of .env.test", () => {
    write(packageDir, ".env.test", "RELIS_TEST_LOCAL_ONLY=from-test-tier\n");
    write(packageDir, ".env.test.local", "RELIS_TEST_LOCAL_ONLY=from-test-local\n");
    loadEnvFiles("test", packageDir);
    expect(process.env.RELIS_TEST_LOCAL_ONLY).toBe("from-test-local");
  });

  it("ignores .env.local in test mode even when it is the only .local file present", () => {
    write(packageDir, ".env.test", "RELIS_TEST_LOCAL_ONLY=from-test-tier\n");
    write(packageDir, ".env.local", "RELIS_TEST_LOCAL_ONLY=from-local\n");
    loadEnvFiles("test", packageDir);
    expect(process.env.RELIS_TEST_LOCAL_ONLY).toBe("from-test-tier");
  });

  it("prefers .env.test.local over .env.local when both exist", () => {
    write(packageDir, ".env.test.local", "RELIS_TEST_LOCAL_ONLY=from-test-local\n");
    write(packageDir, ".env.local", "RELIS_TEST_LOCAL_ONLY=from-local\n");
    loadEnvFiles("test", packageDir);
    expect(process.env.RELIS_TEST_LOCAL_ONLY).toBe("from-test-local");
  });

  it("falls back to .env.test, then .env, when no .local file exists", () => {
    write(packageDir, ".env", "RELIS_TEST_LOCAL_ONLY=from-base\n");
    loadEnvFiles("test", packageDir);
    expect(process.env.RELIS_TEST_LOCAL_ONLY).toBe("from-base");
  });

  it("rejects invalid configuration originating from .env.test.local", () => {
    write(packageDir, ".env.test.local", "RELIS_TEST_LOCAL_ONLY=${RELIS_TEST_LOCAL_ONLY}\n");
    expect(() => loadEnvFiles("test", packageDir)).toThrow(ConfigValidationError);
  });
});

describe("loadEnvFiles: variable expansion", () => {
  it("expands ${VAR} and $VAR against already-resolved values", () => {
    write(workspaceDir, ".env", "RELIS_TEST_OVERRIDE=base-value\n");
    write(
      packageDir,
      ".env",
      "RELIS_TEST_EXPANDED=prefix-${RELIS_TEST_OVERRIDE}-mid-$RELIS_TEST_OVERRIDE-suffix\n",
    );
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_EXPANDED).toBe("prefix-base-value-mid-base-value-suffix");
  });

  it("treats a backslash-escaped reference as a literal dollar sign", () => {
    write(packageDir, ".env", "RELIS_TEST_ESCAPED=literal-\\${NOT_EXPANDED}\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_ESCAPED).toBe("literal-${NOT_EXPANDED}");
  });

  it("expands an unresolved reference to an empty string", () => {
    write(packageDir, ".env", "RELIS_TEST_EXPANDED=value-${RELIS_TEST_DOES_NOT_EXIST}-end\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_EXPANDED).toBe("value--end");
  });
});

describe("loadEnvFiles: chained variable expansion (deterministic, order-independent)", () => {
  it("resolves a 3-level chain when declared in reverse order (C, then B, then A)", () => {
    write(
      packageDir,
      ".env",
      ["RELIS_TEST_CHAIN_C=${RELIS_TEST_CHAIN_B}", "RELIS_TEST_CHAIN_B=${RELIS_TEST_CHAIN_A}", "RELIS_TEST_CHAIN_A=resolved"].join(
        "\n",
      ) + "\n",
    );
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_CHAIN_C).toBe("resolved");
    expect(process.env.RELIS_TEST_CHAIN_B).toBe("resolved");
    expect(process.env.RELIS_TEST_CHAIN_A).toBe("resolved");
  });

  it("resolves the identical 3-level chain when declared in forward order", () => {
    write(
      packageDir,
      ".env",
      ["RELIS_TEST_CHAIN_A=resolved", "RELIS_TEST_CHAIN_B=${RELIS_TEST_CHAIN_A}", "RELIS_TEST_CHAIN_C=${RELIS_TEST_CHAIN_B}"].join(
        "\n",
      ) + "\n",
    );
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_CHAIN_C).toBe("resolved");
  });

  it("resolves a chain whose links are declared across the root file and the package file", () => {
    write(workspaceDir, ".env", "RELIS_TEST_CHAIN_A=root-base\n");
    write(packageDir, ".env", "RELIS_TEST_CHAIN_B=${RELIS_TEST_CHAIN_A}\nRELIS_TEST_CHAIN_C=${RELIS_TEST_CHAIN_B}\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_CHAIN_C).toBe("root-base");
  });

  it("lets a real OS environment value short-circuit and win over the rest of a chain", () => {
    process.env.RELIS_TEST_CHAIN_A = "from-os";
    write(packageDir, ".env", "RELIS_TEST_CHAIN_A=file-value\nRELIS_TEST_CHAIN_B=${RELIS_TEST_CHAIN_A}\nRELIS_TEST_CHAIN_C=${RELIS_TEST_CHAIN_B}\n");
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_CHAIN_A).toBe("from-os");
    expect(process.env.RELIS_TEST_CHAIN_C).toBe("from-os");
  });
});

describe("loadEnvFiles: cycle detection", () => {
  it("detects a direct self-reference cycle and throws a safe error", () => {
    write(packageDir, ".env", "RELIS_TEST_CYCLE_A=${RELIS_TEST_CYCLE_A}\n");
    expect(() => loadEnvFiles("production", packageDir)).toThrow(ConfigValidationError);
    expect(process.env.RELIS_TEST_CYCLE_A).toBeUndefined();
  });

  it("detects an indirect cycle (A -> B -> A), reports it safely, and leaves no partially-expanded value assigned", () => {
    write(packageDir, ".env", "RELIS_TEST_CYCLE_A=${RELIS_TEST_CYCLE_B}\nRELIS_TEST_CYCLE_B=${RELIS_TEST_CYCLE_A}\n");
    try {
      loadEnvFiles("production", packageDir);
      expect.unreachable("expected a cycle error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const diagnostic = (error as ConfigValidationError).toDiagnostic();
      expect(diagnostic.code).toBe("CONFIG_INVALID");
      expect(diagnostic.categories).toEqual(["runtime"]);
      // Neither cyclic variable was left partially expanded in process.env.
      expect(process.env.RELIS_TEST_CYCLE_A).toBeUndefined();
      expect(process.env.RELIS_TEST_CYCLE_B).toBeUndefined();
    }
  });

  it("does not treat a diamond (non-cyclic) reference graph as a cycle", () => {
    write(
      packageDir,
      ".env",
      [
        "RELIS_TEST_CHAIN_A=base",
        "RELIS_TEST_CHAIN_B=${RELIS_TEST_CHAIN_A}",
        "RELIS_TEST_CHAIN_C=${RELIS_TEST_CHAIN_A}-${RELIS_TEST_CHAIN_B}",
      ].join("\n") + "\n",
    );
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_CHAIN_C).toBe("base-base");
  });
});

describe("resolveEffectiveEnv: independent per-application resolution", () => {
  it("never lets one directory's file-derived values leak into another directory's resolution", () => {
    const apiDir = path.join(workspaceDir, "apps", "api");
    const webDir = path.join(workspaceDir, "apps", "web");
    mkdirSync(apiDir, { recursive: true });
    mkdirSync(webDir, { recursive: true });
    write(apiDir, ".env", "API_ONLY_VAR=api-value\n");
    write(webDir, ".env", "WEB_ONLY_VAR=web-value\n");

    const apiEnv = resolveEffectiveEnv("production", apiDir, {});
    const webEnv = resolveEffectiveEnv("production", webDir, {});

    expect(apiEnv.API_ONLY_VAR).toBe("api-value");
    expect(webEnv.API_ONLY_VAR).toBeUndefined();
    expect(webEnv.WEB_ONLY_VAR).toBe("web-value");
    expect(apiEnv.WEB_ONLY_VAR).toBeUndefined();
  });

  it("a root-level value is respected by a package that does not override it", () => {
    const webDir = path.join(workspaceDir, "apps", "web");
    mkdirSync(webDir, { recursive: true });
    write(workspaceDir, ".env", "WEB_PORT=3005\n");

    const webEnv = resolveEffectiveEnv("production", webDir, {});
    expect(webEnv.WEB_PORT).toBe("3005");
  });

  it("a package-level override wins for that package regardless of another package's own resolution", () => {
    const apiDir = path.join(workspaceDir, "apps", "api");
    const webDir = path.join(workspaceDir, "apps", "web");
    mkdirSync(apiDir, { recursive: true });
    mkdirSync(webDir, { recursive: true });
    write(workspaceDir, ".env", "WEB_PORT=3005\n");
    write(webDir, ".env", "WEB_PORT=4000\n");

    // Resolve apps/api's environment FIRST, from the identical base
    // snapshot, to prove resolution order cannot influence apps/web's
    // independently-resolved result (the bug this corrects: api's
    // resolution previously mutated the shared process.env, silently
    // blocking web's own package-level override).
    const apiEnv = resolveEffectiveEnv("production", apiDir, {});
    const webEnv = resolveEffectiveEnv("production", webDir, {});

    expect(apiEnv.WEB_PORT).toBe("3005"); // apps/api incidentally sees the shared root value
    expect(webEnv.WEB_PORT).toBe("4000"); // apps/web's own override still applies for apps/web
  });

  it("real OS environment variables retain precedence identically for each independently-resolved application", () => {
    const apiDir = path.join(workspaceDir, "apps", "api");
    const webDir = path.join(workspaceDir, "apps", "web");
    mkdirSync(apiDir, { recursive: true });
    mkdirSync(webDir, { recursive: true });
    write(apiDir, ".env", "SHARED_OS_VAR=from-api-file\n");
    write(webDir, ".env", "SHARED_OS_VAR=from-web-file\n");
    const base = { SHARED_OS_VAR: "from-os" };

    expect(resolveEffectiveEnv("production", apiDir, base).SHARED_OS_VAR).toBe("from-os");
    expect(resolveEffectiveEnv("production", webDir, base).SHARED_OS_VAR).toBe("from-os");
  });

  it("agrees with loadEnvFiles (the real per-process mutating path) for the same fixture", () => {
    write(packageDir, ".env", "RELIS_TEST_OVERRIDE=agree-value\n");
    const pureResult = resolveEffectiveEnv("production", packageDir, {});
    loadEnvFiles("production", packageDir);
    expect(process.env.RELIS_TEST_OVERRIDE).toBe(pureResult.RELIS_TEST_OVERRIDE);
  });
});

describe("resolveRuntimeMode (lenient — file-selection only)", () => {
  it("uses the provided fallback when NODE_ENV is absent", () => {
    expect(resolveRuntimeMode(undefined, "production")).toBe("production");
    expect(resolveRuntimeMode(undefined, "development")).toBe("development");
  });

  it("respects an explicit, valid NODE_ENV over the fallback", () => {
    expect(resolveRuntimeMode("test", "production")).toBe("test");
    expect(resolveRuntimeMode("development", "production")).toBe("development");
  });
});

describe("validateRuntimeMode (strict — rejects an invalid or empty explicit value)", () => {
  it("uses the provided fallback when NODE_ENV is absent", () => {
    expect(validateRuntimeMode(undefined, "production")).toBe("production");
  });

  it("respects an explicit, valid NODE_ENV over the fallback", () => {
    expect(validateRuntimeMode("test", "production")).toBe("test");
  });

  it("rejects an explicitly invalid NODE_ENV instead of coercing it", () => {
    expect(() => validateRuntimeMode("bogus", "development")).toThrow(ConfigValidationError);
  });

  it("rejects an explicitly empty NODE_ENV instead of coercing it", () => {
    expect(() => validateRuntimeMode("", "development")).toThrow(ConfigValidationError);
  });
});

describe("validateConsistentRuntimeMode (rejects a well-formed but DIFFERENT mode than tier selection used)", () => {
  it("uses the selected mode unchanged when NODE_ENV is still absent (the documented absent-value default)", () => {
    expect(validateConsistentRuntimeMode(undefined, "production")).toBe("production");
    expect(validateConsistentRuntimeMode(undefined, "development")).toBe("development");
  });

  it("accepts a value that matches the selected mode exactly", () => {
    expect(validateConsistentRuntimeMode("production", "production")).toBe("production");
    expect(validateConsistentRuntimeMode("test", "test")).toBe("test");
  });

  it("rejects a well-formed but conflicting mode instead of silently switching to it", () => {
    // e.g. `start` selects "production" (loading production-tier files),
    // then a .env file sets NODE_ENV=development: accepting "development"
    // here would forward a different mode to Next than the one whose
    // files were actually loaded.
    expect(() => validateConsistentRuntimeMode("development", "production")).toThrow(ConfigValidationError);
  });

  it("rejects an explicitly invalid NODE_ENV regardless of the selected mode", () => {
    expect(() => validateConsistentRuntimeMode("bogus", "production")).toThrow(ConfigValidationError);
  });

  it("rejects an explicitly empty NODE_ENV regardless of the selected mode", () => {
    expect(() => validateConsistentRuntimeMode("", "production")).toThrow(ConfigValidationError);
  });

  it("produces a safe diagnostic naming only NODE_ENV, never a value", () => {
    try {
      validateConsistentRuntimeMode("development", "production");
      expect.unreachable("expected validateConsistentRuntimeMode to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const diagnostic = (error as ConfigValidationError).toDiagnostic();
      expect(diagnostic).toEqual({
        code: "CONFIG_INVALID",
        process: "web",
        categories: ["runtime"],
        variables: ["NODE_ENV"],
      });
    }
  });
});
