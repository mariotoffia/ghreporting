import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { runMigrations } from "../../adapters/db/migrate";
import { migrations } from "../../adapters/db/migrations";
import { wireErrorEnvelope } from "../../app";
import { createEventBus } from "../../kernel/bus";
import { loadConfig } from "../../kernel/config";
import { createContext } from "../../kernel/context";
import { AppError } from "../../kernel/errors";
import type { AppEvent, SecretStoreBackend } from "../../kernel/ports";
import { createKernel } from "../../kernel/registry";
import { nullLogger } from "../../kernel/testutil";
import { createAuthService } from "./service";
import { createSessionStore } from "./session";
import { fakeClock, fakeWebAuthnLib, memoryBackend } from "./testutil";

// Minimal composition (like buildApp, minus everything but auth) so these tests
// drive the real kernel mount at /api/auth with fakes for lib + master-key backend.
function buildHarness(script: Parameters<typeof fakeWebAuthnLib>[0] = {}) {
  const clock = fakeClock();
  const log = nullLogger();
  const db = new Database(":memory:");
  runMigrations(db, migrations);
  const config = { ...loadConfig({ HOME: "/tmp" }), now: clock.now };
  const { ctx } = createContext({ db, bus: createEventBus(log), config, log });
  const kernel = createKernel(ctx);
  const app = new Hono();
  const sessions = createSessionStore(config.now);
  const backend = memoryBackend();
  const keySets: Array<Uint8Array | null> = [];
  const events: AppEvent[] = [];
  ctx.bus.on("auth.unlocked", (e) => events.push(e));
  const { lib, calls } = fakeWebAuthnLib(script);
  kernel.register(
    createAuthService({
      sessions,
      masterKeyBackends: [backend],
      setMasterKey: (k) => keySets.push(k),
      lib,
    }),
  );
  wireErrorEnvelope(app, log);
  return { clock, db, ctx, kernel, app, sessions, backend, keySets, events, calls };
}

type Harness = ReturnType<typeof buildHarness>;

const post = (app: Hono, path: string, body: unknown = { id: "passkey-1" }, cookie?: string) =>
  app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
  });

async function registerAndUnlock(h: Harness): Promise<string> {
  await post(h.app, "/api/auth/register/options");
  const res = await post(h.app, "/api/auth/register/verify");
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie") ?? "";
}

