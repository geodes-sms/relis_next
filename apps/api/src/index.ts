import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "http://localhost:3000",
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

serve(
  {
    fetch: app.fetch,
    port: 3001,
  },
  (info) => {
    console.log(`ReLiS API running on http://localhost:${info.port}`);
  },
);
