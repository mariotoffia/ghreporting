import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { openDatabase } from "../../adapters/db/database";
import { runMigrations } from "../../adapters/db/migrate";
import { migrations } from "../../adapters/db/migrations";
import { createGitHubClient } from "../../adapters/github/client";
import { wireErrorEnvelope } from "../../app";
import { createEventBus } from "../../kernel/bus";
import { loadConfig } from "../../kernel/config";
import { createContext } from "../../kernel/context";
import { SecretsLockedError } from "../../kernel/errors";
import type { AppEvent, NotificationInput, SecretStoreBackend } from "../../kernel/ports";
import { nullLogger } from "../../kernel/testutil";
import type { CredentialProvider, CredentialStatus } from "./ports";
import { createCredentialsService } from "./service";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 5));

/** In-memory SecretStoreBackend; `lock()` makes every op throw like a locked encfile. */
function memBackend(id = "mem"): SecretStoreBackend & { store: Map<string, string>; lock(): void } {
  const store = new Map<string, string>();
  let locked = false;
  return {
    id,
    store,
    lock() {
      locked = true;
    },
    available: async () => true,
    get: async (a) => {
      if (locked) throw new SecretsLockedError();
      return store.get(a) ?? null;
    },
    set: async (a, s) => {
      if (locked) throw new SecretsLockedError();
      store.set(a, s);
    },
    delete: async (a) => {
      store.delete(a);
    },
  };
}

function fakeProvider(
  status: CredentialStatus,
  requiredScopes = ["read:org"],
): CredentialProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    type: "github-pat",
    calls,
    describe: () => ({
      type: "github-pat",
      title: "GitHub PAT",
      helpUrl: "https://github.com/settings/tokens",
      fields: [{ key: "token", label: "Token", secret: true }],
      requiredScopes,
    }),
    validate: async (secret) => {
      calls.push(secret);
      return status;
    },
  };
}

/** A device-capable provider (type github-oauth) scripting start + a sequence of polls. */
function fakeDeviceProvider(
  polls: Array<{ done: false } | { done: true; secret: string }>,
  validateStatus: CredentialStatus = { state: "ok", scopes: ["read:org"] },
): CredentialProvider & {
  startDevice: (ctx: unknown) => Promise<unknown>;
  pollDevice: (dc: string, ctx: unknown) => Promise<unknown>;
  started: number;
} {
  let i = 0;
  const p = {
    type: "github-oauth",
    started: 0,
    describe: () => ({
      type: "github-oauth",
      title: "GitHub (sign in)",
      helpUrl: "https://github.com/login/device",
      flow: "device" as const,
      fields: [],
      requiredScopes: ["read:org"],
    }),
    validate: async () => validateStatus,
    startDevice: async () => {
      p.started++;
      return {
        deviceCode: "SECRET_DEVICE_CODE",
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        interval: 5,
        expiresIn: 900,
      };
    },
    pollDevice: async () => polls[i++] ?? { done: false },
  };
  return p as unknown as CredentialProvider & {
    startDevice: (ctx: unknown) => Promise<unknown>;
    pollDevice: (dc: string, ctx: unknown) => Promise<unknown>;
    started: number;
  };
}

interface Harness {
  ctx: ReturnType<typeof createContext>["ctx"];
  notes: NotificationInput[];
  resolved: string[];
  events: AppEvent[];
  app: Hono;
  cred: ReturnType<typeof createCredentialsService>;
  tick: () => void;
}

const open: Array<{ close(): void }> = [];
afterEach(() => {
  for (const d of open.splice(0)) d.close();
});

