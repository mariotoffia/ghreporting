import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { openDatabase, openReadOnly } from "./adapters/db/database";
import { runMigrations } from "./adapters/db/migrate";
import { migrations } from "./adapters/db/migrations";
import { createGitHubClient } from "./adapters/github/client";
import { createEncryptedFileBackend } from "./adapters/secretstore/encfile";
import { createKeychainBackend } from "./adapters/secretstore/keychain";
import { createEventBus } from "./kernel/bus";
import { loadConfig } from "./kernel/config";
import { createContext } from "./kernel/context";
import { AppError } from "./kernel/errors";
import { createLogger } from "./kernel/logger";
import type { Logger, SecretStoreBackend } from "./kernel/ports";
import { createKernel } from "./kernel/registry";
import { createMasterKeyFileBackend } from "./services/auth/masterkey";
import { createAuthService, SESSION_COOKIE } from "./services/auth/service";
import { createSessionStore } from "./services/auth/session";
import type { WebAuthnLib } from "./services/auth/webauthn";
import { githubPatProvider } from "./services/credentials/providers/github-pat";
import { createCredentialsService } from "./services/credentials/service";
import { createDataService } from "./services/data/service";
import { createNotificationsService } from "./services/notifications/service";
import { createReportsService } from "./services/reports/service";
import { createWorkspaceService } from "./services/workspace/service";

/**
 * The composition root: build config, logger, bus, DB, and the kernel, wire the
 * shared error envelope, and return the pieces `index.ts` (or a test) drives.
 * Services are registered here as tasks land (notifications → credentials → auth →
 * data → workspace); E2 registers `data`, E4 registers `auth` and the session gate.
 *
 * `deps` is the test seam: unit tests inject an in-memory master-key backend
 * (never the real keychain, TESTS.md §4) and a scripted WebAuthn lib.
 */
export function buildApp(
  env: Record<string, string | undefined> = process.env,
  deps: { masterKeyBackend?: SecretStoreBackend; webauthnLib?: WebAuthnLib } = {},
) {
  const config = loadConfig(env);
  const log = createLogger("app");
  const bus = createEventBus(log);
  const db = openDatabase(config.dbPath);
  runMigrations(db, migrations);
  // Second handle for user query-dataset SQL (ADR 0016). Only for a real file — a
  // `:memory:` DB has no shared second handle, so query datasets are inert under that
  // config (the resolver falls through to NotFound, built-ins keep working).
  const roDb = config.dbPath === ":memory:" ? undefined : openReadOnly(config.dbPath);
  const { ctx, ...bind } = createContext({ db, bus, config, log });
  const kernel = createKernel(ctx);
  const app = new Hono();

  // The master key for the encrypted-file backend lives in memory only while
  // unlocked; E4 (T4.2) sets `master.key` on `auth.unlocked`. Until then the
  // encrypted-file backend is locked (darwin uses the keychain instead).
  const master: { key: Uint8Array | null } = { key: null };
  const credentials = createCredentialsService({
    bindSecrets: bind.bindSecrets,
    backends: [
      createKeychainBackend(),
      createEncryptedFileBackend({
        path: config.secretsPath,
        // Hand out a per-call snapshot. Today encfile consumes the key synchronously
        // (WebCrypto importKey copies the bytes before any await), so logout's in-place
        // key.fill(0) is already safe — but the key buffer is shared-mutable, so a
        // snapshot keeps that true if a reader ever holds the key across an await.
        keyProvider: () => (master.key ? new Uint8Array(master.key) : null),
      }),
    ],
    providers: [githubPatProvider()],
  });

  // The one GitHub door. The token comes from the credentials service per request
  // (rotation-safe); before a valid token is stored, every sync fails into the
  // stale-serve path with a notification.
  const gh = createGitHubClient({
    tokenProvider: credentials.tokenProvider("github-pat:default"),
    log: log.child("github"),
  });
  // Access (E4): sessions live here so the gate middleware and the auth service
  // share one store. The master key rests in the keychain on darwin, else a
  // 0600 file — first available wins, mirroring the secret-backend selection.
  const sessions = createSessionStore(() => config.now());
  const auth = createAuthService({
    sessions,
    masterKeyBackends: deps.masterKeyBackend
      ? [deps.masterKeyBackend]
      : [createKeychainBackend(), createMasterKeyFileBackend(config.masterKeyPath)],
    setMasterKey: (key) => {
      master.key = key;
    },
    lib: deps.webauthnLib,
  });

  // The gate (ARCHITECTURE.md §6): every /api/* call needs a Session except
  // health and the auth ceremonies themselves.
  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    if (path === "/api/health" || path.startsWith("/api/auth/")) return next();
    const token = getCookie(c, SESSION_COOKIE);
    if (!token || !sessions.touch(token)) {
      return c.json({ error: { code: "unauthorized", message: "login required" } }, 401);
    }
    return next();
  });

  // notifications first: its init binds ctx.notify/ctx.resolve, so every later
  // service (credentials fires cards on a bad token) sees a live notifier.
  // Then credentials before auth (unlock needs the bound secret store) before data.
  kernel.register(
    createNotificationsService({ bindNotify: bind.bindNotify, bindResolve: bind.bindResolve }),
  );
  kernel.register(credentials);
  kernel.register(auth);
  kernel.register(createDataService({ gh, roDb }));
  // reports after data: it seeds the Copilot Spend definition on init and its ReportView
  // executes against the data service in the browser (ADR 0014). It owns only the
  // `reports` table, so this order is about intent, not a hard dependency.
  kernel.register(createReportsService());
  // workspace last: it only owns the workbooks/bindings tables and depends on
  // nothing but the shared DB (DDD.md §3.3), so registration order is cosmetic here.
  kernel.register(createWorkspaceService());

  app.get("/api/health", (c) => c.json({ status: "ok", service: "ghreporting" }));
  wireErrorEnvelope(app, log);

  return { app, kernel, ctx, bind, sessions, roDb };
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
