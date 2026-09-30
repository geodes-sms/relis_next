// Hand-authored type declarations for deploy.mjs (plain JS, no build step).
// deploy.mjs stays untyped JavaScript; this file exists solely so tests
// importing it get an accurate, narrowable type instead of TypeScript's
// own structural inference from the file's multiple `return {...}`
// statements, which loses the real ok-true/ok-false discriminant (every
// branch returns the same property names, so `ok` widens to `boolean` and
// every other field widens to its across-all-branches union). It changes
// no runtime behavior.
import type { ConfigDiagnostic, RuntimeMode } from "@relis/config";

export type DeployEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface ValidateDeploymentOptions {
  skipMigrate?: boolean;
}

export interface ValidateDeploymentSuccess {
  ok: true;
  diagnostic: null;
  mode: RuntimeMode;
  apiEnv: Record<string, string>;
  webEnv: Record<string, string>;
  workerEnv: Record<string, string>;
  databaseEnv: Record<string, string>;
}

export interface ValidateDeploymentFailure {
  ok: false;
  diagnostic: ConfigDiagnostic;
  // Unlike the success case, a failure can occur before some (or all) of
  // these were ever resolved — see deploy.mjs's own try/catch: mode/apiEnv/
  // webEnv/workerEnv/databaseEnv are only assigned as validation proceeds.
  mode: RuntimeMode | undefined;
  apiEnv: Record<string, string> | undefined;
  webEnv: Record<string, string> | undefined;
  workerEnv: Record<string, string> | undefined;
  databaseEnv: Record<string, string> | undefined;
}

export type ValidateDeploymentResult = ValidateDeploymentSuccess | ValidateDeploymentFailure;

export function validateDeployment(baseEnv: DeployEnv, options?: ValidateDeploymentOptions): ValidateDeploymentResult;

export interface DeployStep {
  name: string;
  run: () => Promise<number>;
}

export interface RunStepsResult {
  ok: boolean;
  failedStep: string | null;
  exitCode: number;
}

export function runSteps(steps: DeployStep[]): Promise<RunStepsResult>;

export interface StepFactoryOptions {
  spawnFn?: (...args: unknown[]) => unknown;
}

export function createMigrateStep(
  target: "control" | "project",
  env: Record<string, string>,
  options?: StepFactoryOptions,
): DeployStep;
export function createBuildStep(
  name: string,
  filterArgs: string[],
  env: Record<string, string>,
  options?: StepFactoryOptions,
): DeployStep;
export function createWorkerStep(env: Record<string, string>, options?: StepFactoryOptions): DeployStep;

/**
 * The minimal duck-typed contract startAndSupervise actually relies on for
 * a spawned service, satisfied both by a real node:child_process
 * ChildProcess and by a test's injected fake (e.g. an EventEmitter given
 * matching exitCode/signalCode/kill members).
 */
export interface SupervisedChild {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean | void;
}

export interface ServiceDefinition {
  name: string;
  command: string;
  args: string[];
  env: DeployEnv;
  cwd: string;
  stdio?: unknown;
}

export interface SupervisorOptions {
  spawnFn?: (command: string, args: string[], options: Record<string, unknown>) => SupervisedChild;
  killFn?: (pid: number, signal?: string) => Promise<boolean>;
  gracePeriodMs?: number;
}

export interface Supervisor {
  exitPromise: Promise<number>;
  requestShutdown: (signal?: string) => Promise<number>;
}

export function startAndSupervise(services: ServiceDefinition[], options?: SupervisorOptions): Supervisor;
