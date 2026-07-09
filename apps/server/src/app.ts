import { Hono } from "hono";

/**
 * Builds the HTTP application. The uService kernel (task T1.1) will take over
 * route mounting; until then this is the composition root for routes.
 */
export function createApp(): Hono {
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok", service: "ghreporting" }));
  return app;
}
