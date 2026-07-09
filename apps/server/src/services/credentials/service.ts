// The `credentials` uService (ADR 0006, ARCHITECTURE.md §6): ties secret-store
// backends to credential providers. Picks a backend at init and binds it as the
// shared `ctx.secrets`; validates on save and every 6h; secret material never
// reaches SQLite, logs, or the browser — only `credentials_meta` (status/expiry).
import { AppError, NotFoundError, SecretsLockedError, ValidationError } from "../../kernel/errors";
import type {
  MicroService,
  SecretStore,
  SecretStoreBackend,
  ServiceContext,
} from "../../kernel/ports";
import type { CredentialProvider, CredentialStatus } from "./ports";

const REVALIDATE_MS = 6 * 3_600_000;

interface Timers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export interface CredentialsService extends MicroService {
  /** A per-request token reader for a credential id (e.g. "github-pat:default"). */
  tokenProvider(id: string): () => Promise<string>;
}

export function createCredentialsService(opts: {
  /** Late-binds the chosen backend as the kernel's shared `ctx.secrets` (T1.4). */
  bindSecrets: (store: SecretStore) => void;
  backends: SecretStoreBackend[]; // priority order, e.g. [keychain, encrypted-file]
  providers: CredentialProvider[]; // e.g. [githubPatProvider()]
  /** Test seam: deterministic timer for the 6h revalidation (same idea as T2.6). */
  timers?: Timers;
}): CredentialsService {
  const providers = new Map(opts.providers.map((p) => [p.type, p]));
  let ctx: ServiceContext;
  let backend: SecretStoreBackend;
  let timers: Timers;
  let revalHandle: ReturnType<typeof setInterval> | undefined;

  const account = (id: string) => `cred.${id}`;

  function providerFor(id: string): CredentialProvider {
    const type = id.split(":")[0] ?? id; // id = "<type>:label"
    const provider = providers.get(type);
    if (!provider) throw new ValidationError(`unknown credential type for '${id}'`);
    return provider;
  }

  async function selectBackend(): Promise<SecretStoreBackend> {
    const override = ctx.config.secretBackend;
    if (override) {
      const b = opts.backends.find((x) => x.id === override);
      if (!b)
        throw new AppError("credential.backend_unknown", `no secret backend '${override}'`, 500);
      return b; // an explicit override trusts the operator; skip the availability probe
    }
    for (const b of opts.backends) if (await b.available()) return b;
    throw new AppError("credential.no_backend", "no secret backend is available here", 500);
  }

  /** Scopes a classic PAT is missing; a fine-grained PAT reports none, which is not a gap. */
  function missingScopes(type: string, scopes: string[] | undefined): string[] {
    if (!scopes || scopes.length === 0) return [];
    const required = providers.get(type)?.describe().requiredScopes ?? [];
    return required.filter((s) => !scopes.includes(s));
  }

  /** Upsert `credentials_meta` and fire the matching event + notification. */
  function applyStatus(id: string, type: string, status: CredentialStatus): void {
    const checkedAt = ctx.config.now().toISOString();
    const expiresAt =
      status.state === "expiring"
        ? status.expiresAt
        : status.state === "ok"
          ? (status.expiresAt ?? null)
          : null;
    const detail = status.state === "invalid" ? status.reason : null;
    ctx.db
      .query(
        `INSERT INTO credentials_meta(id, type, backend, label, status, status_detail, expires_at, checked_at)
         VALUES(?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           type=?2, backend=?3, status=?4, status_detail=?5, expires_at=?6, checked_at=?7`,
      )
      .run(id, type, backend.id, status.state, detail, expiresAt, checkedAt);

    if (status.state === "invalid") {
      ctx.bus.emit({ type: "credential.invalid", id });
      ctx.notify({
        key: `credential.${id}.invalid`,
        level: "error",
        title: `Credential ${id} is invalid`,
        body: status.reason,
        source: "credentials",
      });
      return;
    }
    // Recovery: any non-invalid state clears a prior `credential.<id>.invalid`
    // card. The refresh scheduler pauses while such a card is active
    // (scheduler.ts), so without this the scheduler stays paused after a token is
    // fixed. `ctx.resolve` is the notifications uService primitive (E5, T5.1).
    ctx.resolve(`credential.${id}.invalid`);
    if (status.state === "expiring") {
      ctx.bus.emit({ type: "credential.expiring", id, daysLeft: status.daysLeft });
      ctx.notify({
        key: `credential.${id}.expiring`,
        level: "warning",
        title: `Credential ${id} expires soon`,
        body: `${status.daysLeft} day(s) left`,
        source: "credentials",
      });
      return;
    }
    const missing = missingScopes(type, status.scopes);
    if (missing.length > 0) {
      ctx.notify({
        key: `credential.${id}.scopes`,
        level: "warning",
        title: `Credential ${id} is missing scopes`,
        body: `missing: ${missing.join(", ")}`,
        source: "credentials",
      });
    }
  }

  /** Every 6h: re-read + re-validate each stored credential. Silent while locked. */
  async function revalidateAll(): Promise<void> {
    const rows = ctx.db.query("SELECT id, type FROM credentials_meta").all() as Array<{
      id: string;
      type: string;
    }>;
    for (const row of rows) {
      const provider = providers.get(row.type);
      if (!provider) continue;
      let secret: string | null;
      try {
        secret = await ctx.secrets.get(account(row.id));
      } catch (e) {
        if (e instanceof SecretsLockedError) return; // locked: skip the whole tick quietly
        throw e;
      }
      if (secret === null) continue; // secret removed out-of-band; leave meta untouched
      applyStatus(row.id, row.type, await provider.validate(secret, ctx));
    }
  }

  return {
    name: "credentials",
    tokenProvider(id) {
      return async () => {
        const secret = await ctx.secrets.get(account(id)); // throws SecretsLockedError while locked
        if (secret === null) throw new NotFoundError(`credential ${id}`);
        return secret;
      };
    },
    async init(c) {
      ctx = c;
      backend = await selectBackend();
      opts.bindSecrets(backend); // from here ctx.secrets serves every service
      ctx.log.info("secret backend selected", { backend: backend.id });
      timers = opts.timers ?? { setInterval, clearInterval };
      revalHandle = timers.setInterval(() => {
        revalidateAll().catch((e) =>
          ctx.log.warn("credential revalidation failed", { err: String(e) }),
        );
      }, REVALIDATE_MS);
    },
    shutdown() {
      if (revalHandle !== undefined) timers.clearInterval(revalHandle);
    },
    routes(app) {
      app.get("/", (c) => {
        const rows = ctx.db.query("SELECT * FROM credentials_meta").all() as Array<{
          type: string;
        }>;
        // meta only — never secret material; describe() tells the UI what to collect
        return c.json(rows.map((r) => ({ ...r, describe: providers.get(r.type)?.describe() })));
      });

      app.put("/:id", async (c) => {
        const id = c.req.param("id");
        const provider = providerFor(id);
        const body = (await c.req.json().catch(() => {
          throw new ValidationError("body must be JSON");
        })) as { secret?: unknown };
        if (typeof body.secret !== "string" || body.secret === "") {
          throw new ValidationError("secret is required");
        }
        const status = await provider.validate(body.secret, ctx);
        if (status.state !== "invalid") await backend.set(account(id), body.secret);
        applyStatus(id, provider.type, status);
        if (status.state === "invalid")
          throw new AppError("credential.invalid", status.reason, 400);
        return c.json({ id, status: status.state });
      });

      app.post("/:id/validate", async (c) => {
        const id = c.req.param("id");
        const provider = providerFor(id);
        const secret = await ctx.secrets.get(account(id));
        if (secret === null) throw new NotFoundError(`credential ${id}`);
        const status = await provider.validate(secret, ctx);
        applyStatus(id, provider.type, status);
        return c.json({ id, status: status.state });
      });

      app.delete("/:id", async (c) => {
        const id = c.req.param("id");
        await backend.delete(account(id));
        ctx.db.query("DELETE FROM credentials_meta WHERE id=?").run(id);
        return c.json({ deleted: true });
      });
    },
  };
}