async function setup(opts: {
  backends: SecretStoreBackend[];
  provider: CredentialProvider;
  extraProviders?: CredentialProvider[];
  secretBackend?: string;
  githubClientId?: string;
}): Promise<Harness> {
  const db = openDatabase(":memory:");
  open.push(db);
  runMigrations(db, migrations);
  const notes: NotificationInput[] = [];
  const resolved: string[] = [];
  const events: AppEvent[] = [];
  const bus = createEventBus(nullLogger());
  bus.on("credential.expiring", (e) => events.push(e));
  bus.on("credential.invalid", (e) => events.push(e));
  const config = {
    ...loadConfig({}),
    now: () => NOW,
    secretBackend: opts.secretBackend,
    githubClientId: opts.githubClientId,
  };
  const { ctx, bindNotify, bindResolve, bindSecrets } = createContext({
    db,
    bus,
    config,
    log: nullLogger(),
  });
  bindNotify((n) => notes.push(n));
  bindResolve((key) => resolved.push(key));

  let tickFn: (() => void) | undefined;
  const timers = {
    setInterval: ((fn: () => void) => {
      tickFn = fn;
      return 1;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
  };

  const cred = createCredentialsService({
    bindSecrets,
    backends: opts.backends,
    providers: [opts.provider, ...(opts.extraProviders ?? [])],
    timers,
  });
  await cred.init(ctx);

  const app = new Hono();
  const sub = new Hono();
  cred.routes?.(sub, ctx);
  app.route("/", sub);
  wireErrorEnvelope(app, nullLogger());
  return { ctx, notes, resolved, events, app, cred, tick: () => tickFn?.() };
}

const ID = "github-pat:default";
const ACCOUNT = `cred.${ID}`;

describe("credentials service — backend selection", () => {
  it("binds the first available backend as the secret store", async () => {
    const unavailable: SecretStoreBackend = { ...memBackend("kc"), available: async () => false };
    const file = memBackend("encrypted-file");
    const h = await setup({
      backends: [unavailable, file],
      provider: fakeProvider({ state: "ok" }),
    });
    await h.ctx.secrets.set("k", "v"); // routes through the bound backend
    expect(file.store.get("k")).toBe("v");
  });

  it("honors the config.secretBackend override over availability order", async () => {
    const kc = memBackend("keychain");
    const file = memBackend("encrypted-file");
    const h = await setup({
      backends: [kc, file],
      provider: fakeProvider({ state: "ok" }),
      secretBackend: "encrypted-file",
    });
    await h.ctx.secrets.set("k", "v");
    expect(file.store.get("k")).toBe("v");
    expect(kc.store.size).toBe(0);
  });
});

describe("credentials service — save + validate routes", () => {
  it("stores a valid secret and records meta status ok with the chosen backend id", async () => {
    const backend = memBackend("encrypted-file");
    const h = await setup({
      backends: [backend],
      provider: fakeProvider({ state: "ok", scopes: ["read:org"] }),
    });
    const res = await h.app.request(`/${ID}`, {
      method: "PUT",
      body: JSON.stringify({ secret: "ghp_valid" }),
    });
    expect(res.status).toBe(200);
    expect(backend.store.get(ACCOUNT)).toBe("ghp_valid");
    const row = h.ctx.db.query("SELECT * FROM credentials_meta WHERE id=?").get(ID) as {
      status: string;
      backend: string;
      type: string;
    };
    expect(row.status).toBe("ok");
    expect(row.backend).toBe("encrypted-file");
    expect(row.type).toBe("github-pat");
  });

  it("rejects an invalid secret with 400, stores nothing, and marks meta invalid", async () => {
    const backend = memBackend();
    const h = await setup({
      backends: [backend],
      provider: fakeProvider({ state: "invalid", reason: "token rejected (401)" }),
    });
    const res = await h.app.request(`/${ID}`, {
      method: "PUT",
      body: JSON.stringify({ secret: "ghp_bad" }),
    });
    expect(res.status).toBe(400);
    expect(backend.store.size).toBe(0);
    const row = h.ctx.db.query("SELECT status FROM credentials_meta WHERE id=?").get(ID) as {
      status: string;
    };
    expect(row.status).toBe("invalid");
    expect(h.events.some((e) => e.type === "credential.invalid")).toBe(true);
  });

  it("notifies + emits on an expiring token", async () => {
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({
        state: "expiring",
        expiresAt: "2026-07-14T00:00:00.000Z",
        daysLeft: 5,
      }),
    });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_soon" }) });
    expect(
      h.notes.some((n) => n.key === `credential.${ID}.expiring` && n.level === "warning"),
    ).toBe(true);
    const evt = h.events.find((e) => e.type === "credential.expiring");
    expect(evt).toMatchObject({ id: ID, daysLeft: 5 });
  });

  it("warns when a classic PAT is missing a required scope", async () => {
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({ state: "ok", scopes: ["read:org"] }, [
        "read:org",
        "manage_billing:copilot",
      ]),
    });
    await h.app.request(`/${ID}`, {
      method: "PUT",
      body: JSON.stringify({ secret: "ghp_narrow" }),
    });
    expect(h.notes.some((n) => n.key === `credential.${ID}.scopes` && n.level === "warning")).toBe(
      true,
    );
  });

  it("does not warn about scopes for a fine-grained PAT (empty scope list)", async () => {
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({ state: "ok", scopes: [] }, ["read:org"]),
    });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_fine" }) });
    expect(h.notes.some((n) => n.key === `credential.${ID}.scopes`)).toBe(false);
  });

  it("POST /:id/validate re-runs validation against the stored secret", async () => {
    const backend = memBackend();
    const provider = fakeProvider({ state: "ok", scopes: ["read:org"] });
    const h = await setup({ backends: [backend], provider });
    await h.app.request(`/${ID}`, {
      method: "PUT",
      body: JSON.stringify({ secret: "ghp_stored" }),
    });
    provider.calls.length = 0;
    const res = await h.app.request(`/${ID}/validate`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(provider.calls).toEqual(["ghp_stored"]); // validated the stored secret, not a new one
  });

  it("DELETE /:id removes the secret and the meta row", async () => {
    const backend = memBackend();
    const h = await setup({ backends: [backend], provider: fakeProvider({ state: "ok" }) });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_x" }) });
    const res = await h.app.request(`/${ID}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(backend.store.has(ACCOUNT)).toBe(false);
    expect(h.ctx.db.query("SELECT 1 FROM credentials_meta WHERE id=?").get(ID)).toBeNull();
  });
});

describe("credentials service — recovery clears the invalid card (T5.1 wiring)", () => {
  it("resolves credential.<id>.invalid on a valid (ok) validation", async () => {
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({ state: "ok", scopes: ["read:org"] }),
    });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_ok" }) });
    expect(h.resolved).toContain(`credential.${ID}.invalid`);
  });

  it("resolves credential.<id>.invalid on an expiring (still-usable) validation", async () => {
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({ state: "expiring", expiresAt: NOW.toISOString(), daysLeft: 3 }),
    });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_soon" }) });
    expect(h.resolved).toContain(`credential.${ID}.invalid`);
  });

  it("does not resolve on an invalid validation", async () => {
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({ state: "invalid", reason: "token rejected (401)" }),
    });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_bad" }) });
    expect(h.resolved).not.toContain(`credential.${ID}.invalid`);
  });
});

describe("credentials service — listing never leaks secrets", () => {
  it("GET / returns meta joined with describe() and no secret material", async () => {
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({ state: "ok", scopes: ["read:org"] }),
    });
    await h.app.request(`/${ID}`, {
      method: "PUT",
      body: JSON.stringify({ secret: "ghp_topsecret" }),
    });
    const res = await h.app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; describe: { type: string } }>;
    expect(body[0]?.id).toBe(ID);
    expect(body[0]?.describe.type).toBe("github-pat");
    expect(JSON.stringify(body)).not.toContain("ghp_topsecret");
  });
});

describe("credentials service — tokenProvider", () => {
  it("returns the stored token", async () => {
    const backend = memBackend();
    const h = await setup({ backends: [backend], provider: fakeProvider({ state: "ok" }) });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_live" }) });
    expect(await h.cred.tokenProvider(ID)()).toBe("ghp_live");
  });

  it("throws SecretsLockedError when the store is locked", async () => {
    const backend = memBackend();
    const h = await setup({ backends: [backend], provider: fakeProvider({ state: "ok" }) });
    backend.lock();
    await expect(h.cred.tokenProvider(ID)()).rejects.toBeInstanceOf(SecretsLockedError);
  });

  it("throws NotFoundError when the credential is absent", async () => {
    const h = await setup({ backends: [memBackend()], provider: fakeProvider({ state: "ok" }) });
    await expect(h.cred.tokenProvider(ID)()).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("credentials service — 6h revalidation", () => {
  it("re-runs validate for every stored credential on each tick", async () => {
    const provider = fakeProvider({ state: "ok", scopes: ["read:org"] });
    const h = await setup({ backends: [memBackend()], provider });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_tick" }) });
    provider.calls.length = 0;
    h.tick();
    await flush();
    expect(provider.calls).toEqual(["ghp_tick"]);
  });

  it("skips the tick silently while the store is locked", async () => {
    const backend = memBackend();
    const provider = fakeProvider({ state: "ok" });
    const h = await setup({ backends: [backend], provider });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_tick" }) });
    backend.lock();
    provider.calls.length = 0;
    h.tick();
    await flush();
    expect(provider.calls).toEqual([]); // locked read short-circuits, no crash
  });
});

describe("credentials service — GET / enumerates registered providers (T12.1)", () => {
  it("lists an unconfigured provider with status null and a configured one with its status", async () => {
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({ state: "ok", scopes: ["read:org"] }), // github-pat
      extraProviders: [fakeDeviceProvider([])], // github-oauth, never configured
    });
    const res = await h.app.request("/");
    const body = (await res.json()) as Array<{ id: string; type: string; status: string | null }>;
    const oauth = body.find((e) => e.type === "github-oauth");
    const pat = body.find((e) => e.type === "github-pat");
    expect(oauth).toMatchObject({ id: "github-oauth:default", status: null }); // visible though unset
    expect(pat?.status).toBeNull(); // not configured yet either
    // Configure the PAT, and only its status flips — enumeration still shows both.
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_ok" }) });
    const after = (await (await h.app.request("/")).json()) as Array<{
      type: string;
      status: string | null;
    }>;
    expect(after.find((e) => e.type === "github-pat")?.status).toBe("ok");
    expect(after.find((e) => e.type === "github-oauth")?.status).toBeNull();
  });
});

describe("credentials service — device flow ceremony (T12.2)", () => {
  const OAUTH = "github-oauth:default";

  it("start stores pending and never returns the deviceCode", async () => {
    const device = fakeDeviceProvider([]);
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({ state: "ok" }),
      extraProviders: [device],
      githubClientId: "Iv1.x",
    });
    const res = await h.app.request(`/${OAUTH}/device/start`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 900,
    });
    expect(JSON.stringify(body)).not.toContain("SECRET_DEVICE_CODE");
  });

  it("poll returns { pending:true } while pending, then stores the secret and reports ok", async () => {
    const backend = memBackend();
    const device = fakeDeviceProvider([{ done: false }, { done: true, secret: "gho_live" }]);
    const h = await setup({
      backends: [backend],
      provider: fakeProvider({ state: "ok" }),
      extraProviders: [device],
      githubClientId: "Iv1.x",
    });
    await h.app.request(`/${OAUTH}/device/start`, { method: "POST" });

    const first = await h.app.request(`/${OAUTH}/device/poll`, { method: "POST" });
    expect(await first.json()).toEqual({ pending: true });
    expect(backend.store.has(`cred.${OAUTH}`)).toBe(false);

    const second = await h.app.request(`/${OAUTH}/device/poll`, { method: "POST" });
    expect(await second.json()).toEqual({ status: "ok" });
    expect(backend.store.get(`cred.${OAUTH}`)).toBe("gho_live"); // same storage path as PUT
    const row = h.ctx.db.query("SELECT status FROM credentials_meta WHERE id=?").get(OAUTH) as {
      status: string;
    };
    expect(row.status).toBe("ok");
  });

  it("poll does NOT store a token that validates invalid (parity with PUT)", async () => {
    const backend = memBackend();
    const device = fakeDeviceProvider([{ done: true, secret: "gho_bad" }], {
      state: "invalid",
      reason: "token rejected (401)",
    });
    const h = await setup({
      backends: [backend],
      provider: fakeProvider({ state: "ok" }),
      extraProviders: [device],
      githubClientId: "Iv1.x",
    });
    await h.app.request(`/${OAUTH}/device/start`, { method: "POST" });
    const res = await h.app.request(`/${OAUTH}/device/poll`, { method: "POST" });
    expect(await res.json()).toEqual({ status: "invalid" });
    expect(backend.store.has(`cred.${OAUTH}`)).toBe(false); // nothing persisted
  });

  it("poll with no pending ceremony is 410", async () => {
    const h = await setup({
      backends: [memBackend()],
      provider: fakeProvider({ state: "ok" }),
      extraProviders: [fakeDeviceProvider([])],
      githubClientId: "Iv1.x",
    });
    const res = await h.app.request(`/${OAUTH}/device/poll`, { method: "POST" });
    expect(res.status).toBe(410);
  });

  it("device routes 400 for a provider without the DeviceFlowProvider port", async () => {
    const h = await setup({ backends: [memBackend()], provider: fakeProvider({ state: "ok" }) });
    const res = await h.app.request(`/${ID}/device/start`, { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("credentials service — firstConfiguredTokenProvider (T12.2)", () => {
  it("prefers the first configured id, falls back to the next, throws NotFound when neither", async () => {
    const h = await setup({ backends: [memBackend()], provider: fakeProvider({ state: "ok" }) });
    const read = h.cred.firstConfiguredTokenProvider([
      "github-oauth:default",
      "github-pat:default",
    ]);
    await expect(read()).rejects.toMatchObject({ code: "not_found" });

    await h.ctx.secrets.set("cred.github-pat:default", "pat_token");
    expect(await read()).toBe("pat_token"); // falls back to the PAT

    await h.ctx.secrets.set("cred.github-oauth:default", "device_token");
    expect(await read()).toBe("device_token"); // device wins when both exist
  });

  it("propagates SecretsLockedError instead of reporting NotFound", async () => {
    const backend = memBackend();
    const h = await setup({ backends: [backend], provider: fakeProvider({ state: "ok" }) });
    backend.lock();
    const read = h.cred.firstConfiguredTokenProvider([
      "github-oauth:default",
      "github-pat:default",
    ]);
    await expect(read()).rejects.toBeInstanceOf(SecretsLockedError);
  });
});

describe("credentials service — configuredTokensProvider (token fallback, ADR 0018)", () => {
  it("returns every configured token in order, skipping unconfigured, empty when none", async () => {
    const h = await setup({ backends: [memBackend()], provider: fakeProvider({ state: "ok" }) });
    const read = h.cred.configuredTokensProvider(["github-pat:default", "github-oauth:default"]);
    expect(await read()).toEqual([]); // none configured yet
    await h.ctx.secrets.set("cred.github-oauth:default", "device_token");
    expect(await read()).toEqual(["device_token"]); // skips the unconfigured PAT
    await h.ctx.secrets.set("cred.github-pat:default", "pat_token");
    expect(await read()).toEqual(["pat_token", "device_token"]); // PAT first (priority order)
  });

  it("propagates SecretsLockedError", async () => {
    const backend = memBackend();
    const h = await setup({ backends: [backend], provider: fakeProvider({ state: "ok" }) });
    backend.lock();
    const read = h.cred.configuredTokensProvider(["github-pat:default", "github-oauth:default"]);
    await expect(read()).rejects.toBeInstanceOf(SecretsLockedError);
  });
});

describe("credentials service — end-to-end with GitHubClient (Done-when)", () => {
  it("authorizes GitHub requests with the token the service stored", async () => {
    const backend = memBackend();
    const h = await setup({ backends: [backend], provider: fakeProvider({ state: "ok" }) });
    await h.app.request(`/${ID}`, { method: "PUT", body: JSON.stringify({ secret: "ghp_e2e" }) });

    const seen: Array<string | null> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const gh = createGitHubClient({
      tokenProvider: h.cred.tokenProvider(ID),
      fetchImpl,
      log: nullLogger(),
    });
    const res = await gh.get("/user");
    expect(res.status).toBe(200);
    expect(seen[0]).toBe("token ghp_e2e");
  });
});
