import { Hono } from "hono";
import { openDatabase } from "./adapters/db/database";
import { runMigrations } from "./adapters/db/migrate";
import { migrations } from "./adapters/db/migrations";
import { createGitHubClient } from "./adapters/github/client";
import { createEventBus } from "./kernel/bus";
import { loadConfig } from "./kernel/config";
import { createContext } from "./kernel/context";
import { AppError } from "./kernel/errors";
import { createLogger } from "./kernel/logger";
import type { Logger } from "./kernel/ports";
import { createKernel } from "./kernel/registry";
import { createDataService } from "./services/data/service";

/**
 * The composition root: build config, logger, bus, DB, and the kernel, wire the
 * shared error envelope, and return the pieces `index.ts` (or a test) drives.
 * Services are registered here as tasks land (notifications → credentials → auth →
 * data → workspace); E2 registers `data`.
 */
export function buildApp(env: Record<string, string | undefined> = process.env) {
  const config = loadConfig(env);
  const log = createLogger("app");
  const bus = createEventBus(log);
  const db = openDatabase(config.dbPath);
  runMigrations(db, migrations);
  const { ctx, ...bind } = createContext({ db, bus, config, log });
  const kernel = createKernel(ctx);
  const app = new Hono();

  // The one GitHub door. The token comes from the secrets port per request
  // (rotation-safe); until the credentials service (T3.4) binds a real store,
  // every sync fails into the stale-serve path with a notification.
  const gh = createGitHubClient({
    tokenProvider: async () => {
      const token = await ctx.secrets.get("github-pat:default");
      if (!token) {
        throw new AppError("credential.missing", "no GitHub token stored", 401);
      }
      return token;
    },
    log: log.child("github"),
  });
  kernel.register(createDataService({ gh }));

  app.get("/api/health", (c) => c.json({ status: "ok", service: "ghreporting" }));
  wireErrorEnvelope(app, log);

  return { app, kernel, ctx, bind };
}

/** The shared JSON error envelope every route answers failures with. */
export function wireErrorEnvelope(app: Hono, log: Logger): void {
  app.onError((err, c) => {
    const e = err instanceof AppError ? err : new AppError("internal", String(err), 500);
    if (e.status >= 500) log.error("unhandled", { path: c.req.path, err: String(err) });
    // A bad status would make c.json throw a RangeError out of onError — clamp to 500.
    const status = e.status >= 200 && e.status <= 599 ? e.status : 500;
    return c.json({ error: { code: e.code, message: e.message } }, status as 400);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));
}
