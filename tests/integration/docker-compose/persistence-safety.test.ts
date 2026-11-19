import { describe, expect, it } from "vitest";
import {
  type DisposableCleanupTarget,
  type OwnedVolumeRecord,
  type ResolvedComposePersistence,
  type VolumeInspectionResult,
  type VolumeOwnership,
  type VolumeOwnershipContext,
  assertProvisioningSafety,
  checkProvisioningSafety,
  checkVolumeOwnershipForDeletion,
  cleanupDisposableTargets,
  discoverVolumesRequiringInspection,
  evaluateOwnershipGate,
  inspectVolume,
  isDockerAvailableSync,
  isS3ObjectAbsent,
  isVolumeNotFoundError,
  parseS3ErrorBody,
  readS3ErrorResponse,
  uniqueProjectName,
  volumeExists,
} from "@relis/test-utils";

// Regression coverage for the review findings on
// tests/integration/docker-compose/persistence.test.ts's destructive
// paths (see that file's own header comment for how these pure
// functions and fakes are wired into the real suite):
//
//   1. Ownership checks must protect every destructive path — covered
//      here by exercising `checkVolumeOwnershipForDeletion`,
//      `evaluateOwnershipGate`, and
//      `checkProvisioningSafety`/`assertProvisioningSafety` directly
//      with constructed fakes, and `cleanupDisposableTargets` with fake
//      targets that simulate partial setup and per-target failure.
//   2. Distinguish absent volumes from Docker failures — covered by
//      `isVolumeNotFoundError` (the exact classification `inspectVolume`
//      dispatches on) with synthetic stderr text, by
//      `checkVolumeOwnershipForDeletion`'s own tri-state handling of
//      `VolumeInspectionResult` (absence is `ok`, failure is not), plus
//      one safe, real-Docker check that a genuinely nonexistent volume
//      name resolves to `undefined` end to end.
//   3. Prove actual object absence after reset — covered by
//      `parseS3ErrorBody`/`isS3ObjectAbsent`/`readS3ErrorResponse` with
//      synthetic S3 XML error bodies, including the unrelated-error
//      shapes (auth failure, server error, malformed body) that must
//      NOT be accepted as deletion evidence.
//   4. A volume whose NAME is configured but whose Compose-project
//      LABEL is incorrect or missing must still be inspected, and still
//      block destructive cleanup — covered by
//      `discoverVolumesRequiringInspection`'s union-of-sources behavior
//      (configured names ∪ label-discovered names, never label
//      discovery alone), its FAIL-CLOSED behavior when either source
//      cannot be resolved, and a direct `cleanupDisposableTargets`
//      regression test with exactly two configured volumes — one
//      correctly labeled, one not — asserting the destructive command
//      is never called.
//
// Nothing here touches a real Docker volume, a real container, or a
// real network request: every scenario is a constructed fake or a
// synthetic string/Response, except the one narrow real-Docker check
// noted above, which only ever INSPECTS a volume name that is
// guaranteed never to exist — it creates and destroys nothing. This
// file therefore needs no Docker-availability gate overall; only that
// one block gates on it.

function fakeVolumeOwnership(overrides: Partial<VolumeOwnership> = {}): VolumeOwnership {
  return {
    name: "relis-persist-aaaa1111_postgres-data",
    driver: "local",
    composeProject: "relis-persist-aaaa1111",
    composeVolumeKey: "postgres-data",
    labels: {},
    ...overrides,
  };
}

/** `{status: "exists", ownership}` — shorthand for the common case in these tests. */
function exists(overrides: Partial<VolumeOwnership> = {}): VolumeInspectionResult {
  return { status: "exists", ownership: fakeVolumeOwnership(overrides) };
}

/** A CONFIRMED absence — the daemon genuinely reports no such volume. Never the same as a failed inspection; see `failed` below. */
const absent: VolumeInspectionResult = { status: "absent" };

/** An inspection FAILURE — the daemon could not be asked at all (unreachable, permission denied, malformed output, ...). */
function failed(error: string): VolumeInspectionResult {
  return { status: "failed", error };
}

function fakeResolvedPersistence(overrides: Partial<ResolvedComposePersistence> = {}): ResolvedComposePersistence {
  return {
    projectName: "relis-persist-aaaa1111",
    volumeNames: {
      "postgres-data": "relis-persist-aaaa1111_postgres-data",
      "storage-data": "relis-persist-aaaa1111_storage-data",
    },
    externalVolumes: [],
    bindMounts: {},
    databaseTargets: {},
    ...overrides,
  };
}

const BASE_CONTEXT: VolumeOwnershipContext = {
  expectedProjectName: "relis-persist-aaaa1111",
  baselineVolumeNames: [],
  externalVolumeKeys: [],
};

