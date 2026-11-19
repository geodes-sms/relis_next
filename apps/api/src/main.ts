import { serve } from "@hono/node-server";
import {
  ConfigValidationError,
  loadApiConfig,
  loadEnvFiles,
  resolveRuntimeMode,
  type ApiConfig,
} from "@relis/config";
import { createApp } from "./app.js";

function loadValidatedConfig(): ApiConfig {
  try {
    return loadApiConfig(process.env);
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

  // Configuration must be valid before any listener opens or the API
  // accepts traffic.
  const config = loadValidatedConfig();

  const app = createApp(config);

  const server = serve(
    {
      fetch: app.fetch,
      port: config.API_PORT,
      hostname: config.API_HOST,
    },
    (info) => {
      console.log(`ReLiS API running on http://${info.address}:${info.port}`);
    },
  );

  // A syntactically valid API_HOST can still fail to bind at runtime (DNS
  // resolution failure, permission denied, ...). Node's default unhandled
  // 'error' event prints the underlying error, which can include the
  // submitted host/port; report a safe diagnostic instead.
  server.on("error", () => {
    console.error(
      JSON.stringify({ code: "SERVER_START_FAILED", process: "api", categories: ["network"], variables: [] }),
    );
    process.exit(1);
  });
}

main();
