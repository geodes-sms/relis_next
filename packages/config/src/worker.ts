import { z } from "zod";
import { nodeEnvSchema, resolveOrDefault } from "./primitives.js";
import { parseConfig, type ConfigCategory } from "./parse.js";

const DEFAULTS = {
  NODE_ENV: "development",
} as const;

export const workerConfigSchema = z.object({
  NODE_ENV: nodeEnvSchema,
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export interface RawWorkerEnv {
  NODE_ENV?: string;
}

/**
 * apps/worker currently only logs its own startup: it has no real queue or
 * database consumer, so no variable is required here. Background-job
 * technology (pg-boss vs. BullMQ) remains an undecided stack choice; do not
 * add queue/database variables to this schema until a real consumer exists.
 */
export function loadWorkerConfig(raw: RawWorkerEnv): WorkerConfig {
  const resolved = {
    NODE_ENV: resolveOrDefault(raw.NODE_ENV, DEFAULTS.NODE_ENV),
  };
  return parseConfig("worker", workerConfigSchema, resolved, () => "runtime");
}

export const WORKER_CONFIG_CATEGORIES: readonly ConfigCategory[] = ["runtime"];