describe("isVolumeNotFoundError — distinguishing genuine absence from a real failure", () => {
  it("matches Docker's own real 'no such volume' response", () => {
    expect(isVolumeNotFoundError('Error response from daemon: get my-vol: no such volume\n')).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isVolumeNotFoundError("NO SUCH VOLUME")).toBe(true);
  });

  it("does NOT match a daemon-unreachable error", () => {
    expect(
      isVolumeNotFoundError('error during connect: Get "http://127.0.0.1:1/v1.56/volumes/x": dial tcp 127.0.0.1:1: connectex: connection refused'),
    ).toBe(false);
  });

  it("does NOT match a permission failure", () => {
    expect(isVolumeNotFoundError("permission denied while trying to connect to the Docker daemon socket")).toBe(false);
  });

  it("does NOT match an empty or unrelated message", () => {
    expect(isVolumeNotFoundError("")).toBe(false);
    expect(isVolumeNotFoundError("Error response from daemon: something else entirely")).toBe(false);
  });
});

// The one real-Docker check in this file. Inspecting a volume name that
// is guaranteed never to exist is read-only and risk-free: it creates
// nothing and can destroy nothing. Gated and skipped (not mocked) when
// Docker is unavailable, matching every other real-Docker suite here.
const dockerAvailable = isDockerAvailableSync();
if (!dockerAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    "[docker-compose/persistence-safety.test.ts] One block SKIPPED: the `docker` CLI is not available (or no daemon " +
      "is reachable). The genuine-absence check against a real daemon was not verified; every other check in this " +
      "file uses controlled fakes and still ran.",
  );
}

describe.runIf(dockerAvailable)("inspectVolume/volumeExists — genuine absence, verified against the real daemon", () => {
  it("resolves to undefined/false for a volume name guaranteed not to exist, never throwing", async () => {
    const neverExists = uniqueProjectName("relis-persistence-safety-never-exists");
    await expect(inspectVolume(neverExists)).resolves.toBeUndefined();
    await expect(volumeExists(neverExists)).resolves.toBe(false);
  });
});

