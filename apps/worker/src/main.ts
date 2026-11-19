import {
  ConfigValidationError,
  loadEnvFiles,
  loadWorkerConfig,
  resolveRuntimeMode,
  type WorkerConfig,
} from "@relis/config";

function loadValidatedConfig(): WorkerConfig {
  try {
    return loadWorkerConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(JSON.stringify(error.toDiagnostic()));
      process.exit(1);
    }
    throw error;
  }
}

function main(): void {
  loadEnvFiles(resolveRuntimeMode(process.env.NODE_ENV));

  // Configuration must be valid before this process does anything else.
  loadValidatedConfig();

  console.log("ReLiS worker started");
}

main();
