import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks `runToCompletion` — the one function every `docker`/Compose
// invocation in packages/test-utils/src/docker-compose.ts bottoms out
// in — to prove a narrow wiring claim about `createComposeCleanupTarget`:
// the SAME environment overrides passed into it reach BOTH the Compose
// CONFIGURATION RESOLUTION step (`docker compose config`) and the
// actual CLEANUP commands it issues (`docker compose down --volumes`
// and `docker compose down --remove-orphans`), rather than the cleanup
// commands silently falling back to this process's own inherited
// environment.
//
// This is kept in its OWN file, separate from
// persistence-safety.test.ts, specifically because `vi.mock` applies to
// this entire test file's module graph — mixing it into a file that
// also runs a REAL-Docker check (as persistence-safety.test.ts does, for
// `inspectVolume`'s genuine-absence path) would silently break that real
// check by routing it through this mock too.
//
// Per the testing policy's "mocks prove the mocked boundary contract"
// note: this proves docker-compose.ts's OWN internal env-threading
// wiring, never a real Docker integration (`persistence.test.ts`'s
// real, disposable-project suite remains the proof of that). No real
// `docker` process is spawned and no real volume is ever touched or
// endangered — every `runToCompletion` call in this file is answered by
// a constructed fake, synchronously in-process.
//
// The mocked path below resolves to the exact same file
// docker-compose.ts itself imports as `./process.js` (both reach
// packages/test-utils/src/process.ts) — which is what lets this mock
// intercept docker-compose.ts's own calls, even though this test file
// never imports that module through the `@relis/test-utils` package
// barrel.
vi.mock("../../../packages/test-utils/src/process.ts", async () => {
  const actual = await vi.importActual<typeof import("../../../packages/test-utils/src/process.ts")>(
    "../../../packages/test-utils/src/process.ts",
  );
  return { ...actual, runToCompletion: vi.fn() };
});

import {
  type ComposeEnv,
  type ComposeProject,
  type SpawnResult,
  cleanupDisposableTargets,
  createComposeCleanupTarget,
} from "@relis/test-utils";
import { runToCompletion } from "../../../packages/test-utils/src/process.ts";

const mockedRunToCompletion = vi.mocked(runToCompletion);

const project: ComposeProject = {
  projectName: "relis-env-consistency-fake",
  composeFile: "/fake/docker-compose.yml",
  cwd: "/fake",
};

function ok(stdout = ""): SpawnResult {
  return { exitCode: 0, signal: null, stdout, stderr: "" };
}

/** The real `docker volume inspect <missing>` "not found" shape (see `isVolumeNotFoundError`). */
function notFound(name: string): SpawnResult {
  return { exitCode: 1, signal: null, stdout: "", stderr: `Error response from daemon: get ${name}: no such volume` };
}

/** An "exists, but wrongly labelled" `docker volume inspect` response — enough to fail the ownership gate. */
function existsWithWrongLabel(name: string): SpawnResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({ Name: name, Driver: "local", Labels: { "com.docker.compose.project": "someone-elses-dev-stack" } }),
    stderr: "",
  };
}

/**
 * A FAKE `docker compose config --format json` response whose resolved
 * volume NAMES are directly controlled by `env.TEST_VOLUME_SUFFIX` —
 * standing in for "a volume name controlled by an environment
 * variable." This is what makes the core assertion below concrete: the
 * exact env value that shaped a volume's NAME during resolution is the
 * one this test then traces into the later cleanup command's own env.
 */
function configJsonFor(env: NodeJS.ProcessEnv): string {
  const suffix = env.TEST_VOLUME_SUFFIX ?? "unset";
  return JSON.stringify({
    name: project.projectName,
    volumes: {
      "postgres-data": { name: `${project.projectName}_postgres-data-${suffix}` },
      "storage-data": { name: `${project.projectName}_storage-data-${suffix}` },
    },
    services: {},
  });
}

/** Every env object `runToCompletion` was actually invoked with, keyed by which Compose command it was for. */
let capturedEnv: { config?: NodeJS.ProcessEnv; destructiveDown?: NodeJS.ProcessEnv; keepVolumesDown?: NodeJS.ProcessEnv };

