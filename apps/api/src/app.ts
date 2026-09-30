import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ApiConfig } from "@relis/config";

/**
 * Composes the Hono application from validated configuration. main.ts is
 * responsible for validating configuration and starting the listener;
 * this module never reads process.env directly.
 */
export function createApp(config: ApiConfig) {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: config.API_CORS_ORIGIN,
      allowMethods: ["GET", "OPTIONS"],
    }),
  );

  app.get("/", (c) => {
    return c.text("ReLiS API");
  });

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      message: "Bienvenue dans le nouveau ReLiS",
      service: "api",
    });
  });

  // Readiness reflects configuration categories actually initialized by
  // this process before serve() was called. It does not claim a database
  // or queue dependency: apps/api has neither today.
  app.get("/ready", (c) => {
    return c.json({
      status: "ok",
      service: "api",
      checks: {
        network: "ok",
        cors: "ok",
      },
    });
  });

  return app;
}