describe("checkVolumeOwnershipForDeletion — tri-state ownership rejection with controlled fakes", () => {
  it("accepts a volume confirmed to exist, genuinely belonging to the expected project and nothing else", () => {
    const result = checkVolumeOwnershipForDeletion("relis-persist-aaaa1111_postgres-data", exists(), BASE_CONTEXT);
    expect(result).toEqual({ name: "relis-persist-aaaa1111_postgres-data", ok: true });
  });

  it("accepts a CONFIRMED absence — nothing to delete is never a reason to block", () => {
    const result = checkVolumeOwnershipForDeletion("some-volume", absent, BASE_CONTEXT);
    expect(result).toEqual({ name: "some-volume", ok: true });
  });

  it("refuses an inspection FAILURE — never the same as a confirmed absence", () => {
    const result = checkVolumeOwnershipForDeletion("some-volume", failed("daemon unreachable"), BASE_CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be inspected/i);
    expect(result.reason).toContain("daemon unreachable");
  });

  it("refuses a volume that already existed before this run (the baseline)", () => {
    const name = "relis-persist-aaaa1111_postgres-data";
    const result = checkVolumeOwnershipForDeletion(name, exists(), { ...BASE_CONTEXT, baselineVolumeNames: [name] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/pre-existing/i);
  });

  it("refuses a volume labelled with a DIFFERENT Compose project — never a name-prefix guess", () => {
    const result = checkVolumeOwnershipForDeletion(
      "relis-persist-aaaa1111_postgres-data",
      exists({ composeProject: "someone-elses-dev-stack" }),
      BASE_CONTEXT,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("someone-elses-dev-stack");
    expect(result.reason).toContain(BASE_CONTEXT.expectedProjectName);
  });

  it("refuses a volume with no Compose project label at all (a missing label)", () => {
    const result = checkVolumeOwnershipForDeletion("relis-persist-aaaa1111_postgres-data", exists({ composeProject: undefined }), BASE_CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("(none)");
  });

  it("refuses a volume whose key is declared external:true, even if its project label matches", () => {
    const result = checkVolumeOwnershipForDeletion("relis-persist-aaaa1111_postgres-data", exists(), {
      ...BASE_CONTEXT,
      externalVolumeKeys: ["postgres-data"],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/external/i);
  });
});

describe("evaluateOwnershipGate — the pure batch gate used immediately before every destructive step", () => {
  it("refuses an empty record list rather than treating 'nothing to check' as 'safe to proceed'", () => {
    const gate = evaluateOwnershipGate([], BASE_CONTEXT);
    expect(gate.ok).toBe(false);
    expect(gate.checks).toHaveLength(1);
    expect(gate.checks[0]?.ok).toBe(false);
  });

  it("is ok only when EVERY record passes — one failure among several fails the whole gate", () => {
    const gate = evaluateOwnershipGate(
      [
        { name: "good", inspection: exists() },
        { name: "bad", inspection: failed("boom") },
      ],
      BASE_CONTEXT,
    );
    expect(gate.ok).toBe(false);
    expect(gate.checks.find((check) => check.name === "good")?.ok).toBe(true);
    expect(gate.checks.find((check) => check.name === "bad")?.ok).toBe(false);
  });

  it("is ok when every record is either a confirmed-safe existing volume or a confirmed absence", () => {
    const gate = evaluateOwnershipGate(
      [
        { name: "exists-ok", inspection: exists() },
        { name: "absent-ok", inspection: absent },
      ],
      BASE_CONTEXT,
    );
    expect(gate.ok).toBe(true);
  });
});

describe("discoverVolumesRequiringInspection — the union of configured and label-discovered names, with fakes", () => {
  it("inspects the UNION of configured and labeled names — a name present in only ONE of the two is still inspected", async () => {
    const inspected: string[] = [];
    const records = await discoverVolumesRequiringInspection({
      resolveConfiguredVolumeNames: async () => ["configured-only", "shared"],
      listLabeledVolumeNames: async () => ["shared", "labeled-only"],
      inspectVolumeByName: async (name) => {
        inspected.push(name);
        return fakeVolumeOwnership({ name });
      },
    });
    expect(inspected.slice().sort()).toEqual(["configured-only", "labeled-only", "shared"]);
    expect(records.map((record) => record.name).sort()).toEqual(["configured-only", "labeled-only", "shared"]);
    expect(records.every((record) => record.inspection.status === "exists")).toBe(true);
  });

  it("de-duplicates a name present in BOTH sources — inspects it only once", async () => {
    let calls = 0;
    const records = await discoverVolumesRequiringInspection({
      resolveConfiguredVolumeNames: async () => ["shared"],
      listLabeledVolumeNames: async () => ["shared"],
      inspectVolumeByName: async (name) => {
        calls += 1;
        return fakeVolumeOwnership({ name });
      },
    });
    expect(calls).toBe(1);
    expect(records).toHaveLength(1);
  });

  it("FAILS CLOSED when configured-name resolution itself fails, even though label discovery would have succeeded", async () => {
    await expect(
      discoverVolumesRequiringInspection({
        resolveConfiguredVolumeNames: async () => {
          throw new Error("docker compose config failed");
        },
        listLabeledVolumeNames: async () => ["would-have-worked"],
        inspectVolumeByName: async () => fakeVolumeOwnership(),
      }),
    ).rejects.toThrow(/docker compose config failed/i);
  });

  it("FAILS CLOSED when label-based discovery itself fails, even though configured-name resolution would have succeeded", async () => {
    await expect(
      discoverVolumesRequiringInspection({
        resolveConfiguredVolumeNames: async () => ["would-have-worked"],
        listLabeledVolumeNames: async () => {
          throw new Error("docker volume ls failed");
        },
        inspectVolumeByName: async () => fakeVolumeOwnership(),
      }),
    ).rejects.toThrow(/docker volume ls failed/i);
  });

  it("records a CONFIRMED absence distinctly from an inspection FAILURE, for different names in the same discovery", async () => {
    const records = await discoverVolumesRequiringInspection({
      resolveConfiguredVolumeNames: async () => ["absent-one", "failed-one", "exists-one"],
      listLabeledVolumeNames: async () => [],
      inspectVolumeByName: async (name) => {
        if (name === "absent-one") return undefined;
        if (name === "failed-one") throw new Error("daemon unreachable");
        return fakeVolumeOwnership({ name });
      },
    });
    const byName = Object.fromEntries(records.map((record) => [record.name, record.inspection]));
    expect(byName["absent-one"]).toEqual({ status: "absent" });
    expect(byName["failed-one"]).toEqual({ status: "failed", error: expect.stringContaining("daemon unreachable") });
    expect(byName["exists-one"]?.status).toBe("exists");
  });

  it("a single name's inspection FAILURE does not abort discovery of the OTHER names", async () => {
    const records = await discoverVolumesRequiringInspection({
      resolveConfiguredVolumeNames: async () => ["bad", "good"],
      listLabeledVolumeNames: async () => [],
      inspectVolumeByName: async (name) => {
        if (name === "bad") throw new Error("boom");
        return fakeVolumeOwnership({ name });
      },
    });
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.name === "good")?.inspection.status).toBe("exists");
    expect(records.find((record) => record.name === "bad")?.inspection.status).toBe("failed");
  });

  // THE SPECIFIC REGRESSION THIS FIX CLOSES: a volume Compose WILL
  // target by NAME on a destructive `down --volumes` (because it is
  // declared in docker-compose.yml, i.e. "configured") is not absent
  // from the configured side — only from LABEL-based discovery, exactly
  // as it would be for a volume created out-of-band, relabeled, or hit
  // by an engine/Compose labeling quirk. Label discovery alone would
  // silently let it escape inspection entirely; the union must not.
  it("REGRESSION: a configured volume absent from label-based discovery (incorrect/missing label) is still inspected and still BLOCKS destructive cleanup", async () => {
    const expectedProjectName = "relis-union-fix-aaaa1111";
    const CORRECTLY_LABELED = `${expectedProjectName}_postgres-data`;
    const MISSING_LABEL = `${expectedProjectName}_storage-data`;

    // Both volumes are CONFIGURED (docker-compose.yml always declares
    // both postgres-data and storage-data for this project) — but
    // label-based discovery reports only the correctly-labeled one.
    const sources = {
      resolveConfiguredVolumeNames: async () => [CORRECTLY_LABELED, MISSING_LABEL],
      listLabeledVolumeNames: async () => [CORRECTLY_LABELED],
      inspectVolumeByName: async (name: string) => {
        if (name === MISSING_LABEL) {
          // Physically exists (Compose created it, by name) but its
          // ownership label is missing — exactly what a mislabeled
          // volume looks like once it is actually inspected directly,
          // rather than discovered only through the label filter.
          return fakeVolumeOwnership({ name, composeProject: undefined, composeVolumeKey: "storage-data" });
        }
        return fakeVolumeOwnership({ name, composeProject: expectedProjectName, composeVolumeKey: "postgres-data" });
      },
    };

    let keepCalls = 0;
    let destroyCalls = 0;
    const target: DisposableCleanupTarget = {
      label: expectedProjectName,
      discoverVolumes: () => discoverVolumesRequiringInspection(sources),
      ownershipContext: { expectedProjectName, baselineVolumeNames: [], externalVolumeKeys: [] },
      removeContainersKeepingVolumes: async () => {
        keepCalls += 1;
      },
      removeContainersAndVolumes: async () => {
        destroyCalls += 1;
      },
    };

    const [outcome] = await cleanupDisposableTargets([target]);

    // The union DID find and inspect the mislabeled volume — label
    // discovery alone would have missed it completely — and its
    // missing label is exactly why the whole target is blocked.
    expect(outcome.volumesRequiringManualInspection.map((entry) => entry.name)).toContain(MISSING_LABEL);
    expect(outcome.volumesDeleted).toEqual([]);
    // THE CORE ASSERTION: the destructive command is NEVER called.
    expect(destroyCalls).toBe(0);
    expect(keepCalls).toBe(1);
  });
});

describe("checkProvisioningSafety/assertProvisioningSafety — validated BEFORE anything is provisioned", () => {
  it("accepts a genuinely disposable, project-scoped, non-pre-existing configuration", () => {
    const check = checkProvisioningSafety(fakeResolvedPersistence(), []);
    expect(check).toEqual({ ok: true, problems: [] });
    expect(() => assertProvisioningSafety(fakeResolvedPersistence(), [])).not.toThrow();
  });

  it("rejects a configuration that declares any volume external:true", () => {
    const resolved = fakeResolvedPersistence({ externalVolumes: ["postgres-data"] });
    const check = checkProvisioningSafety(resolved, []);
    expect(check.ok).toBe(false);
    expect(check.problems.join("\n")).toMatch(/external/i);
    expect(() => assertProvisioningSafety(resolved, [])).toThrow(/external/i);
  });

  it("rejects a volume name that is not actually scoped to the project (never a name-prefix guess elsewhere in this stack)", () => {
    const resolved = fakeResolvedPersistence({
      volumeNames: { "postgres-data": "some-completely-unrelated-volume-name", "storage-data": "relis-persist-aaaa1111_storage-data" },
    });
    const check = checkProvisioningSafety(resolved, []);
    expect(check.ok).toBe(false);
    expect(check.problems.join("\n")).toContain("some-completely-unrelated-volume-name");
  });

  it("rejects a configuration whose volume name already exists on the daemon (the baseline)", () => {
    const resolved = fakeResolvedPersistence();
    const check = checkProvisioningSafety(resolved, [resolved.volumeNames["postgres-data"] as string]);
    expect(check.ok).toBe(false);
    expect(check.problems.join("\n")).toMatch(/already exists/i);
    expect(() => assertProvisioningSafety(resolved, [resolved.volumeNames["postgres-data"] as string])).toThrow(/already exists/i);
  });
});

describe("cleanupDisposableTargets — partial setup and per-target ownership refusal, with fakes", () => {
  /**
   * Builds a fake target with call-tracking, never touching any real
   * process or Docker daemon: `owned` supplies already-paired
   * name/inspection records directly (or a function, to simulate a
   * discovery failure), exactly mirroring what the real
   * `discoverVolumesRequiringInspection` would return — WITHOUT this
   * function ever calling the real one.
   */
  function fakeTarget(options: {
    label: string;
    owned: OwnedVolumeRecord[] | (() => Promise<OwnedVolumeRecord[]>);
    context?: VolumeOwnershipContext;
  }): DisposableCleanupTarget & { keepCalls: number; destroyCalls: number } {
    const calls = { keep: 0, destroy: 0 };
    const fixedOwned = options.owned;
    const discoverVolumes: () => Promise<OwnedVolumeRecord[]> =
      typeof fixedOwned === "function" ? fixedOwned : async () => fixedOwned;
    const target: DisposableCleanupTarget & { keepCalls: number; destroyCalls: number } = {
      label: options.label,
      discoverVolumes,
      ownershipContext: options.context ?? { ...BASE_CONTEXT, expectedProjectName: options.label },
      removeContainersKeepingVolumes: async () => {
        calls.keep += 1;
      },
      removeContainersAndVolumes: async () => {
        calls.destroy += 1;
      },
      get keepCalls() {
        return calls.keep;
      },
      get destroyCalls() {
        return calls.destroy;
      },
    };
    return target;
  }

  it("blocks (never destroys) a target whose discovery finds NO volumes at all — 'nothing to check' is never 'safe to proceed'", async () => {
    const target = fakeTarget({ label: "relis-empty-target", owned: [] });
    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.volumesDeleted).toEqual([]);
    expect(outcome.volumesRequiringManualInspection).toHaveLength(1);
    expect(target.keepCalls).toBe(1);
    expect(target.destroyCalls).toBe(0);
  });

  it("destroys volumes only once EVERY one of them passes the ownership gate", async () => {
    const ownedVolumeName = "relis-good-target_postgres-data";
    const context: VolumeOwnershipContext = { expectedProjectName: "relis-good-target", baselineVolumeNames: [], externalVolumeKeys: [] };
    const target = fakeTarget({
      label: "relis-good-target",
      owned: [{ name: ownedVolumeName, inspection: exists({ name: ownedVolumeName, composeProject: "relis-good-target" }) }],
      context,
    });
    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome).toEqual({ label: "relis-good-target", volumesDeleted: [ownedVolumeName], volumesRequiringManualInspection: [] });
    expect(target.destroyCalls).toBe(1);
    expect(target.keepCalls).toBe(0);
  });

  it("treats a CONFIRMED-absent configured volume as no obstacle, destroying only the ones that actually exist", async () => {
    const existsName = "relis-mixed-target_postgres-data";
    const absentName = "relis-mixed-target_storage-data";
    const target = fakeTarget({
      label: "relis-mixed-target",
      owned: [
        { name: existsName, inspection: exists({ name: existsName, composeProject: "relis-mixed-target" }) },
        { name: absentName, inspection: absent },
      ],
      context: { expectedProjectName: "relis-mixed-target", baselineVolumeNames: [], externalVolumeKeys: [] },
    });
    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.volumesDeleted).toEqual([existsName]);
    expect(outcome.volumesRequiringManualInspection).toEqual([]);
    expect(target.destroyCalls).toBe(1);
    expect(target.keepCalls).toBe(0);
  });

  it("REFUSES deletion and reports the exact volume requiring manual inspection when ownership fails", async () => {
    const preExistingName = "relis-risky-target_postgres-data";
    const target = fakeTarget({
      label: "relis-risky-target",
      // Ownership itself looks fine (correct project label) — it is the
      // BASELINE (pre-existing before this run) that must refuse it.
      owned: [{ name: preExistingName, inspection: exists({ name: preExistingName, composeProject: "relis-risky-target" }) }],
      context: { expectedProjectName: "relis-risky-target", baselineVolumeNames: [preExistingName], externalVolumeKeys: [] },
    });
    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.volumesDeleted).toEqual([]);
    expect(outcome.volumesRequiringManualInspection).toEqual([{ name: preExistingName, reason: expect.stringMatching(/pre-existing/i) }]);
    // The destructive call must never have been made; only the safe,
    // containers-only removal runs.
    expect(target.destroyCalls).toBe(0);
    expect(target.keepCalls).toBe(1);
  });

  it("REFUSES deletion when a volume's inspection FAILED outright (not merely absent)", async () => {
    const name = "relis-uninspectable-target_postgres-data";
    const target = fakeTarget({
      label: "relis-uninspectable-target",
      owned: [{ name, inspection: failed("daemon unreachable") }],
    });
    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.volumesDeleted).toEqual([]);
    expect(outcome.volumesRequiringManualInspection).toEqual([{ name, reason: expect.stringMatching(/could not be inspected/i) }]);
    expect(target.destroyCalls).toBe(0);
    expect(target.keepCalls).toBe(1);
  });

  it("handles a target whose setup never actually started (discovering its volumes throws) without crashing or faking success", async () => {
    const target: DisposableCleanupTarget = {
      label: "relis-never-started",
      discoverVolumes: async () => {
        throw new Error("docker compose config failed: no such project");
      },
      ownershipContext: { ...BASE_CONTEXT, expectedProjectName: "relis-never-started" },
      removeContainersKeepingVolumes: async () => {
        throw new Error("should never be called");
      },
      removeContainersAndVolumes: async () => {
        throw new Error("should never be called");
      },
    };
    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.error).toMatch(/no such project/i);
    expect(outcome.volumesDeleted).toEqual([]);
    expect(outcome.volumesRequiringManualInspection).toEqual([]);
  });

  it("processes multiple targets INDEPENDENTLY — one target's failure never stops or skips another's cleanup", async () => {
    const neverStarted: DisposableCleanupTarget = {
      label: "relis-partial-a",
      discoverVolumes: async () => {
        throw new Error("never actually started");
      },
      ownershipContext: { ...BASE_CONTEXT, expectedProjectName: "relis-partial-a" },
      removeContainersKeepingVolumes: async () => undefined,
      removeContainersAndVolumes: async () => undefined,
    };
    const riskyName = "relis-partial-b_postgres-data";
    const riskyOne = fakeTarget({
      label: "relis-partial-b",
      owned: [{ name: riskyName, inspection: exists({ name: riskyName, composeProject: "relis-partial-b" }) }],
      context: { expectedProjectName: "relis-partial-b", baselineVolumeNames: [riskyName], externalVolumeKeys: [] },
    });
    const healthyName = "relis-partial-c_postgres-data";
    const healthyOne = fakeTarget({
      label: "relis-partial-c",
      owned: [{ name: healthyName, inspection: exists({ name: healthyName, composeProject: "relis-partial-c" }) }],
      context: { expectedProjectName: "relis-partial-c", baselineVolumeNames: [], externalVolumeKeys: [] },
    });

    const outcomes = await cleanupDisposableTargets([neverStarted, riskyOne, healthyOne]);

    expect(outcomes).toHaveLength(3);
    const byLabel = Object.fromEntries(outcomes.map((outcome) => [outcome.label, outcome]));

    expect(byLabel["relis-partial-a"]?.error).toMatch(/never actually started/i);
    expect(byLabel["relis-partial-b"]?.volumesRequiringManualInspection).toHaveLength(1);
    expect(byLabel["relis-partial-b"]?.volumesDeleted).toEqual([]);
    expect(byLabel["relis-partial-c"]?.volumesDeleted).toEqual([healthyName]);

    // The healthy target's own destructive call ran, and the risky
    // target's never did — proving the failure/refusal for the other two
    // targets did not suppress or alter this target's own outcome.
    expect(healthyOne.destroyCalls).toBe(1);
    expect(riskyOne.destroyCalls).toBe(0);
  });
});