beforeEach(() => {
  capturedEnv = {};
  mockedRunToCompletion.mockReset();
});

describe("createComposeCleanupTarget — the same env reaches configuration resolution AND the actual cleanup command (mocked, no real Docker)", () => {
  it("passes the SAME env — including the value controlling a volume's resolved NAME — to configuration resolution and to the DESTRUCTIVE cleanup command", async () => {
    mockedRunToCompletion.mockImplementation(async (command, args, options = {}) => {
      expect(command).toBe("docker");
      if (args[0] === "compose" && args.includes("config")) {
        capturedEnv.config = options.env;
        return ok(configJsonFor(options.env ?? {}));
      }
      if (args[0] === "volume" && args[1] === "ls") {
        return ok(""); // nothing reported by label-based discovery — the union relies on configured names.
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        // Every configured volume is genuinely absent (never actually
        // created). A confirmed absence alone is enough to pass the
        // ownership gate, so the destructive path is reached without
        // needing to fabricate any matching ownership label.
        return notFound(String(args[2]));
      }
      if (args[0] === "compose" && args.includes("down") && args.includes("--volumes")) {
        capturedEnv.destructiveDown = options.env;
        return ok("");
      }
      if (args[0] === "compose" && args.includes("down")) {
        capturedEnv.keepVolumesDown = options.env;
        return ok("");
      }
      throw new Error(`Unexpected mocked docker invocation: ${JSON.stringify(args)}`);
    });

    const env: ComposeEnv = { PROJECT_TEST_DB_NAME: "relis_project_env_consistency_test", TEST_VOLUME_SUFFIX: "abc123" };
    const target = await createComposeCleanupTarget(project, env, []);
    const [outcome] = await cleanupDisposableTargets([target]);

    // The destructive command actually ran — proving this reached
    // `removeContainersAndVolumes`, not the safe fallback.
    expect(outcome.error).toBeUndefined();
    expect(outcome.volumesRequiringManualInspection).toEqual([]);
    expect(capturedEnv.destructiveDown).toBeDefined();
    expect(capturedEnv.keepVolumesDown).toBeUndefined();

    // THE CORE ASSERTION: the exact env value that controlled a
    // volume's NAME during configuration resolution is present,
    // unchanged, in the env the actual destructive `down --volumes`
    // command received — proving the SAME overrides reached both.
    expect(capturedEnv.config?.TEST_VOLUME_SUFFIX).toBe("abc123");
    expect(capturedEnv.destructiveDown?.TEST_VOLUME_SUFFIX).toBe("abc123");
    expect(capturedEnv.destructiveDown?.PROJECT_TEST_DB_NAME).toBe(env.PROJECT_TEST_DB_NAME);
  });

  it("passes the SAME env — including that volume-naming value — to the VOLUME-PRESERVING cleanup command when the gate blocks deletion", async () => {
    mockedRunToCompletion.mockImplementation(async (command, args, options = {}) => {
      if (args[0] === "compose" && args.includes("config")) {
        capturedEnv.config = options.env;
        return ok(configJsonFor(options.env ?? {}));
      }
      if (args[0] === "volume" && args[1] === "ls") return ok("");
      if (args[0] === "volume" && args[1] === "inspect") {
        const name = String(args[2]);
        // The env-suffixed storage-data volume genuinely EXISTS, but
        // with the WRONG Compose-project label — enough to block the
        // whole gate.
        if (name.includes("storage-data")) return existsWithWrongLabel(name);
        return notFound(name);
      }
      if (args[0] === "compose" && args.includes("down") && args.includes("--volumes")) {
        capturedEnv.destructiveDown = options.env;
        return ok("");
      }
      if (args[0] === "compose" && args.includes("down")) {
        capturedEnv.keepVolumesDown = options.env;
        return ok("");
      }
      throw new Error(`Unexpected mocked docker invocation: ${JSON.stringify(args)}`);
    });

    const env: ComposeEnv = { PROJECT_TEST_DB_NAME: "relis_project_env_consistency_test", TEST_VOLUME_SUFFIX: "xyz789" };
    const target = await createComposeCleanupTarget(project, env, []);
    const [outcome] = await cleanupDisposableTargets([target]);

    // The gate blocked deletion (mismatched label on the env-suffixed
    // volume) — the SAFE, volume-preserving command ran instead of the
    // destructive one.
    expect(outcome.volumesRequiringManualInspection.length).toBeGreaterThan(0);
    expect(capturedEnv.keepVolumesDown).toBeDefined();
    expect(capturedEnv.destructiveDown).toBeUndefined();

    // THE CORE ASSERTION, for the volume-PRESERVING path this time: the
    // same env value that shaped the volume's name during resolution
    // also reached this actual cleanup command.
    expect(capturedEnv.config?.TEST_VOLUME_SUFFIX).toBe("xyz789");
    expect(capturedEnv.keepVolumesDown?.TEST_VOLUME_SUFFIX).toBe("xyz789");
    expect(capturedEnv.keepVolumesDown?.PROJECT_TEST_DB_NAME).toBe(env.PROJECT_TEST_DB_NAME);
  });

  it("two DIFFERENT env values for the same key produce two DIFFERENT resolved volume names, and each target's own cleanup still receives its OWN value, never the other's", async () => {
    // Guards against a subtler bug than "env omitted entirely": two
    // concurrently-processed targets (as `cleanupDisposableTargets`
    // always runs them) must never cross-contaminate — e.g. a shared
    // mutable env object, or a closure capturing the wrong target's
    // value.
    const capturedByProject: Record<string, { config?: NodeJS.ProcessEnv; destructiveDown?: NodeJS.ProcessEnv }> = {};

    mockedRunToCompletion.mockImplementation(async (command, args, options = {}) => {
      const projectName = args[args.indexOf("-p") + 1];
      if (args[0] === "compose" && args.includes("config")) {
        capturedByProject[projectName] ??= {};
        capturedByProject[projectName].config = options.env;
        const suffix = options.env?.TEST_VOLUME_SUFFIX ?? "unset";
        return ok(
          JSON.stringify({
            name: projectName,
            volumes: { "postgres-data": { name: `${projectName}_postgres-data-${suffix}` }, "storage-data": { name: `${projectName}_storage-data-${suffix}` } },
            services: {},
          }),
        );
      }
      if (args[0] === "volume" && args[1] === "ls") return ok("");
      if (args[0] === "volume" && args[1] === "inspect") return notFound(String(args[2]));
      if (args[0] === "compose" && args.includes("down") && args.includes("--volumes")) {
        capturedByProject[projectName] ??= {};
        capturedByProject[projectName].destructiveDown = options.env;
        return ok("");
      }
      if (args[0] === "compose" && args.includes("down")) return ok("");
      throw new Error(`Unexpected mocked docker invocation: ${JSON.stringify(args)}`);
    });

    const primary: ComposeProject = { ...project, projectName: "relis-env-consistency-primary" };
    const bystander: ComposeProject = { ...project, projectName: "relis-env-consistency-bystander" };

    const [primaryTarget, bystanderTarget] = await Promise.all([
      createComposeCleanupTarget(primary, { TEST_VOLUME_SUFFIX: "primary-value" }, []),
      createComposeCleanupTarget(bystander, { TEST_VOLUME_SUFFIX: "bystander-value" }, []),
    ]);
    await cleanupDisposableTargets([primaryTarget, bystanderTarget]);

    expect(capturedByProject[primary.projectName]?.config?.TEST_VOLUME_SUFFIX).toBe("primary-value");
    expect(capturedByProject[primary.projectName]?.destructiveDown?.TEST_VOLUME_SUFFIX).toBe("primary-value");
    expect(capturedByProject[bystander.projectName]?.config?.TEST_VOLUME_SUFFIX).toBe("bystander-value");
    expect(capturedByProject[bystander.projectName]?.destructiveDown?.TEST_VOLUME_SUFFIX).toBe("bystander-value");
  });
});