describe("auth service", () => {
  let h: Harness;
  afterEach(async () => {
    await h.kernel.stop();
    h.db.close();
  });

  it("reports { registered: false, unlocked: false } before setup", async () => {
    h = buildHarness();
    await h.kernel.start(h.app);
    const res = await h.app.request("/api/auth/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registered: false, unlocked: false, hasSession: false });
  });

  it("register/verify unlocks: session cookie, master key, auth.unlocked event", async () => {
    h = buildHarness();
    await h.kernel.start(h.app);
    const cookie = await registerAndUnlock(h);
    expect(cookie).toContain("ghr_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    // master key handed to the composition root slot, 32 bytes
    expect(h.keySets).toHaveLength(1);
    expect(h.keySets[0]?.length).toBe(32);
    expect(h.events).toEqual([{ type: "auth.unlocked" }]);
    // the cookie's token is a live session
    const token = /ghr_session=([^;]+)/.exec(cookie)?.[1] ?? "";
    expect(h.sessions.touch(token)).toBe(true);
    // Without the cookie: unlocked (global) but NO session — the UI must route to login, not app.
    const noCookie = await h.app.request("/api/auth/status");
    expect(await noCookie.json()).toEqual({
      registered: true,
      unlocked: true,
      hasSession: false,
    });
    // With the cookie: this browser has a live session → hasSession true → routes to app.
    const withCookie = await h.app.request("/api/auth/status", { headers: { Cookie: cookie } });
    expect(await withCookie.json()).toEqual({
      registered: true,
      unlocked: true,
      hasSession: true,
    });
  });

  it("returns the 403 already-registered envelope on a second register/options", async () => {
    h = buildHarness();
    await h.kernel.start(h.app);
    await registerAndUnlock(h);
    const res = await post(h.app, "/api/auth/register/options");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth.already_registered");
  });

  it("login/verify after a restart-like lock unlocks again with the same key", async () => {
    h = buildHarness();
    await h.kernel.start(h.app);
    const first = await registerAndUnlock(h);
    await post(h.app, "/api/auth/logout", {}, first);
    await post(h.app, "/api/auth/login/options");
    const res = await post(h.app, "/api/auth/login/verify");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("ghr_session=");
    // same persisted master key loaded again (created once, not regenerated)
    expect(h.backend.store.size).toBe(1);
    const storedHex = h.backend.store.get("master-key") ?? "";
    const relocked = h.keySets.at(-1) as Uint8Array;
    const expected = storedHex.match(/.{2}/g)?.map((b) => Number.parseInt(b, 16));
    expect([...relocked]).toEqual(expected ?? []);
  });

  it("logout destroys the session, zeroes the key buffer, and locks", async () => {
    h = buildHarness();
    await h.kernel.start(h.app);
    const cookie = await registerAndUnlock(h);
    const token = /ghr_session=([^;]+)/.exec(cookie)?.[1] ?? "";
    const key = h.keySets[0] as Uint8Array;
    const res = await post(h.app, "/api/auth/logout", {}, cookie);
    expect(res.status).toBe(200);
    expect(h.sessions.touch(token)).toBe(false);
    expect([...key].every((b) => b === 0)).toBe(true); // zeroed in place
    expect(h.keySets.at(-1)).toBeNull(); // slot cleared → encfile locked again
    const status = await h.app.request("/api/auth/status");
    expect(await status.json()).toEqual({
      registered: true,
      unlocked: false,
      hasSession: false,
    });
  });

  it("rejects a non-JSON verify body with a 400 envelope", async () => {
    h = buildHarness();
    await h.kernel.start(h.app);
    const res = await h.app.request("/api/auth/register/verify", {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rolls back the passkey row when unlock fails, so re-registration works", async () => {
    h = buildHarness();
    // a master-key backend whose set() blows up like a locked keychain would
    const flaky = memoryBackend();
    let failNext = true;
    flaky.set = async (account, secret) => {
      if (failNext) {
        failNext = false;
        throw new AppError("keychain.write_failed", "security exited 1");
      }
      flaky.store.set(account, secret);
    };
    const sessions = createSessionStore(h.ctx.config.now);
    const { lib } = fakeWebAuthnLib();
    const app = new Hono();
    const kernel = createKernel(h.ctx);
    kernel.register(
      createAuthService({ sessions, masterKeyBackends: [flaky], setMasterKey: () => {}, lib }),
    );
    wireErrorEnvelope(app, nullLogger());
    await kernel.start(app);
    await post(app, "/api/auth/register/options");
    const first = await post(app, "/api/auth/register/verify");
    expect(first.status).toBe(500); // unlock failed
    // the passkey row was rolled back — status shows unregistered, retry is allowed
    expect((await (await app.request("/api/auth/status")).json()) as unknown).toEqual({
      registered: false,
      unlocked: false,
      hasSession: false,
    });
    await post(app, "/api/auth/register/options"); // not 403
    const retry = await post(app, "/api/auth/register/verify");
    expect(retry.status).toBe(200);
    await kernel.stop();
  });

  it("skips an unavailable master-key backend and uses the next one", async () => {
    h = buildHarness();
    const dead: SecretStoreBackend = {
      id: "dead",
      available: async () => false,
      get: async () => {
        throw new Error("never");
      },
      set: async () => {},
      delete: async () => {},
    };
    const alive = memoryBackend("alive");
    const sessions = createSessionStore(h.ctx.config.now);
    const { lib } = fakeWebAuthnLib();
    const app = new Hono();
    const kernel = createKernel(h.ctx);
    kernel.register(
      createAuthService({
        sessions,
        masterKeyBackends: [dead, alive],
        setMasterKey: () => {},
        lib,
      }),
    );
    wireErrorEnvelope(app, nullLogger());
    await kernel.start(app);
    await post(app, "/api/auth/register/options");
    const res = await post(app, "/api/auth/register/verify");
    expect(res.status).toBe(200);
    expect(alive.store.has("master-key")).toBe(true);
    await kernel.stop();
  });
});