// Regression coverage for a review finding on sub-issue 02.04:
// proxy-health.test.ts and port-exposure.test.ts now build their cleanup
// via `createComposeCleanupTarget` + `cleanupDisposableTargets` (the same
// guarded contract `persistence.test.ts` uses — see this file's own
// header comment for why the NEGATIVE ownership/discovery paths are
// proven here, with fakes, rather than against a real volume). These
// cases mirror those two files' own project shapes specifically —
// proxy-health.test.ts starts only `nginx`/`web`/`api` (no volume is
// actually expected to exist), port-exposure.test.ts's runtime suite
// starts the full stack (both `postgres-data`/`storage-data` really
// exist) — proving the SAME guard rejects destructive cleanup for both
// shapes when ownership is unsafe or discovery itself fails.
describe("guarded cleanup for the 02.04 proxy-health/port-exposure call sites — unsafe ownership or failed discovery blocks destruction", () => {
  function fakeGuardedTarget(options: {
    label: string;
    resolveConfiguredVolumeNames: () => Promise<string[]>;
    listLabeledVolumeNames: () => Promise<string[]>;
    inspectVolumeByName: (name: string) => Promise<VolumeOwnership | undefined>;
    context: VolumeOwnershipContext;
  }): DisposableCleanupTarget & { keepCalls: number; destroyCalls: number } {
    const calls = { keep: 0, destroy: 0 };
    return {
      label: options.label,
      discoverVolumes: () =>
        discoverVolumesRequiringInspection({
          resolveConfiguredVolumeNames: options.resolveConfiguredVolumeNames,
          listLabeledVolumeNames: options.listLabeledVolumeNames,
          inspectVolumeByName: options.inspectVolumeByName,
        }),
      ownershipContext: options.context,
      removeContainersKeepingVolumes: async () => {
        calls.keep += 1;
      },
      removeContainersAndVolumes: async () => {
        calls.destroy += 1;
      },
      get keepCalls() {
        return calls.keep;
      },
      get destroyCalls() {
        return calls.destroy;
      },
    };
  }

  it("proxy-health.test.ts's shape — a FAILED configuration resolution (e.g. 'docker compose config' itself failing) fails closed and never destroys anything", async () => {
    const target = fakeGuardedTarget({
      label: "relis-proxy-health-aaaa1111",
      resolveConfiguredVolumeNames: async () => {
        throw new Error("docker compose config --format json failed (exit 1)");
      },
      listLabeledVolumeNames: async () => [],
      inspectVolumeByName: async () => fakeVolumeOwnership(),
      context: { expectedProjectName: "relis-proxy-health-aaaa1111", baselineVolumeNames: [], externalVolumeKeys: [] },
    });

    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.error).toMatch(/docker compose config.*failed/i);
    expect(outcome.volumesDeleted).toEqual([]);
    expect(target.destroyCalls).toBe(0);
    // Setup never completed, so even the safe containers-only removal is
    // never attempted for this target either — there is nothing it owns
    // to clean up.
    expect(target.keepCalls).toBe(0);
  });

  it("proxy-health.test.ts's shape — neither postgres-data nor storage-data was ever created (both CONFIRMED absent): cleanup proceeds safely with nothing to delete", async () => {
    const projectName = "relis-proxy-health-bbbb2222";
    const target = fakeGuardedTarget({
      label: projectName,
      resolveConfiguredVolumeNames: async () => [`${projectName}_postgres-data`, `${projectName}_storage-data`],
      listLabeledVolumeNames: async () => [],
      inspectVolumeByName: async () => undefined,
      context: { expectedProjectName: projectName, baselineVolumeNames: [], externalVolumeKeys: [] },
    });

    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.volumesDeleted).toEqual([]);
    expect(outcome.volumesRequiringManualInspection).toEqual([]);
    // A CONFIRMED absence is never a reason to block the destructive
    // step — there is simply nothing there to delete or protect.
    expect(target.destroyCalls).toBe(1);
    expect(target.keepCalls).toBe(0);
  });

  it("port-exposure.test.ts's shape — a MISLABELED postgres-data (real daemon volume, wrong/missing Compose project label) REFUSES the destructive step for the whole target", async () => {
    const projectName = "relis-port-runtime-cccc3333";
    const postgresDataName = `${projectName}_postgres-data`;
    const storageDataName = `${projectName}_storage-data`;
    const target = fakeGuardedTarget({
      label: projectName,
      resolveConfiguredVolumeNames: async () => [postgresDataName, storageDataName],
      listLabeledVolumeNames: async () => [storageDataName],
      inspectVolumeByName: async (name) => {
        if (name === postgresDataName) {
          // Exists physically (Compose created it, by name) but its
          // ownership label does not match this disposable project —
          // exactly the "mislabeled or relabeled volume" scenario
          // `discoverVolumesRequiringInspection`'s union is meant to
          // still catch, even though label-based discovery alone missed it.
          return fakeVolumeOwnership({ name: postgresDataName, composeProject: "someone-elses-dev-stack", composeVolumeKey: "postgres-data" });
        }
        return fakeVolumeOwnership({ name: storageDataName, composeProject: projectName, composeVolumeKey: "storage-data" });
      },
      context: { expectedProjectName: projectName, baselineVolumeNames: [], externalVolumeKeys: [] },
    });

    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.volumesDeleted).toEqual([]);
    expect(outcome.volumesRequiringManualInspection).toEqual([
      { name: postgresDataName, reason: expect.stringContaining("someone-elses-dev-stack") },
    ]);
    // The destructive command is NEVER called for this target — only the
    // safe, containers-only removal runs, for BOTH volumes together
    // (ownership is all-or-nothing per target).
    expect(target.destroyCalls).toBe(0);
    expect(target.keepCalls).toBe(1);
  });

  it("port-exposure.test.ts's shape — storage-data already existed on the daemon before this run (the baseline) REFUSES destruction even though postgres-data is genuinely owned", async () => {
    const projectName = "relis-port-runtime-dddd4444";
    const postgresDataName = `${projectName}_postgres-data`;
    const storageDataName = `${projectName}_storage-data`;
    const target = fakeGuardedTarget({
      label: projectName,
      resolveConfiguredVolumeNames: async () => [postgresDataName, storageDataName],
      listLabeledVolumeNames: async () => [postgresDataName, storageDataName],
      inspectVolumeByName: async (name) =>
        fakeVolumeOwnership({ name, composeProject: projectName, composeVolumeKey: name === postgresDataName ? "postgres-data" : "storage-data" }),
      context: { expectedProjectName: projectName, baselineVolumeNames: [storageDataName], externalVolumeKeys: [] },
    });

    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.volumesDeleted).toEqual([]);
    expect(outcome.volumesRequiringManualInspection).toEqual([{ name: storageDataName, reason: expect.stringMatching(/pre-existing/i) }]);
    expect(target.destroyCalls).toBe(0);
    expect(target.keepCalls).toBe(1);
  });

  it("port-exposure.test.ts's shape — an INSPECTION FAILURE for one volume (daemon unreachable mid-discovery) REFUSES destruction for the whole target, never reading it as absence", async () => {
    const projectName = "relis-port-runtime-eeee5555";
    const postgresDataName = `${projectName}_postgres-data`;
    const storageDataName = `${projectName}_storage-data`;
    const target = fakeGuardedTarget({
      label: projectName,
      resolveConfiguredVolumeNames: async () => [postgresDataName, storageDataName],
      listLabeledVolumeNames: async () => [postgresDataName, storageDataName],
      inspectVolumeByName: async (name) => {
        if (name === storageDataName) {
          throw new Error("daemon unreachable while inspecting storage-data");
        }
        return fakeVolumeOwnership({ name: postgresDataName, composeProject: projectName, composeVolumeKey: "postgres-data" });
      },
      context: { expectedProjectName: projectName, baselineVolumeNames: [], externalVolumeKeys: [] },
    });

    const [outcome] = await cleanupDisposableTargets([target]);
    expect(outcome.volumesDeleted).toEqual([]);
    expect(outcome.volumesRequiringManualInspection).toEqual([
      { name: storageDataName, reason: expect.stringContaining("daemon unreachable while inspecting storage-data") },
    ]);
    expect(target.destroyCalls).toBe(0);
    expect(target.keepCalls).toBe(1);
  });
});

