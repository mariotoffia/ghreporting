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
import type { CredentialProvider, CredentialStatus, DeviceFlowProvider } from "./ports";

const REVALIDATE_MS = 6 * 3_600_000;

/** Single default instance per credential type — the convention `github-pat:default` uses. */
const defaultId = (type: string) => `${type}:default`;

/** A provider also implements the optional device-flow port (interface segregation, ADR 0018). */
function isDeviceFlow(p: CredentialProvider): p is CredentialProvider & DeviceFlowProvider {
  return typeof (p as Partial<DeviceFlowProvider>).startDevice === "function";
}

interface Timers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export interface CredentialsService extends MicroService {
  /** A per-request token reader for a credential id (e.g. "github-pat:default"). */
  tokenProvider(id: string): () => Promise<string>;
  /**
   * A per-request reader that returns the secret of the first configured id in `ids`,
   * so one GitHub door reads either a device-flow token or a pasted PAT (ADR 0018).
   * Propagates SecretsLockedError; throws NotFoundError only if none is configured.
   */
  firstConfiguredTokenProvider(ids: string[]): () => Promise<string>;
  /**
   * A per-request reader returning EVERY configured secret in `ids` order (skipping
   * unconfigured), so the GitHub client can try a complementary token on a 401/403 — e.g.
   * a billing PAT then a Copilot device token (ADR 0018). Propagates SecretsLockedError.
   */
  configuredTokensProvider(ids: string[]): () => Promise<string[]>;
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
  // Pending device ceremonies, in memory only (ADR 0018): the deviceCode never reaches the
  // browser and dies with the process — device codes are short-lived and single-user.
  const pending = new Map<string, { deviceCode: string; expiresAt: number }>();

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
    firstConfiguredTokenProvider(ids) {
      return async () => {
        for (const id of ids) {
          const secret = await ctx.secrets.get(account(id)); // locked → SecretsLockedError propagates
          if (secret !== null) return secret; // device-flow preferred when ids is ordered so
        }
        throw new NotFoundError(`credential ${ids.join(" or ")}`);
      };
    },
    configuredTokensProvider(ids) {
      return async () => {
        const out: string[] = [];
        for (const id of ids) {
          const secret = await ctx.secrets.get(account(id)); // locked → SecretsLockedError propagates
          if (secret !== null) out.push(secret);
        }
        return out; // may be empty — the caller decides how to fail
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
        // Enumerate every registered *provider* (not just meta rows), each left-joined with
        // its `${type}:default` status — so an unconfigured type is visible (status: null),
        // which the old meta-only list could never show. Never any secret material.
        const meta = new Map(
          (
            ctx.db.query("SELECT * FROM credentials_meta").all() as Array<{
              id: string;
              status: string;
              expires_at: string | null;
              status_detail: string | null;
            }>
          ).map((r) => [r.id, r]),
        );
        const entries = [...providers.values()].map((p) => {
          const id = defaultId(p.type);
          const row = meta.get(id);
          return {
            id,
            type: p.type,
            describe: p.describe(),
            status: row?.status ?? null,
            expiresAt: row?.expires_at ?? null,
            statusDetail: row?.status_detail ?? null,
          };
        });
        return c.json(entries);
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

      // Device Flow ceremony (ADR 0018). Guarded: providers without DeviceFlowProvider 400.
      app.post("/:id/device/start", async (c) => {
        const id = c.req.param("id");
        const provider = providerFor(id);
        if (!isDeviceFlow(provider))
          throw new ValidationError(`credential ${id} does not support device sign-in`);
        const started = await provider.startDevice(ctx);
        pending.set(id, {
          deviceCode: started.deviceCode,
          expiresAt: ctx.config.now().getTime() + started.expiresIn * 1000,
        });
        // deviceCode is deliberately NOT in the response — it stays server-side.
        return c.json({
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          interval: started.interval,
          expiresIn: started.expiresIn,
        });
      });

      app.post("/:id/device/poll", async (c) => {
        const id = c.req.param("id");
        const provider = providerFor(id);
        if (!isDeviceFlow(provider))
          throw new ValidationError(`credential ${id} does not support device sign-in`);
        const entry = pending.get(id);
        if (!entry || entry.expiresAt <= ctx.config.now().getTime()) {
          pending.delete(id);
          throw new AppError("credential.device_expired", "device code expired — start again", 410);
        }
        const result = await provider.pollDevice(entry.deviceCode, ctx);
        if (!result.done) return c.json({ pending: true });
        // Authorized: validate, then land the token on the exact path PUT uses — and, like PUT,
        // never persist a secret that validates invalid (parity with the fields form).
        const status = await provider.validate(result.secret, ctx);
        if (status.state !== "invalid") await backend.set(account(id), result.secret);
        applyStatus(id, provider.type, status);
        pending.delete(id);
        return c.json({ status: status.state });
      });
    },
  };
}