describe("parseS3ErrorBody / isS3ObjectAbsent — a specific S3 'not found', never merely 'any error'", () => {
  const NO_SUCH_KEY_BODY =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>';
  const NO_SUCH_BUCKET_BODY =
    '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist.</Message></Error>';
  const ACCESS_DENIED_BODY = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>';

  it("parses a real NoSuchKey body", () => {
    expect(parseS3ErrorBody(NO_SUCH_KEY_BODY)).toEqual({ code: "NoSuchKey", message: "The specified key does not exist." });
  });

  it("parses a real NoSuchBucket body", () => {
    expect(parseS3ErrorBody(NO_SUCH_BUCKET_BODY)).toEqual({ code: "NoSuchBucket", message: "The specified bucket does not exist." });
  });

  it("returns undefined fields for a body that isn't a recognizable S3 XML error (never throws)", () => {
    expect(parseS3ErrorBody("")).toEqual({ code: undefined, message: undefined });
    expect(parseS3ErrorBody("<html><body>502 Bad Gateway</body></html>")).toEqual({ code: undefined, message: undefined });
  });

  it("accepts ONLY HTTP 404 with NoSuchKey or NoSuchBucket as absence", () => {
    expect(isS3ObjectAbsent({ status: 404, code: "NoSuchKey", message: undefined })).toBe(true);
    expect(isS3ObjectAbsent({ status: 404, code: "NoSuchBucket", message: undefined })).toBe(true);
  });

  it("rejects an authentication failure, even though it is also an error response", () => {
    expect(isS3ObjectAbsent({ status: 403, code: "AccessDenied", message: undefined })).toBe(false);
    expect(isS3ObjectAbsent({ status: 401, code: "SignatureDoesNotMatch", message: undefined })).toBe(false);
  });

  it("rejects a server error (5xx)", () => {
    expect(isS3ObjectAbsent({ status: 500, code: "InternalError", message: undefined })).toBe(false);
    expect(isS3ObjectAbsent({ status: 503, code: undefined, message: undefined })).toBe(false);
  });

  it("rejects a response with no parseable Code at all, even if the status happens to be 404", () => {
    expect(isS3ObjectAbsent({ status: 404, code: undefined, message: undefined })).toBe(false);
  });

  it("rejects a 404 whose Code is something else entirely — status alone is never sufficient", () => {
    expect(isS3ObjectAbsent({ status: 404, code: "AccessDenied", message: undefined })).toBe(false);
  });

  it("readS3ErrorResponse reads a real Response end to end and classifies it correctly", async () => {
    const notFound = await readS3ErrorResponse(new Response(NO_SUCH_KEY_BODY, { status: 404 }));
    expect(notFound).toEqual({ status: 404, code: "NoSuchKey", message: "The specified key does not exist." });
    expect(isS3ObjectAbsent(notFound)).toBe(true);

    // The unrelated-error shapes this finding explicitly calls out:
    // auth failure, server error, and a connection-style failure must
    // never be read as absence.
    const forbidden = await readS3ErrorResponse(new Response(ACCESS_DENIED_BODY, { status: 403 }));
    expect(isS3ObjectAbsent(forbidden)).toBe(false);

    const serverError = await readS3ErrorResponse(new Response("", { status: 503 }));
    expect(isS3ObjectAbsent(serverError)).toBe(false);

    const malformed = await readS3ErrorResponse(new Response("<html>not an S3 response</html>", { status: 404 }));
    expect(isS3ObjectAbsent(malformed)).toBe(false);
  });
});
